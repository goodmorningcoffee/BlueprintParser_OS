// @vitest-environment node
// [refactor jul6 S040] CHARACTERIZATION for the ADMIN B5 write-cluster — usage (GET compute
// dashboard + PUT limit/reset mutations) + projects (GET cross-company god-view), written as
// THE FREEZE before the fold onto services/admin-usage.ts + services/admin-projects.ts. B5 is
// a WRITE-CLUSTER: shared freeze, ONE DETECTOR PER ROUTE (DR002 §5). NOT a symmetric pair —
// usage has a 4-branch PUT write; projects is read-only.
//
// All 3 handlers requireRootAdmin (root cross-company). Frozen quirk inventory:
//   • AUTH: 401 flat {error:"Unauthorized"} / 403 flat {error:"Root admin only"}; root passes.
//   • usage GET: 2 raw-SQL aggregates. company agg sums compute_usage.pages FILTER by
//     resource + window-start anchor (null window = all-time), ::int, GROUP BY c.id ORDER BY
//     c.name → {id,name,sagemakerLimit,sagemakerUsed,textractLimit,textractUsed,resetInterval,
//     windowStart}. user agg = sagemaker-only sub-cap → {id,username,email,companyId,
//     sagemakerLimit,sagemakerUsed,windowStart}. No try/catch.
//   • usage PUT: body=req.json().catch(()=>({})) GRACEFUL (malformed→{}); validate
//     target∈{company,user} && Number.isInteger(id) && id>0 → 400 "target ('company'|'user')
//     and a numeric id are required". action=reset → advance usageWindowStart=now. company
//     setSagemaker/TextractLimit → int4 clamp [0,2147483647] else 400 "value must be an
//     integer between 0 and 2147483647". user setSagemakerLimit → null/""/undefined CLEARS
//     the sub-cap, else int4 clamp else 400 "...between 0 and 2147483647, or null".
//     fallthrough → 400 "Unknown or invalid action for target". Each success → {success:true}.
//   • projects GET: cross-company list (innerJoin companies, leftJoin users) ORDER BY
//     createdAt DESC LIMIT 1000 → {projects:[{id:publicId,name,status,numPages,createdAt,
//     companyId,companyName,author}]}.
// Assertions tagged [S040 fold: … applied] were flipped in the fold commit onto
// services/admin-usage.ts (sanctioned A/E only — no catch-500
// literals in B5, so NO B; usage/projects have no try/catch → unexpected errors → generic
// INTERNAL 500, the inherent shell property, not a literal drop).
import { describe, expect, inject, it, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { GET as usageGET, PUT as usagePUT } from "@/app/api/admin/usage/route";
import { GET as projectsGET } from "@/app/api/admin/projects/route";
import { db } from "@/lib/db";
import { companies, users, computeUsage } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  asUser,
  createCompany,
  createUser,
  createProject,
  makeReq,
  readJson,
  signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

async function makeRoot() {
  const company = await createCompany();
  const root = await createUser(company.id, { isRootAdmin: true });
  const member = await createUser(company.id);
  return { company, root, member };
}

const getReq = (path: string) => makeReq(path, { method: "GET" });
const putReq = (body: unknown) => makeReq("/api/admin/usage", { method: "PUT", body });
const rawPut = (raw?: string) =>
  new Request("http://test.local/api/admin/usage", { method: "PUT", headers: { "content-type": "application/json" }, body: raw });

const UNAUTH = { error: { code: "UNAUTHORIZED", message: "Unauthorized" } }; // [S040 fold: A applied]
const ROOT_ONLY = { error: { code: "FORBIDDEN", message: "Root admin only" } }; // [S040 fold: A applied]

async function seedUsage(over: Partial<typeof computeUsage.$inferInsert> & { companyId: number }) {
  await db.insert(computeUsage).values({ resource: "sagemaker", pages: 1, ...over });
}
async function companyRow(id: number) {
  const [r] = await db.select().from(companies).where(eq(companies.id, id)).limit(1);
  return r;
}
async function userRow(id: number) {
  const [r] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return r;
}

beforeEach(() => { vi.clearAllMocks(); signedOut(); });

// ── usage GET — 2 aggregates ──────────────────────────────────────────────────
describe.skipIf(!dbUp)("admin/usage GET (UGET)", () => {
  it("UGET-1 auth: signed-out→401, member→403, root→200", async () => {
    const { root, member } = await makeRoot();
    let r = await readJson(await usageGET(getReq("/api/admin/usage")));
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S040 fold: A applied]
    asUser(member);
    r = await readJson(await usageGET(getReq("/api/admin/usage")));
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ROOT_ONLY); // [S040 fold: A applied]
    asUser(root);
    r = await readJson(await usageGET(getReq("/api/admin/usage")));
    expect(r.status).toBe(200);
  });

  it("UGET-2 company+user aggregates: sums pages per resource, respects window-start anchor", async () => {
    const company = await createCompany({ sagemakerPageLimit: 500, textractPageLimit: 9000 });
    const u = await createUser(company.id, { sagemakerPageLimit: 50 });
    asUser(await createUser(company.id, { isRootAdmin: true }));
    // window-start = null → all sagemaker/textract counted
    await seedUsage({ companyId: company.id, userId: u.id, resource: "sagemaker", pages: 10 });
    await seedUsage({ companyId: company.id, userId: u.id, resource: "sagemaker", pages: 5 });
    await seedUsage({ companyId: company.id, resource: "textract", pages: 7 });
    const r = await readJson(await usageGET(getReq("/api/admin/usage")));
    expect(r.status).toBe(200);
    const c = r.body.companies.find((x: { id: number }) => x.id === company.id);
    expect(c).toMatchObject({ name: company.name, sagemakerLimit: 500, sagemakerUsed: 15, textractLimit: 9000, textractUsed: 7, resetInterval: "manual" });
    const ur = r.body.users.find((x: { id: number }) => x.id === u.id);
    expect(ur).toMatchObject({ username: u.username, email: u.email, companyId: company.id, sagemakerLimit: 50, sagemakerUsed: 15 });
  });

  it("UGET-3 window-start anchor EXCLUDES older usage", async () => {
    const company = await createCompany();
    const root = await createUser(company.id, { isRootAdmin: true });
    // set the company window to NOW; older usage rows must be excluded
    const anchor = new Date();
    await db.update(companies).set({ usageWindowStart: anchor }).where(eq(companies.id, company.id));
    await seedUsage({ companyId: company.id, resource: "sagemaker", pages: 100, createdAt: new Date(anchor.getTime() - 3600_000) }); // before anchor
    await seedUsage({ companyId: company.id, resource: "sagemaker", pages: 3, createdAt: new Date(anchor.getTime() + 1000) }); // after anchor
    asUser(root);
    const r = await readJson(await usageGET(getReq("/api/admin/usage")));
    const c = r.body.companies.find((x: { id: number }) => x.id === company.id);
    expect(c.sagemakerUsed).toBe(3); // only the after-anchor row
  });
});

