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
  withProjectStorageWrite,
  type ProjectWriteCapability,
} from "@/server/api/project-write-capability";

export interface DeletableProject {
  id: number;
  dataUrl: string;
  jobId: string | null;
  name?: string;
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
export async function deleteProjectFully(
  project: DeletableProject,
  writeCapability: ProjectWriteCapability,
): Promise<void> {
  // The parent lock, quiescence decision, and delete are one transaction. Provider stop
  // acknowledgement is not quiescence: workers may still be writing after a timeout/stop request.
  // Callers retry only after the provider-attested job row and every explicit lease are retired.
  const deletionId = await withProjectStorageWrite(
    writeCapability,
    project.id,
    project.dataUrl,
    async (tx) => {
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
        !isCanonicalProjectPath(
          storageOwner.companyDataKey,
          storageOwner.dataUrl,
        )
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

      // [refactor jun13 P0.5-G4] DB deletes first, in ONE parent-first transaction; S3 purge
      // only after commit. The old order (S3 → unwrapped per-table deletes) could leave a live
      // project row pointing at deleted files after any mid-sequence failure.
      await tx
        .delete(chatMessages)
        .where(eq(chatMessages.projectId, project.id));
      await tx.delete(annotations).where(eq(annotations.projectId, project.id));
      // [refactor jun16 P0-review G4] explicit (was DB-cascade-only); members
      // junction cascades off both annotations (above) and annotation_groups.
      await tx
        .delete(annotationGroups)
        .where(eq(annotationGroups.projectId, project.id));
      await tx
        .delete(takeoffItems)
        .where(eq(takeoffItems.projectId, project.id));
      await tx
        .delete(takeoffGroups)
        .where(eq(takeoffGroups.projectId, project.id));
      await tx
        .delete(qtoWorkflows)
        .where(eq(qtoWorkflows.projectId, project.id));
      await tx
        .delete(processingJobs)
        .where(eq(processingJobs.projectId, project.id));
      await tx.delete(pages).where(eq(pages.projectId, project.id));
      await tx.delete(projects).where(eq(projects.id, project.id));
      return deletion.id;
    },
  );

  // Reconcile S3 versions + CDN only after the DB transaction commits. Failure is persisted on the
  // outbox row and retried by the scheduled worker; the permanent row also forbids path reuse.
  try {
    await reconcileProjectAssetDeletion(deletionId);
  } catch (err) {
    logger.error(
      `[project-delete] immediate asset reconciliation failed for ${project.dataUrl}; durable retry remains pending:`,
      err,
    );
  }
}
