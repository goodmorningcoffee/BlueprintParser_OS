// [table-pipeline WP-2.0a] Table › Manual cell join, extracted verbatim from
// `ManualParseTab.parseFromIntersections` at the TP-1 head (67492cc) so the goldens can call it.
// Behaviour is byte-equal to the inline original (legacy-golden.test.ts); WP-2.B changes it
// (K06 duplicate headers, K07 x-only join) — record every output diff in eval/parse-engine/intended-diffs.md.
// [WP-2.B] Done: cell text is line-aware (`assembleText`); headers go through `uniqueHeaders` after the
// blank fill, so two columns named alike keep separate keys (`X`, `X (2)`).
import type { TextractWord } from "@/types";
import { assembleText, lineWordsFromLtwh } from "@/lib/parse-engine/lines";
import { uniqueHeaders } from "@/lib/table-headers";

type MinMax = readonly [number, number, number, number];

export interface ManualCellsGrid {
  headers: string[];
  rows: Record<string, string>[];
  tagColumn: string | undefined;
}

const RE_TAG = /^[A-Z]{0,3}-?\d{1,4}[A-Z]?$/i;

/** Cell = column BB ∩ row BB; words by centre, line-aware reading order; tag column = first ≥ 50 % tag-like. */
export function joinManualCells(
  words: readonly TextractWord[],
  columnBBs: readonly MinMax[],
  rowBBs: readonly MinMax[],
  columnNames: readonly string[],
): ManualCellsGrid {
  const headers = uniqueHeaders(columnBBs.map((_, i) =>
    columnNames[i]?.trim() || `Column ${String.fromCharCode(65 + i)}`
  ));

  const rows: Record<string, string>[] = [];
  for (const rowBB of rowBBs) {
    const row: Record<string, string> = {};
    let hasContent = false;
    for (let ci = 0; ci < columnBBs.length; ci++) {
      const colBB = columnBBs[ci];
      // Cell = intersection of column and row bounding boxes
      const cellMinX = Math.max(colBB[0], rowBB[0]);
      const cellMaxX = Math.min(colBB[2], rowBB[2]);
      const cellMinY = Math.max(colBB[1], rowBB[1]);
      const cellMaxY = Math.min(colBB[3], rowBB[3]);

      // Find words whose center falls inside the cell
      const cellWords = words.filter((w) => {
        const cx = w.bbox[0] + w.bbox[2] / 2;
        const cy = w.bbox[1] + w.bbox[3] / 2;
        return cx >= cellMinX && cx <= cellMaxX && cy >= cellMinY && cy <= cellMaxY;
      });

      const text = assembleText(lineWordsFromLtwh(cellWords));

      row[headers[ci]] = text;
      if (text) hasContent = true;
    }
    if (hasContent) rows.push(row);
  }

  // Auto-detect tag column
  let tagColumn: string | undefined;
  for (const h of headers) {
    let tagCount = 0, nonEmpty = 0;
    for (const row of rows) {
      const v = (row[h] || "").trim();
      if (v) { nonEmpty++; if (RE_TAG.test(v)) tagCount++; }
    }
    if (nonEmpty > 0 && tagCount / nonEmpty >= 0.5) { tagColumn = h; break; }
  }

  return { headers, rows, tagColumn };
}
