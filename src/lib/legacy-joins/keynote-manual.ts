// [table-pipeline WP-2.0a] Keynote › Manual (column × row intersections) join, extracted verbatim
// from `KeynotePanel.parseKeynotes` at the TP-1 head (67492cc) so the goldens can call it.
// (PLAN §5 calls this file `keynote-guided.ts`; the code at KeynotePanel.tsx:500-518 is the Manual
// tab — Keynote Guided already calls `extractCellsFromGrid`.) Byte-equal to the inline original;
// WP-2.B changes it (K07) — record every output diff in eval/parse-engine/intended-diffs.md.
import type { TextractWord } from "@/types";

type MinMax = readonly [number, number, number, number];

export interface KeynoteKeyRow {
  key: string;
  description: string;
}

/** Column A = key; columns B+ = description (merged); words by centre, joined in x order. */
export function joinKeynoteIntersections(
  words: readonly TextractWord[],
  cols: readonly MinMax[],
  rows: readonly MinMax[],
): KeynoteKeyRow[] {
  const keys: KeynoteKeyRow[] = [];

  for (const rowBB of rows) {
    // Column A = tag key
    const tagWords = words.filter((w) => {
      const cx = w.bbox[0] + w.bbox[2] / 2;
      const cy = w.bbox[1] + w.bbox[3] / 2;
      return cx >= cols[0][0] && cx <= cols[0][2] && cy >= rowBB[1] && cy <= rowBB[3];
    });
    const tagText = tagWords.sort((a, b) => a.bbox[0] - b.bbox[0]).map((w) => w.text).join(" ");

    // Column B+ = description (all other columns merged)
    let descText = "";
    for (let ci = 1; ci < cols.length; ci++) {
      const descWords = words.filter((w) => {
        const cx = w.bbox[0] + w.bbox[2] / 2;
        const cy = w.bbox[1] + w.bbox[3] / 2;
        return cx >= cols[ci][0] && cx <= cols[ci][2] && cy >= rowBB[1] && cy <= rowBB[3];
      });
      const text = descWords.sort((a, b) => a.bbox[0] - b.bbox[0]).map((w) => w.text).join(" ");
      descText += (descText ? " " : "") + text;
    }

    if (tagText || descText) {
      keys.push({ key: tagText.trim(), description: descText.trim() });
    }
  }

  return keys;
}
