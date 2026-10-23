// @vitest-environment node
// [2026-10-23] Root-only upload compute preset (Fargate size of the upload processing task). Stored in
// app_settings["upload_compute_preset"] as { preset } (no schema change).
//   • GET/PUT /api/admin/upload-compute: auth "root" — signed-out 401, member 403, company admin 403.
//   • PUT is zod-strict and allowlisted to the five presets; each change is audited.
//   • The generic /api/admin/app-settings route refuses the key, so no write skips the allowlist.
//   • readUploadComputePreset (the StartExecution reader) returns the saved preset, and the 8x16
//     default for a missing or hand-edited off-list value.
// This file is the only writer of the key; it removes the row when done.
import { afterAll, beforeEach, describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { GET, PUT } from "@/app/api/admin/upload-compute/route";
import { PUT as settingsPUT } from "@/app/api/admin/app-settings/route";
import { db } from "@/lib/db";
import { appSettings, auditLog } from "@/lib/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { readUploadComputePreset } from "@/server/services/upload-compute";
import { UPLOAD_COMPUTE_SETTING_KEY } from "@/lib/upload-compute";
import { asUser, createCompany, createUser, makeReq, readJson, signedOut } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;
const PATH = "/api/admin/upload-compute";
const get = () => GET(makeReq(PATH, { method: "GET" }));
const put = (body: unknown) => PUT(makeReq(PATH, { method: "PUT", body }));
const clearRow = () => db.delete(appSettings).where(eq(appSettings.key, UPLOAD_COMPUTE_SETTING_KEY));

async function makeWorld() {
  const company = await createCompany();
  const admin = await createUser(company.id, { role: "admin" });
  const member = await createUser(company.id);
  const root = await createUser(company.id, { isRootAdmin: true });
  return { company, admin, member, root };
}

beforeEach(() => {
  vi.clearAllMocks();
  signedOut();
});

describe.skipIf(!dbUp)("/api/admin/upload-compute", () => {
  afterAll(async () => {
    await clearRow();
  });

  it("auth: signed-out 401; member and company admin 403 on read AND write; root 200", async () => {
    const { admin, member, root } = await makeWorld();
    expect((await get()).status).toBe(401);
    expect((await put({ preset: "16x64" })).status).toBe(401);
    for (const actor of [member, admin]) {
      asUser(actor);
      let r = await readJson(await get());
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("FORBIDDEN");
      r = await readJson(await put({ preset: "16x64" }));
      expect(r.status).toBe(403);
    }
    asUser(root);
    expect((await get()).status).toBe(200);
  });

  it("GET lists the five presets (default 8x16); PUT saves one with an audit row; the run-path reader sees it", async () => {
    await clearRow();
    const { root } = await makeWorld();
    asUser(root);
    let r = await readJson(await get());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ preset: "8x16", valid: false, defaultPreset: "8x16" });
    expect(r.body.presets.map((p: { id: string }) => p.id)).toEqual(["4x16", "8x16", "8x32", "16x32", "16x64"]);
    expect((await readUploadComputePreset()).id).toBe("8x16");

    r = await readJson(await put({ preset: "16x32" }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, preset: "16x32" });
    r = await readJson(await put({ preset: "16x64" }));
    expect(r.status).toBe(200);
    expect((await readJson(await get())).body).toMatchObject({ preset: "16x64", valid: true });
    expect(await readUploadComputePreset()).toMatchObject({ id: "16x64", cpu: "16384", memory: "65536", pageConcurrency: 16 });

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "upload_compute_preset_changed"), eq(auditLog.userId, root.id)))
      .orderBy(desc(auditLog.id));
    expect(audits.map((a) => a.details)).toEqual([
      { before: "16x32", after: "16x64" },
      { before: null, after: "16x32" },
    ]);
  });

  it("PUT refuses anything but a preset id (400) without writing; the generic app-settings route refuses the key", async () => {
    await clearRow();
    const { root } = await makeWorld();
    asUser(root);
    await put({ preset: "8x32" });
    for (const body of [
      { preset: "32x64" },
      { preset: "2x4" },
      { preset: 16 },
      { preset: "8x32", cpu: "32768" },
      { cpu: "16384", memory: "65536" },
      {},
    ]) {
      const r = await readJson(await put(body));
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("VALIDATION");
    }
    expect((await readUploadComputePreset()).id).toBe("8x32");

    const generic = await readJson(
      await settingsPUT(
        makeReq("/api/admin/app-settings", { method: "PUT", body: { key: UPLOAD_COMPUTE_SETTING_KEY, value: { preset: "32x120" } } }),
      ),
    );
    expect(generic.status).toBe(400);
    expect(generic.body.error.message).toMatch(/\/api\/admin\/upload-compute/u);
    expect((await readUploadComputePreset()).id).toBe("8x32");

    // A hand-edited off-list value falls back to the default (never throws on the run path).
    await clearRow();
    await db.insert(appSettings).values({ key: UPLOAD_COMPUTE_SETTING_KEY, value: { preset: "64x512" } });
    expect((await readUploadComputePreset()).id).toBe("8x16");
    await clearRow();
  });
});
