// [refactor jul6 S046] admin/running-jobs SOLO — GET running YOLO jobs (companyId-scoped raw
// SQL, bare array, graceful catch) + PUT a job's terminal status, folded from the legacy route
// (git show 0fe49e8:src/app/api/admin/running-jobs/route.ts). Char:
// __tests__/admin-running-jobs.route.test.ts (RJ-*). requireAdmin (the shell provides
// auth:"admin"). Sanctioned diffs:
//   • A — flat auth errors → envelope; the PUT 400 literals stay byte-verbatim as ApiError.
//   • E — legacy PUT `await req.json()` subsumed by the shell raw-parse ("Invalid JSON body").
//   • NO B — GET's internal try/catch → 200 bare [] is a PRESERVED SUCCESS fallback (fail
//     quietly), NOT a catch-500 literal; it stays in-service. PUT has no catch → unexpected
//     errors propagate to the shell generic INTERNAL 500.
// PRESERVED byte-exact: the GET raw-SQL (companyId-scoped, status='running', model_config NOT
// NULL, DESC) + the bare-array model_config shaping; the PUT status map (Completed→completed /
// Failed|Stopped→failed) + executionId lookup. P2 resolves the owning project, hides foreign
// jobs from company admins, preserves the root operations bypass, and rechecks provider terminality.

import { db } from "@/lib/db";
import { processingJobs } from "@/lib/db/schema";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { AuthSession } from "@/lib/api-utils";
import { ApiError, notFound } from "@/server/api/envelope";
import {
  assertProjectWritable,
  resolveProjectOrThrow,
} from "@/server/api/access";
import { withProjectWrite } from "@/server/api/project-write-capability";
import { getYoloJobStatus } from "@/lib/yolo";

export async function getRunningJobs(session: AuthSession): Promise<unknown> {
  try {
    const rows = await db.execute(sql`
      SELECT
        pj.id,
        pj.execution_id AS "executionId",
        pj.model_config AS "modelConfig",
        pj.started_at AS "startedAt",
        p.public_id AS "projectPublicId"
      FROM processing_jobs pj
      JOIN projects p ON pj.project_id = p.id
      WHERE p.company_id = ${session.user.companyId}
        AND pj.status = 'running'
        AND pj.model_config IS NOT NULL
      ORDER BY pj.started_at DESC
    `);

    const jobs = (rows.rows as any[]).map((r) => ({
      projectPublicId: r.projectPublicId,
      executionId: r.executionId,
      modelId: r.modelConfig?.modelId,
      modelName: r.modelConfig?.modelName,
      startedAt: r.startedAt,
    }));

    return jobs;
  } catch {
    return [];
  }
}

export async function updateRunningJob(
  rawBody: Record<string, unknown>,
  session: AuthSession,
): Promise<unknown> {
  const { executionId, status } = rawBody as {
    executionId?: string;
    status?: string;
  };
  if (!executionId || !status) {
    throw new ApiError("VALIDATION", "executionId and status required");
  }

  const requestedStatus =
    status === "Completed" || status === "Failed" || status === "Stopped"
      ? status
      : null;
  if (!requestedStatus) {
    throw new ApiError("VALIDATION", "Invalid terminal status");
  }

  const [job] = await db
    .select({
      id: processingJobs.id,
      projectId: processingJobs.projectId,
      executionId: processingJobs.executionId,
    })
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.executionId, executionId),
        isNotNull(processingJobs.modelConfig),
      ),
    )
    .limit(1);
  if (!job) throw notFound();

  const { project } = await resolveProjectOrThrow(
    { dbId: job.projectId },
    { allowDemo: true },
  );
  if (!session.user.isRootAdmin && project.companyId !== session.user.companyId)
    throw notFound();
  if (project.isDemo) assertProjectWritable(project);
  const writeCapability = assertProjectWritable(project);

  // The browser also polls SageMaker, but its status string is not an attestation: accepting it
  // here would let any company admin retire the publication blocker while the provider job was
  // still writing to the project's S3 prefix. Re-read the authoritative, monotonic provider
  // state and fail closed on non-terminal/unknown responses or provider errors.
  const provider = await getYoloJobStatus(job.executionId!);
  const dbStatus =
    provider.status === "Completed"
      ? "completed"
      : provider.status === "Failed" || provider.status === "Stopped"
        ? "failed"
        : null;
  if (!dbStatus) {
    throw new ApiError(
      "CONFLICT",
      "Job has not reached a terminal provider status",
    );
  }

  await withProjectWrite(writeCapability, project.id, async (tx) => {
    await tx
      .update(processingJobs)
      .set({ status: dbStatus, completedAt: new Date() })
      .where(eq(processingJobs.id, job.id));
  });

  return { success: true };
}
