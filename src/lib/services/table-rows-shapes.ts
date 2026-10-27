/**
 * table-rows-shapes.ts — the SHAPE-CENTRE row builder (owner, 2026-10-25: "take the center point of the
 * YOLO shapes detected as the tags and draw a line horizontally thru that center point and use that to
 * justify the center of each row in the table, as an additional row building tool"). A 4th MethodResult
 * for the grid merger beside OCR positions / Textract / OpenCV lines: the rows are the column of tag
 * shapes in the region's left part (classifier-engine/shape-column.ts — the same rule the proposals' tag
 * map uses), each row band running between the midpoints of consecutive shape centres (WP-2.C, K13: a
 * description centred on its shape stays in its row; the last row runs to the last word in the region), so a multi-line description stays one row
 * (the OCR-positions chain, tol .006, splits 29 % of legend tag bands); the columns are x-start clusters
 * (OCR-positions' gap rule) over the CELL-START words right of the shapes — a word with a neighbour ending
 * within the column gap to its left continues a cell, so "NEW WALL TYPE" stays one description column;
 * the tag column is the shape column itself (the word inside the shape, else the classical crop read, its lost
 * `.`/`/` restored from the sibling keys: parse-engine/rows/shape-centres.ts). Measured basis: shape centre within .18 word
 * heights of its row text (yolo), .04 (classical). Pure.
 *
 * Confidence .6 when the column is regular (≥ 3 shapes, gap CV ≤ .5), else .35 so the merger never takes a
 * weak column as its base. Runs only when the request asks for it (rowSource "shape-centres").
 */
import type { MethodResult } from "@/lib/grid-merger";
import type { TextractWord } from "@/types";
import { bestShapeColumn, type ColumnShape, type ColumnWord } from "@/lib/classifier-engine/shape-column";
import { assembleText } from "@/lib/parse-engine/lines";
import { readShapeKeys, shapeRowBands } from "@/lib/parse-engine/rows/shape-centres";

export interface ShapeRowsOptions {
  /** OCR-positions' column gap (normalized x) between x-start clusters. Default .015. */
  minColGap?: number;
  /** A column cluster needs ≥ max(2, floor(rows × colHitRatio)) words. Default .3. */
  colHitRatio?: number;
}

export const SHAPE_ROWS_METHOD = "shape-rows";
const STRONG_CONFIDENCE = 0.6;
const WEAK_CONFIDENCE = 0.35;
const MAX_GAP_CV = 0.5;

const toColumnWord = (w: TextractWord): ColumnWord => ({ text: w.text, bbox: [w.bbox[0], w.bbox[1], w.bbox[0] + w.bbox[2], w.bbox[1] + w.bbox[3]], c: [w.bbox[0] + w.bbox[2] / 2, w.bbox[1] + w.bbox[3] / 2], h: Math.max(w.bbox[3], 1e-4) });
// [table pipeline WP-2.C] line-aware (lines top to bottom, words left to right): the exact-y-centre sort read
// words of one line out of order under a small height jitter (C02-F3).
const joinWords = (ws: readonly ColumnWord[]): string => assembleText(ws.map((w) => ({ t: w.text, b: w.bbox }))).replace(/\s+/g, " ").trim();

