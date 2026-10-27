/**
 * classifier-engine/shape-column.ts — the shape-tag COLUMN rule (owner, 2026-10-25; plan
 * gitignore/projects/classifier_builder/shape_tags/PLAN.md §2.1 / §2.3): a vertical run of tag shapes in
 * the left part of a box whose x-centres line up, each shape anchoring one table row — the tag text is
 * the OCR inside the shape, the meaning is the OCR to its right. Measured on 733 labelled boxes
 * (shape_tags/out/REPORT.md): yolo_primitive columns mark LEGENDS (29/80), classical rectangles mark
 * schedules (45/378); 97 % of column rows have text to the right, the shape centre sits within .18 word
 * heights of its row's text. Pure and client-safe; used by the engine's `shape-column` signal and tag
 * map, and by the shape-centre row builder (src/lib/services/table-rows-shapes.ts).
 */

import type { BboxMinMax } from "@/types";
import { center, inside, iou } from "@/lib/region-classifier-v2/geometry";
import { shapeRowBands } from "@/lib/parse-engine/rows/shape-centres";
import { TAG_MAP_ROW_CAP, type ProposalTagMap, type ProposalTagRow } from "./types";

export type ShapeSource = "yolo" | "classical";

/** One shape as either detector yields it (normalized MinMax bbox). */
export interface ColumnShape {
  label: string;
  bbox: BboxMinMax;
  source: ShapeSource;
  confidence: number;
  /** The classical arm's per-crop read, when it has one. */
  text?: string;
}

/** A word as the engine holds it (evidence.ts EvWord, or anything with these fields). */
export interface ColumnWord { text: string; bbox: BboxMinMax; c: readonly [number, number]; h: number }

export interface ShapeColumnOptions {
  /** The shape centre must lie in the left `leftShare` of the box (owner: "often column A"; measured .25). */
  leftShare?: number;
  minShapes?: number;
  /** Rectangles / squares with a longer side than this page fraction are table cells, not tags (shape-ensemble families.ts: 250 px on a 10,800 × 7,200 sheet). */
  maxRectSide?: { x: number; y: number };
}

export interface ShapeColumn {
  source: ShapeSource;
  /** Majority class of the column. */
  shapeClass: string;
  n: number;
  /** Column shapes, top to bottom. */
  shapes: ColumnShape[];
  /** Coefficient of variation of the vertical centre gaps (null below 3 shapes). */
  gapCv: number | null;
  /** Median vertical centre gap (null below 2 shapes). */
  pitch: number | null;
  /** Spread of the x-centres over the median shape width. */
  xSpread: number;
  /** Right edge of the column (max shape maxX): words right of it are the row's text. */
  right: number;
}

/** yolo_primitive / classical classes a column may be made of (region v2 LEGEND_SHAPES). */
export const COLUMN_SHAPE_LABELS: ReadonlySet<string> = new Set(["circle", "hexagon", "diamond", "square", "triangle", "arch_sheet_circle", "oval", "pill", "rectangle", "dot_small_circle"]);
export const DEFAULT_LEFT_SHARE = 0.25;
export const DEFAULT_MIN_SHAPES = 3;
const DEFAULT_RECT_SIDE = { x: 250 / 10800, y: 250 / 7200 };
/** Two detections of one bubble (circle + arch_sheet_circle) collapse at this IoU; the more confident stays. */
const DOUBLE_FIRE_IOU = 0.5;

