"use client";

// [TP-3 WP-3.N] The table preview (PLAN §3.1 StructurePreviewGrid): the grid AFTER the draft's correction ops,
// computed in the browser by StructureStep (`applyOps`, WP-3.D), so nothing here fetches.
//   • cell tint = the cell's source (`src`: a method, or `edit` for a typed cell); a low-confidence cell and an
//     unknown row key (a shape whose text could not be read) are outlined;
//   • header rows are shaded, section rows italic; spans (`rs`/`cs`) render as row/col spans;
//   • the key gutter shows each row's key; with "Edit cells" on, a click on a key, a cell or a column label edits
//     it in place (⏎ or leaving the field saves: `set-row-key` / `edit-cell` / `rename-col`; Esc cancels, and is
//     not stopped — the field is editable, so ProposalFocusLayer leaves it alone);
//   • each column header has the role ▾ (ColumnRoleMenu: QTY/Tag/Type…, Key column).
// The same component renders read-only in the admin Classifiers preview (WP-3.P: no `emit`) and wide in the
// "Wide view ▸" drawer.

import { useRef, useState, type KeyboardEvent } from "react";
import type { CorrectionOp, StructureCell, StructureRow, StructureTableModel } from "@/lib/parse-engine/types";
import ColumnRoleMenu, { COL_ROLE_LABELS, colTitle } from "./ColumnRoleMenu";

/** Background tint per cell source (legend in StructureStep). */
export const SOURCE_TINT: Readonly<Record<string, string>> = {
  edit: "rgba(0, 230, 118, 0.18)",
  "textract-cells": "rgba(66, 165, 245, 0.16)",
  "shape-centres": "rgba(255, 183, 77, 0.16)",
  tatr: "rgba(171, 71, 188, 0.16)",
  img2table: "rgba(171, 71, 188, 0.16)",
};

/** A cell below this confidence is outlined for review. */
export const LOW_CELL_CONF = 0.5;

type Editing = { kind: "cell"; row: string; col: string } | { kind: "key"; row: string } | { kind: "label"; col: string };

/** The text a row key shows, and whether it is unknown (a shape key whose text could not be read). */
export function rowKeyText(row: StructureRow): { text: string; unknown: boolean } {
  const k = row.key;
  if (!k) return { text: "", unknown: false };
  if (k.kind === "text") return { text: k.text, unknown: false };
  if (k.kind === "shape-text") return { text: k.text ?? "?", unknown: k.text === null };
  return { text: "◆", unknown: false };
}

/** Anchor cells by `row|col`, and the set of positions a span covers (not its anchor). */
export function gridIndex(model: StructureTableModel): { at: Map<string, StructureCell>; covered: Set<string> } {
  const at = new Map<string, StructureCell>();
  const covered = new Set<string>();
  const ri = new Map(model.rows.map((r, i) => [r.id, i]));
  const ci = new Map(model.cols.map((c, i) => [c.id, i]));
  for (const cell of model.cells) {
    const r = ri.get(cell.row);
    const c = ci.get(cell.col);
    if (r === undefined || c === undefined) continue;
    const id = `${cell.row}|${cell.col}`;
    if (covered.has(id) || at.has(id)) continue;
    at.set(id, cell);
    for (let dr = 0; dr < (cell.rs ?? 1); dr++) {
      for (let dc = 0; dc < (cell.cs ?? 1); dc++) {
        if (dr === 0 && dc === 0) continue;
        const row = model.rows[r + dr];
        const col = model.cols[c + dc];
        if (row && col) covered.add(`${row.id}|${col.id}`);
      }
    }
  }
  return { at, covered };
}

/** A one-line field that saves on ⏎ or blur and cancels on Esc (Esc is not stopped: the target is editable). */
export function InlineField({ value, label, onSave, onCancel }: { value: string; label: string; onSave: (v: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(value);
  const settled = useRef(false); // ⏎, Esc and the blur that may follow end the edit once
  const settle = (save: boolean) => {
    if (settled.current) return;
    settled.current = true;
    if (save) onSave(text);
    else onCancel();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      settle(true);
    } else if (e.key === "Escape") {
      settle(false);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.stopPropagation();
    }
  };
  return (
    <input
      aria-label={label}
      autoFocus
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => settle(true)}
      className="w-full min-w-[3rem] px-0.5 text-[10px] bg-[var(--bg)] text-[var(--fg)] border border-[#00E676]/60 rounded-sm outline-none"
    />
  );
}

