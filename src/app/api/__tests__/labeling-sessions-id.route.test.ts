// @vitest-environment node
// [refactor jul3 P1.5] CHARACTERIZATION for DELETE /api/labeling/sessions/[id], written as THE
// FREEZE before the P1.5 migration onto services/labeling.ts (no P0.3 file existed). Frozen:
//   • AUTH-FIRST requireAuth (401 before any lookup).
//   • lookup = and(eq(labelingSessions.id, parseInt(id)), eq(companyId, session.companyId)) —
//     DIRECT on the DENORMALIZED companyId column, NO project join, NO isRootAdmin bypass.
//     Root admin cross-company → 404 AND the row survives (R1 guard vs a future
//     resolveProjectOrThrow "simplification").
//   • parseInt(id) — NOT Number(): trailing garbage is TOLERATED ("999999abc" → 999999 → real
//     lookup → 404, never 500). Only a leading non-digit ("abc") yields NaN → pg int-cast throw.
//     Do NOT "upgrade" to Number() (would flip "5abc" from 404 to 500 — unsanctioned).
//   • Label Studio deletion is the external-authority retirement step. Failure is propagated and
//     the DB row remains as a fail-closed publication/project-deletion blocker.
//   • NaN id: legacy had no catch → pg int-cast THREW. Now the shell's leak-free INTERNAL 500
//     (qto/annotations/takeoff-items precedent — NOT a clean 400).
// Assertions tagged [P1.5 fold] were flipped in the fold commit (sanctioned diff A); the freeze
// form is at commit 025c9b7.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

// Mock the Label Studio client — tests never talk to a live LS. deleteProject is per-test
// controllable; the other exports exist so the fold-time service module (which also imports
// createProject/importTasks) loads under the same mock.
const lsMocks = vi.hoisted(() => {
  const binding = {
    baseUrl: "https://labels.test",
    instanceId: "session-delete-provider",
  } as const;
  return {
    binding,
    configuredLabelStudioProvider: vi.fn(() => binding),
    deleteProject: vi.fn(),
    createProject: vi.fn(),
    importTasks: vi.fn(),
    getProject: vi.fn(),
    healthCheck: vi.fn(),
  };
});
vi.mock("@/lib/label-studio", () => lsMocks);

import { DELETE } from "@/app/api/labeling/sessions/[id]/route";
import { db } from "@/lib/db";
import {
  labelingSessions,
  labelStudioAssetGrants,
  labelStudioProjectIntents,
  projects,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  asUser,
  createCompany,
  createUser,
  createWorld,
  makeReq,
  params,
  publishDemoFixture,
  readJson,
  signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

const del = (id: number | string) =>
  DELETE(
    makeReq(`/api/labeling/sessions/${id}`, { method: "DELETE" }),
    params({ id: String(id) }),
  );

async function seedSession(projectId: number, companyId: number) {
  return db.transaction(async (tx) => {
    const [project] = await tx
      .select({ lifecycleEpoch: projects.lifecycleEpoch })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project) throw new Error("Missing project fixture");

    const intentId = randomUUID();
    const grantId = randomUUID();
    const labelStudioProjectId = 80000 + Math.floor(Math.random() * 9999);
    await tx.insert(labelStudioProjectIntents).values({
      id: intentId,
      projectId,
      companyId,
      lifecycleEpoch: project.lifecycleEpoch,
      marker: `bp-labeling-intent:${intentId}`,
      providerProjectId: labelStudioProjectId,
      providerBaseUrl: lsMocks.binding.baseUrl,
      providerInstanceId: lsMocks.binding.instanceId,
      state: "cleanup_pending",
    });
    const [row] = await tx
      .insert(labelingSessions)
      .values({
        projectId,
        companyId,
        labelStudioProjectId,
        providerBaseUrl: lsMocks.binding.baseUrl,
        providerInstanceId: lsMocks.binding.instanceId,
        labelStudioUrl: `http://ls.test/projects/${labelStudioProjectId}`,
        taskType: "generic",
        pageRange: "1-3",
        status: "active",
        provisioningIntentId: intentId,
      })
      .returning();
    await tx.insert(labelStudioAssetGrants).values({
      id: grantId,
      projectId,
      companyId,
      lifecycleEpoch: project.lifecycleEpoch,
      provisioningIntentId: intentId,
      tokenHash: randomUUID().replaceAll("-", "").repeat(2),
      snapshotVersionId: `snapshot-${grantId}`,
      state: "provisioning",
    });
    await tx
      .update(labelStudioAssetGrants)
      .set({
        provisioningIntentId: null,
        labelingSessionId: row.id,
        state: "active",
      })
      .where(eq(labelStudioAssetGrants.id, grantId));
    await tx
      .delete(labelStudioProjectIntents)
      .where(eq(labelStudioProjectIntents.id, intentId));
    return { ...row, grantId };
  });
}

