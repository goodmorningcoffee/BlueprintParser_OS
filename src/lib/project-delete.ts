import { db } from "@/lib/db";
import {
  projects,
  pages,
  annotations,
  annotationGroups,
  chatMessages,
  processingJobs,
  takeoffItems,
  takeoffGroups,
  labelingSessions,
  qtoWorkflows,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { deleteProjectFiles } from "@/lib/s3";
import { logger } from "@/lib/logger";

export interface DeletableProject {
  id: number;
  dataUrl: string;
  jobId: string | null;
  name?: string;
}

/**
 * Fully delete a project: stop any running Step Functions job, delete its
 * dependent DB rows + the project row in ONE transaction, then remove its S3
 * files (after commit).
 *
 * Deletion coverage — every table with an FK to projects.id:
 *  - Explicitly deleted below: chat_messages, annotations, annotation_groups,
 *    takeoff_items, takeoff_groups, labeling_sessions, qto_workflows,
 *    processing_jobs, pages. Most are ON DELETE NO ACTION, so they MUST be
 *    gone before the final DELETE projects or it aborts the tx.
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
export async function deleteProjectFully(project: DeletableProject): Promise<void> {
  // Stop any running Step Functions execution for this project
  if (project.jobId && process.env.STEP_FUNCTION_ARN) {
    try {
      const { SFNClient, StopExecutionCommand } = await import("@aws-sdk/client-sfn");
      const sfn = new SFNClient({ region: process.env.AWS_REGION || "us-east-1" });
      const executionArn = `${process.env.STEP_FUNCTION_ARN.replace(":stateMachine:", ":execution:")}:${project.jobId}`;
      await sfn.send(new StopExecutionCommand({ executionArn, cause: "Project deleted" }));
      logger.info(`[project-delete] Stopped Step Functions execution: ${project.jobId}`);
    } catch (err) {
      logger.warn("[project-delete] Could not stop Step Functions execution:", err);
    }
  }

  // [refactor jun13 P0.5-G4] DB deletes first, in ONE transaction; S3 purge
  // only after commit. The old order (S3 → unwrapped per-table deletes) could
  // leave a live project row pointing at deleted files after any mid-sequence
  // failure — a user-visible broken project. The failure mode now is the
  // benign inverse: committed DB delete + failed S3 purge = orphaned objects,
  // invisible to users, logged below for cleanup. This tx is the P1 reference
  // pattern for service-layer writes.
  //
  // The old per-table try/catch ("table may not exist yet") is gone on
  // purpose: inside a pg transaction any failed statement aborts the tx
  // (25P02) so those catches could never help — and the schema is
  // migration-managed now (test harness fresh-migrates 0000→latest).
  await db.transaction(async (tx) => {
    await tx.delete(chatMessages).where(eq(chatMessages.projectId, project.id));
    await tx.delete(annotations).where(eq(annotations.projectId, project.id));
    // [refactor jun16 P0-review G4] explicit (was DB-cascade-only); members
    // junction cascades off both annotations (above) and annotation_groups.
    await tx.delete(annotationGroups).where(eq(annotationGroups.projectId, project.id));
    await tx.delete(takeoffItems).where(eq(takeoffItems.projectId, project.id));
    await tx.delete(takeoffGroups).where(eq(takeoffGroups.projectId, project.id));
    await tx.delete(labelingSessions).where(eq(labelingSessions.projectId, project.id));
    await tx.delete(qtoWorkflows).where(eq(qtoWorkflows.projectId, project.id));
    await tx.delete(processingJobs).where(eq(processingJobs.projectId, project.id));
    await tx.delete(pages).where(eq(pages.projectId, project.id));
    await tx.delete(projects).where(eq(projects.id, project.id));
  });

  // Delete S3 files (PDF, thumbnails, page images, etc.) — after commit
  try {
    await deleteProjectFiles(project.dataUrl);
  } catch (err) {
    logger.error(
      `[project-delete] DB rows deleted but S3 purge failed for ${project.dataUrl} — orphaned objects need manual cleanup:`,
      err
    );
  }
}
