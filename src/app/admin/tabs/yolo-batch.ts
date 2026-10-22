// Bulk YOLO run/load queue for Admin › AI Models (owner 2026-10-21: "run all of a single model across
// all the plans, as well as load all"). Kept free of fetch/React so it can be unit-tested; the
// YoloBulkBar injects the network steps, which reuse the admin page's own runYolo/loadYoloResults.
//
// Run mode — up to `concurrency` (default 2) SageMaker jobs at once:
//   • a row already Running/Loading/… is skipped, never started twice;
//   • a SageMaker capacity refusal (ResourceLimitExceeded → 429 "No SageMaker quota for <type>", or
//     any other 429) PAUSES new starts and retries after 60 s — and, while this queue's own jobs hold
//     the capacity, until one of them finishes — instead of failing the batch. After
//     `maxIdleQuotaRetries` refusals with nothing of ours running, the queue stops new starts;
//   • a daily/page "limit reached" refusal stops new starts at once (retrying cannot succeed);
//   • each started job is polled through the existing status endpoint; on Completed its result is
//     loaded automatically (autoLoad, default on); one failure never stops the rest.
// [2026-10-22] Batched run mode (root; options.chunks + deps.startBatch) — the planner
// (src/lib/yolo-chunk-plan.ts) groups the projects into SageMaker jobs of ≤ 9 and `concurrency` counts
// JOBS, not projects. One status poll per job; on Completed every project of the job is loaded in
// turn; a project the server refused is failed alone while the rest of its job runs. Capacity / limit
// refusals behave as above, per job.
// [2026-10-22 incident: 15 chunk starts within 3 s, 9 throttled into phantom rows] Starts are spaced
// (at most one per `startSpacingMs`, default 3 s). A 429 / RETRYABLE refusal requeues the job, backs
// off exponentially (throttling from 5 s, quota / capacity from 60 s, capped at 2 min) and lowers the
// effective concurrency by 1 (min 1); each successful start raises it by 1 again, up to "Machines at
// once". A job that ends Failed with a CapacityError / InsufficientCapacity reason is requeued up to
// `maxCapacityRetries` (3) times with backoff before its projects are marked failed.
// Load mode — sequential loads.
// stop() ends NEW starts/loads only: jobs already running finish on AWS and are still loaded.
// The queue lives in the browser tab: closing the tab stops new starts (see YoloBulkBar).

import { batchSummary } from "./yolo-batch-summary";

export { batchCounts, batchSummary, type YoloBatchCounts } from "./yolo-batch-summary";

/** The same status prefixes that disable a row's Run button in AiModelsTab. */
export const BUSY_STATUS = /^(Running|Rasterizing|InProgress|Loading|Waiting|starting)/;

export const DEFAULT_CONCURRENCY = 2;
export const QUOTA_RETRY_MS = 60_000;
export const POLL_MS = 10_000;
export const LOAD_DELAY_MS = 3_000;
export const MAX_IDLE_QUOTA_RETRIES = 5;
export const MAX_STATUS_FAILURES = 30;
/** Minimum gap between two job starts (SageMaker throttles CreateProcessingJob bursts). */
export const START_SPACING_MS = 3_000;
/** First backoff after a throttling refusal; doubles per consecutive refusal up to MAX_BACKOFF_MS. */
export const THROTTLE_RETRY_MS = 5_000;
export const MAX_BACKOFF_MS = 120_000;
/** Requeues of a job that ended Failed for lack of provider capacity, before it is failed. */
export const MAX_CAPACITY_RETRIES = 3;

const TERMINAL = new Set(["Completed", "Failed", "Stopped"]);

export type YoloBatchMode = "run" | "load";
export type YoloBatchPhase =
  | "queued"
  | "starting"
  | "running"
  | "loading"
  | "done"
  | "failed"
  | "skipped"
  | "not-started";

export interface YoloBatchTarget {
  projectId: string;
  projectName: string;
}

export interface YoloBatchItem extends YoloBatchTarget {
  phase: YoloBatchPhase;
  jobName?: string;
  message?: string;
}

