// [refactor jun12 P0.5-G3] Merge policy for pageIntelligence reprocessing.
//
// pages.pageIntelligence is a mixed-ownership jsonb: some keys are COMPUTED
// (pipeline output, safe to rebuild on every reprocess) and some are USER DATA
// (most importantly `parsedRegions` — regions users promoted via the parse
// wizards; hours of work). The intelligence-scope reprocess used to rebuild
// the object from `{}` and wholesale-write it, silently destroying every
// non-computed key across ALL of a company's projects in one admin click
// (bug G3, fable_refactor_plan_june11/09 §2.1). yolo/load already had the
// correct semantics (spread the existing object, refresh what you computed);
// this module makes that policy explicit, shared, and unit-tested.
//
// Refresh semantics: computed keys are CLEARED here and conditionally re-added
// by the caller — so a key that genuinely computes to empty this run is
// dropped (correct: it's stale), while user/unknown keys always survive.
// Unknown keys are deliberately preserved: future writers may add keys this
// module hasn't heard of, and "reprocess" must never be the thing that eats them.

/** Keys the intelligence reprocess (admin/reprocess?scope=intelligence) recomputes. */
export const REPROCESS_COMPUTED_KEYS = [
  "classification",
  "crossRefs",
  "noteBlocks",
  "textRegions",
  "heuristicInferences",
  "classifiedTables",
  "classifiedRegions",
  "yoloHeatmap",
  "ensembleRegions",
  "autoTableProposals",
  "csiSpatialMap",
] as const;

/**
 * Start-state for a reprocess rebuild: the page's existing intelligence with
 * computed keys removed (caller re-adds fresh ones) and everything else —
 * parsedRegions and any unknown keys — carried over untouched.
 */
export function carryNonComputedIntelligence(existing: unknown): Record<string, unknown> {
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) return {};
  const computed = new Set<string>(REPROCESS_COMPUTED_KEYS);
  return Object.fromEntries(
    Object.entries(existing as Record<string, unknown>).filter(([key]) => !computed.has(key)),
  );
}
