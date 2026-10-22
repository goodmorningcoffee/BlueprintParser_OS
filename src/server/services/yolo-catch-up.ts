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
// Bounded per request (CATCH_UP_MAX_JOBS describes, CATCH_UP_MAX_LOADS loads). NEVER THROWS.

import type { AuthSession } from "@/lib/api-utils";
import { getYoloJobStatus } from "@/lib/yolo";
import { isSageMakerNotFoundError } from "@/lib/yolo-instances";
import { logger } from "@/lib/logger";

export const CATCH_UP_MAX_JOBS = 10;
export const CATCH_UP_MAX_LOADS = 2;
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
  markTerminal(body: { executionId: string; status: "Completed" | "Failed" }, session: AuthSession): Promise<unknown>;
  /** services/yolo yoloLoad with an explicit session. */
  load?(body: { projectId: string; modelId: number; modelName: string }, session: AuthSession): Promise<unknown>;
  now?: () => number;
}

async function defaultLoad(body: { projectId: string; modelId: number; modelName: string }, session: AuthSession) {
  const { yoloLoad } = await import("@/server/services/yolo");
  return yoloLoad(body, session);
}

/** Returns the execution ids this call retired from the running list. */
export async function catchUpYoloJobs(
  session: AuthSession,
  rows: readonly CatchUpRow[],
  deps: CatchUpDeps,
): Promise<Set<string>> {
  const retired = new Set<string>();
  try {
    const now = deps.now ?? Date.now;
    const load = deps.load ?? defaultLoad;
    const candidates = rows.filter((r) => r.executionId && r.projectPublicId).slice(-CATCH_UP_MAX_JOBS);
    const answers = await Promise.all(
      candidates.map(async (row) => {
        try {
          const s = await getYoloJobStatus(row.executionId);
          return { row, status: typeof s?.status === "string" ? s.status : null, missing: false };
        } catch (err) {
          return { row, status: null, missing: isSageMakerNotFoundError(err) };
        }
      }),
    );
    let loads = 0;
    for (const { row, status, missing } of answers) {
      try {
        if (status === "Completed" && row.modelId && row.modelName && loads < CATCH_UP_MAX_LOADS) {
          loads += 1;
          await load({ projectId: row.projectPublicId, modelId: row.modelId, modelName: row.modelName }, session);
          await deps.markTerminal({ executionId: row.executionId, status: "Completed" }, session);
          retired.add(row.executionId);
          logger.info("[yolo] catch-up loaded a completed job nobody was polling", { jobName: row.executionId });
        } else if (missing) {
          const started = row.startedAt ? new Date(row.startedAt).getTime() : NaN;
          if (Number.isFinite(started) && now() - started >= NEVER_STARTED_MIN_AGE_MS) {
            await deps.markTerminal({ executionId: row.executionId, status: "Failed" }, session);
            retired.add(row.executionId);
          }
        }
      } catch (err) {
        logger.warn("[yolo] catch-up step failed; the browser will retry", { jobName: row.executionId, error: String(err).slice(0, 300) });
      }
    }
  } catch (err) {
    logger.warn("[yolo] catch-up skipped", { error: String(err).slice(0, 300) });
  }
  return retired;
}
