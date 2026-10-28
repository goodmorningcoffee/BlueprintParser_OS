"use client";

// [TP-3 WP-3.N] The corrections of the Structure step (PLAN §3.1, §3.3 A step 3):
//   tables      [Adjust lines] [Draw rows | Draw columns] [Edit cells] [Header rows ▾] [Key column ▾] [Source ▾]
//   notes/spec  [Split/merge ¶]
//   both        Undo / Reset (named "Undo correction" / "Reset corrections": the KindBar's verdict Undo shares the detail)
// Every control appends a correction op to the item's draft (E-2: ops are applied after fusion and always win);
// the preview re-applies them locally, so no control fetches. "Adjust lines" brings the box into view and explains
// the canvas handles (WP-3.O: drag = `move-line`, double-click = `add-line`, Del on a focused handle =
// `remove-line`); "Draw rows / columns" arms WP-3.O's box draw on the canvas (`workspaceCanvasStore.arm`), where
// each drawn box is a `user-boxes` op. "Source ▾" pins BOTH axes to one method (SourceSwitcher pins one axis).

import type { ChangeEvent } from "react";
import type { CorrectionOp, MethodId, ParseResult, StructureModel } from "@/lib/parse-engine/types";
import { useWorkspaceCanvasStore, type CanvasDrawMode } from "@/stores/workspaceCanvasStore";
import { colTitle } from "./ColumnRoleMenu";
import { METHOD_LABELS, pinnedSource } from "./SourceSwitcher";
import { FOCUS_RING, wsButton } from "./WorkspaceHeader";

export type StructureMode = "lines" | "cells" | "paragraphs" | null;

/** Header-row choices offered: 0 … min(6, rows of the main box). */
export const MAX_HEADER_CHOICE = 6;

const SELECT = `px-1 py-0.5 rounded border border-[var(--border)] bg-[var(--bg)] text-[10px] text-[var(--fg)] disabled:opacity-40 ${FOCUS_RING}`;

/** The value "Source ▾" shows: one method on both axes, Fused, or "mixed" (axes pinned differently). */
export function sourceChoice(ops: readonly CorrectionOp[]): MethodId | "fused" | "mixed" {
  const rows = pinnedSource(ops, "rows");
  const cols = pinnedSource(ops, "cols");
  if (rows === cols) return rows ?? "fused";
  return "mixed";
}

/** The pin ops for "Source ▾ = method": each axis on which the method has lines (null = both back to Fused). */
export function pinBothOps(result: ParseResult, method: MethodId | null): CorrectionOp[] {
  if (method === null) return [{ op: "pin-source", axis: "rows", method: null }, { op: "pin-source", axis: "cols", method: null }];
  const alt = result.alternatives.find((a) => a.method === method);
  if (!alt) return [];
  const out: CorrectionOp[] = [];
  if (alt.rows >= 1) out.push({ op: "pin-source", axis: "rows", method });
  if (alt.cols >= 1) out.push({ op: "pin-source", axis: "cols", method });
  return out;
}

