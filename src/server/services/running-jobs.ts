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
// Failed|Stopped→failed) + the executionId-keyed update (⚠️ NOT company-scoped, legacy).

import { db } from "@/lib/db";
import { processingJobs } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import type { AuthSession } from "@/lib/api-utils";
import { ApiError } from "@/server/api/envelope";

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

export async function updateRunningJob(rawBody: Record<string, unknown>): Promise<unknown> {
  const { executionId, status } = rawBody as { executionId?: string; status?: string };
  if (!executionId || !status) {
    throw new ApiError("VALIDATION", "executionId and status required");
  }

  const dbStatus = status === "Completed" ? "completed" : status === "Failed" || status === "Stopped" ? "failed" : null;
  if (!dbStatus) {
    throw new ApiError("VALIDATION", "Invalid terminal status");
  }

  await db
    .update(processingJobs)
    .set({ status: dbStatus, completedAt: new Date() })
    .where(eq(processingJobs.executionId, executionId));

  return { success: true };
}
