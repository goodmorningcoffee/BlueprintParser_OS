"use client";

// [classifier builder track 3] One signal row: label, type, weight (number + slider), role, enabled,
// note, the per-type parameter editor (collapsed by default), reset-to-built-in / duplicate / remove.

import { useState } from "react";
import { signalTypeSchema, type SignalCatalog, type WeightedSignal } from "@/lib/classifier-engine";
import SignalParamEditor from "./SignalParamEditor";

const INPUT = "px-2 py-1 text-xs bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--fg)] outline-none";
const BTN = "px-1.5 py-0.5 text-[10px] rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:border-[var(--fg)]/40";

export interface SignalRowProps {
  signal: WeightedSignal;
  /** Built-in version of this signal (undefined = added in this company). */
  builtIn?: WeightedSignal;
  catalog: SignalCatalog;
  onChange: (patch: Partial<WeightedSignal>) => void;
  onReset: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export default function SignalRow({ signal, builtIn, catalog, onChange, onReset, onDuplicate, onRemove }: SignalRowProps) {
  const [open, setOpen] = useState(false);
  const modified = builtIn ? !same(builtIn, signal) : true;
  const schema = signalTypeSchema(signal.spec.type);
  const roleWeight = signal.role === "score";
  return (
    <div className={`rounded border ${modified ? "border-amber-400/40" : "border-[var(--border)]"} ${signal.enabled ? "" : "opacity-60"} bg-[var(--card,transparent)]`} data-signal-id={signal.id}>
      <div className="flex flex-wrap items-center gap-2 px-2 py-1.5">
        <input type="checkbox" checked={signal.enabled} aria-label={`enable ${signal.id}`} onChange={(e) => onChange({ enabled: e.target.checked })} />
        <input className={`${INPUT} w-44`} value={signal.label} aria-label={`label of ${signal.id}`} onChange={(e) => onChange({ label: e.target.value })} />
        <span className="text-[10px] font-mono text-[var(--muted)]" title="signal id (the feature key)">{signal.id}</span>
        <span className="text-[10px] px-1.5 rounded bg-[var(--accent)]/15 text-[var(--accent)]">{schema?.name ?? signal.spec.type}</span>
        <label className="flex items-center gap-1 text-[10px] text-[var(--muted)]">
          weight
          <input type="number" step={0.1} className={`${INPUT} w-16`} value={signal.weight} disabled={!roleWeight} aria-label={`weight of ${signal.id}`}
            onChange={(e) => onChange({ weight: Number(e.target.value) })} />
          <input type="range" min={-6} max={6} step={0.1} value={Math.max(-6, Math.min(6, signal.weight))} disabled={!roleWeight} aria-label={`weight slider of ${signal.id}`}
            className="w-24" onChange={(e) => onChange({ weight: Number(e.target.value) })} />
        </label>
        <select className={INPUT} value={signal.role} aria-label={`role of ${signal.id}`} onChange={(e) => onChange({ role: e.target.value as WeightedSignal["role"] })}>
          <option value="score">score</option>
          <option value="required">required</option>
          <option value="veto">veto</option>
        </select>
        <div className="ml-auto flex gap-1">
          <button type="button" className={BTN} onClick={() => setOpen((o) => !o)}>{open ? "▲ params" : "▼ params"}</button>
          {builtIn && modified && <button type="button" className={BTN} title="back to the built-in signal" onClick={onReset}>reset</button>}
          {!builtIn && <span className="text-[10px] px-1.5 self-center rounded bg-amber-500/15 text-amber-300">added</span>}
          <button type="button" className={BTN} onClick={onDuplicate}>duplicate</button>
          <button type="button" className={`${BTN} hover:text-red-400`} onClick={onRemove}>remove</button>
        </div>
      </div>
      {open && (
        <div className="px-3 pb-2 space-y-2 border-t border-[var(--border)]">
          <SignalParamEditor spec={signal.spec} catalog={catalog} onChange={(spec) => onChange({ spec })} />
          <div>
            <label className="text-[10px] text-[var(--muted)] block mb-0.5">Note</label>
            <input className={`${INPUT} w-full`} value={signal.note ?? ""} placeholder="why this signal exists" onChange={(e) => onChange({ note: e.target.value || undefined })} />
          </div>
        </div>
      )}
    </div>
  );
}
