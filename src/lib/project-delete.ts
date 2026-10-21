import {
  projects,
  pages,
  annotations,
  annotationGroups,
  chatMessages,
  processingJobs,
  projectMutationLeases,
  labelStudioProjectIntents,
  takeoffItems,
  takeoffGroups,
  labelingSessions,
  qtoWorkflows,
  companies,
  projectAssetDeletions,
} from "@/lib/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { reconcileProjectAssetDeletion } from "@/lib/project-asset-deletion";
import {
  isCanonicalProjectPath,
  PROJECT_UPLOAD_PUBLICATION_FENCE_SECONDS,
} from "@/lib/project-upload-authority";
import { ApiError } from "@/server/api/envelope";
import {
  reconcileProjectIngestJobs,
  type IngestReconcileOutcome,
} from "@/server/services/ingest-reconcile";
import {
  withProjectStorageWrite,
  withProjectStorageWritesInTransaction,
  withProjectWritesInTransaction,
  type ProjectWriteCapability,
  type ProjectWriteTransaction,
} from "@/server/api/project-write-capability";

export interface DeletableProject {
  id: number;
  dataUrl: string;
  jobId: string | null;
  name?: string;
}

export interface ProjectDeletionEntry {
  project: DeletableProject;
  writeCapability: ProjectWriteCapability;
}

export interface StagedProjectAssetDeletion {
  id: string;
  storageRoot: string;
}

export interface StagedProjectDeletionResult<T> {
  deletions: StagedProjectAssetDeletion[];
  result: T;
}

/**
 * Fully delete a quiescent project: reject every live external-work witness, delete its dependent
 * DB rows + the project row in ONE transaction, then remove its S3 files (after commit).
 *
 * Deletion coverage — every table with an FK to projects.id:
 *  - Explicitly deleted below: chat_messages, annotations, annotation_groups,
 *    takeoff_items, takeoff_groups, qto_workflows,
 *    processing_jobs, pages. Most are ON DELETE NO ACTION, so they MUST be
 *    gone before the final DELETE projects or it aborts the tx.
 *  - labeling_sessions must be empty before teardown: its external Label Studio project is
 *    retired first through the provider-aware session-delete path, never orphaned here.
 *  - annotation_group_members (the M:N junction) has NO direct project FK; it
 *    clears via ON DELETE CASCADE from BOTH parents (annotations.id and
 *    annotation_groups.id), which we delete above — no explicit delete needed.
 *  - compute_usage is intentionally NOT deleted: ON DELETE SET NULL (0030)
 *    preserves the append-only billing ledger with project_id nulled.
 *
 * [refactor jun16 P0-review G4] annotation_groups is now deleted EXPLICITLY.
 * It previously survived this sequence and only disappeared via its own
 * project-level ON DELETE CASCADE (0025) — undocumented and untested. Deleting
 * it here keeps this function (not the schema) the single, testable source of
 * truth for teardown, so a future NO-ACTION child added-but-forgotten fails
 * loudly in the cascade test rather than silently aborting prod deletes.
 *
 * This is the single source of truth for "delete a project end to end" — used
 * by DELETE /api/projects/[id] and by the cascade path of user deletion. Keep
 * the deletion sequence identical to avoid divergent cleanup.
 */
