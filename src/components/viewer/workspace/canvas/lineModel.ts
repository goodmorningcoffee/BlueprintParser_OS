// [TP-3 WP-3.O] Pure geometry of the workspace canvas: which structure lines to draw for a draft, where they are
// after the draft's correction ops, which source each one comes from, and which op a gesture on a line becomes.
//
// Every coordinate is page-normalised (0–1, E-4), the same space as `StructureRow.y0/y1` and `StructureCol.x0/x1`.
// A LINE is an interior boundary: the line between row r(i-1) and r(i) is `{ after: r(i-1).id, at: r(i).y0 }`
// (cols likewise with x0). Rows of different continuation parts (R11) never share a line; part k > 0 lies in
// `parts[k-1]`, and the column lines of a later part are part 0's lines mapped by relative x (`parts.ts`).
//
// Preview: the draft's ops go through `applyOps` (WP-3.D, client-safe, E-8). While that is still the WP-2.E stub
// (it throws), the line ops are previewed here instead — `pin-source` from `alternatives[].geometry`, `set-lines`,
// `move-line`, `add-line`, `remove-line` — so dragging works the same before and after 3.D lands. Lines without a
// row/col id (added, pinned, or set) are edited with `set-lines` on their axis (a full boundary list per part, the
// `rowLines` convention); id-keyed lines with `move-line` / `remove-line` (E-2: ops applied after fusion).

import { applyOps } from "@/lib/parse-engine/ops";
import type {
  Axis,
  BboxMinMax,
  CorrectionOp,
  MethodId,
  ParseAlternative,
  ParseResult,
  StructureModel,
  StructureTableModel,
} from "@/lib/parse-engine/types";

/** Two lines closer than this (page units) are the same line. */
export const LINE_EPS = 0.002;

export type LineSource = MethodId | "fused" | "user";

export interface CanvasLine {
  axis: Axis;
  /** Page-normalised y (rows) or x (cols). */
  at: number;
  /** Id of the row/col BEFORE the line, when the line has one (→ `move-line` / `remove-line`). */
  after: string | null;
  src: LineSource;
  /** Continuation part the line belongs to (0 = the main box). Cols are always part 0. */
  part: number;
}

export interface CanvasPreview {
  model: StructureModel;
  /** True when `applyOps` previewed every op; false while it is unavailable (line ops previewed locally). */
  exact: boolean;
}

export const isTableModel = (m: StructureModel): m is StructureTableModel => !("paragraphs" in m);

/** Round to 1e-4 and clamp into [0, 1]: ops carry stable, compact page coordinates. */
export function pageUnit(v: number): number {
  return Math.round(Math.min(1, Math.max(0, v)) * 1e4) / 1e4;
}

export function previewModel(result: ParseResult, ops: readonly CorrectionOp[]): CanvasPreview {
  if (ops.length === 0) return { model: result.model, exact: true };
  try {
    return { model: applyOps(result, ops), exact: true };
  } catch {
    return { model: result.model, exact: false };
  }
}

/** The boxes of a table: part 0 = `bbox`, part k = `parts[k-1]`. */
export function partBoxes(model: StructureTableModel): BboxMinMax[] {
  return [model.bbox, ...(model.parts ?? [])];
}

function partOfY(y: number, boxes: readonly BboxMinMax[]): number {
  return boxes.findIndex((b) => y > b[1] + LINE_EPS && y < b[3] - LINE_EPS);
}

function inside(axis: Axis, v: number, box: BboxMinMax): boolean {
  return axis === "rows" ? v > box[1] + LINE_EPS && v < box[3] - LINE_EPS : v > box[0] + LINE_EPS && v < box[2] - LINE_EPS;
}

/** The interior lines of a model, straight from its rows / cols. */
export function modelLines(model: StructureTableModel, axis: Axis): CanvasLine[] {
  const out: CanvasLine[] = [];
  if (axis === "rows") {
    for (let i = 1; i < model.rows.length; i++) {
      const prev = model.rows[i - 1];
      const row = model.rows[i];
      if ((prev.part ?? 0) !== (row.part ?? 0)) continue;
      out.push({ axis, at: row.y0, after: prev.id, src: "fused", part: row.part ?? 0 });
    }
  } else {
    for (let i = 1; i < model.cols.length; i++) {
      out.push({ axis, at: model.cols[i].x0, after: model.cols[i - 1].id, src: "fused", part: 0 });
    }
  }
  return out;
}

/** Interior lines of a boundary list (`rowLines` / `colLines` / `set-lines.at`), assigned to their part. */
function linesFromBoundaries(axis: Axis, at: readonly number[], boxes: readonly BboxMinMax[], src: LineSource): CanvasLine[] {
  const out: CanvasLine[] = [];
  for (const v of at) {
    const part = axis === "rows" ? partOfY(v, boxes) : inside("cols", v, boxes[0]) ? 0 : -1;
    if (part < 0) continue;
    if (out.some((l) => l.part === part && Math.abs(l.at - v) <= LINE_EPS)) continue;
    out.push({ axis, at: v, after: null, src, part });
  }
  return out;
}

const sortLines = (lines: CanvasLine[]): CanvasLine[] => [...lines].sort((a, b) => a.part - b.part || a.at - b.at);

function altLines(alt: ParseAlternative, axis: Axis): number[] {
  return axis === "rows" ? alt.geometry.rowLines : alt.geometry.colLines;
}

