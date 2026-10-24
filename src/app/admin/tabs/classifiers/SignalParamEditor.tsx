"use client";

// [classifier builder track 3] One signal's parameters, by spec type (lib/classifier-engine/catalog.ts
// schemas): term list with per-term weights (words), division / section chips (csi), model + class
// pickers from the catalog (yolo), discipline chips (sheet), feature pick (structure), enums, numbers.

import { useState } from "react";
import { DISCIPLINES, SIGNAL_SCOPES, STRUCTURE_FEATURES, signalTypeSchema, type ParamSchema, type SignalCatalog, type SignalSpec } from "@/lib/classifier-engine";

const INPUT = "px-2 py-1 text-xs bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--fg)] outline-none";
const LABEL = "text-[10px] text-[var(--muted)] block mb-0.5";
const chip = (active: boolean) => `px-1.5 py-0.5 text-[10px] rounded border transition-colors ${active ? "border-emerald-400/50 text-emerald-300 bg-emerald-500/15" : "border-[var(--border)] text-[var(--muted)] hover:border-emerald-400/30"}`;

type Spec = Record<string, unknown>;

function Chips({ options, value, onChange, labels }: { options: readonly string[]; value: string[]; onChange: (v: string[]) => void; labels?: Record<string, string> }) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((o) => {
        const on = value.includes(o);
        return (
          <button key={o} type="button" title={labels?.[o]} className={chip(on)} onClick={() => onChange(on ? value.filter((v) => v !== o) : [...value, o])}>
            {o}
          </button>
        );
      })}
    </div>
  );
}

/** Free-text list ("08", "26") with chips to remove; `normalize` cleans each entry. */
function ListEditor({ value, onChange, placeholder, normalize }: { value: string[]; onChange: (v: string[]) => void; placeholder: string; normalize?: (s: string) => string }) {
  const [text, setText] = useState("");
  const add = () => {
    const items = text.split(/[,\s]+/).map((s) => (normalize ? normalize(s) : s.trim())).filter(Boolean);
    if (items.length) onChange([...new Set([...value, ...items])]);
    setText("");
  };
  return (
    <div className="flex flex-wrap items-center gap-1">
      {value.map((v) => (
        <button key={v} type="button" className={chip(true)} title="remove" onClick={() => onChange(value.filter((x) => x !== v))}>{v} ×</button>
      ))}
      <input className={`${INPUT} w-28`} placeholder={placeholder} value={text} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} onBlur={add} />
    </div>
  );
}

/** Terms → weight table for a `words` signal. Terms are stored upper-case. */
export function TermsEditor({ terms, onChange }: { terms: Record<string, number>; onChange: (t: Record<string, number>) => void }) {
  const [draft, setDraft] = useState("");
  const entries = Object.entries(terms);
  const add = () => {
    const t = draft.trim().toUpperCase();
    if (t && !(t in terms)) onChange({ ...terms, [t]: 1 });
    setDraft("");
  };
  return (
    <div className="space-y-1">
      {entries.length === 0 && <p className="text-[10px] text-amber-400">No terms yet — this signal always yields 0.</p>}
      <div className="grid grid-cols-[1fr_4rem_1.5rem] gap-1 max-h-48 overflow-y-auto pr-1">
        {entries.map(([term, w]) => (
          <div key={term} className="contents">
            <span className="text-[11px] font-mono truncate self-center" title={term}>{term}</span>
            <input type="number" step={0.1} className={`${INPUT} w-16`} value={w} aria-label={`weight of ${term}`}
              onChange={(e) => onChange({ ...terms, [term]: Number(e.target.value) })} />
            <button type="button" className="text-[var(--muted)] hover:text-red-400 text-xs" title={`remove ${term}`}
              onClick={() => { const next = { ...terms }; delete next[term]; onChange(next); }}>×</button>
          </div>
        ))}
      </div>
      <div className="flex gap-1">
        <input className={`${INPUT} flex-1`} placeholder="add a word or phrase, Enter" value={draft} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
        <button type="button" className="px-2 text-xs border border-[var(--border)] rounded hover:border-emerald-400/50" onClick={add}>Add term</button>
      </div>
    </div>
  );
}

