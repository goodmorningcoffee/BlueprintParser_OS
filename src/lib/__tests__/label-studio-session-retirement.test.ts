// @vitest-environment node

import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { Pool, type PoolClient } from "pg";
import { beforeEach, describe, expect, inject, it, vi } from "vitest";

const boundaries = vi.hoisted(() => ({
  deleteProject: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

vi.mock("@/lib/label-studio", () => ({
  deleteProject: boundaries.deleteProject,
}));

vi.mock("@/lib/logger", () => ({
  logger: { error: boundaries.loggerError },
}));

import { db } from "@/lib/db";
import {
  labelingSessions,
  labelStudioAssetGrants,
  labelStudioProjectIntents,
  projectMutationLeases,
} from "@/lib/db/schema";
import {
  drainLabelStudioSessionRetirementQueue,
  reconcileLabelStudioSessionRetirement,
} from "@/lib/label-studio-session-retirement";
import { revokeSessionLabelStudioAssetGrants } from "@/lib/label-studio-asset-grant";
import { createWorld } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;
const PROVIDER_BASE_URL = "https://labels.test";
const PROVIDER_INSTANCE_ID = "fs-label-studio-retirement-test";
const PROVIDER_BINDING = {
  baseUrl: PROVIDER_BASE_URL,
  instanceId: PROVIDER_INSTANCE_ID,
} as const;

interface SeedOverrides {
  retirementNextAttemptAt?: Date;
  retirementLease?: {
    token: string;
    expiresAfterMilliseconds: number;
    waitForExpiry?: boolean;
  };
}

async function seedRetirement(overrides: SeedOverrides = {}) {
  const { company, project } = await createWorld();
  const intentId = randomUUID();
  const grantId = randomUUID();
  const providerProjectId = 1_000_000 + project.id;

  const session = await db.transaction(async (tx) => {
    await tx.insert(labelStudioProjectIntents).values({
      id: intentId,
      projectId: project.id,
      companyId: company.id,
      lifecycleEpoch: project.lifecycleEpoch,
      marker: `bp-labeling-intent:${intentId}`,
      providerProjectId,
      providerBaseUrl: PROVIDER_BASE_URL,
      providerInstanceId: PROVIDER_INSTANCE_ID,
      state: "cleanup_pending",
    });
    const [created] = await tx
      .insert(labelingSessions)
      .values({
        projectId: project.id,
        companyId: company.id,
        labelStudioProjectId: providerProjectId,
        providerBaseUrl: PROVIDER_BASE_URL,
        providerInstanceId: PROVIDER_INSTANCE_ID,
        labelStudioUrl: `https://labels.test/projects/${providerProjectId}`,
        taskType: "generic",
        status: "active",
        provisioningIntentId: intentId,
      })
      .returning();
    await tx.insert(labelStudioAssetGrants).values({
      id: grantId,
      projectId: project.id,
      companyId: company.id,
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
        labelingSessionId: created.id,
        state: "active",
      })
      .where(eq(labelStudioAssetGrants.id, grantId));
    await tx
      .delete(labelStudioProjectIntents)
      .where(eq(labelStudioProjectIntents.id, intentId));
    await tx
      .update(labelingSessions)
      .set({
        status: "retiring",
        retirementNextAttemptAt:
          overrides.retirementNextAttemptAt ?? new Date(0),
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(labelingSessions.id, created.id));
    return created;
  });

  if (overrides.retirementLease) {
    const lease = overrides.retirementLease;
    const [claimed] = await db.transaction(async (tx) => {
      await revokeSessionLabelStudioAssetGrants(tx, session.id);
      return tx
        .update(labelingSessions)
        .set({
          retirementLeaseToken: lease.token,
          retirementLeaseExpiresAt: sql`CURRENT_TIMESTAMP + (${lease.expiresAfterMilliseconds} * INTERVAL '1 millisecond')`,
          retirementAttemptCount: sql`${labelingSessions.retirementAttemptCount} + 1`,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(eq(labelingSessions.id, session.id))
        .returning({ expiresAt: labelingSessions.retirementLeaseExpiresAt });
    });
    if (!claimed?.expiresAt) throw new Error("Failed to seed retirement lease");
    if (lease.waitForExpiry) {
      const remaining = claimed.expiresAt.getTime() - Date.now();
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, remaining) + 50),
      );
    }
  }

  return { company, project, session, grantId, providerProjectId };
}

async function sessionById(id: number) {
  const [session] = await db
    .select()
    .from(labelingSessions)
    .where(eq(labelingSessions.id, id));
  return session;
}

function grantsBySessionId(id: number) {
  return db
    .select()
    .from(labelStudioAssetGrants)
    .where(eq(labelStudioAssetGrants.labelingSessionId, id));
}

async function waitForTransactionWaiter(
  client: PoolClient,
  blockingTransactionId: string,
): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await client.query<{ pid: number }>(
      `SELECT pid
         FROM pg_locks
        WHERE locktype = 'transactionid'
          AND transactionid::text = $1
          AND granted = false
        LIMIT 1`,
      [blockingTransactionId],
    );
    if (result.rows[0]) return result.rows[0].pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for retirement to reach the session lock");
}

beforeEach(() => {
  boundaries.deleteProject.mockReset();
  boundaries.loggerError.mockReset();
});

describe.skipIf(!dbUp)("durable Label Studio session retirement", () => {
  it("claims parent-first before waiting on the session child row", async () => {
    const seeded = await seedRetirement();
    boundaries.deleteProject.mockResolvedValueOnce(undefined);
    const blockerPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
    });
    const probePool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
    });
    const blocker = await blockerPool.connect();
    let blockerReleased = false;
    let reconciliation: Promise<unknown> | undefined;
    let operationError: unknown;

    try {
      await blocker.query("BEGIN");
      const xid = await blocker.query<{ xid: string }>(
        "SELECT txid_current()::text AS xid",
      );
      await blocker.query(
        "SELECT 1 FROM labeling_sessions WHERE id = $1 FOR UPDATE",
        [seeded.session.id],
      );

      reconciliation = reconcileLabelStudioSessionRetirement(seeded.session.id);
      void reconciliation.catch(() => undefined);
      await waitForTransactionWaiter(blocker, xid.rows[0].xid);

      await expect(
        probePool.query(
          "SELECT 1 FROM projects WHERE id = $1 FOR UPDATE NOWAIT",
          [seeded.project.id],
        ),
      ).rejects.toMatchObject({ code: "55P03" });
    } catch (error) {
      operationError = error;
    } finally {
      await blocker.query("COMMIT").catch(async () => {
        await blocker.query("ROLLBACK").catch(() => undefined);
      });
      blockerReleased = true;
      blocker.release();
      await blockerPool.end();
      await probePool.end();
    }

    expect(blockerReleased).toBe(true);
    if (operationError) {
      await Promise.allSettled(reconciliation ? [reconciliation] : []);
      throw operationError;
    }
    await expect(reconciliation).resolves.toBe("cleaned");
    expect(boundaries.deleteProject).toHaveBeenCalledExactlyOnceWith(
      PROVIDER_BINDING,
      seeded.providerProjectId,
    );
  }, 15_000);

  it("commits revoked grants and a fenced lease before provider I/O, then cleans both witnesses", async () => {
    const seeded = await seedRetirement();
    let providerWitness:
      | {
          status: string | undefined;
          attemptCount: number | undefined;
          leased: boolean;
          grantState: string | undefined;
          revokedAt: Date | null | undefined;
        }
      | undefined;
    boundaries.deleteProject.mockImplementationOnce(async () => {
      const [session, grants] = await Promise.all([
        sessionById(seeded.session.id),
        grantsBySessionId(seeded.session.id),
      ]);
      providerWitness = {
        status: session?.status,
        attemptCount: session?.retirementAttemptCount,
        leased:
          session?.retirementLeaseToken !== null &&
          session?.retirementLeaseExpiresAt !== null,
        grantState: grants[0]?.state,
        revokedAt: grants[0]?.revokedAt,
      };
    });

    await expect(
      reconcileLabelStudioSessionRetirement(seeded.session.id),
    ).resolves.toBe("cleaned");

    expect(providerWitness).toEqual({
      status: "retiring",
      attemptCount: 1,
      leased: true,
      grantState: "revoked",
      revokedAt: expect.any(Date),
    });
    expect(boundaries.deleteProject).toHaveBeenCalledExactlyOnceWith(
      PROVIDER_BINDING,
      seeded.providerProjectId,
    );
    expect(await sessionById(seeded.session.id)).toBeUndefined();
    expect(await grantsBySessionId(seeded.session.id)).toHaveLength(0);
  });

  it("finishes local cleanup when the provider client normalizes an idempotent 404 to success", async () => {
    const seeded = await seedRetirement();
    // deleteProject's boundary contract resolves both DELETE success and provider 404.
    boundaries.deleteProject.mockResolvedValueOnce(undefined);

    await expect(
      reconcileLabelStudioSessionRetirement(seeded.session.id),
    ).resolves.toBe("cleaned");

    expect(await sessionById(seeded.session.id)).toBeUndefined();
    expect(await grantsBySessionId(seeded.session.id)).toHaveLength(0);
  });

  it("retains revoked grants, clears the lease, and applies bounded backoff after provider failure", async () => {
    const seeded = await seedRetirement();
    const providerError = new Error("provider timeout after ambiguous DELETE");
    boundaries.deleteProject.mockImplementationOnce(async () => {
      const grants = await grantsBySessionId(seeded.session.id);
      expect(grants).toEqual([
        expect.objectContaining({
          state: "revoked",
          revokedAt: expect.any(Date),
        }),
      ]);
      throw providerError;
    });
    const failedAfter = Date.now();

    await expect(
      reconcileLabelStudioSessionRetirement(seeded.session.id),
    ).rejects.toBe(providerError);

    const failed = await sessionById(seeded.session.id);
    const observedAfter = Date.now();
    expect(failed).toEqual(
      expect.objectContaining({
        status: "retiring",
        retirementAttemptCount: 1,
        retirementConsecutiveFailures: 1,
        retirementLeaseToken: null,
        retirementLeaseExpiresAt: null,
        retirementLastError: "provider timeout after ambiguous DELETE",
      }),
    );
    expect(failed!.retirementNextAttemptAt.getTime()).toBeGreaterThanOrEqual(
      failedAfter + 25_000,
    );
    expect(failed!.retirementNextAttemptAt.getTime()).toBeLessThanOrEqual(
      observedAfter + 35_000,
    );
    expect(await grantsBySessionId(seeded.session.id)).toEqual([
      expect.objectContaining({
        id: seeded.grantId,
        state: "revoked",
        revokedAt: expect.any(Date),
      }),
    ]);
  });

  it("excludes a live retirement lease without mutating its revoked grants or calling the provider", async () => {
    const leaseToken = randomUUID();
    const seeded = await seedRetirement({
      retirementLease: {
        token: leaseToken,
        expiresAfterMilliseconds: 60_000,
      },
    });

    await expect(
      reconcileLabelStudioSessionRetirement(seeded.session.id),
    ).resolves.toBe("unavailable");

    expect(boundaries.deleteProject).not.toHaveBeenCalled();
    expect(await sessionById(seeded.session.id)).toEqual(
      expect.objectContaining({
        retirementAttemptCount: 1,
        retirementLeaseToken: leaseToken,
        retirementLeaseExpiresAt: expect.any(Date),
      }),
    );
    expect(await grantsBySessionId(seeded.session.id)).toEqual([
      expect.objectContaining({
        state: "revoked",
        revokedAt: expect.any(Date),
      }),
    ]);
  });

  it("reclaims an expired retirement lease with a new fence", async () => {
    const expiredToken = randomUUID();
    const seeded = await seedRetirement({
      retirementLease: {
        token: expiredToken,
        expiresAfterMilliseconds: 25,
        waitForExpiry: true,
      },
    });
    let reclaimed:
      | {
          token: string | null | undefined;
          expiresAt: Date | null | undefined;
          attempts: number | undefined;
          grantState: string | undefined;
        }
      | undefined;
    boundaries.deleteProject.mockImplementationOnce(async () => {
      const [session, grants] = await Promise.all([
        sessionById(seeded.session.id),
        grantsBySessionId(seeded.session.id),
      ]);
      reclaimed = {
        token: session?.retirementLeaseToken,
        expiresAt: session?.retirementLeaseExpiresAt,
        attempts: session?.retirementAttemptCount,
        grantState: grants[0]?.state,
      };
    });

    await expect(
      reconcileLabelStudioSessionRetirement(seeded.session.id),
    ).resolves.toBe("cleaned");

    expect(reclaimed).toEqual({
      token: expect.any(String),
      expiresAt: expect.any(Date),
      attempts: 2,
      grantState: "revoked",
    });
    expect(reclaimed!.token).not.toBe(expiredToken);
    expect(reclaimed!.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("rejects forged and replaced live retirement leases", async () => {
    const unleased = await seedRetirement();
    await expect(
      db
        .update(labelingSessions)
        .set({
          retirementLeaseToken: randomUUID(),
          retirementLeaseExpiresAt: new Date(Date.now() + 60_000),
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(eq(labelingSessions.id, unleased.session.id)),
    ).rejects.toBeDefined();

    const leased = await seedRetirement({
      retirementLease: {
        token: randomUUID(),
        expiresAfterMilliseconds: 60_000,
      },
    });
    await expect(
      db
        .update(labelingSessions)
        .set({
          retirementLeaseToken: randomUUID(),
          retirementLeaseExpiresAt: new Date(Date.now() + 60_000),
          retirementAttemptCount: sql`${labelingSessions.retirementAttemptCount} + 1`,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(eq(labelingSessions.id, leased.session.id)),
    ).rejects.toBeDefined();
  });

  it("rejects clearing a live lease or resetting its attempt counter", async () => {
    const seeded = await seedRetirement({
      retirementLease: {
        token: randomUUID(),
        expiresAfterMilliseconds: 60_000,
      },
    });

    await expect(
      db
        .update(labelingSessions)
        .set({
          retirementLeaseToken: null,
          retirementLeaseExpiresAt: null,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(eq(labelingSessions.id, seeded.session.id)),
    ).rejects.toBeDefined();
    await expect(
      db
        .update(labelingSessions)
        .set({
          retirementAttemptCount: 0,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(eq(labelingSessions.id, seeded.session.id)),
    ).rejects.toBeDefined();
  });

  it("rejects arbitrary retiring-session mutation and unleased deletion", async () => {
    const seeded = await seedRetirement();
    await expect(
      db
        .update(labelingSessions)
        .set({
          retirementNextAttemptAt: new Date(Date.now() + 60_000),
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(eq(labelingSessions.id, seeded.session.id)),
    ).rejects.toBeDefined();
    await expect(
      db
        .update(labelingSessions)
        .set({
          labelStudioUrl: "https://labels.test/projects/forged",
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(eq(labelingSessions.id, seeded.session.id)),
    ).rejects.toBeDefined();
    await expect(
      db
        .delete(labelingSessions)
        .where(eq(labelingSessions.id, seeded.session.id)),
    ).rejects.toBeDefined();
  });

  it("excludes a due retirement while any active project mutation exists", async () => {
    const seeded = await seedRetirement();
    const mutationToken = randomUUID();
    await db.insert(projectMutationLeases).values({
      token: mutationToken,
      projectId: seeded.project.id,
      lifecycleEpoch: seeded.project.lifecycleEpoch,
      kind: "retirement-exclusion-test",
      status: "active",
      // Project mutation expiry is diagnostic; status remains the authority.
      expiresAt: new Date(0),
    });

    await expect(
      reconcileLabelStudioSessionRetirement(seeded.session.id),
    ).resolves.toBe("unavailable");

    expect(boundaries.deleteProject).not.toHaveBeenCalled();
    expect(await sessionById(seeded.session.id)).toEqual(
      expect.objectContaining({
        retirementAttemptCount: 0,
        retirementLeaseToken: null,
      }),
    );
    expect(await grantsBySessionId(seeded.session.id)).toEqual([
      expect.objectContaining({ state: "active", revokedAt: null }),
    ]);
  });

  it("reports attempted, cleaned, and failed queue counts", async () => {
    // These two rows sort strictly ahead of every ordinary fixture (which uses epoch 0), and
    // the bounded drain stops after them even if another Vitest file creates a due row between
    // their insertion and this assertion.
    const failed = await seedRetirement({
      retirementNextAttemptAt: new Date("1900-01-01T00:00:00.000Z"),
    });
    const cleaned = await seedRetirement({
      retirementNextAttemptAt: new Date("1900-01-02T00:00:00.000Z"),
    });
    const providerError = new Error("queue provider outage");
    boundaries.deleteProject.mockImplementation(
      async (_, providerProjectId) => {
        if (providerProjectId === failed.providerProjectId) throw providerError;
        if (providerProjectId === cleaned.providerProjectId) return undefined;
        throw new Error(`Unexpected provider project ${providerProjectId}`);
      },
    );

    await expect(drainLabelStudioSessionRetirementQueue(2)).resolves.toEqual({
      attempted: 2,
      cleaned: 1,
      failed: 1,
    });

    expect(boundaries.deleteProject.mock.calls).toEqual([
      [PROVIDER_BINDING, failed.providerProjectId],
      [PROVIDER_BINDING, cleaned.providerProjectId],
    ]);
    expect(boundaries.loggerError).toHaveBeenCalledExactlyOnceWith(
      "[label-studio-retirement] reconciliation attempt failed:",
      providerError,
    );
    expect(await sessionById(failed.session.id)).toEqual(
      expect.objectContaining({
        retirementConsecutiveFailures: 1,
        retirementLeaseToken: null,
      }),
    );
    expect(await sessionById(cleaned.session.id)).toBeUndefined();
  });
});
