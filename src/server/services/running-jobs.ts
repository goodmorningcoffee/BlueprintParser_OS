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
import { processingJobs, projects } from "@/lib/db/schema";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { AuthSession } from "@/lib/api-utils";
import { ApiError, notFound } from "@/server/api/envelope";
import {
  assertProjectWritable,
  resolveProjectOrThrow,
} from "@/server/api/access";
import { withProjectWrite } from "@/server/api/project-write-capability";
import { describeYoloJobRun, getYoloJobStatus } from "@/lib/yolo";
import { catchUpRowKey, catchUpYoloJobs } from "@/server/services/yolo-catch-up";

// [2026-10-22] 3 min (was 30): a start now settles in seconds (Describe retries ≤ 2 s), so a
// confirmed not-found older than this cannot still be created by an in-flight start.
export const YOLO_NEVER_STARTED_MIN_AGE_MS = 3 * 60_000;

/** DescribeProcessingJob's answer for an unknown job name (no typed exception exists for it). */
export function isSagemakerJobNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (name === "ResourceNotFound") return true;
  return (
    name === "ValidationException" &&
    typeof message === "string" &&
    /could not find/i.test(message)
  );
}

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

    // [2026-10-21] Completed jobs nobody polled are loaded once server-side (services/yolo-catch-up).
    // [fix 2026-10-24] ROOT ONLY: YOLO load became root-only on 2026-10-23 (yolo-root-gate.ts) and
    // the catch-up loads with the caller's session, so a company admin's page load must not run it.
    const retired = session.user.isRootAdmin
      ? await catchUpYoloJobs(session, jobs, { markTerminal: updateRunningJob })
      : new Set<string>();
    return jobs.filter((j) => !retired.has(catchUpRowKey(j)));
  } catch {
    return [];
  }
}

/** DescribeProcessingJob throttled: the SDK's ThrottlingException / TooManyRequests, or an HTTP 429. */
export function isSagemakerThrottled(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { name?: unknown; Code?: unknown; __type?: unknown; $metadata?: { httpStatusCode?: unknown } };
  if (e.$metadata?.httpStatusCode === 429) return true;
  return [e.name, e.Code, e.__type].some((v) => typeof v === "string" && /Throttl|TooManyRequests/u.test(v));
}

// [fix 2026-10-24 feature_ledger Y11 "finished (Completed) but its status could not be saved:
// Internal server error"] During a bulk run every open admin tab describes every job every 10 s and
// this PUT describes it once more, so SageMaker throttles DescribeProcessingJob and the PUT fell
// through to the generic 500. A throttled describe is retried briefly; if it stays throttled the
// answer is 429 RATE_LIMITED with a message that says the row stays running (the browser's next
// poll, or root's page-load catch-up, closes it). Any other provider error is still the 500.
export const YOLO_STATUS_THROTTLE_RETRY_MS: readonly number[] = [250, 750, 1500];
export const YOLO_STATUS_THROTTLED_MESSAGE =
  "SageMaker is throttling status checks; the job stays marked running and is retried on the next poll or page load";

async function describeJobStatus(jobName: string): Promise<{ status: string; failureReason?: string }> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await getYoloJobStatus(jobName);
    } catch (error) {
      if (!isSagemakerThrottled(error)) throw error;
      if (attempt >= YOLO_STATUS_THROTTLE_RETRY_MS.length) throw new ApiError("RATE_LIMITED", YOLO_STATUS_THROTTLED_MESSAGE);
      await new Promise((resolve) => setTimeout(resolve, YOLO_STATUS_THROTTLE_RETRY_MS[attempt]));
    }
  }
}

export async function updateRunningJob(
  rawBody: Record<string, unknown>,
  session: AuthSession,
): Promise<unknown> {
  const { executionId, status, projectId } = rawBody as {
    executionId?: string;
    status?: string;
    /** [2026-10-22] Batched YOLO jobs share one executionId across projects; this picks the row. */
    projectId?: unknown;
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
      startedAt: processingJobs.startedAt,
    })
    .from(processingJobs)
    .innerJoin(projects, eq(projects.id, processingJobs.projectId))
    .where(
      and(
        eq(processingJobs.executionId, executionId),
        isNotNull(processingJobs.modelConfig),
        ...(typeof projectId === "string" && projectId ? [eq(projects.publicId, projectId)] : []),
      ),
    )
    // Without a projectId (legacy callers) a batched job's still-running row is closed first.
    .orderBy(sql`CASE WHEN ${processingJobs.status} = 'running' THEN 0 ELSE 1 END`, processingJobs.id)
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
  // Case 9: SageMaker never accepted the job. A not-found answer is terminal only once the row is
  // old enough that no in-flight start can still create it; only the JOB row closes — the compute
  // reservation is never touched here (it is unlinked; see the Stuck jobs panel).
  let neverStarted = false;
  const provider = await describeJobStatus(job.executionId!).catch((error: unknown) => {
    if (!isSagemakerJobNotFound(error)) throw error;
    const ageMs = job.startedAt ? Date.now() - job.startedAt.getTime() : Infinity;
    if (ageMs < YOLO_NEVER_STARTED_MIN_AGE_MS) {
      throw new ApiError("CONFLICT", "SageMaker has no such job yet; retry in 3 minutes");
    }
    neverStarted = true;
    return { status: "Failed" };
  });
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

  // [2026-10-22] Instance + provider wall seconds feed the cost estimate (services/yolo-run-stats).
  // Best-effort: a failed Describe only leaves the estimate on the DB timestamps.
  let run: Awaited<ReturnType<typeof describeYoloJobRun>> = null;
  if (dbStatus === "completed") {
    try {
      run = await describeYoloJobRun(job.executionId!);
    } catch {
      run = null;
    }
  }

  await withProjectWrite(writeCapability, project.id, async (tx) => {
    await tx
      .update(processingJobs)
      .set({
        status: dbStatus,
        completedAt: new Date(),
        ...(neverStarted ? { error: "SageMaker job never accepted" } : {}),
        ...(run
          ? { modelConfig: sql`COALESCE(${processingJobs.modelConfig}, '{}'::jsonb) || ${JSON.stringify(run)}::jsonb` }
          : {}),
      })
      .where(eq(processingJobs.id, job.id));
  });

  return { success: true };
}