/** POST /api/yolo/run-batch's answer (or the refusal of the whole job). */
export interface YoloBatchStartResult {
  jobName?: string;
  projects?: Array<{ projectId: string; status: "running" | "refused"; error?: string; httpStatus?: number }>;
  error?: string;
  httpStatus?: number;
  /** The envelope's error code (RETRYABLE = throttling / capacity: requeue). */
  code?: string;
}

/** What the admin page's runYolo(projectId, modelId, bulk=true) resolves to. */
export interface YoloStartResult {
  jobName?: string;
  error?: string;
  httpStatus?: number;
  code?: string;
}

export interface YoloJobStatus {
  status: string;
  failureReason?: string;
}

export interface YoloBatchDeps {
  /** POST /api/yolo/run via the page's runYolo (bulk: no page-side polling). */
  start(projectId: string, modelId: number): Promise<YoloStartResult | undefined | void>;
  /** GET /api/yolo/status. null = transient failure (keep polling). */
  status(jobName: string): Promise<YoloJobStatus | null>;
  /** PUT /api/admin/running-jobs with the terminal status (best-effort); projectId picks a batched job's row. */
  markTerminal(jobName: string, status: string, projectId?: string): Promise<void>;
  /** POST /api/yolo/run-batch for one planned chunk (batched run mode only). */
  startBatch?(projectIds: string[], modelId: number): Promise<YoloBatchStartResult>;
  /** Debug event sink (the AI Models debug report). */
  log?(kind: string, msg: string, data?: unknown): void;
  /** POST /api/yolo/load via the page's loadYoloResults; resolves to the row's final status text. */
  load(projectId: string, modelId: number, modelName: string): Promise<string | void>;
  /** True while the row shows a busy status (Running, Loading, …). */
  isBusy(projectId: string, modelId: number): boolean;
  /**
   * A started job reached a provider-confirmed Failed/Stopped end. The page's row text still says
   * "Running: <job>" (the queue, not the page, polled it), so the bar records the terminal text here
   * and the row becomes retryable. NOT called when the queue gives up on an unreadable status: that
   * job may still be live, so its row stays busy until a page reload re-derives it.
   */
  jobEnded?(jobName: string, message: string): void;
  sleep(ms: number): Promise<void>;
}

export interface YoloBatchOptions {
  concurrency?: number;
  /** Batched run mode: the planned jobs, as project ids (needs deps.startBatch). */
  chunks?: readonly (readonly string[])[];
  autoLoad?: boolean;
  pollMs?: number;
  quotaRetryMs?: number;
  loadDelayMs?: number;
  maxIdleQuotaRetries?: number;
  maxStatusFailures?: number;
  startSpacingMs?: number;
  throttleRetryMs?: number;
  maxBackoffMs?: number;
  maxCapacityRetries?: number;
}

export interface YoloBatchSnapshot {
  mode: YoloBatchMode;
  modelId: number;
  modelName: string;
  items: readonly YoloBatchItem[];
  pausedForQuota: boolean;
  stopped: boolean;
  finished: boolean;
  haltReason?: string;
  /** Jobs allowed at once right now (lowered by refusals, ≤ maxConcurrency). */
  effectiveConcurrency?: number;
  /** The admin's "Machines at once". */
  maxConcurrency?: number;
  /** Refused starts + capacity-failed jobs put back in the queue. */
  retries?: number;
  /** Current backoff before the next start, while paused. */
  retryInMs?: number | null;
}

export type StartRefusal = "capacity" | "limit" | "error";

/** capacity → pause and retry; limit → stop new starts; error → this row failed, carry on. */
export function classifyStartRefusal(r: YoloStartResult): StartRefusal {
  const msg = r.error ?? "";
  if (r.code === "RETRYABLE") return "capacity";
  if (/ResourceLimitExceeded|No SageMaker quota/iu.test(msg)) return "capacity";
  if (r.httpStatus === 429) return /limit reached/iu.test(msg) ? "limit" : "capacity";
  return "error";
}

/** A job SageMaker ended Failed because no instance could be provisioned (worth a requeue). */
export function isCapacityFailure(failureReason: string | undefined): boolean {
  return /^\s*(CapacityError|InsufficientCapacity)/iu.test(failureReason ?? "");
}

