import type { TextractPageData, BboxLTWH } from "@/types";
import { NOTES_KEY_COLUMN_GAP } from "@/lib/spatial-constants";
import { buildLineFeatures, median, RE_NUMBERED_ITEM } from "./shared";
import { bindNumberedGrid } from "./bind-numbered";
import { bindKeyValueGrid } from "./bind-key-value";

export interface ParsedNotesGrid {
  headers: string[];
  rows: Record<string, string>[];
  rowBoundaries?: number[];
  colBoundaries?: number[];
}

/**
 * Parse a user-drawn bbox region into a notes grid. Tries numbered first,
 * falls back to key-value. Returns undefined when neither shape matches.
 */
export function parseNotesFromRegion(
  textractData: TextractPageData,
  regionBbox: BboxLTWH,
): ParsedNotesGrid | undefined {
  if (!textractData?.lines || textractData.lines.length === 0) return undefined;

  const [rx, ry, rw, rh] = regionBbox;
  const rRight = rx + rw;
  const rBottom = ry + rh;

  const linesInRegion = textractData.lines.filter((line) => {
    if (!line.bbox || line.bbox.length < 4) return false;
    const cx = line.bbox[0] + line.bbox[2] / 2;
    const cy = line.bbox[1] + line.bbox[3] / 2;
    return cx >= rx && cx <= rRight && cy >= ry && cy <= rBottom;
  });

  if (linesInRegion.length === 0) return undefined;

  const features = buildLineFeatures(linesInRegion);
  if (features.length === 0) return undefined;

  const numbered = bindNumberedGrid(features);
  if (numbered) {
    const numberedFirstWordRights: number[] = [];
    for (const f of features) {
      if (!RE_NUMBERED_ITEM.test(f.firstWord)) continue;
      const firstWord = f.line.words?.[0];
      if (!firstWord?.bbox || firstWord.bbox.length < 4) continue;
      numberedFirstWordRights.push(firstWord.bbox[0] + firstWord.bbox[2]);
    }
    let colBoundaries: number[] | undefined;
    if (numberedFirstWordRights.length > 0) {
      const keyColRight = median(numberedFirstWordRights);
      colBoundaries = [rx, Math.min(keyColRight + NOTES_KEY_COLUMN_GAP, rRight - 0.001), rRight];
    }
    return {
      headers: numbered.headers,
      rows: numbered.rows,
      rowBoundaries: numbered.rowBoundaries,
      colBoundaries,
    };
  }

  const kv = bindKeyValueGrid(features);
  if (kv) return kv;
  return undefined;
}