async function stageLockedProjectDeletion(
  tx: ProjectWriteTransaction,
  project: DeletableProject,
): Promise<StagedProjectAssetDeletion> {
  const [storageOwner] = await tx
    .select({
      dataUrl: projects.dataUrl,
      publicId: projects.publicId,
      companyId: projects.companyId,
      lifecycleEpoch: projects.lifecycleEpoch,
      companyDataKey: companies.dataKey,
    })
    .from(projects)
    .innerJoin(companies, eq(companies.id, projects.companyId))
    .where(eq(projects.id, project.id))
    .limit(1);
  if (
    !storageOwner ||
    storageOwner.dataUrl !== project.dataUrl ||
    !isCanonicalProjectPath(storageOwner.companyDataKey, storageOwner.dataUrl)
  ) {
    throw new ApiError(
      "CONFLICT",
      "Project storage root requires reconciliation",
    );
  }

  const [deletion] = await tx
    .insert(projectAssetDeletions)
    .values({
      projectPublicId: storageOwner.publicId,
      companyId: storageOwner.companyId,
      storageRoot: storageOwner.dataUrl,
      lifecycleEpoch: storageOwner.lifecycleEpoch,
    })
    .returning({ id: projectAssetDeletions.id });
  if (!deletion) throw new Error("Failed to record project asset deletion");

  const [runningJob] = await tx
    .select({ id: processingJobs.id })
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.projectId, project.id),
        eq(processingJobs.status, "running"),
      ),
    )
    .limit(1);
  if (runningJob) {
    throw new ApiError("CONFLICT", "Project has an active processing job");
  }

  const [activeLease] = await tx
    .select({ token: projectMutationLeases.token })
    .from(projectMutationLeases)
    .where(
      and(
        eq(projectMutationLeases.projectId, project.id),
        eq(projectMutationLeases.status, "active"),
      ),
    )
    .limit(1);
  if (activeLease) {
    throw new ApiError("CONFLICT", "Project has an active mutation lease");
  }

  // Deleting only the local row would orphan a still-mutable Label Studio project. Sessions
  // must first be retired through their provider-aware delete path (404 is already idempotent).
  const [linkedLabelingSession] = await tx
    .select({ id: labelingSessions.id })
    .from(labelingSessions)
    .where(eq(labelingSessions.projectId, project.id))
    .limit(1);
  if (linkedLabelingSession) {
    throw new ApiError("CONFLICT", "Project has linked labeling sessions");
  }
  const [pendingLabelStudioProject] = await tx
    .select({ id: labelStudioProjectIntents.id })
    .from(labelStudioProjectIntents)
    .where(eq(labelStudioProjectIntents.projectId, project.id))
    .limit(1);
  if (pendingLabelStudioProject) {
    throw new ApiError(
      "CONFLICT",
      "Project has pending Label Studio provisioning",
    );
  }

  // This is a conservative credential-drain delay, not proof that an already accepted request
  // finished. Isolated staging + server-only canonical final roots are the immutability boundary.
  const [uploadAuthority] = await tx
    .select({
      active: sql<boolean>`
        ${projects.createdAt} IS NULL
        OR ${projects.createdAt}
          + (${PROJECT_UPLOAD_PUBLICATION_FENCE_SECONDS} * INTERVAL '1 second')
          > CURRENT_TIMESTAMP
      `,
    })
    .from(projects)
    .where(eq(projects.id, project.id))
    .limit(1);
  if (uploadAuthority?.active) {
    throw new ApiError(
      "CONFLICT",
      "Project upload credentials are still active",
    );
  }

  // DB deletes and the permanent outbox row share the caller's transaction. S3/CDN work is
  // deliberately absent here and can begin only after that transaction has committed.
  await tx.delete(chatMessages).where(eq(chatMessages.projectId, project.id));
  await tx.delete(annotations).where(eq(annotations.projectId, project.id));
  await tx
    .delete(annotationGroups)
    .where(eq(annotationGroups.projectId, project.id));
  await tx.delete(takeoffItems).where(eq(takeoffItems.projectId, project.id));
  await tx.delete(takeoffGroups).where(eq(takeoffGroups.projectId, project.id));
  await tx.delete(qtoWorkflows).where(eq(qtoWorkflows.projectId, project.id));
  await tx
    .delete(processingJobs)
    .where(eq(processingJobs.projectId, project.id));
  await tx.delete(pages).where(eq(pages.projectId, project.id));
  await tx.delete(projects).where(eq(projects.id, project.id));
  return { id: deletion.id, storageRoot: storageOwner.dataUrl };
}

/**
 * Stage several project teardowns and an associated DB mutation on one already-open transaction.
 * Every storage root and every affected parent is locked before the first outbox row is inserted.
 */
