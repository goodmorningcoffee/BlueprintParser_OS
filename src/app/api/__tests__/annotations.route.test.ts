// @vitest-environment node
// [refactor jun12 P0.3] CHARACTERIZATION tests for POST /api/annotations.
// These freeze TODAY'S behavior — including quirks (falsy pageNumber rejected).
// [refactor jun17 P1.3] Envelope flipped to the shell's {error:{code,message}} as the
// route migrated onto services/annotations.ts (the one sanctioned diff; client call sites
// updated in the same commit, per plan 03 §P1.2). The malformed-JSON case now asserts the
// shell's structured 400 instead of an unhandled throw.
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { POST } from "@/app/api/annotations/route";
import {
  annotationsFor,
  asUser,
  createUser,
  createWorld,
  createCompany,
  makeReq,
  readJson,
  signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;
const bbox = [0.1, 0.1, 0.3, 0.3];

describe.skipIf(!dbUp)("POST /api/annotations — single record", () => {
  it("creates an annotation and returns the client shape", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const { status, body } = await readJson(
      await POST(makeReq("/api/annotations", { body: { projectId: project.publicId, pageNumber: 2, name: "door", bbox, note: "fire door" } })),
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ pageNumber: 2, name: "door", bbox, note: "fire door", source: "user" });
    expect(typeof body.id).toBe("number");
    const rows = await annotationsFor(project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].creatorId).toBe(user.id);
  });

  it("auto-merges detected CSI codes into data.csiCodes from the note", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const { status, body } = await readJson(
      await POST(makeReq("/api/annotations", {
        body: { projectId: project.publicId, pageNumber: 1, name: "n", bbox, note: "provide gypsum board partitions per spec section 09 29 00", data: { csiCodes: ["03 30 00"] } },
      })),
    );
    expect(status).toBe(200);
    // manual code preserved; auto-detected codes (if any) appended — the
    // characterization point is that manual entries are never dropped.
    expect(body.data.csiCodes).toContain("03 30 00");
  });

  it("rejects missing required fields with 400 (quirk: pageNumber 0 is treated as missing)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const cases = [
      { pageNumber: 1, name: "x" }, // no bbox
      { pageNumber: 1, bbox }, // no name
      { name: "x", bbox }, // no pageNumber
      { pageNumber: 0, name: "x", bbox }, // falsy pageNumber QUIRK
    ];
    for (const c of cases) {
      const { status, body } = await readJson(
        await POST(makeReq("/api/annotations", { body: { projectId: project.publicId, ...c } })),
      );
      expect(status).toBe(400);
      expect(body.error).toEqual({ code: "VALIDATION", message: "projectId, pageNumber, name, and bbox required" });
    }
  });

  it("validates bbox geometry (range 0-1, min<max)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    for (const bad of [[0.5, 0.5, 0.4, 0.6], [-0.1, 0, 0.5, 0.5], [0, 0, 1.5, 1]]) {
      const { status } = await readJson(
        await POST(makeReq("/api/annotations", { body: { projectId: project.publicId, pageNumber: 1, name: "x", bbox: bad } })),
      );
      expect(status).toBe(400);
    }
  });

  it("401 when signed out", async () => {
    const { project } = await createWorld();
    signedOut();
    const { status } = await readJson(
      await POST(makeReq("/api/annotations", { body: { projectId: project.publicId, pageNumber: 1, name: "x", bbox } })),
    );
    expect(status).toBe(401);
  });

  it("cross-tenant write is a 404 (not 403 — existing semantics, keep)", async () => {
    const { project } = await createWorld();
    const otherCo = await createCompany();
    const outsider = await createUser(otherCo.id);
    asUser(outsider);
    const { status } = await readJson(
      await POST(makeReq("/api/annotations", { body: { projectId: project.publicId, pageNumber: 1, name: "x", bbox } })),
    );
    expect(status).toBe(404);
  });

  it("demo project + signed out cannot write (the demo-write gate)", async () => {
    const { project } = await createWorld({ isDemo: true });
    signedOut();
    const { status } = await readJson(
      await POST(makeReq("/api/annotations", { body: { projectId: project.publicId, pageNumber: 1, name: "x", bbox } })),
    );
    expect([401, 404]).toContain(status); // freeze: never 2xx
    expect(await annotationsFor(project.id)).toHaveLength(0);
  });

  it("validate-before-auth: a signed-out request with a bad field still 400s (validation precedes auth)", async () => {
    const { project } = await createWorld();
    signedOut();
    // Single mode validates required-fields + bbox BEFORE resolving auth, so a bad bbox 400s even
    // with no session. A regression that moved auth ahead of validation (e.g. declarative
    // project-auth) would 401 here instead — this freezes the recipe's core ordering invariant.
    const { status, body } = await readJson(
      await POST(makeReq("/api/annotations", { body: { projectId: project.publicId, pageNumber: 1, name: "x", bbox: [0.9, 0.9, 0.1, 0.1] } })),
    );
    expect(status).toBe(400);
    expect(body.error.code).toBe("VALIDATION");
  });
});

