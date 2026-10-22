"use client";

// Bulk YOLO run/load for one model across many projects (owner 2026-10-21). Queue logic lives in
// ./yolo-batch.ts; this file wires it to the admin page's own runYolo / loadYoloResults (so every
// row keeps its usual status strings) and renders the bar above the "Run YOLO Inference" list.
//
// The active queue is held at MODULE scope, not in component state, so switching admin tabs (which
// unmounts AiModelsTab) does not orphan it; it still lives only in this browser tab. For the same
// reason its busy check reads `latestYoloJobs` (module scope, refreshed by whichever hook instance
// is mounted), never a ref of the instance that created the queue: that ref freezes on unmount.

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { persistFetch } from "@/lib/client-persist";
import {
  BUSY_STATUS,
  YoloBatch,
  batchSummary,
  type YoloBatchDeps,
  type YoloBatchMode,
  type YoloBatchSnapshot,
  type YoloJobStatus,
  type YoloStartResult,
} from "./yolo-batch";

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
  latestYoloJobs = {};
  endedBulkJobs.clear();
  notifyStore();
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function fetchJobStatus(jobName: string): Promise<YoloJobStatus | null> {
  const res = await fetch(`/api/yolo/status?jobName=${encodeURIComponent(jobName)}`);
  if (!res.ok) return null;
  const body = (await res.json()) as Partial<YoloJobStatus>;
  return typeof body.status === "string" ? { status: body.status, failureReason: body.failureReason } : null;
}

export interface UseYoloBulkArgs {
  models: BulkModel[];
  projects: BulkProject[];
  yoloJobs: Record<string, Record<string, string>>;
  yoloStatus: Record<string, Record<string, number>>;
  onRunYolo: RunYoloFn;
  onLoadResults: LoadYoloFn;
}

export function useYoloBulk({ models, projects, yoloJobs, yoloStatus, onRunYolo, onLoadResults }: UseYoloBulkArgs) {
  const [pickedModelId, setPickedModelId] = useState<number | null>(null);
  const model = models.find((m) => m.id === pickedModelId) ?? models[0] ?? null;
  const [selectedByModel, setSelectedByModel] = useState<Record<number, string[]>>({});
  const [onlyMissing, setOnlyMissing] = useState(true);
  const snapshot = useSyncExternalStore(subscribeStore, readStore, readStore);
  useEffect(() => {
    latestYoloJobs = yoloJobs;
  }, [yoloJobs]);

  const selected = useMemo(() => new Set(model ? selectedByModel[model.id] ?? [] : []), [model, selectedByModel]);
  const hasResults = useCallback(
    (projectId: string, modelId: number) => ((yoloStatus[projectId] || {})[String(modelId)] || 0) > 0,
    [yoloStatus],
  );
  const candidates = useMemo(
    () => (model ? projects.filter((p) => !onlyMissing || !hasResults(p.id, model.id)) : []),
    [projects, model, onlyMissing, hasResults],
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
    if (mode === "run") {
      const pages = targets.reduce((sum, p) => sum + (p.numPages ?? 0), 0);
      const unknown = targets.filter((p) => !p.numPages).length;
      const ok = window.confirm(
        `Run ${model.name} on ${targets.length} project${targets.length === 1 ? "" : "s"} — ${pages} pages total` +
          `${unknown ? ` (+${unknown} with an unknown page count, which will be refused)` : ""}.\n\n` +
          "SageMaker is billed per page. Up to 2 jobs run at a time; each result loads automatically when its job finishes.\n\n" +
          "Keep this browser tab open until the queue finishes: closing it stops new starts (jobs already started still finish on AWS and can be loaded later).",
      );
      if (!ok) return;
    }
    const deps: YoloBatchDeps = {
      start: async (projectId, modelId) => (await onRunYolo(projectId, modelId, true)) || undefined,
      status: fetchJobStatus,
      markTerminal: (jobName, status) =>
        persistFetch("/api/admin/running-jobs", { executionId: jobName, status }, "PUT").then(() => undefined),
      load: async (projectId, modelId, modelName) => (await onLoadResults(projectId, modelId, modelName)) || undefined,
      isBusy: rowIsBusy,
      jobEnded: (jobName, message) => {
        endedBulkJobs.set(jobName, message); // the queue's next patch re-renders the row
      },
      sleep,
    };
    const batch = new YoloBatch(mode, model, targets.map((p) => ({ projectId: p.id, projectName: p.name })), deps);
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
      candidateCount: candidates.length,
      totalCount: projects.length,
      onlyMissing,
      onToggleOnlyMissing: () => setOnlyMissing((v) => !v),
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
          only projects without results for this model ({props.candidateCount} of {props.totalCount})
        </label>
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
