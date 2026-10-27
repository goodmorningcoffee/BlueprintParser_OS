/**
 * Words → text lines, and line-aware cell text (pure, client-safe; E-1, E-7, E-8).
 *
 * The one text-assembly rule for every parser (K07). Five legacy joins sort a cell's words by x
 * only, so a two-line cell "PAINTED METAL / HOLLOW FRAME" reads "PAINTED HOLLOW METAL FRAME"; the
 * shape-rows join sorts by exact y-centre, so a 1 % height jitter reorders words on one line.
 * Here words are first grouped into lines, then read top-to-bottom, left-to-right.
 *
 * Line rule (running mean, the same rule as `csi-detect.ts` `linesFromWordsByGeometry`):
 * - words are visited in (y-centre, x0, input index) order;
 * - a word joins the open line when |its y-centre − the line's MEAN y-centre| is at most
 *   `centreTol` × max(its height, the line's running max height); otherwise it opens a new line;
 * - inside a line, words read left to right; with `splitGap`, a horizontal gap wider than
 *   `splitGap` × the line's median height splits it into separate lines (two text columns).
 *
 * Deterministic: the same words in any input order give the same lines (ties break on input
 * index only when two words share y-centre and x0). Every word with a finite box lands in
 * exactly one line (word conservation); words with a non-finite box are skipped.
 *
 * Import purity: imports only `./geometry` (see `__tests__/client-safe-imports.test.ts`).
 */

import { ltwhToMinMax, unionBox } from "./geometry";

type Box = readonly [number, number, number, number];

/** A word as the engine sees it: text and a normalised MinMax box. */
export interface LineWord {
  t: string;
  b: Box;
}

/** One text line. `wordIdx` indexes the input array, in reading order. */
export interface WordLine {
  text: string;
  b: [number, number, number, number];
  wordIdx: number[];
}

export interface WordsToLinesOptions {
  /** Share of the taller height within which a y-centre joins a line. Default 0.5. */
  centreTol?: number;
  /** Split a line at horizontal gaps wider than this × its median height. Default: never split. */
  splitGap?: number;
}

export interface AssembleTextOptions extends WordsToLinesOptions {
  /** Joins lines. Default " " (the legacy cell convention); the structure model uses "\n". */
  lineSep?: string;
}

const MIN_H = 1e-4;
const DEFAULT_CENTRE_TOL = 0.5;

function finiteBox(b: unknown): b is Box {
  return Array.isArray(b) && b.length === 4 && b.every((v) => typeof v === "number" && Number.isFinite(v));
}

interface Item {
  i: number;
  x0: number;
  x1: number;
  yc: number;
  h: number;
}

function lineOf(words: readonly LineWord[], items: readonly Item[]): WordLine {
  const wordIdx = items.map((it) => it.i);
  const text = wordIdx
    .map((i) => (typeof words[i].t === "string" ? words[i].t.trim() : ""))
    .filter((t) => t !== "")
    .join(" ");
  return { text, b: unionBox(wordIdx.map((i) => words[i].b)) as [number, number, number, number], wordIdx };
}

/** Group words into lines in reading order (top to bottom; left to right inside a line). */
export function wordsToLines(words: readonly LineWord[], opts: WordsToLinesOptions = {}): WordLine[] {
  const tol = opts.centreTol ?? DEFAULT_CENTRE_TOL;
  const splitGap = opts.splitGap;
  const items: Item[] = [];
  words.forEach((w, i) => {
    if (!w || !finiteBox(w.b)) return;
    items.push({ i, x0: w.b[0], x1: w.b[2], yc: (w.b[1] + w.b[3]) / 2, h: Math.max(w.b[3] - w.b[1], MIN_H) });
  });
  items.sort((a, b) => a.yc - b.yc || a.x0 - b.x0 || a.i - b.i);

  const rows: Item[][] = [];
  let cur: Item[] = [];
  let meanYc = 0;
  let maxH = 0;
  for (const it of items) {
    if (cur.length > 0 && Math.abs(it.yc - meanYc) <= tol * Math.max(it.h, maxH)) {
      cur.push(it);
      meanYc += (it.yc - meanYc) / cur.length;
      maxH = Math.max(maxH, it.h);
    } else {
      if (cur.length > 0) rows.push(cur);
      cur = [it];
      meanYc = it.yc;
      maxH = it.h;
    }
  }
  if (cur.length > 0) rows.push(cur);

  const out: WordLine[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x0 - b.x0 || a.yc - b.yc || a.i - b.i);
    if (splitGap === undefined || !Number.isFinite(splitGap)) {
      out.push(lineOf(words, row));
      continue;
    }
    const hs = row.map((it) => it.h).sort((a, b) => a - b);
    const gapMax = splitGap * hs[Math.floor(hs.length / 2)];
    let seg: Item[] = [];
    let segRight = -Infinity;
    for (const it of row) {
      if (seg.length > 0 && it.x0 - segRight > gapMax) {
        out.push(lineOf(words, seg));
        seg = [];
        segRight = -Infinity;
      }
      seg.push(it);
      segRight = Math.max(segRight, it.x1);
    }
    if (seg.length > 0) out.push(lineOf(words, seg));
  }
  return out;
}

/** Cell text in line-aware reading order: lines top to bottom, words left to right. */
export function assembleText(words: readonly LineWord[], opts: AssembleTextOptions = {}): string {
  const sep = opts.lineSep ?? " ";
  return wordsToLines(words, opts)
    .map((l) => l.text)
    .filter((t) => t !== "")
    .join(sep);
}

/**
 * Loader-edge adapter: legacy `{ text, bbox: LTWH }` words (TextractWord) → engine `LineWord`s,
 * index for index (a malformed box becomes NaN, which `wordsToLines` skips).
 */
export function lineWordsFromLtwh(words: readonly { text: string; bbox: Box }[]): LineWord[] {
  return words.map((w) => ({
    t: w.text,
    b: finiteBox(w.bbox) ? ltwhToMinMax(w.bbox) : [NaN, NaN, NaN, NaN],
  }));
}
