"use client";

// [classifier builder track 3] The recipe editor: header fields (name, enabled, target, thresholds,
// margin, detect bias), scope + candidates, the detect head, the table-ness head (when the recipe has one), the classes grouped by vocabulary group,
// add class, reset recipe, and the diff view against the built-in. Every edit goes through draft-ops
// (pure) and up through `onChange(nextDraft)`.

import { useState } from "react";
import {
  DETECT, TABLE, blankClass, describePatch, buildRecipePatch, resetClass, resetRecipe, resetSignal,
  type ClassifierRecipe, type SignalCatalog, type WeightedSignal, type ClassifierClass,
} from "@/lib/classifier-engine";
import { SCHEDULE_GROUP_NAMES } from "@/lib/classifier-engine/vocabulary";
import ClassSection from "./ClassSection";
import DiffView from "./DiffView";
import HeadSignals from "./HeadSignals";
import ScopeEditor from "./ScopeEditor";
import { addClass, addSignal, duplicateSignal, groupClasses, removeClass, removeSignal, updateClass, updateRecipe, updateSignal } from "./draft-ops";

const INPUT = "px-2 py-1 text-xs bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--fg)] outline-none";
const BTN = "px-2 py-1 text-[10px] rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:border-[var(--fg)]/40";

export interface RecipeEditorProps {
  draft: ClassifierRecipe;
  builtIn?: ClassifierRecipe;
  catalog: SignalCatalog;
  onChange: (next: ClassifierRecipe) => void;
}

