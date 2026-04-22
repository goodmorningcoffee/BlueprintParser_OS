/**
 * overlap-signals.ts
 *
 * Axis-aligned bbox overlap metrics. Used by text-region-classifier Stage D
 * to draw merge edges between Stage B cluster candidates.
 *
 * Inspired by Docling's LayoutPostprocessor, which merges regions when
 * IoU > threshold OR when either containment ratio exceeds its threshold.
 * The containment-ratio signal catches nested-box cases (e.g., a legend cell
 * inside a legend frame) that pure IoU misses.
 *
 * All functions operate on BboxLTWH = [left, top, width, height] in whatever
 * coordinate system the caller uses (normalized 0-1 is typical for our
 * pipeline but the math is coordinate-system-agnostic).
 */

import type { BboxLTWH } from "@/types";

/** Area of a box. Returns 0 for degenerate (non-positive width/height) boxes. */
export function area(b: BboxLTWH): number {
  const w = b[2];
  const h = b[3];
  if (w <= 0 || h <= 0) return 0;
  return w * h;
}

/** Area of intersection between two bboxes. 0 if they don't overlap. */
export function intersectionArea(a: BboxLTWH, b: BboxLTWH): number {
  const left = Math.max(a[0], b[0]);
  const top = Math.max(a[1], b[1]);
  const right = Math.min(a[0] + a[2], b[0] + b[2]);
  const bottom = Math.min(a[1] + a[3], b[1] + b[3]);
  const w = right - left;
  const h = bottom - top;
  if (w <= 0 || h <= 0) return 0;
  return w * h;
}

/**
 * Intersection-over-Union. Symmetric.
 * 0 if either box is degenerate or they don't overlap.
 * 1 if the boxes are identical and non-degenerate.
 */
export function iou(a: BboxLTWH, b: BboxLTWH): number {
  const inter = intersectionArea(a, b);
  if (inter === 0) return 0;
  const union = area(a) + area(b) - inter;
  if (union <= 0) return 0;
  return inter / union;
}

/**
 * Intersection-over-Self of box A: what fraction of A is covered by B.
 * 0 if A is degenerate or boxes don't overlap. 1 if A is fully inside B.
 */
export function iosA(a: BboxLTWH, b: BboxLTWH): number {
  const aArea = area(a);
  if (aArea === 0) return 0;
  return intersectionArea(a, b) / aArea;
}

/**
 * Intersection-over-Self of box B: what fraction of B is covered by A.
 * 0 if B is degenerate or boxes don't overlap. 1 if B is fully inside A.
 */
export function iosB(a: BboxLTWH, b: BboxLTWH): number {
  const bArea = area(b);
  if (bArea === 0) return 0;
  return intersectionArea(a, b) / bArea;
}

/** Max of `iosA` and `iosB` — the "containment signal" used by Docling's merge. */
export function maxContainment(a: BboxLTWH, b: BboxLTWH): number {
  return Math.max(iosA(a, b), iosB(a, b));
}
