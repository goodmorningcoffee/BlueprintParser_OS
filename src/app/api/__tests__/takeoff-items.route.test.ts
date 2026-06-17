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
import {
  asUser,
  createCompany,
  createUser,
  createWorld,
  makeReq,
  readJson,
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

  it("demo write gate: member 403, admin allowed (same scope exception as groups)", async () => {
    const { project, company } = await createWorld({ isDemo: true });
    asUser(await createUser(company.id));
    expect((await readJson(await post({ projectId: project.publicId, name: "x", shape: "circle", color: "#fff" }))).status).toBe(403);
    asUser(await createUser(company.id, { role: "admin" }));
    expect((await readJson(await post({ projectId: project.publicId, name: "x", shape: "circle", color: "#fff" }))).status).toBe(200);
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