// ── usage PUT — the 4-branch write ────────────────────────────────────────────
describe.skipIf(!dbUp)("admin/usage PUT (UPUT)", () => {
  it("UPUT-1 auth: signed-out→401", async () => {
    await makeRoot();
    const r = await readJson(await usagePUT(putReq({ target: "company", id: 1, action: "reset" })));
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S040 fold: A applied]
  });

  it("UPUT-2 target/id validation: bad target or non-positive id → 400 literal", async () => {
    const { root } = await makeRoot();
    asUser(root);
    for (const body of [{ action: "reset" }, { target: "x", id: 1 }, { target: "company", id: 0 }, { target: "user", id: -3 }, { target: "company", id: "abc" }]) {
      const r = await readJson(await usagePUT(putReq(body)));
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: { code: "VALIDATION", message: "target ('company'|'user') and a numeric id are required" } }); // [S040 fold: A applied]
    }
  });

  it("UPUT-3 reset: advances usageWindowStart for company AND user", async () => {
    const { company, root } = await makeRoot();
    asUser(root);
    let r = await readJson(await usagePUT(putReq({ target: "company", id: company.id, action: "reset" })));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true });
    expect((await companyRow(company.id)).usageWindowStart).toBeTruthy();
    r = await readJson(await usagePUT(putReq({ target: "user", id: root.id, action: "reset" })));
    expect(r.status).toBe(200);
    expect((await userRow(root.id)).usageWindowStart).toBeTruthy();
  });

  it("UPUT-4 company setSagemakerLimit / setTextractLimit: writes; int4 range 400 literal", async () => {
    const { company, root } = await makeRoot();
    asUser(root);
    let r = await readJson(await usagePUT(putReq({ target: "company", id: company.id, action: "setSagemakerLimit", value: 777 })));
    expect(r.status).toBe(200);
    expect((await companyRow(company.id)).sagemakerPageLimit).toBe(777);
    r = await readJson(await usagePUT(putReq({ target: "company", id: company.id, action: "setTextractLimit", value: 88888 })));
    expect(r.status).toBe(200);
    expect((await companyRow(company.id)).textractPageLimit).toBe(88888);
    // int4 out of range → 400 literal, no write
    for (const value of [-1, 2147483648, 1.5, "x"]) {
      r = await readJson(await usagePUT(putReq({ target: "company", id: company.id, action: "setSagemakerLimit", value })));
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: { code: "VALIDATION", message: "value must be an integer between 0 and 2147483647" } }); // [S040 fold: A applied]
    }
    expect((await companyRow(company.id)).sagemakerPageLimit).toBe(777); // unchanged
  });

  it("UPUT-5 user setSagemakerLimit: sets value; null/''/undefined CLEARS sub-cap; range→400 (or null) literal", async () => {
    const { company, root } = await makeRoot();
    const u = await createUser(company.id, { sagemakerPageLimit: 20 });
    asUser(root);
    let r = await readJson(await usagePUT(putReq({ target: "user", id: u.id, action: "setSagemakerLimit", value: 33 })));
    expect(r.status).toBe(200);
    expect((await userRow(u.id)).sagemakerPageLimit).toBe(33);
    // null clears
    r = await readJson(await usagePUT(putReq({ target: "user", id: u.id, action: "setSagemakerLimit", value: null })));
    expect(r.status).toBe(200);
    expect((await userRow(u.id)).sagemakerPageLimit).toBeNull();
    // "" also clears (frozen)
    await db.update(users).set({ sagemakerPageLimit: 99 }).where(eq(users.id, u.id));
    r = await readJson(await usagePUT(putReq({ target: "user", id: u.id, action: "setSagemakerLimit", value: "" })));
    expect(r.status).toBe(200);
    expect((await userRow(u.id)).sagemakerPageLimit).toBeNull();
    // out of range → 400 "...or null" literal (distinct from company message)
    r = await readJson(await usagePUT(putReq({ target: "user", id: u.id, action: "setSagemakerLimit", value: 2147483648 })));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: { code: "VALIDATION", message: "value must be an integer between 0 and 2147483647, or null" } }); // [S040 fold: A applied]
  });

  it("UPUT-6 unknown action / invalid target+action combo → 400 fallthrough literal", async () => {
    const { company, root } = await makeRoot();
    asUser(root);
    for (const body of [
      { target: "company", id: company.id, action: "bogus" },
      { target: "user", id: root.id, action: "setTextractLimit", value: 5 }, // textract is company-only
    ]) {
      const r = await readJson(await usagePUT(putReq(body)));
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: { code: "VALIDATION", message: "Unknown or invalid action for target" } }); // [S040 fold: A applied]
    }
  });

  it("UPUT-7 malformed body: legacy req.json().catch(()=>({})) GRACEFUL → 400 'target required'", async () => {
    const { root } = await makeRoot();
    asUser(root);
    // [S040 fold: E — shell raw-parse → 400 BAD_REQUEST "Invalid JSON body" (message/code drift; both 400)]
    const r = await readJson(await usagePUT(rawPut("{oops")));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: { code: "BAD_REQUEST", message: "Invalid JSON body" } }); // [S040 fold: E applied]
  });
});

