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
 *
 * [tag-mapping v2 2026-10-24] When the context carries `shapes` (the per-page shape ensemble,
 * src/lib/shape-ensemble) the shape half of Types 1/3/4 reads TAG-CLASS shapes from it — YOLO,
 * classical and both, with the ensemble's fused inner text — and the ensemble's confidence enters
 * the score as `shapeContainBoost`. Free-floating hits (Type 2, and the fallbacks of 3 and 5) pass
 * the owner's text rules when `rules` is set. Object classes (doors, outlets, …) and every context
 * without those fields keep v1's behaviour verbatim.
 */

import type { YoloTagInstance, ClassifiedPageRegions, ClientAnnotation } from "@/types";
import { bboxCenterMinMax } from "@/lib/bbox-utils";
import { TAG_SHAPE_CLASSES, isSheetNumber, sheetKeySet } from "@/lib/shape-ensemble";
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
import { findFreeFloatingMatches, type TextRulesContext } from "./matchers/type2-text-only";
import {
  findYoloMatches,
  mergeYoloAndFloatingHits,
} from "./matchers/type3-yolo-with-inner-text";
import { findObjectWithTagShapeMatches } from "./matchers/type4-yolo-object-with-tag-shape";
import { findObjectWithNearbyTextMatches } from "./matchers/type5-yolo-object-with-nearby-text";
import { bindToNearestTargets } from "./matchers/fuzzy";
import { ensembleAnnotationId, findEnsembleShapeMatches, type ShapeBackedInstance } from "./matchers/ensemble-shapes";

/** v2 applies to a shape class when the ensemble is present and the class is a tag-bubble class. */
function ensembleFor(ctx: MatchContext, cls: string | undefined): boolean {
  return !!ctx.shapes && !!cls && TAG_SHAPE_CLASSES.has(cls);
}

function rulesFor(ctx: MatchContext, normalizedTag: string): TextRulesContext | undefined {
  if (!ctx.rules) return undefined;
  return {
    rules: ctx.rules,
    shapesByPage: ctx.shapes,
    tagIsSheetNumber: isSheetNumber(normalizedTag, sheetKeySet(ctx.sheetNumbers)),
  };
}

/** Ensemble tag shapes as nearest-binding targets (the shape of `bindToNearestTargets`'s input). */
function ensembleTargets(ctx: MatchContext, cls: string, scope: "page" | "project", pageNumber: number | undefined): ClientAnnotation[] {
  const out: ClientAnnotation[] = [];
  for (const [pn, shapes] of Object.entries(ctx.shapes ?? {})) {
    const pageNum = Number(pn);
    if (scope === "page" && pageNumber != null && pageNum !== pageNumber) continue;
    for (const s of shapes ?? []) {
      if (s.cls !== cls || s.kind !== "tag") continue;
      out.push({ id: ensembleAnnotationId(s), pageNumber: pageNum, name: s.cls, bbox: [s.bbox[0], s.bbox[1], s.bbox[2], s.bbox[3]], note: null, source: "yolo" });
    }
  }
  return out;
}

/**
 * Dispatch a CountableItem to the right matcher. Returns raw instances
 * before scoring; the orchestrator wraps each with ScoreSignals via
 * `scoreRawMatches` below.
 */
function dispatchMatcher(item: CountableItem, ctx: MatchContext): YoloTagInstance[] {
  const scopeLegacy: "page" | "project" = ctx.isPageScoped ? "page" : "project";
  const pageNumber = ctx.pageNumber;
  const sheets = sheetKeySet(ctx.sheetNumbers);

  switch (item.itemType) {
    case "yolo-only":
      if (!item.yoloClass) return [];
      if (ensembleFor(ctx, item.yoloClass)) {
        return findEnsembleShapeMatches(null, item.yoloClass, scopeLegacy, pageNumber, ctx.shapes!, sheets);
      }
      return findYoloOnlyMatches(
        item.yoloClass, item.yoloModel, scopeLegacy, pageNumber, ctx.annotations,
      );

    case "text-only": {
      if (!item.text?.trim()) return [];
      const normalizedTag = item.text.toUpperCase().trim();
      return findFreeFloatingMatches(normalizedTag, scopeLegacy, pageNumber, ctx.textractData, rulesFor(ctx, normalizedTag));
    }

    case "yolo-with-inner-text": {
      if (!item.text?.trim() || !item.yoloClass) return [];
      const normalizedTag = item.text.toUpperCase().trim();
      const floatingHits = findFreeFloatingMatches(
        normalizedTag, scopeLegacy, pageNumber, ctx.textractData, rulesFor(ctx, normalizedTag),
      );
      if (ensembleFor(ctx, item.yoloClass)) {
        const shapeHits = findEnsembleShapeMatches(normalizedTag, item.yoloClass, scopeLegacy, pageNumber, ctx.shapes!, sheets);
        return bindToNearestTargets(
          floatingHits, shapeHits, ensembleTargets(ctx, item.yoloClass, scopeLegacy, pageNumber), { exact: 0.8, fuzzy: 0.7 },
        );
      }
      const yoloHits = findYoloMatches(
        normalizedTag, item.yoloClass, item.yoloModel,
        scopeLegacy, pageNumber, ctx.annotations, ctx.textractData,
      );
      return mergeYoloAndFloatingHits(
        yoloHits, floatingHits, item.yoloClass, item.yoloModel, ctx.annotations,
      );
    }

    case "yolo-object-with-tag-shape": {
      if (ensembleFor(ctx, item.tagShapeClass) && item.yoloClass && item.text?.trim()) {
        const normalizedTag = item.text.toUpperCase().trim();
        const tagShapeHits = findEnsembleShapeMatches(normalizedTag, item.tagShapeClass!, scopeLegacy, pageNumber, ctx.shapes!, sheets);
        if (tagShapeHits.length === 0) return [];
        const objectTargets = ctx.annotations.filter((a) =>
          a.source === "yolo" &&
          a.name === item.yoloClass &&
          (!item.yoloModel || (a.data as { modelName?: string } | null)?.modelName === item.yoloModel) &&
          (scopeLegacy !== "page" || pageNumber == null || a.pageNumber === pageNumber),
        );
        return bindToNearestTargets(tagShapeHits, [], objectTargets, { exact: 0.9, fuzzy: 0.85 });
      }
      return findObjectWithTagShapeMatches(
        item, scopeLegacy, pageNumber, ctx.annotations, ctx.textractData,
      );
    }
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

  // [v2] a hit found inside an ensemble tag shape carries the shape's fused confidence.
  const shapeConfidence = (raw as ShapeBackedInstance).shapeConfidence;
  const shapeContainBoost = shapeConfidence != null ? Math.min(config.shapeBoostMax, shapeConfidence * config.shapeBoostMax) : 0;

  const signals: ScoreSignals = {
    patternMatch,
    patternStrength,
    windowMatch,
    regionType,
    regionWeight,
    shapeContainBoost,
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
