/**
 * rows/hanging-indent.ts — "a key opens a row; other lines continue it" (table pipeline WP-3.A; PLAN §1.4
 * `hanging-indent`, the engine's version of the notes binders' rule, INVENTORY §5b #11).
 *
 * The key column is the left-most cluster of line starts (first-word x0 within 0.5 h) that holds ≥ 3 lines
 * whose first word is key-like (`1` `1.` `(a)` `A.` `K-01` `1.01` `2.3`), with ≥ 60 % key-like starts, whose keys
 * share one printed format (`tag-mapping/primitives/pattern-infer`). A line
 * whose first word's centre lies in that column and is key-like opens a row; every other line continues the
 * open row; lines above the first key form one lead-in row (K35). Boundaries sit at the midpoint of the gap
 * between a row's last line and the next key line.
 *
 * It votes only when a key column exists (R8: weight .6 "only when a key column exists"); otherwise `error`.
 * Confidence = .5 + .4 × share of key-like starts in the column. Pure (E-7).
 */

import { inferTagPattern } from "@/lib/tag-mapping/primitives/pattern-infer";
import type { BboxMinMax } from "../types";
import type { RowHypothesis, RowsInput, RowsLine } from "../types-rows";

export const HANGING_INDENT_VERSION = 1;
/** A printed key: a number, a letter, a lettered/dotted path or a tag, optionally closed by `.` or `)`. */
export const KEY_LIKE_RE = /^\(?(?:\d{1,3}|[A-Za-z]|[A-Za-z]{1,3}-?\d{1,4}[A-Za-z]?|\d{1,2}(?:\.\d{1,2}){1,3})[.)]?:?$/;
const MIN_KEY_LINES = 3;
const MIN_KEY_SHARE = 0.6;

const yc = (b: BboxMinMax): number => (b[1] + b[3]) / 2;

interface Start { line: RowsLine; x0: number; x1: number; key: boolean }

/** The first word (smallest x0) of a line, and whether it is key-like. */
function startOf(input: RowsInput, line: RowsLine): Start | null {
  if (line.wordIdx.length === 0) return null;
  const first = line.wordIdx.map((i) => input.words[i]).sort((a, b) => a.b[0] - b.b[0] || a.b[1] - b.b[1])[0];
  return { line, x0: first.b[0], x1: first.b[2], key: KEY_LIKE_RE.test(first.t.trim()) };
}

/** The first word of a line, upper-cased and trimmed. */
function keyToken(input: RowsInput, line: RowsLine): string {
  const first = line.wordIdx.map((i) => input.words[i]).sort((a, b) => a.b[0] - b.b[0] || a.b[1] - b.b[1])[0];
  return (first?.t ?? "").trim().toUpperCase();
}

/** The key column `[x0, x1]` (first-word extent of the key lines) or null. */
export function findKeyColumn(input: RowsInput): { x0: number; x1: number; starts: Start[] } | null {
  const starts = input.lines.map((l) => startOf(input, l)).filter((s): s is Start => s !== null);
  if (starts.length < MIN_KEY_LINES) return null;
  const tol = 0.5 * input.h;
  const byX = [...starts].sort((a, b) => a.x0 - b.x0 || yc(a.line.b) - yc(b.line.b));
  const clusters: Start[][] = [];
  for (const s of byX) {
    const cur = clusters[clusters.length - 1];
    if (cur && s.x0 - cur[0].x0 <= tol) cur.push(s);
    else clusters.push([s]);
  }
  for (const c of clusters) { // left-most first
    const keys = c.filter((s) => s.key);
    if (keys.length < MIN_KEY_LINES || keys.length / c.length < MIN_KEY_SHARE) continue;
    // the keys must share one printed format (`1.` `2.` `3.`, `A` `B` `C`, `K-01` …): lines that merely start with
    // a number (quantities, dimensions) in a text column are not a key column (MEASURED on the private G-TAB gold)
    if (!inferTagPattern(keys.map((s) => keyToken(input, s.line)))) continue;
    return { x0: Math.min(...keys.map((s) => s.x0)), x1: Math.max(...keys.map((s) => s.x1)), starts: c };
  }
  return null;
}

export function hangingIndentRows(input: RowsInput): RowHypothesis {
  const base = { method: "hanging-indent" as const, methodVersion: HANGING_INDENT_VERSION };
  const col = findKeyColumn(input);
  if (!col) return { ...base, conf: 0, error: "no key column (need ≥ 3 key-like line starts in one column)" };
  const box = input.box;
  const clamp = (y: number): number => Math.min(box[3], Math.max(box[1], y));
  const lines = [...input.lines].sort((a, b) => yc(a.b) - yc(b.b) || a.b[0] - b.b[0]);
  const opens = new Set<RowsLine>(col.starts.filter((s) => s.key).map((s) => s.line));
  const rows: { y0: number; y1: number }[] = [];
  for (const l of lines) {
    if (opens.has(l) || rows.length === 0) rows.push({ y0: l.b[1], y1: l.b[3] });
    else { const r = rows[rows.length - 1]; r.y0 = Math.min(r.y0, l.b[1]); r.y1 = Math.max(r.y1, l.b[3]); }
  }
  if (rows.length < 2) return { ...base, conf: 0, error: "a key column but a single row" };
  const rowLines: number[] = [clamp(rows[0].y0)];
  for (let i = 1; i < rows.length; i++) rowLines.push(Math.max(rowLines[i - 1], clamp((rows[i - 1].y1 + rows[i].y0) / 2)));
  rowLines.push(Math.max(rowLines[rowLines.length - 1], clamp(rows[rows.length - 1].y1)));
  const share = col.starts.filter((s) => s.key).length / col.starts.length;
  return { ...base, conf: Math.round((0.5 + 0.4 * share) * 1000) / 1000, rowLines };
}