export default function RecipeEditor({ draft, builtIn, catalog, onChange }: RecipeEditorProps) {
  const [section, setSection] = useState<"detect" | "table" | "classes" | "scope" | "diff">("classes");
  const [newClass, setNewClass] = useState({ id: "", name: "", group: "other" });
  const patch = builtIn ? buildRecipePatch(builtIn, draft) : null;
  const diff = builtIn ? describePatch(builtIn, patch) : [];
  const groupName = (g: string) => (SCHEDULE_GROUP_NAMES as Record<string, string>)[g] ?? g;

  const headProps = (head: string, cls?: ClassifierClass) => ({
    onChangeSignal: (sid: string, p: Partial<WeightedSignal>) => onChange(updateSignal(draft, head, sid, p)),
    onResetSignal: (sid: string) => builtIn && onChange(resetSignal(draft, builtIn, head, sid)),
    onDuplicateSignal: (sid: string) => onChange(duplicateSignal(draft, head, sid)),
    onRemoveSignal: (sid: string) => onChange(removeSignal(draft, head, sid)),
    onAddSignal: (s: Omit<WeightedSignal, "id">, base: string) => onChange(addSignal(draft, head, s, base)),
    onChangeClass: (p: Partial<Omit<ClassifierClass, "signals">>) => cls && onChange(updateClass(draft, cls.id, p)),
    onResetClass: () => cls && builtIn && onChange(resetClass(draft, builtIn, cls.id)),
    onRemoveClass: () => cls && onChange(removeClass(draft, cls.id)),
  });

  const tab = (id: typeof section, label: string) => (
    <button type="button" className={`px-3 py-1 text-xs border-b-2 ${section === id ? "border-[var(--accent)] text-[var(--accent)]" : "border-transparent text-[var(--muted)]"}`} onClick={() => setSection(id)}>{label}</button>
  );

  return (
    <div className="space-y-3" data-recipe-id={draft.id}>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-[10px] text-[var(--muted)]">name<br /><input className={`${INPUT} w-56`} value={draft.name} aria-label="recipe name" onChange={(e) => onChange(updateRecipe(draft, { name: e.target.value }))} /></label>
        <label className="text-[10px] text-[var(--muted)] flex items-center gap-1 pb-1"><input type="checkbox" checked={draft.enabled} aria-label="recipe enabled" onChange={(e) => onChange(updateRecipe(draft, { enabled: e.target.checked }))} /> enabled</label>
        <span className="text-[10px] text-[var(--muted)] pb-1">v{draft.version} · {draft.source} · unit {draft.unit} · target <input className={`${INPUT} w-24`} value={draft.target} disabled={!!builtIn} onChange={(e) => onChange(updateRecipe(draft, { target: e.target.value }))} /></span>
        {builtIn && patch && <button type="button" className={BTN} onClick={() => onChange(resetRecipe(builtIn))}>Reset recipe to built-in</button>}
      </div>
      <div className="flex flex-wrap gap-3">
        <label className="text-[10px] text-[var(--muted)]">detect bias <input type="number" step={0.1} className={`${INPUT} w-16`} value={draft.detect.bias} onChange={(e) => onChange(updateRecipe(draft, { detect: { bias: Number(e.target.value) } }))} /></label>
        <label className="text-[10px] text-[var(--muted)]">detect threshold <input type="number" step={0.05} min={0} max={1} className={`${INPUT} w-16`} value={draft.detect.threshold} aria-label="detect threshold" onChange={(e) => onChange(updateRecipe(draft, { detect: { threshold: Number(e.target.value) } }))} /></label>
        <label className="text-[10px] text-[var(--muted)]">name threshold <input type="number" step={0.05} min={0} max={1} className={`${INPUT} w-16`} value={draft.nameThreshold} onChange={(e) => onChange(updateRecipe(draft, { nameThreshold: Number(e.target.value) }))} /></label>
        <label className="text-[10px] text-[var(--muted)]">min margin <input type="number" step={0.05} min={0} max={1} className={`${INPUT} w-16`} value={draft.minMargin} onChange={(e) => onChange(updateRecipe(draft, { minMargin: Number(e.target.value) }))} /></label>
        <label className="text-[10px] text-[var(--muted)]">fallback name <input className={`${INPUT} w-32`} value={draft.fallbackClassName} disabled={!!builtIn} onChange={(e) => onChange(updateRecipe(draft, { fallbackClassName: e.target.value }))} /></label>
        <label className="text-[10px] text-[var(--muted)] flex items-center gap-1"><input type="checkbox" checked={draft.deriveName} disabled={!!builtIn} onChange={(e) => onChange(updateRecipe(draft, { deriveName: e.target.checked }))} /> derive the printed title</label>
      </div>
      <div className="flex border-b border-[var(--border)]">
        {tab("classes", `Classes (${draft.classes.length})`)}{tab("detect", `Detect head (${draft.detect.signals.length})`)}{draft.tableHead && tab("table", `Table-ness head (${draft.tableHead.signals.length})`)}{tab("scope", "Scope & candidates")}{tab("diff", `Diff vs built-in (${diff.length})`)}
      </div>

      {section === "detect" && (
        <div className="space-y-1">
          <p className="text-[10px] text-[var(--muted)]">p(candidate is the target) = σ(bias + Σ weight × value); a required signal at 0 or a veto above 0 drops the candidate.</p>
          <HeadSignals signals={draft.detect.signals} builtIn={builtIn?.detect.signals} catalog={catalog}
            onChange={headProps(DETECT).onChangeSignal} onReset={headProps(DETECT).onResetSignal} onDuplicate={headProps(DETECT).onDuplicateSignal} onRemove={headProps(DETECT).onRemoveSignal} onAdd={headProps(DETECT).onAddSignal} />
        </div>
      )}

      {section === "table" && draft.tableHead && (
        <div className="space-y-1">
          <p className="text-[10px] text-[var(--muted)]">p(candidate is a table: schedule, legend or keynote) = σ(bias + Σ weight × value). Shown on each proposal as "table NN %"; it does not pick the kind.</p>
          <label className="text-[10px] text-[var(--muted)]">table-ness bias <input type="number" step={0.1} className={`${INPUT} w-16`} value={draft.tableHead.bias} aria-label="table-ness bias" onChange={(e) => draft.tableHead && onChange(updateRecipe(draft, { tableHead: { ...draft.tableHead, bias: Number(e.target.value) } }))} /></label>
          <HeadSignals signals={draft.tableHead.signals} builtIn={builtIn?.tableHead?.signals} catalog={catalog}
            onChange={headProps(TABLE).onChangeSignal} onReset={headProps(TABLE).onResetSignal} onDuplicate={headProps(TABLE).onDuplicateSignal} onRemove={headProps(TABLE).onRemoveSignal} onAdd={headProps(TABLE).onAddSignal} />
        </div>
      )}

      {section === "classes" && (
        <div className="space-y-3">
          {draft.classes.length === 0 && <p className="text-[10px] text-[var(--muted)] italic">No classes: every candidate that passes detect is shown with its derived title.</p>}
          {groupClasses(draft.classes).map(([group, classes]) => (
            <div key={group} className="space-y-1">
              <p className="text-[11px] font-medium text-[var(--muted)]">{groupName(group)}</p>
              {classes.map((cls) => (
                <ClassSection key={cls.id} cls={cls} builtIn={builtIn?.classes.find((c) => c.id === cls.id)} catalog={catalog} defaultThreshold={draft.nameThreshold} {...headProps(cls.id, cls)} />
              ))}
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-1 pt-1">
            <input className={`${INPUT} w-32`} placeholder="class id (kebab)" value={newClass.id} onChange={(e) => setNewClass({ ...newClass, id: e.target.value })} />
            <input className={`${INPUT} w-40`} placeholder="class name" value={newClass.name} onChange={(e) => setNewClass({ ...newClass, name: e.target.value })} />
            <select className={INPUT} value={newClass.group} onChange={(e) => setNewClass({ ...newClass, group: e.target.value })}>
              {Object.entries(SCHEDULE_GROUP_NAMES).map(([g, n]) => <option key={g} value={g}>{n}</option>)}<option value="text">text</option>
            </select>
            <button type="button" className={BTN} disabled={!/^[a-z0-9][a-z0-9-]{0,79}$/.test(newClass.id) || !newClass.name.trim() || draft.classes.some((c) => c.id === newClass.id)}
              onClick={() => { onChange(addClass(draft, blankClass(newClass.id, newClass.name.trim(), newClass.group))); setNewClass({ id: "", name: "", group: newClass.group }); }}>+ Add class</button>
          </div>
        </div>
      )}

      {section === "scope" && (
        <ScopeEditor scope={draft.scope} candidates={draft.candidates} catalog={catalog}
          onScope={(scope) => onChange(updateRecipe(draft, { scope }))} onCandidates={(candidates) => onChange(updateRecipe(draft, { candidates }))} />
      )}

      {section === "diff" && (builtIn ? <DiffView lines={diff} /> : <p className="text-[10px] text-[var(--muted)] italic">A custom recipe has no built-in to diff against.</p>)}
    </div>
  );
}
