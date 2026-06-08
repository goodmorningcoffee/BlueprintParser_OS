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
 * Fully delete a project: stop any running Step Functions job, remove its S3
 * files, and delete every dependent DB row in FK order, then the project row.
 * compute_usage rows survive with project_id nulled (ON DELETE SET NULL, 0030)
 * since the ledger is append-only billing history.
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

  // Delete S3 files (PDF, thumbnails, page images, etc.)
  try {
    await deleteProjectFiles(project.dataUrl);
  } catch (err) {
    logger.error("[project-delete] Failed to delete S3 files:", err);
  }

  // Delete DB records in dependency order (all tables with FK to projects.id)
  await db.delete(chatMessages).where(eq(chatMessages.projectId, project.id));
  await db.delete(annotations).where(eq(annotations.projectId, project.id));
  try { await db.delete(takeoffItems).where(eq(takeoffItems.projectId, project.id)); } catch { /* table may not exist yet */ }
  try { await db.delete(takeoffGroups).where(eq(takeoffGroups.projectId, project.id)); } catch { /* table may not exist yet */ }
  try { await db.delete(labelingSessions).where(eq(labelingSessions.projectId, project.id)); } catch { /* table may not exist yet */ }
  await db.delete(processingJobs).where(eq(processingJobs.projectId, project.id));
  await db.delete(pages).where(eq(pages.projectId, project.id));
  await db.delete(projects).where(eq(projects.id, project.id));
}
