// @vitest-environment node
// [refactor jul8 S058] CHARACTERIZATION for the admin/users SOLO (GET list + POST create +
// PUT update + DELETE reassign/cascade), written as THE FREEZE before the fold onto
// services/admin-users.ts. Solo. requireAdmin on all 4. ⚠️ SAFETY: @/lib/project-delete is
// MODULE-MOCKED (deleteProjectFully fires S3 deletes UNCONDITIONALLY + SFN StopExecution when
// STEP_FUNCTION_ARN is set — leaving the env unset is INSUFFICIENT; the mock severs both with
// one seam). @/lib/audit mocked (fire-and-forget db write). bcrypt REAL (never assert hash
// bytes — verify via bcrypt.compare). Frozen quirk inventory:
//   • GET: BARE ARRAY. Root → all companies + companyName; regular admin → own company only,
//     companyName undefined (key dropped). INNER perms try/catch = DATA fallback (throw →
//     canRunModels = role==="admin", isRootAdmin=false) — BUSINESS logic, stays in-service,
//     NOT a sanctioned B.
//   • POST: email lowercased/trimmed BEFORE validation; "username, email, password required"
//     @400; "Password must be at least 8 characters" @400 (<8); "Email already exists" @400;
//     root+companyId → target company, non-root forced own; role==="admin" → role admin +
//     canRunModels true, else member/false; bcrypt.hash(pw,12); catch :109 = err.message LEAK
//     [fold: B → generic INTERNAL 500]. {success:true}.
//   • PUT: publicId lookup; "id required" @400; miss AND cross-company BOTH → "User not found"
//     @404 (no existence leak); canRunModels boolean-gated for any admin; role/companyId
//     ROOT-gated (silently ignored for regular admin); updatedAt always; catch :149 = FIXED
//     literal "Update failed" @500 [fold: B → generic INTERNAL 500]. {success:true}.
//   • DELETE: 9-literal validation ladder (see US-12); reassign default → acting admin;
//     reassignTo publicId honored (in-company for non-root); cascade → deleteProjectFully per
//     owned project (root: unscoped by company; admin: company-scoped select) BEFORE the tx;
//     tx = reassign projects + null 5 soft-attribution FKs + delete user (all-or-nothing);
//     audit("user_deleted") fire-and-forget; catch :270 = err.message LEAK + logger.error
//     "[user-delete] Failed" [fold: B → generic INTERNAL 500, KEEP the logger breadcrumb via
//     in-service try/log/re-throw]. {success:true, mode, projectCount}.
// GET no body → NO E. POST/PUT/DELETE read req.json() → E at fold. THREE B catch-drops at fold
// (POST:109 leak, PUT:149 fixed literal, DELETE:270 leak-keep-logger) — DR002-sanctioned.
// Assertions tagged [S058 fold: … applied] were flipped in the fold commit.
import { describe, expect, inject, it, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

const h = vi.hoisted(() => ({
  deleteProjectFully: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("@/lib/project-delete", () => ({ deleteProjectFully: h.deleteProjectFully }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));

import { GET as usGET, POST as usPOST, PUT as usPUT, DELETE as usDELETE } from "@/app/api/admin/users/route";
import { db } from "@/lib/db";
import { users, projects, annotations } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import bcrypt from "bcrypt";
import { logger } from "@/lib/logger";
import { asUser, createCompany, createProject, createUser, makeReq, readJson, signedOut } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

// [S058 fold: A applied] — at freeze these were the legacy flat bodies
// UNAUTH={error:"Unauthorized"}, ADMIN_ONLY={error:"Admin only"}.
const UNAUTH = { error: { code: "UNAUTHORIZED", message: "Unauthorized" } };
const ADMIN_ONLY = { error: { code: "FORBIDDEN", message: "Admin only" } };
const A = {
  validation: (message: string) => ({ error: { code: "VALIDATION", message } }),
  notFound: (message: string) => ({ error: { code: "NOT_FOUND", message } }),
};
const INTERNAL = { error: { code: "INTERNAL", message: "Internal server error" } };

async function makeWorld() {
  const company = await createCompany();
  const admin = await createUser(company.id, { role: "admin" });
  const member = await createUser(company.id);
  const root = await createUser(company.id, { isRootAdmin: true, role: "admin" });
  return { company, admin, member, root };
}

async function userByPublicId(publicId: string) {
  const [u] = await db.select().from(users).where(eq(users.publicId, publicId)).limit(1);
  return u;
}
async function publicIdOf(dbId: number) {
  const [u] = await db.select({ publicId: users.publicId }).from(users).where(eq(users.id, dbId)).limit(1);
  return u.publicId;
}

const getReq = () => makeReq("/api/admin/users", { method: "GET" });
const postReq = (body: unknown) => makeReq("/api/admin/users", { method: "POST", body });
const putReq = (body: unknown) => makeReq("/api/admin/users", { method: "PUT", body });
const delReq = (body: unknown) => makeReq("/api/admin/users", { method: "DELETE", body });
const malformed = (method: string) =>
  new Request("http://test.local/api/admin/users", {
    method, headers: { "content-type": "application/json" }, body: "{ nope",
  });

beforeEach(() => {
  vi.clearAllMocks();
  signedOut();
  // The mock severs S3 + SFN but MUST mimic the real fn's DB effect (project row deleted) —
  // otherwise the cascade's subsequent user-delete violates projects.authorId FK and the
  // route 500s where production succeeds.
  h.deleteProjectFully.mockImplementation(async (p: { id: number }) => {
    await db.delete(projects).where(eq(projects.id, p.id));
  });
  h.audit.mockResolvedValue(undefined);
});

describe.skipIf(!dbUp)("admin/users (US)", () => {
  // ── auth (A) ────────────────────────────────────────────────────────────────
  it("US-1 auth: all methods signed-out→401, member→403", async () => {
    const { member } = await makeWorld();
    const calls = [
      () => usGET(getReq()),
      () => usPOST(postReq({ username: "u", email: "e@x.t", password: "longenough" })),
      () => usPUT(putReq({ id: "x" })),
      () => usDELETE(delReq({ id: "x" })),
    ];
    for (const call of calls) {
      const r = await readJson(await call());
      expect(r.status).toBe(401);
      expect(r.body).toEqual(UNAUTH); // [S058 fold: A applied]
    }
    asUser(member);
    for (const call of calls) {
      const r = await readJson(await call());
      expect(r.status).toBe(403);
      expect(r.body).toEqual(ADMIN_ONLY); // [S058 fold: A applied]
    }
  });

  // ── GET ─────────────────────────────────────────────────────────────────────
  it("US-2 GET regular admin: BARE ARRAY, own company only, no companyName, per-row perms", async () => {
    const { company, admin, member } = await makeWorld();
    const otherCo = await createCompany();
    const foreign = await createUser(otherCo.id);
    asUser(admin);
    const r = await readJson(await usGET(getReq()));
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true); // bare array, never enveloped
    const ids = r.body.map((u: { id: string }) => u.id);
    const adminPub = await publicIdOf(admin.id);
    const memberPub = await publicIdOf(member.id);
    const foreignPub = await publicIdOf(foreign.id);
    expect(ids).toContain(adminPub);
    expect(ids).toContain(memberPub);
    expect(ids).not.toContain(foreignPub); // company-scoped
    const me = r.body.find((u: { id: string }) => u.id === adminPub);
    // canRunModels reflects the REAL column (harness default false) — NOT role-derived;
    // contrast with US-4 where the perms-query fallback DOES derive true from role==="admin".
    expect(me).toMatchObject({ role: "admin", canRunModels: false, isRootAdmin: false });
    expect(me.companyName).toBeUndefined(); // non-root: no company map
    const mem = r.body.find((u: { id: string }) => u.id === memberPub);
    expect(mem).toMatchObject({ role: "member", canRunModels: false });
  });

  it("US-3 GET root: all companies, companyName populated", async () => {
    const { company, root } = await makeWorld();
    const otherCo = await createCompany();
    const foreign = await createUser(otherCo.id);
    asUser(root);
    const r = await readJson(await usGET(getReq()));
    const foreignPub = await publicIdOf(foreign.id);
    const row = r.body.find((u: { id: string }) => u.id === foreignPub);
    expect(row).toBeTruthy(); // cross-company visible to root
    expect(row.companyName).toBe(otherCo.name);
    const mine = r.body.find((u: { id: string; companyId: number }) => u.companyId === company.id);
    expect(mine.companyName).toBe(company.name);
  });

  it("US-4 GET perms-query fallback: 2nd select throws → canRunModels=(role==='admin'), isRootAdmin=false (NOT a 500)", async () => {
    const { admin, member } = await makeWorld();
    asUser(admin);
    const realSelect = db.select.bind(db);
    let n = 0;
    const spy = vi.spyOn(db, "select").mockImplementation(((...a: unknown[]) => {
      n += 1;
      if (n === 2) throw new Error("perms query down"); // the canRunModels/isRootAdmin select
      return (realSelect as (...args: unknown[]) => unknown)(...a);
    }) as typeof db.select);
    const r = await readJson(await usGET(getReq()));
    spy.mockRestore();
    expect(r.status).toBe(200); // business fallback, not an error
    const adminPub = await publicIdOf(admin.id);
    const memberPub = await publicIdOf(member.id);
    expect(r.body.find((u: { id: string }) => u.id === adminPub)).toMatchObject({ canRunModels: true, isRootAdmin: false }); // role==='admin'
    expect(r.body.find((u: { id: string }) => u.id === memberPub)).toMatchObject({ canRunModels: false, isRootAdmin: false });
  });

  // ── POST ────────────────────────────────────────────────────────────────────
  it("US-5 POST validation ladder: required fields, short password, duplicate email (normalized)", async () => {
    const { admin } = await makeWorld();
    asUser(admin);
    for (const body of [{}, { username: "u" }, { username: "u", email: "e@x.t" }]) {
      const r = await readJson(await usPOST(postReq(body)));
      expect(r.status).toBe(400);
      expect(r.body).toEqual(A.validation("username, email, password required")); // [S058 fold: A applied]
    }
    let r = await readJson(await usPOST(postReq({ username: "u", email: "e@x.t", password: "short7c" })));
    expect(r.status).toBe(400);
    expect(r.body).toEqual(A.validation("Password must be at least 8 characters")); // [S058 fold: A applied]
    // duplicate email — existing row is lowercase; POST an upper/spaced variant → normalized match
    const dup = `dup-${Date.now()}@x.test`;
    await readJson(await usPOST(postReq({ username: "first", email: dup, password: "longenough" })));
    r = await readJson(await usPOST(postReq({ username: "second", email: `  ${dup.toUpperCase()}  `, password: "longenough" })));
    expect(r.status).toBe(400);
    expect(r.body).toEqual(A.validation("Email already exists")); // [S058 fold: A applied]
  });

  it("US-6 POST happy: member default vs role admin; email normalized; bcrypt(12) verifies; {success:true}", async () => {
    const { company, admin } = await makeWorld();
    asUser(admin);
    const email = `New-${Date.now()}@X.Test`;
    const r = await readJson(await usPOST(postReq({ username: "newbie", email: `  ${email}  `, password: "longenough" })));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true });
    const [row] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
    expect(row).toMatchObject({ username: "newbie", role: "member", canRunModels: false, companyId: company.id });
    expect(await bcrypt.compare("longenough", row.passwordHash!)).toBe(true);
    // role:"admin" → admin + canRunModels
    const email2 = `adm-${Date.now()}@x.test`;
    await readJson(await usPOST(postReq({ username: "adminette", email: email2, password: "longenough", role: "admin" })));
    const [row2] = await db.select().from(users).where(eq(users.email, email2)).limit(1);
    expect(row2).toMatchObject({ role: "admin", canRunModels: true });
  });

  it("US-7 POST scope: root+companyId → target company; non-root companyId IGNORED (own)", async () => {
    const { company, admin, root } = await makeWorld();
    const targetCo = await createCompany();
    asUser(root);
    const e1 = `r-${Date.now()}@x.test`;
    await readJson(await usPOST(postReq({ username: "rooted", email: e1, password: "longenough", companyId: targetCo.id })));
    expect((await db.select().from(users).where(eq(users.email, e1)))[0].companyId).toBe(targetCo.id);
    asUser(admin);
    const e2 = `a-${Date.now()}@x.test`;
    await readJson(await usPOST(postReq({ username: "scoped", email: e2, password: "longenough", companyId: targetCo.id })));
    expect((await db.select().from(users).where(eq(users.email, e2)))[0].companyId).toBe(company.id); // forced own
  });

  it("US-8 POST insert throws → 500 err.message LEAK (legacy)", async () => {
    const { admin } = await makeWorld();
    asUser(admin);
    const spy = vi.spyOn(db, "insert").mockImplementationOnce(() => { throw new Error("boom-insert"); });
    const r = await readJson(await usPOST(postReq({ username: "u", email: `l-${Date.now()}@x.t`, password: "longenough" })));
    spy.mockRestore();
    expect(r.status).toBe(500);
    // [S058 fold: B applied — the :109 err.message leak ({error:"boom-insert"}) is RETIRED
    // to the shell generic INTERNAL]
    expect(r.body).toEqual(INTERNAL);
  });

  // ── PUT ─────────────────────────────────────────────────────────────────────
  it("US-9 PUT: no id 400; miss + cross-company BOTH 'User not found' 404 (no existence leak)", async () => {
    const { admin } = await makeWorld();
    const otherCo = await createCompany();
    const foreign = await createUser(otherCo.id);
    asUser(admin);
    let r = await readJson(await usPUT(putReq({})));
    expect(r.status).toBe(400);
    expect(r.body).toEqual(A.validation("id required")); // [S058 fold: A applied]
    r = await readJson(await usPUT(putReq({ id: "00000000-0000-4000-8000-000000000000" })));
    expect(r.status).toBe(404);
    expect(r.body).toEqual(A.notFound("User not found")); // [S058 fold: A applied]
    r = await readJson(await usPUT(putReq({ id: await publicIdOf(foreign.id), canRunModels: true })));
    expect(r.status).toBe(404);
    expect(r.body).toEqual(A.notFound("User not found")); // [S058 fold: A applied] — same msg cross-company
  });

  it("US-10 PUT gates: canRunModels any-admin; role/companyId ROOT-only (silently ignored otherwise)", async () => {
    const { company, admin, member, root } = await makeWorld();
    const otherCo = await createCompany();
    const memberPub = await publicIdOf(member.id);
    asUser(admin);
    let r = await readJson(await usPUT(putReq({ id: memberPub, canRunModels: true, role: "admin", companyId: otherCo.id })));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true });
    let row = await userByPublicId(memberPub);
    expect(row).toMatchObject({ canRunModels: true, role: "member", companyId: company.id }); // role+company IGNORED
    // canRunModels only applies when boolean
    r = await readJson(await usPUT(putReq({ id: memberPub, canRunModels: "yes" })));
    expect((await userByPublicId(memberPub)).canRunModels).toBe(true); // unchanged (string ignored)
    // root: role + companyId applied
    asUser(root);
    r = await readJson(await usPUT(putReq({ id: memberPub, role: "admin", companyId: otherCo.id })));
    row = await userByPublicId(memberPub);
    expect(row).toMatchObject({ role: "admin", companyId: otherCo.id });
  });

  it("US-11 PUT update throws → 500 FIXED literal 'Update failed' (legacy)", async () => {
    const { admin, member } = await makeWorld();
    asUser(admin);
    const memberPub = await publicIdOf(member.id);
    const spy = vi.spyOn(db, "update").mockImplementationOnce(() => { throw new Error("boom-update"); });
    const r = await readJson(await usPUT(putReq({ id: memberPub, canRunModels: false })));
    spy.mockRestore();
    expect(r.status).toBe(500);
    // [S058 fold: B applied — the :149 fixed catch-500 literal ({error:"Update failed"}) is
    // RETIRED to the shell generic INTERNAL]
    expect(r.body).toEqual(INTERNAL);
  });

  // ── DELETE ──────────────────────────────────────────────────────────────────
  it("US-12 DELETE validation ladder: all 9 literals byte-verbatim", async () => {
    const { company, admin, member, root } = await makeWorld();
    const otherCo = await createCompany();
    const foreign = await createUser(otherCo.id);
    const memberPub = await publicIdOf(member.id);
    asUser(admin);
    const cases: Array<[unknown, number, string]> = [
      [{}, 400, "User id required"],
      [{ id: memberPub, mode: "nuke" }, 400, "mode must be 'reassign' or 'cascade'"],
      [{ id: "00000000-0000-4000-8000-000000000000" }, 404, "User not found"],
      [{ id: await publicIdOf(foreign.id) }, 404, "User not found"], // cross-company
      [{ id: await publicIdOf(admin.id) }, 400, "Cannot delete yourself"],
      [{ id: await publicIdOf(root.id) }, 400, "Cannot delete root admin"],
      [{ id: memberPub, reassignTo: "00000000-0000-4000-8000-000000000000" }, 400, "Reassign target not found"],
      [{ id: memberPub, reassignTo: await publicIdOf(foreign.id) }, 400, "Reassign target must be in your company"],
      [{ id: memberPub, reassignTo: memberPub }, 400, "Cannot reassign projects to the user being deleted"],
    ];
    for (const [body, status, msg] of cases) {
      const r = await readJson(await usDELETE(delReq(body)));
      expect(r.status).toBe(status);
      // [S058 fold: A applied — code from status: 400→VALIDATION, 404→NOT_FOUND]
      expect(r.body).toEqual(status === 404 ? A.notFound(msg) : A.validation(msg));
    }
  });

  it("US-13 DELETE reassign (default → acting admin): projects moved, soft-FKs nulled, user gone, audit fired, NO deleteProjectFully", async () => {
    const { company, admin } = await makeWorld();
    const victim = await createUser(company.id);
    const victimPub = await publicIdOf(victim.id);
    const p1 = await createProject(company.id, victim.id);
    const p2 = await createProject(company.id, victim.id);
    const [ann] = await db.insert(annotations).values({
      projectId: p1.id, name: "a", minX: 0, minY: 0, maxX: 0.5, maxY: 0.5, pageNumber: 1, creatorId: victim.id,
    }).returning();
    asUser(admin);
    const r = await readJson(await usDELETE(delReq({ id: victimPub })));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, mode: "reassign", projectCount: 2 });
    expect(h.deleteProjectFully).not.toHaveBeenCalled();
    for (const p of [p1, p2]) {
      const [row] = await db.select({ authorId: projects.authorId }).from(projects).where(eq(projects.id, p.id));
      expect(row.authorId).toBe(admin.id); // default reassign target = acting admin
    }
    const [annRow] = await db.select({ creatorId: annotations.creatorId }).from(annotations).where(eq(annotations.id, ann.id));
    expect(annRow.creatorId).toBeNull(); // soft-attribution nulled in the tx
    expect(await userByPublicId(victimPub)).toBeUndefined();
    expect(h.audit).toHaveBeenCalledWith("user_deleted", expect.objectContaining({
      userId: admin.id, companyId: company.id,
      details: expect.objectContaining({ deletedUserId: victimPub, mode: "reassign", projectCount: 2, reassignTargetId: admin.id }),
    }));
  });

  it("US-14 DELETE reassign explicit reassignTo publicId honored", async () => {
    const { company, admin } = await makeWorld();
    const victim = await createUser(company.id);
    const heir = await createUser(company.id);
    const p = await createProject(company.id, victim.id);
    asUser(admin);
    const r = await readJson(await usDELETE(delReq({ id: await publicIdOf(victim.id), reassignTo: await publicIdOf(heir.id) })));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, mode: "reassign", projectCount: 1 });
    const [row] = await db.select({ authorId: projects.authorId }).from(projects).where(eq(projects.id, p.id));
    expect(row.authorId).toBe(heir.id);
  });

  it("US-15 DELETE cascade: deleteProjectFully once per owned project (BEFORE the tx), user gone, counts", async () => {
    const { company, admin } = await makeWorld();
    const victim = await createUser(company.id);
    const victimPub = await publicIdOf(victim.id);
    const p1 = await createProject(company.id, victim.id);
    const p2 = await createProject(company.id, victim.id);
    asUser(admin);
    const r = await readJson(await usDELETE(delReq({ id: victimPub, mode: "cascade" })));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, mode: "cascade", projectCount: 2 });
    expect(h.deleteProjectFully).toHaveBeenCalledTimes(2);
    const calledIds = h.deleteProjectFully.mock.calls.map((c) => (c[0] as { id: number }).id).sort();
    expect(calledIds).toEqual([p1.id, p2.id].sort());
    expect(await userByPublicId(victimPub)).toBeUndefined();
    expect(h.audit).toHaveBeenCalledWith("user_deleted", expect.objectContaining({
      details: expect.objectContaining({ mode: "cascade", projectCount: 2, reassignTargetId: undefined }),
    }));
  });

  it("US-16 DELETE tx failure → 500 err.message LEAK + logger breadcrumb (legacy)", async () => {
    const { company, admin } = await makeWorld();
    const victim = await createUser(company.id);
    asUser(admin);
    const logSpy = vi.spyOn(logger, "error");
    const spy = vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("boom-tx"));
    const r = await readJson(await usDELETE(delReq({ id: await publicIdOf(victim.id) })));
    spy.mockRestore();
    expect(r.status).toBe(500);
    // [S058 fold: B applied — the :270 err.message leak ({error:"boom-tx"}) is RETIRED to
    // the shell generic INTERNAL; the '[user-delete] Failed' logger.error breadcrumb
    // SURVIVES via the in-service try/log/re-throw]
    expect(r.body).toEqual(INTERNAL);
    // [S058 DETECTOR closer P2] the breadcrumb is the WHOLE POINT of the try/log/re-throw —
    // pin it (the objectContaining 2nd arg distinguishes it from the shell's string-only
    // '[route] …' log; a bare-propagate mutation would pass without this assert).
    expect(logSpy).toHaveBeenCalledWith("[user-delete] Failed", expect.objectContaining({ mode: "reassign", err: expect.anything() }));
    logSpy.mockRestore();
    expect(await userByPublicId(await publicIdOf(victim.id))).toBeTruthy(); // nothing deleted
  });

  // ── DETECTOR closers (wf_9933fb7e-4b9 P1/P4/P3) ─────────────────────────────
  it("US-18 [closer P1] ROOT cascade of a CROSS-COMPANY victim: unscoped owned-select arm", async () => {
    const { root } = await makeWorld();
    const otherCo = await createCompany();
    const victim = await createUser(otherCo.id);
    const victimPub = await publicIdOf(victim.id);
    const p = await createProject(otherCo.id, victim.id);
    asUser(root);
    const r = await readJson(await usDELETE(delReq({ id: victimPub, mode: "cascade" })));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, mode: "cascade", projectCount: 1 });
    // proves the root arm is eq(authorId) UNSCOPED by company — a companyId filter added to
    // the root arm would orphan the cross-company victim's projects and fail here loudly
    expect(h.deleteProjectFully).toHaveBeenCalledTimes(1);
    expect((h.deleteProjectFully.mock.calls[0][0] as { id: number }).id).toBe(p.id);
    expect(await userByPublicId(victimPub)).toBeUndefined();
  });

  it("US-19 [closer P4] ROOT reassign bypasses BOTH cross-company gates (victim gate + heir gate)", async () => {
    const { root } = await makeWorld();
    const otherCo = await createCompany();
    const victim = await createUser(otherCo.id);
    const heirCo = await createCompany();
    const heir = await createUser(heirCo.id);
    const p = await createProject(otherCo.id, victim.id);
    asUser(root);
    // root deletes a cross-company victim (non-root would 404) AND reassigns to a heir in a
    // THIRD company (non-root would 400 'Reassign target must be in your company')
    const r = await readJson(await usDELETE(delReq({ id: await publicIdOf(victim.id), reassignTo: await publicIdOf(heir.id) })));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, mode: "reassign", projectCount: 1 });
    const [row] = await db.select({ authorId: projects.authorId }).from(projects).where(eq(projects.id, p.id));
    expect(row.authorId).toBe(heir.id);
  });

  it("US-20 [closer P3 pin] non-object JSON bodies → shell zLooseBody VALIDATION 400 (uniform shell property)", async () => {
    const { admin } = await makeWorld();
    asUser(admin);
    // Legacy destructured an array to all-undefined (POST → the required-fields 400) and
    // THREW on null/empty (unhandled 500). The shell's z.record object-ness check yields a
    // uniform VALIDATION 400 instead — repo-wide shell property (remerge precedent, DR006
    // noted-not-drift), pinned here so it cannot silently shift.
    for (const body of ["[1,2]", "null", ""] as const) {
      const r = await readJson(await usPOST(new Request("http://test.local/api/admin/users", {
        method: "POST", headers: { "content-type": "application/json" }, body,
      })));
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("VALIDATION");
    }
  });

  // ── E (malformed body) ──────────────────────────────────────────────────────
  it("US-17 malformed JSON on POST/PUT/DELETE → 400 'Invalid JSON body'", async () => {
    const { admin } = await makeWorld();
    asUser(admin);
    // [S058 fold: E applied — legacy `await req.json()` threw (handler rejected)]
    for (const call of [usPOST(malformed("POST")), usPUT(malformed("PUT")), usDELETE(malformed("DELETE"))]) {
      const r = await readJson(await call);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: { code: "BAD_REQUEST", message: "Invalid JSON body" } });
    }
  });
});
