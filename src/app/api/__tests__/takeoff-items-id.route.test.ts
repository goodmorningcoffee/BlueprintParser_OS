// @vitest-environment node
// [refactor jun16 P1.2] CHARACTERIZATION for /api/takeoff-items/[id] (PUT, DELETE), added
// WITH the P1.2 migration to lock the [id] paths the P0.3 harness never froze (it only
// covered the collection GET/POST). Frozen behavior: indirect lookup (item → its project),
// missing entity 404s BEFORE auth, signed-out on an existing item → 401, cross-tenant → 404,
// partial update, rename → annotation name sync, marker cleanup on delete, invalid groupId
// → 400. Errors use the P1 envelope `{ error: { code, message } }`.
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { DELETE, PUT } from "@/app/api/takeoff-items/[id]/route";
import { db } from "@/lib/db";
import { annotations, takeoffGroups, takeoffItems } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
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

async function seedItem(projectId: number, over: Partial<typeof takeoffItems.$inferInsert> = {}) {
  const [row] = await db
    .insert(takeoffItems)
    .values({ projectId, name: "Doors", shape: "circle", color: "#fff", size: 10, sortOrder: 0, ...over })
    .returning();
  return row;
}

async function seedTakeoffAnnotation(projectId: number, takeoffItemId: number, name: string) {
  const [row] = await db.insert(annotations).values({
    projectId,
    name,
    minX: 0,
    maxX: 1,
    minY: 0,
    maxY: 1,
    pageNumber: 1,
    source: "takeoff",
    data: { takeoffItemId } as unknown as (typeof annotations.$inferInsert)["data"],
  }).returning();
  return row;
}

const put = (id: string | number, body: unknown) =>
  PUT(makeReq(`/api/takeoff-items/${id}`, { method: "PUT", body }), params({ id: String(id) }));
const del = (id: string | number) =>
  DELETE(makeReq(`/api/takeoff-items/${id}`, { method: "DELETE" }), params({ id: String(id) }));

