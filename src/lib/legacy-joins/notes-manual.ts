// [table-pipeline WP-2.0a] Notes › Manual cell join, extracted verbatim from
// `NotesParser.buildGridFromManualBBs` at the TP-1 head (67492cc) so the goldens can call it.
// (PLAN §5 calls this file `notes-guided.ts`; the inline join at NotesParser.tsx ~:304 is the
// Manual sub-mode — Notes Guided already calls `extractCellsFromGrid`.) Byte-equal to the inline
// original; WP-2.B changes it (K07) — record every output diff in eval/parse-engine/intended-diffs.md.
// [WP-2.B] Cell text is line-aware (`assembleText`: lines top to bottom, words left to right); was x only.
import type { TextractWord } from "@/types";
import { assembleText, lineWordsFromLtwh } from "@/lib/parse-engine/lines";

type MinMax = readonly [number, number, number, number];

export interface NotesManualCells {
  headers: string[];
  rows: Record<string, string>[];
}

/** Headers Key | Note | ColN; words by centre in column × row BB, line-aware reading order. Null when every cell is empty. */
export function joinNotesManualCells(
  words: readonly TextractWord[],
  columns: readonly MinMax[],
  rowBbs: readonly MinMax[],
): NotesManualCells | null {
  const headers = columns.map((_, i) => (i === 0 ? "Key" : i === 1 ? "Note" : `Col${i + 1}`));
  const builtRows: Record<string, string>[] = [];
  for (const [, yT, , yB] of rowBbs) {
    const row: Record<string, string> = {};
    for (let c = 0; c < columns.length; c++) {
      const [xL, , xR] = columns[c];
      const cellWords = words.filter((w) => {
        const [wL, wT, wW, wH] = w.bbox;
        const cx = wL + wW / 2;
        const cy = wT + wH / 2;
        return cx >= xL && cx <= xR && cy >= yT && cy <= yB;
      });
      row[headers[c]] = assembleText(lineWordsFromLtwh(cellWords));
    }
    builtRows.push(row);
  }
  if (builtRows.every((r) => Object.values(r).every((v) => !v))) return null;
  return { headers, rows: builtRows };
}
