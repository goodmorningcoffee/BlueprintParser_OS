/**
 * classifier-engine/spatial.ts — the legacy heuristic engine's spatial conditions between two YOLO classes
 * on one page ("yolo-spatial" signal, [2b] heuristic port). Same arithmetic as `evalSpatialCondition` in
 * src/lib/heuristic-engine.ts (kept there for the comparison test): centre containment, > 30 % overlap of
 * the A box, centre distance (default .1), and .03 centre alignment. Pure.
 */

import type { EvDetection } from "./evidence";
import type { SignalSpec } from "./types";

type Spatial = Extract<SignalSpec, { type: "yolo-spatial" }>;
type Box = EvDetection["bbox"];

/** Overlap share of the A box above which "overlaps" holds. */
export const SPATIAL_OVERLAP_SHARE = 0.3;
/** Default centre distance for "near" (page units). */
export const SPATIAL_NEAR_DEFAULT = 0.1;
/** Centre tolerance for "aligned" (page units). */
export const SPATIAL_ALIGN_TOLERANCE = 0.03;

const cx = (b: Box): number => (b[0] + b[2]) / 2;
const cy = (b: Box): number => (b[1] + b[3]) / 2;
const centreIn = (b: Box, a: Box): boolean => cx(b) >= a[0] && cx(b) <= a[2] && cy(b) >= a[1] && cy(b) <= a[3];

function overlapArea(a: Box, b: Box): number {
  return Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
}

function aligned(inside: Box[], minInstances: number, pick: (b: Box) => number): boolean {
  const cs = inside.map(pick);
  const mean = cs.reduce((s, v) => s + v, 0) / cs.length;
  return cs.filter((v) => Math.abs(v - mean) < SPATIAL_ALIGN_TOLERANCE).length >= minInstances;
}

export function yoloSpatialHolds(spec: Spatial, detections: readonly EvDetection[]): boolean {
  const A = detections.filter((d) => d.name === spec.classA).map((d) => d.bbox);
  if (!A.length) return false;
  const B = detections.filter((d) => (spec.classB === "*" ? d.name !== spec.classA : d.name === spec.classB)).map((d) => d.bbox);
  if (!B.length) return false;
  switch (spec.operator) {
    case "contains": {
      const min = spec.minInstances || 1;
      return A.some((a) => B.filter((b) => centreIn(b, a)).length >= min);
    }
    case "overlaps":
      return A.some((a) => {
        const aArea = (a[2] - a[0]) * (a[3] - a[1]);
        return B.some((b) => aArea > 0 && overlapArea(a, b) / aArea > SPATIAL_OVERLAP_SHARE);
      });
    case "near": {
      const max = spec.maxDistance || SPATIAL_NEAR_DEFAULT;
      return A.some((a) => B.some((b) => Math.sqrt((cx(a) - cx(b)) ** 2 + (cy(a) - cy(b)) ** 2) <= max));
    }
    case "aligned": {
      const min = spec.minInstances || 3;
      const axis = spec.axis || "any";
      return A.some((a) => {
        const inside = B.filter((b) => centreIn(b, a));
        if (inside.length < min) return false;
        return ((axis === "vertical" || axis === "any") && aligned(inside, min, cx))
          || ((axis === "horizontal" || axis === "any") && aligned(inside, min, cy));
      });
    }
    default:
      return false;
  }
}
