// @vitest-environment node
// [refactor jun18 P1.4 demo fold] CHARACTERIZATION for GET /api/demo/projects/[id] — the public
// demo project-by-id bootstrap mirror. No char file existed for it, so this file IS the freeze.
//
// FREEZE-FIRST discipline (S016 pilot recipe): this commit asserts the CURRENT (legacy) behavior and
// runs GREEN against the legacy route BEFORE the fold. The fold (next commit) makes the route a thin
// defineRoute({auth:"none"}) shell delegating to a NEW services/projects.ts `getDemoProject`, and flips
// ONLY the assertions tagged `// [P1.4 fold]` (each notes its pre-fold value):
//   • error envelope {error:string} → {error:{code,message}} (the shell does it);
//   • a non-uuid id (legacy fed it straight to the pg uuid column with NO try/catch → an unhandled
//     throw) → a clean 400 "Invalid project id" (zPublicId).
// Everything else — the full 200 body shape, the isDemo=true guard (404 for a non-demo project), the
// demoConfig populate-vs-{}-fallback, the public no-auth posture — is preserved byte-for-byte.
//
// This route is FULLY PUBLIC (no auth() lookup at all): a signed-out caller, the owner, and a
// cross-company authed user ALL get 200 on a demo project. The only gate is WHERE isDemo=true.
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { GET as demoProjectGET } from "@/app/api/demo/projects/[id]/route";
import {
  asUser,
  createCompany,
  createPage,
  createProject,
  createUser,
  createWorld,
  makeReq,
  params,
  readJson,
  signedOut,
} from "@/test/harness";
import { randomUUID } from "crypto";

const dbUp = inject("dbUp") as boolean;

const runDemo = (id: string) =>
  demoProjectGET(makeReq(`/api/demo/projects/${id}`, { method: "GET" }), params({ id }));

/** company + author + a completed isDemo project (the only kind /api/demo/projects/[id] serves). */
async function createDemoProject(
  companyOver: Partial<Parameters<typeof createCompany>[0]> = {},
  projectOver: Partial<Parameters<typeof createProject>[2]> = {},
) {
  const company = await createCompany(companyOver);
  const author = await createUser(company.id);
  const project = await createProject(company.id, author.id, {
    isDemo: true,
    status: "completed",
    numPages: 2,
    ...projectOver,
  });
  return { company, author, project };
}

describe.skipIf(!dbUp)("GET /api/demo/projects/[id]", () => {
  it("200 public happy: full body shape, pages ordered by pageNumber, populated demoConfig", async () => {
    const PI = { summaries: { keep: true }, pageCount: 2 };
    const { company, author, project } = await createDemoProject(
      { pipelineConfig: { demo: { someFlag: true } } },
      { projectIntelligence: PI as never },
    );
    // insert pages OUT of order → proves ORDER BY pageNumber
    await createPage(project.id, 2, { name: "Second", drawingNumber: "A-102" });
    await createPage(project.id, 1, { name: "First", drawingNumber: "A-101" });

    signedOut(); // the typical public-demo caller — no auth required
    const res = await readJson(await runDemo(project.publicId));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(project.publicId);
    expect(res.body.dbId).toBe(project.id);
    expect(res.body.name).toBe(project.name);
    expect(res.body.dataUrl).toBe(project.dataUrl);
    expect(res.body.pdfUrl).toContain(project.dataUrl); // getS3Url(dataUrl, "original.pdf")
    expect(res.body.pdfUrl).toContain("original.pdf");
    expect(res.body.numPages).toBe(2);
    expect(res.body.status).toBe("completed");
    expect(res.body.summaries).toEqual({ keep: true });
    expect(res.body.projectIntelligence).toEqual(PI);
    expect(res.body.demoConfig).toEqual({ someFlag: true });
    expect(res.body.pages).toEqual([
      { pageNumber: 1, name: "First", drawingNumber: "A-101" },
      { pageNumber: 2, name: "Second", drawingNumber: "A-102" },
    ]);
    expect(company.id).toBe(project.companyId);
  });

  it("200 demoConfig fallback: company without pipelineConfig.demo → {}; null projectIntelligence → summaries null", async () => {
    const { project } = await createDemoProject(); // no pipelineConfig, no projectIntelligence
    signedOut();
    const res = await readJson(await runDemo(project.publicId));
    expect(res.status).toBe(200);
    expect(res.body.demoConfig).toEqual({});
    expect(res.body.summaries).toBeNull();
    expect(res.body.projectIntelligence).toBeNull();
    expect(res.body.pages).toEqual([]); // no pages seeded
  });

  it("200 auth-agnostic: the route does NO auth lookup — owner and a cross-company authed user also 200", async () => {
    const { author, project } = await createDemoProject();
    asUser(author);
    expect((await runDemo(project.publicId)).status).toBe(200);
    // a user from a DIFFERENT company still 200s (demo is public; no tenancy check on this route)
    asUser(await createUser((await createCompany()).id));
    expect((await runDemo(project.publicId)).status).toBe(200);
  });

  it("404 NON-DEMO project (the isDemo=true guard); 404 missing project (valid uuid, no row)", async () => {
    signedOut();

    // a real (isDemo=false) project → legacy `WHERE isDemo=true` finds no row → 404
    const { project: realProj } = await createWorld(); // isDemo=false
    const nonDemo = await readJson(await runDemo(realProj.publicId));
    expect(nonDemo.status).toBe(404);
    expect(nonDemo.body.error).toBe("Not found"); // [P1.4 fold] → {error:{code:"NOT_FOUND",message:"Not found"}}

    // valid uuid, no such project → 404
    const ghost = await readJson(await runDemo(randomUUID()));
    expect(ghost.status).toBe(404);
    expect(ghost.body.error).toBe("Not found"); // [P1.4 fold] → {error:{code:"NOT_FOUND",message:"Not found"}}
  });

  it("non-uuid id: legacy unhandled pg uuid-cast (defensive capture) [P1.4 fold → clean 400]", async () => {
    signedOut();
    // Legacy has NO try/catch around the pg uuid-column SELECT, so a non-uuid id makes the cast throw.
    // Capture EITHER a thrown exception OR a non-2xx Response (harness-dependent) — do NOT pre-assert a
    // specific status. [P1.4 fold] this becomes a clean 400 "Invalid project id" via zPublicId.
    let threwOrErrored = false;
    try {
      const res = await runDemo("not-a-uuid");
      threwOrErrored = res.status >= 400;
    } catch {
      threwOrErrored = true;
    }
    expect(threwOrErrored).toBe(true);
  });
});
