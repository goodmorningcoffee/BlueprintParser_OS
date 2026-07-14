// @vitest-environment node
// [refactor jun12 P0.3] CHARACTERIZATION for /api/takeoff-items (P1.2 pilot
// family, with takeoff-groups). Notable frozen quirks: color is REQUIRED here
// (groups treats it optional); GET's item payload omits groupId while POST's
// response includes it (payload asymmetry the P1 service unifies — knowingly);
// GET is strictly company-scoped with NO root-admin bypass (unlike
// projects/[id] — root from another company gets 404 here today).
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { GET, POST } from "@/app/api/takeoff-items/route";
import { db } from "@/lib/db";
import { takeoffGroups, takeoffItems } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  asUser,
  createCompany,
  createUser,
  createWorld,
  makeReq,
  readJson,
  signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;
const post = (body: unknown) => POST(makeReq("/api/takeoff-items", { body }));
const get = (projectId?: string) =>
  GET(makeReq(`/api/takeoff-items${projectId ? `?projectId=${projectId}` : ""}`, { method: "GET" }));

describe.skipIf(!dbUp)("/api/takeoff-items", () => {
  it("creates items: project-wide sortOrder ladder, size default 10, groupId in POST response", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const a = await readJson(await post({ projectId: project.publicId, name: "Doors", shape: "circle", color: "#ff0000" }));
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ name: "Doors", shape: "circle", size: 10, sortOrder: 0, groupId: null });

    const b = await readJson(await post({ projectId: project.publicId, name: "Walls", shape: "polygon", color: "#00ff00", size: 14 }));
    expect(b.body.sortOrder).toBe(1); // ladder is per-project (not per-shape)
    expect(b.body.size).toBe(14);
  });

  it("400s: missing color (required HERE unlike groups), invalid shape, non-integer groupId", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    expect((await readJson(await post({ projectId: project.publicId, name: "x", shape: "circle" }))).status).toBe(400);
    const badShape = await readJson(await post({ projectId: project.publicId, name: "x", shape: "blob", color: "#fff" }));
    expect(badShape.status).toBe(400);
    // [refactor jun16 P1.2] envelope flip — was `error: "Invalid shape"` (bare string).
    expect(badShape.body.error).toEqual({ code: "VALIDATION", message: "Invalid shape" });
    expect((await readJson(await post({ projectId: project.publicId, name: "x", shape: "circle", color: "#fff", groupId: 1.5 }))).status).toBe(400);
  });

  it("B2 RED: POST rejects a groupId owned by another project and inserts nothing", async () => {
    const own = await createWorld();
    const foreign = await createWorld();
    const [foreignGroup] = await db.insert(takeoffGroups).values({
      projectId: foreign.project.id,
      name: "Foreign group",
      kind: "count",
      sortOrder: 0,
    }).returning();
    asUser(own.user);

    const response = await readJson(await post({
      projectId: own.project.publicId,
      name: "Must not insert",
      shape: "circle",
      color: "#fff",
      groupId: foreignGroup.id,
    }));

    expect.soft(response.status).toBe(404);
    expect.soft(response.body.error).toEqual({ code: "NOT_FOUND", message: "Not found" });
    expect.soft(await db.select().from(takeoffItems).where(eq(takeoffItems.projectId, own.project.id))).toEqual([]);
  });

  it("L5 freeze: demo create denies signed-out, member, admin, and root with zero inserts", async () => {
    const { project, company } = await createWorld({ isDemo: true });
    const member = await createUser(company.id);
    const admin = await createUser(company.id, { role: "admin" });
    const root = await createUser((await createCompany()).id, { role: "admin", isRootAdmin: true });
    const statuses: number[] = [];
    for (const actor of [null, member, admin, root]) {
      actor ? asUser(actor) : signedOut();
      statuses.push(
        (await readJson(await post({ projectId: project.publicId, name: "x", shape: "circle", color: "#fff" }))).status,
      );
    }
    expect(statuses).toEqual([403, 403, 403, 403]);
    expect(await db.select().from(takeoffItems).where(eq(takeoffItems.projectId, project.id))).toEqual([]);
  });

  // [refactor jul8 P1-review PR-C1] demo-RESOLUTION parity guard. The service's local
  // resolveByPublicId (which HARDCODED {allowDemo:true}) was hoisted to the opts-parameterized
  // access.ts helper, with the option re-supplied at the call site. These two legs are the exact
  // regression dropping that option would produce: without allowDemo a demo project would 401
  // (unauth) / 404 (cross-company) at resolution instead of resolving to scope "demo" and hitting
  // the frozen 403 write-gate. (The member/admin cases above resolve through the non-demo branch
  // and would NOT catch the flip.)
  it("demo resolution parity: unauth + cross-company writers still get the 403 write-gate (not 401/404)", async () => {
    const { project } = await createWorld({ isDemo: true });
    const body = { projectId: project.publicId, name: "x", shape: "circle", color: "#fff" };

    signedOut();
    const anon = await readJson(await post(body));
    expect(anon.status).toBe(403);
    expect(anon.body.error).toEqual({ code: "FORBIDDEN", message: "Demo projects are read-only" });

    asUser(await createUser((await createCompany()).id));
    const crossCo = await readJson(await post(body));
    expect(crossCo.status).toBe(403);
    expect(crossCo.body.error).toEqual({ code: "FORBIDDEN", message: "Demo projects are read-only" });
  });

  it("GET: list shape OMITS groupId (asymmetry quirk); company-scoped strictly", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    await post({ projectId: project.publicId, name: "A", shape: "circle", color: "#fff" });
    const { status, body } = await readJson(await get(project.publicId));
    expect(status).toBe(200);
    expect(body).toHaveLength(1);
    expect(Object.keys(body[0]).sort()).toEqual(["color", "id", "name", "notes", "shape", "size", "sortOrder"]); // no groupId
    expect((await readJson(await get())).status).toBe(400);

    // strict company scoping — even a ROOT ADMIN of another company 404s here today
    const rootElsewhere = await createUser((await createCompany()).id, { isRootAdmin: true, role: "admin" });
    asUser(rootElsewhere);
    expect((await readJson(await get(project.publicId))).status).toBe(404);
  });
});