describe.skipIf(!dbUp)("PUT/DELETE /api/takeoff-items/[id]", () => {
  it("PUT updates fields + syncs the renamed annotation; returns {success:true}", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const item = await seedItem(project.id, { name: "Old" });
    await seedTakeoffAnnotation(project.id, item.id, "Old");

    const res = await readJson(await put(item.id, { name: "New", color: "#abc", notes: "hi" }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });

    const [updated] = await db.select().from(takeoffItems).where(eq(takeoffItems.id, item.id));
    expect(updated.name).toBe("New");
    expect(updated.color).toBe("#abc");
    expect(updated.notes).toBe("hi");

    const [ann] = await db
      .select()
      .from(annotations)
      .where(and(eq(annotations.projectId, project.id), eq(annotations.source, "takeoff")));
    expect(ann.name).toBe("New"); // rename synced to the takeoff marker
  });

  it("B2 RED: PUT rename scopes takeoff annotation sync to the item's project", async () => {
    const own = await createWorld();
    const foreign = await createWorld();
    const item = await seedItem(own.project.id, { name: "Old" });
    const localMarker = await seedTakeoffAnnotation(own.project.id, item.id, "Old");
    const plantedForeignMarker = await seedTakeoffAnnotation(
      foreign.project.id,
      item.id,
      "FOREIGN-MUST-STAY",
    );
    asUser(own.user);

    const response = await readJson(await put(item.id, { name: "New" }));

    expect.soft(response.status).toBe(200);
    expect.soft((await db.select({ name: annotations.name }).from(annotations)
      .where(eq(annotations.id, localMarker.id)))[0]?.name).toBe("New");
    expect.soft((await db.select({ name: annotations.name }).from(annotations)
      .where(eq(annotations.id, plantedForeignMarker.id)))[0]?.name).toBe("FOREIGN-MUST-STAY");
  });

  it("PUT invalid groupId (non-integer) → 400; null groupId allowed", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const item = await seedItem(project.id);

    const bad = await readJson(await put(item.id, { groupId: 1.5 }));
    expect(bad.status).toBe(400);
    expect(bad.body.error).toEqual({ code: "VALIDATION", message: "invalid groupId" });

    expect((await readJson(await put(item.id, { groupId: null }))).status).toBe(200);
  });

  it("B2 RED: PUT rejects a groupId owned by another project and preserves the item", async () => {
    const own = await createWorld();
    const foreign = await createWorld();
    const item = await seedItem(own.project.id);
    const [foreignGroup] = await db.insert(takeoffGroups).values({
      projectId: foreign.project.id,
      name: "Foreign group",
      kind: "count",
      sortOrder: 0,
    }).returning();
    asUser(own.user);

    const response = await readJson(await put(item.id, { groupId: foreignGroup.id }));

    expect.soft(response.status).toBe(404);
    expect.soft(response.body.error).toEqual({ code: "NOT_FOUND", message: "Not found" });
    expect.soft((await db.select({ groupId: takeoffItems.groupId }).from(takeoffItems)
      .where(eq(takeoffItems.id, item.id)))[0]?.groupId).toBeNull();
  });

  it("PUT: missing item → 404; signed-out on existing → 401; cross-tenant → 404", async () => {
    const { user, project } = await createWorld();
    const item = await seedItem(project.id);

    asUser(user);
    expect((await readJson(await put(999999, { name: "x" }))).status).toBe(404); // missing → 404 before auth
    // items/[id] has NO id validation (unlike groups/[id], which 400s "invalid id"): a
    // non-numeric id → parseInt→NaN → the pg int-cast on `id = NaN` THROWS → 500. Verified
    // empirically. The shell makes that 500 leak-free/generic (was an unhandled framework 500).
    const nan = await readJson(await put("abc", { name: "x" }));
    expect(nan.status).toBe(500);
    expect(nan.body.error).toEqual({ code: "INTERNAL", message: "Internal server error" });

    signedOut();
    expect((await readJson(await put(item.id, { name: "x" }))).status).toBe(401); // existing + no session

    asUser(await createUser((await createCompany()).id)); // another company
    expect((await readJson(await put(item.id, { name: "x" }))).status).toBe(404); // cross-tenant = 404
  });

  it("DELETE removes the item AND its takeoff markers; returns {success:true}", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const item = await seedItem(project.id);
    await seedTakeoffAnnotation(project.id, item.id, "m");

    const res = await readJson(await del(item.id));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect((await db.select().from(takeoffItems).where(eq(takeoffItems.id, item.id))).length).toBe(0);
    const markers = await db
      .select()
      .from(annotations)
      .where(and(eq(annotations.projectId, project.id), eq(annotations.source, "takeoff")));
    expect(markers.length).toBe(0);
  });

  it("B2 RED: DELETE removes only matching markers from the item's project", async () => {
    const own = await createWorld();
    const foreign = await createWorld();
    const item = await seedItem(own.project.id);
    const localMarker = await seedTakeoffAnnotation(own.project.id, item.id, "local");
    const plantedForeignMarker = await seedTakeoffAnnotation(
      foreign.project.id,
      item.id,
      "FOREIGN-MUST-STAY",
    );
    asUser(own.user);

    const response = await readJson(await del(item.id));

    expect.soft(response.status).toBe(200);
    expect.soft((await db.select().from(annotations).where(eq(annotations.id, localMarker.id))).length).toBe(0);
    expect.soft((await db.select({ name: annotations.name }).from(annotations)
      .where(eq(annotations.id, plantedForeignMarker.id)))[0]?.name).toBe("FOREIGN-MUST-STAY");
  });

  it("DELETE: missing → 404; cross-tenant → 404", async () => {
    const { project } = await createWorld();
    const item = await seedItem(project.id);
    asUser(await createUser((await createCompany()).id));
    expect((await readJson(await del(item.id))).status).toBe(404);
    expect((await readJson(await del(999999))).status).toBe(404);
  });
});
