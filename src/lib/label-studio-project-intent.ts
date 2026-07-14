import { randomUUID } from "node:crypto";
import { and, eq, isNull, lt, lte, or, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  labelStudioProjectIntents,
  projectMutationLeases,
  projects,
} from "@/lib/db/schema";
import {
  deleteProject,
  findProjectsByExactDescription,
  type LabelStudioProviderBinding,
} from "@/lib/label-studio";
import { logger } from "@/lib/logger";
import {
  deleteIntentLabelStudioAssetGrants,
  revokeIntentLabelStudioAssetGrants,
} from "@/lib/label-studio-asset-grant";

const CLEANUP_LEASE_SECONDS = 15 * 60;
const EMPTY_SEARCH_RETRY_SECONDS = 60 * 60;
const MAX_RETRY_SECONDS = 24 * 60 * 60;
const MAX_ERROR_LENGTH = 4_000;

type IntentRow = typeof labelStudioProjectIntents.$inferSelect;
type TransactionCallback = Parameters<typeof db.transaction>[0];
type Transaction = Parameters<TransactionCallback>[0];
export type LabelStudioIntentResult = "cleaned" | "pending" | "unavailable";

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    MAX_ERROR_LENGTH,
  );
}

function providerBinding(row: IntentRow): LabelStudioProviderBinding {
  return {
    baseUrl: row.providerBaseUrl,
    instanceId: row.providerInstanceId,
  };
}

interface IntentCandidate {
  id: string;
  projectId: number;
}

async function claimCandidate(
  candidate: IntentCandidate,
): Promise<{ row: IntentRow; leaseToken: string } | null> {
  return db.transaction(async (tx) => {
    // Global workers use the same parent-first lock order as every user-facing project write.
    // The intent remains a publication/deletion blocker while provider I/O runs outside this tx.
    const [project] = await tx
      .select({
        id: projects.id,
        isDemo: projects.isDemo,
        lifecycleEpoch: projects.lifecycleEpoch,
      })
      .from(projects)
      .where(eq(projects.id, candidate.projectId))
      .for("update")
      .limit(1);
    if (!project) return null;

    const [activeMutation] = await tx
      .select({ token: projectMutationLeases.token })
      .from(projectMutationLeases)
      .where(
        and(
          eq(projectMutationLeases.projectId, candidate.projectId),
          eq(projectMutationLeases.status, "active"),
        ),
      )
      .limit(1);
    if (activeMutation) return null;

    const [current] = await tx
      .select()
      .from(labelStudioProjectIntents)
      .where(
        and(
          eq(labelStudioProjectIntents.id, candidate.id),
          eq(labelStudioProjectIntents.projectId, candidate.projectId),
          lte(labelStudioProjectIntents.nextAttemptAt, sql`CURRENT_TIMESTAMP`),
          or(
            isNull(labelStudioProjectIntents.leaseExpiresAt),
            lt(
              labelStudioProjectIntents.leaseExpiresAt,
              sql`CURRENT_TIMESTAMP`,
            ),
          ),
        ),
      )
      .for("update")
      .limit(1);
    if (!current) return null;
    if (project.isDemo || project.lifecycleEpoch !== current.lifecycleEpoch) {
      throw new Error("Label Studio cleanup intent project lifecycle changed");
    }

    const leaseToken = randomUUID();
    const [claimed] = await tx
      .update(labelStudioProjectIntents)
      .set({
        leaseToken,
        leaseExpiresAt: sql`CURRENT_TIMESTAMP + (${CLEANUP_LEASE_SECONDS} * INTERVAL '1 second')`,
        attemptCount: sql`${labelStudioProjectIntents.attemptCount} + 1`,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(
        and(
          eq(labelStudioProjectIntents.id, current.id),
          eq(labelStudioProjectIntents.projectId, current.projectId),
          eq(labelStudioProjectIntents.lifecycleEpoch, current.lifecycleEpoch),
          or(
            isNull(labelStudioProjectIntents.leaseExpiresAt),
            lt(
              labelStudioProjectIntents.leaseExpiresAt,
              sql`CURRENT_TIMESTAMP`,
            ),
          ),
        ),
      )
      .returning();
    if (!claimed)
      throw new Error("Failed to claim Label Studio cleanup intent");
    // Reconciliation performs provider I/O outside this transaction. Retire every bearer while
    // the parent is still locked so a provider timeout can never leave an imported task live.
    await revokeIntentLabelStudioAssetGrants(tx, claimed.id);
    return { row: claimed, leaseToken };
  });
}

async function claimIntent(
  id?: string,
): Promise<{ row: IntentRow; leaseToken: string } | null> {
  // This discovery read takes no row lock. Each candidate is revalidated after locking its parent,
  // which prevents both lock inversion and a stale discovery result from becoming authority.
  const candidates = await db
    .select({
      id: labelStudioProjectIntents.id,
      projectId: labelStudioProjectIntents.projectId,
    })
    .from(labelStudioProjectIntents)
    .leftJoin(
      projectMutationLeases,
      and(
        eq(
          projectMutationLeases.projectId,
          labelStudioProjectIntents.projectId,
        ),
        eq(projectMutationLeases.status, "active"),
      ),
    )
    .where(
      and(
        lte(labelStudioProjectIntents.nextAttemptAt, sql`CURRENT_TIMESTAMP`),
        or(
          isNull(labelStudioProjectIntents.leaseExpiresAt),
          lt(labelStudioProjectIntents.leaseExpiresAt, sql`CURRENT_TIMESTAMP`),
        ),
        isNull(projectMutationLeases.token),
        id ? eq(labelStudioProjectIntents.id, id) : undefined,
      ),
    )
    .orderBy(
      labelStudioProjectIntents.nextAttemptAt,
      labelStudioProjectIntents.id,
    )
    .limit(id ? 1 : 25);

  for (const candidate of candidates) {
    const claim = await claimCandidate(candidate);
    if (claim) return claim;
  }
  return null;
}

async function withLockedIntentProject<T>(
  row: IntentRow,
  write: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const [project] = await tx
      .select({
        isDemo: projects.isDemo,
        lifecycleEpoch: projects.lifecycleEpoch,
      })
      .from(projects)
      .where(eq(projects.id, row.projectId))
      .for("update")
      .limit(1);
    if (
      !project ||
      project.isDemo ||
      project.lifecycleEpoch !== row.lifecycleEpoch
    ) {
      throw new Error("Label Studio cleanup intent project lifecycle changed");
    }
    return write(tx);
  });
}

