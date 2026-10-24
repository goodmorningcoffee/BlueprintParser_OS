/**
 * region-classifier-v2/geometry.ts — the MinMax box arithmetic of corpus_v2 `regions_rc.py`
 * (area / inter / iou / inside / cover / text_grid / widening), reproduced term for term so the
 * parity script can compare against the Python reference. Pure.
 */

import type { BboxMinMax } from "@/types";

export const area = (b: BboxMinMax): number => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);

export const inter = (a: BboxMinMax, b: BboxMinMax): number =>
  Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
  Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));

export function iou(a: BboxMinMax, b: BboxMinMax): number {
  const i = inter(a, b);
  const u = area(a) + area(b) - i;
  return u > 0 ? i / u : 0;
}

/** Intersection / smaller area (containment either way); 0 for a degenerate box. */
export function overlapSmaller(a: BboxMinMax, b: BboxMinMax): number {
  const mn = Math.min(area(a), area(b));
  return mn > 0 ? inter(a, b) / mn : 0;
}

export const center = (b: BboxMinMax): [number, number] => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];

export const inside = (c: readonly [number, number], b: BboxMinMax): boolean =>
  b[0] <= c[0] && c[0] <= b[2] && b[1] <= c[1] && c[1] <= b[3];

/** LTWH → MinMax (TextRegion / Textract geometry → ours). */
export const ltwhToMinMax = (b: readonly [number, number, number, number]): BboxMinMax => [b[0], b[1], b[0] + b[2], b[1] + b[3]];

/** MinMax → LTWH. */
export const minMaxToLtwh = (b: BboxMinMax): [number, number, number, number] => [b[0], b[1], b[2] - b[0], b[3] - b[1]];

/**
 * Share of the box `T` covered by the union of `boxes`, sampled on an n×n grid of cell centres
 * (regions_rc.py `cover`, n = 24).
 */
export function cover(T: BboxMinMax, boxes: readonly BboxMinMax[], n = 24): number {
  if (boxes.length === 0) return 0;
  const w = T[2] - T[0];
  const h = T[3] - T[1];
  let hit = 0;
  for (let iy = 0; iy < n; iy++) {
    const y = T[1] + ((iy + 0.5) / n) * h;
    for (let ix = 0; ix < n; ix++) {
      const x = T[0] + ((ix + 0.5) / n) * w;
      for (const b of boxes) {
        if (x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]) { hit++; break; }
      }
    }
  }
  return hit / (n * n);
}

/** Number of 1-D clusters (gap > tol starts a new one) holding at least k values. */
function clusters(values: number[], tol: number, k: number): number {
  const v = [...values].sort((a, b) => a - b);
  let n = 0;
  let c = 1;
  for (let i = 1; i < v.length; i++) {
    if (v[i] - v[i - 1] > tol) { n += c >= k ? 1 : 0; c = 1; } else c++;
  }
  return n + (c >= k ? 1 : 0);
}

/**
 * yolo_text line boxes inside a region → { lines, rows, cols } (regions_rc.py `text_grid`):
 * rows = y-centre clusters (gap > .6 × median line height) with ≥ 2 boxes; cols = left-edge
 * clusters (gap > .5 × median height) with ≥ 3 boxes. Fewer than 6 boxes ⇒ no grid.
 */
export function textGrid(boxes: readonly BboxMinMax[]): { lines: number; rows: number; cols: number } {
  if (boxes.length < 6) return { lines: boxes.length, rows: 0, cols: 0 };
  const hs = boxes.map((b) => b[3] - b[1]).sort((a, b) => a - b);
  const mh = Math.max(hs[Math.floor(hs.length / 2)], 1e-4);
  return {
    lines: boxes.length,
    rows: clusters(boxes.map((b) => (b[1] + b[3]) / 2), 0.6 * mh, 2),
    cols: clusters(boxes.map((b) => b[0]), 0.5 * mh, 3),
  };
}

export interface Widened {
  bbox: BboxMinMax;
  /** area-box labels that supported the anchor (smaller / inside / widening), with counts. */
  support: Record<string, number>;
  /** area-box labels the box was widened toward, with counts. */
  grown: Record<string, number>;
}

/**
 * Widen the anchor `T` toward yolo_primitive area boxes (regions_rc.py l1_page): a box no larger
 * than `T`, or ≥ 80 % inside it, is support only; a larger box covering < 30 % of `T` is ignored;
 * a larger one covering ≥ 30 % widens `T` toward it, each side growing at most 2 × T's width /
 * height, clipped to the page.
 */
export function widenToward(T: BboxMinMax, areas: ReadonlyArray<{ label: string; bbox: BboxMinMax }>): Widened {
  const aT = area(T);
  const w = T[2] - T[0];
  const h = T[3] - T[1];
  let S: BboxMinMax = [...T] as BboxMinMax;
  const support: Record<string, number> = {};
  const grown: Record<string, number> = {};
  for (const { label, bbox: b } of areas) {
    const i = inter(T, b);
    if (i <= 0) continue;
    if (area(b) <= aT || i >= 0.8 * area(b)) { support[label] = (support[label] ?? 0) + 1; continue; }
    if (i < 0.3 * aT) continue;
    support[label] = (support[label] ?? 0) + 1;
    grown[label] = (grown[label] ?? 0) + 1;
    S = [
      Math.max(Math.min(S[0], b[0]), T[0] - 2 * w),
      Math.max(Math.min(S[1], b[1]), T[1] - 2 * h),
      Math.min(Math.max(S[2], b[2]), T[2] + 2 * w),
      Math.min(Math.max(S[3], b[3]), T[3] + 2 * h),
    ];
  }
  return { bbox: [Math.max(0, S[0]), Math.max(0, S[1]), Math.min(1, S[2]), Math.min(1, S[3])], support, grown };
}

export const round5 = (v: number): number => Math.round(v * 1e5) / 1e5;
