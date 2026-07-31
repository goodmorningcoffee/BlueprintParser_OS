import { randomUUID } from "node:crypto";
import { and, eq, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";

import { ensureProjectCloudFrontInvalidation } from "@/lib/cloudfront";
import { db } from "@/lib/db";
import { projectAssetDeletions } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import {
  deleteProjectFiles,
  deleteProjectStagingFiles,
  type S3PrefixPurgeResult,
} from "@/lib/s3";

const DELETION_LEASE_SECONDS = 15 * 60;
const INVALIDATION_POLL_SECONDS = 60;
const HOT_WATCH_SECONDS = 60 * 60;
const COLD_WATCH_SECONDS = 24 * 60 * 60;
const HOT_WATCH_DAYS = 7;
/** Units conversion, NOT a sweep cadence. Kept separate from COLD_WATCH_SECONDS so that
 *  retuning the cold sweep cannot silently resize the 7-day hot-watch window. */
const SECONDS_PER_DAY = 24 * 60 * 60;
const MAX_RETRY_SECONDS = 24 * 60 * 60;
const ATTENTION_FAILURE_COUNT = 12;
const MAX_PHASE_TRANSITIONS_PER_ATTEMPT = 8;
const MAX_ERROR_LENGTH = 4_000;

type DeletionRow = typeof projectAssetDeletions.$inferSelect;
type TimestampUpdate = Date | null | SQL;
interface DeletionUpdate {
  status?: string | SQL;
  phase?: string | SQL;
  consecutiveFailures?: number | SQL;
  nextAttemptAt?: Date | SQL;
  leaseToken?: string | null;
  leaseExpiresAt?: TimestampUpdate;
  s3PurgedAt?: TimestampUpdate;
  invalidationGeneration?: number | SQL;
  lastReconciledEventGeneration?: number | SQL;
  cloudfrontInvalidationId?: string | null;
  lastError?: string | null;
  lastVerifiedAt?: TimestampUpdate;
  attentionRequiredAt?: TimestampUpdate;
  completedAt?: TimestampUpdate;
}

export type ProjectAssetDeletionResult =
  "reconciled" | "pending" | "unavailable";

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    MAX_ERROR_LENGTH,
  );
}

