/**
 * vote-adapters.ts
 *
 * Convert each classifier's native output shape into the canonical
 * `RegionVote[]` format consumed by `reduceRegionVotes`. Keeps the reducer
 * classifier-agnostic and makes it trivial to add new vote sources later
 * (TATR, LLM, etc.) — just write an adapter.
 *
 * Adapters are pure — no DB, no async.
 */

import type {
  RegionVote,
  ClassifiedTable,
  ClassifiedRegion,
  YoloHeatmap,
  ParsedRegion,
  BboxLTWH,
  BboxMinMax,
} from "@/types";

function minmaxToLtwh(b: BboxMinMax): BboxLTWH {
  return [b[0], b[1], b[2] - b[0], b[3] - b[1]];
}

// ─── table-classifier.ts → RegionVote[] ───────────────────────

export function votesFromClassifiedTables(
  tables: readonly ClassifiedTable[] | undefined,
): RegionVote[] {
  if (!tables) return [];
  return tables.map((t) => ({
    source: "table-classifier" as const,
    bbox: t.bbox,
    score: t.confidence,
    category: t.category,
    evidence: t.evidence,
  }));
}

// ─── composite-classifier.ts → RegionVote[] ───────────────────

export function votesFromCompositeClassifier(
  tables: readonly ClassifiedRegion[] | undefined,
): RegionVote[] {
  if (!tables) return [];
  return tables.map((r) => ({
    source: "composite-classifier" as const,
    bbox: minmaxToLtwh(r.bbox),
    score: r.confidence,
    evidence: r.sources,
  }));
}

// ─── yolo-heatmap.ts → RegionVote[] ──────────────────────────

export function votesFromYoloHeatmap(
  heatmap: YoloHeatmap | undefined,
): RegionVote[] {
  if (!heatmap) return [];
  return heatmap.confidentRegions.map((r) => ({
    source: "yolo-heatmap" as const,
    bbox: r.bbox,
    score: r.confidence,
    evidence: [`classes: ${r.classes.join("+")}`, `${r.cellCount} cells`],
  }));
}

// ─── user-saved ParsedRegion[] → RegionVote[] (strongest signal) ──

export function votesFromParsedRegions(
  parsedRegions: readonly ParsedRegion[] | undefined,
): RegionVote[] {
  if (!parsedRegions) return [];
  return parsedRegions
    .filter((pr) => pr.type === "schedule" || pr.type === "keynote")
    .map((pr) => ({
      source: "parsed-region" as const,
      bbox: pr.bbox,
      score: 0.99,  // user has committed this; treat as near-certain
      category: pr.category,
      evidence: [`user-saved ${pr.type}`],
    }));
}

// ─── Bundle all adapters ──────────────────────────────────────

export interface VotesInput {
  classifiedTables?: readonly ClassifiedTable[];
  classifiedRegionsTables?: readonly ClassifiedRegion[];
  yoloHeatmap?: YoloHeatmap;
  parsedRegions?: readonly ParsedRegion[];
}

/** Convenience — run every adapter in one call and concatenate. */
export function collectAllVotes(input: VotesInput): RegionVote[] {
  return [
    ...votesFromClassifiedTables(input.classifiedTables),
    ...votesFromCompositeClassifier(input.classifiedRegionsTables),
    ...votesFromYoloHeatmap(input.yoloHeatmap),
    ...votesFromParsedRegions(input.parsedRegions),
  ];
}
