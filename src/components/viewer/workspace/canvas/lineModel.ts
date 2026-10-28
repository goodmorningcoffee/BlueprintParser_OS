// [TP-3 WP-3.O] Pure geometry of the workspace canvas: which structure lines to draw for a draft, where they are
// after the draft's correction ops, which source each one comes from, and which op a gesture on a line becomes.
//
// Every coordinate is page-normalised (0–1, E-4), the same space as `StructureRow.y0/y1` and `StructureCol.x0/x1`.
// A LINE is an interior boundary: the line between row r(i-1) and r(i) is `{ after: r(i-1).id, at: r(i).y0 }`
// (cols likewise with x0). Rows of different continuation parts (R11) never share a line; part k > 0 lies in
// `parts[k-1]`, and the column lines of a later part are part 0's lines mapped by relative x (`parts.ts`).
// A line's part comes from its ROW (`row.part`), never from its y: continuation blocks usually sit side by side on
// one sheet, so their y-ranges overlap (VERIFY F2).
//
// Preview: the draft's ops go through `applyOps` (WP-3.D, client-safe, E-8). While that is still the WP-2.E stub
// (it throws `ParseEngineNotImplementedError`), the line ops are previewed here instead — `pin-source` from
// `alternatives[].geometry`, `set-lines`, `move-line`, `add-line`, `remove-line` — with WP-3.D's semantics:
//   • an axis replacement (`pin-source`, `set-lines`) acts on PART 0 only (alternatives are measured on the main
//     box; `parts.ts` keeps part 0's alternatives), and its list is sorted and de-duplicated with the outer
//     edges at its ends; the later parts keep their lines;
//   • `add-line` splits the FIRST row band (in row order, so part 0 first) that holds `at` strictly inside.
// Lines without a row/col id (added, pinned, or set) are edited with `set-lines` on their axis (part 0's full
// boundary list); id-keyed lines with `move-line` / `remove-line` (E-2: ops applied after fusion). An id-less line
// of a later part has no op that can express it, so it is drawn but not editable (only reachable on the stub path).

