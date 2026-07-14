import { randomUUID } from "node:crypto";

import { and, eq, isNull, lt, lte, or, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  labelingSessions,
  labelStudioAssetGrants,
  projectMutationLeases,
  projects,
} from "@/lib/db/schema";
import {
  deleteSessionLabelStudioAssetGrants,
  revokeSessionLabelStudioAssetGrants,
} from "@/lib/label-studio-asset-grant";
import {
  deleteProject,
  type LabelStudioProviderBinding,
} from "@/lib/label-studio";
import { logger } from "@/lib/logger";
import { assertProjectWritable } from "@/server/api/access";
import {
  withProjectWrite,
  type ProjectWriteCapability,
} from "@/server/api/project-write-capability";

const RETIREMENT_LEASE_SECONDS = 15 * 60;
const MAX_RETRY_SECONDS = 24 * 60 * 60;
const MAX_ERROR_LENGTH = 4_000;

export type LabelStudioSessionRetirementResult = "cleaned" | "unavailable";

interface RetirementCandidate {
  id: number;
  projectId: number;
}

interface ClaimedRetirement {
  id: number;
  projectId: number;
  providerProjectId: number;
  provider: LabelStudioProviderBinding;
  leaseToken: string;
  consecutiveFailures: number;
  capability: ProjectWriteCapability;
}

function errorMessage(error: unknown): string {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).trim();
  return (message || "Unknown Label Studio retirement error").slice(
    0,
    MAX_ERROR_LENGTH,
  );
}

