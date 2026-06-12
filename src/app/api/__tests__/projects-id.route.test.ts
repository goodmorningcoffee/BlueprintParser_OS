// @vitest-environment node
// [refactor jun12 P0.3] CHARACTERIZATION for /api/projects/[id] GET/PUT/DELETE.
// Freezes: company scoping (cross-tenant = 404), root-admin bypass, the GET
// payload shape the viewer bootstrap depends on, PUT's projectIntelligence
// merge semantics, and DELETE's full-cascade behavior (today's hand-rolled
// child deletes — becomes a transactional service in P1, FK CASCADE in P4.2;
// these tests are the spec those steps refactor against).
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { DELETE, GET, PUT } from "@/app/api/projects/[id]/route";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  annotationsFor,
  asUser,
  createCompany,
  createPage,
  createUser,
  createWorld,
  makeReq,
  params,
  readJson,
  signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

describe.skipIf(!dbUp)("GET /api/projects/[id]", () => {
  it("returns the viewer-bootstrap payload shape", async () => {
    const { user, project } = await createWorld({ numPages: 2 });
    await createPage(project.id, 1, { drawingNumber: "A-101" });
    await createPage(project.id, 2);
    asUser(user);
    const { status, body } = await readJson(
      await GET(makeReq(`/api/projects/${project.publicId}`, { method: "GET" }), params({ id: project.publicId })),
    );
    expect(status).toBe(200);
    // publicId travels as `id`; dbId ALSO exposed today (dual-ID era —
    // P1 retires dbId from responses once the 3 dbId-only callers move).
    expect(body.id).toBe(project.publicId);
    expect(body.dbId).toBe(project.id);
    expect(body.pdfUrl).toContain(project.dataUrl);
    expect(body.pages).toEqual([
      { pageNumber: 1, name: "Page 1", drawingNumber: "A-101" },
      { pageNumber: 2, name: "Page 2", drawingNumber: null },
    ]);
    expect(body.takeoffItems).toEqual([]);
    expect(body.takeoffGroups).toEqual([]);
    expect(body.chatMessages).toEqual([]);
    expect(body.summaries).toBeNull();
  });

  it("404 for cross-tenant and for unknown id; 401 signed out", async () => {
    const { project } = await createWorld();
    const otherCo = await createCompany();
    const outsider = await createUser(otherCo.id);

    asUser(outsider);
    expect((await GET(makeReq("x", { method: "GET" }), params({ id: project.publicId }))).status).toBe(404);
    expect((await GET(makeReq("x", { method: "GET" }), params({ id: "00000000-0000-0000-0000-000000000000" }))).status).toBe(404);
    signedOut();
    expect((await GET(makeReq("x", { method: "GET" }), params({ id: project.publicId }))).status).toBe(401);
  });

  it("root admin reads any company's project", async () => {
    const { project } = await createWorld();
    const rootCo = await createCompany();
    const root = await createUser(rootCo.id, { isRootAdmin: true, role: "admin" });
    asUser(root);
    const { status, body } = await readJson(
      await GET(makeReq("x", { method: "GET" }), params({ id: project.publicId })),
    );
    expect(status).toBe(200);
    expect(body.id).toBe(project.publicId);
  });
});

describe.skipIf(!dbUp)("PUT /api/projects/[id]", () => {
  it("updates name/address and MERGES intelligence keys (existing keys preserved)", async () => {
    const { user, project } = await createWorld();
    await db
      .update(projects)
      .set({ projectIntelligence: { summaries: { keep: true } } as any })
      .where(eq(projects.id, project.id));
    asUser(user);

    const { status, body } = await readJson(
      await PUT(
        makeReq("x", { method: "PUT", body: { name: "renamed", classCsiOverrides: { door: "08 11 00" } } }),
        params({ id: project.publicId }),
      ),
    );
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });

    const [row] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(row.name).toBe("renamed");
    const pi = row.projectIntelligence as Record<string, unknown>;
    expect(pi.summaries).toEqual({ keep: true }); // merge, not replace
    expect(pi.classCsiOverrides).toEqual({ door: "08 11 00" });
  });

  it("cross-tenant PUT is 404 and writes nothing", async () => {
    const { project } = await createWorld();
    const outsider = await createUser((await createCompany()).id);
    asUser(outsider);
    const { status } = await readJson(
      await PUT(makeReq("x", { method: "PUT", body: { name: "hax" } }), params({ id: project.publicId })),
    );
    expect(status).toBe(404);
    const [row] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(row.name).toBe(project.name);
  });
});

describe.skipIf(!dbUp)("DELETE /api/projects/[id]", () => {
  it("deletes the project and its children; returns {success:true}", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1);
    asUser(user);
    // seed a child annotation through the real route for realism
    const { POST: createAnnotation } = await import("@/app/api/annotations/route");
    await createAnnotation(
      makeReq("/api/annotations", { body: { projectId: project.publicId, pageNumber: 1, name: "x", bbox: [0.1, 0.1, 0.2, 0.2] } }),
    );
    expect(await annotationsFor(project.id)).toHaveLength(1);

    const { status, body } = await readJson(
      await DELETE(makeReq("x", { method: "DELETE" }), params({ id: project.publicId })),
    );
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(await db.select().from(projects).where(eq(projects.id, project.id))).toHaveLength(0);
    expect(await annotationsFor(project.id)).toHaveLength(0);
  }, 20000); // S3 cleanup attempt fails against dummy creds and is swallowed — allow for SDK retry latency

  it("cross-tenant DELETE is 404; project survives", async () => {
    const { project } = await createWorld();
    const outsider = await createUser((await createCompany()).id);
    asUser(outsider);
    const { status } = await readJson(
      await DELETE(makeReq("x", { method: "DELETE" }), params({ id: project.publicId })),
    );
    expect(status).toBe(404);
    expect(await db.select().from(projects).where(eq(projects.id, project.id))).toHaveLength(1);
  });
});
