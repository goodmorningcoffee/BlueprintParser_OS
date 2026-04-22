/**
 * auto-table-detector.ts
 *
 * Stage 2c: convert Stage 2b ensemble output into auto-parse-ready proposals.
 *
 * Consumes `pageIntelligence.ensembleRegions` (cross-signal agreement) and
 * filters to the high-probability subset suitable for automated schedule
 * parsing. Emits `AutoTableProposal[]` — one step before a committed
 * `ParsedRegion`. The actual parsing (headers/rows/cells extraction) is
 * invoked downstream by the caller using the existing table-parse library.
 *
 * Stage 2c scope intentionally does NOT auto-commit ParsedRegions. The
 * proposals surface to admin for review + one-click accept. Auto-commit on
 * upload becomes a Stage 2d config toggle (autoDetect.tables).
 *
 * Pure function. No DB, no async.
 */

import type {
  EnsembleRegion,
  AutoTableProposal,
} from "@/types";

// ═══════════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════════

export interface AutoTableDetectorConfig {
  /** Minimum ensemble `tableProbability` to qualify as a proposal.
   *  Default 0.65 — higher than the ensemble's own 0.5 threshold so we stay
   *  conservative about what we hand to the auto-parser. */
  minProbability: number;
  /** If set, restricts proposals to these categories only (e.g.,
   *  `["door-schedule", "finish-schedule"]` for a targeted run). Undefined
   *  or empty array = accept any category. */
  categoryFilter?: string[];
  /** Maximum proposals to emit per page. Prevents runaway output on
   *  pathologically dense pages. Default 10. */
  maxPerPage: number;
}

export const DEFAULT_AUTO_DETECT_CONFIG: AutoTableDetectorConfig = {
  minProbability: 0.65,
  maxPerPage: 10,
};

// ═══════════════════════════════════════════════════════════════════
// Main export
// ═══════════════════════════════════════════════════════════════════

/**
 * Produce auto-table proposals for a single page from its ensemble regions.
 * Idempotent — same input always yields the same proposal IDs.
 */
export function detectAutoTables(
  pageNumber: number,
  ensembleRegions: readonly EnsembleRegion[] | undefined,
  configIn?: Partial<AutoTableDetectorConfig>,
): AutoTableProposal[] {
  if (!ensembleRegions || ensembleRegions.length === 0) return [];
  const config: AutoTableDetectorConfig = { ...DEFAULT_AUTO_DETECT_CONFIG, ...configIn };

  const filterCategories = config.categoryFilter && config.categoryFilter.length > 0
    ? new Set(config.categoryFilter)
    : null;

  const proposals: AutoTableProposal[] = [];

  for (const region of ensembleRegions) {
    if (region.tableProbability < config.minProbability) continue;
    if (filterCategories && region.category && !filterCategories.has(region.category)) continue;
    // Skip uncategorized regions when a category filter is active — the caller
    // asked for a specific subset, so an unknown-category region doesn't qualify.
    if (filterCategories && !region.category) continue;

    proposals.push({
      id: `auto-${pageNumber}-${proposals.length}`,
      pageNumber,
      bbox: region.bbox,
      tableProbability: region.tableProbability,
      category: region.category,
      reasoning: region.reasoning,
      voteSources: [...region.voteSources],
    });

    if (proposals.length >= config.maxPerPage) break;
  }

  return proposals;
}

/**
 * Batch variant — iterate a map of { pageNumber → ensembleRegions } and
 * collect proposals across the whole project. Result is keyed by pageNumber
 * so callers can fan out per-page.
 */
export function detectAutoTablesForProject(
  pageEnsembles: ReadonlyMap<number, readonly EnsembleRegion[]>,
  configIn?: Partial<AutoTableDetectorConfig>,
): Map<number, AutoTableProposal[]> {
  const out = new Map<number, AutoTableProposal[]>();
  for (const [pageNumber, regions] of pageEnsembles) {
    const proposals = detectAutoTables(pageNumber, regions, configIn);
    if (proposals.length > 0) out.set(pageNumber, proposals);
  }
  return out;
}
