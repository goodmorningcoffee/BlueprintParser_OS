/**
 * parse-engine/shapes.ts — ONE fused tag-shape set (table pipeline WP-3.A; PLAN §1.4 R2, R10).
 *
 * The page evidence lists yolo_primitive shapes and classical `pages.keynotes` shapes separately (WP-2.E).
 * The classifier's `bestShapeColumn` picks one source or the other (`shape-column.ts:125`, MEASURED); the
 * engine instead reads both as one set:
 *
 * - **R10 fuse.** Shapes of a tag class whose centre lies inside the box; a yolo/classical pair at IoU ≥ .5
 *   is one shape. The kept box is yolo's (the live detector box) unless only classical saw it; a kept shape
 *   without inside text takes its twin's crop read. In-table shapes are kept (no either/or, no left-share
 *   limit: R9 lets the tag column sit anywhere, so the engine does not apply `eligible()`'s `.25`).
 *   Oversized rectangles/squares are table cells, not tags (the same cap as `shape-column.ts`).
 * - **Column.** The largest cluster of fused shapes whose x-centres lie within 0.5 × the median shape width
 *   (the `findShapeColumn` rule, without the source split), same-row doubles collapsed, with ≥ `minShapes`
 *   members, sorted top to bottom.
 * - **R2 regime test** (`shapeRegimeHolds`): ≥ 3 shapes in one column AND the column's y-span covers ≥ 60 %
 *   of the body word lines (the lines below the header bottom).
 *
 * Pure and deterministic (E-7). Imports `./geometry`, `./types-rows` and `region-classifier-v2/geometry`
 * (iou). `COLUMN_SHAPE_LABELS` is repeated here rather than imported from `classifier-engine/shape-column`,
 * which imports `rows/shape-centres` (a cycle otherwise); a test asserts the two sets are equal.
 */

import { iou } from "@/lib/region-classifier-v2/geometry";
import { centreIn } from "./geometry";
import { midpointBands } from "./rows/shape-centres";
import type { BboxMinMax, EngineShape } from "./types";
import type { FusedShape, FusedShapeColumn, RowsInput } from "./types-rows";

/** yolo_primitive / classical classes a tag column may be made of (= `shape-column.ts` COLUMN_SHAPE_LABELS). */
export const ENGINE_COLUMN_SHAPE_LABELS: ReadonlySet<string> = new Set([
  "circle", "hexagon", "diamond", "square", "triangle", "arch_sheet_circle", "oval", "pill", "rectangle", "dot_small_circle",
]);
/** A rectangle/square with a longer side than this is a table cell (shape-ensemble families.ts: 250 px on 10,800 × 7,200). */
const MAX_RECT_SIDE = { x: 250 / 10800, y: 250 / 7200 };
/** Two detections of one shape collapse at this IoU (R10). */
export const SHAPE_DEDUPE_IOU = 0.5;
export const DEFAULT_MIN_COLUMN_SHAPES = 3;
/** R2: the column must cover this share of the body word lines. */
export const SHAPE_REGIME_MIN_COVER = 0.6;

const cx = (b: BboxMinMax): number => (b[0] + b[2]) / 2;
const cy = (b: BboxMinMax): number => (b[1] + b[3]) / 2;
const width = (b: BboxMinMax): number => b[2] - b[0];
const height = (b: BboxMinMax): number => b[3] - b[1];
const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const isTag = (s: EngineShape): boolean =>
  ENGINE_COLUMN_SHAPE_LABELS.has(s.cls) &&
  !((s.cls === "rectangle" || s.cls === "square") && (width(s.b) > MAX_RECT_SIDE.x || height(s.b) > MAX_RECT_SIDE.y));

/** Deterministic order: y-centre, then x-centre, then input index. */
const byPosition = (a: { b: BboxMinMax; i: number }, b: { b: BboxMinMax; i: number }): number =>
  cy(a.b) - cy(b.b) || cx(a.b) - cx(b.b) || a.i - b.i;

/**
 * R10: the fused tag shapes whose centre lies inside `box`, top to bottom. yolo and classical twins at
 * IoU ≥ .5 become one shape (yolo's box; a missing inside text takes the twin's read). A `rectangle` / `square`
 * that coincides with a stored Textract CELL (IoU ≥ .5, `cellBoxes`) is a table cell, not a tag: measured on the
 * private G-TAB gold, the cells of ruled tables formed "shape columns" of 5–26 rectangles that put no-shape
 * tables into the shape regime (WP-3.A).
 */