async function claimProjectAssetDeletion(
  id?: string,
): Promise<{ row: DeletionRow; leaseToken: string } | null> {
  return db.transaction(async (tx) => {
    const due = and(
      or(
        eq(projectAssetDeletions.status, "pending"),
        eq(projectAssetDeletions.status, "watching"),
      ),
      lte(projectAssetDeletions.nextAttemptAt, sql`CURRENT_TIMESTAMP`),
      or(
        isNull(projectAssetDeletions.leaseExpiresAt),
        lt(projectAssetDeletions.leaseExpiresAt, sql`CURRENT_TIMESTAMP`),
      ),
      id ? eq(projectAssetDeletions.id, id) : undefined,
    );
    const [candidate] = await tx
      .select()
      .from(projectAssetDeletions)
      .where(due)
      .orderBy(projectAssetDeletions.nextAttemptAt, projectAssetDeletions.id)
      .for("update", { skipLocked: true })
      .limit(1);
    if (!candidate) return null;

    const leaseToken = randomUUID();
    const [claimed] = await tx
      .update(projectAssetDeletions)
      .set({
        leaseToken,
        leaseExpiresAt: sql`CURRENT_TIMESTAMP + (${DELETION_LEASE_SECONDS} * INTERVAL '1 second')`,
        attemptCount: sql`${projectAssetDeletions.attemptCount} + 1`,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(projectAssetDeletions.id, candidate.id))
      .returning();
    if (!claimed) throw new Error("Failed to claim project asset deletion");
    return { row: claimed, leaseToken };
  });
}

async function updateClaimedDeletion(
  id: string,
  leaseToken: string,
  values: DeletionUpdate,
  expectedObjectEventGeneration?: number,
): Promise<DeletionRow> {
  const [updated] = await db
    .update(projectAssetDeletions)
    .set({ ...values, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(
      and(
        eq(projectAssetDeletions.id, id),
        or(
          eq(projectAssetDeletions.status, "pending"),
          eq(projectAssetDeletions.status, "watching"),
        ),
        eq(projectAssetDeletions.leaseToken, leaseToken),
        expectedObjectEventGeneration === undefined
          ? undefined
          : eq(
              projectAssetDeletions.objectEventGeneration,
              expectedObjectEventGeneration,
            ),
      ),
    )
    .returning();
  if (!updated) throw new Error("Project asset deletion lease was lost");
  return updated;
}

async function purgeBothPrefixes(
  storageRoot: string,
  onFinalObjectsFound?: () => Promise<void>,
): Promise<{
  final: S3PrefixPurgeResult;
  staging: S3PrefixPurgeResult;
}> {
  const results = await Promise.allSettled([
    deleteProjectFiles(storageRoot, {
      onObjectsFound: onFinalObjectsFound,
    }),
    deleteProjectStagingFiles(storageRoot),
  ]);
  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      `Project asset purge failed for ${failures.length} prefix(es)`,
    );
  }
  return {
    final: (results[0] as PromiseFulfilledResult<S3PrefixPurgeResult>).value,
    staging: (results[1] as PromiseFulfilledResult<S3PrefixPurgeResult>).value,
  };
}

function watchDelaySeconds(row: DeletionRow): number | null {
  const ageMs = Date.now() - row.createdAt.getTime();
  if (ageMs < HOT_WATCH_DAYS * SECONDS_PER_DAY * 1_000) {
    return HOT_WATCH_SECONDS;
  }
  // Terminalize only when durable ObjectCreated delivery can reopen the permanent tombstone.
  // Self-hosted/misconfigured deployments fail closed by retaining a daily cold sweep.
  return process.env.PROJECT_ASSET_EVENT_QUEUE_URL ? null : COLD_WATCH_SECONDS;
}

/**
 * Run one leased, idempotent state-machine attempt. Tombstones poll for seven days, then terminalize
 * only when durable ObjectCreated events can reopen them; otherwise they retain a daily cold sweep.
 */
export async function reconcileProjectAssetDeletion(
  id?: string,
): Promise<ProjectAssetDeletionResult> {
  const claim = await claimProjectAssetDeletion(id);
  if (!claim) return "unavailable";

  let row = claim.row;
  try {
    for (
      let transition = 0;
      transition < MAX_PHASE_TRANSITIONS_PER_ATTEMPT;
      transition++
    ) {
      if (row.phase === "purge") {
        await purgeBothPrefixes(row.storageRoot);
        row = await updateClaimedDeletion(row.id, claim.leaseToken, {
          phase: "invalidate",
          s3PurgedAt: sql`CURRENT_TIMESTAMP`,
          consecutiveFailures: 0,
          lastError: null,
        });
        continue;
      }

      if (row.phase === "invalidate") {
        const invalidation = await ensureProjectCloudFrontInvalidation(
          row.storageRoot,
          `bp-project-delete:${row.id}:${row.invalidationGeneration}`,
          row.cloudfrontInvalidationId,
        );
        if (!invalidation.complete) {
          await updateClaimedDeletion(row.id, claim.leaseToken, {
            cloudfrontInvalidationId: invalidation.id,
            leaseToken: null,
            leaseExpiresAt: null,
            nextAttemptAt: sql`CURRENT_TIMESTAMP + (${INVALIDATION_POLL_SECONDS} * INTERVAL '1 second')`,
            consecutiveFailures: 0,
            lastError: null,
          }, row.objectEventGeneration);
          return "pending";
        }
        row = await updateClaimedDeletion(row.id, claim.leaseToken, {
          phase: "verify",
          cloudfrontInvalidationId: invalidation.id,
          consecutiveFailures: 0,
          lastError: null,
        });
        continue;
      }

      if (row.phase === "verify" || row.phase === "watch") {
        let lateFinalRow: DeletionRow | null = null;
        await purgeBothPrefixes(row.storageRoot, async () => {
          // Persist the need for a new invalidation before the first late final version is
          // deleted. A crash after this write can only cause an idempotent re-purge; it cannot
          // lose the evidence while an edge retains the now-deleted object.
          lateFinalRow = await updateClaimedDeletion(row.id, claim.leaseToken, {
            status: "pending",
            phase: "purge",
            invalidationGeneration: row.invalidationGeneration + 1,
            cloudfrontInvalidationId: null,
            consecutiveFailures: 0,
            lastError: null,
          });
        });
        if (lateFinalRow) {
          row = await updateClaimedDeletion(row.id, claim.leaseToken, {
            phase: "invalidate",
          });
          continue;
        }

        const delaySeconds = watchDelaySeconds(row);
        if (delaySeconds === null) {
          await updateClaimedDeletion(row.id, claim.leaseToken, {
            status: "completed",
            phase: "complete",
            completedAt: row.completedAt ?? sql`CURRENT_TIMESTAMP`,
            lastVerifiedAt: sql`CURRENT_TIMESTAMP`,
            leaseToken: null,
            leaseExpiresAt: null,
            consecutiveFailures: 0,
            lastReconciledEventGeneration: row.objectEventGeneration,
            lastError: null,
          }, row.objectEventGeneration);
          return "reconciled";
        }
        await updateClaimedDeletion(row.id, claim.leaseToken, {
          status: "watching",
          phase: "watch",
          completedAt: row.completedAt ?? sql`CURRENT_TIMESTAMP`,
          lastVerifiedAt: sql`CURRENT_TIMESTAMP`,
          leaseToken: null,
          leaseExpiresAt: null,
          nextAttemptAt: sql`CURRENT_TIMESTAMP + (${delaySeconds} * INTERVAL '1 second')`,
          consecutiveFailures: 0,
          lastReconciledEventGeneration: row.objectEventGeneration,
          lastError: null,
        }, row.objectEventGeneration);
        return "reconciled";
      }

      throw new Error(`Unknown project asset deletion phase: ${row.phase}`);
    }

    throw new Error(
      "Project asset deletion exceeded its phase-transition budget",
    );
  } catch (error) {
    const failures = row.consecutiveFailures + 1;
    const retrySeconds = Math.min(
      MAX_RETRY_SECONDS,
      30 * 2 ** Math.min(failures - 1, 12),
    );
    try {
      await updateClaimedDeletion(row.id, claim.leaseToken, {
        status: sql`CASE
          WHEN ${projectAssetDeletions.objectEventGeneration} > ${row.objectEventGeneration}
          THEN 'pending'
          ELSE ${projectAssetDeletions.status}
        END`,
        phase: sql`CASE
          WHEN ${projectAssetDeletions.objectEventGeneration} > ${row.objectEventGeneration}
          THEN 'purge'
          ELSE ${projectAssetDeletions.phase}
        END`,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: sql`CURRENT_TIMESTAMP + (${retrySeconds} * INTERVAL '1 second')`,
        consecutiveFailures: failures,
        attentionRequiredAt:
          failures >= ATTENTION_FAILURE_COUNT
            ? (row.attentionRequiredAt ?? sql`CURRENT_TIMESTAMP`)
            : row.attentionRequiredAt,
        lastError: errorMessage(error),
      });
    } catch (persistError) {
      logger.error(
        `[project-asset-deletion] failed to persist retry state for ${row.id}:`,
        persistError,
      );
    }
    throw error;
  }
}

/** Drain a bounded batch for the scheduled ECS task. */
export async function drainProjectAssetDeletionQueue(
  maxAttempts = 10,
): Promise<{ attempted: number; reconciled: number; failed: number }> {
  let attempted = 0;
  let reconciled = 0;
  let failed = 0;

  while (attempted < maxAttempts) {
    try {
      const result = await reconcileProjectAssetDeletion();
      if (result === "unavailable") break;
      attempted++;
      if (result === "reconciled") reconciled++;
    } catch (error) {
      attempted++;
      failed++;
      logger.error(
        "[project-asset-deletion] reconciliation attempt failed:",
        error,
      );
    }
  }

  return { attempted, reconciled, failed };
}
