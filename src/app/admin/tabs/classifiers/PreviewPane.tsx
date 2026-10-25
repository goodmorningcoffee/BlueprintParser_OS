"use client";

// [classifier builder track 3] Preview: pick a project + pages, dry-run the CURRENT DRAFT (POST
// /api/admin/classifiers/preview, no writes) → proposals per page with displayName, p, nameP and the
// top contributions ("Div 08 share +1.6"), plus the verdict-agreement table (stored accept / reject /
// rename labels vs what the draft now says). "Run on project" starts reprocess scope=classifiers for
// that project (POST /api/admin/classifiers/run, NDJSON) and prints its stream.

import { useState } from "react";
import type { ClassifierProposal, ClassifierRecipe } from "@/lib/classifier-engine";
import { formatReprocessEvent } from "@/app/admin/reprocess-client";
import { formatContribution, parsePageSpec, pct } from "./draft-ops";

const INPUT = "px-2 py-1 text-xs bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--fg)] outline-none";
const BTN = "px-3 py-1 text-xs rounded border border-[var(--border)] hover:border-[var(--accent)] disabled:opacity-50";

export interface PreviewProject { id: string; name: string; numPages: number | null; isDemo: boolean; companyId?: number }

interface AgreementRow { classId: string; name: string; labeled: number; agree: number; disagree: number; notProposed: number }
interface PreviewPage { pageNumber: number; proposals: ClassifierProposal[]; storedCount: number; errors: Array<{ recipeId: string; message: string }>; ms: number }
interface PreviewResult {
  recipeId: string; recipeVersion: number; pages: PreviewPage[];
  agreement: { rows: AgreementRow[]; totals: Omit<AgreementRow, "classId" | "name"> };
  summary: { pagesRun: number; pagesWithYolo: number; proposals: number; storedProposals: number; verdicts: number };
}

export interface PreviewPaneProps {
  draft: ClassifierRecipe | null;
  projects: PreviewProject[];
  /** The company the editor is showing (root may pick another); only its projects are offered. */
  companyId: number | null;
  /** Run is reprocess for the caller's OWN company only. */
  canRun: boolean;
}

async function readError(res: Response): Promise<string> {
  try { const j = await res.json(); return j?.error?.message ?? `HTTP ${res.status}`; } catch { return `HTTP ${res.status}`; }
}

/** The closing line(s) of a run: a missing `done` or a 0-proposal run gets an explanation, not silence. */
export function runVerdictLines(done: Record<string, unknown> | null, reasons: readonly string[]): string[] {
  if (!done) return ["Stream ended without a done line — the run may have been cut off; check the server log."];
  if (typeof done.proposals !== "number" || done.proposals > 0) return [];
  const why = reasons.filter(Boolean);
  return [why.length
    ? `No proposals were written. Why: ${why.join("; ")}.`
    : "No proposals were written: the engine ran on the pages with YOLO detections but no table candidate cleared the recipe thresholds."];
}

function ProposalRow({ p }: { p: ClassifierProposal }) {
  const why = [...p.detectWhy.slice(0, 2), ...p.nameWhy.slice(0, 4)];
  return (
    <li className="rounded border border-[var(--border)] px-2 py-1 text-[11px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{p.displayName}</span>
        {p.classId ? <span className="font-mono text-[10px] text-[var(--muted)]">{p.classId}</span> : <span className="text-[10px] text-amber-300">fallback{p.derivedName ? ` · title "${p.derivedName.text}" (${pct(p.derivedName.confidence)})` : ""}</span>}
        <span className="text-[10px] text-[var(--muted)]">p {pct(p.p)} · nameP {pct(p.nameP)} · margin {pct(p.margin)}{p.runnerUp ? ` · runner-up ${p.runnerUp.classId} ${pct(p.runnerUp.nameP)}` : ""}</span>
        <span className="text-[10px] text-[var(--muted)] font-mono ml-auto">[{p.bbox.map((v) => v.toFixed(2)).join(", ")}]</span>
      </div>
      <ul className="flex flex-wrap gap-x-3 text-[10px] text-[var(--muted)]">
        {why.map((c) => <li key={c.signalId} title={c.signalId}>{formatContribution(c)}</li>)}
      </ul>
    </li>
  );
}

