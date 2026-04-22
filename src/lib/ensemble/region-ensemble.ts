/**
 * region-ensemble.ts
 *
 * Stage 2b: cross-signal ensemble reducer.
 *
 * Problem it solves: the legacy `table-classifier.ts` fires `door-schedule`
 * on any page with "DOOR" + "SCHEDULE" as whole words (post-Stage 2a quick
 * win) plus any multi-column text region, even when the page actually
 * contains only a cross-reference ("SEE DOOR SCHEDULE ON A-8") and no
 * actual table. Those false positives were the A-8 / CS-1 / A-1 / A-14 / etc.
 * hits in the 2026-04-22 screenshot.
 *
 * This module replaces single-classifier trust with cross-classifier agreement:
 *   - Accepts `RegionVote[]` — one entry per classifier's opinion of a region.
 *   - Spatially merges votes that refer to the same physical region (via IoU
 *     or containment — reuses Stage 1 overlap-signals + Union-Find).
 *   - Emits `EnsembleRegion[]` with a consolidated `tableProbability` that
 *     REQUIRES at least N distinct vote sources (default 2) before crossing a
 *     confidence threshold. Keyword-only matches with no composite/heatmap
 *     agreement → suppressed below the threshold.
 *
 * The ensemble is the authoritative "is there a real table here" signal
 * going forward. `classifiedTables` output stays intact as an input vote;
 * it just no longer speaks alone.
 *
 * Reused Stage 1 primitives:
 *   - `overlap-signals` (iou + maxContainment) for spatial merge edges.
 *   - `union-find` (DSU) for grouping votes into physical-region clusters.
 */

import type {
  RegionVote,
  EnsembleRegion,
  EnsembleVoteSource,
  BboxLTWH,
} from "@/types";
import { UnionFind } from "@/lib/geom/union-find";
import { iou, maxContainment } from "@/lib/geom/overlap-signals";

// ═══════════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════════

export interface EnsembleConfig {
  /** Minimum distinct vote sources required to qualify a region as
   *  "probable table" above the threshold. Default 2. */
  minDistinctVotes: number;
  /** IoU threshold above which two votes are merged into the same region. */
  iouThreshold: number;
  /** Containment threshold — catches nested-box cases IoU misses. */
  containThreshold: number;
  /** tableProbability below this is considered noise and suppressed from
   *  output. Default 0.5. */
  probabilityThreshold: number;
  /** Per-source weight multiplier applied to the vote's self-reported score
   *  before aggregation. Lets us distrust known-noisy sources without
   *  removing them from the evidence chain. */
  sourceWeights: Partial<Record<EnsembleVoteSource, number>>;
}

export const DEFAULT_ENSEMBLE_CONFIG: EnsembleConfig = {
  minDistinctVotes: 2,
  iouThreshold: 0.3,
  containThreshold: 0.5,
  probabilityThreshold: 0.5,
  sourceWeights: {
    // table-classifier alone (keyword + regionType) is the known false-positive
    // source. Down-weight so it cannot clear the threshold alone even if it
    // self-reports 0.95. Still contributes to the evidence chain and gets
    // promoted when a stronger signal agrees.
    "table-classifier": 0.4,
    "composite-classifier": 1.0,
    "yolo-heatmap": 0.9,
    "tatr": 1.0,           // future
    "llm": 0.8,            // future
    "parsed-region": 1.5,   // user-saved regions are strongest
  },
};

// ═══════════════════════════════════════════════════════════════════
// Main export
// ═══════════════════════════════════════════════════════════════════

/**
 * Reduce a heterogeneous list of votes into cross-signal-agreement regions.
 * Output is sorted by `tableProbability` descending and filtered to rows
 * ≥ `probabilityThreshold`.
 *
 * Pure function — no side effects.
 */
export function reduceRegionVotes(
  pageNumber: number,
  votes: readonly RegionVote[],
  configIn?: Partial<EnsembleConfig>,
): EnsembleRegion[] {
  const config: EnsembleConfig = { ...DEFAULT_ENSEMBLE_CONFIG, ...configIn };

  if (votes.length === 0) return [];

  // Build overlap graph: edge between vote i and vote j iff they refer to
  // the same physical region (IoU or containment above threshold).
  const uf = new UnionFind(votes.length);
  for (let i = 0; i < votes.length; i++) {
    for (let j = i + 1; j < votes.length; j++) {
      const iouVal = iou(votes[i].bbox, votes[j].bbox);
      const contVal = maxContainment(votes[i].bbox, votes[j].bbox);
      if (iouVal >= config.iouThreshold || contVal >= config.containThreshold) {
        uf.union(i, j);
      }
    }
  }

  // Collect vote indices per component.
  const componentVotes = new Map<number, number[]>();
  for (let i = 0; i < votes.length; i++) {
    const root = uf.find(i);
    if (!componentVotes.has(root)) componentVotes.set(root, []);
    componentVotes.get(root)!.push(i);
  }

  // Reduce each component to an EnsembleRegion.
  const regions: EnsembleRegion[] = [];
  for (const indices of componentVotes.values()) {
    const contributingVotes = indices.map((i) => votes[i]);
    const region = reduceComponent(pageNumber, contributingVotes, config);
    if (region.tableProbability >= config.probabilityThreshold) {
      regions.push(region);
    }
  }

  regions.sort((a, b) => b.tableProbability - a.tableProbability);
  return regions;
}

