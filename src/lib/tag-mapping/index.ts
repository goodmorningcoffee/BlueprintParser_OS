/**
 * tag-mapping — Schedule row → plan instance mapping engine.
 *
 * Public surface:
 *   - `findOccurrences(item, ctx)` — new scored API, returns ScoredMatch[]
 *   - Primitive helpers for future mappers (note-mapping, spec-mapping):
 *       inferTagPattern, buildScope, resolveRegionType, composeScore
 *   - Legacy adapters re-exported under old names for back-compat
 *
 * See featureRoadMap/tag_mapping_refactor_plan.md for architecture.
 */

export type {
  ConfidenceTier,
  RegionType,
  DropReason,
  ScoreSignals,
  ScoredMatch,
  InferredPattern,
  ScopeFilter,
  PageMeta,
  ScopeOptions,
  ScoringConfig,
  CountableItem,
  MapYoloToOcrOptions,
  MatchContext,
  ClassScanResult,
  RegionLookup,
} from "./types";

export { DEFAULT_SCORING_CONFIG } from "./types";

// Primitives (reusable by future mappers)
export { inferTagPattern } from "./primitives/pattern-infer";
export { buildScope, allPagesScope } from "./primitives/scope";
export { resolveRegionType, weightFor } from "./primitives/region-weight";
export { composeScore } from "./primitives/score-compose";

// Orchestrator
export { findOccurrences } from "./find-occurrences";

// Legacy shims — keep call sites working during the migration
export {
  findItemOccurrencesLegacy as findItemOccurrences,
  mapYoloToOcrTextLegacy as mapYoloToOcrText,
  getOcrTextInAnnotationLegacy as getOcrTextInAnnotation,
  scanClassForTextsLegacy as scanClassForTexts,
  toYoloTagInstance,
  toYoloTagInstances,
} from "./legacy";

// Fuzzy-OCR helpers (still exported for any direct consumer)
export { isFuzzyCandidate, OCR_CONFUSIONS } from "./matchers/fuzzy";
