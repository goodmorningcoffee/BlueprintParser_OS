/**
 * `x-starts` column method (table pipeline WP-3.B; PLAN §1.4; R7 column tolerance). Pure, deterministic (E-7).
 *
 * Columns from where cells START. Two modes (`XStartsMode`):
 *
 * - `legacy` reproduces ocr-positions' left-edge finder exactly (`lib/services/table-parse.ts`
 *   `methodOcrPositions`): the words whose centre is in the box; a row chain at y-tol .006 (only its count is
 *   used, for the hit floor); EVERY word's left edge, sorted, split where two neighbours differ by more than
 *   .015 (page-normalised); a cluster is stable with ≥ max(2, ⌊rows × .3⌋) lefts (else every cluster, when
 *   fewer than 2 are stable); column lines = [max(0, x0 − .005), midpoints of the cluster means,
 *   min(1, rightmost word + .005)]. Same failures (< 6 words, < 3 rows, < 2 clusters).
 *   The fixed page gap smears a narrow table into one column (K16-adjacent, LabelFactory audit).
 *
 * - `table-relative` (the LabelFactory port): the gap is `tableRelativeGap(W) = max(.003, .013 × W)`, W the
 *   width of the box's text. Only CELL-START words vote: inside each visual line (`lines.ts`), a word whose
 *   left edge is within max(gap, .75 × median word height) of the previous word's right edge continues that
 *   cell (word spacing scales with the text, gutters with the table). Cell lefts cluster
 *   (chain, gap); a cluster is stable with ≥ max(2, ⌊lines × .3⌋) cells. Cells in no stable left cluster
 *   try their centres (centre-aligned columns), then their rights (right-aligned numbers), with the same
 *   rule. A sparse column (≥ 2 cells, below the floor) is kept when its cells come no closer than the gap to
 *   any stable column, and so is a lone cell in the top 3 lines (a header over an empty column).
 *   Each line between two columns is put in the GUTTER: midway between the right edge of the left column's
 *   cells and the left edge of the right column's cells (or just left of the right column when a cell
 *   bleeds across). The outer lines are the box edges.
 *
 * Output: a `ColumnHypothesis` (n + 1 lines, outer edges included; see `types-cols.ts`). Fusion (R7,
 * `fuse.ts`, WP-3.A) clusters column boundaries within `tableRelativeGap`, exported here for that.
 */

import { centreIn } from "../geometry";
import { wordsToLines } from "../lines";
import type { BboxMinMax } from "../types";
import type { ColWord, ColumnHypothesis, XStartsMode } from "../types-cols";

export const X_STARTS_VERSION = 1;
/** ocr-positions constants (legacy mode). */
export const LEGACY_MIN_COL_GAP = 0.015;
export const LEGACY_ROW_Y_TOL = 0.006;
export const COL_HIT_RATIO = 0.3;
const LEGACY_EDGE_PAD = 0.005;
/** A word continues a cell when its gap to the previous word is within this many median word heights (or the column gap). */
export const CELL_JOIN_H = 0.75;
/** A lone cell in this many top lines that overlaps no column is a header over an empty column. */
export const HEADER_ONLY_LINES = 3;

/** The table-relative column gap (LabelFactory `grid.py`): `max(.003, .013 × width)`. */
export function tableRelativeGap(width: number): number {
  return Math.max(0.003, 0.013 * (Number.isFinite(width) && width > 0 ? width : 0));
}

export interface XStartsOptions {
  /** Default `table-relative`. */
  mode?: XStartsMode;
  /** Override the gap (legacy default .015; table-relative default `tableRelativeGap(W)`). */
  minColGap?: number;
  /** Hit floor ratio. Default .3. */
  colHitRatio?: number;
}

const fail = (error: string, extra: Partial<ColumnHypothesis> = {}): ColumnHypothesis =>
  ({ method: "x-starts", methodVersion: X_STARTS_VERSION, conf: 0, colLines: [], error, ...extra });

const finite = (b: readonly number[]): boolean => b.length === 4 && b.every((v) => Number.isFinite(v));

/** Chain clusters over sorted values: a new cluster starts where a value exceeds the previous one by more than `gap`. */
function chain(values: readonly number[], gap: number): number[][] {
  const out: number[][] = [];
  for (const v of values) {
    const cur = out[out.length - 1];
    if (cur && v - cur[cur.length - 1] <= gap) cur.push(v);
    else out.push([v]);
  }
  return out;
}

const mean = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;

// ─── legacy (ocr-positions parity) ─────────────────────────────────────────────────────────────────

