/**
 * `textract-cells` column method (table pipeline WP-3.B; PLAN §1.4, E-1). Pure, deterministic (E-7).
 *
 * Geometry from a stored (or live-crop) Textract TABLE: column lines, row lines, the cells with their spans
 * (`rowSpan`/`colSpan` / MERGED_CELL, already resolved by the evidence loader: `EngineTextractCell.rs/cs`)
 * and the COLUMN_HEADER flags (`hdr`). No text: cell text is assembled once, by `cells.ts`, from page words.
 *
 * Table choice is the legacy rule (`methodTextractTables`): the table that covers the largest share of the
 * box, at least .3 of the box area. Cells count when their centre lies in the box (closed). Rows and columns
 * are re-indexed to the ones present in the box, so a box over part of a page table gets a dense grid; a span
 * is clipped to the rows / columns present.
 *
 * Lines: Textract cell boxes tile the table, so an inner column line is the median left edge of the cells
 * that START in that column (any span); the outer lines are the median left edge of the first column and the
 * median right edge of the cells ending in the last column. Rows alike. `headerRows` counts the consecutive
 * rows from the top that hold a header-flagged cell. `conf` is the table's cover of the box (0..1).
 */

import type { BboxMinMax, EnginePageEvidence, EngineTextractCell } from "../types";
import type { ColumnHypothesis } from "../types-cols";

export const TEXTRACT_CELLS_COLS_VERSION = 1;
export const TEXTRACT_MIN_COVER = 0.3;

type Table = EnginePageEvidence["textractTables"][number];

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Share of `box`'s area that `t` covers. */
export function tableCover(t: BboxMinMax, box: BboxMinMax): number {
  const w = Math.min(box[2], t[2]) - Math.max(box[0], t[0]);
  const h = Math.min(box[3], t[3]) - Math.max(box[1], t[1]);
  const area = (box[2] - box[0]) * (box[3] - box[1]);
  return w > 0 && h > 0 && area > 0 ? (w * h) / area : 0;
}

/** The table covering the most of `box` (≥ `minCover`), first one on a tie; null when none does. */
export function pickTextractTable(tables: readonly Table[], box: BboxMinMax, minCover = TEXTRACT_MIN_COVER): { index: number; cover: number } | null {
  let index = -1;
  let cover = 0;
  for (let i = 0; i < tables.length; i++) {
    const c = tableCover(tables[i].b, box);
    if (c > cover) { cover = c; index = i; }
  }
  return index >= 0 && cover >= minCover ? { index, cover } : null;
}

/** Lines of one axis from the cells: inner = median start edge per band, last = median end edge of the last band. */
function axisLines(cells: readonly EngineTextractCell[], idx: (c: EngineTextractCell) => number, span: (c: EngineTextractCell) => number, lo: 0 | 1, hi: 2 | 3, n: number): number[] {
  const lines: number[] = [];
  for (let k = 0; k < n; k++) {
    const starts = cells.filter((c) => idx(c) === k).map((c) => c.b[lo]);
    lines.push(starts.length ? median(starts) : NaN);
  }
  const ends = cells.filter((c) => idx(c) + span(c) - 1 === n - 1).map((c) => c.b[hi]);
  lines.push(ends.length ? median(ends) : NaN);
  // A band with no starting cell (fully covered by spans) takes the midpoint of its neighbours; lines stay monotone.
  for (let k = 0; k < lines.length; k++) {
    if (!Number.isFinite(lines[k])) {
      const prev = lines.slice(0, k).reverse().find(Number.isFinite);
      const next = lines.slice(k + 1).find(Number.isFinite);
      lines[k] = prev !== undefined && next !== undefined ? (prev + next) / 2 : (prev ?? next ?? 0);
    }
    if (k > 0) lines[k] = Math.max(lines[k], lines[k - 1]);
  }
  return lines;
}

/** Column (and row) geometry, spans and header rows from the Textract TABLE under `box`. */
export function textractCellsColumns(tables: readonly Table[], box: BboxMinMax): ColumnHypothesis & { tableIndex?: number } {
  const base = { method: "textract-cells" as const, methodVersion: TEXTRACT_CELLS_COLS_VERSION };
  if (!tables.length) return { ...base, conf: 0, colLines: [], error: "no Textract TABLE on this page" };
  const pick = pickTextractTable(tables, box);
  if (!pick) return { ...base, conf: 0, colLines: [], error: `no Textract TABLE covers ≥${TEXTRACT_MIN_COVER} of the box` };
  const inBox = tables[pick.index].cells.filter((c) => {
    const cx = (c.b[0] + c.b[2]) / 2;
    const cy = (c.b[1] + c.b[3]) / 2;
    return cx >= box[0] && cx <= box[2] && cy >= box[1] && cy <= box[3];
  });
  if (!inBox.length) return { ...base, conf: 0, colLines: [], error: "the Textract TABLE has no cell centred in the box", tableIndex: pick.index };
  const rowsPresent = [...new Set(inBox.map((c) => c.r))].sort((a, b) => a - b);
  const colsPresent = [...new Set(inBox.map((c) => c.c))].sort((a, b) => a - b);
  const rowAt = new Map(rowsPresent.map((r, i) => [r, i]));
  const colAt = new Map(colsPresent.map((c, i) => [c, i]));
  const clip = (start: number, span: number, present: readonly number[]): number => Math.max(1, present.filter((v) => v >= start && v < start + span).length);
  const cells = inBox
    .map((c) => ({ ...c, r: rowAt.get(c.r)!, c: colAt.get(c.c)!, rs: clip(c.r, c.rs, rowsPresent), cs: clip(c.c, c.cs, colsPresent) }))
    .sort((a, b) => a.r - b.r || a.c - b.c);
  const colLines = axisLines(cells, (c) => c.c, (c) => c.cs, 0, 2, colsPresent.length);
  const rowLines = axisLines(cells, (c) => c.r, (c) => c.rs, 1, 3, rowsPresent.length);
  let headerRows = 0;
  while (headerRows < rowsPresent.length && cells.some((c) => c.r === headerRows && c.hdr)) headerRows++;
  return {
    ...base,
    conf: Math.round(Math.min(1, pick.cover) * 1000) / 1000,
    colLines,
    rowLines,
    headerRows,
    cells: cells.map((c) => ({ r: c.r, c: c.c, rs: c.rs, cs: c.cs, b: [...c.b] as BboxMinMax, ...(c.hdr ? { header: true as const } : {}) })),
    tableIndex: pick.index,
  };
}
