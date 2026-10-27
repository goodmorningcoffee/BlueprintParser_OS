import { KV_RIGHT_COL_MAX_LEN, KV_MIN_GAP_RATIO } from "@/lib/spatial-constants";
import type { LineFeature } from "./shared";
import { kvPairs, type KvLine } from "@/lib/parse-engine/paragraphs/kv-pairs";
import { ltwhToMinMax } from "@/lib/parse-engine/geometry";

/**
 * K:V binding (K09). Lines that overlap vertically form one visual row (OCR often returns the key and
 * the value as two separate LINEs), and each row splits at its largest inter-word X-gap (must exceed
 * KV_MIN_GAP_RATIO of the row width to qualify), emitting {Key, Value} rows. Rows with no meaningful
 * gap keep their whole text as the Key; a no-gap row lying wholly right of the median split (a
 * wrapped value) is appended to the previous row's Value. The pairing itself is
 * `parse-engine/paragraphs/kv-pairs.ts` (pure, MinMax); this adapter converts the LTWH line features.
 *
 * Derives `colBoundaries` from median split X across rows so the downstream
 * ParsedRegion grid renders cleanly on canvas.
 *
 * Was per-LINE only (split *within* a LINE), so a legend whose keys and values are separate LINEs
 * bound into key-only and value-only rows (`[{Key:"<key>",Value:""},{Key:"<value>",Value:""},…]`).
 */
export function bindKeyValueGrid(
  lines: readonly LineFeature[],
): { headers: string[]; rows: Record<string, string>[]; rowBoundaries?: number[]; colBoundaries?: number[] } | undefined {
  if (lines.length === 0) return undefined;
  const kvLines: KvLine[] = [];
  for (const lf of lines) {
    const words = lf.line.words;
    if (!words || words.length === 0) continue;
    kvLines.push({
      text: lf.line.text,
      b: [lf.left, lf.top, lf.right, lf.bottom],
      words: words.map((w) => ({ t: w.text, b: ltwhToMinMax(w.bbox) })),
    });
  }

  // ⚠ BORROWED THRESHOLD — hidden coupling. `KV_RIGHT_COL_MAX_LEN` is a
  // *text-region-classifier* threshold: there it gates `meanRightColLen` when deciding
  // whether a region is `notes-key-value`. Here it is reused as a per-row KEY-length
  // gate, a different quantity in a different module. Tuning the classifier's
  // sensitivity therefore silently moves this binder's rendered column boundary, with
  // nothing connecting the two. Its ONLY effect is whether a row's split x joins the
  // median `colBoundaries` below (and hence which rows count as continuations).
  const { pairs, medianSplitX } = kvPairs(kvLines, {
    minGapRatio: KV_MIN_GAP_RATIO,
    maxKeyLen: KV_RIGHT_COL_MAX_LEN,
    mergeContinuations: true,
  });
  if (pairs.length === 0) return undefined;

  const rows = pairs.map((p) => ({ Key: p.key, Value: p.value }));
  const rowBoundaries = pairs.map((p) => p.top);
  let regionLeft = Infinity;
  let regionRight = -Infinity;
  for (const l of kvLines) {
    regionLeft = Math.min(regionLeft, l.b[0]);
    regionRight = Math.max(regionRight, l.b[2]);
  }

  let colBoundaries: number[] | undefined;
  if (medianSplitX !== null && isFinite(regionLeft) && isFinite(regionRight)) {
    colBoundaries = [regionLeft, medianSplitX, regionRight];
  }

  return {
    headers: ["Key", "Value"],
    rows,
    rowBoundaries,
    colBoundaries,
  };
}