export default function PreviewPane({ draft, projects, companyId, canRun }: PreviewPaneProps) {
  const [projectId, setProjectId] = useState("");
  const [pagesText, setPagesText] = useState("1-5");
  const [busy, setBusy] = useState<"preview" | "run" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [runLog, setRunLog] = useState<string[]>([]);
  const eligible = projects.filter((p) => !p.isDemo && (companyId === null || p.companyId === undefined || p.companyId === companyId));
  const pages = parsePageSpec(pagesText);
  const project = eligible.find((p) => p.id === projectId);

  const preview = async () => {
    if (!draft || !project || !pages.length) return;
    setBusy("preview"); setError(null);
    try {
      const res = await fetch("/api/admin/classifiers/preview", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id, pages, recipe: draft, ...(companyId !== null ? { companyId } : {}) }),
      });
      if (!res.ok) { setError(await readError(res)); setResult(null); return; }
      setResult((await res.json()) as PreviewResult);
    } catch (e) { setError(e instanceof Error ? e.message : "Preview failed"); }
    finally { setBusy(null); }
  };

  const run = async () => {
    if (!project) return;
    setBusy("run"); setRunLog([]);
    try {
      const res = await fetch("/api/admin/classifiers/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: project.id }) });
      if (!res.ok || !res.body) { setRunLog([`Error: ${await readError(res)}`]); return; }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      // [clf visibility 2026-10-25] every line is printed; the server's reasons (warnings / errors) are kept so
      // a run that ends with 0 proposals can say why instead of just "Done".
      const reasons: string[] = [];
      let doneLine: Record<string, unknown> | null = null;
      const handle = (raw: string) => {
        if (!raw.trim()) return;
        let event: Record<string, unknown>;
        try { event = JSON.parse(raw) as Record<string, unknown>; }
        catch { setRunLog((l) => [...l, `  (unparseable line) ${raw.slice(0, 120)}`]); return; }
        if (event.type === "warning" || event.type === "error") reasons.push(String(event.message ?? event.error ?? ""));
        if (event.type === "done") doneLine = event;
        const line = formatReprocessEvent(event);
        if (line !== null) setRunLog((l) => [...l, line]);
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        lines.forEach(handle);
      }
      handle(buffer);
      setRunLog((l) => [...l, ...runVerdictLines(doneLine, reasons)]);
    } catch (e) { setRunLog((l) => [...l, `Error: ${e instanceof Error ? e.message : "run failed"}`]); }
    finally { setBusy(null); }
  };

  return (
    <div className="space-y-2" data-testid="preview-pane">
      <p className="text-xs font-medium">Preview on real pages (dry run — nothing is written)</p>
      <div className="flex flex-wrap items-center gap-2">
        <select className={INPUT} value={projectId} aria-label="preview project" onChange={(e) => { setProjectId(e.target.value); setResult(null); }}>
          <option value="">Select a project…</option>
          {eligible.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.numPages ?? "?"} pages)</option>)}
        </select>
        <label className="text-[10px] text-[var(--muted)]">pages <input className={`${INPUT} w-28`} value={pagesText} aria-label="preview pages" placeholder="1-5, 8" onChange={(e) => setPagesText(e.target.value)} /></label>
        <span className="text-[10px] text-[var(--muted)]">{pages.length ? `${pages.length} page${pages.length === 1 ? "" : "s"} (max 20)` : "no valid pages"}</span>
        <button type="button" className={BTN} disabled={!draft || !project || !pages.length || busy !== null} onClick={preview}>{busy === "preview" ? "Running…" : "Preview draft"}</button>
        {canRun && <button type="button" className={BTN} title="Reprocess scope “classifiers” for this project with the SAVED recipes" disabled={!project || busy !== null} onClick={run}>{busy === "run" ? "Running…" : "Run saved recipes on project"}</button>}
      </div>
      {eligible.length === 0 && <p className="text-[10px] text-amber-400">No non-demo projects to preview on.</p>}
      {!draft && <p className="text-[10px] text-[var(--muted)] italic">Select a recipe to preview.</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
      {result && (
        <div className="space-y-2">
          <p className="text-[10px] text-[var(--muted)]">
            {result.summary.pagesRun} pages run ({result.summary.pagesWithYolo} with YOLO rows) · {result.summary.proposals} proposals now vs {result.summary.storedProposals} stored · {result.summary.verdicts} labels compared · recipe {result.recipeId} v{result.recipeVersion}
          </p>
          {result.summary.pagesRun === 0 && <p className="text-xs text-amber-400">None of those page numbers exist in this project.</p>}
          {result.summary.pagesRun > 0 && result.summary.pagesWithYolo === 0 && <p className="text-xs text-amber-400">These pages have no stored YOLO detections, so there are no candidates — run YOLO on the project first.</p>}
          {result.agreement.rows.length > 0 ? (
            <table className="text-[11px]">
              <thead><tr className="text-left text-[var(--muted)]"><th className="pr-3 font-normal">your label</th><th className="pr-3 font-normal">labeled</th><th className="pr-3 font-normal">draft agrees</th><th className="pr-3 font-normal">disagrees</th><th className="font-normal">not proposed</th></tr></thead>
              <tbody>
                {result.agreement.rows.map((r) => (
                  <tr key={r.classId} className="border-t border-[var(--border)]"><td className="pr-3">{r.name}</td><td className="pr-3">{r.labeled}</td><td className="pr-3 text-emerald-300">{r.agree}</td><td className="pr-3 text-red-300">{r.disagree}</td><td>{r.notProposed}</td></tr>
                ))}
                <tr className="border-t border-[var(--border)] font-medium"><td className="pr-3">all</td><td className="pr-3">{result.agreement.totals.labeled}</td><td className="pr-3 text-emerald-300">{result.agreement.totals.agree}{result.agreement.totals.labeled ? ` (${pct(result.agreement.totals.agree / result.agreement.totals.labeled)})` : ""}</td><td className="pr-3 text-red-300">{result.agreement.totals.disagree}</td><td>{result.agreement.totals.notProposed}</td></tr>
              </tbody>
            </table>
          ) : <p className="text-[10px] text-[var(--muted)] italic">No verdicts on these pages for this recipe yet — accept / reject / rename proposals in the viewer to measure agreement.</p>}
          {result.pages.map((pg) => (
            <div key={pg.pageNumber}>
              <p className="text-[11px] font-medium">Page {pg.pageNumber} <span className="text-[var(--muted)] font-normal">— {pg.proposals.length} proposal{pg.proposals.length === 1 ? "" : "s"} (stored: {pg.storedCount}) · {pg.ms} ms</span></p>
              {pg.errors.map((e, i) => <p key={i} className="text-[10px] text-red-400">recipe error: {e.message}</p>)}
              {pg.proposals.length ? <ul className="space-y-1">{pg.proposals.map((p) => <ProposalRow key={p.id} p={p} />)}</ul> : <p className="text-[10px] text-[var(--muted)] italic">nothing proposed</p>}
            </div>
          ))}
        </div>
      )}
      {runLog.length > 0 && <pre className="text-[10px] bg-[var(--bg)] border border-[var(--border)] rounded p-2 max-h-48 overflow-auto whitespace-pre-wrap">{runLog.join("\n")}</pre>}
    </div>
  );
}