/**
 * Non-filtering variant — returns ALL ensemble regions regardless of
 * threshold. Useful for debug/LLM context where suppressed candidates still
 * carry evidentiary value. Sorted by tableProbability descending.
 */
export function reduceRegionVotesAll(
  pageNumber: number,
  votes: readonly RegionVote[],
  configIn?: Partial<EnsembleConfig>,
): EnsembleRegion[] {
  return reduceRegionVotes(pageNumber, votes, {
    ...configIn,
    probabilityThreshold: 0,
  });
}

// ═══════════════════════════════════════════════════════════════════
// Internals
// ═══════════════════════════════════════════════════════════════════

function reduceComponent(
  pageNumber: number,
  votes: readonly RegionVote[],
  config: EnsembleConfig,
): EnsembleRegion {
  const distinctSources = new Set<EnsembleVoteSource>();
  for (const v of votes) distinctSources.add(v.source);

  // Union bbox from all contributing votes.
  const bbox = unionBboxes(votes.map((v) => v.bbox));

  // Weighted aggregate score.
  let weightedSum = 0;
  let totalWeight = 0;
  for (const v of votes) {
    const w = config.sourceWeights[v.source] ?? 1.0;
    weightedSum += v.score * w;
    totalWeight += w;
  }
  const weightedAvg = totalWeight > 0 ? weightedSum / totalWeight : 0;

  // Cross-signal-agreement multiplier: require `minDistinctVotes` sources
  // before the aggregate can cross probabilityThreshold. A single-source
  // vote at any self-reported score gets capped below threshold via a
  // penalty factor; two distinct sources get parity; three+ get a small bonus.
  const distinct = distinctSources.size;
  let agreementMultiplier: number;
  if (distinct >= config.minDistinctVotes + 1) {
    agreementMultiplier = 1.1;
  } else if (distinct >= config.minDistinctVotes) {
    agreementMultiplier = 1.0;
  } else {
    // Single-source vote (or insufficient) — penalize so the single strong
    // vote ("table-classifier alone says 0.95") cannot clear the default
    // 0.5 threshold without corroboration.
    agreementMultiplier = 0.5;
  }

  const tableProbability = Math.min(1, weightedAvg * agreementMultiplier);

  // Pick a category: most common across votes, else first available.
  const categoryCounts = new Map<string, number>();
  for (const v of votes) {
    if (v.category) {
      categoryCounts.set(v.category, (categoryCounts.get(v.category) ?? 0) + 1);
    }
  }
  let category: string | undefined;
  let bestCount = 0;
  for (const [cat, count] of categoryCounts) {
    if (count > bestCount) {
      bestCount = count;
      category = cat;
    }
  }

  const reasoning = buildReasoning(distinctSources, votes, tableProbability, agreementMultiplier);

  return {
    bbox,
    tableProbability,
    contributingVotes: [...votes],
    voteSources: [...distinctSources],
    category,
    reasoning,
    pageNumber,
  };
}

function unionBboxes(bboxes: readonly BboxLTWH[]): BboxLTWH {
  if (bboxes.length === 0) return [0, 0, 0, 0];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of bboxes) {
    if (b[0] < minX) minX = b[0];
    if (b[1] < minY) minY = b[1];
    if (b[0] + b[2] > maxX) maxX = b[0] + b[2];
    if (b[1] + b[3] > maxY) maxY = b[1] + b[3];
  }
  return [minX, minY, maxX - minX, maxY - minY];
}

function buildReasoning(
  distinctSources: ReadonlySet<EnsembleVoteSource>,
  votes: readonly RegionVote[],
  probability: number,
  agreementMultiplier: number,
): string {
  const sourceList = [...distinctSources].join(", ");
  const n = distinctSources.size;
  const perSource = votes
    .map((v) => `${v.source}=${v.score.toFixed(2)}`)
    .join(", ");
  const agreementNote = agreementMultiplier < 1
    ? " (single-source penalty applied — needs corroboration)"
    : agreementMultiplier > 1
      ? " (multi-source bonus applied)"
      : "";
  return `${n} source(s): ${sourceList}. Per-source: ${perSource}. Probability: ${probability.toFixed(2)}${agreementNote}.`;
}
