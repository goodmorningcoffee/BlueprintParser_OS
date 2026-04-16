/**
 * primitives/region-weight.ts — Point-in-region classification + weight lookup.
 *
 * Consumer-agnostic. Given a point and a RegionLookup, decide which region
 * type contains it (applying the same precedence as
 * composite-classifier.applyExclusionFilter: title_block > tables > drawings),
 * then return the configured weight for that region type.
 *
 * Reused by tag-mapping's matchers today; future note-mapping or
 * spec-reference mapping will import this unchanged.
 */

import { bboxContainsPoint } from "@/lib/bbox-utils";
import type { RegionType, RegionLookup, ScoringConfig } from "../types";

/**
 * Resolve the region type containing the given point, applying the precedence
 * title_block > tables > drawings. Returns "unclassified" when no region
 * contains the point — both for pre-YOLO projects (empty lookup) and for
 * matches that genuinely fall outside every classified region.
 *
 * NOTE on "outside_drawings": the existing applyExclusionFilter treats a
 * match as outside_drawings only when the page HAS drawings regions and the
 * point is NOT inside any. This function can't encode that (it doesn't know
 * whether the page has drawings unless drawings.length > 0 in the lookup);
 * callers resolve this in score-compose using `drawings.length > 0`.
 */
export function resolveRegionType(
  point: { x: number; y: number },
  regions: RegionLookup | undefined,
): RegionType {
  if (!regions) return "unclassified";

  // Precedence must match composite-classifier.applyExclusionFilter:
  //   1. title_block  (highest priority)
  //   2. tables
  //   3. drawings
  if (regions.titleBlocks.some((r) => bboxContainsPoint(r.bbox, point))) {
    return "title_block";
  }
  if (regions.tables.some((r) => bboxContainsPoint(r.bbox, point))) {
    return "tables";
  }
  if (regions.drawings.some((r) => bboxContainsPoint(r.bbox, point))) {
    return "drawings";
  }
  return "unclassified";
}

/** Look up the weight for a region type from the scoring config. */
export function weightFor(regionType: RegionType, config: ScoringConfig): number {
  return config.regionWeights[regionType];
}