function YoloPicker({ spec, set, catalog }: { spec: Spec; set: (k: string, v: unknown) => void; catalog: SignalCatalog }) {
  const model = typeof spec.model === "string" ? spec.model : "";
  const picked = catalog.models.find((m) => m.name === model);
  const classOptions = picked ? picked.classes : [...new Set(catalog.models.flatMap((m) => m.classes))];
  const classes = Array.isArray(spec.classes) ? (spec.classes as string[]) : [];
  return (
    <>
      <div>
        <label className={LABEL}>Model (blank = any)</label>
        <select className={INPUT} value={model} onChange={(e) => set("model", e.target.value || undefined)}>
          <option value="">any model</option>
          {catalog.models.map((m) => <option key={m.id} value={m.name}>{m.name} ({m.classes.length} classes{m.shared ? ", shared" : ""})</option>)}
        </select>
      </div>
      <div>
        <label className={LABEL}>Classes</label>
        {classOptions.length === 0
          ? <p className="text-[10px] text-amber-400">No model with a class list is available to this company.</p>
          : <Chips options={classOptions} value={classes} onChange={(v) => set("classes", v)} />}
        {classes.filter((c) => !classOptions.includes(c)).length > 0 && (
          <p className="text-[10px] text-amber-400 mt-1">Not in any model&apos;s class list: {classes.filter((c) => !classOptions.includes(c)).join(", ")}</p>
        )}
      </div>
    </>
  );
}

function Param({ p, spec, set, catalog }: { p: ParamSchema; spec: Spec; set: (k: string, v: unknown) => void; catalog: SignalCatalog }) {
  const v = spec[p.key];
  const list = Array.isArray(v) ? (v as string[]) : [];
  switch (p.kind) {
    case "scope":
      return <select className={INPUT} value={String(v ?? "box")} onChange={(e) => set(p.key, e.target.value)}>{SIGNAL_SCOPES.map((s) => <option key={s} value={s}>{s}</option>)}</select>;
    case "enum":
      return <select className={INPUT} value={String(v ?? p.options?.[0] ?? "")} onChange={(e) => set(p.key, e.target.value)}>{(p.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}</select>;
    case "number":
      return <input type="number" className={`${INPUT} w-24`} value={typeof v === "number" ? v : ""} min={p.min} max={p.max} step={p.step ?? 0.1}
        onChange={(e) => set(p.key, e.target.value === "" ? undefined : Number(e.target.value))} />;
    case "regex":
      return <input className={`${INPUT} w-48 font-mono`} value={typeof v === "string" ? v : ""} placeholder="^A-?6" onChange={(e) => set(p.key, e.target.value || undefined)} />;
    case "terms":
      return <TermsEditor terms={(v && typeof v === "object" ? v : {}) as Record<string, number>} onChange={(t) => set(p.key, t)} />;
    case "disciplineList":
      return <Chips options={DISCIPLINES.map((d) => d.id)} labels={Object.fromEntries(DISCIPLINES.map((d) => [d.id, d.name]))} value={list} onChange={(x) => set(p.key, x)} />;
    case "divisionList":
      return <ListEditor value={list} onChange={(x) => set(p.key, x)} placeholder="08, 26 …" normalize={(s) => s.replace(/\D/g, "").slice(0, 2).padStart(2, "0").replace(/^00$/, "")} />;
    case "sectionList":
      return <ListEditor value={list} onChange={(x) => set(p.key, x)} placeholder="08 71 …" normalize={(s) => s.replace(/[^0-9]/g, "").replace(/(\d{2})(?=\d)/g, "$1 ").trim()} />;
    case "shapeList":
      return <Chips options={catalog.shapes} value={list} onChange={(x) => set(p.key, x)} />;
    case "pageKindList":
      return <Chips options={catalog.pageKinds} value={list} onChange={(x) => set(p.key, x)} />;
    case "structureFeature":
      return <select className={INPUT} value={String(v ?? "structureScore")} onChange={(e) => set(p.key, e.target.value)}>{STRUCTURE_FEATURES.map((f) => <option key={f.id} value={f.id}>{f.id} — {f.name}</option>)}</select>;
    case "stringList":
      return <ListEditor value={list} onChange={(x) => set(p.key, x)} placeholder="value" />;
    default:
      return null;
  }
}

export default function SignalParamEditor({ spec, onChange, catalog }: { spec: SignalSpec; onChange: (s: SignalSpec) => void; catalog: SignalCatalog }) {
  const schema = signalTypeSchema(spec.type);
  if (!schema) return <p className="text-[10px] text-amber-400">Unknown signal type &quot;{(spec as { type: string }).type}&quot; — the engine yields 0 for it.</p>;
  const raw = spec as unknown as Spec;
  const set = (k: string, v: unknown) => {
    const next: Spec = { ...raw };
    if (v === undefined) delete next[k]; else next[k] = v;
    onChange(next as unknown as SignalSpec);
  };
  return (
    <div className="space-y-2">
      <p className="text-[10px] text-[var(--muted)] italic">value: {schema.valueHelp}</p>
      {spec.type === "yolo" && <YoloPicker spec={raw} set={set} catalog={catalog} />}
      {schema.params.filter((p) => p.kind !== "yoloModel" && p.kind !== "yoloClasses").map((p) => (
        <div key={p.key}>
          <label className={LABEL}>{p.label}{p.required ? " *" : ""}{p.help ? <span className="opacity-70"> — {p.help}</span> : null}</label>
          <Param p={p} spec={raw} set={set} catalog={catalog} />
        </div>
      ))}
    </div>
  );
}
