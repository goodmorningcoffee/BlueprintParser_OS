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
 * Two guards keep the grouping from pairing what is not one entry (WP-2.B VERIFY MED-1):
 * - a row only takes a line that overlaps EVERY line already in it (no chaining through a growing
 *   band), and a line that spans two text rows (it overlaps two shorter lines that do not overlap
 *   each other: a tall symbol or a large label) stays a row of its own;
 * - a gutter: when the widest gap's two sides EACH hold their own column gap (wider than the same
 *   row threshold), the widest gap separates two entries, not a key from its value (a legend printed
 *   in side-by-side columns). Each side is then paired on its own, recursively.
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
  /** Lines join one row when their vertical overlap ≥ this share of the shorter height (pairwise). Default 0.5. */
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
  /** Input line indices in the pair, in reading order (a LINE that straddles a gutter is in both pairs). */
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

/** Two lines share a visual row: vertical overlap ≥ `minOverlap` × the shorter height. */
function sameRow(a: Box, b: Box, minOverlap: number): boolean {
  return overlap(a[1], a[3], b[1], b[3]) >= minOverlap * Math.min(a[3] - a[1], b[3] - b[1]);
}

/**
 * Group lines that overlap vertically into visual rows, top to bottom.
 *
 * A line joins the most recent row whose members it ALL overlaps (pairwise, so a row never chains
 * stacked lines through a growing band). A line that overlaps two SHORTER lines which do not overlap
 * each other spans two text rows (a tall symbol or a large label) and is a row of its own.
 */
export function groupLinesByYOverlap(lines: readonly KvLine[], minOverlap = 0.5): number[][] {
  const order = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l && finiteBox(l.b))
    .sort((p, q) => p.l.b[1] - q.l.b[1] || p.l.b[0] - q.l.b[0] || p.i - q.i);

  // Same-row adjacency. Sorted by top, so a later line can only overlap while its top is above the bottom.
  const adj = new Map<number, Set<number>>(order.map(({ i }) => [i, new Set<number>()]));
  for (let p = 0; p < order.length; p++) {
    const a = order[p].l.b;
    for (let q = p + 1; q < order.length && order[q].l.b[1] < a[3]; q++) {
      if (!sameRow(a, order[q].l.b, minOverlap)) continue;
      adj.get(order[p].i)!.add(order[q].i);
      adj.get(order[q].i)!.add(order[p].i);
    }
  }
  const h = (i: number): number => lines[i].b[3] - lines[i].b[1];
  // Only shorter neighbours count, so a line beside a tall one is not itself taken for a tall one.
  const spansTwoRows = (i: number): boolean => {
    const ns = [...adj.get(i)!].filter((j) => h(j) < h(i));
    for (let x = 0; x < ns.length; x++) for (let y = x + 1; y < ns.length; y++) if (!adj.get(ns[x])!.has(ns[y])) return true;
    return false;
  };

  const rows: { members: number[]; alone: boolean }[] = [];
  for (const { i } of order) {
    const alone = spansTwoRows(i);
    let target: { members: number[]; alone: boolean } | undefined;
    if (!alone) {
      for (let r = rows.length - 1; r >= 0 && target === undefined; r--) {
        if (!rows[r].alone && rows[r].members.every((j) => adj.get(i)!.has(j))) target = rows[r];
      }
    }
    if (target) target.members.push(i);
    else rows.push({ members: [i], alone });
  }
  return rows.map((r) => [...r.members].sort((a, b) => lines[a].b[0] - lines[b].b[0] || a - b));
}

interface RowWord {
  w: LineWord;
  /** Input line index. */
  li: number;
}

/** Index of the widest gap between x-sorted words, and its width (idx −1 when there is none). */
function widestGap(ws: readonly RowWord[]): { idx: number; gap: number } {
  let gap = 0;
  let idx = -1;
  for (let i = 1; i < ws.length; i++) {
    const g = ws[i].w.b[0] - ws[i - 1].w.b[2];
    if (g > gap) {
      gap = g;
      idx = i;
    }
  }
  return { idx, gap };
}

/**
 * Split a row's x-sorted words at gutters: the widest gap is a gutter when the words on each side
 * hold a qualifying gap of their own (> `minGap`, the row threshold) — two entries side by side.
 */
function splitAtGutters(ws: readonly RowWord[], minGap: number): RowWord[][] {
  const { idx, gap } = widestGap(ws);
  if (idx <= 0 || gap <= minGap) return [[...ws]];
  const left = ws.slice(0, idx);
  const right = ws.slice(idx);
  if (widestGap(left).gap > minGap && widestGap(right).gap > minGap) {
    return [...splitAtGutters(left, minGap), ...splitAtGutters(right, minGap)];
  }
  return [[...ws]];
}

/** Pair keys with values row by row. */
export function kvPairs(lines: readonly KvLine[], opts: KvPairsOptions): KvPairsResult {
  const rows = groupLinesByYOverlap(lines, opts.minOverlap ?? 0.5);
  const pairs: KvPair[] = [];
  const splitXs: number[] = [];

  for (const row of rows) {
    const members = row.map((i) => lines[i]);
    const words: RowWord[] = [];
    for (const li of row) {
      const l = lines[li];
      const ws = l.words && l.words.length > 0 ? l.words : [{ t: l.text, b: l.b }];
      for (const w of ws) if (w && finiteBox(w.b)) words.push({ w, li });
    }
    const sorted = words.map((rw, k) => ({ rw, k })).sort((p, q) => p.rw.w.b[0] - q.rw.w.b[0] || p.k - q.k).map((p) => p.rw);
    const rowB = unionBox(members.map((l) => l.b))!;
    const minGap = (rowB[2] - rowB[0]) * opts.minGapRatio;
    const segments = splitAtGutters(sorted, minGap);

    for (const seg of segments) {
      // One segment (no gutter): the row itself. Several: each entry's own words, lines and box.
      const whole = segments.length === 1;
      const segLines = whole ? [...row] : [...new Set(seg.map((rw) => rw.li))];
      const b = whole ? rowB : unionBox(seg.map((rw) => rw.w.b))!;
      const top = whole ? Math.min(...members.map((l) => l.b[1])) : b[1];
      const { idx: splitIdx, gap: maxGap } = widestGap(seg);
      if (splitIdx > 0 && maxGap > minGap) {
        const key = assembleText(seg.slice(0, splitIdx).map((rw) => rw.w));
        const value = assembleText(seg.slice(splitIdx).map((rw) => rw.w));
        const splitX = (seg[splitIdx - 1].w.b[2] + seg[splitIdx].w.b[0]) / 2;
        if (key.length > 0 && (opts.maxKeyLen === undefined || key.length <= opts.maxKeyLen)) splitXs.push(splitX);
        pairs.push({ key, value, b, top, lineIdx: segLines, splitX });
      } else {
        const key = whole
          ? members.map((l) => (typeof l.text === "string" ? l.text.trim() : "")).filter((t) => t !== "").join(" ")
          : assembleText(seg.map((rw) => rw.w));
        pairs.push({ key, value: "", b, top, lineIdx: segLines, splitX: null });
      }
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