export default function CorrectionBar({
  itemKey,
  result,
  model,
  ops,
  mode,
  readOnly,
  setMode,
  emit,
  emitMany,
  onShowOnPage,
  onUndo,
  onReset,
}: {
  itemKey: string;
  result: ParseResult;
  /** The preview (the result's model after the ops). */
  model: StructureModel;
  ops: readonly CorrectionOp[];
  mode: StructureMode;
  readOnly: boolean;
  setMode: (mode: StructureMode) => void;
  emit: (op: CorrectionOp) => void;
  emitMany: (ops: CorrectionOp[]) => void;
  onShowOnPage: () => void;
  onUndo: () => void;
  onReset: () => void;
}) {
  const armed = useWorkspaceCanvasStore((s) => (s.armed?.itemKey === itemKey ? s.armed.mode : null));
  const toggleDraw = (m: CanvasDrawMode) => {
    const canvas = useWorkspaceCanvasStore.getState();
    if (armed === m) canvas.disarm();
    else canvas.arm(m, itemKey);
  };
  const undoReset = (
    <span className="ml-auto flex gap-1">
      <button type="button" aria-label="Undo correction" disabled={readOnly || ops.length === 0} onClick={onUndo} className={`${wsButton(false)} disabled:opacity-40`}>
        Undo
      </button>
      <button type="button" aria-label="Reset corrections" disabled={readOnly || ops.length === 0} onClick={onReset} className={`${wsButton(false)} disabled:opacity-40`}>
        Reset
      </button>
    </span>
  );

  if ("paragraphs" in model) {
    return (
      <div role="toolbar" aria-label="Corrections" className="flex flex-wrap items-center gap-1 px-2 py-1 border-b border-[var(--border)]">
        <button
          type="button"
          aria-pressed={mode === "paragraphs"}
          disabled={readOnly}
          onClick={() => setMode(mode === "paragraphs" ? null : "paragraphs")}
          className={`${wsButton(mode === "paragraphs")} disabled:opacity-40`}
        >
          Split/merge ¶
        </button>
        {undoReset}
      </div>
    );
  }

  const rows0 = model.rows.filter((r) => (r.part ?? 0) === 0).length;
  const headerChoices = Array.from({ length: Math.min(MAX_HEADER_CHOICE, rows0) + 1 }, (_, n) => n);
  const source = sourceChoice(ops);
  const pinnable = result.alternatives.filter((a) => a.rows >= 1 || a.cols >= 1);
  const onSource = (e: ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    if (v === "mixed") return;
    emitMany(pinBothOps(result, v === "fused" ? null : (v as MethodId)));
  };

  return (
    <div role="toolbar" aria-label="Corrections" className="flex flex-col gap-1 px-2 py-1 border-b border-[var(--border)]">
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          aria-pressed={mode === "lines"}
          disabled={readOnly}
          onClick={() => {
            const on = mode !== "lines";
            setMode(on ? "lines" : null);
            if (on) onShowOnPage();
          }}
          className={`${wsButton(mode === "lines")} disabled:opacity-40`}
        >
          Adjust lines
        </button>
        <button type="button" aria-pressed={armed === "draw-rows"} disabled={readOnly} onClick={() => toggleDraw("draw-rows")} className={`${wsButton(armed === "draw-rows")} disabled:opacity-40`}>
          Draw rows
        </button>
        <button type="button" aria-pressed={armed === "draw-cols"} disabled={readOnly} onClick={() => toggleDraw("draw-cols")} className={`${wsButton(armed === "draw-cols")} disabled:opacity-40`}>
          Draw columns
        </button>
        <button
          type="button"
          aria-pressed={mode === "cells"}
          disabled={readOnly}
          onClick={() => setMode(mode === "cells" ? null : "cells")}
          className={`${wsButton(mode === "cells")} disabled:opacity-40`}
        >
          Edit cells
        </button>
        {undoReset}
      </div>
      <div className="flex flex-wrap items-center gap-1 text-[10px] text-[var(--muted)]">
        <label className="flex items-center gap-0.5">
          Header rows
          <select
            aria-label="Header rows"
            className={SELECT}
            disabled={readOnly}
            value={model.headerRows}
            onChange={(e) => emit({ op: "set-header-rows", n: Number(e.target.value) })}
          >
            {headerChoices.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-0.5">
          Key column
          <select
            aria-label="Key column"
            className={SELECT}
            disabled={readOnly}
            value={model.tag?.col ?? ""}
            onChange={(e) => emit({ op: "set-tag-col", col: e.target.value || null })}
          >
            <option value="">None</option>
            {model.cols.map((c, i) => <option key={c.id} value={c.id}>{colTitle(c, i)}</option>)}
          </select>
        </label>
        {model.tag ? (
          <select
            aria-label="Tag scope"
            className={SELECT}
            disabled={readOnly}
            value={model.tag.scope}
            onChange={(e) => emit({ op: "set-tag-scope", scope: e.target.value === "project" ? "project" : "sheet" })}
          >
            <option value="sheet">This sheet</option>
            <option value="project">All sheets</option>
          </select>
        ) : null}
        <label className="flex items-center gap-0.5">
          Source
          <select aria-label="Source" className={SELECT} disabled={readOnly || pinnable.length === 0} value={source} onChange={onSource}>
            <option value="fused">Fused</option>
            {pinnable.map((a) => <option key={a.method} value={a.method}>{METHOD_LABELS[a.method]}</option>)}
            {source === "mixed" ? <option value="mixed" disabled>Mixed</option> : null}
          </select>
        </label>
      </div>
      {mode === "lines" ? (
        <p role="note" className="text-[10px] text-[var(--muted)]">
          On the drawing: drag a line to move it · double-click the rail beside the box to add one · focus a line and press Del to remove it.
        </p>
      ) : null}
      {armed ? (
        <p role="note" className="text-[10px] text-[var(--muted)]">
          Drag a box over each {armed === "draw-rows" ? "row" : "column"} on the drawing · Esc ends.
        </p>
      ) : null}
    </div>
  );
}
