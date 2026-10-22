// [2026-10-22 bulk YOLO incident] Admin › Data tools › Stuck jobs, YOLO rows (root only).
//   POST /api/admin/stuck-jobs/yolo-stop  {executionId} | {all:true, confirm:"STOP ALL", companyId?}
//        InProgress → StopProcessingJob (rows close once SageMaker reports Stopped: Fix / Fix all).
//        Already Failed/Stopped, or confirmed absent ≥ 3 min → the rows are closed right away.
//   POST /api/admin/stuck-jobs/yolo-fix   {all:true, companyId?}
//        Closes every running YOLO row SageMaker attests Failed/Stopped or confirms absent (≥ 3 min).
//        Completed rows are left for the catch-up loader (AI Models page) so results are not lost.
// Every close goes through updateRunningJob, which re-reads SageMaker itself (no trust in this list).
// One Describe per job name (a batched job has up to 9 rows), ≤ 50 names per request.

import { z } from "zod";
import { audit } from "@/lib/audit";
import { getYoloJobStatus, stopYoloJob } from "@/lib/yolo";
import { awsErrorFacts } from "@/lib/yolo-start-errors";
import type { AuthSession } from "@/lib/api-utils";
import { ApiError } from "@/server/api/envelope";
import { isSagemakerJobNotFound, updateRunningJob, YOLO_NEVER_STARTED_MIN_AGE_MS } from "@/server/services/running-jobs";
import { runningJobRows, scopeCompanyId } from "@/server/services/stuck-jobs";

export const YOLO_STOP_ALL_PHRASE = "STOP ALL";
const MAX_NAMES = 50;

export const zStuckYoloStopBody = z.union([
  z.object({ executionId: z.string().min(1).max(63) }).strict(),
  z
    .object({ all: z.literal(true), confirm: z.literal(YOLO_STOP_ALL_PHRASE), companyId: z.number().int().positive().optional() })
    .strict(),
]);
export const zStuckYoloFixBody = z.object({ all: z.literal(true), companyId: z.number().int().positive().optional() }).strict();

type Row = Awaited<ReturnType<typeof runningJobRows>>[number];
type Provider = { status: string } | { status: "NotFound" } | { status: "Unknown"; reason: string };

export interface YoloStuckOutcome {
  executionId: string;
  projects: number;
  action: "stop-requested" | "closed" | "left" | "failed";
  message: string;
}

async function yoloRows(session: AuthSession, companyId: number | undefined, executionId?: string): Promise<Map<string, Row[]>> {
  if (!session.user.isRootAdmin) throw new ApiError("FORBIDDEN", "Root only");
  const rows = await runningJobRows(scopeCompanyId(session, companyId), false);
  const byName = new Map<string, Row[]>();
  for (const row of rows) {
    if (row.modelConfig === null || !row.executionId) continue;
    if (executionId !== undefined && row.executionId !== executionId) continue;
    byName.set(row.executionId, [...(byName.get(row.executionId) ?? []), row]);
  }
  return byName;
}

async function describe(name: string): Promise<Provider> {
  try {
    return { status: (await getYoloJobStatus(name)).status };
  } catch (error) {
    if (isSagemakerJobNotFound(error)) return { status: "NotFound" };
    return { status: "Unknown", reason: `SageMaker lookup failed (${awsErrorFacts(error).name})` };
  }
}

const oldEnough = (rows: Row[], nowMs: number) =>
  rows.every((r) => !r.startedAt || nowMs - r.startedAt.getTime() >= YOLO_NEVER_STARTED_MIN_AGE_MS);

/** Close each row through updateRunningJob (it re-reads SageMaker and refuses a non-terminal job). */
async function closeRows(session: AuthSession, name: string, rows: Row[]): Promise<YoloStuckOutcome> {
  const refusals: string[] = [];
  for (const row of rows) {
    try {
      await updateRunningJob({ executionId: name, status: "Failed", projectId: row.projectPublicId }, session);
    } catch (error) {
      refusals.push(error instanceof ApiError ? error.message : "close failed");
    }
  }
  const closed = rows.length - refusals.length;
  return {
    executionId: name,
    projects: rows.length,
    action: closed > 0 ? "closed" : "failed",
    message: refusals.length === 0 ? `Closed ${closed} row(s)` : `Closed ${closed}/${rows.length}: ${refusals[0]}`,
  };
}

/** Terminal (Failed/Stopped) or confirmed absent and ≥ 3 min old → closable now. */
function closable(p: Provider, rows: Row[], nowMs: number): boolean {
  return p.status === "Failed" || p.status === "Stopped" || (p.status === "NotFound" && oldEnough(rows, nowMs));
}

function leftMessage(p: Provider): string {
  if (p.status === "NotFound") return "SageMaker has no such job yet; Fix closes it 3 minutes after the start";
  if (p.status === "Unknown") return (p as { reason: string }).reason;
  if (p.status === "Completed") return "Completed — its results load from the AI Models page; Fix on the row closes it without loading";
  return `SageMaker reports ${p.status}`;
}

export async function stopStuckYolo(session: AuthSession, body: z.infer<typeof zStuckYoloStopBody>): Promise<unknown> {
  const single = "executionId" in body;
  const byName = await yoloRows(session, single ? undefined : body.companyId, single ? body.executionId : undefined);
  if (single && byName.size === 0) throw new ApiError("NOT_FOUND", "No running YOLO row for this job");
  const nowMs = Date.now();
  const outcomes: YoloStuckOutcome[] = [];
  for (const [name, rows] of [...byName].slice(0, MAX_NAMES)) {
    const p = await describe(name);
    if (p.status === "InProgress") {
      try {
        await stopYoloJob(name);
        outcomes.push({ executionId: name, projects: rows.length, action: "stop-requested", message: "Stop requested; Fix closes the rows once SageMaker reports Stopped" });
      } catch (error) {
        const f = awsErrorFacts(error);
        outcomes.push({ executionId: name, projects: rows.length, action: "failed", message: `StopProcessingJob refused (${f.name}): ${f.message}` });
      }
    } else if (closable(p, rows, nowMs)) {
      outcomes.push(await closeRows(session, name, rows));
    } else {
      outcomes.push({ executionId: name, projects: rows.length, action: "left", message: leftMessage(p) });
    }
  }
  audit("admin.stuck_jobs.yolo_stop", {
    userId: session.user.dbId,
    companyId: session.user.companyId,
    details: { all: !single, outcomes: outcomes.map((o) => ({ executionId: o.executionId, action: o.action })) },
  });
  return { outcomes, remaining: Math.max(0, byName.size - MAX_NAMES) };
}

export async function fixStuckYolo(session: AuthSession, body: z.infer<typeof zStuckYoloFixBody>): Promise<unknown> {
  const byName = await yoloRows(session, body.companyId);
  const nowMs = Date.now();
  const outcomes: YoloStuckOutcome[] = [];
  for (const [name, rows] of [...byName].slice(0, MAX_NAMES)) {
    const p = await describe(name);
    outcomes.push(
      closable(p, rows, nowMs)
        ? await closeRows(session, name, rows)
        : { executionId: name, projects: rows.length, action: "left", message: leftMessage(p) },
    );
  }
  const closed = outcomes.filter((o) => o.action === "closed");
  if (closed.length > 0) {
    audit("admin.stuck_jobs.yolo_fix", {
      userId: session.user.dbId,
      companyId: session.user.companyId,
      details: { closed: closed.map((o) => ({ executionId: o.executionId, projects: o.projects })) },
    });
  }
  return { outcomes, remaining: Math.max(0, byName.size - MAX_NAMES) };
}
