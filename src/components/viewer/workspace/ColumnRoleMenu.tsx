"use client";

// [TP-3 WP-3.N] The column header ▾ (PLAN §3.1 StructurePreviewGrid; C3-m3): what a column holds. A role is a
// `set-col-role` op (QTY drives expectedQty / Auto-QTO in TP-4; "No role" clears it); "Key column" is a separate
// `set-tag-col` op, because the tag column (`model.tag`) is what maps tags on Accept, and a column can be the key
// column without carrying the `tag` role. Picking the current key column again clears it (`set-tag-col null`).
// The menu is a plain popover inside the panel (no portal, no `window` listener; §1.6 rule 14): it closes on a
// pick, on blur out of the menu and on Esc — Esc still propagates, because ProposalFocusLayer owns it.

import { useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { COL_ROLES, type ColRole, type CorrectionOp, type StructureCol } from "@/lib/parse-engine/types";
import { FOCUS_RING } from "./WorkspaceHeader";

export const COL_ROLE_LABELS: Readonly<Record<ColRole, string>> = {
  tag: "Tag",
  qty: "QTY",
  description: "Description",
  type: "Type",
  size: "Size",
  material: "Material",
  remarks: "Remarks",
  sheet: "Sheet",
  other: "Other",
};

/** The text a column shows in the grid header: its label, else its position. */
export function colTitle(col: StructureCol, index: number): string {
  return col.label.trim() || `Column ${index + 1}`;
}

export default function ColumnRoleMenu({
  col,
  index,
  isTag,
  disabled,
  emit,
}: {
  col: StructureCol;
  index: number;
  isTag: boolean;
  disabled?: boolean;
  emit: (op: CorrectionOp) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const title = colTitle(col, index);
  const pick = (op: CorrectionOp) => {
    setOpen(false);
    emit(op);
  };
  const onBlur = (e: FocusEvent<HTMLSpanElement>) => {
    if (open && !rootRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (e.key === "Escape") setOpen(false); // never stopped: ProposalFocusLayer owns Esc
  };
  const item = (label: string, checked: boolean, op: CorrectionOp) => (
    <button
      key={label}
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      onClick={() => pick(op)}
      className={`block w-full text-left px-2 py-0.5 text-[10px] ${FOCUS_RING} ${
        checked ? "text-[#00E676]" : "text-[var(--fg)] hover:bg-[var(--border)]/40"
      }`}
    >
      <span aria-hidden>{checked ? "✓ " : ""}</span>
      {label}
    </button>
  );
  return (
    <span ref={rootRef} className="relative inline-block" onBlur={onBlur} onKeyDown={onKeyDown}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Role of ${title}`}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={`px-0.5 text-[10px] text-[var(--muted)] hover:text-[var(--fg)] disabled:opacity-40 ${FOCUS_RING}`}
      >
        ▾
      </button>
      {open ? (
        <span
          role="menu"
          aria-label={`Role of ${title}`}
          className="absolute left-0 top-full z-20 min-w-[7.5rem] py-0.5 rounded border border-[var(--border)] bg-[var(--surface)] shadow-lg"
        >
          {COL_ROLES.map((role) => item(COL_ROLE_LABELS[role], col.role === role, { op: "set-col-role", col: col.id, role }))}
          {item("No role", !col.role, { op: "set-col-role", col: col.id, role: null })}
          <span role="separator" className="block my-0.5 border-t border-[var(--border)]" />
          {item("Key column", isTag, { op: "set-tag-col", col: isTag ? null : col.id })}
        </span>
      ) : null}
    </span>
  );
}
