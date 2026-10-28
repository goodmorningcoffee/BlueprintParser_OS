/**
 * Tag column, anywhere (table pipeline WP-3.B; PLAN §1.4 R9). Pure, deterministic (E-7).
 *
 * Every column is considered; the classifier's left-share limit (`classifier-engine/shape-column.ts`
 * `DEFAULT_LEFT_SHARE = .25`, the detect half) is NOT applied here. Order (first that holds wins):
 * 1. `user` — an explicit column (a `set-tag-col` op or `hints.tagCol`), when it is in range;
 * 2. `shape` — the column holding a tag shape in the most body rows (shape centre inside the column and the
 *    row band, and the shape no larger than 1.5 × the band height / column width, so a table-cell rectangle
 *    never counts), at least 3 rows and half the body rows; `shapeClass` = its most frequent class;
 * 3. `header` — columns whose label names a tag (`roleOfLabel` = "tag"), arbitrated by the BODY: the
 *    candidate with the highest tag score wins, provided its score is ≥ .35 (row numbers score .35);
 * 4. `body` — the column whose filled values read as tags: score ≥ .5 (≥ .35 for keynotes and legends,
 *    whose keys are often bare numbers), filled in ≥ half the body rows, and ≥ 80 % distinct.
 * Ties go to the leftmost column.
 *
 * Tag score of one value (LabelFactory `tags.py` `is_tag_like` order): letters + digits (`RTU-1`, `A-101`,
 * `EF-10`) 1.0; letters only, ≤ 3 (`A`, `CL`) .8; digits only, ≤ 3 (`12`) .35; else 0 — dimensions
 * (`3'-0"`), words over 8 characters and the stop list (`TYP`, `NO`, `SEE`, …) score 0. The column score is
 * the mean over its non-empty body values. `pattern` is `inferTagPattern` over those values (regex source).
 * `scope`: "project" for schedules, "sheet" for keynotes and legends (PLAN §3.3 accept-tags defaults).
 */

import { inferTagPattern } from "@/lib/tag-mapping/primitives/pattern-infer";
import { roleOfLabel } from "./headers";
import type { BboxMinMax, StructureTableModel } from "./types";
import type { TagColumnPick } from "./types-cols";

export const TAG_COLUMN_VERSION = 1;
export const HEADER_TAG_MIN_SCORE = 0.35;
/** A tag shape fits its cell: at most this many times the row band's height and the column's width (a table-cell rectangle does not). */
const SHAPE_FIT = 1.5;
export const BODY_TAG_MIN_SCORE = 0.5;
/** Keynote and legend keys are often bare numbers (.35 each), so those kinds accept a numbered key column. */
export const BODY_KEY_MIN_SCORE = 0.35;

