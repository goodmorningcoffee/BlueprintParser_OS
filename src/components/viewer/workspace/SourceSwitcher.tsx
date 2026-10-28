"use client";

// [TP-3 WP-3.N] Which method's lines the grid uses, per axis (PLAN §3.1, §1.4 R12):
//   "Rows: Fused ✓ (12) · Shape centres 12 · Textract 12 · Lines 17 · Rulings 12"
// Fused is the engine's own fusion; every other entry is one method's geometry from `ParseResult.alternatives`.
// A click is a `pin-source` op (`method: null` = back to Fused), previewed locally by `applyOps` from
// `alternatives[].geometry`, so switching never fetches. A method with no lines on an axis (fewer than one band)
// is shown but cannot be pinned there. The active entry is the LAST pin on that axis in the draft's ops.

import type { Axis, CorrectionOp, MethodId, ParseResult, StructureTableModel } from "@/lib/parse-engine/types";
import { FOCUS_RING } from "./WorkspaceHeader";

export const METHOD_LABELS: Readonly<Record<MethodId, string>> = {
  "ocr-lines": "Lines",
  "shape-centres": "Shape centres",
  "textract-cells": "Textract",
  layout: "Layout",
  "primitive-grid": "Grid",
  "hanging-indent": "Indents",
  "x-starts": "Text edges",
  rulings: "Rulings",
  img2table: "img2table",
  tatr: "Cell model",
};

/** The method the last `pin-source` on this axis pinned; null = Fused (no pin, or un-pinned). */
export function pinnedSource(ops: readonly CorrectionOp[], axis: Axis): MethodId | null {
  let pinned: MethodId | null = null;
  for (const op of ops) if (op.op === "pin-source" && op.axis === axis) pinned = op.method;
  return pinned;
}

/** Bands of the fused model on an axis (rows of the main box; continuation parts keep their own). */
export function fusedCount(model: StructureTableModel, axis: Axis): number {
  return axis === "rows" ? model.rows.filter((r) => (r.part ?? 0) === 0).length : model.cols.length;
}

const AXIS_LABEL: Readonly<Record<Axis, string>> = { rows: "Rows", cols: "Columns" };

function AxisLine({
  axis,
  result,
  model,
  active,
  disabled,
  onPin,
}: {
  axis: Axis;
  result: ParseResult;
  model: StructureTableModel;
  active: MethodId | null;
  disabled: boolean;
  onPin: (axis: Axis, method: MethodId | null) => void;
}) {
  const chip = (key: string, label: string, on: boolean, pinnable: boolean, method: MethodId | null, title?: string) => (
    <button
      key={key}
      type="button"
      aria-pressed={on}
      title={title}
      disabled={disabled || !pinnable}
      onClick={() => {
        if (!on) onPin(axis, method);
      }}
      className={`px-1 rounded text-[10px] disabled:opacity-40 ${FOCUS_RING} ${
        on ? "bg-[#00E676]/15 text-[#00E676]" : "text-[var(--muted)] hover:text-[var(--fg)]"
      }`}
    >
      {label}
    </button>
  );
  return (
    <div role="group" aria-label={`${AXIS_LABEL[axis]} source`} className="flex flex-wrap items-center gap-x-0.5 gap-y-0">
      <span className="text-[10px] text-[var(--muted)] mr-0.5">{AXIS_LABEL[axis]}:</span>
      {chip("fused", `Fused${active === null ? " ✓" : ""} (${fusedCount(model, axis)})`, active === null, true, null, "The engine's fused lines")}
      {result.alternatives.map((alt) => {
        const n = axis === "rows" ? alt.rows : alt.cols;
        const on = active === alt.method;
        return (
          <span key={alt.method} className="flex items-center">
            <span aria-hidden className="text-[10px] text-[var(--muted)]">·</span>
            {chip(
              alt.method,
              `${METHOD_LABELS[alt.method]}${on ? " ✓" : ""} ${n}`,
              on,
              n >= 1,
              alt.method,
              `agreement ${Math.round(alt.agreement * 100)}% · confidence ${Math.round(alt.conf * 100)}%`,
            )}
          </span>
        );
      })}
    </div>
  );
}

export default function SourceSwitcher({
  result,
  ops,
  disabled = false,
  onPin,
}: {
  /** The parse the draft's ops apply to (its model is the fused model; its alternatives are the other methods). */
  result: ParseResult;
  ops: readonly CorrectionOp[];
  disabled?: boolean;
  onPin: (axis: Axis, method: MethodId | null) => void;
}) {
  const model = result.model;
  if ("paragraphs" in model) return null;
  return (
    <div aria-label="Sources" className="flex flex-col gap-0.5 px-2 py-1 border-b border-[var(--border)]">
      <AxisLine axis="rows" result={result} model={model} active={pinnedSource(ops, "rows")} disabled={disabled} onPin={onPin} />
      <AxisLine axis="cols" result={result} model={model} active={pinnedSource(ops, "cols")} disabled={disabled} onPin={onPin} />
    </div>
  );
}
