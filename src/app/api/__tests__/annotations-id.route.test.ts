// @vitest-environment node
// [refactor jun17 P1.3] CHARACTERIZATION for /api/annotations/[id] (PUT, DELETE), added WITH the
// P1.3 migration to lock the [id] paths the P0.3 harness never froze (it only covered the
// collection POST). Frozen behavior: indirect lookup (annotation → its project), missing entity
// 404s BEFORE auth, signed-out on an existing annotation → 401, cross-tenant → 404, non-numeric
// id → generic 500 (parseInt NaN → pg int-cast; same quirk as takeoff-items/[id]), partial
// update (name/note/data/bbox; bbox is NOT validated on PUT), auto-CSI merge from the note with
// manual codes preserved, DELETE removes the row. Errors use the P1 envelope {error:{code,message}}.
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { DELETE, PUT } from "@/app/api/annotations/[id]/route";
import { db } from "@/lib/db";
import { annotations } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  asUser,
  createCompany,
  createUser,
  createWorld,
  makeReq,
  params,
  readJson,
  signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;
const bbox = [0.1, 0.1, 0.3, 0.3];

async function seedAnnotation(projectId: number, over: Partial<typeof annotations.$inferInsert> = {}) {
  const [row] = await db
    .insert(annotations)
    .values({
      projectId,
      name: "Old",
      minX: 0.1,
      minY: 0.1,
      maxX: 0.2,
      maxY: 0.2,
      pageNumber: 1,
      source: "user",
      ...over,
    })
    .returning();
  return row;
}

const put = (id: string | number, body: unknown) =>
  PUT(makeReq(`/api/annotations/${id}`, { method: "PUT", body }), params({ id: String(id) }));
const del = (id: string | number) =>
  DELETE(makeReq(`/api/annotations/${id}`, { method: "DELETE" }), params({ id: String(id) }));

describe.skipIf(!dbUp)("PUT/DELETE /api/annotations/[id]", () => {
  it("PUT updates fields (name/note/bbox) + returns {success, autoCsiCodes}", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const ann = await seedAnnotation(project.id, { name: "Old" });

    const res = await readJson(await put(ann.id, { name: "New", note: "a note", bbox }));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.autoCsiCodes)).toBe(true);

    const [row] = await db.select().from(annotations).where(eq(annotations.id, ann.id));
    expect(row.name).toBe("New");
    expect(row.note).toBe("a note");
    expect([row.minX, row.minY, row.maxX, row.maxY]).toEqual(bbox); // bbox written verbatim (no validation)
  });

  it("PUT preserves a manual csiCode when merging auto-detected codes from the note", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const ann = await seedAnnotation(project.id);
    // The frozen invariant is that a manual code in the request data is never dropped (Set
    // dedupe), independent of whatever the CSI dictionary detects from the note text.
    const res = await readJson(
      await put(ann.id, { note: "provide gypsum board partitions per spec section 09 29 00", data: { csiCodes: ["03 30 00"] } }),
    );
    expect(res.status).toBe(200);
    const [row] = await db.select().from(annotations).where(eq(annotations.id, ann.id));
    expect((row.data as { csiCodes: string[] }).csiCodes).toContain("03 30 00");
  });

  it("note-only PUT (no `data` in body) seeds csiCodes from the EXISTING row — manual code preserved", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const ann = await seedAnnotation(project.id, {
      data: { csiCodes: ["03 30 00"] } as unknown as (typeof annotations.$inferInsert)["data"],
    });
    // PUT with ONLY a note (no `data`): the merge branch seeds from the existing row's data, so
    // the pre-existing manual code must survive (plus any auto-detected codes). Exercises the
    // existing-row seeding fallback the service comment flags as load-bearing.
    const res = await readJson(await put(ann.id, { note: "provide gypsum board partitions per spec section 09 29 00" }));
    expect(res.status).toBe(200);
    const [row] = await db.select().from(annotations).where(eq(annotations.id, ann.id));
    expect((row.data as { csiCodes: string[] }).csiCodes).toContain("03 30 00");
  });

  it("demo write gate: signed-out PUT/DELETE on a demo project → 401/404; row survives", async () => {
    const { project } = await createWorld({ isDemo: true });
    const ann = await seedAnnotation(project.id);
    signedOut();
    // annotation writes NEVER allow demo — a signed-out demo write is denied (no allowDemo path).
    expect([401, 404]).toContain((await readJson(await put(ann.id, { name: "x" }))).status);
    expect([401, 404]).toContain((await readJson(await del(ann.id))).status);
    expect((await db.select().from(annotations).where(eq(annotations.id, ann.id))).length).toBe(1);
  });

  it("demo carve-out: the owning-company member CAN PUT on their own demo project", async () => {
    const { user, project } = await createWorld({ isDemo: true });
    asUser(user);
    const ann = await seedAnnotation(project.id);
    // With no allowDemo, a demo project is treated as a normal company-scoped project: its owner
    // still passes the company-match check. (This is the positive half of the demo-write policy.)
    expect((await readJson(await put(ann.id, { name: "x" }))).status).toBe(200);
  });

  it("PUT: missing → 404; non-numeric id → 500; signed-out on existing → 401; cross-tenant → 404", async () => {
    const { user, project } = await createWorld();
    const ann = await seedAnnotation(project.id);

    asUser(user);
    expect((await readJson(await put(999999, { name: "x" }))).status).toBe(404); // missing → 404 before auth
    // annotations/[id] has NO id validation: a non-numeric id → parseInt→NaN → the pg int-cast on
    // `id = NaN` THROWS → the shell makes that an unleaked generic 500 (was an unhandled framework 500).
    const nan = await readJson(await put("abc", { name: "x" }));
    expect(nan.status).toBe(500);
    expect(nan.body.error).toEqual({ code: "INTERNAL", message: "Internal server error" });

    signedOut();
    expect((await readJson(await put(ann.id, { name: "x" }))).status).toBe(401); // existing + no session

    asUser(await createUser((await createCompany()).id)); // another company
    expect((await readJson(await put(ann.id, { name: "x" }))).status).toBe(404); // cross-tenant = 404
  });

  it("DELETE removes the annotation; returns {success:true}", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const ann = await seedAnnotation(project.id);

    const res = await readJson(await del(ann.id));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect((await db.select().from(annotations).where(eq(annotations.id, ann.id))).length).toBe(0);
  });

  it("DELETE: missing → 404; cross-tenant → 404 (and the row survives)", async () => {
    const { project } = await createWorld();
    const ann = await seedAnnotation(project.id);
    asUser(await createUser((await createCompany()).id));
    expect((await readJson(await del(ann.id))).status).toBe(404);
    expect((await readJson(await del(999999))).status).toBe(404);
    expect((await db.select().from(annotations).where(eq(annotations.id, ann.id))).length).toBe(1);
  });
});