function legacyColumns(words: readonly ColWord[], box: BboxMinMax, opts: XStartsOptions): ColumnHypothesis {
  const gap = opts.minColGap ?? LEGACY_MIN_COL_GAP;
  const ratio = opts.colHitRatio ?? COL_HIT_RATIO;
  const [rMinX, rMinY, rMaxX, rMaxY] = box;
  // Same predicate and centre arithmetic as ocr-positions on LTWH: cx = left + width / 2.
  const inBox = words.filter((w) => {
    const cx = w.b[0] + (w.b[2] - w.b[0]) / 2;
    const cy = w.b[1] + (w.b[3] - w.b[1]) / 2;
    return cx >= rMinX && cx <= rMaxX && cy >= rMinY && cy <= rMaxY;
  });
  if (inBox.length < 6) return fail(`too few words in region: ${inBox.length} (need ≥6)`);
  const yc = (w: ColWord): number => w.b[1] + (w.b[3] - w.b[1]) / 2;
  const sorted = [...inBox].sort((a, b) => yc(a) - yc(b));
  let rows = 1;
  let curY = yc(sorted[0]);
  for (let i = 1; i < sorted.length; i++) {
    const y = yc(sorted[i]);
    if (Math.abs(y - curY) > LEGACY_ROW_Y_TOL) { rows++; curY = y; }
  }
  if (rows < 3) return fail(`too few row clusters: ${rows} (need ≥3)`);
  const clusters = chain(inBox.map((w) => w.b[0]).sort((a, b) => a - b), gap);
  const minHits = Math.max(2, Math.floor(rows * ratio));
  let stable = clusters.filter((c) => c.length >= minHits);
  if (stable.length < 2) stable = clusters.length >= 2 ? clusters : [];
  if (stable.length < 2) return fail(`no stable column clusters detected (need ≥2 with ≥${minHits} hits each)`);
  const centres = stable.map(mean).sort((a, b) => a - b);
  const maxRight = Math.max(...inBox.map((w) => w.b[2]));
  const lines = [Math.max(0, rMinX - LEGACY_EDGE_PAD)];
  centres.forEach((c, i) => lines.push(Math.min(1, i === centres.length - 1 ? maxRight + LEGACY_EDGE_PAD : (c + centres[i + 1]) / 2)));
  return { method: "x-starts", methodVersion: X_STARTS_VERSION, conf: Math.min(0.85, 0.3 + 0.1 * stable.length), colLines: lines };
}

// ─── table-relative ────────────────────────────────────────────────────────────────────────────────

interface Cell { x0: number; x1: number; line: number }
interface Column { cells: Cell[]; x0: number; x1: number }

/** The cells of each visual line: a word within `gap` of the previous word's right edge continues the cell. */
function cellsOf(words: readonly ColWord[], gap: number): { cells: Cell[]; lines: number } {
  const lines = wordsToLines(words.map((w) => ({ t: w.t, b: w.b })));
  const cells: Cell[] = [];
  lines.forEach((line, li) => {
    let cur: Cell | null = null;
    for (const i of line.wordIdx) {
      const b = words[i].b;
      if (cur && b[0] - cur.x1 <= gap) cur.x1 = Math.max(cur.x1, b[2]);
      else { cur = { x0: b[0], x1: b[2], line: li }; cells.push(cur); }
    }
  });
  return { cells, lines: lines.length };
}

/**
 * A column of cells. Its extent for the overlap tests is [leftmost cell start, 3rd-quartile cell end], so one
 * cell bleeding across a gutter does not make the column swallow its neighbour.
 */
function columnOf(cells: Cell[]): Column {
  const rights = cells.map((c) => c.x1).sort((a, b) => a - b);
  return { cells, x0: Math.min(...cells.map((c) => c.x0)), x1: rights[Math.min(rights.length - 1, Math.floor(rights.length * 0.75))] };
}

const anchorOf = { left: (c: Cell) => c.x0, centre: (c: Cell) => (c.x0 + c.x1) / 2, right: (c: Cell) => c.x1 } as const;

/** Stable clusters of `cells` by one anchor; returns the columns found and the cells left over. */
function clusterBy(cells: readonly Cell[], anchor: (c: Cell) => number, gap: number, minHits: number): { cols: Column[]; rest: Cell[]; weak: Cell[][] } {
  const order = [...cells].sort((a, b) => anchor(a) - anchor(b) || a.x0 - b.x0 || a.line - b.line);
  const groups: Cell[][] = [];
  for (const c of order) {
    const g = groups[groups.length - 1];
    if (g && anchor(c) - anchor(g[g.length - 1]) <= gap) g.push(c);
    else groups.push([c]);
  }
  const cols: Column[] = [];
  const rest: Cell[] = [];
  const weak: Cell[][] = [];
  for (const g of groups) {
    if (g.length >= minHits) cols.push(columnOf(g));
    else { rest.push(...g); if (g.length >= 2) weak.push(g); }
  }
  return { cols, rest, weak };
}

