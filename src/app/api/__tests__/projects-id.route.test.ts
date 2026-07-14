// @vitest-environment node
// [refactor jun12 P0.3] CHARACTERIZATION for /api/projects/[id] GET/PUT/DELETE.
// Freezes: company scoping (cross-tenant = 404), root-admin bypass, the GET
// payload shape the viewer bootstrap depends on, PUT's projectIntelligence
// merge semantics, and DELETE's full-cascade behavior (today's hand-rolled
// child deletes — becomes a transactional service in P1, FK CASCADE in P4.2;
// these tests are the spec those steps refactor against).
//
// [refactor jun17 P1.3 family 4/7] These routes are now thin defineRoute shells over
// services/projects.ts (auth:"session" + manual full-row root-bypass lookup). The pre-existing
// error cases below assert .status ONLY and survive the envelope flip unchanged; the new
// "shell envelope + sanctioned diffs" block freezes: error bodies are now {error:{code,message}};
// a non-uuid id is a clean 400 VALIDATION (was a pg-uuid-cast 500); 401 still precedes the id-parse.
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { DELETE, GET, PUT } from "@/app/api/projects/[id]/route";
import { db } from "@/lib/db";
import { auditLog, projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  annotationsFor,
  ageProjectForPublication,
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

// audit() is fire-and-forget (un-awaited insert), so poll briefly for the row this delete should write.
async function pollAuditByProjectId(projectPublicId: string, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "project_deleted"));
    const row = rows.find(
      (r) =>
        (r.details as Record<string, unknown> | null)?.projectId ===
        projectPublicId,
    );
    if (row) return row;
    await new Promise((res) => setTimeout(res, 20));
  }
  return undefined;
}

describe.skipIf(!dbUp)("GET /api/projects/[id]", () => {
  it("returns the viewer-bootstrap payload shape", async () => {
    const { user, project } = await createWorld({ numPages: 2 });
    await createPage(project.id, 1, { drawingNumber: "A-101" });
    await createPage(project.id, 2);
    asUser(user);
    const { status, body } = await readJson(
      await GET(
        makeReq(`/api/projects/${project.publicId}`, { method: "GET" }),
        params({ id: project.publicId }),
      ),
    );
    expect(status).toBe(200);
    // publicId travels as `id`; dbId ALSO exposed today (dual-ID era —
    // P1 retires dbId from responses once the 3 dbId-only callers move).
    expect(body.id).toBe(project.publicId);
    expect(body.dbId).toBe(project.id);
    expect(body.dataUrl).toBeUndefined();
    expect(body.assetBaseUrl).toBe(`/api/project-assets/${project.publicId}`);
    expect(body.pdfUrl).toBe(`${body.assetBaseUrl}/original.pdf`);
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
    expect(
      (
        await GET(
          makeReq("x", { method: "GET" }),
          params({ id: project.publicId }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await GET(
          makeReq("x", { method: "GET" }),
          params({ id: "00000000-0000-0000-0000-000000000000" }),
        )
      ).status,
    ).toBe(404);
    signedOut();
    expect(
      (
        await GET(
          makeReq("x", { method: "GET" }),
          params({ id: project.publicId }),
        )
      ).status,
    ).toBe(401);
  });

  it("root admin reads any company's project", async () => {
    const { project } = await createWorld();
    const rootCo = await createCompany();
    const root = await createUser(rootCo.id, {
      isRootAdmin: true,
      role: "admin",
    });
    asUser(root);
    const { status, body } = await readJson(
      await GET(
        makeReq("x", { method: "GET" }),
        params({ id: project.publicId }),
      ),
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

    const yoloTags = [{ id: "tag-1", tagText: "D-101", instances: [] }];
    const { status, body } = await readJson(
      await PUT(
        makeReq("x", {
          method: "PUT",
          body: {
            name: "renamed",
            classCsiOverrides: { door: "08 11 00" },
            yoloTags,
          },
        }),
        params({ id: project.publicId }),
      ),
    );
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });

    const [row] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, project.id));
    expect(row.name).toBe("renamed");
    const pi = row.projectIntelligence as Record<string, unknown>;
    expect(pi.summaries).toEqual({ keep: true }); // merge, not replace
    expect(pi.classCsiOverrides).toEqual({ door: "08 11 00" });
    expect(pi.yoloTags).toEqual(yoloTags);
  });

  it("rejects yoloTags writes to a demo project for both its owner and a cross-company root", async () => {
    const { user, project } = await createWorld({
      isDemo: true,
      projectIntelligence: { yoloTags: [{ id: "keep" }] } as any,
    });

    asUser(user);
    const owner = await readJson(
      await PUT(
        makeReq("x", { method: "PUT", body: { yoloTags: [] } }),
        params({ id: project.publicId }),
      ),
    );
    expect(owner.status).toBe(403);
    expect(owner.body).toEqual({
      error: { code: "FORBIDDEN", message: "Demo projects are read-only" },
    });

    const root = await createUser((await createCompany()).id, {
      isRootAdmin: true,
      role: "admin",
    });
    asUser(root);
    expect(
      (
        await PUT(
          makeReq("x", { method: "PUT", body: { yoloTags: [] } }),
          params({ id: project.publicId }),
        )
      ).status,
    ).toBe(403);

    const [row] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, project.id));
    expect((row.projectIntelligence as any).yoloTags).toEqual([{ id: "keep" }]);
  });

  it("rejects a non-array yoloTags payload without touching project intelligence", async () => {
    const { user, project } = await createWorld({
      projectIntelligence: { keep: true } as any,
    });
    asUser(user);
    const { status, body } = await readJson(
      await PUT(
        makeReq("x", { method: "PUT", body: { yoloTags: { corrupt: true } } }),
        params({ id: project.publicId }),
      ),
    );
    expect(status).toBe(400);
    expect(body.error.code).toBe("VALIDATION");
    const [row] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, project.id));
    expect(row.projectIntelligence).toEqual({ keep: true });
  });

  it("cross-tenant PUT is 404 and writes nothing", async () => {
    const { project } = await createWorld();
    const outsider = await createUser((await createCompany()).id);
    asUser(outsider);
    const { status } = await readJson(
      await PUT(
        makeReq("x", { method: "PUT", body: { name: "hax" } }),
        params({ id: project.publicId }),
      ),
    );
    expect(status).toBe(404);
    const [row] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, project.id));
    expect(row.name).toBe(project.name);
  });
});