// ── projects GET — cross-company god-view (read-only) ─────────────────────────
describe.skipIf(!dbUp)("admin/projects GET (PROJ)", () => {
  it("PROJ-1 auth: signed-out→401, member→403", async () => {
    const { member } = await makeRoot();
    let r = await readJson(await projectsGET(getReq("/api/admin/projects")));
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S040 fold: A applied]
    asUser(member);
    r = await readJson(await projectsGET(getReq("/api/admin/projects")));
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ROOT_ONLY); // [S040 fold: A applied]
  });

  it("PROJ-2 cross-company god-view: lists projects from MULTIPLE companies, publicId + joined names", async () => {
    const cA = await createCompany();
    const uA = await createUser(cA.id);
    const pA = await createProject(cA.id, uA.id, { name: "Alpha" });
    const cB = await createCompany();
    const uB = await createUser(cB.id);
    const pB = await createProject(cB.id, uB.id, { name: "Bravo" });
    asUser(await createUser(cA.id, { isRootAdmin: true }));
    const r = await readJson(await projectsGET(getReq("/api/admin/projects")));
    expect(r.status).toBe(200);
    const mine = r.body.projects.filter((p: { id: string }) => [pA.publicId, pB.publicId].includes(p.id));
    expect(mine).toHaveLength(2); // BOTH companies visible (cross-company god-view)
    const a = mine.find((p: { id: string }) => p.id === pA.publicId);
    expect(a).toMatchObject({ name: "Alpha", companyId: cA.id, companyName: cA.name, author: uA.username });
    expect(a.id).toBe(pA.publicId); // exposes publicId, not internal id
  });
});
