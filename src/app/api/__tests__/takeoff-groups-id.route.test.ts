// @vitest-environment node
// [refactor jun16 P1.2] CHARACTERIZATION for /api/takeoff-groups/[id] (PUT, DELETE), added
// WITH the P1.2 migration to lock the [id] paths (P0.3 froze only the collection GET/POST).
// Frozen behavior: id validated → 400 "invalid id" (groups validate id; items/[id] do NOT),
// missing → 404, indirect lookup + cross-tenant 404, partial update with per-field 400s,
// name trimmed, fill-when-empty CSI never overwrites a curated code, FK SET NULL orphans
// items on delete. Errors use the P1 envelope `{ error: { code, message } }`.
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { DELETE, PUT } from "@/app/api/takeoff-groups/[id]/route";
import { db } from "@/lib/db";
import { takeoffGroups, takeoffItems } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  asUser,
  createCompany,
  createUser,
  createWorld,
  makeReq,
  params,
  readJson,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

async function seedGroup(projectId: number, over: Partial<typeof takeoffGroups.$inferInsert> = {}) {
  const [row] = await db
    .insert(takeoffGroups)
    .values({ projectId, name: "Group", kind: "count", sortOrder: 0, ...over })
    .returning();
  return row;
}

const put = (id: string | number, body: unknown) =>
  PUT(makeReq(`/api/takeoff-groups/${id}`, { method: "PUT", body }), params({ id: String(id) }));
const del = (id: string | number) =>
  DELETE(makeReq(`/api/takeoff-groups/${id}`, { method: "DELETE" }), params({ id: String(id) }));

describe.skipIf(!dbUp)("PUT/DELETE /api/takeoff-groups/[id]", () => {
  it("PUT updates name(trim)/color/csiCode/sortOrder; returns the 6-field payload", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const group = await seedGroup(project.id, { name: "Old", kind: "area" });

    const res = await readJson(
      await put(group.id, { name: "  New Name  ", color: "#abc", csiCode: "09 21 00", sortOrder: 3 }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: group.id,
      name: "New Name", // trimmed
      kind: "area",
      color: "#abc",
      csiCode: "09 21 00",
      sortOrder: 3,
    });
  });

  it("PUT field validation: invalid name/color/csiCode/sortOrder → 400", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const group = await seedGroup(project.id);

    const empty = await readJson(await put(group.id, { name: "   " }));
    expect(empty.status).toBe(400);
    expect(empty.body.error).toEqual({ code: "VALIDATION", message: "invalid name" });

    expect((await readJson(await put(group.id, { color: "x".repeat(21) }))).status).toBe(400);
    expect((await readJson(await put(group.id, { csiCode: "x".repeat(21) }))).status).toBe(400);
    expect((await readJson(await put(group.id, { sortOrder: 1.5 }))).status).toBe(400);
  });

  it("PUT fill-when-empty CSI never overwrites a curated code on rename", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const group = await seedGroup(project.id, { csiCode: "08 11 00" });
    // rename only; no csiCode in body, but the record already HAS one → stays put.
    const res = await readJson(await put(group.id, { name: "Renamed" }));
    expect(res.status).toBe(200);
    expect(res.body.csiCode).toBe("08 11 00");
  });

  it("PUT: invalid id → 400; missing → 404; cross-tenant → 404", async () => {
    const { user, project } = await createWorld();
    const group = await seedGroup(project.id);

    asUser(user);
    const badId = await readJson(await put("abc", { name: "x" }));
    expect(badId.status).toBe(400);
    expect(badId.body.error).toEqual({ code: "VALIDATION", message: "invalid id" });
    expect((await readJson(await put(999999, { name: "x" }))).status).toBe(404);

    asUser(await createUser((await createCompany()).id)); // another company
    expect((await readJson(await put(group.id, { name: "x" }))).status).toBe(404);
  });

  it("DELETE removes the group and orphans its items (groupId → null)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const group = await seedGroup(project.id);
    const [item] = await db
      .insert(takeoffItems)
      .values({ projectId: project.id, groupId: group.id, name: "I", shape: "circle", color: "#fff", sortOrder: 0 })
      .returning();

    const res = await readJson(await del(group.id));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect((await db.select().from(takeoffGroups).where(eq(takeoffGroups.id, group.id))).length).toBe(0);
    const [stillThere] = await db.select().from(takeoffItems).where(eq(takeoffItems.id, item.id));
    expect(stillThere.groupId).toBeNull(); // FK ON DELETE SET NULL
  });

  it("DELETE: invalid id → 400; missing → 404; cross-tenant → 404", async () => {
    const { project } = await createWorld();
    const group = await seedGroup(project.id);

    asUser(await createUser((await createCompany()).id));
    expect((await readJson(await del("abc"))).status).toBe(400);
    expect((await readJson(await del(group.id))).status).toBe(404); // cross-tenant
    expect((await readJson(await del(999999))).status).toBe(404);
  });
});
