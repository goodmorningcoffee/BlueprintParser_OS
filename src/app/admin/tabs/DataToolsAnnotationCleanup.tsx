"use client";

/**
 * Admin › Data tools › Annotation cleanup (ROOT only). Pick projects (or all) and sources, pick a
 * mode, Count (a dry run that changes nothing), then type the phrase to run it. Any change to
 * the choices discards the count, so what runs is always what was counted.
 *   Remove exact duplicates — rows identical on page, source, name, box and model; keeps the oldest.
 *   Delete annotations — every matching row; optionally also clears page-level CSI codes.
 * User-made sources (user-drawn markup, takeoff, symbol-search saves) start unticked.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiErrorMessage } from "@/lib/client-persist";
import OpenReprocessLink from "./OpenReprocessLink";
import type { ReprocessPreset } from "./reprocess-plan";

interface ScopeProject { publicId: string; name: string; companyId: number; annotations: number }
interface SourceRow { source: string; count: number; userMade: boolean }
interface ProjectResult { publicId: string; name: string; annotations: number; pagesCsiCleared: number; error?: string }
interface RunResult {
  dryRun: boolean; mode: Mode; sources: string[]; clearPageCsi: boolean; confirmPhrase: string;
  projects: ProjectResult[]; total: number; pagesCsiCleared: number;
}
type Mode = "dedupe" | "delete";

const SOURCE_LABELS: Record<string, string> = {
  user: "user — USER-DRAWN markup",
  takeoff: "takeoff — user takeoff measurements",
  "takeoff-scale": "takeoff-scale — user scale calibrations",
  "symbol-search": "symbol-search — user-saved symbol search hits",
  yolo: "yolo — YOLO detections",
  "shape-parse": "shape-parse — keynote shapes",
};

async function call<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new Error(apiErrorMessage(json) || `HTTP ${res.status}`);
  return json as T;
}

export default function DataToolsAnnotationCleanup({ isRootAdmin, onOpenReprocess }: { isRootAdmin: boolean; onOpenReprocess: (preset: ReprocessPreset) => void }) {
  const [companyId, setCompanyId] = useState("");
  const [companyOptions, setCompanyOptions] = useState<number[]>([]);
  const [projects, setProjects] = useState<ScopeProject[]>([]);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [allProjects, setAllProjects] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pickedSources, setPickedSources] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<Mode>("dedupe");
  const [clearPageCsi, setClearPageCsi] = useState(false);
  const [count, setCount] = useState<RunResult | null>(null);
  const [done, setDone] = useState<RunResult | null>(null);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const query = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";

  const load = useCallback(async () => {
    setMessage("");
    try {
      const data = await call<{ projects: ScopeProject[]; sources: SourceRow[] }>(`/api/admin/annotation-cleanup${query}`, "GET");
      setProjects(data.projects);
      setSources(data.sources);
      setPickedSources(new Set(data.sources.filter((s) => !s.userMade).map((s) => s.source)));
      setPicked(new Set());
      if (!companyId) setCompanyOptions([...new Set(data.projects.map((p) => p.companyId))].sort((a, b) => a - b));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Load failed");
    }
  }, [query, companyId]);

  useEffect(() => { if (isRootAdmin) void load(); }, [isRootAdmin, load]);

  // Any change to the choices invalidates the count: what runs must be what was counted.
  useEffect(() => { setCount(null); setConfirm(""); }, [companyId, allProjects, picked, pickedSources, mode, clearPageCsi]);

  const body = useMemo(() => ({
    mode,
    ...(allProjects ? { all: true } : { projectPublicIds: [...picked] }),
    sources: [...pickedSources],
    clearPageCsi: mode === "delete" && clearPageCsi,
  }), [mode, allProjects, picked, pickedSources, clearPageCsi]);

  if (!isRootAdmin) return null;

  const toggle = (set: Set<string>, value: string) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value); else next.add(value);
    return next;
  };
  const ready = pickedSources.size > 0 && (allProjects || picked.size > 0);

  async function run(dryRun: boolean) {
    setBusy(true);
    setMessage("");
    try {
      const result = await call<RunResult>(`/api/admin/annotation-cleanup${query}`, "POST", { ...body, dryRun, ...(dryRun ? {} : { confirm }) });
      if (dryRun) { setCount(result); setDone(null); } else { setDone(result); setCount(null); setConfirm(""); void load(); }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  const userMadePicked = sources.filter((s) => s.userMade && pickedSources.has(s.source));
  const shown = count ?? done;

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Annotation cleanup</h2>
        <p className="text-xs text-[var(--muted)]">
          Root only. Count changes nothing. Deleting cannot be undone. Demo projects are never touched.
          After deleting YOLO or clearing page CSI, rebuild CSI codes and intelligence from the Reprocess tab (the
          &ldquo;Delete YOLO annotations&rdquo; stage there does both in one plan).
        </p>
        <OpenReprocessLink preset="clean-yolo" onOpen={onOpenReprocess} note="Same thing as one plan:" />
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className="bg-[var(--bg)] border border-[var(--border)] rounded px-2 py-1">
          <option value="">All companies</option>
          {companyOptions.map((id) => <option key={id} value={String(id)}>Company {id}</option>)}
        </select>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={allProjects} onChange={(e) => setAllProjects(e.target.checked)} /> All projects ({projects.length})
        </label>
      </div>

      {!allProjects && (
        <div className="text-xs space-y-1">
          <div className="flex gap-2">
            <button onClick={() => setPicked(new Set(projects.map((p) => p.publicId)))} className="px-2 py-0.5 rounded border border-[var(--border)]">Select all</button>
            <button onClick={() => setPicked(new Set())} className="px-2 py-0.5 rounded border border-[var(--border)]">Deselect all</button>
            <span className="text-[var(--muted)]">{picked.size} selected</span>
          </div>
          <div className="max-h-56 overflow-y-auto border border-[var(--border)] rounded p-2 grid gap-0.5">
            {projects.map((p) => (
              <label key={p.publicId} className="flex items-center gap-1">
                <input type="checkbox" checked={picked.has(p.publicId)} onChange={() => setPicked(toggle(picked, p.publicId))} />
                {p.name} <span className="text-[var(--muted)]">({p.annotations} annotations)</span>
              </label>
            ))}
            {projects.length === 0 && <span className="text-[var(--muted)]">No projects in scope.</span>}
          </div>
        </div>
      )}

      <div className="text-xs space-y-1">
        <div className="font-medium">Sources</div>
        {sources.map((s) => (
          <label key={s.source} className={`flex items-center gap-1 ${s.userMade ? "text-amber-500" : ""}`}>
            <input type="checkbox" checked={pickedSources.has(s.source)} onChange={() => setPickedSources(toggle(pickedSources, s.source))} />
            {SOURCE_LABELS[s.source] ?? s.source} ({s.count}){s.userMade ? " — made by people, not the pipeline" : ""}
          </label>
        ))}
        {sources.length === 0 && <span className="text-[var(--muted)]">No annotations in scope.</span>}
        {userMadePicked.length > 0 && (
          <div className="text-amber-500">Warning: user-made sources are ticked ({userMadePicked.map((s) => s.source).join(", ")}). Their work will be deleted.</div>
        )}
      </div>

      <div className="text-xs space-y-1">
        <label className="flex items-center gap-1">
          <input type="radio" checked={mode === "dedupe"} onChange={() => setMode("dedupe")} /> Remove exact duplicates (same page, source, name, box and model; keeps the oldest)
        </label>
        <label className="flex items-center gap-1">
          <input type="radio" checked={mode === "delete"} onChange={() => setMode("delete")} /> Delete annotations (every row of the ticked sources)
        </label>
        {mode === "delete" && (
          <label className="flex items-center gap-1 pl-5">
            <input type="checkbox" checked={clearPageCsi} onChange={(e) => setClearPageCsi(e.target.checked)} /> Also clear page-level CSI codes (pages.csiCodes) in these projects
          </label>
        )}
      </div>

      <button disabled={busy || !ready} onClick={() => run(true)} className="px-3 py-1 rounded bg-[var(--accent)] text-white text-sm disabled:opacity-50">
        {busy && !count ? "Counting…" : "Count (dry run)"}
      </button>
      {message && <div className="text-sm text-red-500">{message}</div>}

      {shown && (
        <div className="text-xs space-y-1">
          <div className="font-medium">
            {shown.dryRun ? "Would " : ""}{shown.mode === "dedupe" ? "remove" : "delete"} {shown.total} annotation(s)
            {shown.clearPageCsi ? ` and clear CSI codes on ${shown.pagesCsiCleared} page(s)` : ""}
            {" "}across {shown.projects.length} project(s){shown.dryRun ? "" : " — done"}. Sources: {shown.sources.join(", ") || "none"}.
          </div>
          {!shown.dryRun && <OpenReprocessLink preset="detectors-changed" onOpen={onOpenReprocess} note="Then rebuild CSI codes + intelligence:" />}
          <div className="max-h-56 overflow-y-auto">
            {shown.projects.filter((p) => p.annotations > 0 || p.pagesCsiCleared > 0 || p.error).map((p) => (
              <div key={p.publicId}>
                {p.name}: {p.annotations}{shown.clearPageCsi ? ` · ${p.pagesCsiCleared} page(s) CSI` : ""}{p.error ? ` — FAILED: ${p.error}` : ""}
              </div>
            ))}
          </div>
        </div>
      )}

      {count && count.total + count.pagesCsiCleared > 0 && (
        <div className="flex items-center gap-2 text-xs">
          <span>Type {count.confirmPhrase} to confirm:</span>
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} className="bg-[var(--bg)] border border-[var(--border)] rounded px-1 w-24" />
          <button disabled={busy || confirm !== count.confirmPhrase} onClick={() => run(false)} className="px-2 py-1 rounded bg-red-600 text-white disabled:opacity-40">
            {busy ? "Working…" : count.mode === "dedupe" ? `Remove ${count.total} duplicates` : `Delete ${count.total} annotations`}
          </button>
        </div>
      )}
    </section>
  );
}
