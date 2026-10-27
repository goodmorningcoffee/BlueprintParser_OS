// [table-pipeline WP-2.0a] Notes › Fast-manual grid builder, extracted verbatim from
// `FastManualParseOverlay` (handleDoubleClick's column/grid steps, `deriveMidSplit`,
// `binLineIntoColumns`, `computeRowBoundaries`) at the TP-1 head (67492cc) so the goldens can call it.
// One Textract LINE = one row. Byte-equal to the inline original; WP-2.B changes it (K06/K07) —
// record every output diff in eval/parse-engine/intended-diffs.md.
// [WP-2.B] Deliberately NOT rewired to `assembleText`: one row is one OCR LINE, whose word order is
// already the reading order (also for rotated text, where a geometric sort reverses it — measured on a
// private slice). Headers are fixed names, unique by construction, so no `uniqueHeaders` either.
import type { TextractLine } from "@/types";

export interface FastManualGrid {
  headers: string[];
  rows: Record<string, string>[];
  colBoundaries?: number[];
  rowBoundaries?: number[];
}

/** Column padding around the first selected LINE, in CSS pixels. */
const PADDING_PX = 2;

/**
 * The column boundaries after the user double-clicks `hit`. First selection: the LINE's L/R margins
 * plus 2 px (`pxPerUnit` = cssScale × canvas width), split at the widest word gap when one exists.
 * Later selections only extend the outer bounds; the SAME array is returned when nothing changes.
 */
export function nextFastManualColumns(
  columns: number[],
  hit: TextractLine,
  pxPerUnit: number,
): number[] {
  let nextColumns = columns;
  if (columns.length === 0) {
    // First selection: establish columns from LINE's L/R margins + 2px padding
    const padNorm = PADDING_PX / pxPerUnit;
    const lineLeft = hit.bbox[0];
    const lineRight = hit.bbox[0] + hit.bbox[2];
    // 2-column default (Key | Note). Try to find a gap in the line's words.
    const midSplit = deriveMidSplit(hit);
    nextColumns = midSplit !== null
      ? [
          Math.max(0, lineLeft - padNorm),
          midSplit,
          Math.min(1, lineRight + padNorm),
        ]
      : [
          Math.max(0, lineLeft - padNorm),
          Math.min(1, lineRight + padNorm),
        ];
  } else {
    // Subsequent: extend columns if any word of the line falls outside all existing bounds
    const leftmost = hit.bbox[0];
    const rightmost = hit.bbox[0] + hit.bbox[2];
    if (leftmost < nextColumns[0]) {
      nextColumns = [leftmost, ...nextColumns];
    }
    if (rightmost > nextColumns[nextColumns.length - 1]) {
      nextColumns = [...nextColumns, rightmost];
    }
  }
  return nextColumns;
}

/** The cumulative grid for the selected LINEs (already sorted top-down) under `columns`. */
export function fastManualGrid(selected: readonly TextractLine[], columns: number[]): FastManualGrid {
  const headers = columns.length === 3 ? ["Key", "Note"] : columns.slice(0, -1).map((_, i) => i === 0 ? "Key" : `Col${i + 1}`);
  const rows = selected.map((line) => binLineIntoColumns(line, columns, headers));
  const rowBoundaries = computeRowBoundaries(selected);
  return { headers, rows, colBoundaries: columns, rowBoundaries };
}

/**
 * Find a reasonable Key/Note column split inside a LINE by scanning for the
 * largest inter-word X-gap. Returns normalized X coordinate, or null if the
 * line has fewer than 2 words.
 */
export function deriveMidSplit(line: TextractLine): number | null {
  if (!line.words || line.words.length < 2) return null;
  const sorted = [...line.words].sort((a, b) => a.bbox[0] - b.bbox[0]);
  let maxGap = 0;
  let splitAt: number | null = null;
  for (let i = 1; i < sorted.length; i++) {
    const prevRight = sorted[i - 1].bbox[0] + sorted[i - 1].bbox[2];
    const curLeft = sorted[i].bbox[0];
    const gap = curLeft - prevRight;
    if (gap > maxGap) {
      maxGap = gap;
      splitAt = prevRight + gap / 2;
    }
  }
  // Only use the split if the gap is meaningful (> 1% of line width)
  if (splitAt !== null && maxGap > line.bbox[2] * 0.05) return splitAt;
  return null;
}

export function binLineIntoColumns(
  line: TextractLine,
  columns: readonly number[],
  headers: readonly string[],
): Record<string, string> {
  const row: Record<string, string> = {};
  for (const h of headers) row[h] = "";
  if (!line.words) {
    row[headers[0]] = line.text;
    return row;
  }
  for (const word of line.words) {
    const wx = word.bbox[0] + word.bbox[2] / 2;
    let colIdx = 0;
    for (let i = 1; i < columns.length - 1; i++) {
      if (wx >= columns[i]) colIdx = i;
    }
    if (colIdx >= headers.length) colIdx = headers.length - 1;
    row[headers[colIdx]] = row[headers[colIdx]]
      ? `${row[headers[colIdx]]} ${word.text}`
      : word.text;
  }
  return row;
}

export function computeRowBoundaries(lines: readonly TextractLine[]): number[] {
  if (lines.length === 0) return [];
  const sorted = [...lines].sort((a, b) => a.bbox[1] - b.bbox[1]);
  const boundaries: number[] = [];
  for (const line of sorted) {
    boundaries.push(line.bbox[1]);
  }
  // Final boundary = bottom of last line
  const last = sorted[sorted.length - 1];
  boundaries.push(last.bbox[1] + last.bbox[3]);
  return boundaries;
}