export default function StructurePreviewGrid({
  model,
  emit,
  editCells = false,
  wide = false,
  label = "Structure preview",
}: {
  model: StructureTableModel;
  /** Absent → read-only (admin preview). */
  emit?: (op: CorrectionOp) => void;
  editCells?: boolean;
  wide?: boolean;
  label?: string;
}) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const editable = !!emit && editCells;
  const { at, covered } = gridIndex(model);
  const keyed = model.rows.some((r) => !!r.key);
  const tagCol = model.tag?.col ?? null;
  const cellPad = wide ? "px-1.5 py-1 text-[11px]" : "px-1 py-0.5 text-[10px]";
  const done = (op: CorrectionOp | null) => {
    setEditing(null);
    if (op && emit) emit(op);
  };

  return (
    <div className="overflow-auto max-w-full" data-wide={wide ? "" : undefined}>
      <table aria-label={label} className="border-collapse text-[var(--fg)]">
        <thead>
          <tr>
            {keyed ? <th scope="col" className={`${cellPad} text-left text-[var(--muted)] font-normal`}>Key</th> : null}
            {model.cols.map((col, i) => {
              const title = colTitle(col, i);
              const isTag = tagCol === col.id;
              const editingLabel = editing?.kind === "label" && editing.col === col.id;
              return (
                <th key={col.id} scope="col" data-col={col.id} className={`${cellPad} text-left font-semibold border border-[var(--border)] whitespace-nowrap`}>
                  {editingLabel ? (
                    <InlineField
                      value={col.label}
                      label={`Label of ${title}`}
                      onSave={(v) => done(v.trim() && v !== col.label ? { op: "rename-col", col: col.id, label: v } : null)}
                      onCancel={() => setEditing(null)}
                    />
                  ) : (
                    <span onClick={editable ? () => setEditing({ kind: "label", col: col.id }) : undefined} className={editable ? "cursor-text" : ""}>
                      {isTag ? "⬡ " : ""}
                      {title}
                    </span>
                  )}
                  {col.role ? <span data-role={col.role} className="ml-1 px-0.5 rounded bg-[#00E676]/15 text-[#00E676] text-[9px] font-normal">{COL_ROLE_LABELS[col.role]}</span> : null}
                  {emit ? <ColumnRoleMenu col={col} index={i} isTag={isTag} emit={emit} /> : null}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {model.rows.map((row) => {
            const key = rowKeyText(row);
            const editingKey = editing?.kind === "key" && editing.row === row.id;
            const rowClass = row.role === "header" ? "bg-[var(--border)]/40 font-semibold" : row.role === "section" ? "italic" : "";
            return (
              <tr key={row.id} data-row={row.id} data-role={row.role} className={rowClass}>
                {keyed ? (
                  <th
                    scope="row"
                    data-unknown-key={key.unknown ? "" : undefined}
                    onClick={editable && !editingKey ? () => setEditing({ kind: "key", row: row.id }) : undefined}
                    className={`${cellPad} text-left font-normal border border-[var(--border)] ${editable ? "cursor-text" : ""}`}
                    style={key.unknown ? { outline: "1px solid #ef4444", color: "#ef4444" } : undefined}
                  >
                    {editingKey ? (
                      <InlineField
                        value={key.unknown ? "" : key.text}
                        label={`Key of row ${row.id}`}
                        onSave={(v) => done(v.trim() !== (key.unknown ? "" : key.text) ? { op: "set-row-key", row: row.id, text: v } : null)}
                        onCancel={() => setEditing(null)}
                      />
                    ) : (
                      key.text
                    )}
                  </th>
                ) : null}
                {model.cols.map((col) => {
                  const id = `${row.id}|${col.id}`;
                  if (covered.has(id)) return null;
                  const cell = at.get(id);
                  const editingCell = editing?.kind === "cell" && editing.row === row.id && editing.col === col.id;
                  const low = cell?.conf !== undefined && cell.conf < LOW_CELL_CONF;
                  return (
                    <td
                      key={col.id}
                      data-cell={id}
                      data-src={cell?.src}
                      rowSpan={cell?.rs && cell.rs > 1 ? cell.rs : undefined}
                      colSpan={cell?.cs && cell.cs > 1 ? cell.cs : undefined}
                      onClick={editable && !editingCell ? () => setEditing({ kind: "cell", row: row.id, col: col.id }) : undefined}
                      className={`${cellPad} align-top border border-[var(--border)] whitespace-pre-wrap ${wide ? "max-w-[20rem]" : "max-w-[10rem]"} ${editable ? "cursor-text" : ""}`}
                      style={{
                        background: cell ? SOURCE_TINT[cell.src] : undefined,
                        outline: low ? "1px solid #f59e0b" : undefined,
                      }}
                    >
                      {editingCell ? (
                        <InlineField
                          value={cell?.text ?? ""}
                          label={`Cell ${row.id} ${colTitle(col, model.cols.indexOf(col))}`}
                          onSave={(v) => done(v !== (cell?.text ?? "") ? { op: "edit-cell", row: row.id, col: col.id, text: v } : null)}
                          onCancel={() => setEditing(null)}
                        />
                      ) : (
                        cell?.text ?? ""
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
