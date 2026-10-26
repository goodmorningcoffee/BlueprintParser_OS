"use client";

// [2026-10-24 master Reprocess tab, phase 1 — UI only] Admin › Reprocess. One scope picker, one stage
// checklist with dependency auto-inclusion, one preview, one typed confirm, one console. It runs
// TODAY's routes in sequence (POST /api/admin/reprocess?scope=… per stage, POST
// /api/admin/annotation-cleanup for the root cleanup stages) — no server change, so the limits of
// those routes still hold and are stated in the UI: the reprocess scopes run on the caller's OWN
// company (root's cross-company ticks are dropped by the server), there is no "output missing"
// filter yet, and chaining is one lease per scope per project (not atomic across stages).
// Pure logic (DAG, presets, run steps) is in reprocess-plan.ts; the log console in ReprocessConsole.
// The reprocess state (running / log / Debug toggle) used to live in admin/page.tsx and was shared by
// six tabs' buttons; those buttons are now OpenReprocessLink → this tab with a preset.

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiErrorMessage } from "@/lib/client-persist";
import type { AdminTab } from "../AdminTabs";
import ReprocessDebugToggle from "../ReprocessDebugToggle";
import { runReprocess } from "../reprocess-client";
import ReprocessConsole from "./ReprocessConsole";
import { reprocessAllConfirmText, reprocessScopeNote, useReprocessScope } from "./reprocess-scope";
import {
  PRESETS,
  PROJECT_STATUSES,
  STAGES,
  buildRunSteps,
  isPreset,
  isRunnable,
  presetTicks,
  resolvePlan,
  resolveProjectIds,
  stageHeader,
  type PlanStep,
  type ReprocessPreset,
  type RunStep,
  type ScopeMode,
  type ScopeProject,
  type StageId,
} from "./reprocess-plan";

interface ReprocessTabProps {
  projects: ScopeProject[];
  isRootAdmin: boolean;
  /** Preset handed over by another tab's link; `n` changes per click so the same preset re-applies. */
  presetRequest: { preset: ReprocessPreset; n: number } | null;
  onOpenTab: (tab: AdminTab) => void;
}

interface CleanupDryRun {
  total: number;
  pagesCsiCleared: number;
  confirmPhrase: string;
  projects: number;
  error?: string;
}

interface Preview {
  /** undefined = the server's own predicate ("All"). */
  projectIds: string[] | undefined;
  /** Projects a reprocess stage will touch (server count for "All"). null = count unavailable. */
  projectCount: number | null;
  cleanup: Partial<Record<StageId, CleanupDryRun>>;
  scopeError: string | null;
  /**
   * [TP-1 WP-1.C, K75] The company the preview was counted for. Run uses THIS, never the live
   * scope state, so a later failed scope reload cannot turn the cleanup cross-company. null =
   * unknown: the cleanup route then refuses (it needs a company or an explicit allCompanies).
   */
  companyId: number | null;
}

interface CleanupResult {
  total: number;
  pagesCsiCleared: number;
  projects: Array<{ name: string; annotations: number; pagesCsiCleared: number; error?: string }>;
}

const MAX_LOG = 5000;

function presetFromUrl(): ReprocessPreset | null {
  if (typeof window === "undefined") return null;
  const v = new URLSearchParams(window.location.search).get("preset");
  return isPreset(v) ? v : null;
}

