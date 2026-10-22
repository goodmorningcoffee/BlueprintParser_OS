// Bulk YOLO queue (owner 2026-10-21: run/load one model across all plans). Pure module, driven with
// fake timers and a fake SageMaker: concurrency cap, pause-and-retry on a capacity refusal, stop on
// a daily/page limit, skip busy rows, auto-load on completion, stop(), load mode and the summary.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  YoloBatch,
  batchSummary,
  classifyStartRefusal,
  isLoadSuccess,
  type YoloBatchDeps,
  type YoloBatchOptions,
  type YoloStartResult,
} from "../yolo-batch";

const MODEL = { id: 7, name: "doors" };
const QUOTA_429: YoloStartResult = {
  error: "No SageMaker quota for ml.g4dn.xlarge processing jobs (ResourceLimitExceeded): …",
  httpStatus: 429,
};
const targets = (...ids: string[]) => ids.map((id) => ({ projectId: id, projectName: `Plan ${id}` }));

interface FakeOpts {
  /** Per-project queue of start answers; when exhausted the start succeeds. */
  refusals?: Record<string, YoloStartResult[]>;
  busy?: Set<string>;
  loadMessage?: (projectId: string) => string;
  finalStatus?: (projectId: string) => { status: string; failureReason?: string };
}

function fakeWorld(opts: FakeOpts = {}) {
  const starts: string[] = [];
  const loads: string[] = [];
  const terminal: Array<[string, string]> = [];
  const finished = new Set<string>(); // projects whose job the test has let finish
  const jobProject = new Map<string, string>();
  let active = 0;
  let maxActive = 0;
  let loadsInFlight = 0;
  let maxLoadsInFlight = 0;
  const deps: YoloBatchDeps = {
    async start(projectId) {
      starts.push(projectId);
      const queued = opts.refusals?.[projectId];
      if (queued && queued.length > 0) return queued.shift();
      const jobName = `job-${projectId}-${starts.length}`;
      jobProject.set(jobName, projectId);
      active += 1;
      maxActive = Math.max(maxActive, active);
      return { jobName };
    },
    async status(jobName) {
      const pid = jobProject.get(jobName)!;
      if (!finished.has(pid)) return { status: "InProgress" };
      return opts.finalStatus?.(pid) ?? { status: "Completed" };
    },
    async markTerminal(jobName, status) {
      terminal.push([jobName, status]);
      active -= 1;
    },
    async load(projectId) {
      loads.push(projectId);
      loadsInFlight += 1;
      maxLoadsInFlight = Math.max(maxLoadsInFlight, loadsInFlight);
      await new Promise((r) => setTimeout(r, 100));
      loadsInFlight -= 1;
      return opts.loadMessage?.(projectId) ?? "Completed — 12 detections loaded";
    },
    isBusy: (projectId) => opts.busy?.has(projectId) ?? false,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
  return {
    deps,
    starts,
    loads,
    terminal,
    finish: (...ids: string[]) => ids.forEach((id) => finished.add(id)),
    get maxActive() {
      return maxActive;
    },
    get maxLoadsInFlight() {
      return maxLoadsInFlight;
    },
  };
}

const FAST: YoloBatchOptions = { pollMs: 1_000, loadDelayMs: 500 };
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const phases = (b: YoloBatch) => Object.fromEntries(b.snapshot().items.map((i) => [i.projectId, i.phase]));

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("classifyStartRefusal / isLoadSuccess", () => {
  it("capacity for ResourceLimitExceeded and plain 429s, limit for daily/page caps, error otherwise", () => {
    expect(classifyStartRefusal(QUOTA_429)).toBe("capacity");
    expect(classifyStartRefusal({ error: "ResourceLimitExceeded: account-level service limit" })).toBe("capacity");
    expect(classifyStartRefusal({ error: "Too many requests", httpStatus: 429 })).toBe("capacity");
    expect(classifyStartRefusal({ error: "Daily YOLO job limit reached (10/day)", httpStatus: 429 })).toBe("limit");
    expect(classifyStartRefusal({ error: "YOLO limit reached for your company (90/100 pages used)", httpStatus: 429 })).toBe("limit");
    expect(classifyStartRefusal({ error: "Failed to start SageMaker job", httpStatus: 500 })).toBe("error");
    expect(classifyStartRefusal({ error: "Model not found" })).toBe("error");
  });
  it("load success follows the page's status strings", () => {
    expect(isLoadSuccess("Completed — 4 detections loaded")).toBe(true);
    expect(isLoadSuccess("Loaded 4 (errors: page 3)")).toBe(true);
    expect(isLoadSuccess("Load failed: No results found")).toBe(false);
  });
});

describe("YoloBatch run mode", () => {
  it("never has more than `concurrency` (default 2) jobs running, and runs + loads every project", async () => {
    const w = fakeWorld();
    const b = new YoloBatch("run", MODEL, targets("a", "b", "c", "d", "e"), w.deps, FAST);
    const done = b.run();
    await tick(10);
    expect(w.starts).toEqual(["a", "b"]);
    expect(b.snapshot().items.filter((i) => i.phase === "running")).toHaveLength(2);
    await tick(5_000);
    expect(w.starts).toEqual(["a", "b"]); // still capped while both are InProgress
    w.finish("a");
    await tick(2_000);
    expect(w.starts).toEqual(["a", "b", "c"]);
    w.finish("b", "c", "d", "e");
    await tick(20_000);
    const final = await done;
    expect(w.maxActive).toBe(2);
    expect(w.loads.sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect(final.items.every((i) => i.phase === "done")).toBe(true);
    expect(w.terminal.map(([, s]) => s)).toEqual(Array(5).fill("Completed"));
    expect(batchSummary(final)).toBe("Finished — 5 started · 0 waiting · 5 loaded");
  });

  it("concurrency 1 is strictly sequential", async () => {
    const w = fakeWorld();
    const b = new YoloBatch("run", MODEL, targets("a", "b", "c"), w.deps, { ...FAST, concurrency: 1 });
    const done = b.run();
    w.finish("a", "b", "c");
    await tick(30_000);
    await done;
    expect(w.maxActive).toBe(1);
    expect(w.starts).toEqual(["a", "b", "c"]);
  });

  it("a capacity refusal pauses new starts and retries after 60 s — and only once our own job frees capacity", async () => {
    const w = fakeWorld({ refusals: { b: [QUOTA_429] } });
    const b = new YoloBatch("run", MODEL, targets("a", "b", "c"), w.deps, FAST);
    const done = b.run();
    await tick(10);
    expect(w.starts).toEqual(["a", "b"]);
    expect(b.snapshot().pausedForQuota).toBe(true);
    expect(phases(b)).toMatchObject({ a: "running", b: "queued", c: "queued" });
    expect(batchSummary(b.snapshot())).toContain("paused: SageMaker capacity — retrying in 60 s");

    await tick(61_000); // 60 s elapsed, but "a" still holds the capacity → no retry yet
    expect(w.starts).toEqual(["a", "b"]);
    w.finish("a");
    await tick(2_000);
    expect(w.starts).toEqual(["a", "b", "b", "c"]); // b retried first, keeping its place
    expect(b.snapshot().pausedForQuota).toBe(false);
    w.finish("b", "c");
    await tick(20_000);
    const final = await done;
    expect(final.items.map((i) => i.phase)).toEqual(["done", "done", "done"]);
  });

  it("with nothing of ours running, retries every 60 s and stops new starts after maxIdleQuotaRetries", async () => {
    const w = fakeWorld({ refusals: { a: [QUOTA_429, QUOTA_429, QUOTA_429, QUOTA_429] } });
    const b = new YoloBatch("run", MODEL, targets("a", "b"), w.deps, { ...FAST, concurrency: 1, maxIdleQuotaRetries: 2 });
    const done = b.run();
    await tick(10);
    expect(w.starts).toEqual(["a"]);
    await tick(59_000);
    expect(w.starts).toEqual(["a"]); // still inside the 60 s pause
    await tick(1_100);
    expect(w.starts).toEqual(["a", "a"]);
    await tick(60_100);
    const final = await done;
    expect(w.starts).toEqual(["a", "a", "a"]); // 3rd idle refusal > 2 → halt, b never tried
    expect(final.items.map((i) => i.phase)).toEqual(["not-started", "not-started"]);
    expect(final.haltReason).toBe(QUOTA_429.error);
    expect(batchSummary(final)).toMatch(/^Finished — 0 started · 0 waiting · 2 not started \(No SageMaker quota for ml\.g4dn\.xlarge/u);
  });

  it("a daily/page limit refusal stops new starts at once and says how many were not started", async () => {
    const limit = { error: "Daily YOLO job limit reached (10/day)", httpStatus: 429 };
    const w = fakeWorld({ refusals: { b: [limit] } });
    const b = new YoloBatch("run", MODEL, targets("a", "b", "c", "d"), w.deps, FAST);
    const done = b.run();
    await tick(10);
    w.finish("a");
    await tick(10_000);
    const final = await done;
    expect(w.starts).toEqual(["a", "b"]);
    expect(phases(b)).toEqual({ a: "done", b: "not-started", c: "not-started", d: "not-started" });
    expect(batchSummary(final)).toBe(
      "Finished — 1 started · 0 waiting · 1 loaded · 3 not started (Daily YOLO job limit reached (10/day))",
    );
  });

  it("skips rows that are already running/loading and never starts them", async () => {
    const w = fakeWorld({ busy: new Set(["b"]) });
    const b = new YoloBatch("run", MODEL, targets("a", "b", "c"), w.deps, FAST);
    const done = b.run();
    w.finish("a", "c");
    await tick(20_000);
    const final = await done;
    expect(w.starts).toEqual(["a", "c"]);
    expect(phases(b).b).toBe("skipped");
    expect(batchSummary(final)).toContain("1 skipped (already running)");
  });

  it("auto-loads on Completed (after the load delay), reports Failed with its reason, and one failure never stops the rest", async () => {
    const w = fakeWorld({
      refusals: { c: [{ error: "Failed to start SageMaker job", httpStatus: 500 }] },
      finalStatus: (pid) => (pid === "b" ? { status: "Failed", failureReason: "OOM" } : { status: "Completed" }),
    });
    const b = new YoloBatch("run", MODEL, targets("a", "b", "c", "d"), w.deps, FAST);
    const done = b.run();
    await tick(10);
    w.finish("a", "b");
    await tick(1_000); // poll sees Completed; load waits loadDelayMs
    expect(w.terminal).toContainEqual(["job-a-1", "Completed"]);
    expect(w.loads).toEqual([]);
    await tick(700);
    expect(w.loads).toEqual(["a"]);
    w.finish("d");
    await tick(10_000);
    const final = await done;
    expect(w.loads).toEqual(["a", "d"]); // never "b" (Failed) or "c" (never started)
    expect(w.terminal).toContainEqual(["job-b-2", "Failed"]);
    expect(final.items.find((i) => i.projectId === "b")).toMatchObject({ phase: "failed", message: "Failed: OOM" });
    expect(final.items.find((i) => i.projectId === "c")).toMatchObject({ phase: "failed", message: "Failed to start SageMaker job" });
    expect(batchSummary(final)).toBe("Finished — 3 started · 0 waiting · 2 loaded · 2 failed (Failed: OOM)");
  });

  it("autoLoad:false marks Completed jobs done without loading", async () => {
    const w = fakeWorld();
    const b = new YoloBatch("run", MODEL, targets("a"), w.deps, { ...FAST, autoLoad: false });
    const done = b.run();
    w.finish("a");
    await tick(5_000);
    const final = await done;
    expect(w.loads).toEqual([]);
    expect(final.items[0]).toMatchObject({ phase: "done", message: "Completed — not loaded" });
  });

  it("a load that fails marks the row failed", async () => {
    const w = fakeWorld({ loadMessage: () => "Load failed: No results found" });
    const b = new YoloBatch("run", MODEL, targets("a"), w.deps, FAST);
    const done = b.run();
    w.finish("a");
    await tick(5_000);
    expect((await done).items[0]).toMatchObject({ phase: "failed", message: "Load failed: No results found" });
  });

  it("stop() ends new starts — including a quota pause — but a running job is still followed and loaded", async () => {
    const w = fakeWorld({ refusals: { b: [QUOTA_429] } });
    const b = new YoloBatch("run", MODEL, targets("a", "b", "c"), w.deps, FAST);
    const done = b.run();
    await tick(10);
    expect(b.snapshot().pausedForQuota).toBe(true);
    b.stop();
    expect(b.snapshot().pausedForQuota).toBe(false);
    expect(batchSummary(b.snapshot())).toContain("stopping: running jobs will finish and load");
    await tick(30_000);
    expect(w.starts).toEqual(["a", "b"]);
    expect(b.snapshot().finished).toBe(false); // a is still InProgress
    w.finish("a");
    await tick(5_000);
    const final = await done;
    expect(w.loads).toEqual(["a"]);
    expect(phases(b)).toEqual({ a: "done", b: "not-started", c: "not-started" });
    expect(final.items[2].message).toBe("Not started — queue stopped");
  });

  it("a job whose status cannot be read is given up on after maxStatusFailures polls", async () => {
    const w = fakeWorld();
    w.deps.status = async () => null;
    const b = new YoloBatch("run", MODEL, targets("a"), w.deps, { ...FAST, maxStatusFailures: 3 });
    const done = b.run();
    await tick(5_000);
    expect((await done).items[0]).toMatchObject({ phase: "failed" });
    expect(w.loads).toEqual([]);
  });

  it("a completed job resets the idle-refusal count, so earlier refusals do not halt a later project", async () => {
    // maxIdleQuotaRetries 1: a's idle refusal is strike 1; a then runs and completes, which must reset
    // the count — so b's idle refusal is strike 1 again (retry), not strike 2 (halt).
    const w = fakeWorld({ refusals: { a: [QUOTA_429], b: [QUOTA_429] } });
    w.finish("a", "b");
    const b = new YoloBatch("run", MODEL, targets("a", "b"), w.deps, { ...FAST, concurrency: 1, maxIdleQuotaRetries: 1 });
    const done = b.run();
    await tick(200_000);
    const final = await done;
    expect(w.starts).toEqual(["a", "a", "b", "b"]);
    expect(final.items.map((i) => i.phase)).toEqual(["done", "done"]);
    expect(final.haltReason).toBeUndefined();
  });

  it("only CONSECUTIVE status failures give a job up: a good poll resets the count", async () => {
    const w = fakeWorld();
    const script: Array<{ status: string } | null> = [null, null, { status: "InProgress" }, null, null, { status: "InProgress" }, null, null, { status: "Completed" }];
    w.deps.status = async () => (script.length > 0 ? script.shift()! : { status: "Completed" });
    const b = new YoloBatch("run", MODEL, targets("a"), w.deps, { ...FAST, maxStatusFailures: 3 });
    const done = b.run();
    await tick(20_000);
    const final = await done;
    expect(final.items[0]).toMatchObject({ phase: "done" });
    expect(w.loads).toEqual(["a"]);
  });

  it("a flickering status never frees the slot: with concurrency 1 the next project waits", async () => {
    // concurrency 1: while a's status flickers (never 3 misses in a row) b must not start.
    const w = fakeWorld();
    let polls = 0;
    w.deps.status = async () => {
      polls += 1;
      return polls % 3 === 0 ? { status: "InProgress" } : null;
    };
    const b = new YoloBatch("run", MODEL, targets("a", "b"), w.deps, { ...FAST, concurrency: 1, maxStatusFailures: 3 });
    void b.run();
    await tick(30_000);
    expect(w.starts).toEqual(["a"]);
    expect(phases(b)).toEqual({ a: "running", b: "queued" });
    b.stop();
  });

  it("reports provider-confirmed Failed/Stopped ends (and unloaded completions) through jobEnded — never a give-up", async () => {
    const ended: Array<[string, string]> = [];
    const w = fakeWorld({ finalStatus: (pid) => (pid === "a" ? { status: "Failed", failureReason: "OOM" } : pid === "b" ? { status: "Stopped" } : { status: "Completed" }) });
    w.deps.jobEnded = (jobName, message) => ended.push([jobName, message]);
    w.finish("a", "b", "c");
    const b = new YoloBatch("run", MODEL, targets("a", "b", "c"), w.deps, FAST);
    await (async () => { const done = b.run(); await tick(20_000); await done; })();
    expect(ended).toEqual([["job-a-1", "Failed: OOM"], ["job-b-2", "Stopped"]]); // c Completed + loaded: no call

    const w2 = fakeWorld();
    const ended2: string[] = [];
    w2.deps.jobEnded = (_j, m) => ended2.push(m);
    w2.finish("a");
    const noLoad = new YoloBatch("run", MODEL, targets("a"), w2.deps, { ...FAST, autoLoad: false });
    await (async () => { const done = noLoad.run(); await tick(5_000); await done; })();
    expect(ended2).toEqual(["Completed — not loaded"]);

    const w3 = fakeWorld();
    const ended3: string[] = [];
    w3.deps.jobEnded = (_j, m) => ended3.push(m);
    w3.deps.status = async () => null;
    const gaveUp = new YoloBatch("run", MODEL, targets("a"), w3.deps, { ...FAST, maxStatusFailures: 2 });
    await (async () => { const done = gaveUp.run(); await tick(5_000); await done; })();
    expect(gaveUp.snapshot().items[0].phase).toBe("failed");
    expect(ended3).toEqual([]);
  });

  it("dedupes repeated projects", () => {
    const w = fakeWorld();
    const b = new YoloBatch("run", MODEL, targets("a", "a", "b"), w.deps);
    expect(b.snapshot().items.map((i) => i.projectId)).toEqual(["a", "b"]);
  });
});

describe("YoloBatch load mode", () => {
  it("loads one project at a time, skips busy rows, and keeps going after a failed load", async () => {
    const w = fakeWorld({
      busy: new Set(["c"]),
      loadMessage: (pid) => (pid === "b" ? "Load failed: No results found" : "Completed — 3 detections loaded"),
    });
    const b = new YoloBatch("load", MODEL, targets("a", "b", "c", "d"), w.deps, FAST);
    const done = b.run();
    await tick(1_000);
    const final = await done;
    expect(w.loads).toEqual(["a", "b", "d"]);
    expect(w.maxLoadsInFlight).toBe(1);
    expect(w.starts).toEqual([]);
    expect(phases(b)).toEqual({ a: "done", b: "failed", c: "skipped", d: "done" });
    expect(batchSummary(final)).toBe(
      "Finished — 0 waiting · 2 loaded · 1 failed (Load failed: No results found) · 1 skipped (already running)",
    );
  });

  it("stop() ends the remaining loads", async () => {
    const w = fakeWorld();
    const b = new YoloBatch("load", MODEL, targets("a", "b", "c"), w.deps, FAST);
    const done = b.run();
    await tick(10);
    b.stop();
    await tick(1_000);
    const final = await done;
    expect(w.loads).toEqual(["a"]);
    expect(phases(b)).toEqual({ a: "done", b: "not-started", c: "not-started" });
    expect(batchSummary(final)).toContain("2 not started (queue stopped)");
  });
});
