"use client";

// [TP-3 WP-3.L] Workspace header (PLAN §3.1): scope [This sheet | All sheets] · filter [To review n | Parsed n |
// Rejected n | Stale n] · kind chips [Schedules Keynotes Legends | Notes Specs] · "+ Region" · "Classic tools ▸".
// "Stale" shows only when the read has a stale item (or it is the active filter): the items read has no stale
// field until WP-5.A, and a filter that always counts 0 is noise (WP-3.L verify HIGH-1).

import type { StructureKind } from "@/lib/parse-engine/types";
import {
  GROUP_KINDS,
  useTablesWorkspaceStore,
  type WorkspaceFilter,
  type WorkspaceScope,
} from "@/stores/tablesWorkspaceStore";
import { closeWorkspace, openClassicTools, startDraw } from "@/stores/workspaceCommands";

export const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#00E676]";

export function wsButton(on: boolean): string {
  return `px-1.5 py-0.5 rounded border text-[10px] ${FOCUS_RING} ${
    on ? "border-[#00E676]/60 text-[#00E676] bg-[#00E676]/10" : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
  }`;
}

export const KIND_LABELS: Readonly<Record<StructureKind, string>> = {
  schedule: "Schedules",
  keynote: "Keynotes",
  legend: "Legends",
  notes: "Notes",
  spec: "Specs",
};

const SCOPES: ReadonlyArray<[WorkspaceScope, string]> = [["sheet", "This sheet"], ["all", "All sheets"]];
const FILTERS: ReadonlyArray<[WorkspaceFilter, string]> = [
  ["todo", "To review"],
  ["parsed", "Parsed"],
  ["rejected", "Rejected"],
  ["stale", "Stale"],
];

export default function WorkspaceHeader({ counts }: { counts: Record<WorkspaceFilter, number> | null }) {
  const group = useTablesWorkspaceStore((s) => s.group);
  const scope = useTablesWorkspaceStore((s) => s.scope);
  const filter = useTablesWorkspaceStore((s) => s.filter);
  const kinds = useTablesWorkspaceStore((s) => s.kinds);
  const drawing = useTablesWorkspaceStore((s) => s.correction === "draw-region");
  const setScope = useTablesWorkspaceStore((s) => s.setScope);
  const setFilter = useTablesWorkspaceStore((s) => s.setFilter);
  const toggleKind = useTablesWorkspaceStore((s) => s.toggleKind);

  return (
    <header className="flex flex-col gap-1 px-2 py-2 border-b border-[var(--border)]">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--fg)]">{group === "tables" ? "Tables" : "Notes"} workspace</h3>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => openClassicTools()} className={wsButton(false)} title="Open the classic panel">
            Classic tools ▸
          </button>
          <button
            type="button"
            onClick={closeWorkspace}
            aria-label="Close workspace"
            className="text-[var(--muted)] hover:text-[var(--fg)] text-lg leading-none px-1"
          >
            &times;
          </button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Scope">
        {SCOPES.map(([value, label]) => (
          <button key={value} type="button" aria-pressed={scope === value} onClick={() => setScope(value)} className={wsButton(scope === value)}>
            {label}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={drawing}
          onClick={startDraw}
          className={`${wsButton(drawing)} ml-auto`}
          title="Draw a box around a table or notes block the detector missed"
        >
          + Region
        </button>
      </div>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Filter">
        {FILTERS.filter(([value]) => value !== "stale" || filter === "stale" || (counts?.stale ?? 0) > 0).map(([value, label]) => (
          <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)} className={wsButton(filter === value)}>
            {label}
            {counts ? ` ${counts[value]}` : ""}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Kinds">
        {[...GROUP_KINDS.tables, ...GROUP_KINDS.notes].map((kind) => (
          <button key={kind} type="button" aria-pressed={kinds.includes(kind)} onClick={() => toggleKind(kind)} className={wsButton(kinds.includes(kind))}>
            {KIND_LABELS[kind]}
          </button>
        ))}
      </div>
    </header>
  );
}