async function deleteClaimedIntent(
  row: IntentRow,
  leaseToken: string,
): Promise<void> {
  await withLockedIntentProject(row, async (tx) => {
    await deleteIntentLabelStudioAssetGrants(tx, row.id);
    const deleted = await tx
      .delete(labelStudioProjectIntents)
      .where(
        and(
          eq(labelStudioProjectIntents.id, row.id),
          eq(labelStudioProjectIntents.projectId, row.projectId),
          eq(labelStudioProjectIntents.lifecycleEpoch, row.lifecycleEpoch),
          eq(labelStudioProjectIntents.leaseToken, leaseToken),
        ),
      )
      .returning({ id: labelStudioProjectIntents.id });
    if (deleted.length !== 1) {
      throw new Error("Label Studio cleanup intent lease was lost");
    }
  });
}

async function rescheduleClaimedIntent(
  row: IntentRow,
  leaseToken: string,
  options: {
    state?: "create_uncertain" | "cleanup_pending";
    error?: unknown;
    delaySeconds: number;
  },
): Promise<void> {
  const failures = options.error ? row.consecutiveFailures + 1 : 0;
  await withLockedIntentProject(row, async (tx) => {
    const updated = await tx
      .update(labelStudioProjectIntents)
      .set({
        state: options.state ?? row.state,
        leaseToken: null,
        leaseExpiresAt: null,
        consecutiveFailures: failures,
        nextAttemptAt: sql`CURRENT_TIMESTAMP + (${options.delaySeconds} * INTERVAL '1 second')`,
        lastError: options.error ? errorMessage(options.error) : null,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(
        and(
          eq(labelStudioProjectIntents.id, row.id),
          eq(labelStudioProjectIntents.projectId, row.projectId),
          eq(labelStudioProjectIntents.lifecycleEpoch, row.lifecycleEpoch),
          eq(labelStudioProjectIntents.leaseToken, leaseToken),
        ),
      )
      .returning({ id: labelStudioProjectIntents.id });
    if (updated.length !== 1) {
      throw new Error("Label Studio cleanup intent lease was lost");
    }
  });
}

async function persistDiscoveredProviderIdentity(
  row: IntentRow,
  leaseToken: string,
  providerProjectId: number,
): Promise<IntentRow> {
  return withLockedIntentProject(row, async (tx) => {
    const [updated] = await tx
      .update(labelStudioProjectIntents)
      .set({
        providerProjectId,
        state: "cleanup_pending",
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(
        and(
          eq(labelStudioProjectIntents.id, row.id),
          eq(labelStudioProjectIntents.projectId, row.projectId),
          eq(labelStudioProjectIntents.lifecycleEpoch, row.lifecycleEpoch),
          eq(labelStudioProjectIntents.leaseToken, leaseToken),
          isNull(labelStudioProjectIntents.providerProjectId),
        ),
      )
      .returning();
    if (!updated) {
      throw new Error("Label Studio cleanup intent lease was lost");
    }
    return updated;
  });
}

/**
 * Reconcile one provider create whose application commit may have failed. No automatic retry ever
 * creates a second Label Studio project; marker search can only discover and delete exact matches.
 */
export async function reconcileLabelStudioProjectIntent(
  id?: string,
): Promise<LabelStudioIntentResult> {
  const claim = await claimIntent(id);
  if (!claim) return "unavailable";

  let durableRow = claim.row;
  try {
    const provider = providerBinding(durableRow);
    if (durableRow.providerProjectId !== null) {
      await deleteProject(provider, durableRow.providerProjectId);
      await deleteClaimedIntent(durableRow, claim.leaseToken);
      return "cleaned";
    }

    const matches = await findProjectsByExactDescription(
      provider,
      durableRow.marker,
    );
    if (matches.length === 0) {
      // Absence cannot prove a delayed/ambiguous POST did not commit. Retain the marker forever.
      await rescheduleClaimedIntent(durableRow, claim.leaseToken, {
        state: "create_uncertain",
        delaySeconds: EMPTY_SEARCH_RETRY_SECONDS,
      });
      return "pending";
    }

    // Automatic CREATE is never retried, so one exact marker has at most one legitimate owner.
    // Multiple matches are contradictory provider state and cannot be safely bulk-deleted.
    if (matches.length !== 1) {
      throw new Error(
        "Label Studio marker resolved to multiple provider projects",
      );
    }

    // Claim the discovered numeric identity under the cross-table database fence before provider
    // DELETE. A reused/misreported ID that belongs to any live session is quarantined here: no
    // imported task or provider project belonging to that session is ever touched.
    durableRow = await persistDiscoveredProviderIdentity(
      durableRow,
      claim.leaseToken,
      matches[0].id,
    );
    await deleteProject(provider, matches[0].id);
    await deleteClaimedIntent(durableRow, claim.leaseToken);
    return "cleaned";
  } catch (error) {
    const delaySeconds = Math.min(
      MAX_RETRY_SECONDS,
      30 * 2 ** Math.min(claim.row.consecutiveFailures, 12),
    );
    try {
      await rescheduleClaimedIntent(durableRow, claim.leaseToken, {
        state:
          durableRow.providerProjectId === null
            ? "create_uncertain"
            : "cleanup_pending",
        error,
        delaySeconds,
      });
    } catch (persistError) {
      logger.error(
        `[label-studio-intent] failed to persist retry state for ${claim.row.id}:`,
        persistError,
      );
    }
    throw error;
  }
}

export async function drainLabelStudioProjectIntentQueue(
  maxAttempts = 10,
): Promise<{ attempted: number; cleaned: number; failed: number }> {
  let attempted = 0;
  let cleaned = 0;
  let failed = 0;

  while (attempted < maxAttempts) {
    try {
      const result = await reconcileLabelStudioProjectIntent();
      if (result === "unavailable") break;
      attempted++;
      if (result === "cleaned") cleaned++;
    } catch (error) {
      attempted++;
      failed++;
      logger.error(
        "[label-studio-intent] reconciliation attempt failed:",
        error,
      );
    }
  }
  return { attempted, cleaned, failed };
}
