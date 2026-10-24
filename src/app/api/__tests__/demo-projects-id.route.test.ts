// @vitest-environment node
// [refactor jun18 P1.4 demo fold] CHARACTERIZATION for GET /api/demo/projects/[id] — the public
// demo project-by-id bootstrap mirror. No char file existed for it, so this file IS the freeze.
//
// FREEZE-FIRST discipline (S016 pilot recipe): the freeze commit asserted the CURRENT (legacy) behavior and
// ran GREEN against the legacy route. This (the fold commit) makes the route a thin defineRoute({auth:"none"})
// shell delegating to the NEW services/projects.ts `getDemoProject`, and flipped ONLY the assertions tagged
// `// [P1.4 fold]` (each notes its pre-fold value):
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
  publishDemoFixture,
} from "@/test/harness";
import { db } from "@/lib/db";
import { randomUUID } from "crypto";

const dbUp = inject("dbUp") as boolean;

const runDemo = (id: string) =>
  demoProjectGET(
    makeReq(`/api/demo/projects/${id}`, { method: "GET" }),
    params({ id }),
  );

/** company + author + a completed isDemo project (the only kind /api/demo/projects/[id] serves). */
async function createDemoProject(
  companyOver: Partial<Parameters<typeof createCompany>[0]> = {},
  projectOver: Partial<Parameters<typeof createProject>[2]> = {},
  publish = true,
) {
  const company = await createCompany(companyOver);
  const author = await createUser(company.id);
  const project = await createProject(company.id, author.id, {
    status: "completed",
    numPages: 2,
    ...projectOver,
  });
  const publishedProject = publish
    ? await publishDemoFixture(project.id)
    : project;
  return { company, author, project: publishedProject };
}

describe.skipIf(!dbUp)("GET /api/demo/projects/[id]", () => {
  it("200 public happy: full body shape, pages ordered by pageNumber, populated demoConfig", async () => {
    const PI = { summaries: { keep: true }, pageCount: 2 };
    const { company, author, project } = await createDemoProject(
      { pipelineConfig: { demo: { someFlag: true } } },
      { projectIntelligence: PI as never },
      false,
    );
    // insert pages OUT of order → proves ORDER BY pageNumber
    await createPage(project.id, 2, { name: "Second", drawingNumber: "A-102" });
    await createPage(project.id, 1, { name: "First", drawingNumber: "A-101" });
    await publishDemoFixture(project.id);

    signedOut(); // the typical public-demo caller — no auth required
    const raw = await runDemo(project.publicId);
    expect(raw.status).toBe(200);
    expect(raw.headers.get("Cache-Control")).toBe("public, no-store");
    const body = await raw.json();
    expect(body.id).toBe(project.publicId);
    expect(body.dbId).toBe(project.id);
    expect(body.name).toBe(project.name);
    expect(body.dataUrl).toBeUndefined();
    expect(body.assetBaseUrl).toBe(`/api/project-assets/${project.publicId}`);
    expect(body.pdfUrl).toBe(`${body.assetBaseUrl}/original.pdf`);
    expect(body.numPages).toBe(2);
    expect(body.status).toBe("completed");
    expect(body.summaries).toEqual({ keep: true });
    expect(body.projectIntelligence).toEqual(PI);
    expect(body.demoConfig).toEqual({ someFlag: true });
    expect(body.pages).toEqual([
      { pageNumber: 1, name: "First", drawingNumber: "A-101" },
      { pageNumber: 2, name: "Second", drawingNumber: "A-102" },
    ]);
    // NEGATIVE shape pin: EXACTLY these 11 demo fields — getDemoProject must NEVER add getProject's
    // authed-only address/takeoffItems/takeoffGroups/chatMessages (the isolation contract documented on the
    // getDemoProject header in services/projects.ts), and must NEVER drop demoConfig.
    expect(Object.keys(body).sort()).toEqual([
      "assetBaseUrl",
      "dbId",
      "demoConfig",
      "id",
      "name",
      "numPages",
      "pages",
      "pdfUrl",
      "projectIntelligence",
      "status",
      "summaries",
    ]);
    expect(company.id).toBe(project.companyId);
  });

  it("200 strips projectIntelligence.crossSetLinks: a demo never names the company's private sets", async () => {
    // [cross-set F3 2026-10-24] publishing flips the same row, so a summary written while private is still there
    const PI = { summaries: { keep: true }, crossSetLinks: { v: 1, computedAt: "2026-10-24T00:00:00.000Z", linkedProjects: [{ publicId: "private-set-id", twins: 1, revisions: 0, copy: null }] } };
    const { project } = await createDemoProject({}, { projectIntelligence: PI as never });
    signedOut();
    const res = await readJson(await runDemo(project.publicId));
    expect(res.status).toBe(200);
    expect(res.body.projectIntelligence).toEqual({ summaries: { keep: true } });
    expect(JSON.stringify(res.body)).not.toContain("private-set-id");
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
    expect(nonDemo.body.error).toEqual({
      code: "NOT_FOUND",
      message: "Not found",
    }); // [P1.4 fold] was: "Not found" (string envelope)

    // valid uuid, no such project → 404
    const ghost = await readJson(await runDemo(randomUUID()));
    expect(ghost.status).toBe(404);
    expect(ghost.body.error).toEqual({
      code: "NOT_FOUND",
      message: "Not found",
    }); // [P1.4 fold] was: "Not found" (string envelope)
  });

  it("non-uuid id → clean 400 (sanctioned diff b; legacy was an unhandled pg uuid-cast throw)", async () => {
    signedOut();
    const bad = await readJson(await runDemo("not-a-uuid"));
    // [P1.4 fold] was: an unhandled throw (raw non-uuid fed to the pg uuid column, no try/catch). The freeze
    // commit captured this defensively (thrown OR non-2xx); the fold makes it a clean 400 via zPublicId.
    expect(bad.status).toBe(400);
    expect(bad.body.error).toEqual({
      code: "VALIDATION",
      message: "Invalid project id",
    });
  });

  it("unexpected DB error → the shell's leak-free INTERNAL 500 (sanctioned diff c; legacy had no try/catch → raw 500)", async () => {
    const { project } = await createDemoProject();
    signedOut();
    // getDemoProject's FIRST db call is the project SELECT; make it throw a leaky message. The shell's outer
    // catch (defineRoute) turns any non-ApiError throw into {code:"INTERNAL",message:"Internal server error"}
    // and logs the cause server-side — it must NOT appear in the response body. (Legacy had no try/catch, so
    // this was a raw 500 that could leak a dev stack.)
    const spy = vi.spyOn(db, "select").mockImplementationOnce(() => {
      throw new Error("boom SECRET_LEAK_xyz");
    });
    const res = await readJson(await runDemo(project.publicId));
    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({
      code: "INTERNAL",
      message: "Internal server error",
    });
    expect(JSON.stringify(res.body)).not.toContain("SECRET_LEAK_xyz"); // underlying cause never leaks
    spy.mockRestore();
  });
});
