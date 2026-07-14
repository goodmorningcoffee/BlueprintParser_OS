// @vitest-environment node
// [refactor jul3 P1.5] CHARACTERIZATION for GET /api/labeling/sessions (list), written as THE
// FREEZE before the P1.5 migration onto services/labeling.ts (no P0.3 file existed). Frozen:
//   • AUTH-FIRST: requireAuth 401 fires BEFORE the projectId-required 400 (opposite of the
//     pages/search validate-before-auth shape).
//   • project lookup = and(publicId, companyId) — NO isRootAdmin bypass, NO isDemo carve-out
//     (qto-GET precedent). Root admin cross-company → 404, no existence leak. The R1 guard here
//     is the test that catches a future resolveProjectOrThrow "simplification".
//   • 200 = BARE ARRAY (not {sessions:[...]}) mapped to EXACTLY 8 fields
//     [id,labelStudioProjectId,labelStudioUrl,taskType,labels,pageRange,status,createdAt] —
//     companyId/projectId/tilingEnabled/tileGrid/updatedAt are DROPPED. No orderBy.
//   • non-uuid projectId: legacy had no catch → the pg uuid-cast THREW (S003 class). Now a clean
//     400 "Invalid project id" (sanctioned diff C).
// Assertions tagged [P1.5 fold] were flipped in the fold commit from the legacy {error:string}
// envelope to {error:{code,message}} (sanctioned diff A); the freeze form is at commit 025c9b7.
import { randomUUID } from "node:crypto";
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { GET } from "@/app/api/labeling/sessions/route";
import {
  asUser,
  createCompany,
  createLabelingSessionFixture,
  createUser,
  createWorld,
  makeReq,
  readJson,
  signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

const list = (projectId?: string) =>
  GET(
    makeReq(
      `/api/labeling/sessions${projectId !== undefined ? `?projectId=${projectId}` : ""}`,
      { method: "GET" },
    ),
  );

// The exact 8 wire fields (alphabetical for the sorted key-set assertion).
const WIRE_FIELDS = [
  "createdAt",
  "id",
  "labelStudioProjectId",
  "labelStudioUrl",
  "labels",
  "pageRange",
  "status",
  "taskType",
];

describe.skipIf(!dbUp)("GET /api/labeling/sessions", () => {
  it("happy: bare array of EXACTLY the 8 mapped fields (drops companyId/projectId/tiling*/updatedAt)", async () => {
    const { user, project } = await createWorld();
    // [DETECTOR closer COV-2] two PER-FIELD-DISTINCT seeds so the field→column mapping is pinned
    // by VALUE (a swapped/dropped mapping in the service .map() would pass a key-set-only check).
    const s1 = await createLabelingSessionFixture(project, {
      labelStudioUrl: "http://ls.test/projects/91001",
      labels: ["door", "window"],
      pageRange: "1-3",
      status: "active",
    });
    const s2 = await createLabelingSessionFixture(project, {
      labelStudioUrl: "http://ls.test/projects/91002",
      taskType: "tiled",
      tilingEnabled: true,
      tileGrid: 3,
      pageRange: "4-9",
      status: "retiring",
    });
    asUser(user);

    const { status, body } = await readJson(await list(project.publicId));
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true); // BARE array, not {sessions:[...]}
    expect(body).toHaveLength(2);
    for (const row of body) {
      expect(Object.keys(row).sort()).toEqual(WIRE_FIELDS); // exact key set — nothing extra leaks
      expect(typeof row.createdAt).toBe("string"); // Date → ISO on the wire
    }
    const byId = Object.fromEntries(body.map((r: { id: number }) => [r.id, r]));
    expect(byId[s1.id]).toMatchObject({
      labelStudioProjectId: s1.labelStudioProjectId,
      labelStudioUrl: "http://ls.test/projects/91001",
      taskType: "generic",
      labels: ["door", "window"],
      pageRange: "1-3",
      status: "active",
    });
    expect(byId[s2.id]).toMatchObject({
      labelStudioProjectId: s2.labelStudioProjectId,
      labelStudioUrl: "http://ls.test/projects/91002",
      taskType: "tiled",
      labels: null,
      pageRange: "4-9",
      status: "retiring",
    });
  });

  it("happy: project with no sessions → 200 []", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const { status, body } = await readJson(await list(project.publicId));
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it("missing projectId → 400 'projectId required'", async () => {
    const { user } = await createWorld();
    asUser(user);
    const { status, body } = await readJson(await list());
    expect(status).toBe(400);
    expect(body.error).toEqual({ code: "VALIDATION", message: "projectId required" }); // [P1.5 fold] flipped (legacy: bare string)
  });

  it("signed-out → 401 (AUTH-FIRST: fires even with no projectId at all)", async () => {
    signedOut();
    const { status, body } = await readJson(await list());
    expect(status).toBe(401);
    expect(body.error).toEqual({ code: "UNAUTHORIZED", message: "Unauthorized" }); // [P1.5 fold] flipped (legacy: bare string)
  });

  it("unknown (valid-uuid) projectId → 404 'Not found'", async () => {
    const { user } = await createWorld();
    asUser(user);
    const { status, body } = await readJson(await list(randomUUID()));
    expect(status).toBe(404);
    expect(body.error).toEqual({ code: "NOT_FOUND", message: "Not found" }); // [P1.5 fold] flipped (legacy: bare "Not found")
  });

  it("cross-tenant member → 404, no existence leak", async () => {
    const { project } = await createWorld();
    asUser(await createUser((await createCompany()).id));
    const { status, body } = await readJson(await list(project.publicId));
    expect(status).toBe(404);
    expect(body.error).toEqual({ code: "NOT_FOUND", message: "Not found" }); // [P1.5 fold] flipped (legacy: bare "Not found")
  });

  it("R1: ROOT ADMIN cross-company → 404 — the lookup has NO isRootAdmin bypass (frozen)", async () => {
    const { project } = await createWorld();
    asUser(await createUser((await createCompany()).id, { isRootAdmin: true }));
    const { status, body } = await readJson(await list(project.publicId));
    expect(status).toBe(404);
    expect(body.error).toEqual({ code: "NOT_FOUND", message: "Not found" }); // [P1.5 fold] flipped (legacy: bare "Not found")
  });

  // [P1.5 fold] WHOLE assertion flipped: legacy had no catch → the pg uuid-cast on a non-uuid
  // projectId REJECTED (raw framework 500 in prod, S003 class — frozen at 025c9b7 as
  // .rejects.toThrow()). Now sanctioned diff C: clean 400 via zPublicId, gated AFTER the
  // projectId-required 400 so the missing-field message still wins.
  it("non-uuid projectId → 400 'Invalid project id' (sanctioned diff C; legacy threw)", async () => {
    const { user } = await createWorld();
    asUser(user);
    const { status, body } = await readJson(await list("not-a-uuid"));
    expect(status).toBe(400);
    expect(body.error).toEqual({ code: "VALIDATION", message: "Invalid project id" });
  });
});
