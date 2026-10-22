// @vitest-environment node
// [2026-10-21] Root-only YOLO inference instance (owner: "on the website can list all available and
// change which instance is running for YOLO processing"). Stored in app_settings["yolo_instance_type"]
// (no schema change).
//   • GET/PUT /api/admin/yolo-instance: auth "root" — signed-out 401, member 403, company admin 403.
//   • PUT is zod-strict and allowlisted: unknown type 400, extra keys 400; each change is audited.
//   • The generic /api/admin/app-settings route refuses the key, so no write skips the allowlist.
//   • readYoloInstanceType (the startYoloJob reader) returns the saved type, and the default for a
//     missing or hand-edited off-allowlist value.
// This file is the only writer of the key; it removes the row when done.
import { afterAll, beforeEach, describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { GET, PUT } from "@/app/api/admin/yolo-instance/route";
import { PUT as settingsPUT } from "@/app/api/admin/app-settings/route";
import { db } from "@/lib/db";
import { appSettings, auditLog } from "@/lib/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { putYoloInstanceType, readYoloInstanceType } from "@/server/services/yolo-instance";
import { YOLO_INSTANCE_SETTING_KEY, YOLO_INSTANCE_TYPES } from "@/lib/yolo-instances";
import { asUser, createCompany, createUser, makeReq, readJson, signedOut } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;
const PATH = "/api/admin/yolo-instance";
const get = () => GET(makeReq(PATH, { method: "GET" }));
const put = (body: unknown) => PUT(makeReq(PATH, { method: "PUT", body }));
const clearRow = () => db.delete(appSettings).where(eq(appSettings.key, YOLO_INSTANCE_SETTING_KEY));

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

describe.skipIf(!dbUp)("/api/admin/yolo-instance", () => {
  afterAll(async () => {
    await clearRow();
  });

  it("auth: signed-out 401; member and company admin 403 on read AND write; root 200", async () => {
    const { admin, member, root } = await makeWorld();
    expect((await get()).status).toBe(401);
    expect((await put({ instanceType: "ml.g5.xlarge" })).status).toBe(401);
    for (const actor of [member, admin]) {
      asUser(actor);
      let r = await readJson(await get());
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("FORBIDDEN");
      r = await readJson(await put({ instanceType: "ml.g5.xlarge" }));
      expect(r.status).toBe(403);
    }
    asUser(root);
    expect((await get()).status).toBe(200);
  });

  it("GET lists the allowlist; PUT saves an allowlisted type with an audit row; startYoloJob's reader sees it", async () => {
    await clearRow();
    const { root } = await makeWorld();
    asUser(root);
    let r = await readJson(await get());
    expect(r.body).toMatchObject({ instanceType: "ml.g4dn.xlarge", valid: false, defaultInstanceType: "ml.g4dn.xlarge" });
    expect(r.body.options.map((o: { type: string }) => o.type)).toEqual([...YOLO_INSTANCE_TYPES]);
    expect(await readYoloInstanceType()).toBe("ml.g4dn.xlarge");

    r = await readJson(await put({ instanceType: "ml.g5.xlarge" }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, instanceType: "ml.g5.xlarge" });
    r = await readJson(await put({ instanceType: "ml.g6.2xlarge" }));
    expect(r.status).toBe(200);
    expect((await readJson(await get())).body).toMatchObject({ instanceType: "ml.g6.2xlarge", valid: true });
    expect(await readYoloInstanceType()).toBe("ml.g6.2xlarge");

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "yolo_instance_type_changed"), eq(auditLog.userId, root.id)))
      .orderBy(desc(auditLog.id));
    expect(audits.map((a) => a.details)).toEqual([
      { before: "ml.g5.xlarge", after: "ml.g6.2xlarge" },
      { before: null, after: "ml.g5.xlarge" },
    ]);
  });

  it("PUT refuses an off-allowlist type, a non-string and unknown keys (400) without writing", async () => {
    const { root } = await makeWorld();
    asUser(root);
    await put({ instanceType: "ml.g5.xlarge" });
    for (const body of [
      { instanceType: "ml.inf2.xlarge" },
      { instanceType: "ml.p5.48xlarge" },
      { instanceType: 3 },
      { instanceType: "ml.g5.xlarge", extra: true },
      {},
    ]) {
      const r = await readJson(await put(body));
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("VALIDATION");
    }
    expect(await readYoloInstanceType()).toBe("ml.g5.xlarge");
  });

  it("the service's own belt: putYoloInstanceType refuses a non-root session and an off-allowlist type without writing", async () => {
    // The route is auth:"root"; this pins the in-service check too, so a future caller that reaches
    // the service another way (or a route whose auth is loosened) still cannot write the key.
    await clearRow();
    const { admin, root } = await makeWorld();
    const sessionOf = (u: { id: number; companyId: number }, isRootAdmin: boolean) =>
      ({ user: { dbId: u.id, companyId: u.companyId, isRootAdmin, role: "admin" } }) as never;
    await expect(putYoloInstanceType({ instanceType: "ml.g5.xlarge" }, sessionOf(admin, false))).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(putYoloInstanceType({ instanceType: "ml.inf2.xlarge" }, sessionOf(root, true))).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(await db.select().from(appSettings).where(eq(appSettings.key, YOLO_INSTANCE_SETTING_KEY))).toEqual([]);
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "yolo_instance_type_changed"), eq(auditLog.userId, admin.id)));
    expect(audits).toEqual([]);
  });

  it("the generic app-settings route refuses the key, even for root", async () => {
    const { root } = await makeWorld();
    asUser(root);
    const r = await readJson(
      await settingsPUT(makeReq("/api/admin/app-settings", { method: "PUT", body: { key: YOLO_INSTANCE_SETTING_KEY, value: { instanceType: "ml.p3.8xlarge" } } })),
    );
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/\/api\/admin\/yolo-instance/u);
  });

  it("a hand-edited off-allowlist value reads back as the default on the run path", async () => {
    await clearRow();
    await db.insert(appSettings).values({ key: YOLO_INSTANCE_SETTING_KEY, value: { instanceType: "ml.inf2.xlarge" } });
    expect(await readYoloInstanceType()).toBe("ml.g4dn.xlarge");
    await clearRow();
    await db.insert(appSettings).values({ key: YOLO_INSTANCE_SETTING_KEY, value: { nonsense: 1 } });
    expect(await readYoloInstanceType()).toBe("ml.g4dn.xlarge");
    await clearRow();
  });
});
