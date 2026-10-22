// [2026-10-22 owner: "take full advantage of the larger GPU and its larger quota" · "if there is a quota
// of ten, I should be able to say use 5 or all 10"] Plans a bulk YOLO run as SageMaker jobs ("chunks"):
// each job serves up to MAX_PROJECTS_PER_YOLO_JOB projects (SageMaker allows 10 ProcessingInputs and
// 10 ProcessingOutputs: 9 projects + the model input), and the admin picks how many machines run at
// once (N). Pure and client-safe; the server re-checks the per-job project bound.
//
//   chunks = max(ceil(projects / 9), min(N, projects), ceil(pages / pages-that-fit-the-budget))
//   projects are placed largest-first into the lightest chunk (by page count) that has room (< 9
//   projects) and stays within the budget (80% of the job timeout); a chunk opens when none does.
//   The plan is deterministic: equal inputs → equal chunks, ties broken by input order.
//
// Runtime of one job ≈ startup + pages × s/page ÷ GPUs — the inference script shares every page of
// the job across all GPUs of the machine (scripts/yolo_inference.py).

export const MAX_PROJECTS_PER_YOLO_JOB = 9;
export const YOLO_JOB_TIMEOUT_FRACTION = 0.8;

export interface YoloChunkTiming {
  startupSeconds: number;
  secondsPerPage: number;
}

export interface YoloChunkProject {
  id: string;
  /** null/0 = unknown (the server refuses such a project; it weighs nothing here). */
  pages: number | null | undefined;
}

export interface YoloChunkPlanOptions {
  /** Machines (jobs) running at once — the admin's N. */
  machines: number;
  /** GPUs per machine (0 for a CPU type is treated as one device). */
  gpusPerMachine: number;
  timing: YoloChunkTiming;
  maxRuntimeSeconds: number;
  maxProjectsPerJob?: number;
}

export interface YoloChunk {
  projectIds: string[];
  pages: number;
  /** Estimated job runtime (startup included). */
  seconds: number;
  /** A single project whose own estimate exceeds the budget; it runs alone and may hit the timeout. */
  overBudget: boolean;
}

const pagesOf = (p: number | null | undefined) => (typeof p === "number" && Number.isFinite(p) && p > 0 ? p : 0);

export function yoloJobSeconds(pages: number, gpus: number, timing: YoloChunkTiming): number {
  return timing.startupSeconds + (pages * timing.secondsPerPage) / Math.max(1, Math.floor(gpus) || 1);
}

/** Pages one job may carry and still finish within YOLO_JOB_TIMEOUT_FRACTION of the timeout. */
export function yoloJobPageBudget(gpus: number, timing: YoloChunkTiming, maxRuntimeSeconds: number): number {
  const seconds = YOLO_JOB_TIMEOUT_FRACTION * maxRuntimeSeconds - timing.startupSeconds;
  if (!(timing.secondsPerPage > 0)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (seconds * Math.max(1, Math.floor(gpus) || 1)) / timing.secondsPerPage);
}

export function planYoloChunks(projects: readonly YoloChunkProject[], opts: YoloChunkPlanOptions): YoloChunk[] {
  const maxPer = Math.max(1, Math.min(MAX_PROJECTS_PER_YOLO_JOB, Math.floor(opts.maxProjectsPerJob ?? MAX_PROJECTS_PER_YOLO_JOB)));
  const seen = new Set<string>();
  const items: Array<{ id: string; pages: number; order: number }> = [];
  for (const p of projects) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    items.push({ id: p.id, pages: pagesOf(p.pages), order: items.length });
  }
  const n = items.length;
  if (n === 0) return [];

  const budget = yoloJobPageBudget(opts.gpusPerMachine, opts.timing, opts.maxRuntimeSeconds);
  const totalPages = items.reduce((sum, i) => sum + i.pages, 0);
  const machines = Math.max(1, Math.floor(opts.machines) || 1);
  const byBudget = Number.isFinite(budget) && budget > 0 ? Math.ceil(totalPages / budget) : 1;
  const initial = Math.min(n, Math.max(Math.ceil(n / maxPer), Math.min(machines, n), byBudget));

  const bins: Array<{ members: typeof items; pages: number }> = Array.from({ length: initial }, () => ({ members: [], pages: 0 }));
  const sorted = [...items].sort((a, b) => b.pages - a.pages || a.order - b.order);
  for (const item of sorted) {
    let best = -1;
    for (let i = 0; i < bins.length; i += 1) {
      const bin = bins[i];
      if (bin.members.length >= maxPer) continue;
      if (bin.members.length > 0 && bin.pages + item.pages > budget) continue;
      if (
        best === -1 ||
        bin.pages < bins[best].pages ||
        (bin.pages === bins[best].pages && bin.members.length < bins[best].members.length)
      ) {
        best = i;
      }
    }
    if (best === -1) {
      bins.push({ members: [], pages: 0 });
      best = bins.length - 1;
    }
    bins[best].members.push(item);
    bins[best].pages += item.pages;
  }

  return bins
    .filter((b) => b.members.length > 0)
    .map((b) => {
      const members = [...b.members].sort((x, y) => x.order - y.order);
      return {
        projectIds: members.map((m) => m.id),
        pages: b.pages,
        seconds: yoloJobSeconds(b.pages, opts.gpusPerMachine, opts.timing),
        overBudget: b.pages > budget,
      };
    });
}

export interface YoloBatchRunEstimate {
  jobs: number;
  pages: number;
  usd: number;
  /** Estimated wall clock: the chunks started in plan order on N machines (list scheduling). */
  wallSeconds: number;
  /** ceil(jobs / N): how many rounds of machines the queue needs. */
  waves: number;
  /** Jobs whose estimate exceeds the timeout itself (SageMaker stops them there). */
  overTimeout: number;
  longestJobSeconds: number;
}

export function estimateYoloBatchRun(
  chunks: readonly Pick<YoloChunk, "pages" | "seconds">[],
  machines: number,
  usdPerHour: number,
  maxRuntimeSeconds: number,
): YoloBatchRunEstimate {
  const slots = Array.from({ length: Math.max(1, Math.floor(machines) || 1) }, () => 0);
  let billed = 0;
  let overTimeout = 0;
  let longest = 0;
  let pages = 0;
  for (const c of chunks) {
    const runtime = Math.min(c.seconds, maxRuntimeSeconds);
    if (c.seconds > maxRuntimeSeconds) overTimeout += 1;
    longest = Math.max(longest, c.seconds);
    billed += runtime;
    pages += c.pages;
    let slot = 0;
    for (let i = 1; i < slots.length; i += 1) if (slots[i] < slots[slot]) slot = i;
    slots[slot] += runtime;
  }
  return {
    jobs: chunks.length,
    pages,
    usd: (billed * usdPerHour) / 3600,
    wallSeconds: chunks.length ? Math.max(...slots) : 0,
    waves: chunks.length ? Math.ceil(chunks.length / slots.length) : 0,
    overTimeout,
    longestJobSeconds: longest,
  };
}