const rowById = (id: number) =>
  db.select().from(labelingSessions).where(eq(labelingSessions.id, id));

const grantsBySessionId = (id: number) =>
  db
    .select()
    .from(labelStudioAssetGrants)
    .where(eq(labelStudioAssetGrants.labelingSessionId, id));

beforeEach(() => {
  vi.clearAllMocks();
});

describe.skipIf(!dbUp)("DELETE /api/labeling/sessions/[id]", () => {
  it("commits retiring + revoked before provider DELETE, then removes both recovery witnesses", async () => {
    const { user, project, company } = await createWorld();
    const session = await seedSession(project.id, company.id);
    asUser(user);
    let providerWitness:
      | {
          status: string | undefined;
          grantState: string | undefined;
          revokedAt: Date | null | undefined;
        }
      | undefined;
    lsMocks.deleteProject.mockImplementationOnce(async () => {
      const [owner] = await rowById(session.id);
      const [grant] = await grantsBySessionId(session.id);
      providerWitness = {
        status: owner?.status,
        grantState: grant?.state,
        revokedAt: grant?.revokedAt,
      };
    });

    const { status, body } = await readJson(await del(session.id));
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(providerWitness).toEqual({
      status: "retiring",
      grantState: "revoked",
      revokedAt: expect.any(Date),
    });
    expect(await rowById(session.id)).toHaveLength(0);
    expect(await grantsBySessionId(session.id)).toHaveLength(0);
    expect(lsMocks.deleteProject).toHaveBeenCalledExactlyOnceWith(
      lsMocks.binding,
      session.labelStudioProjectId,
    );
  });

  it("provider failure retains retiring/revoked witnesses; retry after idempotent 404 removes both", async () => {
    const { user, project, company } = await createWorld();
    const session = await seedSession(project.id, company.id);
    asUser(user);
    let failureWitness:
      | {
          status: string | undefined;
          grantState: string | undefined;
          revokedAt: Date | null | undefined;
        }
      | undefined;
    lsMocks.deleteProject.mockImplementationOnce(async () => {
      const [owner] = await rowById(session.id);
      const [grant] = await grantsBySessionId(session.id);
      failureWitness = {
        status: owner?.status,
        grantState: grant?.state,
        revokedAt: grant?.revokedAt,
      };
      throw new Error("LS down");
    });

    const { status, body } = await readJson(await del(session.id));
    expect(status).toBe(500);
    expect(body.error).toEqual({
      code: "INTERNAL",
      message: "Internal server error",
    });
    expect(failureWitness).toEqual({
      status: "retiring",
      grantState: "revoked",
      revokedAt: expect.any(Date),
    });
    expect(await rowById(session.id)).toEqual([
      expect.objectContaining({ id: session.id, status: "retiring" }),
    ]);
    expect(await grantsBySessionId(session.id)).toEqual([
      expect.objectContaining({
        id: session.grantId,
        state: "revoked",
        revokedAt: expect.any(Date),
      }),
    ]);

    // deleteProject resolves both an ordinary success and Label Studio's 404 response. Retrying
    // the durable witness therefore finishes local cleanup after an ambiguous first provider call.
    lsMocks.deleteProject.mockResolvedValueOnce(undefined);
    const retry = await readJson(await del(session.id));
    expect(retry).toEqual({ status: 200, body: { success: true } });
    expect(await rowById(session.id)).toHaveLength(0);
    expect(await grantsBySessionId(session.id)).toHaveLength(0);
    expect(lsMocks.deleteProject).toHaveBeenCalledTimes(2);
    expect(lsMocks.deleteProject).toHaveBeenLastCalledWith(
      lsMocks.binding,
      session.labelStudioProjectId,
    );
  });

  it("missing id → 404 'Not found'", async () => {
    const { user } = await createWorld();
    asUser(user);
    const { status, body } = await readJson(await del(999999));
    expect(status).toBe(404);
    expect(body.error).toEqual({ code: "NOT_FOUND", message: "Not found" }); // [P1.5 fold] flipped (legacy: bare "Not found")
  });

  it("signed-out → 401 (AUTH-FIRST)", async () => {
    const { project, company } = await createWorld();
    const session = await seedSession(project.id, company.id);
    signedOut();
    const { status, body } = await readJson(await del(session.id));
    expect(status).toBe(401);
    expect(body.error).toEqual({
      code: "UNAUTHORIZED",
      message: "Unauthorized",
    }); // [P1.5 fold] flipped (legacy: bare string)
    expect(await rowById(session.id)).toHaveLength(1); // untouched
  });

  it("prevents a live session from being published into an undeletable demo state", async () => {
    const { company, project } = await createWorld();
    const session = await seedSession(project.id, company.id);

    await expect(publishDemoFixture(project.id)).rejects.toMatchObject({
      cause: {
        code: "P0001",
        constraint: "label_studio_publication_guard",
      },
    });

    expect.soft(lsMocks.deleteProject).not.toHaveBeenCalled();
    expect.soft(await rowById(session.id)).toHaveLength(1);
  });

  it("R1: ROOT ADMIN cross-company → 404 AND the row survives (NO bypass on the companyId-scoped lookup)", async () => {
    const { project, company } = await createWorld();
    const session = await seedSession(project.id, company.id);
    asUser(await createUser((await createCompany()).id, { isRootAdmin: true }));

    const { status, body } = await readJson(await del(session.id));
    expect(status).toBe(404);
    expect(body.error).toEqual({ code: "NOT_FOUND", message: "Not found" }); // [P1.5 fold] flipped (legacy: bare "Not found")
    expect(await rowById(session.id)).toHaveLength(1); // NOT deleted — no cross-company reach
  });

  it("trailing-garbage id '<n>abc' → parseInt tolerance → 404 (frozen: parseInt NOT Number — never a 500)", async () => {
    const { user } = await createWorld();
    asUser(user);
    const { status, body } = await readJson(await del("999999abc")); // parseInt → 999999 → no row
    expect(status).toBe(404);
    expect(body.error).toEqual({ code: "NOT_FOUND", message: "Not found" }); // [P1.5 fold] flipped (legacy: bare "Not found")
  });

  // [P1.5 fold, DETECTOR closer E2] inherited P1.1 shell semantics: DELETE is in the shell's
  // METHODS_WITH_BODY, so a NON-EMPTY malformed-JSON body 400s at parse (step 1) BEFORE auth
  // (step 2) — legacy never read the body. Sanctioned via the annotation-groups diff-6 /
  // projects diff-4 class; pinned here so the precedence is frozen. Empty body is unaffected.
  it("DELETE with a malformed-JSON body → 400 BAD_REQUEST, fired BEFORE the 401 (shell E2)", async () => {
    signedOut(); // proves the 400 precedes auth
    const res = await DELETE(
      new Request("http://test.local/api/labeling/sessions/1", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
      params({ id: "1" }),
    );
    const { status, body } = await readJson(res);
    expect(status).toBe(400); // NOT 401
    expect(body.error).toEqual({
      code: "BAD_REQUEST",
      message: "Invalid JSON body",
    });
  });

  // [P1.5 fold] WHOLE assertion flipped: parseInt("abc") = NaN → pg int-cast throw (frozen at
  // 025c9b7 as .rejects.toThrow(); raw framework 500 in prod). Now the shell's deterministic
  // leak-free INTERNAL 500 (frozen at 500 — NOT diff-D'd to a 400; qto-workflows/[id] precedent).
  it("non-numeric id → 500 leak-free INTERNAL on the NaN pg-cast (frozen at 500, not 400)", async () => {
    const { user } = await createWorld();
    asUser(user);
    const { status, body } = await readJson(await del("abc"));
    expect(status).toBe(500);
    expect(body.error).toEqual({
      code: "INTERNAL",
      message: "Internal server error",
    });
  });
});
