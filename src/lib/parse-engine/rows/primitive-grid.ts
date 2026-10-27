/**
 * rows/primitive-grid.ts — separator candidates from yolo_primitive grid shapes (table pipeline WP-3.A;
 * PLAN §1.4 `primitive-grid`; the engine's reading of what region-v2's `geometry.cover` only counted).
 *
 * Primitives whose centre lies inside the box:
 * - `horizontal_area` at least `MIN_RULE_SHARE` of the box wide: one row boundary at its y-centre (a ruled line
 *   or a filled band between rows);
 * - `grid`: its top and bottom edges as boundaries (the table's extent) and its left/right edges as columns;
 * - `vertical_area`: one column candidate at its x-centre (`colLines`, read by WP-3.B).
 * Confidence = min(1, n / 3) over the row candidates. Nothing inside → `error`, no vote. Pure (E-7).
 */

import { centreIn } from "../geometry";
import type { RowHypothesis, RowsInput } from "../types-rows";

export const PRIMITIVE_GRID_VERSION = 1;
/** A horizontal area narrower than this share of the box is a cell fill, not a row separator. */
export const MIN_RULE_SHARE = 0.3;

export function primitiveGridRows(input: RowsInput): RowHypothesis {
  const base = { method: "primitive-grid" as const, methodVersion: PRIMITIVE_GRID_VERSION };
  const box = input.box;
  const prims = input.primitives.filter((p) => centreIn(p.b, box));
  if (prims.length === 0) return { ...base, conf: 0, error: "no grid primitive inside the box" };
  const clampY = (y: number): number => Math.min(box[3], Math.max(box[1], y));
  const clampX = (x: number): number => Math.min(box[2], Math.max(box[0], x));
  const ys = new Set<number>();
  const xs = new Set<number>();
  const minW = MIN_RULE_SHARE * (box[2] - box[0]);
  for (const p of prims) {
    if (p.cls === "horizontal_area") {
      if (p.b[2] - p.b[0] >= minW) ys.add(clampY((p.b[1] + p.b[3]) / 2));
    } else if (p.cls === "vertical_area") {
      xs.add(clampX((p.b[0] + p.b[2]) / 2));
    } else {
      ys.add(clampY(p.b[1]));
      ys.add(clampY(p.b[3]));
      xs.add(clampX(p.b[0]));
      xs.add(clampX(p.b[2]));
    }
  }
  const rowLines = [...ys].sort((a, b) => a - b);
  const colLines = [...xs].sort((a, b) => a - b);
  if (rowLines.length === 0 && colLines.length === 0) return { ...base, conf: 0, error: "grid primitives inside the box give no separator" };
  const conf = Math.round(Math.min(1, rowLines.length / 3) * 1000) / 1000;
  return { ...base, conf, rowLines: rowLines.length ? rowLines : undefined, colLines: colLines.length ? colLines : undefined };
}