const STOP = new Set([
  "NO", "ID", "QTY", "TYP", "REF", "DIM", "MIN", "MAX", "GA", "EA", "SF", "LF", "AFF", "TYPE", "MARK", "SYM", "TAG",
  "SIZE", "CFM", "GPM", "RPM", "HP", "KW", "V", "PH", "HZ", "MCA", "MOP", "NOTES", "REMARKS", "SEE", "ON", "ALL",
  "AND", "OF", "TO", "AT", "BY", "OR", "AS", "IN", "IS", "PER", "USE", "NEW", "NTS", "RE", "X", "O", "W", "N", "S",
  "PLAN", "VIF", "DWG", "SHT", "REQ", "ETC", "MTL",
]);
const RE_DIMENSION = /^\d+['"]|^\d+\/\d+"?$|\d+'-\d+/;
const RE_TAG = /^[A-Z]{1,4}[-.]?\d{1,4}[A-Z]?$|^[A-Z]{1,3}\d{0,3}[-.]\d{1,3}$/;
const RE_ALPHA = /^[A-Z]{1,3}$/;
const RE_DIGITS = /^\d{1,3}$/;

/** Tag-likeness of one cell value (see the file header). */
export function tagValueScore(value: string): number {
  const t = value.trim().toUpperCase().replace(/^[.:;,()[\]]+|[.:;,()[\]]+$/g, "");
  if (!t || STOP.has(t) || RE_DIMENSION.test(t) || t.length > 8) return 0;
  if (RE_TAG.test(t) && /\d/.test(t)) return 1;
  if (RE_ALPHA.test(t)) return 0.8;
  if (RE_DIGITS.test(t)) return 0.35;
  return 0;
}

export interface TagColumnInput {
  kind: StructureTableModel["kind"];
  /** The table's columns, left to right (x extent and printed label). */
  cols: readonly { x0: number; x1: number; label: string }[];
  /** Body rows × columns, cell text. */
  body: readonly (readonly string[])[];
  /** Body row bands [y0, y1] (same order as `body`), for shape alignment. */
  bodyBands?: readonly (readonly [number, number])[];
  /** The fused shape set (yolo ∪ classical, R10) on this page. */
  shapes?: readonly { b: BboxMinMax; cls: string }[];
  /** A user-chosen column index (wins when in range). */
  user?: number | null;
}

interface ColStats { score: number; filled: number; distinct: number; values: string[] }

function statsOf(body: TagColumnInput["body"], c: number): ColStats {
  const values = body.map((row) => (row[c] ?? "").replace(/\s+/g, " ").trim()).filter((v) => v !== "");
  const score = values.length ? values.reduce((s, v) => s + tagValueScore(v), 0) / values.length : 0;
  return {
    score,
    filled: body.length ? values.length / body.length : 0,
    distinct: values.length ? new Set(values.map((v) => v.toUpperCase())).size / values.length : 0,
    values,
  };
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000;

/** The tag column of a table, or null when no rule holds. */
export function pickTagColumn(input: TagColumnInput): TagColumnPick | null {
  const n = input.cols.length;
  if (n === 0) return null;
  const scope = input.kind === "schedule" ? "project" : "sheet";
  const stats = input.cols.map((_, c) => statsOf(input.body, c));
  const finish = (col: number, src: TagColumnPick["src"], shapeClass?: string): TagColumnPick => {
    const out: TagColumnPick = { col, src, score: r3(stats[col].score), scope };
    if (shapeClass) out.shapeClass = shapeClass;
    const p = inferTagPattern(stats[col].values);
    if (p) out.pattern = p.pattern.source;
    return out;
  };

  if (input.user !== undefined && input.user !== null && Number.isInteger(input.user) && input.user >= 0 && input.user < n) return finish(input.user, "user");

  const bands = input.bodyBands ?? [];
  if (input.shapes?.length && bands.length === input.body.length && bands.length > 0) {
    const counts = input.cols.map(() => new Map<string, number>());
    const rowsWith = input.cols.map(() => 0);
    bands.forEach(([y0, y1]) => {
      const seen = new Set<number>();
      for (const s of input.shapes!) {
        const cx = (s.b[0] + s.b[2]) / 2;
        const cy = (s.b[1] + s.b[3]) / 2;
        if (cy < y0 || cy >= y1 || s.b[3] - s.b[1] > SHAPE_FIT * (y1 - y0)) continue;
        const c = input.cols.findIndex((col) => cx >= col.x0 && cx < col.x1);
        if (c < 0 || s.b[2] - s.b[0] > SHAPE_FIT * (input.cols[c].x1 - input.cols[c].x0)) continue;
        counts[c].set(s.cls, (counts[c].get(s.cls) ?? 0) + 1);
        seen.add(c);
      }
      seen.forEach((c) => { rowsWith[c]++; });
    });
    let best = -1;
    rowsWith.forEach((k, c) => { if (k > (best < 0 ? 0 : rowsWith[best])) best = c; });
    if (best >= 0 && rowsWith[best] >= 3 && rowsWith[best] >= 0.5 * bands.length) {
      const cls = [...counts[best]].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0]?.[0];
      return finish(best, "shape", cls);
    }
  }

  const nominated = input.cols.map((col, c) => (roleOfLabel(col.label) === "tag" ? c : -1)).filter((c) => c >= 0);
  let bestHeader = -1;
  for (const c of nominated) if (bestHeader < 0 || stats[c].score > stats[bestHeader].score) bestHeader = c;
  if (bestHeader >= 0 && stats[bestHeader].score >= HEADER_TAG_MIN_SCORE) return finish(bestHeader, "header");

  let bestBody = -1;
  const bodyMin = input.kind === "schedule" ? BODY_TAG_MIN_SCORE : BODY_KEY_MIN_SCORE;
  stats.forEach((s, c) => {
    if (s.score < bodyMin || s.filled < 0.5 || s.distinct < 0.8) return;
    if (bestBody < 0 || s.score > stats[bestBody].score) bestBody = c;
  });
  return bestBody >= 0 ? finish(bestBody, "body") : null;
}
