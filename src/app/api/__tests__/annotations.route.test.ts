// @vitest-environment node
// [refactor jun12 P0.3] CHARACTERIZATION tests for POST /api/annotations.
// These freeze TODAY'S behavior — including quirks (falsy pageNumber rejected,
// per-endpoint envelope shapes). P1's shell conversion must keep these green;
// the unified-envelope change is the one sanctioned diff (update tests + the
// client call sites in the same commit, per plan 03 §P1.2).
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
      expect(body.error).toBe("projectId, pageNumber, name, and bbox required");
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
    expect(noProject.body.error).toBe("projectId required");

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

  it("malformed JSON body is currently an unhandled 500 class (P1 shell makes it 400) — freeze via throw", async () => {
    const { user } = await createWorld();
    asUser(user);
    // [quirk frozen] route does `await req.json()` bare — invalid JSON throws.
    // The shell conversion (P1) turns this into a structured 400; this
    // assertion flips then, in the same commit.
    await expect(
      POST(new Request("http://test.local/api/annotations", { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" })),
    ).rejects.toThrow();
  });
});