/** Two x-extents overlap (open intervals), or come within `tol` of each other. */
const overlaps = (a: { x0: number; x1: number }, b: { x0: number; x1: number }, tol = 0): boolean => a.x0 < b.x1 + tol && b.x0 < a.x1 + tol;

function tableRelativeColumns(words: readonly ColWord[], box: BboxMinMax, opts: XStartsOptions): ColumnHypothesis {
  const inBox = words.filter((w) => finite(w.b) && centreIn(w.b, box));
  if (inBox.length < 2) return fail(`too few words in region: ${inBox.length} (need ≥2)`);
  const textX0 = Math.min(...inBox.map((w) => w.b[0]));
  const textX1 = Math.max(...inBox.map((w) => w.b[2]));
  const gap = opts.minColGap ?? tableRelativeGap(textX1 - textX0);
  // Word spacing scales with the TEXT, not the table: a word continues its cell within the column gap or
  // CELL_JOIN_H line heights, whichever is wider (a wide-set font would otherwise split every cell).
  const hs = inBox.map((w) => w.b[3] - w.b[1]).sort((a, b) => a - b);
  const joinGap = Math.max(gap, CELL_JOIN_H * hs[Math.floor(hs.length / 2)]);
  const { cells, lines } = cellsOf(inBox, joinGap);
  if (lines < 2) return fail(`too few lines: ${lines} (need ≥2)`);
  const minHits = Math.max(2, Math.floor(lines * (opts.colHitRatio ?? COL_HIT_RATIO)));

  const byLeft = clusterBy(cells, anchorOf.left, gap, minHits);
  const cols: Column[] = [...byLeft.cols];
  let rest = byLeft.rest;
  for (const a of [anchorOf.centre, anchorOf.right]) {
    const next = clusterBy(rest, a, gap, minHits);
    const left: Cell[] = [...next.rest];
    for (const col of next.cols) {
      if (cols.some((c) => overlaps(c, col))) left.push(...col.cells);
      else cols.push(col);
    }
    rest = left;
  }
  // Sparse columns: a weak left cluster (≥ 2 cells) whose cells overlap no stable column; and a lone cell in the
  // top HEADER_ONLY_LINES lines that overlaps no column (a header over an empty column, e.g. a blank REMARKS).
  const sparse = clusterBy(rest, anchorOf.left, gap, Number.POSITIVE_INFINITY);
  for (const g of sparse.weak) {
    const col = columnOf(g);
    if (!cols.some((c) => overlaps(c, col, gap))) cols.push(col);
  }
  for (const c of sparse.rest) {
    if (c.line >= HEADER_ONLY_LINES) continue;
    const col = columnOf([c]);
    if (!cols.some((k) => overlaps(k, col, gap))) cols.push(col);
  }
  if (cols.length === 0) return fail("no column clusters");
  cols.sort((a, b) => a.x0 - b.x0 || a.x1 - b.x1);

  const colLines = [box[0]];
  for (let k = 0; k + 1 < cols.length; k++) {
    const nextX0 = cols[k + 1].x0;
    const ends = cols[k].cells.filter((c) => c.x1 <= nextX0).map((c) => c.x1);
    const right = ends.length ? Math.max(...ends) : null;
    const line = right !== null && right < nextX0 ? (right + nextX0) / 2 : nextX0 - Math.min(0.002, gap / 2);
    colLines.push(Math.max(colLines[colLines.length - 1], line));
  }
  colLines.push(Math.max(colLines[colLines.length - 1], box[2]));
  const covered = cols.reduce((s, c) => s + c.cells.length, 0) / Math.max(1, cells.length);
  return {
    method: "x-starts", methodVersion: X_STARTS_VERSION,
    conf: Math.round(Math.min(0.85, 0.35 + 0.5 * covered) * 1000) / 1000,
    colLines,
  };
}

/** Column lines from cell-start x positions (see the file header for both modes). */
export function xStartColumns(words: readonly ColWord[], box: BboxMinMax, opts: XStartsOptions = {}): ColumnHypothesis {
  if (!finite(box) || box[2] <= box[0] || box[3] <= box[1]) return fail("invalid box");
  return (opts.mode ?? "table-relative") === "legacy" ? legacyColumns(words, box, opts) : tableRelativeColumns(words, box, opts);
}