export function fuseShapes(shapes: readonly EngineShape[], box: BboxMinMax, cellBoxes: readonly BboxMinMax[] = []): FusedShape[] {
  const isCell = (s: EngineShape): boolean => (s.cls === "rectangle" || s.cls === "square") && cellBoxes.some((c) => iou(c, s.b) >= SHAPE_DEDUPE_IOU);
  const inBox = shapes.map((s, i) => ({ s, i })).filter(({ s }) => isTag(s) && centreIn(s.b, box) && !isCell(s));
  const yolo = inBox.filter(({ s }) => s.src === "yolo").map(({ s, i }) => ({ b: s.b, i, s })).sort(byPosition);
  const classical = inBox.filter(({ s }) => s.src === "classical").map(({ s, i }) => ({ b: s.b, i, s })).sort(byPosition);
  // yolo double-fires (circle + arch_sheet_circle on one bubble) collapse first: the earlier (input order) stays.
  const keptYolo: { b: BboxMinMax; i: number; s: EngineShape }[] = [];
  for (const y of yolo) if (!keptYolo.some((k) => iou(k.b, y.b) >= SHAPE_DEDUPE_IOU)) keptYolo.push(y);
  const out: FusedShape[] = keptYolo.map(({ s }) => ({ b: s.b, cls: s.cls, src: "yolo", both: false, text: s.text, textSrc: s.textSrc }));
  for (const c of classical) {
    const twin = keptYolo.findIndex((k) => iou(k.b, c.b) >= SHAPE_DEDUPE_IOU);
    if (twin === -1) {
      if (out.some((o) => o.src === "classical" && iou(o.b, c.b) >= SHAPE_DEDUPE_IOU)) continue; // a classical double
      out.push({ b: c.s.b, cls: c.s.cls, src: "classical", both: false, text: c.s.text, textSrc: c.s.textSrc });
      continue;
    }
    const kept = out[twin];
    kept.both = true;
    if (kept.text === null && c.s.text !== null) { kept.text = c.s.text; kept.textSrc = c.s.textSrc; }
  }
  return out.sort((a, b) => cy(a.b) - cy(b.b) || cx(a.b) - cx(b.b));
}

/**
 * The largest column of fused shapes (x-centres within 0.5 × the median shape width), top to bottom, or null
 * below `minShapes`. Ties between clusters of one size go to the left-most (the classifier's left-column prior
 * as a tie-break only).
 */
export function fusedShapeColumn(shapes: readonly FusedShape[], minShapes = DEFAULT_MIN_COLUMN_SHAPES): FusedShapeColumn | null {
  if (shapes.length < Math.max(1, minShapes)) return null;
  const mw = Math.max(median(shapes.map((s) => width(s.b))), 1e-6);
  const tol = 0.5 * mw;
  const byX = [...shapes].sort((a, b) => cx(a.b) - cx(b.b) || cy(a.b) - cy(b.b));
  const groups: FusedShape[][] = [];
  let cur: FusedShape[] = [];
  for (const s of byX) {
    if (cur.length > 0 && cx(s.b) - median(cur.map((c) => cx(c.b))) > tol) { groups.push(cur); cur = []; }
    cur.push(s);
  }
  if (cur.length > 0) groups.push(cur);
  const best = groups.reduce((a, g) => (g.length > a.length ? g : a), groups[0]);
  // Same-row doubles (a loose and a tight detection of one bubble at IoU < .5, or two classes on one shape): centres
  // closer than half the median shape height are one row anchor; the first in (y, x) order stays.
  const mh = Math.max(median(best.map((s) => height(s.b))), 1e-6);
  const col: FusedShape[] = [];
  for (const s of [...best].sort((a, b) => cy(a.b) - cy(b.b) || cx(a.b) - cx(b.b))) {
    const prev = col[col.length - 1];
    if (prev && cy(s.b) - cy(prev.b) < 0.5 * mh) continue;
    col.push(s);
  }
  if (col.length < Math.max(1, minShapes)) return null;
  const gaps = col.slice(1).map((s, i) => cy(s.b) - cy(col[i].b));
  const counts = new Map<string, number>();
  for (const s of col) counts.set(s.cls, (counts.get(s.cls) ?? 0) + 1);
  const shapeClass = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
  let gapCv: number | null = null;
  if (gaps.length >= 2) {
    const m = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    gapCv = m > 0 ? Math.sqrt(gaps.reduce((a, g) => a + (g - m) ** 2, 0) / gaps.length) / m : null;
  }
  return {
    shapes: col,
    shapeClass,
    x0: Math.min(...col.map((s) => s.b[0])),
    x1: Math.max(...col.map((s) => s.b[2])),
    pitch: gaps.length > 0 ? median(gaps) : null,
    gapCv,
  };
}

/**
 * R2: the shape regime holds when the column has ≥ 3 shapes and its y-span covers ≥ 60 % of the body lines
 * (the lines whose centre lies below `headerBottom`; every line when null). The span is the extent of the
 * midpoint bands the shapes imply (`rows/shape-centres.midpointBands` over the box words): half the first
 * centre gap above the first centre down through the last row's contiguous run of lines, because a description
 * centred on its shape has lines outside the shape's own box and a tall last row has trailing lines (K13).
 * A box with no body line is not in the regime.
 */
export function shapeRegimeHolds(col: FusedShapeColumn | null, input: Pick<RowsInput, "box" | "words" | "lines">, headerBottom: number | null): boolean {
  if (!col || col.shapes.length < 3) return false;
  const body = input.lines.filter((l) => headerBottom === null || cy(l.b) > headerBottom);
  if (body.length === 0) return false;
  const bands = midpointBands(col.shapes.map((s) => s.b), input.box, input.words.map((w) => w.b));
  const top = Math.min(...bands.map((b) => b[1]));
  const bottom = Math.max(...bands.map((b) => b[3]));
  const covered = body.filter((l) => cy(l.b) >= top && cy(l.b) <= bottom).length;
  return covered / body.length >= SHAPE_REGIME_MIN_COVER;
}
