/**
 * Key/value pairing on one visual line (K09; pure; reused by the TP-3 paragraph segmenter).
 *
 * A key-value legend (abbreviations, symbols, materials) prints the key and its value side by side.
 * OCR often returns them as two separate LINEs at the same height; a binder that splits *within* a
 * LINE then emits every key and every value as its own key-only row (K09: 6 entries became 12 rows).
 *
 * Here lines that overlap vertically are first grouped into one visual row; the row's words are then
 * split at their widest horizontal gap when it is wide enough to be a column gap. A row with no such
 * gap keeps its whole text as the key. With `mergeContinuations`, a row that lies entirely right of
 * the median split (a wrapped value with no key of its own) is appended to the previous pair's
 * value.
 *
 * Boxes are normalised MinMax `[x0, y0, x1, y1]` (E-4). Deterministic: rows are visited in
 * (top, left, input index) order. Imports only `../lines` (assembleText) and `../geometry`.
 */

import { assembleText, type LineWord } from "../lines";
import { unionBox } from "../geometry";

type Box = readonly [number, number, number, number];

/** A text line: its text, its MinMax box and, when known, its words (MinMax). */
export interface KvLine {
  text: string;
  b: Box;
  words?: readonly LineWord[];
}

export interface KvPairsOptions {
  /** A split gap must exceed this share of the row width. */
  minGapRatio: number;
  /** Lines join one row when their vertical overlap ≥ this share of the shorter height. Default 0.5. */
  minOverlap?: number;
  /** A split only feeds the median column split when the key is at most this long. Default: always. */
  maxKeyLen?: number;
  /** Append value-only rows (wholly right of the median split) to the previous pair. Default false. */
  mergeContinuations?: boolean;
}

export interface KvPair {
  key: string;
  value: string;
  /** Union box of the row (and of any merged continuation rows). */
  b: [number, number, number, number];
  /** Top of the pair's first visual row (the legacy row boundary). */
  top: number;
  /** Input line indices in the pair, in reading order. */
  lineIdx: number[];
  /** x of the split gap's midpoint; null when the row was not split. */
  splitX: number | null;
}

export interface KvPairsResult {
  pairs: KvPair[];
  /** Median of the qualifying split x's; null when no row was split. */
  medianSplitX: number | null;
}

function finiteBox(b: unknown): b is Box {
  return Array.isArray(b) && b.length === 4 && b.every((v) => typeof v === "number" && Number.isFinite(v));
}

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.min(a1, b1) - Math.max(a0, b0);
}

/** Group lines that overlap vertically into visual rows, top to bottom. */
export function groupLinesByYOverlap(lines: readonly KvLine[], minOverlap = 0.5): number[][] {
  const order = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l && finiteBox(l.b))
    .sort((p, q) => p.l.b[1] - q.l.b[1] || p.l.b[0] - q.l.b[0] || p.i - q.i);
  const rows: number[][] = [];
  let cur: number[] = [];
  let y0 = 0;
  let y1 = 0;
  let minH = 0;
  for (const { l, i } of order) {
    const h = l.b[3] - l.b[1];
    if (cur.length > 0 && overlap(l.b[1], l.b[3], y0, y1) >= minOverlap * Math.min(h, minH)) {
      cur.push(i);
      y1 = Math.max(y1, l.b[3]);
      minH = Math.min(minH, h);
    } else {
      if (cur.length > 0) rows.push(cur);
      cur = [i];
      y0 = l.b[1];
      y1 = l.b[3];
      minH = h;
    }
  }
  if (cur.length > 0) rows.push(cur);
  return rows.map((r) => [...r].sort((a, b) => lines[a].b[0] - lines[b].b[0] || a - b));
}

/** Pair keys with values row by row. */
export function kvPairs(lines: readonly KvLine[], opts: KvPairsOptions): KvPairsResult {
  const rows = groupLinesByYOverlap(lines, opts.minOverlap ?? 0.5);
  const pairs: KvPair[] = [];
  const splitXs: number[] = [];

  for (const row of rows) {
    const members = row.map((i) => lines[i]);
    const words: LineWord[] = [];
    for (const l of members) {
      const ws = l.words && l.words.length > 0 ? l.words : [{ t: l.text, b: l.b }];
      for (const w of ws) if (w && finiteBox(w.b)) words.push(w);
    }
    const sorted = words.map((w, k) => ({ w, k })).sort((p, q) => p.w.b[0] - q.w.b[0] || p.k - q.k).map((p) => p.w);
    const b = unionBox(members.map((l) => l.b))!;
    const top = Math.min(...members.map((l) => l.b[1]));

    let maxGap = 0;
    let splitIdx = -1;
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i].b[0] - sorted[i - 1].b[2];
      if (gap > maxGap) {
        maxGap = gap;
        splitIdx = i;
      }
    }
    const width = b[2] - b[0];
    if (splitIdx > 0 && maxGap > width * opts.minGapRatio) {
      const key = assembleText(sorted.slice(0, splitIdx));
      const value = assembleText(sorted.slice(splitIdx));
      const splitX = (sorted[splitIdx - 1].b[2] + sorted[splitIdx].b[0]) / 2;
      if (key.length > 0 && (opts.maxKeyLen === undefined || key.length <= opts.maxKeyLen)) splitXs.push(splitX);
      pairs.push({ key, value, b, top, lineIdx: [...row], splitX });
    } else {
      const key = members.map((l) => (typeof l.text === "string" ? l.text.trim() : "")).filter((t) => t !== "").join(" ");
      pairs.push({ key, value: "", b, top, lineIdx: [...row], splitX: null });
    }
  }

  const medianSplitX = splitXs.length > 0 ? median(splitXs) : null;
  if (!opts.mergeContinuations || medianSplitX === null) return { pairs, medianSplitX };

  const merged: KvPair[] = [];
  for (const p of pairs) {
    const prev = merged[merged.length - 1];
    const continuation = prev !== undefined && prev.splitX !== null && p.splitX === null && p.b[0] >= medianSplitX;
    if (!continuation) {
      merged.push({ ...p, lineIdx: [...p.lineIdx] });
      continue;
    }
    prev.value = prev.value ? `${prev.value} ${p.key}` : p.key;
    prev.b = unionBox([prev.b, p.b])!;
    prev.lineIdx.push(...p.lineIdx);
  }
  return { pairs: merged, medianSplitX };
}
