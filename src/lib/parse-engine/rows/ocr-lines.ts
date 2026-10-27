/**
 * rows/ocr-lines.ts — row boundaries from the visual lines (table pipeline WP-3.A; PLAN §1.4 `ocr-lines`).
 *
 * Two modes, both pure and deterministic (E-7):
 *
 * - `"lines"` (default): the box's visual lines (`lines.wordsToLines`, the running-mean rule) give one
 *   candidate row per line, cut at the midpoint of the white gap between consecutive lines (the midpoint of
 *   the line centres when two lines overlap vertically). This generalises row groupers #1, #2, #3, #5, #6
 *   and #8 of INVENTORY §5b: each of them is "one text line = one row" with a different tolerance.
 * - `"legacy"`: byte parity with `methodOcrPositions` (`lib/services/table-parse.ts:91-108`): words whose
 *   centre lies inside the box, sorted by y-centre, chained to the cluster's FIRST word within .006 of the
 *   page; boundaries `[box top, midpoints of consecutive cluster mean centres, box bottom]`; the same
 *   bail-outs (< 6 words, < 3 clusters) become `error`. `legacyRowClusters` is exported for the parity test.
 *
 * Confidence (lines mode): .55 + .3 × pitch regularity (1 − CV of the line-centre steps, clamped), so a
 * tidy schedule votes ≈ .85 and ragged prose ≈ .55; the R7 weight (.5) does the rest. A method with fewer
 * than two lines casts no vote (`error`).
 */

import type { BboxMinMax } from "../types";
import type { RowHypothesis, RowsInput, RowsWord } from "../types-rows";

export const OCR_LINES_VERSION = 1;
/** `methodOcrPositions`' DEFAULT_ROW_Y_TOL (also `spatial-constants.ROW_Y_TOLERANCE`). */
export const LEGACY_ROW_Y_TOL = 0.006;

export type OcrLinesMode = "lines" | "legacy";

const yc = (b: BboxMinMax): number => (b[1] + b[3]) / 2;

/**
 * The legacy row clusters (indices into `words`, each cluster in x order), exactly as `methodOcrPositions`
 * groups them: y-centre sort, chain to the cluster's first word, tolerance `tol`.
 */
export function legacyRowClusters(words: readonly RowsWord[], tol = LEGACY_ROW_Y_TOL): number[][] {
  if (words.length === 0) return [];
  const sorted = words.map((w, i) => i).sort((a, b) => yc(words[a].b) - yc(words[b].b));
  const clusters: number[][] = [];
  let cur: number[] = [sorted[0]];
  let curY = yc(words[sorted[0]].b);
  for (let k = 1; k < sorted.length; k++) {
    const wy = yc(words[sorted[k]].b);
    if (Math.abs(wy - curY) <= tol) cur.push(sorted[k]);
    else {
      clusters.push(cur.sort((a, b) => words[a].b[0] - words[b].b[0]));
      cur = [sorted[k]];
      curY = wy;
    }
  }
  clusters.push(cur.sort((a, b) => words[a].b[0] - words[b].b[0]));
  return clusters;
}

function legacy(input: RowsInput): RowHypothesis {
  const base = { method: "ocr-lines" as const, methodVersion: OCR_LINES_VERSION };
  const words = input.words;
  if (words.length < 6) return { ...base, conf: 0, error: `too few words in region: ${words.length} (need ≥6)` };
  const clusters = legacyRowClusters(words);
  if (clusters.length < 3) return { ...base, conf: 0, error: `too few row clusters: ${clusters.length} (need ≥3)` };
  const centres = clusters.map((c) => c.reduce((s, i) => s + yc(words[i].b), 0) / c.length);
  const rowLines: number[] = [input.box[1]];
  for (let i = 1; i < centres.length; i++) rowLines.push((centres[i - 1] + centres[i]) / 2);
  rowLines.push(input.box[3]);
  return { ...base, conf: 0.6, rowLines };
}

/** Row boundaries from the visual lines (see the file header). */
export function ocrLinesRows(input: RowsInput, mode: OcrLinesMode = "lines"): RowHypothesis {
  if (mode === "legacy") return legacy(input);
  const base = { method: "ocr-lines" as const, methodVersion: OCR_LINES_VERSION };
  const lines = [...input.lines].sort((a, b) => yc(a.b) - yc(b.b) || a.b[0] - b.b[0]);
  if (lines.length < 2) return { ...base, conf: 0, error: `too few lines in region: ${lines.length} (need ≥2)` };
  const clamp = (y: number): number => Math.min(input.box[3], Math.max(input.box[1], y));
  const rowLines: number[] = [clamp(lines[0].b[1])];
  for (let k = 1; k < lines.length; k++) {
    const prev = lines[k - 1];
    const next = lines[k];
    const cut = prev.b[3] <= next.b[1] ? (prev.b[3] + next.b[1]) / 2 : (yc(prev.b) + yc(next.b)) / 2;
    rowLines.push(Math.max(rowLines[rowLines.length - 1], clamp(cut)));
  }
  rowLines.push(Math.max(rowLines[rowLines.length - 1], clamp(Math.max(...lines.map((l) => l.b[3])))));
  const steps = lines.slice(1).map((l, k) => yc(l.b) - yc(lines[k].b));
  const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
  const sd = Math.sqrt(steps.reduce((a, s) => a + (s - mean) ** 2, 0) / steps.length);
  const regularity = mean > 0 ? Math.max(0, Math.min(1, 1 - sd / mean)) : 0;
  const conf = Math.round((0.55 + 0.3 * regularity) * 1000) / 1000;
  return { ...base, conf, rowLines };
}