import { applyOps } from "@/lib/parse-engine/ops";
import {
  ParseEngineNotImplementedError,
  type Axis,
  type BboxMinMax,
  type CorrectionOp,
  type MethodId,
  type ParseAlternative,
  type ParseResult,
  type StructureModel,
  type StructureTableModel,
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
  /** `applyOps` failed for another reason: the base model is shown unchanged (never the local approximation). */
  error?: string;
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
  } catch (e) {
    // Only the WP-2.E stub falls back to the local line preview; any other failure is surfaced (VERIFY F3).
    if (e instanceof ParseEngineNotImplementedError) return { model: result.model, exact: false };
    return { model: result.model, exact: true, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The boxes of a table: part 0 = `bbox`, part k = `parts[k-1]`. */
export function partBoxes(model: StructureTableModel): BboxMinMax[] {
  return [model.bbox, ...(model.parts ?? [])];
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

/** A boundary list as WP-3.D reads it: finite, sorted, de-duplicated; null when it holds fewer than 2 values. */
function cleanBoundaries(at: readonly number[]): number[] | null {
  const xs = [...new Set(at.filter((v) => Number.isFinite(v)).map((v) => Math.round(v * 1e6) / 1e6))].sort((a, b) => a - b);
  return xs.length >= 2 ? xs : null;
}

/** Part 0's interior lines from a boundary list (`rowLines` / `colLines` / `set-lines.at`: edges at both ends). */
function part0Lines(axis: Axis, at: readonly number[], src: LineSource): CanvasLine[] | null {
  const xs = cleanBoundaries(at);
  return xs ? xs.slice(1, -1).map((v) => ({ axis, at: v, after: null, src, part: 0 })) : null;
}

/** Replace part 0's lines on an axis, keeping every later part's lines (WP-3.D `replaceAxis`). */
function replacePart0(lines: readonly CanvasLine[], next: readonly CanvasLine[]): CanvasLine[] {
  return [...next, ...lines.filter((l) => l.part !== 0)];
}

/** The part `add-line` lands in: the first row band (row order, part 0 first) holding `at` (WP-3.D `addLine`). */
function addLinePart(model: StructureTableModel, axis: Axis, at: number): number | null {
  if (axis === "cols") return model.cols.some((c) => at > c.x0 && at < c.x1) ? 0 : null;
  const row = model.rows.find((r) => at > r.y0 && at < r.y1);
  return row ? row.part ?? 0 : null;
}

/** The outer edges of part 0 on an axis in a model: its first and last band, else its box. */
function modelEdges(model: StructureTableModel, axis: Axis): [number, number] {
  if (axis === "cols") return model.cols.length ? [model.cols[0].x0, model.cols[model.cols.length - 1].x1] : [model.bbox[0], model.bbox[2]];
  const rows0 = model.rows.filter((r) => (r.part ?? 0) === 0);
  return rows0.length ? [rows0[0].y0, rows0[rows0.length - 1].y1] : [model.bbox[1], model.bbox[3]];
}

const sortLines = (lines: CanvasLine[]): CanvasLine[] => [...lines].sort((a, b) => a.part - b.part || a.at - b.at);

function altLines(alt: ParseAlternative, axis: Axis): number[] {
  return axis === "rows" ? alt.geometry.rowLines : alt.geometry.colLines;
}

/** Local preview of the line ops (used only while `applyOps` is unavailable). Other ops do not move lines. */
export function applyLineOps(result: ParseResult, ops: readonly CorrectionOp[], axis: Axis): CanvasLine[] {
  const model = result.model;
  if (!isTableModel(model)) return [];
  let lines = modelLines(model, axis);
  for (const op of ops) {
    if (!("axis" in op) || op.axis !== axis) continue;
    switch (op.op) {
      case "pin-source": {
        if (op.method === null) {
          lines = replacePart0(lines, modelLines(model, axis).filter((l) => l.part === 0));
          break;
        }
        const alt = result.alternatives.find((a) => a.method === op.method);
        const next = alt ? part0Lines(axis, altLines(alt, axis), op.method) : null;
        if (next) lines = replacePart0(lines, next);
        break;
      }
      case "set-lines": {
        const next = part0Lines(axis, op.at, "user");
        if (next) lines = replacePart0(lines, next);
        break;
      }
      case "move-line":
        lines = lines.map((l) => (l.after === op.after ? { ...l, at: op.at, src: "user" } : l));
        break;
      case "add-line": {
        const part = addLinePart(model, axis, op.at);
        if (part !== null) lines = [...lines, { axis, at: op.at, after: null, src: "user", part }];
        break;
      }
      case "remove-line":
        lines = lines.filter((l) => l.after !== op.after);
        break;
    }
  }
  return sortLines(lines);
}

/** Part 0's outer edges on an axis after the draft's ops (the ends of `set-lines.at`; the box edges stay put). */
export function axisEdges(result: ParseResult, ops: readonly CorrectionOp[], preview: CanvasPreview, axis: Axis): [number, number] {
  const base = result.model;
  if (!isTableModel(base)) return [0, 1];
  if (preview.exact) return isTableModel(preview.model) ? modelEdges(preview.model, axis) : modelEdges(base, axis);
  let edges = modelEdges(base, axis);
  for (const op of ops) {
    if (op.op !== "pin-source" && op.op !== "set-lines") continue;
    if (op.axis !== axis) continue;
    if (op.op === "pin-source" && op.method === null) { edges = modelEdges(base, axis); continue; }
    const alt = op.op === "pin-source" ? result.alternatives.find((a) => a.method === op.method) : undefined;
    const xs = cleanBoundaries(op.op === "set-lines" ? op.at : alt ? altLines(alt, axis) : []);
    if (xs) edges = [xs[0], xs[xs.length - 1]];
  }
  return edges;
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

/** Can a gesture on this line be expressed as an op? (An id-less line of a later part cannot: `set-lines` is part 0's.) */
export const editableLine = (line: CanvasLine): boolean => line.after !== null || line.part === 0;

/** Part 0's full boundary list for `set-lines`: [edge, ...interior, edge] (`edges` = part 0's outer edges). */
export function boundaries(axis: Axis, lines: readonly CanvasLine[], edges: readonly [number, number]): number[] {
  return [edges[0], ...lines.filter((l) => l.axis === axis && l.part === 0).map((l) => l.at).sort((x, y) => x - y), edges[1]].map(pageUnit);
}

/** The op for dragging `line` to `at` (null when the line is not editable). */
export function moveOp(line: CanvasLine, at: number, lines: readonly CanvasLine[], edges: readonly [number, number]): CorrectionOp | null {
  if (line.after) return { op: "move-line", axis: line.axis, after: line.after, at };
  if (!editableLine(line)) return null;
  return { op: "set-lines", axis: line.axis, at: boundaries(line.axis, lines.map((l) => (l === line ? { ...l, at } : l)), edges) };
}

/** The op for deleting `line` (null when the line is not editable). */
export function removeOp(line: CanvasLine, lines: readonly CanvasLine[], edges: readonly [number, number]): CorrectionOp | null {
  if (line.after) return { op: "remove-line", axis: line.axis, after: line.after };
  if (!editableLine(line)) return null;
  return { op: "set-lines", axis: line.axis, at: boundaries(line.axis, lines.filter((l) => l !== line), edges) };
}

/** Column x of part 0 mapped onto a later part's box by relative position (`parts.ts` mapXToPart). */
export function mapColToPart(x: number, from: BboxMinMax, to: BboxMinMax): number {
  const w = from[2] - from[0];
  return w > 0 ? to[0] + ((x - from[0]) / w) * (to[2] - to[0]) : x;
}