/** Local preview of the line ops (used only while `applyOps` is unavailable). Other ops do not move lines. */
export function applyLineOps(result: ParseResult, ops: readonly CorrectionOp[], axis: Axis): CanvasLine[] {
  const model = result.model;
  if (!isTableModel(model)) return [];
  const boxes = partBoxes(model);
  let lines = modelLines(model, axis);
  for (const op of ops) {
    if (!("axis" in op) || op.axis !== axis) continue;
    switch (op.op) {
      case "pin-source": {
        if (op.method === null) {
          lines = modelLines(model, axis);
          break;
        }
        const alt = result.alternatives.find((a) => a.method === op.method);
        if (alt) lines = linesFromBoundaries(axis, altLines(alt, axis), boxes, op.method);
        break;
      }
      case "set-lines":
        lines = linesFromBoundaries(axis, op.at, boxes, "user");
        break;
      case "move-line":
        lines = lines.map((l) => (l.after === op.after ? { ...l, at: op.at, src: "user" } : l));
        break;
      case "add-line": {
        const part = axis === "rows" ? partOfY(op.at, boxes) : inside("cols", op.at, boxes[0]) ? 0 : -1;
        if (part >= 0) lines = [...lines, { axis, at: op.at, after: null, src: "user", part }];
        break;
      }
      case "remove-line":
        lines = lines.filter((l) => l.after !== op.after);
        break;
    }
  }
  return sortLines(lines);
}

const near = (vs: readonly number[], v: number): boolean => vs.some((x) => Math.abs(x - v) <= LINE_EPS);

/** The highest-confidence method whose own lines agree with `line`, else "fused". */
function agreeingSource(line: CanvasLine, alternatives: readonly ParseAlternative[]): LineSource {
  const ranked = [...alternatives].sort((a, b) => b.conf - a.conf);
  return ranked.find((a) => near(altLines(a, line.axis), line.at))?.method ?? "fused";
}

/** The method the last `pin-source` op on this axis pinned (null when none, or when it was un-pinned). */
function pinnedMethod(ops: readonly CorrectionOp[], axis: Axis): MethodId | null {
  let pinned: MethodId | null = null;
  for (const op of ops) if (op.op === "pin-source" && op.axis === axis) pinned = op.method;
  return pinned;
}

/** The lines to draw on one axis, after the draft's ops, each with its source (user edit, pinned or agreeing method, fusion). */
export function canvasLines(result: ParseResult, ops: readonly CorrectionOp[], preview: CanvasPreview, axis: Axis): CanvasLine[] {
  const base = result.model;
  if (!isTableModel(base) || !isTableModel(preview.model)) return [];
  if (!preview.exact) {
    return applyLineOps(result, ops, axis).map((l) => (l.src === "fused" ? { ...l, src: agreeingSource(l, result.alternatives) } : l));
  }
  const baseLines = modelLines(base, axis);
  const pinned = pinnedMethod(ops, axis);
  const pinnedAlt = pinned ? result.alternatives.find((a) => a.method === pinned) : undefined;
  return sortLines(modelLines(preview.model, axis).map((l): CanvasLine => {
    if (baseLines.some((b) => b.part === l.part && Math.abs(b.at - l.at) <= LINE_EPS)) {
      return { ...l, src: agreeingSource(l, result.alternatives) };
    }
    if (pinned && pinnedAlt && near(altLines(pinnedAlt, axis), l.at)) return { ...l, src: pinned };
    return { ...l, src: "user" };
  }));
}

/** Where a dragged line may go: strictly inside its part's box and between its neighbours on the same part. */
export function clampLine(line: CanvasLine, v: number, lines: readonly CanvasLine[], boxes: readonly BboxMinMax[]): number {
  const box = boxes[line.part] ?? boxes[0];
  let lo = (line.axis === "rows" ? box[1] : box[0]) + LINE_EPS;
  let hi = (line.axis === "rows" ? box[3] : box[2]) - LINE_EPS;
  for (const other of lines) {
    if (other === line || other.part !== line.part) continue;
    if (other.at <= line.at && other.at + LINE_EPS > lo) lo = other.at + LINE_EPS;
    if (other.at > line.at && other.at - LINE_EPS < hi) hi = other.at - LINE_EPS;
  }
  return pageUnit(Math.min(hi, Math.max(lo, v)));
}

/** A full boundary list for `set-lines`: per part, [edge, ...interior, edge] (the `rowLines` convention). */
export function boundaries(axis: Axis, lines: readonly CanvasLine[], boxes: readonly BboxMinMax[]): number[] {
  if (axis === "cols") {
    const b = boxes[0];
    return [b[0], ...lines.filter((l) => l.part === 0).map((l) => l.at).sort((x, y) => x - y), b[2]].map(pageUnit);
  }
  return boxes.flatMap((b, part) => [
    b[1],
    ...lines.filter((l) => l.part === part).map((l) => l.at).sort((x, y) => x - y),
    b[3],
  ]).map(pageUnit);
}

/** The op for dragging `line` to `at`. */
export function moveOp(line: CanvasLine, at: number, lines: readonly CanvasLine[], boxes: readonly BboxMinMax[]): CorrectionOp {
  if (line.after) return { op: "move-line", axis: line.axis, after: line.after, at };
  return { op: "set-lines", axis: line.axis, at: boundaries(line.axis, lines.map((l) => (l === line ? { ...l, at } : l)), boxes) };
}

/** The op for deleting `line`. */
export function removeOp(line: CanvasLine, lines: readonly CanvasLine[], boxes: readonly BboxMinMax[]): CorrectionOp {
  if (line.after) return { op: "remove-line", axis: line.axis, after: line.after };
  return { op: "set-lines", axis: line.axis, at: boundaries(line.axis, lines.filter((l) => l !== line), boxes) };
}

/** Column x of part 0 mapped onto a later part's box by relative position (`parts.ts` mapXToPart). */
export function mapColToPart(x: number, from: BboxMinMax, to: BboxMinMax): number {
  const w = from[2] - from[0];
  return w > 0 ? to[0] + ((x - from[0]) / w) * (to[2] - to[0]) : x;
}