describe.skipIf(!dbUp)("POST /api/annotations — batch mode", () => {
  it("inserts a batch and returns {count, annotations}", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const { status, body } = await readJson(
      await POST(makeReq("/api/annotations", {
        body: {
          projectId: project.publicId,
          annotations: [
            { pageNumber: 1, name: "a", bbox },
            { pageNumber: 2, name: "b", bbox, source: "yolo" },
          ],
        },
      })),
    );
    expect(status).toBe(200);
    expect(body.count).toBe(2);
    expect(body.annotations).toHaveLength(2);
    expect(body.annotations[1].source).toBe("yolo");
  });

  it("delete-before-insert replaces a source's annotations on the named pages only", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const seed = (pageNumber: number, name: string, source: string) =>
      POST(makeReq("/api/annotations", { body: { projectId: project.publicId, pageNumber, name, bbox, source } }));
    await seed(1, "old-yolo-p1", "yolo");
    await seed(2, "old-yolo-p2", "yolo");
    await seed(1, "user-p1", "user");

    const { body } = await readJson(
      await POST(makeReq("/api/annotations", {
        body: {
          projectId: project.publicId,
          deleteSource: "yolo",
          deletePageNumbers: [1],
          annotations: [{ pageNumber: 1, name: "new-yolo-p1", bbox, source: "yolo" }],
        },
      })),
    );
    expect(body.count).toBe(1);
    const names = (await annotationsFor(project.id)).map((a) => a.name).sort();
    // p1 yolo replaced; p2 yolo untouched; p1 user untouched
    expect(names).toEqual(["new-yolo-p1", "old-yolo-p2", "user-p1"]);
  });

  it("400 when projectId missing; whole batch rejected when ANY bbox invalid", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const noProject = await readJson(
      await POST(makeReq("/api/annotations", { body: { annotations: [{ pageNumber: 1, name: "a", bbox }] } })),
    );
    expect(noProject.status).toBe(400);
    expect(noProject.body.error).toEqual({ code: "VALIDATION", message: "projectId required" });

    const badOne = await readJson(
      await POST(makeReq("/api/annotations", {
        body: {
          projectId: project.publicId,
          annotations: [
            { pageNumber: 1, name: "ok", bbox },
            { pageNumber: 1, name: "bad", bbox: [0.9, 0.9, 0.1, 0.1] },
          ],
        },
      })),
    );
    expect(badOne.status).toBe(400);
    expect(await annotationsFor(project.id)).toHaveLength(0); // nothing partially inserted
  });

  it("malformed JSON body → 400 BAD_REQUEST (shell-handled; was an unhandled 500 pre-shell)", async () => {
    const { user } = await createWorld();
    asUser(user);
    // Pre-shell the route did `await req.json()` bare and invalid JSON threw an unhandled 500.
    // The shell's safeParseJsonBody now turns it into a structured 400 (this assertion flipped
    // with the P1.3 migration, in the same commit).
    const { status, body } = await readJson(
      await POST(new Request("http://test.local/api/annotations", { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" })),
    );
    expect(status).toBe(400);
    expect(body.error).toEqual({ code: "BAD_REQUEST", message: "Invalid JSON body" });
  });

  it("batch validates bbox AFTER auth (asymmetry vs single): signed-out + bad bbox → 401", async () => {
    const { project } = await createWorld();
    signedOut();
    // Batch mode resolves auth BEFORE the per-annotation bbox loop, so a signed-out batch with a
    // bad bbox 401s (auth wins) — the inverse of single mode. A deliberately frozen quirk; a
    // future change that unified the two paths' validation order would silently break this.
    const { status } = await readJson(
      await POST(makeReq("/api/annotations", { body: { projectId: project.publicId, annotations: [{ pageNumber: 1, name: "x", bbox: [0.9, 0.9, 0.1, 0.1] }] } })),
    );
    expect(status).toBe(401);
  });

  it("delete-before-insert rolls back when the insert fails — seeded rows survive (sanctioned tx; legacy lost them)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    await POST(makeReq("/api/annotations", { body: { projectId: project.publicId, pageNumber: 1, name: "old-yolo", bbox, source: "yolo" } }));
    expect(await annotationsFor(project.id)).toHaveLength(1);

    // A batch that deletes the yolo/page-1 rows then inserts a row whose name exceeds the
    // varchar(255) bound → the insert throws INSIDE the tx → the delete rolls back. Pre-tx the
    // legacy ran delete + insert as separate statements, so the delete committed and the rows were
    // LOST; the P1.3 tx (sanctioned scope-add) prevents that. This asserts the NEW behavior.
    const { status } = await readJson(
      await POST(makeReq("/api/annotations", {
        body: {
          projectId: project.publicId,
          deleteSource: "yolo",
          deletePageNumbers: [1],
          annotations: [{ pageNumber: 1, name: "x".repeat(300), bbox, source: "yolo" }],
        },
      })),
    );
    expect(status).toBe(500); // generic INTERNAL (leak-free)
    expect(await annotationsFor(project.id)).toHaveLength(1); // rollback: the original row survives
  });
});
