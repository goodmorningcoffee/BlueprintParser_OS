// @vitest-environment node
// [refactor jul6 S048] CHARACTERIZATION for the admin/llm/preview SOLO (POST — build LLM
// context for a project/page and return section METADATA, NOT an LLM call), written as THE
// FREEZE before the fold onto services/llm-preview.ts. Solo. requireAdmin. 191L but a pure
// READ (no writes, no external LLM/AWS call — returns section metadata). Frozen quirk
// inventory:
//   • {projectId, pageNumber, scope} = body; !projectId → 400 "projectId required".
//   • project lookup by publicId AND companyId=session.companyId (⚠️ companyId-SCOPED, NO root
//     bypass) → else 404 "Not found".
//   • builds ContextSections from yolo/user annotations + takeoff notes + page/project-scope
//     data (all @/lib/context-builder pure fns, unchanged by the fold), assembles with the
//     company sectionConfig + a getContextBudget("anthropic","sonnet") budget → response
//     {sections: sectionMeta, totalChars: assembled.length, budget}.
// Body IS read → E applies at fold. No catch-500 literal → NO B. The section-builder internals
// are pure library fns not touched by the fold, so this freeze pins auth + validation + the
// companyId 404 scope + the response SHAPE (not every section permutation).
// Assertions tagged [S048 fold: … applied] were flipped in the fold commit onto
// services/llm-preview.ts (sanctioned A/E only).
import { describe, expect, inject, it, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { POST as lpPOST } from "@/app/api/admin/llm/preview/route";
import { createCompany, createUser, createProject, asUser, makeReq, readJson, signedOut } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

async function makeWorld() {
  const company = await createCompany();
  const admin = await createUser(company.id, { role: "admin" });
  const member = await createUser(company.id);
  const root = await createUser(company.id, { isRootAdmin: true });
  const author = await createUser(company.id);
  return { company, admin, member, root, author };
}

const post = (body: unknown) => makeReq("/api/admin/llm/preview", { method: "POST", body });
const UNAUTH = { error: { code: "UNAUTHORIZED", message: "Unauthorized" } }; // [S048 fold: A applied]
const ADMIN_ONLY = { error: { code: "FORBIDDEN", message: "Admin only" } }; // [S048 fold: A applied]

beforeEach(() => { vi.clearAllMocks(); signedOut(); });

describe.skipIf(!dbUp)("admin/llm/preview (LP)", () => {
  it("LP-1 auth: signed-out→401, member→403, admin passes to validation", async () => {
    const { admin, member } = await makeWorld();
    let r = await readJson(await lpPOST(post({})));
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S048 fold: A applied]
    asUser(member);
    r = await readJson(await lpPOST(post({})));
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ADMIN_ONLY); // [S048 fold: A applied]
    asUser(admin); // passes auth → hits validation (400, not 403)
    r = await readJson(await lpPOST(post({})));
    expect(r.status).toBe(400);
  });

  it("LP-2 validation: no projectId → 400 'projectId required'", async () => {
    const { admin } = await makeWorld();
    asUser(admin);
    const r = await readJson(await lpPOST(post({ scope: "project" })));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: { code: "VALIDATION", message: "projectId required" } }); // [S048 fold: A applied]
  });

  it("LP-3 ⚠️ companyId-scoped 404: another company's project → 404 'Not found'; own project → 200", async () => {
    const { company, admin, author } = await makeWorld();
    const mine = await createProject(company.id, author.id);
    // another company's project — must be invisible → 404
    const otherCo = await createCompany();
    const otherProj = await createProject(otherCo.id, (await createUser(otherCo.id)).id);
    asUser(admin);
    let r = await readJson(await lpPOST(post({ projectId: otherProj.publicId })));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: { code: "NOT_FOUND", message: "Not found" } }); // [S048 fold: A applied]
    // own project → 200
    r = await readJson(await lpPOST(post({ projectId: mine.publicId })));
    expect(r.status).toBe(200);
  });

  it("LP-4 happy-path shape: {sections: array, totalChars: number, budget: object}", async () => {
    const { company, admin, author } = await makeWorld();
    const proj = await createProject(company.id, author.id);
    asUser(admin);
    const r = await readJson(await lpPOST(post({ projectId: proj.publicId, scope: "project" })));
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.sections)).toBe(true); // sectionMeta array
    expect(typeof r.body.totalChars).toBe("number"); // assembled.length
    expect(typeof r.body.budget).toBe("number"); // getContextBudget(...) is a numeric char budget
    expect(r.body.budget).toBeGreaterThan(0);
  });
});