export async function stageProjectDeletionsInTransaction<T>(
  tx: ProjectWriteTransaction,
  entries: readonly ProjectDeletionEntry[],
  additionalCapabilities: readonly ProjectWriteCapability[],
  write: (tx: ProjectWriteTransaction) => Promise<T>,
): Promise<StagedProjectDeletionResult<T>> {
  const projectIds = new Set<number>();
  for (const entry of entries) {
    if (projectIds.has(entry.project.id)) {
      throw new Error("Duplicate project deletion entry");
    }
    projectIds.add(entry.project.id);
  }

  const stage = async (lockedTx: ProjectWriteTransaction) => {
    const deletions: StagedProjectAssetDeletion[] = [];
    for (const entry of [...entries].sort(
      (left, right) => left.project.id - right.project.id,
    )) {
      deletions.push(await stageLockedProjectDeletion(lockedTx, entry.project));
    }
    return { deletions, result: await write(lockedTx) };
  };

  if (entries.length === 0) {
    if (additionalCapabilities.length === 0) {
      return stage(tx);
    }
    return withProjectWritesInTransaction(tx, additionalCapabilities, stage);
  }

  return withProjectStorageWritesInTransaction(
    tx,
    entries.map((entry) => ({
      capability: entry.writeCapability,
      projectId: entry.project.id,
      storageRoot: entry.project.dataUrl,
    })),
    additionalCapabilities,
    stage,
  );
}

/** Run best-effort immediate reconciliation only for outboxes whose transaction has committed. */
export async function reconcileCommittedProjectDeletions(
  deletions: readonly StagedProjectAssetDeletion[],
): Promise<void> {
  for (const deletion of deletions) {
    try {
      await reconcileProjectAssetDeletion(deletion.id);
    } catch (err) {
      logger.error(
        `[project-delete] immediate asset reconciliation failed for ${deletion.storageRoot}; durable retry remains pending:`,
        err,
      );
    }
  }
}

const STUCK_JOBS_HINT = "see Admin > Data tools > Stuck jobs";

/** Explain a quiescence refusal with what the pre-delete provider reconcile learned. */
function explainDeleteRefusal(
  error: unknown,
  reconciled: readonly IngestReconcileOutcome[],
): unknown {
  if (!(error instanceof ApiError) || error.code !== "CONFLICT") return error;
  if (reconciled.length === 0) return error;
  // An unavailable provider taught us nothing: today's exact refusal stands.
  const pending = reconciled.find(
    (outcome) => !outcome.changed && outcome.provider.state !== "unavailable",
  );
  if (error.message === "Project has an active processing job" && pending) {
    const detail =
      pending.provider.state === "running"
        ? pending.message
        : `${pending.message}; ${STUCK_JOBS_HINT}`;
    return new ApiError("CONFLICT", `${error.message} (${detail})`);
  }
  if (
    error.message === "Project has an active mutation lease" &&
    reconciled.some((outcome) => outcome.changed)
  ) {
    const refusal = reconciled.find((outcome) => outcome.leaseRefusal);
    const detail = refusal?.leaseRefusal
      ? `${refusal.leaseRefusal}; ${STUCK_JOBS_HINT}`
      : STUCK_JOBS_HINT;
    return new ApiError("CONFLICT", `${error.message} (${detail})`);
  }
  return error;
}

export async function deleteProjectFully(
  project: DeletableProject,
  writeCapability: ProjectWriteCapability,
): Promise<void> {
  // Best-effort provider reconcile strictly BEFORE the guard transaction (never call AWS inside
  // it): an ingest job AWS attests finished is closed, and its worker lease reclaimed under the
  // ownership proof, so the quiescence checks below see the truth. Failure leaves them in charge.
  const reconciled = await reconcileProjectIngestJobs(project.id, writeCapability);

  // The parent lock, quiescence decision, outbox, and delete are one transaction. Provider stop
  // acknowledgement is not quiescence: workers may still be writing after a timeout/stop request.
  let deletion: StagedProjectAssetDeletion;
  try {
    deletion = await withProjectStorageWrite(
      writeCapability,
      project.id,
      project.dataUrl,
      (tx) => stageLockedProjectDeletion(tx, project),
    );
  } catch (error) {
    throw explainDeleteRefusal(error, reconciled);
  }

  await reconcileCommittedProjectDeletions([deletion]);
}
