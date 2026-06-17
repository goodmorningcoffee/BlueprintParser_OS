// @vitest-environment node
// [refactor jun17 P1.3] CHARACTERIZATION — POST /api/pages/update (page rename).
// No P0.3 char file existed for the pages family; this freezes today's behavior incl. the
// param-name lie (the body field `projectId` carries a publicId UUID string), the additive
// publicId field, the blind composite-WHERE no-op (missing page → 200, no 404), and that update
// has NO demo write-gate (the deliberate asymmetry vs pages/intelligence). Authored against the
// post-migration {error:{code,message}} envelope (committed with the migration).
import { describe, expect, inject, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { POST } from "@/app/api/pages/update/route";
import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import {
  asUser,
  createPage,
  createUser,
  createWorld,
  makeReq,
  readJson,
  signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

const req = (body: unknown) => POST(makeReq("/api/pages/update", { method: "POST", body }));

async function pageName(projectId: number, pageNumber: number) {
  const [row] = await db
    .select({ name: pages.name })
    .from(pages)
    .where(and(eq(pages.projectId, projectId), eq(pages.pageNumber, pageNumber)))
    .limit(1);
  return row?.name;
}

describe.skipIf(!dbUp)("POST /api/pages/update", () => {
  it("happy: renames the page (projectId carries a publicId), returns {success:true}", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1);
    asUser(user);
    const { status, body } = await readJson(await req({ projectId: project.publicId, pageNumber: 1, name: "Renamed" }));
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(await pageName(project.id, 1)).toBe("Renamed");
  });

  it("ADDITIVE: accepts the new explicit publicId field", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1);
    asUser(user);
    const { status } = await readJson(await req({ publicId: project.publicId, pageNumber: 1, name: "ViaPublicId" }));
    expect(status).toBe(200);
    expect(await pageName(project.id, 1)).toBe("ViaPublicId");
  });

  it("FROZEN blind no-op: a missing page still returns success and creates nothing", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const { status, body } = await readJson(await req({ projectId: project.publicId, pageNumber: 99, name: "Ghost" }));
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(await pageName(project.id, 99)).toBeUndefined();
  });

  it("missing fields → 400 VALIDATION (exact message)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    for (const bad of [
      { projectId: project.publicId, pageNumber: 1 }, // no name
      { projectId: project.publicId, name: "x" }, // no pageNumber
      { pageNumber: 1, name: "x" }, // no id at all
    ]) {
      const { status, body } = await readJson(await req(bad));
      expect(status).toBe(400);
      expect(body.error).toEqual({ code: "VALIDATION", message: "projectId, pageNumber, and name are required" });
    }
  });

  it("validate-before-auth: missing field 400 fires even signed out (before the 401)", async () => {
    const { project } = await createWorld();
    signedOut();
    const { status } = await readJson(await req({ projectId: project.publicId, pageNumber: 1 }));
    expect(status).toBe(400);
  });

  it("signed out with valid fields → 401", async () => {
    const { project } = await createWorld();
    await createPage(project.id, 1);
    signedOut();
    const { status, body } = await readJson(await req({ projectId: project.publicId, pageNumber: 1, name: "x" }));
    expect(status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("cross-tenant → 404 (no existence leak)", async () => {
    const { project } = await createWorld();
    const otherCo = await createUser((await createWorld()).company.id);
    asUser(otherCo);
    const { status, body } = await readJson(await req({ projectId: project.publicId, pageNumber: 1, name: "x" }));
    expect(status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("non-uuid id → 400 VALIDATION 'Invalid project id' (S003 closed; was pg-cast 500)", async () => {
    const { user } = await createWorld();
    asUser(user);
    const { status, body } = await readJson(await req({ projectId: "not-a-uuid", pageNumber: 1, name: "x" }));
    expect(status).toBe(400);
    expect(body.error).toEqual({ code: "VALIDATION", message: "Invalid project id" });
  });

  it("malformed JSON → 400 BAD_REQUEST (shell)", async () => {
    const { user } = await createWorld();
    asUser(user);
    const raw = new Request("http://test.local/api/pages/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const { status, body } = await readJson(await POST(raw));
    expect(status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("empty body → 400 VALIDATION (zLooseBody rejects undefined; legacy req.json() threw → 500)", async () => {
    // [detector-review jun17] sanctioned diff E sub-case: an empty body parses to `undefined` in the
    // shell (safeParseJsonBody returns undefined on empty text), which zLooseBody rejects → VALIDATION
    // 400 (distinct code from the malformed-JSON BAD_REQUEST above). Pre-refactor this 500'd.
    const { user } = await createWorld();
    asUser(user);
    const raw = new Request("http://test.local/api/pages/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "",
    });
    const { status, body } = await readJson(await POST(raw));
    expect(status).toBe(400);
    expect(body.error.code).toBe("VALIDATION");
  });

  it("NO demo write-gate: a same-company member CAN rename a demo project's page", async () => {
    const { user, project } = await createWorld({ isDemo: true });
    await createPage(project.id, 1);
    asUser(user);
    const { status, body } = await readJson(await req({ projectId: project.publicId, pageNumber: 1, name: "DemoRenamed" }));
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
  });
});
