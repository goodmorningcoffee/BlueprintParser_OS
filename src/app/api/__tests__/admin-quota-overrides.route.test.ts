// @vitest-environment node
// Owner ruling 2026-10-21 ("i want ability to modify the limit for a user"): root-only per-user /
// per-company quota overrides, stored in app_settings["quota_overrides"] (no schema change).
//   • GET/PUT /api/admin/quota-overrides: auth "root" — member 403, company admin 403.
//   • PUT is zod-strict: integers 0..1,000,000 or null; unknown keys 400; subject must exist.
//   • Every change commits with one audit_log row ("quota_override_changed").
//   • The generic /api/admin/app-settings route hides the key from non-root admins and refuses
//     to write it, so no write can skip validation or audit.
//   • End to end: the overrides change what checkUploadQuota decides for a non-root user.
// All writers of the shared document live in THIS file (sequential), and every assertion is keyed
// to this file's own fixture ids, so parallel files that read the document are unaffected.
import { beforeEach, describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { GET, PUT } from "@/app/api/admin/quota-overrides/route";
import { GET as settingsGET, PUT as settingsPUT } from "@/app/api/admin/app-settings/route";
import { db } from "@/lib/db";
import { appSettings, auditLog } from "@/lib/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { checkUploadQuota } from "@/lib/quotas";
import { QUOTA_OVERRIDES_KEY } from "@/lib/quota-overrides";
import {
  asUser,
  createCompany,
  createProject,
  createUser,
  makeReq,
  readJson,
  signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;
const PATH = "/api/admin/quota-overrides";
const get = () => GET(makeReq(PATH, { method: "GET" }));
const put = (body: unknown) => PUT(makeReq(PATH, { method: "PUT", body }));

async function makeWorld() {
  const company = await createCompany();
  const admin = await createUser(company.id, { role: "admin" });
  const member = await createUser(company.id);
  const root = await createUser(company.id, { isRootAdmin: true });
  return { company, admin, member, root };
}

async function auditRowsFor(target: string, id: number) {
  return db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "quota_override_changed"),
        sql`${auditLog.details}->>'target' = ${target}`,
        sql`(${auditLog.details}->>'id')::int = ${id}`,
      ),
    )
    .orderBy(desc(auditLog.id));
}

beforeEach(() => {
  vi.clearAllMocks();
  signedOut();
});