const isQuotaText = (msg: string) => /ResourceLimitExceeded|No SageMaker quota/iu.test(msg);

/** The page's load status strings: "Completed — N detections loaded" / "Loaded N (errors: …)". */
export function isLoadSuccess(message: string): boolean {
  return /^(Completed|Loaded)\b/u.test(message);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class YoloBatch {
  readonly mode: YoloBatchMode;
  readonly modelId: number;
  readonly modelName: string;
  private readonly deps: YoloBatchDeps;
  private readonly opts: Required<Omit<YoloBatchOptions, "chunks">>;
  private readonly chunkQueue: string[][] | null;
  private items: YoloBatchItem[];
  private stopped = false;
  private finished = false;
  private haltReason: string | undefined;
  private pauseGate: Promise<void> | null = null;
  private activeJobs = 0;
  private completions = 0;
  private idleQuotaStrikes = 0;
  private readonly stopWaiters: Array<() => void> = [];
  private slotWaiters: Array<() => void> = [];
  private effLimit: number;
  private retries = 0;
  private refusalStreak = 0;
  private retryInMs: number | null = null;
  private readonly failRetries = new Map<string, number>();
  private turnTail: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(s: YoloBatchSnapshot) => void>();
  private current: YoloBatchSnapshot;

  constructor(
    mode: YoloBatchMode,
    model: { id: number; name: string },
    targets: readonly YoloBatchTarget[],
    deps: YoloBatchDeps,
    options: YoloBatchOptions = {},
  ) {
    this.mode = mode;
    this.modelId = model.id;
    this.modelName = model.name;
    this.deps = deps;
    this.opts = {
      concurrency: Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY)),
      autoLoad: options.autoLoad ?? true,
      pollMs: options.pollMs ?? POLL_MS,
      quotaRetryMs: options.quotaRetryMs ?? QUOTA_RETRY_MS,
      loadDelayMs: options.loadDelayMs ?? LOAD_DELAY_MS,
      maxIdleQuotaRetries: options.maxIdleQuotaRetries ?? MAX_IDLE_QUOTA_RETRIES,
      maxStatusFailures: options.maxStatusFailures ?? MAX_STATUS_FAILURES,
      startSpacingMs: options.startSpacingMs ?? START_SPACING_MS,
      throttleRetryMs: options.throttleRetryMs ?? THROTTLE_RETRY_MS,
      maxBackoffMs: options.maxBackoffMs ?? MAX_BACKOFF_MS,
      maxCapacityRetries: options.maxCapacityRetries ?? MAX_CAPACITY_RETRIES,
    };
    this.effLimit = this.opts.concurrency;
    const seen = new Set<string>();
    this.items = [];
    for (const t of targets) {
      if (seen.has(t.projectId)) continue;
      seen.add(t.projectId);
      this.items.push({ projectId: t.projectId, projectName: t.projectName, phase: "queued" });
    }
    this.chunkQueue =
      mode === "run" && options.chunks && deps.startBatch
        ? options.chunks.map((c) => c.filter((id) => seen.has(id))).filter((c) => c.length > 0)
        : null;
    this.current = this.buildSnapshot();
  }

  snapshot(): YoloBatchSnapshot {
    return this.current;
  }

  subscribe(fn: (s: YoloBatchSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** No new starts/loads. Jobs already running keep being polled and loaded. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const wake of this.stopWaiters.splice(0)) wake();
    this.emit();
  }

  async run(): Promise<YoloBatchSnapshot> {
    this.debug("queue", `${this.mode} ${this.modelName}: ${this.items.length} project(s)`, {
      concurrency: this.opts.concurrency,
      chunks: this.chunkQueue,
    });
    if (this.mode === "run" && this.chunkQueue) {
      const workers = Array.from({ length: this.opts.concurrency }, () => this.runChunkWorker());
      await Promise.all(workers);
    } else if (this.mode === "run") {
      const workers = Array.from({ length: this.opts.concurrency }, () => this.runWorker());
      await Promise.all(workers);
    } else {
      await this.loadAll();
    }
    for (const item of this.items) {
      if (item.phase === "queued" || item.phase === "starting") {
        this.patch(item, {
          phase: "not-started",
          message: this.haltReason ? `Not started — ${this.haltReason}` : "Not started — queue stopped",
        });
      }
    }
    this.finished = true;
    this.debug("queue", "finished", { summary: batchSummary(this.buildSnapshot()) });
    this.emit();
    return this.current;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private debug(kind: string, msg: string, data?: unknown): void {
    try {
      this.deps.log?.(kind, msg, data);
    } catch {
      /* never let debugging break the queue */
    }
  }

  private buildSnapshot(): YoloBatchSnapshot {
    return {
      mode: this.mode,
      modelId: this.modelId,
      modelName: this.modelName,
      items: this.items.map((i) => ({ ...i })),
      pausedForQuota: this.pauseGate !== null && !this.stopped,
      stopped: this.stopped,
      finished: this.finished,
      ...(this.haltReason ? { haltReason: this.haltReason } : {}),
      effectiveConcurrency: this.effLimit,
      maxConcurrency: this.opts.concurrency,
      retries: this.retries,
      retryInMs: this.pauseGate !== null && !this.stopped ? this.retryInMs : null,
    };
  }

  private emit(): void {
    this.current = this.buildSnapshot();
    for (const fn of this.listeners) fn(this.current);
  }

  private patch(item: YoloBatchItem, next: Partial<YoloBatchItem>): void {
    Object.assign(item, next);
    this.emit();
  }

  /** Resolves after `ms`, or at once when the queue is stopped. */
  private wait(ms: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      this.stopWaiters.push(finish);
      this.deps.sleep(ms).then(finish, finish);
    });
  }

  private waitForSlot(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.slotWaiters.push(resolve);
      this.stopWaiters.push(resolve);
    });
  }

  private jobFinished(): void {
    this.activeJobs -= 1;
    this.completions += 1;
    this.idleQuotaStrikes = 0;
    const waiters = this.slotWaiters;
    this.slotWaiters = [];
    for (const wake of waiters) wake();
  }

  /**
   * One start turn at a time; the turn reopens `startSpacingMs` after a start was attempted
   * (at once when none was). Resolves to the release function.
   */
  private startTurn(): Promise<(attempted: boolean) => void> {
    const prev = this.turnTail;
    let open!: () => void;
    this.turnTail = new Promise<void>((resolve) => {
      open = resolve;
    });
    return prev.then(() => (attempted: boolean) => {
      if (attempted && this.opts.startSpacingMs > 0) void this.wait(this.opts.startSpacingMs).then(open);
      else open();
    });
  }

  /** True when a worker may not start now (it re-checks after the pause / a slot / the turn). */
  private mustWait(): boolean {
    return this.pauseGate !== null || this.activeJobs >= this.effLimit;
  }

  private startSucceeded(): void {
    this.refusalStreak = 0;
    if (this.effLimit < this.opts.concurrency) {
      this.effLimit += 1;
      this.debug("concurrency", `effective concurrency ${this.effLimit}/${this.opts.concurrency}`);
    }
  }

  /**
   * A retryable refusal or a capacity-failed job: count it, lower the effective concurrency, back off.
   * `waitForOwnJob`: instance quota — retrying before one of our jobs ends would only be refused.
   */
  private backOff(reason: string, waitForOwnJob: boolean): void {
    this.retries += 1;
    this.refusalStreak += 1;
    this.effLimit = Math.max(1, this.effLimit - 1);
    // Instance quota / provisioning capacity frees up in minutes; throttling in seconds.
    const base = isQuotaText(reason) || isCapacityFailure(reason) ? this.opts.quotaRetryMs : this.opts.throttleRetryMs;
    const delay = Math.min(this.opts.maxBackoffMs, base * 2 ** (this.refusalStreak - 1));
    this.debug("pause", `retry in ${Math.round(delay / 1000)} s; effective concurrency ${this.effLimit}/${this.opts.concurrency}`, {
      reason,
      retries: this.retries,
      waiting: this.items.filter((i) => i.phase === "queued").length,
    });
    this.pauseForCapacity(delay, waitForOwnJob);
  }

  private pauseForCapacity(delayMs: number, waitForOwnJob: boolean): void {
    if (this.pauseGate) return;
    const completionsAtRefusal = this.completions;
    this.retryInMs = delayMs;
    this.pauseGate = (async () => {
      await this.wait(delayMs);
      // Our own running jobs hold the capacity: retrying before one ends would only be refused.
      while (waitForOwnJob && !this.stopped && this.activeJobs > 0 && this.completions === completionsAtRefusal) {
        await this.waitForSlot();
      }
      this.pauseGate = null;
      this.retryInMs = null;
      this.emit();
    })();
    this.emit();
  }

  private byId(projectId: string): YoloBatchItem | undefined {
    return this.items.find((i) => i.projectId === projectId);
  }

  private async runChunkWorker(): Promise<void> {
    const queue = this.chunkQueue!;
    for (;;) {
      if (this.stopped || this.haltReason) return;
      if (this.pauseGate) {
        await this.pauseGate;
        continue;
      }
      if (this.activeJobs >= this.effLimit) {
        if (queue.length === 0) return;
        await this.waitForSlot();
        continue;
      }
      const release = await this.startTurn();
      if (this.stopped || this.haltReason || this.mustWait()) {
        release(false);
        continue;
      }
      const chunk = queue.shift();
      if (!chunk) {
        release(false);
        return;
      }
      const items: YoloBatchItem[] = [];
      for (const id of chunk) {
        const item = this.byId(id);
        if (!item || item.phase !== "queued") continue;
        if (this.deps.isBusy(item.projectId, this.modelId)) {
          this.patch(item, { phase: "skipped", message: "Skipped — already running or loading" });
          continue;
        }
        items.push(item);
      }
      if (items.length === 0) {
        release(false);
        continue;
      }
      for (const item of items) this.patch(item, { phase: "starting", message: undefined });
      const ids = items.map((i) => i.projectId);
      this.debug("start", `run-batch ${ids.length} project(s)`, { projectIds: ids });
      let result: YoloBatchStartResult;
      try {
        result = (await this.deps.startBatch!(ids, this.modelId)) || { error: "Start failed" };
      } catch (err) {
        result = { error: errorText(err) };
      }
      release(true);
      this.debug("start", result.jobName ? `started ${result.jobName}` : `refused: ${result.error ?? "?"}`, result);
      if (result.jobName) {
        this.startSucceeded();
        const running: YoloBatchItem[] = [];
        for (const item of items) {
          const outcome = result.projects?.find((p) => p.projectId === item.projectId);
          if (outcome && outcome.status !== "running") {
            this.patch(item, { phase: "failed", message: outcome.error || "Refused" });
          } else {
            running.push(item);
          }
        }
        if (running.length > 0) await this.trackChunk(running, result.jobName);
        continue;
      }
      const refusal = classifyStartRefusal(result);
      const reason = result.error || "Start failed";
      if (refusal === "error") {
        for (const item of items) this.patch(item, { phase: "failed", message: reason });
        continue;
      }
      // limit / capacity: the job keeps its place at the front of the queue.
      queue.unshift(ids);
      if (refusal === "limit") {
        this.haltReason = reason;
        for (const item of items) this.patch(item, { phase: "queued", message: reason });
        return;
      }
      if (this.activeJobs === 0) this.idleQuotaStrikes += 1;
      if (this.idleQuotaStrikes > this.opts.maxIdleQuotaRetries) {
        this.haltReason = reason;
        for (const item of items) this.patch(item, { phase: "queued", message: reason });
        return;
      }
      for (const item of items) this.patch(item, { phase: "queued", message: `Waiting for SageMaker capacity — ${reason}` });
      this.backOff(reason, isQuotaText(reason));
    }
  }

  /**
   * A job ended Failed for lack of provider capacity: put its projects back (front of the queue)
   * up to maxCapacityRetries times, with backoff. False → the caller fails them as usual.
   */
  private requeueCapacityFailure(items: YoloBatchItem[], failureReason: string | undefined): boolean {
    if (!isCapacityFailure(failureReason) || this.stopped || this.haltReason) return false;
    const key = items.map((i) => i.projectId).join(",");
    const n = (this.failRetries.get(key) ?? 0) + 1;
    if (n > this.opts.maxCapacityRetries) return false;
    this.failRetries.set(key, n);
    const message = `Retry ${n}/${this.opts.maxCapacityRetries} — ${failureReason}`;
    for (const item of items) this.patch(item, { phase: "queued", message });
    if (this.chunkQueue) this.chunkQueue.unshift(items.map((i) => i.projectId));
    this.refusalStreak = Math.max(this.refusalStreak, n - 1); // the started job reset it: back off per attempt
    this.backOff(failureReason ?? "CapacityError", false);
    return true;
  }

  /** Poll one batched job; then mark and (auto)load each of its projects in turn. */
  private async trackChunk(items: YoloBatchItem[], jobName: string): Promise<void> {
    this.activeJobs += 1;
    let slotOpen = true;
    const release = () => {
      if (!slotOpen) return;
      slotOpen = false;
      this.jobFinished();
    };
    for (const item of items) this.patch(item, { phase: "running", jobName, message: `Running: ${jobName}` });
    try {
      let statusFailures = 0;
      let last = "";
      for (;;) {
        await this.deps.sleep(this.opts.pollMs);
        let s: YoloJobStatus | null = null;
        try {
          s = await this.deps.status(jobName);
        } catch {
          s = null;
        }
        if (!s) {
          statusFailures += 1;
          this.debug("poll", `${jobName}: status unavailable (${statusFailures}/${this.opts.maxStatusFailures})`);
          if (statusFailures >= this.opts.maxStatusFailures) {
            release();
            for (const item of items) {
              this.patch(item, { phase: "failed", message: `Status unavailable for ${jobName} — check it after a page reload` });
            }
            return;
          }
          continue;
        }
        statusFailures = 0;
        if (s.status !== last) {
          last = s.status;
          this.debug("poll", `${jobName}: ${s.status}`, s.failureReason ? { failureReason: s.failureReason } : undefined);
        }
        if (!TERMINAL.has(s.status)) continue;

        release();
        // A Completed project row is closed only after ITS load, so a tab closed mid-way leaves the
        // unloaded rows running for the server catch-up (services/yolo-catch-up.ts) to load.
        const mark = (item: YoloBatchItem) => this.deps.markTerminal(jobName, s.status, item.projectId).catch(() => {});
        if (s.status !== "Completed" || !this.opts.autoLoad) for (const item of items) void mark(item);
        if (s.status !== "Completed") {
          const reason = s.failureReason ? `: ${s.failureReason}` : "";
          const message = `${s.status}${reason}`;
          this.deps.jobEnded?.(jobName, message);
          if (s.status === "Failed" && this.requeueCapacityFailure(items, s.failureReason)) return;
          for (const item of items) this.patch(item, { phase: "failed", message });
          return;
        }
        if (!this.opts.autoLoad) {
          this.deps.jobEnded?.(jobName, "Completed — not loaded");
          for (const item of items) this.patch(item, { phase: "done", message: "Completed — not loaded" });
          return;
        }
        for (const item of items) this.patch(item, { phase: "loading", message: "Loading results..." });
        await this.deps.sleep(this.opts.loadDelayMs);
        for (const item of items) {
          await this.loadOne(item);
          if (item.phase === "done") void mark(item); // a failed load stays running: a reload retries it
        }
        return;
      }
    } finally {
      release();
    }
  }

  private nextQueued(): YoloBatchItem | undefined {
    return this.items.find((i) => i.phase === "queued");
  }

  private async runWorker(): Promise<void> {
    for (;;) {
      if (this.stopped || this.haltReason) return;
      if (this.pauseGate) {
        await this.pauseGate;
        continue;
      }
      if (this.activeJobs >= this.effLimit) {
        if (!this.nextQueued()) return;
        await this.waitForSlot();
        continue;
      }
      const release = await this.startTurn();
      if (this.stopped || this.haltReason || this.mustWait()) {
        release(false);
        continue;
      }
      const item = this.nextQueued();
      if (!item) {
        release(false);
        return;
      }
      if (this.deps.isBusy(item.projectId, this.modelId)) {
        release(false);
        this.patch(item, { phase: "skipped", message: "Skipped — already running or loading" });
        continue;
      }
      this.patch(item, { phase: "starting", message: undefined });
      let result: YoloStartResult;
      try {
        result = (await this.deps.start(item.projectId, this.modelId)) || { error: "Start failed" };
      } catch (err) {
        result = { error: errorText(err) };
      }
      release(true);
      if (result.jobName) {
        this.startSucceeded();
        await this.track(item, result.jobName);
        continue;
      }
      const refusal = classifyStartRefusal(result);
      const reason = result.error || "Start failed";
      if (refusal === "error") {
        this.patch(item, { phase: "failed", message: reason });
        continue;
      }
      if (refusal === "limit") {
        this.haltReason = reason;
        this.patch(item, { phase: "queued", message: reason });
        return;
      }
      // capacity: back to the queue (it keeps its place), pause new starts, retry later.
      if (this.activeJobs === 0) this.idleQuotaStrikes += 1;
      if (this.idleQuotaStrikes > this.opts.maxIdleQuotaRetries) {
        this.haltReason = reason;
        this.patch(item, { phase: "queued", message: reason });
        return;
      }
      this.patch(item, { phase: "queued", message: `Waiting for SageMaker capacity — ${reason}` });
      this.backOff(reason, isQuotaText(reason));
    }
  }

  private async track(item: YoloBatchItem, jobName: string): Promise<void> {
    this.activeJobs += 1;
    let slotOpen = true;
    const release = () => {
      if (!slotOpen) return;
      slotOpen = false;
      this.jobFinished();
    };
    this.patch(item, { phase: "running", jobName, message: `Running: ${jobName}` });
    try {
      let statusFailures = 0;
      for (;;) {
        // Not interruptible by stop(): a started job is always followed to its end.
        await this.deps.sleep(this.opts.pollMs);
        let s: YoloJobStatus | null = null;
        try {
          s = await this.deps.status(jobName);
        } catch {
          s = null;
        }
        if (!s) {
          statusFailures += 1;
          if (statusFailures >= this.opts.maxStatusFailures) {
            release();
            this.patch(item, { phase: "failed", message: `Status unavailable for ${jobName} — check it after a page reload` });
            return;
          }
          continue;
        }
        statusFailures = 0;
        if (!TERMINAL.has(s.status)) continue;

        release();
        this.deps.markTerminal(jobName, s.status).catch(() => {});
        if (s.status !== "Completed") {
          const reason = s.failureReason ? `: ${s.failureReason}` : "";
          const message = `${s.status}${reason}`;
          this.deps.jobEnded?.(jobName, message);
          if (s.status === "Failed" && this.requeueCapacityFailure([item], s.failureReason)) return;
          this.patch(item, { phase: "failed", message });
          return;
        }
        if (!this.opts.autoLoad) {
          this.deps.jobEnded?.(jobName, "Completed — not loaded");
          this.patch(item, { phase: "done", message: "Completed — not loaded" });
          return;
        }
        this.patch(item, { phase: "loading", message: "Loading results..." });
        await this.deps.sleep(this.opts.loadDelayMs);
        await this.loadOne(item);
        return;
      }
    } finally {
      release();
    }
  }

  private async loadOne(item: YoloBatchItem): Promise<void> {
    let message: string;
    try {
      message = (await this.deps.load(item.projectId, this.modelId, this.modelName)) || "Load failed: no result";
    } catch (err) {
      message = `Load failed: ${errorText(err)}`;
    }
    this.debug("load", `${item.projectName}: ${message}`, { projectId: item.projectId });
    this.patch(item, { phase: isLoadSuccess(message) ? "done" : "failed", message });
  }

  private async loadAll(): Promise<void> {
    for (const item of this.items) {
      if (this.stopped) return;
      if (item.phase !== "queued") continue;
      if (this.deps.isBusy(item.projectId, this.modelId)) {
        this.patch(item, { phase: "skipped", message: "Skipped — already running or loading" });
        continue;
      }
      this.patch(item, { phase: "loading", message: "Loading results..." });
      await this.loadOne(item);
    }
  }
}
