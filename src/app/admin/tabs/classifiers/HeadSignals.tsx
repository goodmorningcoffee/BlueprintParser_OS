"use client";

// [classifier builder track 3] The signal list of one head (detect, or one class) with "add signal"
// (type picked from the catalog) — shared by the detect section and every ClassSection.

import { useState } from "react";
import { SIGNAL_TYPES, type SignalCatalog, type SignalSpec, type WeightedSignal } from "@/lib/classifier-engine";
import SignalRow from "./SignalRow";

const INPUT = "px-2 py-1 text-xs bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--fg)] outline-none";

export interface HeadSignalsProps {
  signals: WeightedSignal[];
  builtIn?: readonly WeightedSignal[];
  catalog: SignalCatalog;
  onChange: (signalId: string, patch: Partial<WeightedSignal>) => void;
  onReset: (signalId: string) => void;
  onDuplicate: (signalId: string) => void;
  onRemove: (signalId: string) => void;
  onAdd: (signal: Omit<WeightedSignal, "id">, baseId: string) => void;
}

export default function HeadSignals({ signals, builtIn, catalog, onChange, onReset, onDuplicate, onRemove, onAdd }: HeadSignalsProps) {
  const [type, setType] = useState<SignalSpec["type"]>("words");
  const add = () => {
    const schema = SIGNAL_TYPES.find((t) => t.type === type);
    if (!schema) return;
    onAdd({ label: `new ${schema.name.toLowerCase()} signal`, spec: JSON.parse(JSON.stringify(schema.blank)) as SignalSpec, weight: 1, role: "score", enabled: true }, type);
  };
  return (
    <div className="space-y-1">
      {signals.length === 0 && <p className="text-[10px] text-[var(--muted)] italic px-1">No signals — this head scores its bias alone.</p>}
      {signals.map((s) => (
        <SignalRow key={s.id} signal={s} builtIn={builtIn?.find((b) => b.id === s.id)} catalog={catalog}
          onChange={(patch) => onChange(s.id, patch)} onReset={() => onReset(s.id)} onDuplicate={() => onDuplicate(s.id)} onRemove={() => onRemove(s.id)} />
      ))}
      <div className="flex items-center gap-1 pt-1">
        <select className={INPUT} value={type} aria-label="new signal type" onChange={(e) => setType(e.target.value as SignalSpec["type"])}>
          {SIGNAL_TYPES.map((t) => <option key={t.type} value={t.type}>{t.name}</option>)}
        </select>
        <button type="button" className="px-2 py-1 text-[10px] rounded border border-[var(--border)] hover:border-emerald-400/50" onClick={add}>+ Add signal</button>
      </div>
    </div>
  );
}
