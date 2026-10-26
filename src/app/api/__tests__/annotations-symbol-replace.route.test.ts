// @vitest-environment node
// [TP-1 WP-1.C, K12] POST /api/annotations batch with `deleteIds`: the symbol-search Save replaces
// exactly the rows it names, and only those of this project, the named source and the caller's own
// creatorId. Before, the Save sent `deletePageNumbers` and erased every symbol-search row on the
// saved pages: other templates' matches and other users' saves included. That legacy path is now
// refused for symbol-search (other sources keep it; annotations.route.test pins yolo). DB-backed.
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { POST } from "@/app/api/annotations/route";
import { symbolSaveReplaceIds } from "@/lib/symbol-save";
import { annotationsFor, asUser, createProject, createUser, createWorld, makeReq, readJson } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

type Box = [number, number, number, number];
const match = (pageNumber: number, bbox: Box, template: string) => ({
  pageNumber, name: "symbol-match", bbox, source: "symbol-search", threshold: 0.9,
  data: { modelName: "symbol-search", method: "template", confidence: 0.9, scale: 1, templateSourcePage: 1, template },
});

const save = (projectId: string, annotations: ReturnType<typeof match>[], deleteIds: number[]) =>
  POST(makeReq("/api/annotations", { body: { projectId, annotations, deleteSource: "symbol-search", deleteIds } })).then(readJson);

const A1: Box = [0.1, 0.1, 0.15, 0.15];
const A2: Box = [0.6, 0.6, 0.65, 0.65];
const B1: Box = [0.3, 0.3, 0.35, 0.35];

describe.skipIf(!dbUp)("POST /api/annotations — symbol-search replace by id (K12)", () => {
  it("saving template B keeps template A rows on the same page", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const first = await save(project.publicId, [match(4, A1, "A"), match(4, A2, "A")], []);
    expect(first.status).toBe(200);
    expect(first.body.deletedIds).toEqual([]);

    const existing = (await annotationsFor(project.id)).map((r) => ({
      id: r.id, pageNumber: r.pageNumber, source: r.source, bbox: [r.minX, r.minY, r.maxX, r.maxY],
    }));
    const incoming = [match(4, B1, "B")];
    const deleteIds = symbolSaveReplaceIds(existing, incoming);
    expect(deleteIds).toEqual([]);

    const second = await save(project.publicId, incoming, deleteIds);
    expect(second.status).toBe(200);
    expect(second.body.deletedIds).toEqual([]);
    const rows = await annotationsFor(project.id);
    expect(rows.map((r) => (r.data as { template: string }).template).sort()).toEqual(["A", "A", "B"]);
  });

  it("re-saving the same spot replaces the caller's row, never another user's, project's or source's", async () => {
    const { company, user, project } = await createWorld();
    const colleague = await createUser(company.id);
    const otherProject = await createProject(company.id, user.id);
    asUser(user);
    const mine = (await save(project.publicId, [match(4, A1, "A")], [])).body.annotations[0].id as number;
    const elsewhere = (await save(otherProject.publicId, [match(4, A1, "A")], [])).body.annotations[0].id as number;
    const userDrawn = (await readJson(await POST(makeReq("/api/annotations", {
      body: { projectId: project.publicId, pageNumber: 4, name: "door", bbox: A1, source: "user" },
    })))).body.id as number;
    asUser(colleague);
    const theirs = (await save(project.publicId, [match(4, A1, "A")], [])).body.annotations[0].id as number;

    asUser(user);
    const res = await save(project.publicId, [match(4, A1, "A")], [mine, theirs, elsewhere, userDrawn]);
    expect(res.status).toBe(200);
    expect(res.body.deletedIds).toEqual([mine]);
    const ids = (await annotationsFor(project.id)).map((r) => r.id);
    expect(ids).not.toContain(mine);
    expect(ids).toEqual(expect.arrayContaining([theirs, userDrawn]));
    expect((await annotationsFor(otherProject.id)).map((r) => r.id)).toEqual([elsewhere]);
  });

  it("rejects malformed deleteIds and deleteIds without a source before writing anything", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    for (const deleteIds of ["1", [0], [1.5], [-2]] as unknown[]) {
      const res = await readJson(await POST(makeReq("/api/annotations", {
        body: { projectId: project.publicId, annotations: [match(1, A1, "A")], deleteSource: "symbol-search", deleteIds },
      })));
      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe("deleteIds must be an array of annotation ids");
    }
    const noSource = await readJson(await POST(makeReq("/api/annotations", {
      body: { projectId: project.publicId, annotations: [match(1, A1, "A")], deleteIds: [1] },
    })));
    expect(noSource.status).toBe(400);
    expect(noSource.body.error.message).toBe("deleteIds requires deleteSource");
    expect(await annotationsFor(project.id)).toHaveLength(0);
  });

  it("refuses the legacy page-wide deletePageNumbers for symbol-search: every row survives, nothing is inserted", async () => {
    const { company, user, project } = await createWorld();
    const colleague = await createUser(company.id);
    asUser(user);
    const mine = (await save(project.publicId, [match(4, A1, "A")], [])).body.annotations[0].id as number;
    asUser(colleague);
    const theirs = (await save(project.publicId, [match(4, A2, "B")], [])).body.annotations[0].id as number;

    // What a tab still running the pre-K12 bundle sends.
    asUser(user);
    for (const deletePageNumbers of [[4], []] as number[][]) {
      const res = await readJson(await POST(makeReq("/api/annotations", {
        body: { projectId: project.publicId, annotations: [match(4, B1, "C")], deleteSource: "symbol-search", deletePageNumbers },
      })));
      expect(res.status).toBe(400);
      expect(res.body.error).toEqual({
        code: "VALIDATION",
        message: "Symbol matches now save by id. Reload the page and save again.",
      });
    }
    expect((await annotationsFor(project.id)).map((r) => r.id).sort((a, b) => a - b)).toEqual(
      [mine, theirs].sort((a, b) => a - b),
    );
  });
});
