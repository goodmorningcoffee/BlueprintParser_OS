import { KV_RIGHT_COL_MAX_LEN, KV_MIN_GAP_RATIO } from "@/lib/spatial-constants";
import { median, type LineFeature } from "./shared";

/**
 * Per-line K:V binding. Splits each line at its largest inter-word X-gap
 * (must exceed KV_MIN_GAP_RATIO of line width to qualify), emitting
 * {Key, Value} rows. Lines with no meaningful gap drop whole text into Key.
 *
 * Derives `colBoundaries` from median split X across lines so the downstream
 * ParsedRegion grid renders cleanly on canvas.
 */
export function bindKeyValueGrid(
  lines: readonly LineFeature[],
): { headers: string[]; rows: Record<string, string>[]; rowBoundaries?: number[]; colBoundaries?: number[] } | undefined {
  if (lines.length === 0) return undefined;
  const ysorted = [...lines].sort((a, b) => a.top - b.top);

  const rows: Record<string, string>[] = [];
  const rowBoundaries: number[] = [];
  const splitXs: number[] = [];
  let regionLeft = Infinity;
  let regionRight = -Infinity;

  for (const lf of ysorted) {
    const words = lf.line.words;
    if (!words || words.length === 0) continue;
    const sorted = [...words].sort((a, b) => a.bbox[0] - b.bbox[0]);

    let maxGap = 0;
    let splitIdx = -1;
    for (let i = 1; i < sorted.length; i++) {
      const prevRight = sorted[i - 1].bbox[0] + sorted[i - 1].bbox[2];
      const curLeft = sorted[i].bbox[0];
      const gap = curLeft - prevRight;
      if (gap > maxGap) {
        maxGap = gap;
        splitIdx = i;
      }
    }

    const lineWidth = lf.right - lf.left;
    const meaningful = splitIdx > 0 && maxGap > lineWidth * KV_MIN_GAP_RATIO;

    if (meaningful) {
      const key = sorted.slice(0, splitIdx).map((w) => w.text).join(" ").trim();
      const value = sorted.slice(splitIdx).map((w) => w.text).join(" ").trim();
      if (key.length > 0 && key.length <= KV_RIGHT_COL_MAX_LEN) {
        rows.push({ Key: key, Value: value });
        const splitX = (sorted[splitIdx - 1].bbox[0] + sorted[splitIdx - 1].bbox[2] + sorted[splitIdx].bbox[0]) / 2;
        splitXs.push(splitX);
      } else {
        rows.push({ Key: key, Value: value });
      }
    } else {
      rows.push({ Key: lf.line.text.trim(), Value: "" });
    }

    rowBoundaries.push(lf.top);
    regionLeft = Math.min(regionLeft, lf.left);
    regionRight = Math.max(regionRight, lf.right);
  }

  if (rows.length === 0) return undefined;

  let colBoundaries: number[] | undefined;
  if (splitXs.length > 0 && isFinite(regionLeft) && isFinite(regionRight)) {
    const medianSplit = median(splitXs);
    colBoundaries = [regionLeft, medianSplit, regionRight];
  }

  return {
    headers: ["Key", "Value"],
    rows,
    rowBoundaries,
    colBoundaries,
  };
}