export function methodShapeRows(
  words: readonly TextractWord[],
  shapes: readonly ColumnShape[],
  regionBbox: [number, number, number, number],
  options?: ShapeRowsOptions,
): MethodResult {
  const minColGap = options?.minColGap ?? 0.015;
  const colHitRatio = options?.colHitRatio ?? 0.3;
  const fail = (error: string, intermediate: Record<string, unknown> = {}): MethodResult => ({ method: SHAPE_ROWS_METHOD, headers: [], rows: [], confidence: 0, error, debug: { intermediate } });

  const inBox = words.map(toColumnWord).filter((w) => w.c[0] >= regionBbox[0] && w.c[0] <= regionBbox[2] && w.c[1] >= regionBbox[1] && w.c[1] <= regionBbox[3]);
  const col = bestShapeColumn(shapes, regionBbox, "any");
  if (!col) return fail("no shape column: need ≥ 3 aligned tag shapes in the left 25 % of the region", { shapesInRegion: shapes.length, regionWordCount: inBox.length });
  const { bands, align } = shapeRowBands(col.shapes.map((s) => s.bbox), regionBbox, inBox.map((w) => w.bbox));
  // [WP-2.C] keys: the words inside each shape, else its crop read (flagged), repaired against the siblings (C2-m4).
  const keys = readShapeKeys(col.shapes, inBox.map((w) => ({ t: w.text, b: w.bbox })));

  // Columns right of the shapes: OCR-positions' x-start clusters over the words that START a cell.
  const right = inBox.filter((w) => w.c[0] > col.right);
  const sameRow = (a: ColumnWord, b: ColumnWord): boolean => Math.abs(a.c[1] - b.c[1]) <= 0.5 * Math.max(a.h, b.h);
  const startsCell = (w: ColumnWord): boolean => !right.some((o) => o !== w && sameRow(o, w) && o.bbox[2] <= w.bbox[0] + 1e-6 && w.bbox[0] - o.bbox[2] <= minColGap);
  const lefts = right.filter(startsCell).map((w) => w.bbox[0]).sort((a, b) => a - b);
  const clusters: number[][] = [];
  for (const x of lefts) {
    const cur = clusters[clusters.length - 1];
    if (cur && x - cur[cur.length - 1] <= minColGap) cur.push(x);
    else clusters.push([x]);
  }
  const minHits = Math.max(2, Math.floor(bands.length * colHitRatio));
  let stable = clusters.filter((c) => c.length >= minHits);
  if (!stable.length) stable = clusters;
  const centers = stable.map((c) => c.reduce((s, x) => s + x, 0) / c.length).sort((a, b) => a - b);
  const maxRight = right.length ? Math.max(...right.map((w) => w.bbox[2])) : regionBbox[2];
  // Column bounds: the tag column from the region's left edge to the shapes' right edge, then the text columns.
  const bounds: Array<{ left: number; right: number }> = [{ left: regionBbox[0], right: col.right }];
  centers.forEach((c, i) => bounds.push({
    left: i === 0 ? col.right : (centers[i - 1] + c) / 2,
    right: i === centers.length - 1 ? Math.min(1, Math.max(maxRight, c) + 0.005) : (c + centers[i + 1]) / 2,
  }));
  const colOf = (w: ColumnWord): number => {
    let i = bounds.findIndex((b) => w.c[0] >= b.left && w.c[0] < b.right);
    if (i === -1) i = bounds.length - 1;
    return i;
  };

  // Header: words above the first band (the title / column-header rows), bucketed by column.
  const headerWords = inBox.filter((w) => w.c[1] < bands[0][1]);
  const headerCells = bounds.map(() => [] as ColumnWord[]);
  for (const w of headerWords) headerCells[colOf(w)].push(w);
  const headerTexts = headerCells.map(joinWords);
  // [fix round] duplicate header texts ("QTY", "QTY") would collapse into one row key; the repeat gets a suffix.
  const seen = new Map<string, number>();
  const headers = bounds.map((_, i) => {
    const h = headerTexts[i] || (i === 0 ? "TAG" : `Column ${i}`);
    const n = (seen.get(h) ?? 0) + 1;
    seen.set(h, n);
    return n === 1 ? h : `${h} (${n})`;
  });
  const tagColumn = headers[0];

  const rows: Record<string, string>[] = [];
  let withTag = 0;
  col.shapes.forEach((_s, i) => {
    const band = bands[i];
    const cells = bounds.map(() => [] as ColumnWord[]);
    for (const w of inBox) if (w.c[1] >= band[1] && w.c[1] < band[3]) cells[colOf(w)].push(w);
    const row: Record<string, string> = {};
    const tag = keys[i].key ?? joinWords(cells[0]);
    if (tag) withTag++;
    headers.forEach((h, c) => { row[h] = c === 0 ? tag : joinWords(cells[c]); });
    rows.push(row);
  });

  const regular = col.n >= 3 && col.gapCv !== null && col.gapCv <= MAX_GAP_CV;
  return {
    method: SHAPE_ROWS_METHOD,
    headers,
    rows,
    confidence: regular ? STRONG_CONFIDENCE : WEAK_CONFIDENCE,
    tagColumn,
    colBoundaries: [bounds[0].left, ...bounds.map((b) => b.right)],
    rowBoundaries: [headerWords.length ? Math.min(regionBbox[1], ...headerWords.map((w) => w.bbox[1])) : bands[0][1], ...bands.map((b) => b[1]).slice(1), bands[bands.length - 1][3]],
    debug: {
      intermediate: {
        source: col.source, shapeClass: col.shapeClass, bandAlign: align, shapeCount: col.n, gapCv: col.gapCv, regular,
        regionWordCount: inBox.length, columnClusterCount: centers.length, headerRowDetected: headerWords.length > 0, rowsWithTag: withTag,
        keyFromCrop: keys.filter((k) => k.flags.includes("key-from-crop")).length, keysRepaired: keys.filter((k) => k.flags.includes("key-repaired")).length,
      },
    },
  };
}
