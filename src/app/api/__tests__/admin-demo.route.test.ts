// @vitest-environment node
// [refactor jul6 S045] CHARACTERIZATION for the admin/demo SOLO (POST — refresh demo projects
// OR toggle a project's isDemo flag), written as THE FREEZE before the fold onto
// services/demo.ts. Solo. requireAdmin (admin OR root passes; member 403; signed-out 401).
// Single POST, two mutually-exclusive branches keyed off body.action:
//   • action==="refresh": update projects SET updatedAt=now WHERE isDemo=true AND
//     companyId=session.companyId .returning(id) → {success:true, refreshed: result.length}.
//   • fallthrough: {projectId, isDemo}; !projectId || typeof isDemo!=="boolean" → 400
//     "projectId and isDemo required"; update projects SET {isDemo, updatedAt} WHERE
//     publicId=projectId AND companyId=session.companyId → {success:true}.
// BOTH writes are companyId-SCOPED (cross-company tenancy guard; NO root bypass — preserve
// byte-exact). new Date() non-determinism. Body IS read (E applies at fold). No catch-500 → NO B.
// Assertions tagged [S045 fold: … applied] were flipped in the fold commit onto
// services/demo.ts (sanctioned A/E only).
import { describe, expect, inject, it, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { POST as demoPOST } from "@/app/api/admin/demo/route";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { asUser, createCompany, createUser, createProject, makeReq, readJson, signedOut } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

async function makeWorld() {
  const company = await createCompany();
  const admin = await createUser(company.id, { role: "admin" });
  const member = await createUser(company.id);
  const root = await createUser(company.id, { isRootAdmin: true });
  return { company, admin, member, root };
}

const post = (body: unknown) => makeReq("/api/admin/demo", { method: "POST", body });
const UNAUTH = { error: { code: "UNAUTHORIZED", message: "Unauthorized" } }; // [S045 fold: A applied]
const ADMIN_ONLY = { error: { code: "FORBIDDEN", message: "Admin only" } }; // [S045 fold: A applied]

async function projectRow(id: number) {
  const [p] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  return p;
}

beforeEach(() => { vi.clearAllMocks(); signedOut(); });

describe.skipIf(!dbUp)("admin/demo (DEMO)", () => {
  it("DEMO-1 auth: signed-out→401, member→403, admin+root pass", async () => {
    const { admin, member, root } = await makeWorld();
    let r = await readJson(await demoPOST(post({ action: "refresh" })));
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S045 fold: A applied]
    asUser(member);
    r = await readJson(await demoPOST(post({ action: "refresh" })));
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ADMIN_ONLY); // [S045 fold: A applied]
    asUser(admin);
    expect((await readJson(await demoPOST(post({ action: "refresh" })))).status).toBe(200);
    asUser(root);
    expect((await readJson(await demoPOST(post({ action: "refresh" })))).status).toBe(200);
  });

  it("DEMO-2 action=refresh: bumps updatedAt on OWN-company demo projects only (companyId-scoped)", async () => {
    const { company, admin } = await makeWorld();
    const author = await createUser(company.id);
    const demo1 = await createProject(company.id, author.id, { isDemo: true } as never);
    const demo2 = await createProject(company.id, author.id, { isDemo: true } as never);
    await createProject(company.id, author.id, { isDemo: false } as never); // non-demo, excluded
    // another company's demo project — MUST be untouched
    const otherCo = await createCompany();
    const otherAuthor = await createUser(otherCo.id);
    const otherDemo = await createProject(otherCo.id, otherAuthor.id, { isDemo: true } as never);
    const otherBefore = (await projectRow(otherDemo.id)).updatedAt as Date;
    await new Promise((res) => setTimeout(res, 8));
    asUser(admin);
    const r = await readJson(await demoPOST(post({ action: "refresh" })));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, refreshed: 2 }); // only demo1 + demo2 (own company, isDemo=true)
    // own demos bumped
    expect((await projectRow(demo1.id)).updatedAt).toBeTruthy();
    // cross-company demo NOT touched
    expect(((await projectRow(otherDemo.id)).updatedAt as Date).getTime()).toBe(otherBefore.getTime());
  });

  it("DEMO-3 fallthrough validation: missing projectId / non-boolean isDemo → 400 literal", async () => {
    const { admin } = await makeWorld();
    asUser(admin);
    for (const body of [{}, { isDemo: true }, { projectId: "x" }, { projectId: "x", isDemo: "yes" }, { projectId: "x", isDemo: 1 }]) {
      const r = await readJson(await demoPOST(post(body)));
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: { code: "VALIDATION", message: "projectId and isDemo required" } }); // [S045 fold: A applied]
    }
  });

  it("DEMO-4 set isDemo by publicId (companyId-scoped); cross-company silently no-ops", async () => {
    const { company, admin } = await makeWorld();
    const author = await createUser(company.id);
    const proj = await createProject(company.id, author.id, { isDemo: false } as never);
    asUser(admin);
    let r = await readJson(await demoPOST(post({ projectId: proj.publicId, isDemo: true })));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true });
    expect((await projectRow(proj.id)).isDemo).toBe(true); // toggled on
    // toggle back off
    r = await readJson(await demoPOST(post({ projectId: proj.publicId, isDemo: false })));
    expect((await projectRow(proj.id)).isDemo).toBe(false);
    // cross-company: a project in ANOTHER company — the companyId scope means 0 rows match,
    // but the response is still {success:true} (no returning / no row-count check)
    const otherCo = await createCompany();
    const otherAuthor = await createUser(otherCo.id);
    const otherProj = await createProject(otherCo.id, otherAuthor.id, { isDemo: false } as never);
    r = await readJson(await demoPOST(post({ projectId: otherProj.publicId, isDemo: true })));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true });
    expect((await projectRow(otherProj.id)).isDemo).toBe(false); // NOT toggled (cross-company scope)
  });
});