export default function ReprocessTab({ projects, isRootAdmin, presetRequest, onOpenTab }: ReprocessTabProps) {
  // Stage ticks: `selected` = ticked by hand, `excluded` = auto-included stages unticked by hand.
  // The first ticks come from the handed-over preset, else from a ?preset= deep link.
  const [selected, setSelected] = useState<Set<StageId>>(() => {
    const preset = presetRequest?.preset ?? presetFromUrl();
    return preset ? presetTicks(preset, isRootAdmin) : new Set();
  });
  const [excluded, setExcluded] = useState<Set<StageId>>(new Set());
  useEffect(() => {
    if (!presetRequest) return;
    setSelected(presetTicks(presetRequest.preset, isRootAdmin));
    setExcluded(new Set());
  }, [presetRequest, isRootAdmin]);
  const [clearPageCsi, setClearPageCsi] = useState(false);
  const [classifierDebug, setClassifierDebug] = useState(false);
  const [debug, setDebug] = useState(false);

  // Scope
  const [scopeMode, setScopeMode] = useState<ScopeMode>("all");
  const [statuses, setStatuses] = useState<Set<string>>(new Set(["completed"]));
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const serverScope = useReprocessScope();
  const ownCompanyId = serverScope.scope?.companyId ?? null;

  // Preview → confirm → run
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [runLabels, setRunLabels] = useState<string[]>([]);
  const [stageIndex, setStageIndex] = useState(-1);

  const plan = useMemo(() => resolvePlan(selected, excluded, isRootAdmin), [selected, excluded, isRootAdmin]);

  // Any change to the ticks or the scope discards the preview: what runs is always what was previewed.
  useEffect(() => {
    setPreview(null);
    setConfirmText("");
  }, [selected, excluded, scopeMode, statuses, picked, clearPageCsi]);

  const eligible = useMemo(
    () => projects.filter((p) => !p.isDemo && (ownCompanyId === null || p.companyId === undefined || p.companyId === ownCompanyId)),
    [projects, ownCompanyId],
  );
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const p of eligible) counts[p.status] = (counts[p.status] ?? 0) + 1;
    return counts;
  }, [eligible]);

  const append = useCallback((line: string) => setLog((prev) => [...prev, line].slice(-MAX_LOG)), []);

  const toggleSet = <T,>(set: Set<T>, value: T): Set<T> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  const applyPreset = (id: ReprocessPreset) => {
    setSelected(presetTicks(id, isRootAdmin));
    setExcluded(new Set());
  };

  const stepFor = (id: StageId): PlanStep | undefined => plan.steps.find((s) => s.id === id);

  const onTickStage = (id: StageId) => {
    const step = stepFor(id);
    if (step && !step.explicit) {
      // Pulled in by a dependency: ticking it off means "leave that stale" (warned), ticking back on re-includes it.
      setExcluded((prev) => toggleSet(prev, id));
      return;
    }
    setSelected((prev) => toggleSet(prev, id));
  };

  async function doPreview() {
    setPreviewing(true);
    try {
      const fresh = await serverScope.reload();
      const companyId = fresh.scope?.companyId ?? null;
      const projectIds = resolveProjectIds(scopeMode, projects, statuses, picked, companyId);
      const projectCount = projectIds ? projectIds.length : fresh.scope?.projects ?? null;
      const cleanup: Partial<Record<StageId, CleanupDryRun>> = {};
      const steps = buildRunSteps(plan, { projectIds, companyId }, { clearPageCsi });
      for (const step of steps) {
        if (step.kind !== "cleanup") continue;
        try {
          const res = await fetch(step.url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...step.body, dryRun: true }),
          });
          const json: unknown = await res.json().catch(() => null);
          if (!res.ok) throw new Error(apiErrorMessage(json) || `HTTP ${res.status}`);
          const r = json as CleanupDryRun & { projects: unknown[] };
          cleanup[step.id] = { total: r.total, pagesCsiCleared: r.pagesCsiCleared, confirmPhrase: r.confirmPhrase, projects: r.projects.length };
        } catch (err) {
          cleanup[step.id] = { total: 0, pagesCsiCleared: 0, confirmPhrase: "", projects: 0, error: err instanceof Error ? err.message : String(err) };
        }
      }
      setPreview({ projectIds, projectCount, cleanup, scopeError: fresh.error, companyId });
    } finally {
      setPreviewing(false);
    }
  }

  async function runCleanupStep(step: Extract<RunStep, { kind: "cleanup" }>, phrase: string) {
    const res = await fetch(step.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...step.body, dryRun: false, confirm: phrase }),
    });
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      append(`  ERROR: ${apiErrorMessage(json) || `HTTP ${res.status}`}`);
      return;
    }
    const r = json as CleanupResult;
    for (const p of r.projects) {
      if (p.error) append(`  ERROR [${p.name}]: ${p.error}`);
      else if (p.annotations > 0 || p.pagesCsiCleared > 0) {
        append(`  ${p.name}: ${p.annotations} annotation(s)${p.pagesCsiCleared ? `, CSI cleared on ${p.pagesCsiCleared} page(s)` : ""}`);
      }
    }
    append(`Done! ${r.total} annotation(s) ${step.body.mode === "dedupe" ? "removed" : "deleted"} across ${r.projects.length} project(s).`);
  }

  async function run() {
    if (!preview || plan.run.length === 0) return;
    const steps = buildRunSteps(plan, { projectIds: preview.projectIds, companyId: preview.companyId }, { clearPageCsi });
    if (plan.confirmPhrase) {
      if (confirmText.trim() !== plan.confirmPhrase) return;
    } else {
      const label = plan.run.map((s) => s.def.label).join(" → ");
      const text = preview.projectIds
        ? `Run ${label} on ${preview.projectIds.length} selected project${preview.projectIds.length === 1 ? "" : "s"}?`
        : reprocessAllConfirmText(label, serverScope.scope, serverScope.error, eligible.length, isRootAdmin);
      if (!window.confirm(text)) return;
    }
    setRunning(true);
    setRunLabels(steps.map((s) => s.label));
    setLog([`Starting ${steps.length} stage${steps.length === 1 ? "" : "s"}${debug ? " (debug on)" : ""}...`]);
    let allRan = true;
    try {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        setStageIndex(i);
        append(stageHeader(i, steps.length, step.label));
        try {
          if (step.kind === "reprocess") {
            await runReprocess(
              { scope: step.scope, projectIds: step.projectIds, debug, classifierDebug: step.scope === "intelligence" && classifierDebug },
              append,
            );
          } else {
            // The phrase the server checks is per mode; the typed one covers the most destructive stage.
            await runCleanupStep(step, preview.cleanup[step.id]?.confirmPhrase || (step.body.mode === "delete" ? "DELETE" : "DEDUPE"));
          }
        } catch (err) {
          append(`Failed: ${err instanceof Error ? err.message : "unknown"}`);
          append(`Stopped at stage ${i + 1}/${steps.length}; later stages did not run.`);
          allRan = false;
          break;
        }
      }
      // [clf visibility 2026-10-25] only when every stage ran — a broken loop used to print this too.
      if (allRan) append("All stages complete.");
    } finally {
      setStageIndex(-1);
      setRunning(false);
      setPreview(null);
      setConfirmText("");
    }
  }

  // [TP-1 WP-1.C, K75] A deletion whose dry run failed (e.g. no company scope) never runs.
  const cleanupBlocked = !!preview && Object.values(preview.cleanup).some((c) => !!c?.error);
  const canRun = !!preview && !running && !cleanupBlocked && plan.run.length > 0 && (!plan.confirmPhrase || confirmText.trim() === plan.confirmPhrase);
  const whose = serverScope.scope?.companyName ?? (serverScope.scope ? `company #${serverScope.scope.companyId}` : "your company");

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h2 className="text-lg font-semibold">Reprocess</h2>
        <p className="text-xs text-[var(--muted)] mt-1">
          One place to re-run pipeline stages on existing projects. Pick the scope, tick stages (stages whose output goes stale are
          added for you and say why), preview, then run. Every stage uses existing OCR — nothing is re-uploaded and no LLM is called.
          Stages run one after another; each project is locked per stage, so a project a user is editing is reported as skipped for that stage.
        </p>
      </div>

      {/* Scope */}
      <section className="border border-[var(--border)] rounded-lg p-4 space-y-3 bg-[var(--surface)]">
        <h3 className="text-sm font-semibold">Scope</h3>
        {isRootAdmin && (
          <div className="flex items-center gap-3">
            <label className="text-[10px] text-[var(--muted)] uppercase tracking-wide w-20">Company</label>
            <select
              disabled
              value="own"
              title="Cross-company reprocess is coming in phase 2 — the server runs these stages on your own company only"
              className="text-xs px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg)] text-[var(--muted)] cursor-not-allowed"
            >
              <option value="own">{whose}</option>
            </select>
            <span className="text-[10px] text-[var(--muted)]">coming in phase 2 — own company only for now</span>
          </div>
        )}

        <div className="flex items-center gap-3 flex-wrap">
          <label className="text-[10px] text-[var(--muted)] uppercase tracking-wide w-20">Projects</label>
          {(
            [
              ["all", `All (${serverScope.scope ? serverScope.scope.projects : "…"})`],
              ["status", "By status"],
              ["select", "Select…"],
            ] as Array<[ScopeMode, string]>
          ).map(([mode, label]) => (
            <button
              key={mode}
              onClick={() => setScopeMode(mode)}
              className={`text-xs px-3 py-1 rounded border ${
                scopeMode === mode ? "border-[var(--accent)]/40 bg-[var(--accent)]/10" : "border-[var(--border)] text-[var(--muted)]"
              }`}
            >
              {label}
            </button>
          ))}
          <label
            className="flex items-center gap-1 text-[10px] text-[var(--muted)] cursor-not-allowed"
            title="Coming in phase 2 — the reprocess routes report no per-project output state yet"
          >
            <input type="checkbox" disabled className="rounded" /> only projects where output is missing (coming in phase 2)
          </label>
        </div>

        {scopeMode === "all" && (
          <div className="text-[10px] text-[var(--muted)]" data-testid="reprocess-scope-note">
            {reprocessScopeNote(serverScope.scope, serverScope.error, eligible.length, isRootAdmin)}
          </div>
        )}

        {scopeMode === "status" && (
          <div className="flex items-center gap-3 flex-wrap text-xs">
            {PROJECT_STATUSES.map((status) => (
              <label key={status} className="flex items-center gap-1 cursor-pointer">
                <input type="checkbox" checked={statuses.has(status)} onChange={() => setStatuses(toggleSet(statuses, status))} className="rounded" />
                {status} ({statusCounts[status] ?? 0})
              </label>
            ))}
            <span className="text-[10px] text-[var(--muted)]">
              non-demo projects of {whose} from the list; demo projects are never reprocessed
            </span>
          </div>
        )}

        {scopeMode === "select" && (
          <div className="space-y-1">
            <div className="flex gap-2 text-xs">
              <button onClick={() => setPicked(new Set(eligible.map((p) => p.id)))} className="px-2 py-0.5 rounded border border-[var(--border)]">Select all</button>
              <button onClick={() => setPicked(new Set())} className="px-2 py-0.5 rounded border border-[var(--border)]">Deselect all</button>
              <span className="text-[var(--muted)]">{picked.size} selected</span>
            </div>
            <div className="max-h-40 overflow-y-auto space-y-0.5 border border-[var(--border)] rounded p-2">
              {projects.filter((p) => !p.isDemo).map((p) => {
                const foreign = ownCompanyId !== null && p.companyId !== undefined && p.companyId !== ownCompanyId;
                return (
                  <label key={p.id} className={`flex items-center gap-2 text-xs rounded px-1 py-0.5 ${foreign ? "opacity-50 cursor-not-allowed" : "cursor-pointer hover:bg-[var(--surface-hover)]"}`}>
                    <input type="checkbox" disabled={foreign} checked={picked.has(p.id)} onChange={() => setPicked(toggleSet(picked, p.id))} className="rounded" />
                    <span className="text-[var(--fg)]">{p.name}</span>
                    <span className="text-[10px] text-[var(--muted)]">
                      {p.status}
                      {p.companyName ? ` · ${p.companyName}` : ""}
                      {foreign ? " — other company: skipped by the server (phase 2)" : ""}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        )}
      </section>

      {/* Presets */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Presets</h3>
        <div className="flex gap-2 flex-wrap">
          {PRESETS.filter((p) => isRootAdmin || !p.rootOnly).map((p) => (
            <button
              key={p.id}
              onClick={() => applyPreset(p.id)}
              title={`Replaces ${p.replaces}`}
              className="text-xs px-3 py-1 rounded border border-[var(--border)] text-[var(--muted)] hover:border-[var(--accent)]/40 hover:text-[var(--fg)]"
            >
              {p.label}
            </button>
          ))}
          <button onClick={() => { setSelected(new Set()); setExcluded(new Set()); }} className="text-xs px-3 py-1 rounded text-[var(--muted)] hover:text-[var(--fg)]">
            Clear
          </button>
        </div>
      </section>

      {/* Stage checklist */}
      <section className="space-y-1">
        <h3 className="text-sm font-semibold">Stages (pipeline order)</h3>
        {STAGES.map((def) => {
          const step = stepFor(def.id);
          const runnable = isRunnable(def);
          const rootBlocked = !!def.rootOnly && !isRootAdmin;
          const checked = !!step && !step.excluded;
          const auto = !!step && !step.explicit;
          const muted = !runnable || rootBlocked;
          return (
            <div
              key={def.id}
              data-testid={`stage-${def.id}`}
              className={`flex items-start gap-3 px-3 py-2 rounded border transition-colors ${
                checked ? "border-[var(--accent)]/40 bg-[var(--accent)]/10" : "border-[var(--border)]"
              } ${muted ? "opacity-50" : ""}`}
            >
              <input
                type="checkbox"
                aria-label={def.label}
                disabled={!runnable || rootBlocked || running}
                checked={checked}
                onChange={() => onTickStage(def.id)}
                className="rounded mt-0.5"
              />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-[var(--fg)] flex items-center gap-2 flex-wrap">
                  {def.label}
                  {def.kind === "placeholder" && <span className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--border)] text-[var(--muted)]">coming soon</span>}
                  {def.kind === "unavailable" && <span className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--border)] text-[var(--muted)]">not available</span>}
                  {def.destructive && <span className="text-[9px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400">deletes rows</span>}
                  {def.rootOnly && <span className="text-[9px] text-[var(--muted)]">root only</span>}
                  {auto && !step.excluded && <span className="text-[9px] text-[var(--accent)]">auto-included</span>}
                  {step?.excluded && <span className="text-[9px] text-amber-400">unticked — leaves data stale</span>}
                </div>
                <div className="text-[10px] text-[var(--muted)]">Writes: {def.writes}</div>
                <div className="text-[10px] text-[var(--muted)]">Cost: {def.cost}</div>
                {def.overlap && <div className="text-[10px] text-[var(--muted)] italic">{def.overlap}</div>}
                {auto && step.reasons.map((r) => (
                  <div key={r} className="text-[10px] text-[var(--accent)]">{r}</div>
                ))}
                {def.kind === "handoff" && def.handoffTab && (
                  <button onClick={() => onOpenTab(def.handoffTab!)} className="text-[10px] text-[var(--accent)] hover:underline">
                    Run in {def.handoffTab === "ai-models" ? "AI Models" : "CSI Codes"} &rarr;
                  </button>
                )}
                {def.id === "purge-yolo" && checked && (
                  <label className="flex items-center gap-1 text-[10px] text-[var(--muted)] mt-1 cursor-pointer">
                    <input type="checkbox" checked={clearPageCsi} onChange={(e) => setClearPageCsi(e.target.checked)} className="rounded" />
                    also clear page-level CSI codes (pages.csi_codes = NULL) — CSI + text annotations rebuilds them
                  </label>
                )}
                {def.id === "intelligence" && checked && (
                  <label className="flex items-center gap-1 text-[10px] text-[var(--muted)] mt-1 cursor-pointer">
                    <input type="checkbox" checked={classifierDebug} onChange={(e) => setClassifierDebug(e.target.checked)} className="rounded" />
                    classifier debug — write Stage A–F traces to {"{projectDataUrl}"}/debug/classifier/page_NNNN.json
                  </label>
                )}
              </div>
            </div>
          );
        })}
      </section>

      {/* Plan + preview */}
      <section className="border border-[var(--border)] rounded-lg p-4 space-y-3 bg-[var(--surface)]">
        <h3 className="text-sm font-semibold">Plan</h3>
        {plan.run.length === 0 ? (
          <div className="text-xs text-[var(--muted)]">Tick a stage or pick a preset.</div>
        ) : (
          <ol className="text-xs space-y-0.5" data-testid="plan-order">
            {plan.run.map((s, i) => (
              <li key={s.id}>
                {i + 1}. {s.def.label}
                {!s.explicit && <span className="text-[10px] text-[var(--accent)]"> (auto)</span>}
              </li>
            ))}
          </ol>
        )}
        {plan.warnings.map((w) => (
          <div key={w} className="text-[10px] text-amber-400">{w}</div>
        ))}
        <ReprocessDebugToggle checked={debug} onChange={setDebug} />

        <div className="flex items-center gap-2">
          <button
            disabled={previewing || running || plan.run.length === 0 || (scopeMode === "select" && picked.size === 0)}
            onClick={doPreview}
            className="px-4 py-1.5 text-xs rounded border border-[var(--accent)]/40 text-[var(--accent)] hover:bg-[var(--accent)]/10 disabled:opacity-40"
          >
            {previewing ? "Previewing…" : "Preview"}
          </button>
          {!preview && plan.run.length > 0 && <span className="text-[10px] text-[var(--muted)]">Preview counts the scope before anything runs.</span>}
        </div>

        {preview && (
          <div className="space-y-2" data-testid="reprocess-preview">
            <table className="w-full text-[10px]">
              <thead>
                <tr className="text-left text-[var(--muted)] border-b border-[var(--border)]">
                  <th className="py-1 pr-2">Stage</th>
                  <th className="py-1 pr-2">Projects</th>
                  <th className="py-1 pr-2">Writes</th>
                  <th className="py-1">Cost</th>
                </tr>
              </thead>
              <tbody>
                {plan.run.map((s) => {
                  const c = preview.cleanup[s.id];
                  return (
                    <tr key={s.id} className="border-b border-[var(--border)] last:border-0 align-top">
                      <td className="py-1 pr-2 text-[var(--fg)]">{s.def.label}</td>
                      <td className="py-1 pr-2">
                        {c
                          ? c.error
                            ? <span className="text-red-400">dry run failed: {c.error}</span>
                            : `${c.projects} project(s) · ${c.total} annotation(s)${c.pagesCsiCleared ? ` · CSI cleared on ${c.pagesCsiCleared} page(s)` : ""}`
                          : preview.projectCount === null
                            ? `count unavailable${preview.scopeError ? ` (${preview.scopeError})` : ""}`
                            : `${preview.projectCount}${preview.projectIds ? " selected" : ` — ${serverScope.scope?.description ?? "server scope"}`}`}
                      </td>
                      <td className="py-1 pr-2 text-[var(--muted)]">{s.def.writes}</td>
                      <td className="py-1 text-[var(--muted)]">{s.def.cost}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {plan.confirmPhrase && (
              <div className="flex items-center gap-2 text-xs">
                <span>Type {plan.confirmPhrase} to confirm the deletion stage(s):</span>
                <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} aria-label="confirm phrase" className="bg-[var(--bg)] border border-[var(--border)] rounded px-1 w-24" />
              </div>
            )}
            {cleanupBlocked && (
              <div className="text-xs text-red-400">A deletion stage&rsquo;s dry run failed, so this plan cannot run. Fix the cause and preview again.</div>
            )}
            <button
              disabled={!canRun}
              onClick={run}
              className={`w-full py-2 rounded text-white text-xs font-medium disabled:opacity-40 hover:opacity-90 ${plan.confirmPhrase ? "bg-red-600" : "bg-[var(--accent)]"}`}
            >
              {running ? "Running…" : `Run ${plan.run.length} stage${plan.run.length === 1 ? "" : "s"}`}
            </button>
          </div>
        )}
      </section>

      <ReprocessConsole log={log} running={running} stages={runLabels} stageIndex={stageIndex} />

      {/* Related tools that are NOT reprocessing but usually precede or follow it */}
      <section className="text-[10px] text-[var(--muted)] space-y-1">
        <div className="font-medium text-xs text-[var(--fg)]">Related tools</div>
        <div>
          Duplicate pages, permanent delete, duplicate projects and stuck jobs live in{" "}
          <button onClick={() => onOpenTab("data-tools")} className="text-[var(--accent)] hover:underline">Data tools &rarr;</button>
          {" "}— after hiding or deleting pages, run &ldquo;Rules changed&rdquo; here to refresh project analysis.
        </div>
        <div>
          YOLO runs and loads (per project, bulk, catch-up) stay in{" "}
          <button onClick={() => onOpenTab("ai-models")} className="text-[var(--accent)] hover:underline">AI Models &rarr;</button>
          {" "}— then &ldquo;After YOLO load&rdquo; here. Pipeline step toggles and the CSI grid stay in{" "}
          <button onClick={() => onOpenTab("pipeline")} className="text-[var(--accent)] hover:underline">Pipeline &rarr;</button>.
        </div>
      </section>
    </div>
  );
}
