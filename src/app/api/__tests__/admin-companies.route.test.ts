// @vitest-environment node
// [refactor jul6 S043] CHARACTERIZATION for the admin/companies SOLO — a 4-method ROOT write
// route (GET list+counts, POST create, PUT update, DELETE with empty-check guards), written
// as THE FREEZE before the fold onto services/companies.ts. Solo (own DETECTOR + write-safety
// lane per DR004). ALL methods requireRootAdmin (root-only; company-admin → 403 "Root admin
// only"). Frozen quirk inventory:
//   • AUTH: 401 flat {error:"Unauthorized"} / 403 flat {error:"Root admin only"}; root passes.
//   • GET: all companies ORDER BY name + per-company user counts + NON-DEMO project counts
//     (projects WHERE is_demo=false) → {companies:[{id,publicId,name,accessKey,dataKey,
//     userCount,projectCount,createdAt}]}.
//   • POST: name.trim() required → 400 "Company name required". accessKey = randomBytes(16)
//     hex (32 chars); dataKey = slug(name: lower, [^a-z0-9]→"-", collapse "-", slice 30) +
//     "-" + randomBytes(4) hex (8 chars). Insert w/ emailDomain:"" subscription:0 →
//     {id,publicId,name,accessKey,dataKey}.
//   • PUT: companyId required → 400 "companyId required". Conditional: name if trim,
//     accessKey regen if regenerateKey, ALWAYS updatedAt → {company: updated-row}.
//   • DELETE: companyId required → 400. Empty-check GUARDS: users>0 → 400 "Cannot delete
//     company with existing users. Remove all users first."; projects>0 → 400 "Cannot delete
//     company with existing projects. Delete all projects first."; else delete → {success:true}.
// crypto → keys non-deterministic: assert PATTERNS (hex length) + slug prefix, not exact values.
// Assertions tagged [S043 fold: … applied] were flipped in the fold commit onto
// services/companies.ts (sanctioned A/E only — no catch-500 → NO B).
import { describe, expect, inject, it, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { GET as coGET, POST as coPOST, PUT as coPUT, DELETE as coDELETE } from "@/app/api/admin/companies/route";
import { db } from "@/lib/db";
import { companies, projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { asUser, createCompany, createUser, createProject, makeReq, readJson, signedOut } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

const tag = () => Math.random().toString(36).slice(2, 8);
async function makeRoot() {
  const company = await createCompany();
  const root = await createUser(company.id, { isRootAdmin: true });
  const admin = await createUser(company.id, { role: "admin" });
  return { company, root, admin };
}

const getReq = () => makeReq("/api/admin/companies", { method: "GET" });
const bodyReq = (method: string, body?: unknown) => makeReq("/api/admin/companies", { method, body });
const UNAUTH = { error: { code: "UNAUTHORIZED", message: "Unauthorized" } }; // [S043 fold: A applied]
const ROOT_ONLY = { error: { code: "FORBIDDEN", message: "Root admin only" } }; // [S043 fold: A applied]

async function companyById(id: number) {
  const [c] = await db.select().from(companies).where(eq(companies.id, id)).limit(1);
  return c;
}

beforeEach(() => { vi.clearAllMocks(); signedOut(); });

describe.skipIf(!dbUp)("admin/companies (CO, requireRootAdmin)", () => {
  it("CO-1 auth: signed-out→401, company-admin→403 (root-only), root→200", async () => {
    const { root, admin } = await makeRoot();
    let r = await readJson(await coGET(getReq()));
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S043 fold: A applied]
    asUser(admin); // a company-ADMIN is still 403 — this route is ROOT-only
    r = await readJson(await coGET(getReq()));
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ROOT_ONLY); // [S043 fold: A applied]
    asUser(root);
    expect((await readJson(await coGET(getReq()))).status).toBe(200);
  });

  it("CO-2 GET: list ORDER BY name + user/NON-DEMO project counts", async () => {
    const { company, root } = await makeRoot();
    // our company already has 2 users (root+admin); add 2 projects, one demo (excluded)
    const author = await createUser(company.id);
    await createProject(company.id, author.id);
    await createProject(company.id, author.id, { isDemo: true } as never);
    asUser(root);
    const r = await readJson(await coGET(getReq()));
    expect(r.status).toBe(200);
    const c = r.body.companies.find((x: { id: number }) => x.id === company.id);
    expect(c).toMatchObject({ publicId: company.publicId, name: company.name, accessKey: company.accessKey, dataKey: company.dataKey });
    expect(c.userCount).toBeGreaterThanOrEqual(3); // root + admin + author
    expect(c.projectCount).toBe(1); // the demo project is EXCLUDED (is_demo=false filter)
    // ORDER BY name — companies sorted ascending
    const names = r.body.companies.map((x: { name: string }) => x.name);
    expect(names).toEqual([...names].sort());
  });

  it("CO-3 POST: name required → 400 'Company name required'", async () => {
    const { root } = await makeRoot();
    asUser(root);
    for (const body of [{}, { name: "" }, { name: "   " }]) {
      const r = await readJson(await coPOST(bodyReq("POST", body)));
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: { code: "VALIDATION", message: "Company name required" } }); // [S043 fold: A applied]
    }
  });

  it("CO-4 POST create: generates accessKey(32 hex) + dataKey(slug-8hex), inserts w/ emailDomain='' subscription=0", async () => {
    const { root } = await makeRoot();
    asUser(root);
    const name = `Acme ${tag()} Co!`;
    const r = await readJson(await coPOST(bodyReq("POST", { name })));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ name }); // name stored trimmed = name here (no outer spaces)
    expect(r.body.accessKey).toMatch(/^[0-9a-f]{32}$/); // randomBytes(16) hex
    // dataKey = slug + "-" + 8 hex; slug = lower, non-alnum→"-", collapse, slice 30
    const slug = name.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-").slice(0, 30);
    expect(r.body.dataKey).toMatch(new RegExp(`^${slug}-[0-9a-f]{8}$`));
    expect(r.body.publicId).toBeTruthy();
    // persisted row: emailDomain "" + subscription 0
    const row = await companyById(r.body.id);
    expect(row.emailDomain).toBe("");
    expect(row.subscription).toBe(0);
    expect(row.name).toBe(name);
  });

  it("CO-5 PUT: companyId required → 400; update name + regenerateKey; conditional", async () => {
    const { company, root } = await makeRoot();
    asUser(root);
    let r = await readJson(await coPUT(bodyReq("PUT", {})));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: { code: "VALIDATION", message: "companyId required" } }); // [S043 fold: A applied]
    const origKey = company.accessKey;
    const newName = `Renamed ${tag()}`;
    r = await readJson(await coPUT(bodyReq("PUT", { companyId: company.id, name: newName, regenerateKey: true })));
    expect(r.status).toBe(200);
    expect(r.body.company).toMatchObject({ id: company.id, name: newName });
    expect(r.body.company.accessKey).not.toBe(origKey); // regenerated
    expect(r.body.company.accessKey).toMatch(/^[0-9a-f]{32}$/);
    // regenerateKey=false + blank name → name unchanged, key unchanged
    const keyAfter = r.body.company.accessKey;
    r = await readJson(await coPUT(bodyReq("PUT", { companyId: company.id, name: "   " })));
    expect(r.body.company.name).toBe(newName); // blank name skipped
    expect(r.body.company.accessKey).toBe(keyAfter); // no regen
  });

  it("CO-6 DELETE: companyId required → 400; empty-check guards; empty company deletes", async () => {
    const { root } = await makeRoot();
    asUser(root);
    let r = await readJson(await coDELETE(bodyReq("DELETE", {})));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: { code: "VALIDATION", message: "companyId required" } }); // [S043 fold: A applied]
    // company WITH a user → blocked
    const withUser = await createCompany();
    await createUser(withUser.id);
    r = await readJson(await coDELETE(bodyReq("DELETE", { companyId: withUser.id })));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: { code: "VALIDATION", message: "Cannot delete company with existing users. Remove all users first." } }); // [S043 fold: A applied]
    // company WITH a project but NO users → blocked on the project guard. Author the project
    // with a user from ANOTHER company so withProj itself has 0 users (users-guard passes,
    // project-guard fires — the count is company_id-scoped).
    const withProj = await createCompany();
    const otherCo = await createCompany();
    const otherAuthor = await createUser(otherCo.id);
    await createProject(withProj.id, otherAuthor.id);
    r = await readJson(await coDELETE(bodyReq("DELETE", { companyId: withProj.id })));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: { code: "VALIDATION", message: "Cannot delete company with existing projects. Delete all projects first." } }); // [S043 fold: A applied]
    // truly empty company → deletes
    const empty = await createCompany();
    r = await readJson(await coDELETE(bodyReq("DELETE", { companyId: empty.id })));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true });
    expect(await companyById(empty.id)).toBeUndefined();
  });
});
