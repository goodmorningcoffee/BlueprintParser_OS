"use client";

// [classifier builder track 3] One naming class: name / group / legacy category / bias / threshold, its
// signals, and reset-to-built-in / remove for the class. Collapsed by default (45 classes in schedules.v1).
// Name / group / legacy category edits of a BUILT-IN class save as RecipePatch.classMeta (fix round).

import { useState } from "react";
import { type ClassifierClass, type SignalCatalog, type WeightedSignal } from "@/lib/classifier-engine";
import HeadSignals from "./HeadSignals";

const INPUT = "px-2 py-1 text-xs bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--fg)] outline-none";
const BTN = "px-1.5 py-0.5 text-[10px] rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:border-[var(--fg)]/40";
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export interface ClassSectionProps {
  cls: ClassifierClass;
  builtIn?: ClassifierClass;
  catalog: SignalCatalog;
  defaultThreshold: number;
  onChangeClass: (patch: Partial<Omit<ClassifierClass, "signals">>) => void;
  onResetClass: () => void;
  onRemoveClass: () => void;
  onChangeSignal: (signalId: string, patch: Partial<WeightedSignal>) => void;
  onResetSignal: (signalId: string) => void;
  onDuplicateSignal: (signalId: string) => void;
  onRemoveSignal: (signalId: string) => void;
  onAddSignal: (signal: Omit<WeightedSignal, "id">, baseId: string) => void;
}

export default function ClassSection(p: ClassSectionProps) {
  const [open, setOpen] = useState(false);
  const { cls, builtIn } = p;
  const modified = builtIn ? !same(builtIn, cls) : true;
  const enabledSignals = cls.signals.filter((s) => s.enabled).length;
  return (
    <div className={`rounded border ${modified ? "border-amber-400/40" : "border-[var(--border)]"}`} data-class-id={cls.id}>
      <div className="flex flex-wrap items-center gap-2 px-2 py-1.5">
        <button type="button" className="text-xs text-left font-medium" onClick={() => setOpen((o) => !o)}>
          {open ? "▼" : "▶"} {cls.name}
        </button>
        <span className="text-[10px] font-mono text-[var(--muted)]">{cls.id}</span>
        <span className="text-[10px] text-[var(--muted)]">{enabledSignals}/{cls.signals.length} signals</span>
        {!builtIn && <span className="text-[10px] px-1.5 rounded bg-amber-500/15 text-amber-300">custom class</span>}
        {builtIn && modified && <span className="text-[10px] px-1.5 rounded bg-amber-500/15 text-amber-300">modified</span>}
        <label className="ml-auto flex items-center gap-1 text-[10px] text-[var(--muted)]">
          bias <input type="number" step={0.1} className={`${INPUT} w-16`} value={cls.bias} aria-label={`bias of ${cls.id}`} onChange={(e) => p.onChangeClass({ bias: Number(e.target.value) })} />
        </label>
        <label className="flex items-center gap-1 text-[10px] text-[var(--muted)]">
          threshold <input type="number" step={0.05} min={0} max={1} className={`${INPUT} w-16`} value={cls.threshold ?? ""} placeholder={String(p.defaultThreshold)} aria-label={`threshold of ${cls.id}`}
            onChange={(e) => p.onChangeClass({ threshold: e.target.value === "" ? undefined : Number(e.target.value) })} />
        </label>
        {builtIn && modified && <button type="button" className={BTN} onClick={p.onResetClass}>reset class</button>}
        <button type="button" className={`${BTN} hover:text-red-400`} onClick={p.onRemoveClass}>remove class</button>
      </div>
      {open && (
        <div className="px-2 pb-2 space-y-2 border-t border-[var(--border)]">
          <div className="flex flex-wrap gap-2 pt-2">
            <label className="text-[10px] text-[var(--muted)]">name <input className={`${INPUT} w-48`} value={cls.name} aria-label={`name of ${cls.id}`} onChange={(e) => p.onChangeClass({ name: e.target.value })} /></label>
            <label className="text-[10px] text-[var(--muted)]">group <input className={`${INPUT} w-24`} value={cls.group} aria-label={`group of ${cls.id}`} onChange={(e) => p.onChangeClass({ group: e.target.value })} /></label>
            <label className="text-[10px] text-[var(--muted)]">legacy category <input className={`${INPUT} w-32`} value={cls.legacyCategory ?? ""} aria-label={`legacy category of ${cls.id}`} onChange={(e) => p.onChangeClass({ legacyCategory: e.target.value || undefined })} /></label>
          </div>
          <HeadSignals signals={cls.signals} builtIn={builtIn?.signals} catalog={p.catalog}
            onChange={p.onChangeSignal} onReset={p.onResetSignal} onDuplicate={p.onDuplicateSignal} onRemove={p.onRemoveSignal} onAdd={p.onAddSignal} />
        </div>
      )}
    </div>
  );
}
