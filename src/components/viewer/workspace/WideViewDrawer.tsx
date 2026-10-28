"use client";

// [TP-3 WP-3.N] "Wide view ▸" (PLAN §3.1, C3-m5): the 420 px panel is too narrow for a 20-column schedule, so the
// same StructurePreviewGrid opens full-width in a bottom drawer (the TableCompareModal pattern: a fixed overlay,
// here docked to the bottom so the drawing stays visible above it). It edits the SAME draft — every edit is the
// same correction op the panel grid emits — so closing the drawer loses nothing. Rendered in place inside the
// panel (no portal), so the panel's focus-scoped key handling still applies (§1.6 rule 14); Esc closes it and
// still propagates (ProposalFocusLayer owns Esc). An Esc that cancels a cell/label edit or closes an open column ▾
// does only that: the drawer stays open.

import { useEffect, useRef, type KeyboardEvent } from "react";
import type { CorrectionOp, StructureTableModel } from "@/lib/parse-engine/types";
import { isEditableKeyboardTarget, isolateDispatcherKeys } from "./keyboard";
import StructurePreviewGrid from "./StructurePreviewGrid";
import { wsButton } from "./WorkspaceHeader";

/** True when the key came from an open column ▾ (its button, or an item in its menu). */
function inOpenMenu(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[role="menu"], [aria-haspopup="menu"][aria-expanded="true"]') !== null;
}

export default function WideViewDrawer({
  title,
  model,
  emit,
  editCells,
  onToggleEdit,
  onClose,
}: {
  title: string;
  model: StructureTableModel;
  emit?: (op: CorrectionOp) => void;
  editCells: boolean;
  onToggleEdit?: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      if (!isEditableKeyboardTarget(e.target) && !inOpenMenu(e.target)) onClose(); // not stopped: ProposalFocusLayer owns Esc
      return;
    }
    isolateDispatcherKeys(e);
  };
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Wide view"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="fixed left-0 right-0 bottom-0 z-40 flex flex-col h-[45vh] border-t border-[var(--border)] bg-[var(--bg)] shadow-2xl outline-none"
    >
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--border)] bg-[var(--surface)]">
        <h2 className="text-xs font-semibold text-[var(--fg)] truncate">{title}</h2>
        <span className="text-[10px] text-[var(--muted)]">
          {model.rows.length} rows × {model.cols.length} columns
        </span>
        {onToggleEdit ? (
          <button type="button" aria-pressed={editCells} onClick={onToggleEdit} className={`ml-auto ${wsButton(editCells)}`}>
            Edit cells
          </button>
        ) : null}
        <button type="button" onClick={onClose} className={`${onToggleEdit ? "" : "ml-auto "}${wsButton(false)}`}>
          Close wide view
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-2">
        <StructurePreviewGrid model={model} emit={emit} editCells={editCells} wide label="Wide structure preview" />
      </div>
    </div>
  );
}
