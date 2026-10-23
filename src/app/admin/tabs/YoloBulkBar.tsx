"use client";

// Bulk YOLO run/load for one model across many projects (owner 2026-10-21). Queue logic lives in
// ./yolo-batch.ts; this file wires it to the admin page's own runYolo / loadYoloResults (so every
// row keeps its usual status strings) and renders the bar above the "Run YOLO Inference" list.
//
// The active queue is held at MODULE scope, not in component state, so switching admin tabs (which
// unmounts AiModelsTab) does not orphan it; it still lives only in this browser tab. For the same
// reason its busy check reads `latestYoloJobs` (module scope, refreshed by whichever hook instance
// is mounted), never a ref of the instance that created the queue: that ref freezes on unmount.
//
// [2026-10-22] Root (the instance options are loaded): Run uses BATCHED jobs — the projects are planned
// into SageMaker jobs of ≤ 9 (src/lib/yolo-chunk-plan.ts) and each job starts through the root-only
// POST /api/yolo/run-batch. "Machines at once" (default = the chosen instance's quota) is how many jobs
// run together; the estimate follows it. Every request/answer goes to the debug log (./yolo-debug-log).
// Non-root admins keep the per-project queue over /api/yolo/run.

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { apiErrorMessage, persistFetch } from "@/lib/client-persist";
import { gpusPerMachine, yoloBatchEstimateFor, yoloBatchEstimateText } from "@/lib/yolo-cost";
import type { YoloChunk } from "@/lib/yolo-chunk-plan";
import {
  BUSY_STATUS,
  YoloBatch,
  batchSummary,
  type YoloBatchDeps,
  type YoloBatchMode,
  type YoloBatchSnapshot,
  type YoloBatchStartResult,
  type YoloJobStatus,
  type YoloStartResult,
} from "./yolo-batch";
import { YoloBulkCost } from "./YoloCost";
import { bulkConcurrency, bulkMachineBounds, clampMachines } from "./yolo-bulk-concurrency";
import { readYoloOptions, useYoloOptions } from "./yolo-options-store";
import { logYoloDebug, logYoloDebugError } from "./yolo-debug-log";
import type { YoloStatusLoad } from "./yolo-status-load";

export { YoloRunCost } from "./YoloCost";

export interface BulkModel {
  id: number;
  name: string;
}

export interface BulkProject {
  id: string;
  name: string;
  numPages: number | null;
}

export type RunYoloFn = (
  projectId: string,
  modelId: number,
  bulk?: boolean,
) => Promise<YoloStartResult | undefined | void> | void;
export type LoadYoloFn = (
  projectId: string,
  modelId: number,
  modelName: string,
) => Promise<string | void> | void;

// ── module-scope queue store ────────────────────────────────────────────────
let activeBatch: YoloBatch | null = null;
let activeSnapshot: YoloBatchSnapshot | null = null;
const storeListeners = new Set<() => void>();
const notifyStore = () => storeListeners.forEach((fn) => fn());
const subscribeStore = (fn: () => void) => {
  storeListeners.add(fn);
  return () => {
    storeListeners.delete(fn);
  };
};
const readStore = () => activeSnapshot;

/** What the last Run planned, for the debug report (./YoloDebugReport.tsx). */
export interface YoloBulkRunPlan {
  at: string;
  modelId: number;
  modelName: string;
  instanceType: string | null;
  machines: number;
  gpusPerMachine: number | null;
  chunks: YoloChunk[] | null;
  estimate: string | null;
}
let lastRunPlan: YoloBulkRunPlan | null = null;

export function readYoloBulkDebugState(): { snapshot: YoloBatchSnapshot | null; plan: YoloBulkRunPlan | null } {
  return { snapshot: activeSnapshot, plan: lastRunPlan };
}

/** The admin page's row texts as last rendered by any mounted useYoloBulk. */
let latestYoloJobs: Record<string, Record<string, string>> = {};
/** jobName → terminal text for bulk jobs this tab saw end Failed/Stopped (the page string still says Running). */
const endedBulkJobs = new Map<string, string>();

