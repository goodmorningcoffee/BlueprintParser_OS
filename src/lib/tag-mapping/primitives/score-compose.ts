/**
 * primitives/score-compose.ts — Composite scoring from signal breakdown.
 *
 * Given raw signals (patternMatch, windowMatch, regionType, etc.) + a
 * scoring config, produce the composite score, tier, and optional dropReason.
 *
 * Consumer-agnostic: future note-mapping or spec-mapping matchers produce
 * their own signals and call this unchanged.
 *
 * Scoring formula (documented in featureRoadMap/tag_mapping_refactor_plan.md):
 *   - scope hard-zero      → score=0, dropReason=outside_scope
 *   - strong pattern miss  → score=0, dropReason=pattern_mismatch
 *   - else:
 *       score = regionWeight
 *             × (patternMatch ? 1.0 : weakPatternAttenuation)
 *             × (windowMatch ? 1.0 : windowPenalty)
 *             × (fuzzy ? fuzzyPenalty : 1.0)
 *             + shapeContainBoost + objectAdjacencyBoost
 *   - tier from tierThresholds; dropReason for low-tier region drops
 */

import type {
  ConfidenceTier,
  DropReason,
  ScoreSignals,
  ScoringConfig,
} from "../types";

export interface ComposedScore {
  score: number;
  tier: ConfidenceTier;
  dropReason?: DropReason;
}

export function composeScore(
  signals: ScoreSignals,
  config: ScoringConfig,
  /** True when the page had drawings regions classified. Lets us flag
   *  outside_drawings correctly — a match in `unclassified` on a page with
   *  zero drawings regions is not "outside drawings" (there were none). */
  pageHasDrawings: boolean,
): ComposedScore {
  // Hard-zero: scope
  if (!signals.scopeMatch) {
    return { score: 0, tier: "low", dropReason: "outside_scope" };
  }

  // Hard-zero: strong pattern miss (weak pattern only attenuates, no hard-zero)
  if (
    config.strongPatternHardZero &&
    signals.patternStrength === "strong" &&
    !signals.patternMatch
  ) {
    return { score: 0, tier: "low", dropReason: "pattern_mismatch" };
  }

  // Multiplicative attenuations
  const patternFactor = signals.patternMatch
    ? 1.0
    : signals.patternStrength === "weak"
      ? config.weakPatternAttenuation
      : 1.0;
  const windowFactor = signals.windowMatch ? 1.0 : config.windowPenalty;
  const fuzzyFactor = signals.fuzzy ? config.fuzzyPenalty : 1.0;

  let score =
    signals.regionWeight * patternFactor * windowFactor * fuzzyFactor +
    signals.shapeContainBoost +
    signals.objectAdjacencyBoost;

  score = Math.max(0, Math.min(1, score));

  // Tier assignment
  const tier: ConfidenceTier =
    score >= config.tierThresholds.high
      ? "high"
      : score >= config.tierThresholds.medium
        ? "medium"
        : "low";

  // Populate dropReason based on dominant region even for tier=low non-hard-zero
  // cases. Lets the UI explain "this is low because it's in a title_block"
  // vs. "low because no regions and no other signals".
  let dropReason: DropReason | undefined;
  if (tier === "low") {
    if (signals.regionType === "title_block") dropReason = "inside_title_block";
    else if (signals.regionType === "tables") dropReason = "inside_table";
    else if (signals.regionType === "unclassified" && pageHasDrawings) {
      // Page has drawings; this match landed in none of them → outside_drawings.
      dropReason = "outside_drawings";
    }
  }

  return { score, tier, dropReason };
}
