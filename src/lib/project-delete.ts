import { db } from "@/lib/db";
import {
  projects,
  pages,
  annotations,
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
 * Fully delete a project: stop any running Step Functions job, delete every
 * dependent DB row in FK order plus the project row in ONE transaction, then
 * remove its S3 files. compute_usage rows survive with project_id nulled
 * (ON DELETE SET NULL, 0030) since the ledger is append-only billing history.
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