/** The page's row text, with "Running: <job>" replaced by its terminal text once the queue saw it end. */
export function effectiveRowStatus(pageStatus: string): string {
  const running = /^Running: (.+)$/u.exec(pageStatus);
  return (running && endedBulkJobs.get(running[1])) || pageStatus;
}

function rowIsBusy(projectId: string, modelId: number): boolean {
  return BUSY_STATUS.test(effectiveRowStatus((latestYoloJobs[projectId] || {})[String(modelId)] || ""));
}

/** Test hook: forget any queue left over from a previous render tree. */
export function resetYoloBulkStoreForTests(): void {
  activeBatch?.stop();
  activeBatch = null;
  activeSnapshot = null;
  lastRunPlan = null;
  latestYoloJobs = {};
  endedBulkJobs.clear();
  notifyStore();
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function fetchJobStatus(jobName: string): Promise<YoloJobStatus | null> {
  const url = `/api/yolo/status?jobName=${encodeURIComponent(jobName)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      logYoloDebug("http", `GET ${url} → ${res.status}`, await res.json().catch(() => null));
      return null;
    }
    const body = (await res.json()) as Partial<YoloJobStatus>;
    return typeof body.status === "string" ? { status: body.status, failureReason: body.failureReason } : null;
  } catch (err) {
    logYoloDebugError(`GET ${url} failed`, err);
    return null;
  }
}

/** POST /api/yolo/run-batch for one planned job; a refusal comes back as { error, httpStatus, code }. */
async function postRunBatch(projectIds: string[], modelId: number): Promise<YoloBatchStartResult> {
  try {
    const res = await fetch("/api/yolo/run-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectIds, modelId }),
    });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      logYoloDebug("http", `POST /api/yolo/run-batch → ${res.status}`, body);
      const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
      return { error: apiErrorMessage(body) || `HTTP ${res.status}`, httpStatus: res.status, ...(typeof code === "string" ? { code } : {}) };
    }
    const ok = body as YoloBatchStartResult;
    return { jobName: typeof ok?.jobName === "string" ? ok.jobName : undefined, projects: ok?.projects, error: ok?.jobName ? undefined : "No job name in the answer" };
  } catch (err) {
    logYoloDebugError("POST /api/yolo/run-batch failed", err);
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export interface UseYoloBulkArgs {
  models: BulkModel[];
  projects: BulkProject[];
  yoloJobs: Record<string, Record<string, string>>;
  yoloStatus: Record<string, Record<string, number>>;
  /** [2026-10-23] Whether yoloStatus has landed; omitted = loaded (callers that pass a final map). */
  yoloStatusLoad?: YoloStatusLoad;
  onRunYolo: RunYoloFn;
  onLoadResults: LoadYoloFn;
}

/** localStorage key of the "only projects without results" checkbox (per browser). */
export const ONLY_MISSING_STORAGE_KEY = "bp.admin.yoloBulk.onlyMissing";

function readOnlyMissing(): boolean | null {
  try {
    const v = window.localStorage.getItem(ONLY_MISSING_STORAGE_KEY);
    return v === "1" ? true : v === "0" ? false : null;
  } catch {
    return null;
  }
}

function writeOnlyMissing(value: boolean): void {
  try {
    window.localStorage.setItem(ONLY_MISSING_STORAGE_KEY, value ? "1" : "0");
  } catch {
    /* private mode / blocked storage — the choice just is not remembered */
  }
}

export function useYoloBulk({ models, projects, yoloJobs, yoloStatus, yoloStatusLoad, onRunYolo, onLoadResults }: UseYoloBulkArgs) {
  const [pickedModelId, setPickedModelId] = useState<number | null>(null);
  const model = models.find((m) => m.id === pickedModelId) ?? models[0] ?? null;
  const [selectedByModel, setSelectedByModel] = useState<Record<number, string[]>>({});
  const [onlyMissing, setOnlyMissing] = useState(() => readOnlyMissing() ?? true);
  const statusLoaded = yoloStatusLoad ? yoloStatusLoad.loaded : true;
  const statusError = yoloStatusLoad?.error ?? null;
  const snapshot = useSyncExternalStore(subscribeStore, readStore, readStore);
  const { data: options } = useYoloOptions();
  const bounds = bulkMachineBounds(options);
  const instanceType = options?.instanceType ?? null;
  // Keyed by the saved instance type: changing the instance re-defaults N to that instance's quota.
  const [machinesChoice, setMachinesChoice] = useState<{ instanceType: string | null; value: number } | null>(null);
  const machines =
    machinesChoice && machinesChoice.instanceType === instanceType ? clampMachines(machinesChoice.value, bounds) : bounds.defaultValue;
  const machineOption = options?.catalog.options.find((o) => o.type === instanceType) ?? null;
  useEffect(() => {
    latestYoloJobs = yoloJobs;
  }, [yoloJobs]);

  const selected = useMemo(() => new Set(model ? selectedByModel[model.id] ?? [] : []), [model, selectedByModel]);
  const hasResults = useCallback(
    (projectId: string, modelId: number) => ((yoloStatus[projectId] || {})[String(modelId)] || 0) > 0,
    [yoloStatus],
  );
  // Until the results are known, "without results" cannot be computed: offer none rather than all.
  const candidates = useMemo(
    () => (model && (!onlyMissing || statusLoaded) ? projects.filter((p) => !onlyMissing || !hasResults(p.id, model.id)) : []),
    [projects, model, onlyMissing, statusLoaded, hasResults],
  );
  const busy = !!snapshot && !snapshot.finished;

  const setSelection = (ids: string[]) => {
    if (model) setSelectedByModel((prev) => ({ ...prev, [model.id]: ids }));
  };
  const toggle = (projectId: string) => {
    if (!model) return;
    const next = new Set(selected);
    if (next.has(projectId)) next.delete(projectId);
    else next.add(projectId);
    setSelection(projects.filter((p) => next.has(p.id)).map((p) => p.id));
  };

  const start = (mode: YoloBatchMode, ids: string[]) => {
    if (!model || ids.length === 0 || busy) return;
    const targets = projects.filter((p) => ids.includes(p.id));
    const opts = readYoloOptions();
    const plan = mode === "run" ? yoloBatchEstimateFor(opts, model.id, targets.map((p) => ({ id: p.id, pages: p.numPages })), machines) : null;
    const concurrency = plan ? machines : bulkConcurrency(opts);
    if (mode === "run") {
      const pages = targets.reduce((sum, p) => sum + (p.numPages ?? 0), 0);
      const unknown = targets.filter((p) => !p.numPages).length;
      const how = plan
        ? `${plan.chunks.length} SageMaker job${plan.chunks.length === 1 ? "" : "s"} of up to 9 projects, ${machines} machine${machines === 1 ? "" : "s"} at a time; every project loads automatically when its job finishes.`
        : `Up to ${concurrency} jobs run at a time; each result loads automatically when its job finishes.`;
      const ok = window.confirm(
        `Run ${model.name} on ${targets.length} project${targets.length === 1 ? "" : "s"} — ${pages} pages total` +
          `${unknown ? ` (+${unknown} with an unknown page count, which will be refused)` : ""}.\n\n` +
          (plan && plan.estimate.jobs > 0 ? `Estimated cost: ${yoloBatchEstimateText(plan)}\n\n` : "") +
          `SageMaker is billed per instance-second. ${how}\n\n` +
          "Keep this browser tab open until the queue finishes: closing it stops new starts (jobs already started still finish on AWS and can be loaded later).",
      );
      if (!ok) return;
      lastRunPlan = {
        at: new Date().toISOString(),
        modelId: model.id,
        modelName: model.name,
        instanceType: opts?.instanceType ?? null,
        machines: concurrency,
        gpusPerMachine: plan ? gpusPerMachine(plan.option) : null,
        chunks: plan?.chunks ?? null,
        estimate: plan ? yoloBatchEstimateText(plan) : null,
      };
      logYoloDebug("plan", `run ${model.name}: ${targets.length} project(s)`, lastRunPlan);
    }
    const deps: YoloBatchDeps = {
      start: async (projectId, modelId) => (await onRunYolo(projectId, modelId, true)) || undefined,
      status: fetchJobStatus,
      markTerminal: (jobName, status, projectId) =>
        persistFetch("/api/admin/running-jobs", { executionId: jobName, status, ...(projectId ? { projectId } : {}) }, "PUT")
          .then(() => undefined)
          .catch((err: unknown) => {
            logYoloDebugError(`PUT /api/admin/running-jobs ${jobName} ${status} failed`, err);
          }),
      ...(plan ? { startBatch: postRunBatch } : {}),
      log: logYoloDebug,
      load: async (projectId, modelId, modelName) => (await onLoadResults(projectId, modelId, modelName)) || undefined,
      isBusy: rowIsBusy,
      jobEnded: (jobName, message) => {
        endedBulkJobs.set(jobName, message); // the queue's next patch re-renders the row
      },
      sleep,
    };
    const batch = new YoloBatch(mode, model, targets.map((p) => ({ projectId: p.id, projectName: p.name })), deps, {
      concurrency,
      ...(plan ? { chunks: plan.chunks.map((c) => c.projectIds) } : {}),
    });
    activeBatch = batch;
    activeSnapshot = batch.snapshot();
    batch.subscribe((s) => {
      if (activeBatch !== batch) return;
      activeSnapshot = s;
      notifyStore();
    });
    notifyStore();
    void batch.run();
  };

  /** The row's status text, with the queue's view where the page's own string would be stale. */
  const rowStatus = (projectId: string, modelId: number, rawPageStatus: string): string => {
    const pageStatus = effectiveRowStatus(rawPageStatus);
    if (!snapshot || snapshot.modelId !== modelId) return pageStatus;
    const item = snapshot.items.find((i) => i.projectId === projectId);
    if (!item) return pageStatus;
    if (item.phase === "queued" && (!pageStatus || pageStatus.startsWith("Error"))) {
      return item.message ? `Queued — ${item.message}` : "Queued (bulk)";
    }
    if (item.phase === "not-started" && (!pageStatus || pageStatus.startsWith("Error"))) return item.message ?? pageStatus;
    // A batched job's projects never had a page-side "Running: …" text: show the queue's own.
    if (!pageStatus && item.message && item.phase !== "queued") return item.message;
    return pageStatus;
  };

  return {
    isSelected: (projectId: string) => selected.has(projectId),
    toggle,
    rowStatus,
    bar: {
      models,
      model,
      onPickModel: setPickedModelId,
      selectedCount: selected.size,
      selectedProjects: projects.filter((p) => selected.has(p.id)).map((p) => ({ id: p.id, pages: p.numPages })),
      candidateCount: candidates.length,
      candidateProjects: candidates.map((p) => ({ id: p.id, pages: p.numPages })),
      machines,
      machineBounds: bounds,
      machineInstance: machineOption ? { type: machineOption.type, gpus: gpusPerMachine(machineOption) } : null,
      onMachines: (value: number) => setMachinesChoice({ instanceType, value }),
      totalCount: projects.length,
      onlyMissing,
      resultsLoaded: statusLoaded,
      resultsError: statusError,
      onToggleOnlyMissing: () => {
        writeOnlyMissing(!onlyMissing);
        setOnlyMissing(!onlyMissing);
      },
      onSelectAll: () => setSelection(candidates.map((p) => p.id)),
      onDeselectAll: () => setSelection([]),
      onRunSelected: () => start("run", [...selected]),
      onLoadSelected: () => start("load", [...selected]),
      onRunAll: () => {
        const ids = candidates.map((p) => p.id);
        setSelection(ids);
        start("run", ids);
      },
      onLoadAll: () => {
        const ids = candidates.map((p) => p.id);
        setSelection(ids);
        start("load", ids);
      },
      onStop: () => activeBatch?.stop(),
      snapshot,
      busy,
    },
  };
}

export type YoloBulkBarProps = ReturnType<typeof useYoloBulk>["bar"];

const btn =
  "px-2.5 py-1 text-xs rounded border border-[var(--border)] hover:border-[var(--accent)] disabled:opacity-40 disabled:hover:border-[var(--border)]";

export default function YoloBulkBar(props: YoloBulkBarProps) {
  const { model, snapshot, busy, selectedCount } = props;
  if (!model) return null;
  const idle = !busy;
  return (
    <div className="mb-3 p-3 bg-[var(--surface)] border border-[var(--border)] rounded space-y-2" data-testid="yolo-bulk-bar">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium text-sm">Bulk</span>
        <label className="flex items-center gap-1">
          Model
          <select
            aria-label="Bulk model"
            value={model.id}
            disabled={!idle}
            onChange={(e) => props.onPickModel(Number(e.target.value))}
            className="px-2 py-1 bg-[var(--bg)] border border-[var(--border)] rounded"
          >
            {props.models.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </label>
        <button type="button" className={btn} onClick={props.onSelectAll} disabled={!idle}>Select all</button>
        <button type="button" className={btn} onClick={props.onDeselectAll} disabled={!idle}>Deselect all</button>
        <label className="flex items-center gap-1 text-[var(--muted)]">
          <input type="checkbox" checked={props.onlyMissing} onChange={props.onToggleOnlyMissing} disabled={!idle} />
          only projects without results for this model (
          {props.onlyMissing && !props.resultsLoaded
            ? props.resultsError ? "results unavailable" : "loading results…"
            : `${props.candidateCount} of ${props.totalCount}`}
          )
        </label>
        {props.resultsError && (
          <span className="text-red-400" data-testid="yolo-bulk-results-error">
            Could not load YOLO results: {props.resultsError}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button type="button" className={btn} onClick={props.onRunSelected} disabled={!idle || selectedCount === 0}>
          Run {model.name} on {selectedCount} selected
        </button>
        <button type="button" className={btn} onClick={props.onLoadSelected} disabled={!idle || selectedCount === 0}>
          Load {model.name} on {selectedCount} selected
        </button>
        <button type="button" className={btn} onClick={props.onRunAll} disabled={!idle || props.candidateCount === 0}>
          Run all ({props.candidateCount})
        </button>
        <button type="button" className={btn} onClick={props.onLoadAll} disabled={!idle || props.candidateCount === 0}>
          Load all ({props.candidateCount})
        </button>
        <button type="button" className={`${btn} text-red-300`} onClick={props.onStop} disabled={!busy || !!snapshot?.stopped}>
          Stop queue
        </button>
      </div>
      {props.machineInstance && (
        <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="yolo-bulk-machines">
          <label className="flex items-center gap-1">
            Machines at once
            <input
              aria-label="Machines at once"
              type="number"
              min={props.machineBounds.min}
              max={props.machineBounds.max}
              step={1}
              value={props.machines}
              disabled={!idle}
              onChange={(e) => props.onMachines(Number(e.target.value))}
              className="w-16 px-2 py-1 bg-[var(--bg)] border border-[var(--border)] rounded"
            />
          </label>
          <span className="text-[var(--muted)]">
            = {props.machines} × {props.machineInstance.type} · {props.machineInstance.gpus} GPU{props.machineInstance.gpus === 1 ? "" : "s"} each ={" "}
            {props.machines * props.machineInstance.gpus} GPU{props.machines * props.machineInstance.gpus === 1 ? "" : "s"}
            {props.machineBounds.quota === null
              ? ` (quota unknown: 1–${props.machineBounds.max})`
              : ` (quota ${props.machineBounds.quota}${props.machineBounds.quota > props.machineBounds.max ? `, capped at ${props.machineBounds.max}` : ""})`}
          </span>
        </div>
      )}
      <div className="text-xs space-y-0.5">
        {selectedCount > 0 && (
          <YoloBulkCost label={`Estimate, ${selectedCount} selected`} modelId={model.id} projects={props.selectedProjects} machines={props.machines} />
        )}
        {props.candidateCount > 0 && (
          <YoloBulkCost label={`Estimate, all ${props.candidateCount}`} modelId={model.id} projects={props.candidateProjects} machines={props.machines} />
        )}
      </div>
      {snapshot && (
        <div className="text-xs" data-testid="yolo-bulk-summary">
          <span className="text-[var(--muted)]">
            {snapshot.mode === "run" ? "Run" : "Load"} {snapshot.modelName}:{" "}
          </span>
          {batchSummary(snapshot)}
          {busy && <span className="ml-2 text-amber-300">Keep this tab open — the queue runs in this browser tab.</span>}
        </div>
      )}
    </div>
  );
}
