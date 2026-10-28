/**
 * `rulings` method, pure half (table pipeline WP-3.B; PLAN §1.4, K16). Deterministic (E-7).
 *
 * The server half (`server/services/parse-engine/rulings.ts`) runs `scripts/detect_table_lines.py --crop`
 * on the box's crop of the page image and returns line positions normalised to the CROP. This module maps
 * them onto the page and into a hypothesis that proposes BOTH axes (one method, one vote per axis, R7):
 * - positions are mapped `crop.x0 + x × crop.width` (rows alike; `crop` = the whole-pixel crop the script
 *   reports, else the requested one), sorted, and de-duplicated within `1e-4`;
 * - lines outside the box (beyond a tolerance of 0.5 % of its size) are dropped;
 * - an axis needs ≥ 2 lines (one band) to propose anything; with fewer it is omitted. With neither axis the
 *   hypothesis carries `error` (R1: a failed method casts no vote).
 * The detected lines are the table's own rules, so the outer lines are NOT forced to the box edges; fusion
 * decides what the box edges are.
 */

import type { BboxMinMax } from "../types";
import type { ColumnHypothesis, CropRulings } from "../types-cols";

export const RULINGS_VERSION = 1;
const DEDUPE = 1e-4;
const OUTSIDE_TOL = 0.005;

function axis(positions: readonly number[], lo: number, size: number, boxLo: number, boxHi: number): number[] {
  const tol = OUTSIDE_TOL * (boxHi - boxLo);
  const mapped = positions
    .filter((v) => Number.isFinite(v))
    .map((v) => lo + v * size)
    .filter((v) => v >= boxLo - tol && v <= boxHi + tol)
    .sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of mapped) if (!out.length || v - out[out.length - 1] > DEDUPE) out.push(v);
  return out.length >= 2 ? out : [];
}

/** Page-space row and column lines from crop rulings. `requested` is the page box asked for (the script's reported whole-pixel crop wins); `box` is the parse box. */
export function rulingsHypothesis(r: CropRulings, requested: BboxMinMax, box: BboxMinMax = requested): ColumnHypothesis {
  const base = { method: "rulings" as const, methodVersion: RULINGS_VERSION };
  if (r.error) return { ...base, conf: 0, colLines: [], error: r.error };
  const crop = r.crop ?? requested; // the whole-pixel crop the script cut
  const w = crop[2] - crop[0];
  const h = crop[3] - crop[1];
  if (!(w > 0 && h > 0)) return { ...base, conf: 0, colLines: [], error: "invalid crop" };
  const colLines = axis(r.cols, crop[0], w, box[0], box[2]);
  const rowLines = axis(r.rows, crop[1], h, box[1], box[3]);
  if (!colLines.length && !rowLines.length) return { ...base, conf: 0, colLines: [], error: "no ruled lines in the box" };
  const conf = Number.isFinite(r.confidence) ? Math.max(0, Math.min(1, r.confidence)) : 0;
  return { ...base, conf, colLines, ...(rowLines.length ? { rowLines } : {}) };
}