const median = (xs: readonly number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const cv = (xs: readonly number[]): number | null => {
  if (xs.length < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (!(m > 0)) return null;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length) / m;
};
const cx = (s: ColumnShape): number => (s.bbox[0] + s.bbox[2]) / 2;
const cy = (s: ColumnShape): number => (s.bbox[1] + s.bbox[3]) / 2;
const width = (s: ColumnShape): number => s.bbox[2] - s.bbox[0];
const height = (s: ColumnShape): number => s.bbox[3] - s.bbox[1];

/** The shapes of one source that can sit in a column of `box`: centre inside, a tag class, rectangles capped. */
function eligible(shapes: readonly ColumnShape[], box: BboxMinMax, source: ShapeSource, opts: ShapeColumnOptions): ColumnShape[] {
  const left = box[0] + (opts.leftShare ?? DEFAULT_LEFT_SHARE) * (box[2] - box[0]);
  const cap = opts.maxRectSide ?? DEFAULT_RECT_SIDE;
  return shapes.filter((s) => s.source === source && COLUMN_SHAPE_LABELS.has(s.label) && inside(center(s.bbox), box) && cx(s) <= left
    && !((s.label === "rectangle" || s.label === "square") && (width(s) > cap.x || height(s) > cap.y)));
}

/** The column of one source, or null. Rule: x-centre clusters within .5 × median width, the largest kept, double-fires dropped. */
export function findShapeColumn(shapes: readonly ColumnShape[], box: BboxMinMax, source: ShapeSource, opts: ShapeColumnOptions = {}): ShapeColumn | null {
  const minShapes = Math.max(1, opts.minShapes ?? DEFAULT_MIN_SHAPES);
  const left = eligible(shapes, box, source, opts);
  if (left.length < minShapes) return null;
  const mw = Math.max(median(left.map(width)), 1e-6);
  const tol = 0.5 * mw;
  left.sort((a, b) => cx(a) - cx(b));
  const groups: ColumnShape[][] = [];
  let cur: ColumnShape[] = [];
  for (const s of left) {
    if (cur.length && cx(s) - median(cur.map(cx)) > tol) { groups.push(cur); cur = []; }
    cur.push(s);
  }
  if (cur.length) groups.push(cur);
  const best = groups.reduce((a, g) => (g.length > a.length ? g : a), groups[0]);
  const kept: ColumnShape[] = [];
  for (const s of [...best].sort((a, b) => b.confidence - a.confidence)) {
    if (!kept.some((k) => iou(k.bbox, s.bbox) >= DOUBLE_FIRE_IOU)) kept.push(s);
  }
  if (kept.length < minShapes) return null;
  kept.sort((a, b) => cy(a) - cy(b));
  const gaps = kept.slice(1).map((s, i) => cy(s) - cy(kept[i]));
  const counts = new Map<string, number>();
  for (const s of kept) counts.set(s.label, (counts.get(s.label) ?? 0) + 1);
  const shapeClass = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
  const xs = kept.map(cx);
  return {
    source, shapeClass, n: kept.length, shapes: kept,
    gapCv: gaps.length >= 2 ? cv(gaps) : null,
    pitch: gaps.length ? median(gaps) : null,
    xSpread: (Math.max(...xs) - Math.min(...xs)) / mw,
    right: Math.max(...kept.map((s) => s.bbox[2])),
  };
}

/** The better column of the two sources: more shapes wins, ties go to classical (it carries a crop read). Null when neither. */
export function bestShapeColumn(shapes: readonly ColumnShape[], box: BboxMinMax, source: ShapeSource | "any", opts: ShapeColumnOptions = {}): ShapeColumn | null {
  if (source !== "any") return findShapeColumn(shapes, box, source, opts);
  const y = findShapeColumn(shapes, box, "yolo", opts);
  const c = findShapeColumn(shapes, box, "classical", opts);
  if (!y) return c;
  if (!c) return y;
  return y.n > c.n ? y : c;
}

/** The band of one shape: the box's width, the shape's centre ± half its height. */
export const rowBand = (s: ColumnShape, box: BboxMinMax): BboxMinMax => [box[0], Math.max(box[1], cy(s) - 0.5 * height(s)), box[2], Math.min(box[3], cy(s) + 0.5 * height(s))];

/** OCR words whose centre lies inside the shape, left to right. */
export const wordsInside = (s: ColumnShape, words: readonly ColumnWord[]): ColumnWord[] =>
  words.filter((w) => inside(w.c, s.bbox)).sort((a, b) => a.bbox[0] - b.bbox[0]);

/** OCR words right of the shape on its band (centre within half the shape height). */
export const wordsRight = (s: ColumnShape, words: readonly ColumnWord[]): ColumnWord[] =>
  words.filter((w) => w.c[0] > s.bbox[2] && Math.abs(w.c[1] - cy(s)) <= 0.5 * height(s));

/** Shares of column shapes with a word inside / with text to the right (the `textInside` / `textRight` measures). */
export function columnTextShares(col: ShapeColumn, words: readonly ColumnWord[]): { textInside: number; textRight: number } {
  let ins = 0;
  let right = 0;
  for (const s of col.shapes) {
    if (wordsInside(s, words).length) ins++;
    if (wordsRight(s, words).length) right++;
  }
  return { textInside: ins / col.n, textRight: right / col.n };
}

/**
 * Row bands for a row builder, one per column shape. [table pipeline WP-2.C, K13] Delegates to
 * parse-engine/rows/shape-centres.ts `shapeRowBands` (PLAN R3): row i spans from the midpoint of the shape
 * centres above it to the midpoint below, so a description centred on its shape stays in its row, unless the
 * description lines show a top-aligned column (wrapped notes beside their bubble's first line), which keeps
 * the shape-top cuts. Continuation lines without a shape stay in their row (measured: 29 % of legend tag
 * bands span ≥ 2 OCR rows). The last band runs down to the last word inside the box (`words`), so a tall last
 * row keeps its trailing lines. Words above the first band are the header.
 */
export function rowBands(col: ShapeColumn, box: BboxMinMax, words: readonly ColumnWord[] = []): BboxMinMax[] {
  return shapeRowBands(col.shapes.map((s) => s.bbox), box, words.map((w) => w.bbox)).bands;
}

const clean = (t: string): string => t.replace(/\s+/g, " ").trim();
/** [fix round] A stored row's text is capped (the longest on the corpus was 2,092 characters; the page record holds every row). */
export const TAG_ROW_TEXT_CAP = 300;
const capText = (t: string): string => (t.length > TAG_ROW_TEXT_CAP ? `${t.slice(0, TAG_ROW_TEXT_CAP - 1)}…` : t);

/** The tag text of one shape: Textract word(s) inside, else the classical crop read, else null. */
export function tagTextOf(s: ColumnShape, words: readonly ColumnWord[]): string | null {
  const ins = clean(wordsInside(s, words).map((w) => w.text).join(" "));
  if (ins) return ins;
  const crop = clean(s.text ?? "");
  return crop || null;
}

/** The proposal's tag map for a box, or undefined when no column (either source) is found. */
export function buildTagMap(shapes: readonly ColumnShape[], words: readonly ColumnWord[], box: BboxMinMax, opts: ShapeColumnOptions = {}): ProposalTagMap | undefined {
  const col = bestShapeColumn(shapes, box, "any", opts);
  if (!col) return undefined;
  const bands = rowBands(col, box, words);
  const rightWords = words.filter((w) => w.c[0] > col.right);
  const rows: ProposalTagRow[] = col.shapes.slice(0, TAG_MAP_ROW_CAP).map((s, i) => {
    const band = bands[i];
    const inRow = rightWords.filter((w) => w.c[1] >= band[1] && w.c[1] < band[3]).sort((a, b) => a.c[1] - b.c[1] || a.bbox[0] - b.bbox[0]);
    return { tag: tagTextOf(s, words), shapeClass: s.label, shapeBbox: s.bbox, rowBbox: band, rowText: capText(clean(inRow.map((w) => w.text).join(" "))) };
  });
  const { textInside } = columnTextShares(col, words);
  return {
    column: { source: col.source, shapeClass: col.shapeClass, n: col.n, gapCv: col.gapCv === null ? null : Math.round(col.gapCv * 1000) / 1000, textInside: Math.round(textInside * 1000) / 1000 },
    rows, truncated: col.n > TAG_MAP_ROW_CAP,
  };
}