describe.skipIf(!dbUp)("DELETE /api/projects/[id]", () => {
  it("deletes the project and its children; returns {success:true}", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1);
    asUser(user);
    // seed a child annotation through the real route for realism
    const { POST: createAnnotation } =
      await import("@/app/api/annotations/route");
    await createAnnotation(
      makeReq("/api/annotations", {
        body: {
          projectId: project.publicId,
          pageNumber: 1,
          name: "x",
          bbox: [0.1, 0.1, 0.2, 0.2],
        },
      }),
    );
    expect(await annotationsFor(project.id)).toHaveLength(1);
    await ageProjectForPublication(project.id);

    const { status, body } = await readJson(
      await DELETE(
        makeReq("x", { method: "DELETE" }),
        params({ id: project.publicId }),
      ),
    );
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(
      await db.select().from(projects).where(eq(projects.id, project.id)),
    ).toHaveLength(0);
    expect(await annotationsFor(project.id)).toHaveLength(0);

    // [refactor jun17 P1.3] the un-awaited audit records details.projectId as the publicId STRING
    // (NOT the numeric project.id) — a regression to project.id would not type-error, so freeze it here.
    const auditRow = await pollAuditByProjectId(project.publicId);
    expect(
      auditRow,
      "audit row should be written for project_deleted",
    ).toBeDefined();
    expect(
      typeof (auditRow!.details as Record<string, unknown>).projectId,
    ).toBe("string");
    expect((auditRow!.details as Record<string, unknown>).projectId).toBe(
      project.publicId,
    );
  }, 20000); // S3 cleanup attempt fails against dummy creds and is swallowed — allow for SDK retry latency

  it("cross-tenant DELETE is 404; project survives", async () => {
    const { project } = await createWorld();
    const outsider = await createUser((await createCompany()).id);
    asUser(outsider);
    const { status } = await readJson(
      await DELETE(
        makeReq("x", { method: "DELETE" }),
        params({ id: project.publicId }),
      ),
    );
    expect(status).toBe(404);
    expect(
      await db.select().from(projects).where(eq(projects.id, project.id)),
    ).toHaveLength(1);
  });
});

describe.skipIf(!dbUp)(
  "/api/projects/[id] shell envelope + sanctioned diffs (P1.3)",
  () => {
    it("non-uuid id → clean 400 VALIDATION (was a pg-uuid-cast 500), on GET/PUT/DELETE", async () => {
      const { user } = await createWorld();
      asUser(user);
      // The shell's zPublicId pre-parse in loadProjectWithRootBypass rejects a non-uuid id BEFORE it reaches
      // the pg uuid column — sanctioned diff (b). All three methods share the helper, so all three 400.
      for (const [label, res] of [
        [
          "GET",
          await GET(
            makeReq("x", { method: "GET" }),
            params({ id: "not-a-uuid" }),
          ),
        ],
        [
          "PUT",
          await PUT(
            makeReq("x", { method: "PUT", body: { name: "x" } }),
            params({ id: "not-a-uuid" }),
          ),
        ],
        [
          "DELETE",
          await DELETE(
            makeReq("x", { method: "DELETE" }),
            params({ id: "not-a-uuid" }),
          ),
        ],
      ] as const) {
        const { status, body } = await readJson(res);
        expect(status, label).toBe(400);
        expect(body.error.code, label).toBe("VALIDATION");
      }
    });

    it("401 precedes the id-parse: signed-out + garbage id → 401, not 400", async () => {
      // auth:"session" runs at the shell's auth step (before the handler's zPublicId parse), so a signed-out
      // caller gets 401 even with a non-uuid id — the frozen 401-before-everything ordering.
      signedOut();
      const { status, body } = await readJson(
        await GET(
          makeReq("x", { method: "GET" }),
          params({ id: "still-not-a-uuid" }),
        ),
      );
      expect(status).toBe(401);
      expect(body.error.code).toBe("UNAUTHORIZED");
    });

    it("error bodies are the unified envelope {error:{code,message}} (404 cross-tenant)", async () => {
      const { project } = await createWorld();
      asUser(await createUser((await createCompany()).id));
      const { status, body } = await readJson(
        await GET(
          makeReq("x", { method: "GET" }),
          params({ id: project.publicId }),
        ),
      );
      expect(status).toBe(404);
      expect(body.error).toEqual({ code: "NOT_FOUND", message: "Not found" });
    });
  },
);
