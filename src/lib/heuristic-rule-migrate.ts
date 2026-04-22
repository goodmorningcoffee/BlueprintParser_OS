/**
 * heuristic-rule-migrate.ts
 *
 * Read-time migration from legacy `HeuristicRule` shape (pre-2026-04-24)
 * to the new DSL. Legacy company-override JSONB in
 * `companies.pipelineConfig.heuristics[]` is transparently normalized at
 * `getEffectiveRules()` entry — DB rows stay untouched until someone edits
 * them in the admin UI.
 *
 * Legacy shape changes:
 * - `textKeywords: string[]`  →  split into `textKeywordsRequired` +
 *                                `textKeywordsBoosters`; `textKeywordsMode`
 *                                defaults to `"all-required"` (preserves
 *                                legacy every(kw) semantics).
 * - (new)                     →  `yoloAvailabilityMode: "require"` default.
 * - `textRegionType: <old>`   →  migrated via `text-region-migrate`.
 *
 * Idempotent on already-new rules.
 */

import type { HeuristicRule, SpatialCondition } from "@/lib/heuristic-engine";
import { migrateTextRegionType } from "@/lib/text-region-migrate";

/** Shape of a HeuristicRule as it may appear in legacy DB payloads or
 *  still-unmigrated built-in defaults. All new DSL fields are optional here
 *  so untouched legacy JSONB passes through without TS errors. */
export interface LegacyHeuristicRule {
  id: string;
  name: string;
  source: "built-in" | "custom";
  enabled: boolean;
  modelId?: number;
  modelName?: string;

  yoloRequired: string[];
  yoloBoosters: string[];
  yoloRequiredMinConfidence?: number;
  yoloAvailabilityMode?: "require" | "degrade" | "ignore";

  // Legacy single keyword list
  textKeywords?: string[];
  // Or already-new split
  textKeywordsRequired?: string[];
  textKeywordsBoosters?: string[];
  textKeywordsMode?: "any-required" | "all-required";

  overlapRequired: boolean;
  spatialConditions?: SpatialCondition[];
  textRegionType?: string;
  csiDivisionsRequired?: string[];

  outputLabel: string;
  outputCsiCode?: string;
  minConfidence: number;
}

/**
 * Migrate a legacy or already-new rule to the current DSL.
 * Idempotent — passing a rule already in new shape returns it intact.
 */
export function migrateRule(
  r: LegacyHeuristicRule | HeuristicRule,
): HeuristicRule {
  const anyR = r as LegacyHeuristicRule;

  // Text keyword migration: prefer already-new fields; else split legacy
  let textKeywordsRequired: string[];
  let textKeywordsBoosters: string[];
  let textKeywordsMode: "any-required" | "all-required";

  if (anyR.textKeywordsRequired !== undefined) {
    textKeywordsRequired = anyR.textKeywordsRequired;
    textKeywordsBoosters = anyR.textKeywordsBoosters ?? [];
    textKeywordsMode = anyR.textKeywordsMode ?? "all-required";
  } else {
    // Legacy: single textKeywords list → textKeywordsRequired, empty boosters,
    // all-required mode to preserve pre-2026-04-24 every(kw) semantics.
    textKeywordsRequired = anyR.textKeywords ?? [];
    textKeywordsBoosters = [];
    textKeywordsMode = "all-required";
  }

  return {
    id: r.id,
    name: r.name,
    source: r.source,
    enabled: r.enabled,
    modelId: r.modelId,
    modelName: r.modelName,

    yoloRequired: r.yoloRequired,
    yoloBoosters: r.yoloBoosters,
    yoloRequiredMinConfidence: anyR.yoloRequiredMinConfidence,
    yoloAvailabilityMode: anyR.yoloAvailabilityMode ?? "require",

    textKeywordsRequired,
    textKeywordsBoosters,
    textKeywordsMode,

    overlapRequired: r.overlapRequired,
    spatialConditions: r.spatialConditions,
    textRegionType: migrateTextRegionType(r.textRegionType),
    csiDivisionsRequired: r.csiDivisionsRequired,

    outputLabel: r.outputLabel,
    outputCsiCode: r.outputCsiCode,
    minConfidence: r.minConfidence,
  };
}
