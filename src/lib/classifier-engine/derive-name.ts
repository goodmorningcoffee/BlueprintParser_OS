/**
 * classifier-engine/derive-name.ts — the printed title of a candidate box: the most title-like
 * line in the header band (top rows of the box) or just above it (titles often sit outside the
 * detector box), cleaned of scale text, detail bubbles and leading numbers. Pure; unit-tested
 * with synthetic words.
 *
 * Score per line: title keyword (SCHEDULE / LEGEND / LIST / TABLE / NOTES / KEY …) +1; taller than
 * the box's text (≥ 1.25×) +.5 (≥ 1.1× +.25); topmost in-box row +.25; mostly digits −.75; more
 * than 10 words −.5; a line above the box −.15 unless it carries a keyword. Confidence =
 * .3 + .4 × score, clamped to [0, 1] — a keyword alone is .7, keyword + tallest + topmost is 1.
 */

import type { EvLine } from "./evidence";

export const TITLE_KEYWORD = /\b(SCHEDULES?|SCHED\.?|LEGENDS?|LIST|TABLE|NOTES|KEY|KEYNOTES|KEYED|ABBREVIATIONS|INDEX|MATRIX|SUMMARY)\b/;
/** A derived name at or above this confidence is shown as the display name of a fallback proposal. */
export const CONFIDENT_NAME = 0.6;

export interface DeriveNameInput {
  /** The first rows inside the box (top to bottom). */
  headerRows: readonly (readonly EvLine[])[];
  /** Rows just above the box (top to bottom). */
  aboveRows: readonly (readonly EvLine[])[];
  /** Median word height of the box's text. */
  lineHeight: number;
}

export interface DerivedLine { text: string; confidence: number; source: "header" | "above"; line: string }

const SCALE = [
  /\bSCALE\s*[:=]?\s*[0-9/'"″′\-=\s.]*(?:[0-9]'-?[0-9]*"?)?/g,
  /\b(?:NOT TO SCALE|N\.?T\.?S\.?)\b/g,
  /\b[0-9]+(?:\/[0-9]+)?"\s*=\s*[0-9]+'(?:-?[0-9]+")?/g,
  /\b[0-9]+(?:\/[0-9]+)?\s*"\s*=\s*[0-9]+'-?[0-9]*"?/g,
];
/** Detail bubbles / view numbers: "3", "A1", "3/A-501", "1.", "12)". */
const LEADING_BUBBLE = /^(?:[A-Z]?[0-9]{1,2}(?:\.[0-9]+)?\s*(?:\/\s*[A-Z]{1,3}[-.]?[0-9]{1,3}(?:\.[0-9]+)?)?\s*[.):-]?\s+)+/;
const LEADING_NUMBER = /^[0-9]+[.):-]?\s+/;

export function cleanTitle(raw: string): string {
  let t = raw.toUpperCase().replace(/\s+/g, " ").trim();
  for (const re of SCALE) t = t.replace(re, " ");
  t = t.replace(/\s+/g, " ").trim();
  t = t.replace(LEADING_BUBBLE, "").replace(LEADING_NUMBER, "");
  t = t.replace(/^[^A-Z0-9(]+/, "").replace(/[\s:;,.\-–—]+$/, "").trim();
  return t.replace(/\s+/g, " ");
}

const digitShare = (text: string): number => {
  const toks = text.split(/\s+/).filter(Boolean);
  return toks.length ? toks.filter((t) => /[0-9]/.test(t)).length / toks.length : 0;
};

export function deriveName(input: DeriveNameInput): DerivedLine | undefined {
  let best: DerivedLine | undefined;
  let bestScore = -Infinity;
  const consider = (line: EvLine, source: "header" | "above", topmost: boolean) => {
    const text = cleanTitle(line.text);
    if (!text || !/[A-Z]/.test(text)) return;
    let score = 0;
    const kw = TITLE_KEYWORD.test(text);
    if (kw) score += 1;
    const ratio = input.lineHeight > 0 ? line.h / input.lineHeight : 1;
    if (ratio >= 1.25) score += 0.5; else if (ratio >= 1.1) score += 0.25;
    if (topmost) score += 0.25;
    if (digitShare(text) >= 0.5) score -= 0.75;
    if (text.split(" ").length > 10) score -= 0.5;
    if (source === "above" && !kw) score -= 0.15;
    // A joined row ties with its own best segment on score; prefer the fuller text.
    if (score > bestScore || (score === bestScore && best && text.length > best.text.length && text.includes(best.text))) {
      bestScore = score;
      best = { text, confidence: Math.max(0, Math.min(1, Math.round((0.3 + 0.4 * score) * 100) / 100)), source, line: line.text };
    }
  };
  // Each segment on its own, then the whole row joined (a title set loose across two segments, or a
  // title followed by its scale text, reads as one line; the cleaner strips the scale).
  const rowLine = (row: readonly EvLine[]): EvLine | null => row.length > 1
    ? { words: row.flatMap((l) => l.words), text: row.map((l) => l.text).join(" "), bbox: row[0].bbox, c: row[0].c, h: Math.max(...row.map((l) => l.h)) }
    : null;
  input.aboveRows.forEach((row) => { row.forEach((l) => consider(l, "above", false)); const r = rowLine(row); if (r) consider(r, "above", false); });
  input.headerRows.forEach((row, i) => { row.forEach((l) => consider(l, "header", i === 0)); const r = rowLine(row); if (r) consider(r, "header", i === 0); });
  return best;
}
