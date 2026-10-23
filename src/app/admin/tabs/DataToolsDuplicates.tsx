"use client";

/**
 * Admin › Data tools › Duplicates. Scan (changes nothing) → review blocks and pairs with
 * thumbnails side by side → select → hide. Hiding is reversible (Restore) and page numbers never
 * change. Every block and lone pair has a checkbox: Exact is pre-selected (except in a project
 * showing revision evidence, bulkHold), and the lower tiers are selected by the admin — one at a
 * time, a whole tier ("Select all near"), or by score ("Select all ≥ 95 %"), per project or across
 * the whole scan (owner 2026-10-22). Repeat / revision blocks keep the latest copy by default.
 * The server re-plans every selected unit under the project lock (apply-selection).
 * Root also gets "Delete hidden pages permanently" at the bottom (DataToolsPermanentDelete):
 * the one irreversible step, previewed first, typed phrase, page numbers kept.
 */

import { useCallback, useEffect, useState } from "react";
import { apiErrorMessage } from "@/lib/client-persist";
import DataToolsPermanentDelete from "./DataToolsPermanentDelete";
import {
  defaultSelection,
  selectAtLeast,
  selectBand,
  selectedUnits,
  selectionRequest,
  selectionUnits,
  unitDefaultKeep,
  type SelectionMap,
} from "@/lib/page-dedup/selection";
import type { DuplicateBlock, DuplicateCounts, DuplicateKeep, DuplicatePair, DuplicateTier } from "@/lib/page-dedup/types";

interface ProjectOption { id: string; name: string; status: string; isDemo: boolean; companyId?: number; companyName?: string }
type ReportPair = DuplicatePair & { diff?: { op: "-" | "+"; text: string }[] };
interface ProjectReport {
  project: { publicId: string; name: string; companyId: number; numPages: number | null };
  reportDigest: string;
  counts: DuplicateCounts;
  blocks: DuplicateBlock[];
  bulkHold: string | null;
  pairs: ReportPair[];
  hidden: { page: number; canonical: number; tier: string }[];
  thumbnailBase: string;
}
interface CrossPair { a: string; b: string; shared: number; bPages: number; aPages: number; copy: boolean }
interface ScanState {
  reports: ProjectReport[];
  skipped: { name: string; reason: string }[];
  cross: CrossPair[];
  dupRows: { total: number; projects: { publicId: string; name: string; rows: number }[] } | null;
  done: boolean;
}

const EMPTY: ScanState = { reports: [], skipped: [], cross: [], dupRows: null, done: false };
const TIERS: DuplicateTier[] = ["exact", "run", "near", "possible"];
const TIER_LABEL: Record<DuplicateTier, string> = { exact: "exact", run: "repeat", near: "near", possible: "possible" };
type KeepMap = Record<string, DuplicateKeep>;
interface ApplyResult { projectPublicId: string; hidden?: unknown[]; skipped?: string | { reason: string }[] }

/** "Hid 12 page(s) in 3 project(s); skipped …" from apply-selection results. */
function summarize(results: ApplyResult[]): string {
  const hid = results.reduce((n, r) => n + (Array.isArray(r.hidden) ? r.hidden.length : 0), 0);
  const pageSkips = results.flatMap((r) => (Array.isArray(r.skipped) ? r.skipped.map((s) => s.reason) : []));
  const projectSkips = results.filter((r) => typeof r.skipped === "string").map((r) => r.skipped as string);
  const parts = [`Hid ${hid} page(s) in ${results.length - projectSkips.length} project(s)`];
  if (pageSkips.length) parts.push(`skipped ${pageSkips.length} page(s) (${[...new Set(pageSkips)].join(", ")})`);
  if (projectSkips.length) parts.push(`${projectSkips.length} project(s) not changed (${[...new Set(projectSkips)].join(", ")}) — scan again`);
  return parts.join("; ");
}

function Check({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return <input type="checkbox" aria-label={label} checked={on} onChange={(e) => onChange(e.target.checked)} className="shrink-0" />;
}

function KeepSelect({ value, onChange }: { value: DuplicateKeep; onChange: (k: DuplicateKeep) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as DuplicateKeep)}
      className="text-xs bg-[var(--bg)] border border-[var(--border)] rounded px-1">
      <option value="latest">keep latest copy</option>
      <option value="earliest">keep first copy</option>
    </select>
  );
}

