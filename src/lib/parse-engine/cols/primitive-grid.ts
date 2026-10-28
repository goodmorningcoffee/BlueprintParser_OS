/**
 * `primitive-grid` column method (table pipeline WP-3.B; PLAN §1.4). Pure, deterministic (E-7).
 *
 * Column-separator CANDIDATES from yolo_primitive boxes. A `vertical_area` box is read as one column-like
 * strip (INFERRED from the class name and region-v2's use of it as table cover, `region-classifier-v2/
 * classify.ts`; not measured per column): it counts when ≥ 50 % of its area lies in the parse box and it
 * is at least 30 % of the box tall. Its left and right edges are separator candidates; candidates within
 * `gap` (default: the table-relative gap of the box width) of each other or of a box edge are merged
 * (cluster mean). `grid` and `horizontal_area` boxes give no column separator (a `grid` is the whole
 * table; `horizontal_area` is the row axis, WP-3.A `rows/primitive-grid.ts`).
 * Lines = [box x0, …candidates…, box x1]. `conf` = .5 (the profile weight carries the trust, R8).
 */

import type { BboxMinMax, EnginePageEvidence } from "../types";
import type { ColumnHypothesis } from "../types-cols";
import { tableRelativeGap } from "./x-starts";

export const PRIMITIVE_GRID_COLS_VERSION = 1;
const MIN_INSIDE = 0.5;
const MIN_HEIGHT_SHARE = 0.3;

function insideShare(b: BboxMinMax, box: BboxMinMax): number {
  const w = Math.min(b[2], box[2]) - Math.max(b[0], box[0]);
  const h = Math.min(b[3], box[3]) - Math.max(b[1], box[1]);
  const area = (b[2] - b[0]) * (b[3] - b[1]);
  return w > 0 && h > 0 && area > 0 ? (w * h) / area : 0;
}

export function primitiveGridColumns(primitives: EnginePageEvidence["primitives"], box: BboxMinMax, gap = tableRelativeGap(box[2] - box[0])): ColumnHypothesis {
  const base = { method: "primitive-grid" as const, methodVersion: PRIMITIVE_GRID_COLS_VERSION };
  const strips = primitives.filter((p) => p.cls === "vertical_area" && insideShare(p.b, box) >= MIN_INSIDE && (p.b[3] - p.b[1]) >= MIN_HEIGHT_SHARE * (box[3] - box[1]));
  const edges = strips
    .flatMap((p) => [p.b[0], p.b[2]])
    .filter((x) => x > box[0] + gap && x < box[2] - gap)
    .sort((a, b) => a - b);
  const groups: number[][] = [];
  for (const x of edges) {
    const g = groups[groups.length - 1];
    if (g && x - g[g.length - 1] <= gap) g.push(x);
    else groups.push([x]);
  }
  if (!groups.length) return { ...base, conf: 0, colLines: [], error: "no vertical_area separator inside the box" };
  const inner = groups.map((g) => g.reduce((s, x) => s + x, 0) / g.length);
  return { ...base, conf: 0.5, colLines: [box[0], ...inner, box[2]] };
}
