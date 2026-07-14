// @vitest-environment node
// [refactor jun12 P0.3] CHARACTERIZATION for /api/takeoff-groups (the P1.2
// pilot family). Freezes: validation-before-auth ordering, kind whitelist,
// per-(project,kind) sortOrder assignment, auto-CSI from the group name,
// demo read-only EXCEPT admin/root scope, and the 500 path that leaks raw
// pg error text into `error` (the err.message-leak class — the P1 envelope
// kills it; assertion flips in that commit).
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { GET, POST } from "@/app/api/takeoff-groups/route";
import { db } from "@/lib/db";
import { takeoffGroups } from "@/lib/db/schema";
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

const post = (body: unknown) => POST(makeReq("/api/takeoff-groups", { body }));
const get = (projectId?: string) =>
  GET(makeReq(`/api/takeoff-groups${projectId ? `?projectId=${projectId}` : ""}`, { method: "GET" }));

describe.skipIf(!dbUp)("POST /api/takeoff-groups", () => {
  it("creates groups with per-(project,kind) sortOrder and auto-CSI from name", async () => {
    const { user, project } = await createWorld();
    asUser(user);

    const a = await readJson(await post({ projectId: project.publicId, name: "Gypsum Board Walls", kind: "area" }));
    expect(a.status).toBe(200);
    expect(a.body.sortOrder).toBe(0);
    // auto-CSI runs detectCsiCodes(name); whether it resolves depends on the
    // CSI dictionary (this name happens NOT to match → null). The frozen
    // contract: the field is always present, and an explicit value wins (below).
    expect("csiCode" in a.body).toBe(true);

    const b = await readJson(await post({ projectId: project.publicId, name: "More Walls", kind: "area" }));
    expect(b.body.sortOrder).toBe(1); // same kind increments

    const c = await readJson(await post({ projectId: project.publicId, name: "Door Count", kind: "count", csiCode: "08 11 00" }));
    expect(c.body.sortOrder).toBe(0); // separate ladder per kind
    expect(c.body.csiCode).toBe("08 11 00"); // explicit value wins over auto-detect
  });

  it("validates BEFORE auth: missing fields/bad kind → 400 even signed out (quirk)", async () => {
    const { project } = await createWorld();
    signedOut();
    expect((await readJson(await post({ name: "x", kind: "area" }))).status).toBe(400);
    expect((await readJson(await post({ projectId: "p", kind: "area" }))).status).toBe(400);
    const badKind = await readJson(await post({ projectId: "p", name: "x", kind: "volume" }));
    expect(badKind.status).toBe(400);
    // [refactor jun16 P1.2] envelope flip — was `error: "invalid kind"` (bare string). Note
    // validate-before-auth is preserved: kind is checked before the id, so the non-uuid "p"
    // never reaches auth — "invalid kind" still wins (would be "Invalid project id" otherwise).
    expect(badKind.body.error).toEqual({ code: "VALIDATION", message: "invalid kind" });
    // valid body + signed out → resolveProjectAccess → 401.
    // NOTE (quirk worth knowing, NOT asserted): resolveProjectAccess queries
    // the project BEFORE/with auth, and a non-uuid publicId makes postgres
    // THROW (unhandled 500 class) — zod id validation in the P1 shell fixes
    // that; a real uuid is required here to reach the auth path.
    expect((await readJson(await post({ projectId: project.publicId, name: "x", kind: "area" }))).status).toBe(401);
  });

  it("L5 freeze: demo create denies signed-out, member, admin, and root with zero inserts", async () => {
    const { project, company } = await createWorld({ isDemo: true });
    const member = await createUser(company.id);
    const admin = await createUser(company.id, { role: "admin" });
    const root = await createUser((await createCompany()).id, { role: "admin", isRootAdmin: true });
    const responses = [];
    for (const actor of [null, member, admin, root]) {
      actor ? asUser(actor) : signedOut();
      responses.push(await readJson(await post({ projectId: project.publicId, name: "x", kind: "count" })));
    }
    expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403]);
    expect(responses.map((response) => response.body.error)).toEqual(
      Array(4).fill({ code: "FORBIDDEN", message: "Demo projects are read-only" }),
    );
    expect(await db.select().from(takeoffGroups).where(eq(takeoffGroups.projectId, project.id))).toEqual([]);
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
    const body = { projectId: project.publicId, name: "x", kind: "count" };

    signedOut();
    const anon = await readJson(await post(body));
    expect(anon.status).toBe(403);
    expect(anon.body.error).toEqual({ code: "FORBIDDEN", message: "Demo projects are read-only" });

    asUser(await createUser((await createCompany()).id));
    const crossCo = await readJson(await post(body));
    expect(crossCo.status).toBe(403);
    expect(crossCo.body.error).toEqual({ code: "FORBIDDEN", message: "Demo projects are read-only" });
  });

  it("cross-tenant create → 404", async () => {
    const { project } = await createWorld();
    const outsider = await createUser((await createCompany()).id);
    asUser(outsider);
    expect((await readJson(await post({ projectId: project.publicId, name: "x", kind: "area" }))).status).toBe(404);
  });
});

describe.skipIf(!dbUp)("GET /api/takeoff-groups", () => {
  it("lists groups sorted by sortOrder; company-scoped; 400 without projectId", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    await post({ projectId: project.publicId, name: "B", kind: "area" });
    await post({ projectId: project.publicId, name: "A", kind: "count" });

    const { status, body } = await readJson(await get(project.publicId));
    expect(status).toBe(200);
    expect(body.map((g: { name: string }) => g.name)).toEqual(["B", "A"]); // sortOrder 0,0 — insertion order by kind ladder
    expect((await readJson(await get())).status).toBe(400);

    const outsider = await createUser((await createCompany()).id);
    asUser(outsider);
    expect((await readJson(await get(project.publicId))).status).toBe(404);
  });
});
