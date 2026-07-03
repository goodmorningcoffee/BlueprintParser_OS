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
//   • non-uuid projectId: legacy has no catch → the pg uuid-cast THROWS (S003 class). Flips to a
//     clean 400 "Invalid project id" at fold time (sanctioned diff C).
// Assertions tagged [P1.5 fold] flip from the legacy {error:string} envelope to
// {error:{code,message}} in the fold commit (sanctioned diff A).
import { randomUUID } from "node:crypto";
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { GET } from "@/app/api/labeling/sessions/route";
import { db } from "@/lib/db";
import { labelingSessions } from "@/lib/db/schema";
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

const list = (projectId?: string) =>
  GET(
    makeReq(
      `/api/labeling/sessions${projectId !== undefined ? `?projectId=${projectId}` : ""}`,
      { method: "GET" },
    ),
  );

/** Seed a labeling_sessions row directly (labeling/create is too heavy to go through). */
async function seedSession(projectId: number, companyId: number, over: Record<string, unknown> = {}) {
  const [row] = await db
    .insert(labelingSessions)
    .values({
      projectId,
      companyId,
      labelStudioProjectId: 90000 + Math.floor(Math.random() * 9999),
      labelStudioUrl: "http://ls.test/projects/90001",
      taskType: "generic",
      pageRange: "1-3",
      status: "active",
      ...over,
    })
    .returning();
  return row;
}

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
    const { user, project, company } = await createWorld();
    await seedSession(project.id, company.id);
    await seedSession(project.id, company.id, { taskType: "tiled", tilingEnabled: true, tileGrid: 3 });
    asUser(user);

    const { status, body } = await readJson(await list(project.publicId));
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true); // BARE array, not {sessions:[...]}
    expect(body).toHaveLength(2);
    for (const row of body) {
      expect(Object.keys(row).sort()).toEqual(WIRE_FIELDS); // exact key set — nothing extra leaks
      expect(typeof row.createdAt).toBe("string"); // Date → ISO on the wire
    }
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
    expect(body.error).toBe("projectId required"); // [P1.5 fold] → {code:"VALIDATION",message:"projectId required"}
  });

  it("signed-out → 401 (AUTH-FIRST: fires even with no projectId at all)", async () => {
    signedOut();
    const { status, body } = await readJson(await list());
    expect(status).toBe(401);
    expect(body.error).toBe("Unauthorized"); // [P1.5 fold] → {code:"UNAUTHORIZED",message:"Unauthorized"}
  });

  it("unknown (valid-uuid) projectId → 404 'Not found'", async () => {
    const { user } = await createWorld();
    asUser(user);
    const { status, body } = await readJson(await list(randomUUID()));
    expect(status).toBe(404);
    expect(body.error).toBe("Not found"); // [P1.5 fold] → {code:"NOT_FOUND",message:"Not found"}
  });

  it("cross-tenant member → 404, no existence leak", async () => {
    const { project } = await createWorld();
    asUser(await createUser((await createCompany()).id));
    const { status, body } = await readJson(await list(project.publicId));
    expect(status).toBe(404);
    expect(body.error).toBe("Not found"); // [P1.5 fold] → {code:"NOT_FOUND",message:"Not found"}
  });

  it("R1: ROOT ADMIN cross-company → 404 — the lookup has NO isRootAdmin bypass (frozen)", async () => {
    const { project } = await createWorld();
    asUser(await createUser((await createCompany()).id, { isRootAdmin: true }));
    const { status, body } = await readJson(await list(project.publicId));
    expect(status).toBe(404);
    expect(body.error).toBe("Not found"); // [P1.5 fold] → {code:"NOT_FOUND",message:"Not found"}
  });

  // [P1.5 fold] WHOLE assertion flips: legacy has no catch → the pg uuid-cast on a non-uuid
  // projectId REJECTS (raw framework 500 in prod, S003 class). Fold = clean 400 via zPublicId
  // (sanctioned diff C: {code:"VALIDATION",message:"Invalid project id"}).
  it("non-uuid projectId → legacy pg uuid-cast throw (frozen defensive form)", async () => {
    const { user } = await createWorld();
    asUser(user);
    await expect(list("not-a-uuid")).rejects.toThrow();
  });
});