/** Per-tier "Select all / none" buttons for the given reports (one project or the whole scan). */
function BandButtons({ reports, sel, onBand }: {
  reports: ProjectReport[]; sel: Record<string, SelectionMap>; onBand: (tier: DuplicateTier, on: boolean) => void;
}) {
  return (
    <>
      {TIERS.map((tier) => {
        const units = reports.flatMap((r) => selectionUnits(r).filter((u) => u.tier === tier).map((u) => ({ u, on: !!sel[r.project.publicId]?.[u.key] })));
        if (!units.length) return null;
        const chosen = units.filter((x) => x.on).length;
        return (
          <span key={tier} className="inline-flex items-center gap-1 border border-[var(--border)] rounded px-1">
            {TIER_LABEL[tier]} {chosen}/{units.length}
            <button className="underline" onClick={() => onBand(tier, true)}>all</button>
            <button className="underline" onClick={() => onBand(tier, false)}>none</button>
          </span>
        );
      })}
    </>
  );
}
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const pad4 = (n: number) => String(n).padStart(4, "0");

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; data: unknown }> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, data };
}

function Thumb({ base, page, label }: { base: string; page: number; label: string }) {
  return (
    <figure className="w-40 shrink-0">
      <div className="aspect-[4/3] bg-[var(--bg)] rounded overflow-hidden border border-[var(--border)] flex items-center justify-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`${base}/page_${pad4(page)}.png`} alt={`Page ${page}`} className="w-full h-full object-contain" loading="lazy" />
      </div>
      <figcaption className="text-[10px] text-[var(--muted)] mt-0.5">{label} p.{page}</figcaption>
    </figure>
  );
}

