/**
 * find-occurrences.ts — Tag-mapping orchestrator.
 *
 * Dispatches a CountableItem to the right matcher (Types 1-5), then scores
 * each raw match via the primitives pipeline (region-weight + score-compose)
 * and returns ScoredMatch[] sorted by score descending.
 *
 * Key design note: this is the ONE new entry point. The legacy
 * `findItemOccurrences` from yolo-tag-engine.ts becomes a shim that calls
 * this with a default MatchContext and strips the scoring fields via
 * legacy.toYoloTagInstances.
 */

import type { YoloTagInstance, ClassifiedPageRegions } from "@/types";
import { bboxCenterMinMax } from "@/lib/bbox-utils";
import type {
  CountableItem,
  MatchContext,
  ScoredMatch,
  ScoreSignals,
  RegionLookup,
  ScoringConfig,
} from "./types";
import { DEFAULT_SCORING_CONFIG } from "./types";
import { resolveRegionType, weightFor } from "./primitives/region-weight";
import { composeScore } from "./primitives/score-compose";

import { findYoloOnlyMatches } from "./matchers/type1-yolo-only";
import { findFreeFloatingMatches } from "./matchers/type2-text-only";
import {
  findYoloMatches,
  mergeYoloAndFloatingHits,
} from "./matchers/type3-yolo-with-inner-text";
import { findObjectWithTagShapeMatches } from "./matchers/type4-yolo-object-with-tag-shape";
import { findObjectWithNearbyTextMatches } from "./matchers/type5-yolo-object-with-nearby-text";

/**
 * Dispatch a CountableItem to the right matcher. Returns raw instances
 * before scoring; the orchestrator wraps each with ScoreSignals via
 * `scoreRawMatches` below.
 */
function dispatchMatcher(item: CountableItem, ctx: MatchContext): YoloTagInstance[] {
  const scopeLegacy: "page" | "project" = ctx.isPageScoped ? "page" : "project";
  const pageNumber = ctx.pageNumber;

  switch (item.itemType) {
    case "yolo-only":
      if (!item.yoloClass) return [];
      return findYoloOnlyMatches(
        item.yoloClass, item.yoloModel, scopeLegacy, pageNumber, ctx.annotations,
      );

    case "text-only":
      if (!item.text?.trim()) return [];
      return findFreeFloatingMatches(
        item.text.toUpperCase().trim(),
        scopeLegacy, pageNumber, ctx.textractData,
      );

    case "yolo-with-inner-text": {
      if (!item.text?.trim() || !item.yoloClass) return [];
      const normalizedTag = item.text.toUpperCase().trim();
      const yoloHits = findYoloMatches(
        normalizedTag, item.yoloClass, item.yoloModel,
        scopeLegacy, pageNumber, ctx.annotations, ctx.textractData,
      );
      const floatingHits = findFreeFloatingMatches(
        normalizedTag, scopeLegacy, pageNumber, ctx.textractData,
      );
      return mergeYoloAndFloatingHits(
        yoloHits, floatingHits, item.yoloClass, item.yoloModel, ctx.annotations,
      );
    }

    case "yolo-object-with-tag-shape":
      return findObjectWithTagShapeMatches(
        item, scopeLegacy, pageNumber, ctx.annotations, ctx.textractData,
      );

    case "yolo-object-with-nearby-text":
      return findObjectWithNearbyTextMatches(
        item, scopeLegacy, pageNumber, ctx.annotations, ctx.textractData,
      );
  }
}

/** Convert ClassifiedPageRegions → RegionLookup (shape the primitives expect). */
function toRegionLookup(
  regions: ClassifiedPageRegions | undefined,
): RegionLookup | undefined {
  if (!regions) return undefined;
  return {
    titleBlocks: regions.titleBlocks.map((r) => ({ bbox: r.bbox })),
    tables: regions.tables.map((r) => ({ bbox: r.bbox })),
    drawings: regions.drawings.map((r) => ({ bbox: r.bbox })),
  };
}

/** Score a single raw instance against the context signals. */
function scoreRawMatch(
  raw: YoloTagInstance,
  item: CountableItem,
  ctx: MatchContext,
  config: ScoringConfig,
): ScoredMatch {
  const center = bboxCenterMinMax(raw.bbox);
  const regions = toRegionLookup(ctx.classifiedRegionsByPage[raw.pageNumber]);
  const regionType = resolveRegionType(center, regions);
  const regionWeight = weightFor(regionType, config);
  const pageHasDrawings = (regions?.drawings.length ?? 0) > 0;

  const scopeMatch = ctx.scope.allowsPage(raw.pageNumber);

  // Pattern match: test the item's text (the normalized tag the caller is
  // looking for) against the inferred pattern. Apply to normalized tag, not
  // raw Textract text, so fuzzy-OCR matches aren't unfairly blocked.
  // For Type 1 (yolo-only, no text), pattern is irrelevant → patternMatch=true.
  const hasPattern = ctx.pattern != null;
  const patternStrength = ctx.pattern?.strength ?? "none";
  const itemText = (item.text ?? "").toUpperCase().trim();
  const patternMatch = !hasPattern || itemText === ""
    ? true
    : ctx.pattern!.pattern.test(itemText);

  // Window match: for multi-word-reconstructed tags, the raw matcher has
  // already validated adjacency. For single-word or YOLO-anchored hits,
  // there's no "window" concept → treat as matched.
  // Raw matchers don't expose window-coherence yet; conservative default=true.
  // A future refinement can thread this from type2-text-only.
  const windowMatch = true;

  const fuzzy = raw.confidence < 1.0;

  const signals: ScoreSignals = {
    patternMatch,
    patternStrength,
    windowMatch,
    regionType,
    regionWeight,
    shapeContainBoost: 0,     // not yet produced by matchers; future refinement
    objectAdjacencyBoost: 0,  // not yet produced by matchers; future refinement
    scopeMatch,
    fuzzy,
  };

  const composed = composeScore(signals, config, pageHasDrawings);

  return {
    // Back-compat narrow fields
    pageNumber: raw.pageNumber,
    annotationId: raw.annotationId,
    bbox: raw.bbox,
    confidence: raw.confidence,
    // New scoring fields
    score: composed.score,
    signals,
    confidenceTier: composed.tier,
    dropReason: composed.dropReason,
  };
}

/**
 * Main entry point. Dispatch to the right matcher, score every raw match,
 * and return sorted by score descending.
 *
 * When no scoring context is meaningful (no pattern, no regions), every
 * match collapses to tier=medium via unclassified weight 0.5 — matching
 * today's permissive behavior when applyExclusionFilter finds no regions.
 */
export function findOccurrences(
  item: CountableItem,
  ctx: MatchContext,
): ScoredMatch[] {
  const config = ctx.config ?? DEFAULT_SCORING_CONFIG;
  const raw = dispatchMatcher(item, ctx);
  const scored = raw.map((r) => scoreRawMatch(r, item, ctx, config));
  // Sort by score descending (ties preserve original order).
  scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return scored;
}
