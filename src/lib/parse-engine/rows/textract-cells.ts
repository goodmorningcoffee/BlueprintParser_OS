/**
 * rows/textract-cells.ts — row boundaries from stored Textract TABLES (table pipeline WP-3.A; PLAN §1.4
 * `textract-cells`, instant budget on stored evidence).
 *
 * The page evidence carries each Textract table's cells with 0-based `r`/`c`, MERGED_CELL spans applied to
 * the anchor cell (WP-2.E) and `hdr` on COLUMN_HEADER cells. For a box:
 * - the table that coincides with the box (containment = intersection / smaller area, the same rule as
 *   `classifier-engine/signals.ts` `textractSignal`) at ≥ .5 is read; the best containment wins;
 * - a row's extent is the union of its unspanned cells inside the box (a spanning anchor covers several rows,
 *   so it never sets a row edge; a row with only spanning cells takes its share of the span);
 * - boundaries: the first row's top, the midpoint of the gap between consecutive rows (the midpoint of the row
 *   centres when the cells overlap vertically, as tall symbol cells do), the last row's bottom;
 * - `headerRows` / `headerBottom`: the run of `hdr` rows from the top;
 * - `sections`: a body row that holds one cell spanning the table's columns (a merged section title, R5);
 * - `cells` carry the geometry on for WP-3.B (spans, header flags).
 *
 * Confidence = the containment (how well the table coincides with the box). The share of the table's cells inside
 * the box is reported in `error`-free hypotheses only through `cells`; it is NOT folded into the confidence, because
 * a box that covers part of a larger Textract table still reads that table's rows exactly (an earlier
 * `containment × share` dropped Textract-only boundaries under the R7 majority on such boxes). Pure (E-7).
 */

import { overlapSmaller } from "@/lib/region-classifier-v2/geometry";
import { centreIn } from "../geometry";
import type { BboxMinMax, EngineTextractCell } from "../types";
import type { RowHypothesis, RowsInput } from "../types-rows";

export const TEXTRACT_CELLS_VERSION = 1;
export const TEXTRACT_MIN_CONTAINMENT = 0.5;

interface RowExtent { r: number; y0: number; y1: number; cells: EngineTextractCell[] }

/** Row extents of one table's cells inside the box, by row index. */
function rowExtents(cells: readonly EngineTextractCell[]): RowExtent[] {
  const byRow = new Map<number, EngineTextractCell[]>();
  for (const c of cells) {
    const list = byRow.get(c.r) ?? [];
    list.push(c);
    byRow.set(c.r, list);
  }
  const rows: RowExtent[] = [];
  for (const [r, list] of [...byRow].sort((a, b) => a[0] - b[0])) {
    const plain = list.filter((c) => c.rs <= 1);
    const use = plain.length > 0 ? plain : list;
    let y0 = Math.min(...use.map((c) => c.b[1]));
    let y1 = Math.max(...use.map((c) => c.b[3]));
    if (plain.length === 0) {
      // only spanning anchors: this row takes the first share of the span
      const rs = Math.max(1, ...use.map((c) => c.rs));
      y1 = y0 + (y1 - y0) / rs;
    }
    rows.push({ r, y0, y1, cells: list });
  }
  return rows;
}

/** The boundary between two consecutive rows: the gap midpoint, or the midpoint of the row centres when the cells overlap vertically (tall symbol cells). */
function cutBetween(a: RowExtent, b: RowExtent): number {
  if (a.y1 <= b.y0) return (a.y1 + b.y0) / 2;
  return ((a.y0 + a.y1) / 2 + (b.y0 + b.y1) / 2) / 2;
}

/** Row boundaries, header rows and section rows from the stored Textract table coinciding with the box. */
export function textractCellRows(input: RowsInput): RowHypothesis {
  const base = { method: "textract-cells" as const, methodVersion: TEXTRACT_CELLS_VERSION };
  const box = input.box;
  let best: { t: RowsInput["textractTables"][number]; containment: number } | null = null;
  for (const t of input.textractTables) {
    const containment = overlapSmaller(box, t.b);
    if (containment >= TEXTRACT_MIN_CONTAINMENT && (!best || containment > best.containment)) best = { t, containment };
  }
  if (!best) return { ...base, conf: 0, error: "no stored Textract table coincides with the box" };
  // a degenerate cell (no height or width: a covered cell stored without a box) carries no row geometry
  const inBox = best.t.cells.filter((c) => centreIn(c.b, box) && c.b[3] - c.b[1] > 1e-6 && c.b[2] - c.b[0] > 1e-6);
  if (inBox.length === 0) return { ...base, conf: 0, error: "the coinciding Textract table has no cell inside the box" };
  const rows = rowExtents(inBox);
  if (rows.length < 1) return { ...base, conf: 0, error: "no Textract row inside the box" };
  // Rows whose cells all share one tall box (every cell spanning the table) carry no row geometry: no vote.
  const overlapping = rows.slice(1).filter((r, i) => Math.min(r.y1, rows[i].y1) - Math.max(r.y0, rows[i].y0) > 0.5 * Math.min(r.y1 - r.y0, rows[i].y1 - rows[i].y0)).length;
  if (rows.length >= 2 && overlapping > (rows.length - 1) / 2) return { ...base, conf: 0, error: `Textract rows carry no row geometry (${overlapping} of ${rows.length - 1} consecutive rows overlap)` };
  const clamp = (y: number): number => Math.min(box[3], Math.max(box[1], y));
  const rowLines: number[] = [clamp(rows[0].y0)];
  for (let i = 1; i < rows.length; i++) rowLines.push(Math.max(rowLines[i - 1], clamp(cutBetween(rows[i - 1], rows[i]))));
  rowLines.push(Math.max(rowLines[rowLines.length - 1], clamp(rows[rows.length - 1].y1)));

  let headerRows = 0;
  while (headerRows < rows.length && rows[headerRows].cells.some((c) => c.hdr) && rows[headerRows].cells.every((c) => c.hdr || c.rs > 1)) headerRows++;
  const colCount = new Set(best.t.cells.map((c) => c.c)).size;
  const sections: [number, number][] = [];
  rows.forEach((row, i) => {
    if (i < headerRows) return;
    if (row.cells.length === 1 && colCount >= 2 && row.cells[0].cs >= colCount) sections.push([rowLines[i], rowLines[i + 1]]);
  });
  const conf = Math.round(Math.max(0, Math.min(1, best.containment)) * 1000) / 1000;
  const b = (c: EngineTextractCell): BboxMinMax => c.b;
  return {
    ...base,
    conf,
    rowLines,
    headerRows,
    headerBottom: headerRows > 0 ? rowLines[headerRows] : undefined,
    sections: sections.length > 0 ? sections : undefined,
    cells: inBox.map((c) => ({ r: c.r, c: c.c, rs: c.rs, cs: c.cs, b: b(c), ...(c.hdr ? { header: true as const } : {}) })),
  };
}