async function projectCapability(
  projectId: number,
): Promise<ProjectWriteCapability | null> {
  const [project] = await db
    .select({
      id: projects.id,
      publicId: projects.publicId,
      companyId: projects.companyId,
      isDemo: projects.isDemo,
      lifecycleEpoch: projects.lifecycleEpoch,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return project ? assertProjectWritable(project) : null;
}

async function claimCandidate(
  candidate: RetirementCandidate,
): Promise<ClaimedRetirement | null> {
  const capability = await projectCapability(candidate.projectId);
  if (!capability) return null;

  return withProjectWrite(capability, candidate.projectId, async (tx) => {
    // A project-wide external mutation is stronger authority. Wait for it to retire before
    // issuing an idempotent provider DELETE; the session row remains a project blocker meanwhile.
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
      .from(labelingSessions)
      .where(
        and(
          eq(labelingSessions.id, candidate.id),
          eq(labelingSessions.projectId, candidate.projectId),
          eq(labelingSessions.status, "retiring"),
          lte(labelingSessions.retirementNextAttemptAt, sql`CURRENT_TIMESTAMP`),
          or(
            isNull(labelingSessions.retirementLeaseExpiresAt),
            lt(
              labelingSessions.retirementLeaseExpiresAt,
              sql`CURRENT_TIMESTAMP`,
            ),
          ),
        ),
      )
      .for("update")
      .limit(1);
    if (!current) return null;

    // This is idempotent and closes any partially migrated/manual state before provider I/O.
    await revokeSessionLabelStudioAssetGrants(tx, current.id);
    const grants = await tx
      .select({
        id: labelStudioAssetGrants.id,
        projectId: labelStudioAssetGrants.projectId,
        companyId: labelStudioAssetGrants.companyId,
        lifecycleEpoch: labelStudioAssetGrants.lifecycleEpoch,
        state: labelStudioAssetGrants.state,
      })
      .from(labelStudioAssetGrants)
      .where(eq(labelStudioAssetGrants.labelingSessionId, current.id));
    if (
      grants.length === 0 ||
      grants.some(
        (grant) =>
          grant.projectId !== capability.projectId ||
          grant.companyId !== capability.companyId ||
          grant.lifecycleEpoch !== capability.lifecycleEpoch ||
          grant.state !== "revoked",
      )
    ) {
      throw new Error("Label Studio retirement grant authority mismatch");
    }

    const leaseToken = randomUUID();
    const [claimed] = await tx
      .update(labelingSessions)
      .set({
        retirementLeaseToken: leaseToken,
        retirementLeaseExpiresAt: sql`CURRENT_TIMESTAMP + (${RETIREMENT_LEASE_SECONDS} * INTERVAL '1 second')`,
        retirementAttemptCount: sql`${labelingSessions.retirementAttemptCount} + 1`,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(
        and(
          eq(labelingSessions.id, current.id),
          eq(labelingSessions.projectId, current.projectId),
          eq(labelingSessions.status, "retiring"),
          or(
            isNull(labelingSessions.retirementLeaseExpiresAt),
            lt(
              labelingSessions.retirementLeaseExpiresAt,
              sql`CURRENT_TIMESTAMP`,
            ),
          ),
        ),
      )
      .returning({ id: labelingSessions.id });
    if (!claimed) throw new Error("Failed to claim Label Studio retirement");

    return {
      id: current.id,
      projectId: current.projectId,
      providerProjectId: current.labelStudioProjectId,
      provider: {
        baseUrl: current.providerBaseUrl,
        instanceId: current.providerInstanceId,
      },
      leaseToken,
      consecutiveFailures: current.retirementConsecutiveFailures,
      capability,
    };
  });
}

async function claimRetirement(id?: number): Promise<ClaimedRetirement | null> {
  // Discovery is deliberately unlocked. Every candidate is revalidated after its parent is
  // locked, preserving the repository-wide parent-first order.
  const candidates = await db
    .select({ id: labelingSessions.id, projectId: labelingSessions.projectId })
    .from(labelingSessions)
    .leftJoin(
      projectMutationLeases,
      and(
        eq(projectMutationLeases.projectId, labelingSessions.projectId),
        eq(projectMutationLeases.status, "active"),
      ),
    )
    .where(
      and(
        eq(labelingSessions.status, "retiring"),
        lte(labelingSessions.retirementNextAttemptAt, sql`CURRENT_TIMESTAMP`),
        or(
          isNull(labelingSessions.retirementLeaseExpiresAt),
          lt(labelingSessions.retirementLeaseExpiresAt, sql`CURRENT_TIMESTAMP`),
        ),
        isNull(projectMutationLeases.token),
        id === undefined ? undefined : eq(labelingSessions.id, id),
      ),
    )
    .orderBy(labelingSessions.retirementNextAttemptAt, labelingSessions.id)
    .limit(id === undefined ? 25 : 1);

  for (const candidate of candidates) {
    const claimed = await claimCandidate(candidate);
    if (claimed) return claimed;
  }
  return null;
}

async function finishClaimedRetirement(
  claim: ClaimedRetirement,
): Promise<void> {
  await withProjectWrite(claim.capability, claim.projectId, async (tx) => {
    const deletedGrants = await deleteSessionLabelStudioAssetGrants(
      tx,
      claim.id,
    );
    if (deletedGrants === 0) {
      throw new Error("Label Studio retirement lost its revoked grants");
    }
    const deleted = await tx
      .delete(labelingSessions)
      .where(
        and(
          eq(labelingSessions.id, claim.id),
          eq(labelingSessions.projectId, claim.projectId),
          eq(labelingSessions.status, "retiring"),
          eq(labelingSessions.retirementLeaseToken, claim.leaseToken),
        ),
      )
      .returning({ id: labelingSessions.id });
    if (deleted.length !== 1) {
      throw new Error("Label Studio retirement lease was lost");
    }
  });
}

async function rescheduleClaimedRetirement(
  claim: ClaimedRetirement,
  error: unknown,
): Promise<void> {
  const failures = claim.consecutiveFailures + 1;
  const delaySeconds = Math.min(
    MAX_RETRY_SECONDS,
    30 * 2 ** Math.min(claim.consecutiveFailures, 12),
  );
  await withProjectWrite(claim.capability, claim.projectId, async (tx) => {
    const updated = await tx
      .update(labelingSessions)
      .set({
        retirementLeaseToken: null,
        retirementLeaseExpiresAt: null,
        retirementConsecutiveFailures: failures,
        retirementNextAttemptAt: sql`CURRENT_TIMESTAMP + (${delaySeconds} * INTERVAL '1 second')`,
        retirementLastError: errorMessage(error),
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(
        and(
          eq(labelingSessions.id, claim.id),
          eq(labelingSessions.projectId, claim.projectId),
          eq(labelingSessions.status, "retiring"),
          eq(labelingSessions.retirementLeaseToken, claim.leaseToken),
        ),
      )
      .returning({ id: labelingSessions.id });
    if (updated.length !== 1) {
      throw new Error("Label Studio retirement lease was lost");
    }
  });
}

/**
 * Reconcile one already-revoked Label Studio session. The only external operation is an
 * idempotent DELETE; an expired lease can therefore be reclaimed after a worker crash.
 */
export async function reconcileLabelStudioSessionRetirement(
  id?: number,
): Promise<LabelStudioSessionRetirementResult> {
  const claim = await claimRetirement(id);
  if (!claim) return "unavailable";

  try {
    await deleteProject(claim.provider, claim.providerProjectId);
    try {
      await finishClaimedRetirement(claim);
    } catch (error) {
      // A lost COMMIT acknowledgement must not resurrect a queue row or turn a completed
      // idempotent retirement into an error.
      const [remaining] = await db
        .select({ id: labelingSessions.id })
        .from(labelingSessions)
        .where(eq(labelingSessions.id, claim.id))
        .limit(1);
      if (!remaining) return "cleaned";
      throw error;
    }
    return "cleaned";
  } catch (error) {
    try {
      await rescheduleClaimedRetirement(claim, error);
    } catch (persistError) {
      logger.error(
        `[label-studio-retirement] failed to persist retry state for ${claim.id}:`,
        persistError,
      );
    }
    throw error;
  }
}

export async function drainLabelStudioSessionRetirementQueue(
  maxAttempts = 10,
): Promise<{ attempted: number; cleaned: number; failed: number }> {
  let attempted = 0;
  let cleaned = 0;
  let failed = 0;

  while (attempted < maxAttempts) {
    try {
      const result = await reconcileLabelStudioSessionRetirement();
      if (result === "unavailable") break;
      attempted++;
      cleaned++;
    } catch (error) {
      attempted++;
      failed++;
      logger.error(
        "[label-studio-retirement] reconciliation attempt failed:",
        error,
      );
    }
  }
  return { attempted, cleaned, failed };
}
