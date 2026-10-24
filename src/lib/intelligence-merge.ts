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
  // [refactor jul9 P2-A S1] "autoTableProposals" purged — zero readers repo-wide
  // (U1-F1); both writers (yolo Stage 2c + reprocess Stage 2c) removed same commit.
  // Old rows keep the stored key as an unknown-key survivor: harmless dead data.
  "csiSpatialMap",
  // [zones T2 2026-10-24] detector zones (src/lib/page-zones.ts), written by the post-YOLO
  // enrichment and the intelligence reprocess; absent on pages without YOLO detections.
  "pageZones",
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

// ─────────────────────────────────────────────────────────────────────────────
// [bugfix jul5 H6/DR002] PROJECT-level analogue of the page-level G3 policy.
//
// projects.projectIntelligence is ALSO mixed-ownership jsonb: analyzeProject()
// recomputes {disciplines, refGraph, csiGraph}, but user-owned keys
// live alongside them — classCsiOverrides AND yoloTags (curated in the viewer,
// persisted via the projects PUT merge). Both project-analysis write sites
// (admin/reprocess?scope=intelligence and the upload-pipeline re-run) used a
// hand-rolled "preserve ONLY classCsiOverrides" merge, silently destroying
// yoloTags (and any future user key) company-wide on an unfiltered reprocess —
// the exact project-level twin of bug G3. Same doctrine as above: computed keys
// refresh, user/unknown keys ALWAYS survive; "reprocess" must never be the
// thing that eats them.
//
// Note on empties: analyzeProject emits this-run-empty computed keys as
// `undefined`, which the spread carries and the jsonb write then DROPS — so a
// stale computed key still disappears when it genuinely computes to nothing,
// byte-identical to the old behavior for the computed set.

// [refactor jul9 P2-A S2+S3] PROJECT_REPROCESS_COMPUTED_KEYS deleted — it was
// declared-never-referenced (U1-F6; the S062 freeze pinned the BLIND-spread
// semantics, not a key list). projectIntelligence.pageCount purged with it:
// writer was project-analysis.ts analyzeProject(), zero readers (U1-F2). Old
// rows keep their stale stored pageCount as an unknown-key survivor.

/**
 * Merge freshly-computed project intelligence over the existing jsonb:
 * computed keys refresh, everything else (classCsiOverrides, yoloTags,
 * unknown future keys) survives untouched.
 */
export function mergeProjectIntelligence(
  existing: unknown,
  computed: Record<string, unknown>,
): Record<string, unknown> {
  const base =
    !existing || typeof existing !== "object" || Array.isArray(existing)
      ? {}
      : { ...(existing as Record<string, unknown>) };
  return { ...base, ...computed };
}
