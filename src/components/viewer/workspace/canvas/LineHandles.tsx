"use client";

// [TP-3 WP-3.O] "Adjust lines" on the canvas (PLAN §3.3 A step 3): every row / column line of the open table has a
// focusable handle.
//   drag          → `move-line` (or `set-lines`, part 0's boundary list, for a line without an id) at the
//                   page-normalised drop position; an id-less line of a later part gets no handle (no op fits it);
//   double-click  on the rail left of the table (rows) or above it (cols) → `add-line` there;
//   Del / ⌫       on the FOCUSED handle → `remove-line`. The key never reaches the window-level annotation
//                 dispatcher, so a selected annotation is never deleted by it (§1.6 rule 14, C2-M11).
// Handles set `pointer-events: auto` themselves (the focus layer's root is `pointer-events: none`), and stop
// pointer/mouse-down so the annotation canvas and the viewer's pan never see a handle gesture.

import { useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from "react";
import type { Axis, BboxMinMax, CorrectionOp } from "@/lib/parse-engine/types";
import { focusScopedKeys } from "../keyboard";
import { clampLine, editableLine, LINE_EPS, moveOp, pageUnit, removeOp, type CanvasLine } from "./lineModel";
import { LINE_COLORS, pct } from "./StructureLines";

/** Client point → page-normalised [x, y], or null when the layer has no size yet. */
export type ToPage = (clientX: number, clientY: number) => [number, number] | null;

const HIT_PX = 8;
const RAIL_PX = 12;

const stop = (e: MouseEvent | PointerEvent) => e.stopPropagation();

interface Props {
  rows: CanvasLine[];
  cols: CanvasLine[];
  boxes: BboxMinMax[];
  /** Part 0's outer edges per axis (the ends of a `set-lines` list). */
  edges: Record<Axis, [number, number]>;
  toPage: ToPage;
  emit: (op: CorrectionOp) => void;
}

function Handle({ line, index, lines, boxes, edges, toPage, emit }: { line: CanvasLine; index: number; lines: CanvasLine[] } & Omit<Props, "rows" | "cols">) {
  const [dragAt, setDragAt] = useState<number | null>(null);
  const dragging = useRef(false);
  const box = boxes[line.part] ?? boxes[0];
  const at = dragAt ?? line.at;
  const rows = line.axis === "rows";

  const positionAt = (e: PointerEvent<HTMLDivElement>): number | null => {
    const p = toPage(e.clientX, e.clientY);
    return p ? clampLine(line, rows ? p[1] : p[0], lines, boxes) : null;
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.focus();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragging.current = true;
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const v = positionAt(e);
    if (v !== null) setDragAt(v);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    e.stopPropagation();
    dragging.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    const v = positionAt(e) ?? dragAt;
    setDragAt(null);
    const op = v !== null && Math.abs(v - line.at) > LINE_EPS / 2 ? moveOp(line, v, lines, edges[line.axis]) : null;
    if (op) emit(op);
  };
  const onPointerCancel = () => {
    dragging.current = false;
    setDragAt(null);
  };
  const remove = () => {
    const op = removeOp(line, lines, edges[line.axis]);
    if (op) emit(op);
  };

  const label = `${rows ? "Row" : "Column"} line ${index + 1}`;
  const style: CSSProperties = rows
    ? { left: pct(box[0]), width: pct(box[2] - box[0]), top: `calc(${pct(at)} - ${HIT_PX / 2}px)`, height: HIT_PX, cursor: "row-resize" }
    : { top: pct(box[1]), height: pct(box[3] - box[1]), left: `calc(${pct(at)} - ${HIT_PX / 2}px)`, width: HIT_PX, cursor: "col-resize" };
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-orientation={rows ? "vertical" : "horizontal"}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={pageUnit(at)}
      data-line-handle={`${line.axis}:${line.after ?? `#${index}`}`}
      data-dragging={dragAt !== null ? "" : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onMouseDown={stop}
      onClick={stop}
      onKeyDown={focusScopedKeys({ Delete: remove, Backspace: remove })}
      className="group outline-none"
      style={{ position: "absolute", pointerEvents: "auto", ...style }}
    >
      <div
        className={dragAt !== null ? undefined : "opacity-0 group-hover:opacity-60 group-focus:opacity-100"}
        style={{
          position: "absolute",
          inset: 0,
          margin: rows ? `${HIT_PX / 2 - 1}px 0` : `0 ${HIT_PX / 2 - 1}px`,
          background: LINE_COLORS[dragAt !== null ? "user" : line.src],
        }}
      />
    </div>
  );
}

function Rail({ axis, boxes, toPage, emit }: { axis: Axis } & Omit<Props, "rows" | "cols" | "edges">) {
  const b = boxes[0];
  const onDoubleClick = (e: MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const p = toPage(e.clientX, e.clientY);
    if (!p) return;
    const v = axis === "rows" ? p[1] : p[0];
    const inPart = axis === "rows"
      ? boxes.some((box) => v > box[1] + LINE_EPS && v < box[3] - LINE_EPS)
      : v > b[0] + LINE_EPS && v < b[2] - LINE_EPS;
    if (inPart) emit({ op: "add-line", axis, at: pageUnit(v) });
  };
  const style: CSSProperties = axis === "rows"
    ? { left: `calc(${pct(b[0])} - ${RAIL_PX + 2}px)`, width: RAIL_PX, top: pct(Math.min(...boxes.map((x) => x[1]))), height: pct(Math.max(...boxes.map((x) => x[3])) - Math.min(...boxes.map((x) => x[1]))), cursor: "copy" }
    : { top: `calc(${pct(b[1])} - ${RAIL_PX + 2}px)`, height: RAIL_PX, left: pct(b[0]), width: pct(b[2] - b[0]), cursor: "copy" };
  return (
    <div
      data-line-rail={axis}
      title={axis === "rows" ? "Double-click to add a row line" : "Double-click to add a column line"}
      onDoubleClick={onDoubleClick}
      onPointerDown={stop}
      onMouseDown={stop}
      onClick={stop}
      className="bg-[var(--accent)]/10 hover:bg-[var(--accent)]/30"
      style={{ position: "absolute", pointerEvents: "auto", ...style }}
    />
  );
}

export default function LineHandles({ rows, cols, boxes, edges, toPage, emit }: Props) {
  return (
    <div data-workspace-handles="" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      <Rail axis="rows" boxes={boxes} toPage={toPage} emit={emit} />
      <Rail axis="cols" boxes={boxes} toPage={toPage} emit={emit} />
      {rows.map((line, i) => editableLine(line) && (
        <Handle key={`r-${line.part}-${line.after ?? `#${i}`}`} line={line} index={i} lines={rows} boxes={boxes} edges={edges} toPage={toPage} emit={emit} />
      ))}
      {cols.map((line, i) => editableLine(line) && (
        <Handle key={`c-${line.after ?? `#${i}`}`} line={line} index={i} lines={cols} boxes={boxes} edges={edges} toPage={toPage} emit={emit} />
      ))}
    </div>
  );
}
