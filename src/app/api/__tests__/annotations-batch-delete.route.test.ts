// @vitest-environment node
// [refactor jun17 P1.3] CHARACTERIZATION for POST /api/annotations/batch-delete, added WITH the
// P1.3 migration (the P0.3 harness never covered it). Frozen behavior: validate-before-auth
// (projectId/annotationIds 400 before the 401), project-scoped delete (only the named project's
// rows are removed — cross-project ids are silently ignored = tenancy), cross-tenant projectId →
// 404, integer-id validation. The legacy raw-pg-leak 500 in the catch is now a generic envelope
// 500. Errors use the P1 envelope {error:{code,message}}.
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { POST } from "@/app/api/annotations/batch-delete/route";
import { db } from "@/lib/db";
import { annotations } from "@/lib/db/schema";
import {
  annotationsFor,
  asUser,
  createCompany,
  createUser,
  createWorld,
  makeReq,
  readJson,
  signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

async function seedAnnotation(projectId: number, name: string) {
  const [row] = await db
    .insert(annotations)
    .values({ projectId, name, minX: 0, minY: 0, maxX: 1, maxY: 1, pageNumber: 1, source: "user" })
    .returning();
  return row;
}

const post = (body: unknown) => POST(makeReq("/api/annotations/batch-delete", { method: "POST", body }));

describe.skipIf(!dbUp)("POST /api/annotations/batch-delete", () => {
  it("deletes the named ids and returns {success, deletedCount, deletedIds}", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const a = await seedAnnotation(project.id, "a");
    const b = await seedAnnotation(project.id, "b");
    const c = await seedAnnotation(project.id, "c");

    const res = await readJson(await post({ projectId: project.publicId, annotationIds: [a.id, b.id] }));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.deletedCount).toBe(2);
    expect([...res.body.deletedIds].sort()).toEqual([a.id, b.id].sort());

    const remaining = (await annotationsFor(project.id)).map((r) => r.id);
    expect(remaining).toEqual([c.id]);
  });

  it("is project-scoped: ids from another project are ignored (tenancy)", async () => {
    const { user, project } = await createWorld();
    const other = await createWorld();
    asUser(user);
    const mine = await seedAnnotation(project.id, "mine");
    const theirs = await seedAnnotation(other.project.id, "theirs");

    const res = await readJson(
      await post({ projectId: project.publicId, annotationIds: [mine.id, theirs.id] }),
    );
    expect(res.status).toBe(200);
    expect(res.body.deletedCount).toBe(1);
    expect(res.body.deletedIds).toEqual([mine.id]);
    expect((await annotationsFor(other.project.id)).length).toBe(1); // theirs survives
  });

  it("validation (before auth): missing projectId / empty ids / non-integer ids → 400", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const noPid = await readJson(await post({ annotationIds: [1] }));
    expect(noPid.status).toBe(400);
    expect(noPid.body.error).toEqual({ code: "VALIDATION", message: "projectId required" });

    const empty = await readJson(await post({ projectId: project.publicId, annotationIds: [] }));
    expect(empty.status).toBe(400);
    expect(empty.body.error).toEqual({ code: "VALIDATION", message: "annotationIds required (non-empty array)" });

    const nonInt = await readJson(await post({ projectId: project.publicId, annotationIds: [1, 2.5] }));
    expect(nonInt.status).toBe(400);
    expect(nonInt.body.error).toEqual({ code: "VALIDATION", message: "annotationIds must be integers" });
  });

  it("validate-before-auth: field 400 fires even when signed out", async () => {
    signedOut();
    const res = await readJson(await post({ annotationIds: [] })); // missing projectId
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ code: "VALIDATION", message: "projectId required" });
  });

  it("auth (after validation): signed-out valid request → 401; cross-tenant projectId → 404 (row survives)", async () => {
    const { project } = await createWorld();
    const ann = await seedAnnotation(project.id, "x");

    signedOut();
    expect(
      (await readJson(await post({ projectId: project.publicId, annotationIds: [ann.id] }))).status,
    ).toBe(401);

    asUser(await createUser((await createCompany()).id)); // another company
    expect(
      (await readJson(await post({ projectId: project.publicId, annotationIds: [ann.id] }))).status,
    ).toBe(404);
    expect((await annotationsFor(project.id)).length).toBe(1);
  });

  it("demo write gate: signed-out batch-delete on a demo project → 401; rows survive", async () => {
    const { project } = await createWorld({ isDemo: true });
    const ann = await seedAnnotation(project.id, "x");
    signedOut();
    // batch-delete is a WRITE — it never allows demo; a signed-out demo request is denied.
    expect((await readJson(await post({ projectId: project.publicId, annotationIds: [ann.id] }))).status).toBe(401);
    expect((await annotationsFor(project.id)).length).toBe(1);
  });

  it("demo carve-out: the owning-company member CAN batch-delete on their own demo project", async () => {
    const { user, project } = await createWorld({ isDemo: true });
    asUser(user);
    const ann = await seedAnnotation(project.id, "x");
    const res = await readJson(await post({ projectId: project.publicId, annotationIds: [ann.id] }));
    expect(res.status).toBe(200);
    expect(res.body.deletedCount).toBe(1);
  });
});
