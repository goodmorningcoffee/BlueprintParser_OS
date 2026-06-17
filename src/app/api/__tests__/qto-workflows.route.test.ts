// @vitest-environment node
// [refactor jun17 P1.3] CHARACTERIZATION for /api/qto-workflows (GET list, POST create), written
// WITH the P1.3 family-3 migration onto services/qto-workflows.ts (no P0.3 char file existed, so
// this file IS the freeze). Frozen behavior:
//   • GET = auth:"session" + a MANUAL companyId-scoped lookup — NO root-admin bypass, NO demo read.
//     The root-admin-cross-company case below is the guard that fails if anyone swaps the manual
//     lookup for resolveProjectAccess (which root-bypasses).
//   • POST = validate-before-auth: the projectId/materialType 400 fires before any 401; then a
//     demo write-gate 403 that an owning-company admin/root bypasses; materialLabel defaults to
//     materialType; step is hardcoded "select-schedule".
//   • Sanctioned diffs only: envelope = {error:{code,message}}; a non-uuid projectId is a clean 400
//     (was a pg-uuid-cast 500).
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { GET, POST } from "@/app/api/qto-workflows/route";
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

const post = (body: unknown) => POST(makeReq("/api/qto-workflows", { body }));
const list = (projectId: string) =>
  GET(makeReq(`/api/qto-workflows?projectId=${projectId}`, { method: "GET" }));

