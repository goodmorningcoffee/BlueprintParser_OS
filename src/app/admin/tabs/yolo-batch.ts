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
// Load mode — sequential loads.
// stop() ends NEW starts/loads only: jobs already running finish on AWS and are still loaded.
// The queue lives in the browser tab: closing the tab stops new starts (see YoloBulkBar).

/** The same status prefixes that disable a row's Run button in AiModelsTab. */
export const BUSY_STATUS = /^(Running|Rasterizing|InProgress|Loading|Waiting|starting)/;

export const DEFAULT_CONCURRENCY = 2;
export const QUOTA_RETRY_MS = 60_000;
export const POLL_MS = 10_000;
export const LOAD_DELAY_MS = 3_000;
export const MAX_IDLE_QUOTA_RETRIES = 5;
export const MAX_STATUS_FAILURES = 30;

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

/** What the admin page's runYolo(projectId, modelId, bulk=true) resolves to. */
export interface YoloStartResult {
  jobName?: string;
  error?: string;
  httpStatus?: number;
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
  /** PUT /api/admin/running-jobs with the terminal status (best-effort). */
  markTerminal(jobName: string, status: string): Promise<void>;
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
  autoLoad?: boolean;
  pollMs?: number;
  quotaRetryMs?: number;
  loadDelayMs?: number;
  maxIdleQuotaRetries?: number;
  maxStatusFailures?: number;
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
}

export type StartRefusal = "capacity" | "limit" | "error";

/** capacity → pause and retry; limit → stop new starts; error → this row failed, carry on. */
export function classifyStartRefusal(r: YoloStartResult): StartRefusal {
  const msg = r.error ?? "";
  if (/ResourceLimitExceeded|No SageMaker quota/iu.test(msg)) return "capacity";
  if (r.httpStatus === 429) return /limit reached/iu.test(msg) ? "limit" : "capacity";
  return "error";
}

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
  private readonly opts: Required<YoloBatchOptions>;
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
    };
    const seen = new Set<string>();
    this.items = [];
    for (const t of targets) {
      if (seen.has(t.projectId)) continue;
      seen.add(t.projectId);
      this.items.push({ projectId: t.projectId, projectName: t.projectName, phase: "queued" });
    }
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
    if (this.mode === "run") {
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
    this.emit();
    return this.current;
  }

  // ── internals ──────────────────────────────────────────────────────────────

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

  private pauseForCapacity(): void {
    if (this.pauseGate) return;
    const completionsAtRefusal = this.completions;
    this.pauseGate = (async () => {
      await this.wait(this.opts.quotaRetryMs);
      // Our own running jobs hold the capacity: retrying before one ends would only be refused.
      while (!this.stopped && this.activeJobs > 0 && this.completions === completionsAtRefusal) {
        await this.waitForSlot();
      }
      this.pauseGate = null;
      this.emit();
    })();
    this.emit();
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
      const item = this.nextQueued();
      if (!item) return;
      if (this.deps.isBusy(item.projectId, this.modelId)) {
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
      if (result.jobName) {
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
      this.pauseForCapacity();
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
  let line = parts.join(" · ");
  if (s.pausedForQuota) line += " · paused: SageMaker capacity — retrying in 60 s";
  else if (s.haltReason && !s.finished) line += ` · stopped new starts: ${clip(s.haltReason)}`;
  else if (s.stopped && !s.finished) line += " · stopping: running jobs will finish and load";
  return s.finished ? `Finished — ${line}` : line;
}
