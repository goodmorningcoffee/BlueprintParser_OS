// [2026-10-21 owner: "have it just auto load so that after the model is run it auto loads"] Server-side
// catch-up for YOLO jobs nobody was watching. The browser polls and auto-loads a job only while the
// admin tab that started it stays open; when GET /api/admin/running-jobs (the admin page's load) finds
// a still-'running' row, this asks SageMaker about it first:
//   • Completed → its results are loaded ONCE via yoloLoad (the yolo-load project lease keeps a
//     concurrent browser load from doubling it; a load replaces that model's previous detections, so a
//     repeat is harmless), and ONLY THEN is the row marked completed through updateRunningJob
//     (provider-rechecked) and dropped from the running list. A failed load leaves the row 'running',
//     so the browser still sees it and auto-loads it.
//   • no such job and the row is ≥ 30 min old → updateRunningJob closes it as "never accepted"
//     (this also returns the day's YOLO job count it held — see checkYoloQuota).
//   • anything else (in progress, failed, stopped, provider error) → left for the browser, unchanged.
// Bounded per request (CATCH_UP_MAX_JOBS describes, CATCH_UP_MAX_LOADS jobs loaded). NEVER THROWS.
// [2026-10-22] A batched job (services/yolo-batch-run.ts) has one row PER PROJECT under one execution
// id: SageMaker is asked once per execution id, every project row of a Completed job is loaded (until
// CATCH_UP_LOAD_BUDGET_MS is spent — the rest stay running for the browser), and each row is closed by
// (executionId, projectId). Retired rows are keyed by catchUpRowKey.

import type { AuthSession } from "@/lib/api-utils";
import { getYoloJobStatus } from "@/lib/yolo";
import { isSageMakerNotFoundError } from "@/lib/yolo-instances";
import { logger } from "@/lib/logger";

/** Distinct SageMaker jobs described per request. */
export const CATCH_UP_MAX_JOBS = 10;
/** Completed jobs loaded per request (every project row of each). */
export const CATCH_UP_MAX_LOADS = 2;
/** After the first row, further loads in one request stop once this much time has gone by. */
export const CATCH_UP_LOAD_BUDGET_MS = 25_000;
const NEVER_STARTED_MIN_AGE_MS = 30 * 60_000;

export interface CatchUpRow {
  projectPublicId: string;
  executionId: string;
  modelId?: number;
  modelName?: string;
  startedAt?: string | Date | null;
}

export interface CatchUpDeps {
  /** services/running-jobs updateRunningJob (re-reads the provider before writing). */
  markTerminal(
    body: { executionId: string; status: "Completed" | "Failed"; projectId: string },
    session: AuthSession,
  ): Promise<unknown>;
  /** services/yolo yoloLoad with an explicit session. */
  load?(body: { projectId: string; modelId: number; modelName: string }, session: AuthSession): Promise<unknown>;
  now?: () => number;
}

/** The identity of one running row: a batched job shares its execution id across projects. */
export function catchUpRowKey(row: Pick<CatchUpRow, "executionId" | "projectPublicId">): string {
  return `${row.executionId}\u0000${row.projectPublicId}`;
}

async function defaultLoad(body: { projectId: string; modelId: number; modelName: string }, session: AuthSession) {
  const { yoloLoad } = await import("@/server/services/yolo");
  return yoloLoad(body, session);
}

/** Returns the catchUpRowKey of every row this call retired from the running list. */
export async function catchUpYoloJobs(
  session: AuthSession,
  rows: readonly CatchUpRow[],
  deps: CatchUpDeps,
): Promise<Set<string>> {
  const retired = new Set<string>();
  try {
    const now = deps.now ?? Date.now;
    const load = deps.load ?? defaultLoad;
    const jobs = new Map<string, CatchUpRow[]>();
    for (const r of rows) {
      if (!r.executionId || !r.projectPublicId) continue;
      const list = jobs.get(r.executionId) ?? [];
      list.push(r);
      jobs.set(r.executionId, list);
    }
    const candidates = [...jobs.entries()].slice(-CATCH_UP_MAX_JOBS);
    const answers = await Promise.all(
      candidates.map(async ([executionId, jobRows]) => {
        try {
          const s = await getYoloJobStatus(executionId);
          return { executionId, jobRows, status: typeof s?.status === "string" ? s.status : null, missing: false };
        } catch (err) {
          return { executionId, jobRows, status: null, missing: isSageMakerNotFoundError(err) };
        }
      }),
    );
    let jobsLoaded = 0;
    let loadStartedAt: number | null = null;
    for (const { executionId, jobRows, status, missing } of answers) {
      if (status === "Completed") {
        if (jobsLoaded >= CATCH_UP_MAX_LOADS) continue;
        jobsLoaded += 1;
        for (const row of jobRows) {
          if (!row.modelId || !row.modelName) continue;
          if (loadStartedAt !== null && now() - loadStartedAt >= CATCH_UP_LOAD_BUDGET_MS) break;
          loadStartedAt ??= now();
          try {
            await load({ projectId: row.projectPublicId, modelId: row.modelId, modelName: row.modelName }, session);
            await deps.markTerminal({ executionId, status: "Completed", projectId: row.projectPublicId }, session);
            retired.add(catchUpRowKey(row));
            logger.info("[yolo] catch-up loaded a completed job nobody was polling", { jobName: executionId, projectId: row.projectPublicId });
          } catch (err) {
            logger.warn("[yolo] catch-up step failed; the browser will retry", { jobName: executionId, error: String(err).slice(0, 300) });
          }
        }
      } else if (missing) {
        for (const row of jobRows) {
          try {
            const started = row.startedAt ? new Date(row.startedAt).getTime() : NaN;
            if (Number.isFinite(started) && now() - started >= NEVER_STARTED_MIN_AGE_MS) {
              await deps.markTerminal({ executionId, status: "Failed", projectId: row.projectPublicId }, session);
              retired.add(catchUpRowKey(row));
            }
          } catch (err) {
            logger.warn("[yolo] catch-up step failed; the browser will retry", { jobName: executionId, error: String(err).slice(0, 300) });
          }
        }
      }
    }
  } catch (err) {
    logger.warn("[yolo] catch-up skipped", { error: String(err).slice(0, 300) });
  }
  return retired;
}