describe.skipIf(!dbUp)("/api/admin/quota-overrides", () => {
  it("auth: signed-out 401; member 403; company admin 403 (read AND write); root 200", async () => {
    const { admin, member, root, company } = await makeWorld();
    expect((await get()).status).toBe(401);
    for (const actor of [member, admin]) {
      asUser(actor);
      let r = await readJson(await get());
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("FORBIDDEN");
      r = await readJson(await put({ target: "company", id: company.id, limits: { uploadsPerDay: null } }));
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("FORBIDDEN");
    }
    expect(await auditRowsFor("company", company.id)).toEqual([]);
    asUser(root);
    const r = await readJson(await get());
    expect(r.status).toBe(200);
    expect(r.body.defaults).toEqual({
      uploadsPerDay: { member: 3, admin: 10 },
      yoloJobsPerDay: 10,
      chatMessagesPerDay: 200,
      lambdaPagesPerDay: 20_000,
    });
    expect(r.body.overrides).toMatchObject({ users: expect.any(Object), companies: expect.any(Object) });
  });

  it("validation 400s: non-integer, negative, > 1,000,000, string, unknown keys, bad target, bad id, unknown subject", async () => {
    const { root, member } = await makeWorld();
    asUser(root);
    const bad = [
      { target: "user", id: member.id, limits: { uploadsPerDay: 1.5 } },
      { target: "user", id: member.id, limits: { uploadsPerDay: -1 } },
      { target: "user", id: member.id, limits: { uploadsPerDay: 1_000_001 } },
      { target: "user", id: member.id, limits: { uploadsPerDay: "5" } },
      { target: "user", id: member.id, limits: { uploadsPerHour: 5 } },
      { target: "user", id: member.id, limits: {}, extra: true },
      { target: "team", id: member.id, limits: {} },
      { target: "user", id: 0, limits: {} },
      { target: "user", id: "12", limits: {} },
      { target: "user", id: member.id },
      { target: "user", id: 2_000_000_000, limits: { uploadsPerDay: 1 } },
      { target: "company", id: 2_000_000_000, limits: { uploadsPerDay: 1 } },
    ];
    for (const body of bad) {
      const r = await readJson(await put(body));
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error.code).toBe("VALIDATION");
    }
    expect(await auditRowsFor("user", member.id)).toEqual([]);
    // boundaries are accepted
    const ok = await readJson(
      await put({ target: "user", id: member.id, limits: { uploadsPerDay: 0, yoloJobsPerDay: 1_000_000, chatMessagesPerDay: null } }),
    );
    expect(ok.status).toBe(200);
    expect(ok.body.overrides.users[String(member.id)]).toEqual({
      uploadsPerDay: 0,
      yoloJobsPerDay: 1_000_000,
      chatMessagesPerDay: null,
    });
  });

  it("root PUT stores the entry, writes one audit row per change, and {} clears it", async () => {
    const { root, member, company } = await makeWorld();
    asUser(root);
    let r = await readJson(await put({ target: "user", id: member.id, limits: { uploadsPerDay: 50 } }));
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    r = await readJson(await put({ target: "company", id: company.id, limits: { yoloJobsPerDay: null } }));
    expect(r.status).toBe(200);

    const doc = (await readJson(await get())).body.overrides;
    expect(doc.users[String(member.id)]).toEqual({ uploadsPerDay: 50 });
    expect(doc.companies[String(company.id)]).toEqual({ yoloJobsPerDay: null });

    const [row] = await db.select().from(appSettings).where(eq(appSettings.key, QUOTA_OVERRIDES_KEY));
    expect(row.updatedBy).toBe(root.id);

    let audits = await auditRowsFor("user", member.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      userId: root.id,
      companyId: root.companyId,
      details: { target: "user", id: member.id, before: null, after: { uploadsPerDay: 50 } },
    });
    expect(await auditRowsFor("company", company.id)).toHaveLength(1);

    r = await readJson(await put({ target: "user", id: member.id, limits: {} }));
    expect(r.status).toBe(200);
    expect(r.body.overrides.users[String(member.id)]).toBeUndefined();
    audits = await auditRowsFor("user", member.id);
    expect(audits).toHaveLength(2);
    expect(audits[0].details).toEqual({ target: "user", id: member.id, before: { uploadsPerDay: 50 }, after: null });
  });

  it("generic app-settings: hides quota_overrides from a company admin, shows it to root, refuses to write it", async () => {
    const { root, admin, member } = await makeWorld();
    asUser(root);
    expect((await put({ target: "user", id: member.id, limits: { chatMessagesPerDay: 7 } })).status).toBe(200);

    asUser(admin);
    let r = await readJson(await settingsGET(makeReq("/api/admin/app-settings", { method: "GET" })));
    expect(r.status).toBe(200);
    expect(Object.prototype.hasOwnProperty.call(r.body, QUOTA_OVERRIDES_KEY)).toBe(false);

    asUser(root);
    r = await readJson(await settingsGET(makeReq("/api/admin/app-settings", { method: "GET" })));
    expect(r.body[QUOTA_OVERRIDES_KEY].users[String(member.id)]).toEqual({ chatMessagesPerDay: 7 });

    r = await readJson(
      await settingsPUT(makeReq("/api/admin/app-settings", { method: "PUT", body: { key: QUOTA_OVERRIDES_KEY, value: {} } })),
    );
    expect(r.status).toBe(400);
    expect(r.body).toEqual({
      error: { code: "VALIDATION", message: "Use /api/admin/quota-overrides to change quota overrides" },
    });
  });

  it("end to end: overrides change checkUploadQuota for a non-root member; clearing restores the default", async () => {
    const { root, member, company } = await makeWorld();
    for (let i = 0; i < 3; i += 1) await createProject(company.id, member.id);
    expect(await checkUploadQuota(company.id, "member", false, member.id)).toMatchObject({
      allowed: false,
      message: "Daily upload limit reached (3/day)",
    });

    asUser(root);
    // company override raises the limit for everyone in the company
    expect((await put({ target: "company", id: company.id, limits: { uploadsPerDay: 5 } })).status).toBe(200);
    expect(await checkUploadQuota(company.id, "member", false, member.id)).toEqual({ allowed: true, current: 3, limit: 5 });
    // user override null = unlimited for that user only
    expect((await put({ target: "user", id: member.id, limits: { uploadsPerDay: null } })).status).toBe(200);
    expect(await checkUploadQuota(company.id, "member", false, member.id)).toEqual({ allowed: true });
    // user override 0 refuses that user even though the company is under its limit
    expect((await put({ target: "user", id: member.id, limits: { uploadsPerDay: 0 } })).status).toBe(200);
    expect(await checkUploadQuota(company.id, "member", false, member.id)).toMatchObject({
      allowed: false,
      message: "Daily upload limit reached (0/day)",
    });
    // root stays exempt whatever is stored for him
    expect((await put({ target: "user", id: root.id, limits: { uploadsPerDay: 0 } })).status).toBe(200);
    expect(await checkUploadQuota(company.id, "member", true, root.id)).toEqual({ allowed: true });
    // clearing both restores the shipped default
    await put({ target: "user", id: member.id, limits: {} });
    await put({ target: "user", id: root.id, limits: {} });
    await put({ target: "company", id: company.id, limits: {} });
    expect(await checkUploadQuota(company.id, "member", false, member.id)).toMatchObject({
      allowed: false,
      message: "Daily upload limit reached (3/day)",
    });
  });

  it("a malformed stored document never breaks the request path and is normalized by the next save", async () => {
    const { root, member, company } = await makeWorld();
    asUser(root);
    // keep the other entries; corrupt only this file's company entry + add junk at the top level
    const [row] = await db.select().from(appSettings).where(eq(appSettings.key, QUOTA_OVERRIDES_KEY));
    const original = row?.value ?? { users: {}, companies: {} };
    const corrupted = {
      ...original,
      junk: [1, 2, 3],
      companies: { ...(original.companies as Record<string, unknown>), [String(company.id)]: { uploadsPerDay: "lots" } },
    };
    await db.update(appSettings).set({ value: corrupted }).where(eq(appSettings.key, QUOTA_OVERRIDES_KEY));
    for (let i = 0; i < 3; i += 1) await createProject(company.id, member.id);
    expect(await checkUploadQuota(company.id, "member", false, member.id)).toMatchObject({ allowed: false, limit: 3 });

    expect((await put({ target: "user", id: member.id, limits: { uploadsPerDay: 9 } })).status).toBe(200);
    const [after] = await db.select().from(appSettings).where(eq(appSettings.key, QUOTA_OVERRIDES_KEY));
    expect(Object.keys(after.value).sort()).toEqual(["companies", "users"]);
    expect((after.value.companies as Record<string, unknown>)[String(company.id)]).toBeUndefined();
    await put({ target: "user", id: member.id, limits: {} });
  });
});
