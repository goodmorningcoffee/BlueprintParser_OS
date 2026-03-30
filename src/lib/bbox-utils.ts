/**
 * bbox-utils.ts
 *
 * Shared bounding box conversion and validation utilities.
 * Two bbox formats exist in the codebase:
 *   - BboxLTWH: [left, top, width, height]  — Textract OCR words, text regions, classified tables
 *   - BboxMinMax: [minX, minY, maxX, maxY]  — Annotations, YOLO detections, tableParseRegion
 * Both are normalized 0-1.
 *
 * Use these utilities instead of ad-hoc inline conversions.
 */

import type { BboxLTWH, BboxMinMax } from "@/types";

// ═══════════════════════════════════════════════════════════════════
// Format conversion
// ═══════════════════════════════════════════════════════════════════

/** Convert [left, top, width, height] → [minX, minY, maxX, maxY] */
export function ltwh2minmax(bbox: BboxLTWH): BboxMinMax {
  return [bbox[0], bbox[1], bbox[0] + bbox[2], bbox[1] + bbox[3]];
}

/** Convert [minX, minY, maxX, maxY] → [left, top, width, height] */
export function minmax2ltwh(bbox: BboxMinMax): BboxLTWH {
  return [bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1]];
}

// ═══════════════════════════════════════════════════════════════════
// Center point
// ═══════════════════════════════════════════════════════════════════

/** Get center point of an LTWH bbox */
export function bboxCenterLTWH(bbox: BboxLTWH): { cx: number; cy: number } {
  return { cx: bbox[0] + bbox[2] / 2, cy: bbox[1] + bbox[3] / 2 };
}

/** Get center point of a MinMax bbox */
export function bboxCenterMinMax(bbox: BboxMinMax): { cx: number; cy: number } {
  return { cx: (bbox[0] + bbox[2]) / 2, cy: (bbox[1] + bbox[3]) / 2 };
}

// ═══════════════════════════════════════════════════════════════════
// Containment & overlap
// ═══════════════════════════════════════════════════════════════════

/** Check if a point falls inside a MinMax bbox */
export function bboxContainsPoint(
  bbox: BboxMinMax,
  point: { x: number; y: number },
): boolean {
  return point.x >= bbox[0] && point.x <= bbox[2] && point.y >= bbox[1] && point.y <= bbox[3];
}

/** Compute overlap area between two MinMax bboxes (0 if no overlap) */
export function bboxOverlap(a: BboxMinMax, b: BboxMinMax): number {
  const intMinX = Math.max(a[0], b[0]);
  const intMinY = Math.max(a[1], b[1]);
  const intMaxX = Math.min(a[2], b[2]);
  const intMaxY = Math.min(a[3], b[3]);

  if (intMinX >= intMaxX || intMinY >= intMaxY) return 0;
  return (intMaxX - intMinX) * (intMaxY - intMinY);
}

/** Compute IoU (Intersection over Union) between two MinMax bboxes */
export function bboxIoU(a: BboxMinMax, b: BboxMinMax): number {
  const intersection = bboxOverlap(a, b);
  if (intersection === 0) return 0;

  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);
  const union = areaA + areaB - intersection;

  return union > 0 ? intersection / union : 0;
}

/** Compute area of a MinMax bbox */
export function bboxAreaMinMax(bbox: BboxMinMax): number {
  return Math.max(0, bbox[2] - bbox[0]) * Math.max(0, bbox[3] - bbox[1]);
}

/** Compute area of an LTWH bbox */
export function bboxAreaLTWH(bbox: BboxLTWH): number {
  return Math.max(0, bbox[2]) * Math.max(0, bbox[3]);
}

// ═══════════════════════════════════════════════════════════════════
// Validation
// ═══════════════════════════════════════════════════════════════════

/** Validate a bbox-like value. Returns error string or null if valid. */
export function validateBbox(
  bbox: unknown,
  format: "minmax" | "ltwh" = "minmax",
): string | null {
  if (!Array.isArray(bbox) || bbox.length !== 4) {
    return "bbox must be a 4-element array";
  }

  const [a, b, c, d] = bbox;
  if (![a, b, c, d].every((v) => typeof v === "number" && isFinite(v))) {
    return "bbox values must be finite numbers";
  }

  if (![a, b, c, d].every((v) => v >= 0 && v <= 1)) {
    return "bbox values must be in range [0, 1]";
  }

  if (format === "minmax" && (a >= c || b >= d)) {
    return "MinMax bbox: minX must be < maxX and minY must be < maxY";
  }

  if (format === "ltwh" && (c <= 0 || d <= 0)) {
    return "LTWH bbox: width and height must be > 0";
  }

  return null;
}

/** Type guard: is this a valid MinMax bbox? */
export function isValidMinMax(bbox: unknown): bbox is BboxMinMax {
  return validateBbox(bbox, "minmax") === null;
}

/** Type guard: is this a valid LTWH bbox? */
export function isValidLTWH(bbox: unknown): bbox is BboxLTWH {
  return validateBbox(bbox, "ltwh") === null;
}
