// @vitest-environment node
// [tiles T9 2026-10-24] Root-only upload tiling switch + level list. Stored in app_settings["tiles_enabled"]
// as { enabled, levels } (no schema change).
//   • GET/PUT /api/admin/tiles: auth "root" — signed-out 401, member 403, company admin 403.
//   • PUT is zod-strict: boolean enabled, optional 1–4 unique px sizes within the planner's bounds; audited.
//   • The generic /api/admin/app-settings route refuses the key, so no write skips the validation.
//   • readTilesSetting (processing.ts's reader) returns the saved document, and ON + [3600, 1280] for
//     a missing row or a hand-edited bad field.
// This file is the only writer of the key; it removes the row when done.
import { afterAll, beforeEach, describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { GET, PUT } from "@/app/api/admin/tiles/route";
import { PUT as settingsPUT } from "@/app/api/admin/app-settings/route";
import { db } from "@/lib/db";
import { appSettings, auditLog } from "@/lib/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { readTilesSetting, TILES_AUDIT_ACTION } from "@/server/services/tiles-setting";
import { TILES_SETTING_KEY } from "@/lib/tiles/settings";
import { asUser, createCompany, createUser, makeReq, readJson, signedOut } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;
const PATH = "/api/admin/tiles";
const get = () => GET(makeReq(PATH, { method: "GET" }));
const put = (body: unknown) => PUT(makeReq(PATH, { method: "PUT", body }));
const clearRow = () => db.delete(appSettings).where(eq(appSettings.key, TILES_SETTING_KEY));

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

describe.skipIf(!dbUp)("/api/admin/tiles", () => {
  afterAll(async () => {
    await clearRow();
  });

  it("auth: signed-out 401; member and company admin 403 on read AND write; root 200", async () => {
    const { admin, member, root } = await makeWorld();
    expect((await get()).status).toBe(401);
    expect((await put({ enabled: false })).status).toBe(401);
    for (const actor of [member, admin]) {
      asUser(actor);
      let r = await readJson(await get());
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("FORBIDDEN");
      r = await readJson(await put({ enabled: false }));
      expect(r.status).toBe(403);
    }
    asUser(root);
    expect((await get()).status).toBe(200);
  });

  it("GET shows the defaults (ON, 3600/1280, valid:false); PUT saves with an audit row; the run-path reader sees it", async () => {
    await clearRow();
    const { root } = await makeWorld();
    asUser(root);
    let r = await readJson(await get());
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      enabled: true, levels: [3600, 1280], overlap: 0.2, valid: false,
      defaults: { enabled: true, levels: [3600, 1280], overlap: 0.2 },
    });
    expect(await readTilesSetting()).toEqual({ enabled: true, levels: [3600, 1280], overlap: 0.2 });

    r = await readJson(await put({ enabled: false }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, enabled: false, levels: [3600, 1280] });
    expect(await readTilesSetting()).toMatchObject({ enabled: false, levels: [3600, 1280] });

    r = await readJson(await put({ enabled: true, levels: [3600, 1824, 1280] }));
    expect(r.status).toBe(200);
    expect((await readJson(await get())).body).toMatchObject({ enabled: true, levels: [3600, 1824, 1280], valid: true });
    expect(await readTilesSetting()).toMatchObject({ enabled: true, levels: [3600, 1824, 1280] });

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, TILES_AUDIT_ACTION), eq(auditLog.userId, root.id)))
      .orderBy(desc(auditLog.id));
    expect(audits.map((a) => a.details)).toEqual([
      { before: { enabled: false, levels: [3600, 1280] }, after: { enabled: true, levels: [3600, 1824, 1280] } },
      { before: null, after: { enabled: false, levels: [3600, 1280] } },
    ]);
  });

  it("PUT refuses anything off the contract (400) without writing; the generic app-settings route refuses the key", async () => {
    await clearRow();
    const { root } = await makeWorld();
    asUser(root);
    await put({ enabled: false, levels: [2048] });
    for (const body of [
      { enabled: "no" },
      { enabled: true, levels: [] },
      { enabled: true, levels: [32] },
      { enabled: true, levels: [1280, 1280] },
      { enabled: true, levels: [3600, 1280, 1824, 640, 512] },
      { enabled: true, levels: ["1280"] },
      { enabled: true, levels: [1280.5] },
      { enabled: true, overlap: 0.5 },
      { levels: [1280] },
      {},
    ]) {
      const r = await readJson(await put(body));
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error.code).toBe("VALIDATION");
    }
    expect(await readTilesSetting()).toMatchObject({ enabled: false, levels: [2048] });

    const generic = await readJson(
      await settingsPUT(
        makeReq("/api/admin/app-settings", { method: "PUT", body: { key: TILES_SETTING_KEY, value: { enabled: true, levels: [1] } } }),
      ),
    );
    expect(generic.status).toBe(400);
    expect(generic.body.error.message).toMatch(/\/api\/admin\/tiles/u);
    expect(await readTilesSetting()).toMatchObject({ enabled: false, levels: [2048] });

    // A hand-edited document: the bad field falls back, the good one is kept, nothing throws on the run path.
    await clearRow();
    await db.insert(appSettings).values({ key: TILES_SETTING_KEY, value: { enabled: false, levels: "all" } });
    expect(await readTilesSetting()).toEqual({ enabled: false, levels: [3600, 1280], overlap: 0.2 });
    expect((await readJson(await get())).body).toMatchObject({ enabled: false, levels: [3600, 1280], valid: false });
    await clearRow();
  });
});
