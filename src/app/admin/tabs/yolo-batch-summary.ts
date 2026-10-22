// Bulk YOLO queue summary line + counts (split from yolo-batch.ts, 2026-10-22, to stay under MAX_LINES).
import type { YoloBatchSnapshot } from "./yolo-batch";

export interface YoloBatchCounts {
  total: number;
  started: number;
  running: number;
  waiting: number;
  done: number;
  failed: number;
  skipped: number;
  notStarted: number;
}

export function batchCounts(s: YoloBatchSnapshot): YoloBatchCounts {
  const c: YoloBatchCounts = { total: s.items.length, started: 0, running: 0, waiting: 0, done: 0, failed: 0, skipped: 0, notStarted: 0 };
  for (const i of s.items) {
    if (i.jobName) c.started += 1;
    if (i.phase === "queued" || i.phase === "starting") c.waiting += 1;
    else if (i.phase === "running" || i.phase === "loading") c.running += 1;
    else if (i.phase === "done") c.done += 1;
    else if (i.phase === "failed") c.failed += 1;
    else if (i.phase === "skipped") c.skipped += 1;
    else c.notStarted += 1;
  }
  return c;
}

const clip = (text: string, max = 90) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** e.g. "12 started · 3 waiting · 4 loaded · 1 failed (Failed: OOM)". */
export function batchSummary(s: YoloBatchSnapshot): string {
  const c = batchCounts(s);
  const parts: string[] = [];
  if (s.mode === "run") parts.push(`${c.started} started`);
  parts.push(`${c.waiting} waiting`);
  if (s.mode === "run" && c.running > 0) parts.push(`${c.running} running`);
  if (s.mode === "load" && c.running > 0) parts.push(`${c.running} loading`);
  if (c.done > 0) parts.push(s.items.some((i) => i.message === "Completed — not loaded") ? `${c.done} done` : `${c.done} loaded`);
  if (c.failed > 0) {
    const first = s.items.find((i) => i.phase === "failed")?.message;
    parts.push(first ? `${c.failed} failed (${clip(first)})` : `${c.failed} failed`);
  }
  if (c.skipped > 0) parts.push(`${c.skipped} skipped (already running)`);
  if (c.notStarted > 0) {
    parts.push(`${c.notStarted} not started (${clip(s.haltReason ?? "queue stopped")})`);
  }
  const retries = s.retries ?? 0;
  if (retries > 0) parts.push(`${retries} ${retries === 1 ? "retry" : "retries"}`);
  if (s.mode === "run" && !s.finished && s.effectiveConcurrency !== undefined && s.maxConcurrency !== undefined && s.effectiveConcurrency < s.maxConcurrency) {
    parts.push(`${s.effectiveConcurrency}/${s.maxConcurrency} machines at once`);
  }
  let line = parts.join(" · ");
  if (s.pausedForQuota) line += ` · paused: SageMaker capacity — retrying in ${Math.round((s.retryInMs ?? 0) / 1000)} s`;
  else if (s.haltReason && !s.finished) line += ` · stopped new starts: ${clip(s.haltReason)}`;
  else if (s.stopped && !s.finished) line += " · stopping: running jobs will finish and load";
  return s.finished ? `Finished — ${line}` : line;
}