describe.skipIf(!dbUp)("/api/qto-workflows", () => {
  it("POST create: happy path → raw row; materialLabel defaults to materialType, then is honored", async () => {
    const { user, project } = await createWorld();
    asUser(user);

    const created = await readJson(await post({ projectId: project.publicId, materialType: "concrete" }));
    expect(created.status).toBe(200);
    expect(created.body.projectId).toBe(project.id);
    expect(created.body.materialType).toBe("concrete");
    expect(created.body.materialLabel).toBe("concrete"); // frozen default = materialType
    expect(created.body.step).toBe("select-schedule"); // frozen hardcode
    expect(typeof created.body.id).toBe("number");

    const labelled = await readJson(
      await post({ projectId: project.publicId, materialType: "steel", materialLabel: "W-Beam" }),
    );
    expect(labelled.status).toBe(200);
    expect(labelled.body.materialLabel).toBe("W-Beam"); // honored when provided
  });

  it("GET list: newest-first, raw rows; empty project → []", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const first = await readJson(await post({ projectId: project.publicId, materialType: "a" }));
    const second = await readJson(await post({ projectId: project.publicId, materialType: "b" }));

    const listed = await readJson(await list(project.publicId));
    expect(listed.status).toBe(200);
    expect(Array.isArray(listed.body)).toBe(true);
    expect(listed.body).toHaveLength(2);
    // ordered by createdAt DESC; with identical timestamps drizzle still returns both — assert the
    // set, and that the newest createdAt is not after the oldest.
    const ids = listed.body.map((w: { id: number }) => w.id).sort();
    expect(ids).toEqual([first.body.id, second.body.id].sort());
    expect(listed.body[0].createdAt >= listed.body[1].createdAt).toBe(true);

    const { user: u2, project: empty } = await createWorld();
    asUser(u2);
    const none = await readJson(await list(empty.publicId));
    expect(none.status).toBe(200);
    expect(none.body).toEqual([]);
  });

  it("GET auth/scope: signed-out 401; cross-company 404; ROOT admin cross-company 404 (R1 guard); non-uuid 400; missing 400", async () => {
    const { user, project } = await createWorld();

    // signed out → shell auth:"session" 401 (before any lookup)
    signedOut();
    const out = await readJson(await list(project.publicId));
    expect(out.status).toBe(401);
    expect(out.body.error.code).toBe("UNAUTHORIZED");

    // authenticated but in a different company (non-root) → manual lookup misses → 404
    const otherCo = await createCompany();
    asUser(await createUser(otherCo.id));
    const cross = await readJson(await list(project.publicId));
    expect(cross.status).toBe(404);
    expect(cross.body.error.code).toBe("NOT_FOUND");

    // R1 GUARD: a ROOT admin in a DIFFERENT company must STILL get 404 — the manual companyId
    // lookup has no root bypass. This is the ONLY case that fails if someone swaps the service to
    // resolveProjectAccess (which would return scope "root" → 200, leaking cross-company reads).
    asUser(await createUser((await createCompany()).id, { isRootAdmin: true, role: "admin" }));
    const rootCross = await readJson(await list(project.publicId));
    expect(rootCross.status).toBe(404);
    expect(rootCross.body.error.code).toBe("NOT_FOUND");

    // non-uuid projectId → clean 400 via the shell query schema (was a pg-uuid-cast 500)
    asUser(user);
    const bad = await readJson(await GET(makeReq("/api/qto-workflows?projectId=not-a-uuid", { method: "GET" })));
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("VALIDATION");

    // missing projectId → 400 (zod rejects undefined). Assert code, not the message (zod wording).
    const missing = await readJson(await GET(makeReq("/api/qto-workflows", { method: "GET" })));
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("VALIDATION");
  });

  it("POST validate-before-auth: field 400 precedes auth; non-uuid 400; signed-out 401; cross-company 404", async () => {
    const { user, project } = await createWorld();

    // missing materialType (authenticated) → 400 with the verbatim legacy message
    asUser(user);
    const noType = await readJson(await post({ projectId: project.publicId }));
    expect(noType.status).toBe(400);
    expect(noType.body.error).toEqual({ code: "VALIDATION", message: "projectId and materialType required" });

    // missing projectId while SIGNED OUT → 400, NOT 401 — proves the field check runs before auth
    signedOut();
    const noProject = await readJson(await post({ materialType: "x" }));
    expect(noProject.status).toBe(400);
    expect(noProject.body.error.message).toBe("projectId and materialType required");

    // non-uuid projectId (fields present) → clean 400 (resolveByPublicId's zPublicId; was a 500)
    asUser(user);
    const nonUuid = await readJson(await post({ projectId: "abc", materialType: "x" }));
    expect(nonUuid.status).toBe(400);
    expect(nonUuid.body.error.code).toBe("VALIDATION");

    // valid project, signed out → 401 (auth runs after field validation passes)
    signedOut();
    const unauth = await readJson(await post({ projectId: project.publicId, materialType: "x" }));
    expect(unauth.status).toBe(401);
    expect(unauth.body.error.code).toBe("UNAUTHORIZED");

    // valid project, authenticated as a different company → 404 (tenancy, no existence leak)
    asUser(await createUser((await createCompany()).id));
    const cross = await readJson(await post({ projectId: project.publicId, materialType: "x" }));
    expect(cross.status).toBe(404);
    expect(cross.body.error.code).toBe("NOT_FOUND");
  });

  it("POST demo write-gate covers every scope branch: unauth 403, cross-company 403, owning member 403, owning admin 200, foreign root 200", async () => {
    const { company, project } = await createWorld({ isDemo: true });
    const body = { projectId: project.publicId, materialType: "x" };

    // unauthenticated write to a demo project → 403 read-only (scope "demo")
    signedOut();
    const anon = await readJson(await post(body));
    expect(anon.status).toBe(403);
    expect(anon.body.error).toEqual({ code: "FORBIDDEN", message: "Demo projects are read-only" });

    // authenticated member of ANOTHER company → scope "demo" → 403 (NOT the 404 a non-demo project
    // gives a cross-company writer — the demo carve-out makes the project visible, then gates writes)
    asUser(await createUser((await createCompany()).id));
    const crossCo = await readJson(await post(body));
    expect(crossCo.status).toBe(403);
    expect(crossCo.body.error.code).toBe("FORBIDDEN");

    // owning-company MEMBER → still 403 (scope "member" does not bypass the gate)
    asUser(await createUser(company.id)); // default role = member
    const member = await readJson(await post(body));
    expect(member.status).toBe(403);
    expect(member.body.error.code).toBe("FORBIDDEN");

    // owning-company ADMIN → 200 (scope "admin" bypasses the gate, per the frozen exception)
    asUser(await createUser(company.id, { role: "admin" }));
    const admin = await readJson(await post(body));
    expect(admin.status).toBe(200);
    expect(admin.body.materialType).toBe("x");

    // ROOT admin from a DIFFERENT company → scope "root" → 200 (the other half of the gate exception)
    asUser(await createUser((await createCompany()).id, { isRootAdmin: true, role: "admin" }));
    const foreignRoot = await readJson(await post(body));
    expect(foreignRoot.status).toBe(200);
    expect(foreignRoot.body.materialType).toBe("x");
  });

  // Inherited zLooseBody/shell diff (the de-facto 4th sanctioned diff, same as families 1/2): a
  // malformed or non-object body that legacy crashed on (req.json() throw / destructure of null) or
  // silently coerced now gets a clean shell 400 instead of an unhandled 500. STATUS is what's frozen.
  it("POST malformed/non-object body → clean shell 400 (was a legacy crash-500)", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    void project;
    // empty body: legacy `await req.json()` (outside its try) threw → 500; now zLooseBody rejects undefined
    expect((await readJson(await post(undefined))).status).toBe(400);
    // literal null: legacy destructured null → TypeError → 500; now zLooseBody rejects null
    expect((await readJson(await post(null))).status).toBe(400);
    // non-object (array / number): legacy yielded all-undefined → "…required" 400; now zLooseBody 400 first
    expect((await readJson(await post([1, 2]))).status).toBe(400);
    const num = await readJson(await post(42));
    expect(num.status).toBe(400);
    expect(num.body.error.code).toBe("VALIDATION");
  });
});
