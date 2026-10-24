"use client";

// [classifier builder track 3] Recipe scope (disciplines, page kinds, title-block exclusion, word
// bounds) and candidate sources (regions-v2 kinds, yolo classes, Textract tables, parsed regions).

import { CANDIDATE_SOURCE_TYPES, DISCIPLINES, type CandidateSource, type ClassifierScope, type SignalCatalog } from "@/lib/classifier-engine";

const INPUT = "px-2 py-1 text-xs bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--fg)] outline-none";
const LABEL = "text-[10px] text-[var(--muted)] block mb-0.5";
const chip = (active: boolean) => `px-1.5 py-0.5 text-[10px] rounded border ${active ? "border-emerald-400/50 text-emerald-300 bg-emerald-500/15" : "border-[var(--border)] text-[var(--muted)]"}`;
const REGION_KINDS = ["table", "legend", "notes", "keynotes"] as const;

function Toggle({ options, value, onChange }: { options: readonly string[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((o) => <button key={o} type="button" className={chip(value.includes(o))} onClick={() => onChange(value.includes(o) ? value.filter((x) => x !== o) : [...value, o])}>{o}</button>)}
    </div>
  );
}

export interface ScopeEditorProps {
  scope: ClassifierScope;
  candidates: CandidateSource[];
  catalog: SignalCatalog;
  onScope: (s: ClassifierScope) => void;
  onCandidates: (c: CandidateSource[]) => void;
}

export default function ScopeEditor({ scope, candidates, catalog, onScope, onCandidates }: ScopeEditorProps) {
  const set = (k: keyof ClassifierScope, v: unknown) => {
    const next = { ...scope } as Record<string, unknown>;
    if (v === undefined || (Array.isArray(v) && v.length === 0)) delete next[k]; else next[k] = v;
    onScope(next as ClassifierScope);
  };
  const allClasses = [...new Set(catalog.models.flatMap((m) => m.classes))];
  const setCand = (i: number, c: CandidateSource) => onCandidates(candidates.map((x, j) => (j === i ? c : x)));
  return (
    <div className="grid md:grid-cols-2 gap-3">
      <div className="space-y-2">
        <p className="text-xs font-medium">Scope — where the recipe may run</p>
        <div><label className={LABEL}>Only these disciplines (sheet prefix)</label><Toggle options={DISCIPLINES.map((d) => d.id)} value={scope.disciplines ?? []} onChange={(v) => set("disciplines", v)} /></div>
        <div><label className={LABEL}>Never these disciplines</label><Toggle options={DISCIPLINES.map((d) => d.id)} value={scope.excludeDisciplines ?? []} onChange={(v) => set("excludeDisciplines", v)} /></div>
        <div><label className={LABEL}>Page kinds (PDF channel census)</label><Toggle options={catalog.pageKinds} value={scope.pageKinds ?? []} onChange={(v) => set("pageKinds", v)} /></div>
        <div className="flex flex-wrap gap-3">
          <label className="text-[10px] text-[var(--muted)] flex items-center gap-1"><input type="checkbox" checked={scope.excludeTitleBlock !== false} onChange={(e) => set("excludeTitleBlock", e.target.checked ? true : false)} /> drop candidates inside the title block</label>
          <label className="text-[10px] text-[var(--muted)]">min words <input type="number" className={`${INPUT} w-16`} value={scope.minWords ?? ""} onChange={(e) => set("minWords", e.target.value === "" ? undefined : Number(e.target.value))} /></label>
          <label className="text-[10px] text-[var(--muted)]">max words <input type="number" className={`${INPUT} w-16`} value={scope.maxWords ?? ""} onChange={(e) => set("maxWords", e.target.value === "" ? undefined : Number(e.target.value))} /></label>
          <label className="text-[10px] text-[var(--muted)]">sheet number regex <input className={`${INPUT} w-28 font-mono`} value={scope.sheetNumberPattern ?? ""} onChange={(e) => set("sheetNumberPattern", e.target.value || undefined)} /></label>
        </div>
      </div>
      <div className="space-y-2">
        <p className="text-xs font-medium">Candidates — the boxes the recipe scores (first source wins a duplicate)</p>
        {candidates.map((c, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2 rounded border border-[var(--border)] px-2 py-1">
            <select className={INPUT} value={c.type} aria-label={`candidate ${i + 1} type`} onChange={(e) => {
              const t = e.target.value as CandidateSource["type"];
              setCand(i, t === "regions-v2" ? { type: t, kinds: ["table"] } : t === "yolo" ? { type: t, classes: [] } : t === "textract-tables" ? { type: t, minRows: 3 } : { type: t });
            }}>
              {CANDIDATE_SOURCE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            {c.type === "regions-v2" && <Toggle options={REGION_KINDS} value={c.kinds} onChange={(v) => setCand(i, { ...c, kinds: v as typeof c.kinds })} />}
            {c.type === "yolo" && (allClasses.length ? <Toggle options={allClasses} value={c.classes} onChange={(v) => setCand(i, { ...c, classes: v })} /> : <span className="text-[10px] text-amber-400">no model class lists available</span>)}
            {c.type === "textract-tables" && <label className="text-[10px] text-[var(--muted)]">min rows <input type="number" className={`${INPUT} w-14`} value={c.minRows ?? 2} onChange={(e) => setCand(i, { ...c, minRows: Number(e.target.value) })} /></label>}
            <button type="button" className="ml-auto text-[10px] text-[var(--muted)] hover:text-red-400" disabled={candidates.length === 1} onClick={() => onCandidates(candidates.filter((_, j) => j !== i))}>remove</button>
          </div>
        ))}
        <button type="button" className="px-2 py-1 text-[10px] rounded border border-[var(--border)] hover:border-emerald-400/50" onClick={() => onCandidates([...candidates, { type: "textract-tables", minRows: 3 }])}>+ Add source</button>
      </div>
    </div>
  );
}