function PairRow({ pair, base }: { pair: ReportPair; base: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-[var(--border)] py-2">
      <button className="text-xs text-left w-full" onClick={() => setOpen(!open)}>
        p.{pair.page} ↔ p.{pair.canonical} · {pair.tier} · content {pct(pair.content)} · full {pct(pair.full)}
        {pair.sameNumber ? " · same sheet number" : ""}{pair.identical ? " · identical text" : ""}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <div className="flex gap-3">
            <Thumb base={base} page={pair.canonical} label="keep" />
            <Thumb base={base} page={pair.page} label="duplicate" />
          </div>
          {pair.diff && pair.diff.length > 0 && (
            <pre className="text-[10px] bg-[var(--bg)] p-2 rounded max-h-48 overflow-auto whitespace-pre-wrap">
              {pair.diff.map((d, i) => (
                <div key={i} className={d.op === "-" ? "text-red-400" : "text-green-400"}>{d.op} {d.text}</div>
              ))}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function ProjectPanel({ report, query, sel, keep, threshold, onSel, onKeep, onChanged }: {
  report: ProjectReport;
  query: string;
  sel: SelectionMap;
  keep: KeepMap;
  threshold: number;
  onSel: (next: SelectionMap) => void;
  onKeep: (next: KeepMap) => void;
  onChanged: (msg: string, applied?: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { counts, project } = report;
  const chosen = selectedUnits(report, sel);
  const chosenPages = chosen.reduce((n, u) => n + u.pages, 0);
  const keepOf = (key: string, tier: DuplicateTier) => keep[key] ?? unitDefaultKeep({ tier });

  async function removeSelected() {
    setBusy(true);
    const { ok, data } = await postJson(`/api/admin/duplicates/apply-selection${query}`, {
      selections: [{ projectPublicId: project.publicId, reportDigest: report.reportDigest, ...selectionRequest(report, sel, keep) }],
    });
    setBusy(false);
    if (!ok) return onChanged(`${project.name}: ${apiErrorMessage(data) ?? "failed"}`);
    onChanged(`${project.name}: ${summarize((data as { results: ApplyResult[] }).results)}`, true);
  }

  async function restore() {
    setBusy(true);
    const { ok, data } = await postJson(`/api/admin/duplicates/restore${query}`, { projectPublicId: project.publicId });
    setBusy(false);
    if (!ok) return onChanged(`${project.name}: ${apiErrorMessage(data) ?? "failed"}`);
    onChanged(`${project.name}: restored ${(data as { restored: number[] }).restored.length} page(s)`, true);
  }

  const unitControls = (key: string, tier: DuplicateTier, label: string) => (
    <>
      <Check on={!!sel[key]} onChange={(on) => onSel({ ...sel, [key]: on })} label={label} />
      <KeepSelect value={keepOf(key, tier)} onChange={(k) => onKeep({ ...keep, [key]: k })} />
    </>
  );

  return (
    <div className="border border-[var(--border)] rounded p-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <button className="font-medium text-left flex-1" onClick={() => setOpen(!open)}>{open ? "▼" : "▶"} {project.name}</button>
        <span className="text-xs text-[var(--muted)]">
          {counts.pages} pages · exact {counts.exact} · repeat {counts.run} · near {counts.near} · possible {counts.possible} · hidden {report.hidden.length}
        </span>
        {chosenPages > 0 && (
          <button disabled={busy} className="text-xs px-2 py-1 rounded bg-[var(--accent)] text-white disabled:opacity-50" onClick={removeSelected}>
            Remove {chosenPages} selected page(s)
          </button>
        )}
        {report.hidden.length > 0 && (
          <button disabled={busy} className="text-xs px-2 py-1 rounded border border-[var(--border)] disabled:opacity-50" onClick={restore}>
            Restore {report.hidden.length}
          </button>
        )}
      </div>
      {report.bulkHold && (
        <div className="text-xs text-[var(--muted)] mt-1">Nothing pre-selected: this project {report.bulkHold}. Review before selecting.</div>
      )}
      {selectionUnits(report).length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs mt-2">
          <span>Select:</span>
          <BandButtons reports={[report]} sel={{ [project.publicId]: sel }} onBand={(tier, on) => onSel(selectBand(report, sel, tier, on))} />
          <button className="underline" onClick={() => onSel(selectAtLeast(report, sel, threshold))}>all ≥ {pct(threshold)}</button>
        </div>
      )}
      {open && (
        <div className="mt-3 space-y-3">
          {report.blocks.map((b) => (
            <div key={b.id} className="bg-[var(--surface)] rounded p-2">
              <div className="flex items-center gap-2 text-xs">
                {unitControls(`b:${b.id}`, b.tier, `Select block ${b.id}`)}
                <span className="flex-1">
                  Pages {b.start + b.offset}–{b.start + b.offset + b.length - 1} repeat pages {b.start}–{b.start + b.length - 1}
                  {" "}· {b.tier} · {b.label} · min full {pct(b.minFull)}
                </span>
              </div>
              {report.pairs.filter((p) => p.blockId === b.id).map((p) => <PairRow key={p.page} pair={p} base={report.thumbnailBase} />)}
            </div>
          ))}
          {report.pairs.some((p) => p.blockId === null) && (
            <div className="bg-[var(--surface)] rounded p-2">
              <div className="text-xs">Pairs outside blocks</div>
              {report.pairs.filter((p) => p.blockId === null).map((p) => (
                <div key={p.page} className="flex items-start gap-2">
                  <div className="flex items-center gap-1 pt-2 text-xs">{unitControls(`p:${p.page}`, p.tier, `Select page ${p.page}`)}</div>
                  <div className="flex-1"><PairRow pair={p} base={report.thumbnailBase} /></div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function DataToolsDuplicates({ isRootAdmin }: { isRootAdmin: boolean }) {
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [target, setTarget] = useState("all");
  const [companyId, setCompanyId] = useState("");
  const [scan, setScan] = useState<ScanState>(EMPTY);
  const [scanning, setScanning] = useState(false);
  const [message, setMessage] = useState("");
  const [confirm, setConfirm] = useState("");
  const [sel, setSel] = useState<Record<string, SelectionMap>>({});
  const [keep, setKeep] = useState<Record<string, KeepMap>>({});
  const [thresholdPct, setThresholdPct] = useState("95");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: ProjectOption[]) => setProjects(Array.isArray(rows) ? rows : []))
      .catch(() => setProjects([]));
  }, []);

  const query = isRootAdmin && companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
  const companies = isRootAdmin
    ? [...new Map(projects.filter((p) => p.companyId).map((p) => [p.companyId, p.companyName ?? String(p.companyId)])).entries()]
    : [];
  const visibleProjects = projects.filter((p) => !p.isDemo && (!companyId || String(p.companyId) === companyId));
  const threshold = Math.min(100, Math.max(0, Number(thresholdPct) || 0)) / 100;

  const runScan = useCallback(async () => {
    setScanning(true);
    setMessage("");
    setScan(EMPTY);
    setSel({});
    setKeep({});
    setConfirm("");
    const body = target === "all" ? { all: true } : { projectPublicIds: [target] };
    try {
      const res = await fetch(`/api/admin/duplicates/scan${query}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!res.ok || !res.body) {
        setMessage(apiErrorMessage(await res.json().catch(() => null)) ?? "Scan failed");
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const next: ScanState = { reports: [], skipped: [], cross: [], dupRows: null, done: false };
      const defaults: Record<string, SelectionMap> = {};
      for (;;) {
        const { value, done } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = done ? "" : (lines.pop() ?? "");
        for (const line of lines) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line) as { t: string } & Record<string, unknown>;
          if (msg.t === "project") {
            const report = msg as unknown as ProjectReport;
            next.reports.push(report);
            defaults[report.project.publicId] = defaultSelection(report);
          } else if (msg.t === "skipped" || msg.t === "error") {
            const p = msg.project as { name?: string } | undefined;
            next.skipped.push({ name: p?.name ?? "scan", reason: String(msg.reason ?? msg.message ?? "") });
          } else if (msg.t === "crossProject") next.cross.push(...(msg.pairs as CrossPair[]));
          else if (msg.t === "duplicatePageRows") next.dupRows = msg as unknown as NonNullable<ScanState["dupRows"]>;
          else if (msg.t === "done") next.done = true;
        }
        setScan({ ...next, reports: [...next.reports] });
        setSel((cur) => ({ ...defaults, ...cur }));
        if (done) break;
      }
    } catch {
      setMessage("Scan failed");
    } finally {
      setScanning(false);
    }
  }, [query, target]);

  const mapAll = (fn: (r: ProjectReport, cur: SelectionMap) => SelectionMap) =>
    setSel((cur) => Object.fromEntries(scan.reports.map((r) => [r.project.publicId, fn(r, cur[r.project.publicId] ?? {})])));
  const chosen = scan.reports
    .map((r) => ({ r, pages: selectedUnits(r, sel[r.project.publicId] ?? {}).reduce((n, u) => n + u.pages, 0) }))
    .filter((x) => x.pages > 0);
  const chosenPages = chosen.reduce((n, x) => n + x.pages, 0);

  /** After an apply the reviewed reports are stale: drop the applied projects' selection. */
  function onChanged(msg: string, applied?: boolean, publicIds?: string[]) {
    setMessage(msg);
    if (applied && publicIds) setSel((cur) => Object.fromEntries(Object.entries(cur).filter(([id]) => !publicIds.includes(id))));
  }

  async function removeAllSelected() {
    setBusy(true);
    const selections = chosen.map(({ r }) => ({
      projectPublicId: r.project.publicId,
      reportDigest: r.reportDigest,
      ...selectionRequest(r, sel[r.project.publicId] ?? {}, keep[r.project.publicId] ?? {}),
    }));
    const { ok, data } = await postJson(`/api/admin/duplicates/apply-selection${query}`, { selections });
    setBusy(false);
    setConfirm("");
    if (!ok) return setMessage(apiErrorMessage(data) ?? "Remove failed");
    onChanged(summarize((data as { results: ApplyResult[] }).results), true, selections.map((s) => s.projectPublicId));
  }
  const nameOf = (publicId: string) => scan.reports.find((r) => r.project.publicId === publicId)?.project.name ?? publicId;

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Duplicate pages</h2>
        <p className="text-xs text-[var(--muted)]">
          Scan changes nothing. Remove hides a page from the page list, search, chat and AI tools; page numbers stay and Restore undoes it.
          Hiding saves no storage, YOLO or page charges. Exact duplicates are pre-selected; select lower tiers yourself.
          Pages carrying your work are never hidden.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {isRootAdmin && (
          <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className="bg-[var(--bg)] border border-[var(--border)] rounded px-2 py-1">
            <option value="">All companies</option>
            {companies.map(([id, name]) => <option key={id} value={String(id)}>{name}</option>)}
          </select>
        )}
        <select value={target} onChange={(e) => setTarget(e.target.value)} className="bg-[var(--bg)] border border-[var(--border)] rounded px-2 py-1">
          <option value="all">All projects</option>
          {visibleProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button disabled={scanning} onClick={runScan} className="px-3 py-1 rounded bg-[var(--accent)] text-white disabled:opacity-50">
          {scanning ? "Scanning…" : "Scan"}
        </button>
      </div>
      {message && <div className="text-sm text-[var(--accent)]">{message}</div>}
      {scan.reports.some((r) => selectionUnits(r).length > 0) && (
        <div className="space-y-2 text-xs border border-[var(--border)] rounded p-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">All scanned projects — select:</span>
            <BandButtons reports={scan.reports} sel={sel} onBand={(tier, on) => mapAll((r, cur) => selectBand(r, cur, tier, on))} />
            <span className="inline-flex items-center gap-1">
              all ≥
              <input value={thresholdPct} onChange={(e) => setThresholdPct(e.target.value)} inputMode="decimal" aria-label="Similarity threshold percent"
                className="bg-[var(--bg)] border border-[var(--border)] rounded px-1 w-12" />%
              <button className="underline" onClick={() => mapAll((r, cur) => selectAtLeast(r, cur, threshold))}>select</button>
            </span>
            <button className="underline" onClick={() => setSel({})}>clear all</button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span>{chosenPages} page(s) selected in {chosen.length} project(s).</span>
            {chosenPages > 0 && scan.done && (
              <>
                <span>Type REMOVE:</span>
                <input value={confirm} onChange={(e) => setConfirm(e.target.value)} className="bg-[var(--bg)] border border-[var(--border)] rounded px-1 w-24" />
                <button disabled={confirm !== "REMOVE" || busy} onClick={removeAllSelected} className="px-2 py-1 rounded bg-red-600 text-white disabled:opacity-40">
                  Remove all selected
                </button>
              </>
            )}
          </div>
        </div>
      )}
      <div className="space-y-2">
        {scan.reports.map((r) => {
          const id = r.project.publicId;
          return (
            <ProjectPanel key={id} report={r} query={query} sel={sel[id] ?? {}} keep={keep[id] ?? {}} threshold={threshold}
              onSel={(next) => setSel((cur) => ({ ...cur, [id]: next }))}
              onKeep={(next) => setKeep((cur) => ({ ...cur, [id]: next }))}
              onChanged={(msg, applied) => onChanged(msg, applied, [id])} />
          );
        })}
      </div>
      {scan.cross.length > 0 && (
        <div className="text-xs space-y-1">
          <div className="font-medium">Cross-project copies (report only — see Duplicate projects below)</div>
          {scan.cross.map((c) => (
            <div key={`${c.a}:${c.b}`}>
              {nameOf(c.b)} shares {c.shared} of its {c.bPages} pages with {nameOf(c.a)}{c.copy ? " — page-for-page copy" : ""}
            </div>
          ))}
        </div>
      )}
      {scan.dupRows && (
        <div className="text-xs">
          {scan.dupRows.total} duplicate page rows {target === "all" ? "company-wide" : "in this project"} (same page number stored twice; read-only)
          {target === "all" && scan.dupRows.projects.length > 0 && `: ${scan.dupRows.projects.map((p) => `${p.name} ${p.rows}`).join("; ")}`}
        </div>
      )}
      {scan.skipped.length > 0 && (
        <div className="text-xs text-[var(--muted)]">
          Not scanned: {scan.skipped.map((s) => `${s.name} (${s.reason})`).join("; ")}
        </div>
      )}
      {scan.done && scan.reports.length === 0 && <div className="text-xs text-[var(--muted)]">No completed projects in scope.</div>}
      {isRootAdmin && <DataToolsPermanentDelete query={query} projects={visibleProjects.map((p) => ({ id: p.id, name: p.name }))} />}
    </section>
  );
}
