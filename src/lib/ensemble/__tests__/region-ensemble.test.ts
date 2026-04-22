import { describe, it, expect } from "vitest";
import {
  reduceRegionVotes,
  reduceRegionVotesAll,
  DEFAULT_ENSEMBLE_CONFIG,
} from "@/lib/ensemble/region-ensemble";
import {
  votesFromClassifiedTables,
  votesFromCompositeClassifier,
  votesFromYoloHeatmap,
  votesFromParsedRegions,
  collectAllVotes,
} from "@/lib/ensemble/vote-adapters";
import type {
  RegionVote,
  ClassifiedTable,
  ClassifiedRegion,
  YoloHeatmap,
  ParsedRegion,
} from "@/types";

// ═══════════════════════════════════════════════════════════════════
// Basic reducer semantics
// ═══════════════════════════════════════════════════════════════════

describe("reduceRegionVotes", () => {
  it("returns empty array for empty votes", () => {
    expect(reduceRegionVotes(1, [])).toEqual([]);
  });

  it("single-source vote does NOT clear the default threshold", () => {
    const votes: RegionVote[] = [
      { source: "table-classifier", bbox: [0.1, 0.1, 0.4, 0.4], score: 0.95 },
    ];
    const regions = reduceRegionVotes(1, votes);
    expect(regions.length).toBe(0); // suppressed by agreementMultiplier penalty
  });

  it("two distinct sources on the same region clear the threshold", () => {
    const votes: RegionVote[] = [
      { source: "table-classifier", bbox: [0.1, 0.1, 0.4, 0.4], score: 0.9 },
      { source: "yolo-heatmap", bbox: [0.12, 0.12, 0.38, 0.38], score: 0.85 },
    ];
    const regions = reduceRegionVotes(1, votes);
    expect(regions.length).toBe(1);
    expect(regions[0].tableProbability).toBeGreaterThanOrEqual(0.5);
    expect(regions[0].voteSources).toContain("table-classifier");
    expect(regions[0].voteSources).toContain("yolo-heatmap");
  });

  it("three distinct sources get an agreement bonus", () => {
    const twoSource: RegionVote[] = [
      { source: "table-classifier", bbox: [0.1, 0.1, 0.4, 0.4], score: 0.8 },
      { source: "yolo-heatmap", bbox: [0.1, 0.1, 0.4, 0.4], score: 0.8 },
    ];
    const threeSource: RegionVote[] = [
      ...twoSource,
      { source: "composite-classifier", bbox: [0.1, 0.1, 0.4, 0.4], score: 0.8 },
    ];
    const two = reduceRegionVotes(1, twoSource)[0];
    const three = reduceRegionVotes(1, threeSource)[0];
    expect(three.tableProbability).toBeGreaterThan(two.tableProbability);
  });

  it("disjoint bboxes produce independent regions", () => {
    const votes: RegionVote[] = [
      { source: "table-classifier", bbox: [0.05, 0.05, 0.2, 0.2], score: 0.85 },
      { source: "yolo-heatmap", bbox: [0.06, 0.06, 0.2, 0.2], score: 0.85 },
      { source: "table-classifier", bbox: [0.6, 0.6, 0.3, 0.3], score: 0.85 },
      { source: "yolo-heatmap", bbox: [0.6, 0.6, 0.3, 0.3], score: 0.85 },
    ];
    const regions = reduceRegionVotes(1, votes);
    expect(regions.length).toBe(2);
  });

  it("output is sorted by tableProbability descending", () => {
    const votes: RegionVote[] = [
      { source: "table-classifier", bbox: [0.05, 0.05, 0.2, 0.2], score: 0.6 },
      { source: "yolo-heatmap", bbox: [0.05, 0.05, 0.2, 0.2], score: 0.6 },
      { source: "table-classifier", bbox: [0.6, 0.6, 0.3, 0.3], score: 0.95 },
      { source: "yolo-heatmap", bbox: [0.6, 0.6, 0.3, 0.3], score: 0.95 },
      { source: "composite-classifier", bbox: [0.6, 0.6, 0.3, 0.3], score: 0.9 },
    ];
    const regions = reduceRegionVotes(1, votes);
    for (let i = 1; i < regions.length; i++) {
      expect(regions[i].tableProbability).toBeLessThanOrEqual(regions[i - 1].tableProbability);
    }
  });

  it("picks most-common category across contributing votes", () => {
    const votes: RegionVote[] = [
      { source: "table-classifier", bbox: [0.1, 0.1, 0.4, 0.4], score: 0.9, category: "door-schedule" },
      { source: "yolo-heatmap", bbox: [0.1, 0.1, 0.4, 0.4], score: 0.85 },
      { source: "composite-classifier", bbox: [0.1, 0.1, 0.4, 0.4], score: 0.8 },
    ];
    const regions = reduceRegionVotes(1, votes);
    expect(regions[0].category).toBe("door-schedule");
  });

  it("reasoning string includes source list and per-source scores", () => {
    const votes: RegionVote[] = [
      { source: "table-classifier", bbox: [0.1, 0.1, 0.4, 0.4], score: 0.9 },
      { source: "yolo-heatmap", bbox: [0.1, 0.1, 0.4, 0.4], score: 0.8 },
    ];
    const regions = reduceRegionVotes(1, votes);
    expect(regions[0].reasoning).toContain("table-classifier");
    expect(regions[0].reasoning).toContain("yolo-heatmap");
    expect(regions[0].reasoning).toContain("0.90");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Door-schedule false-positive regression (2026-04-22 screenshot)
// ═══════════════════════════════════════════════════════════════════

describe("Door-schedule false-positive regression", () => {
  // These tests model the exact scenario from the screenshot: pages that
  // contain "DOOR" and "SCHEDULE" as whole words (e.g., cross-references)
  // trigger the table-classifier at high confidence, but no YOLO tables
  // detection and no density heatmap agreement exists. The ensemble MUST
  // suppress the page below the 0.5 threshold.

  const keywordOnlyVote: RegionVote = {
    source: "table-classifier",
    bbox: [0.1, 0.1, 0.5, 0.5],
    score: 0.95,
    category: "door-schedule",
    evidence: ["Keywords: DOOR, SCHEDULE", "Structure: 3 cols × 3 rows"],
  };

  it("A-8 (screenshot 95% match) with only keyword vote → suppressed", () => {
    const regions = reduceRegionVotes(8, [keywordOnlyVote]);
    expect(regions.length).toBe(0);
  });

  it("CS-1 / A-1 / A-2 / A-14 / A-15 / A-17 / E-3 / A-16 — all keyword-only → all suppressed", () => {
    const pages = [1, 2, 14, 15, 17, 3, 16];
    for (const pn of pages) {
      const regions = reduceRegionVotes(pn, [{ ...keywordOnlyVote, score: 0.7 }]);
      expect(regions).toEqual([]);
    }
  });

  it("keyword vote + yolo-heatmap agreement → passes (this is the REAL door schedule)", () => {
    const votes: RegionVote[] = [
      keywordOnlyVote,
      { source: "yolo-heatmap", bbox: [0.11, 0.11, 0.49, 0.49], score: 0.85 },
    ];
    const regions = reduceRegionVotes(8, votes);
    expect(regions.length).toBe(1);
    expect(regions[0].tableProbability).toBeGreaterThanOrEqual(0.5);
  });

  it("keyword vote + composite tables agreement → passes", () => {
    const votes: RegionVote[] = [
      keywordOnlyVote,
      { source: "composite-classifier", bbox: [0.1, 0.1, 0.5, 0.5], score: 0.85 },
    ];
    const regions = reduceRegionVotes(8, votes);
    expect(regions.length).toBe(1);
  });

  it("reasoning surfaces the single-source penalty when suppressed via reduceRegionVotesAll", () => {
    const regions = reduceRegionVotesAll(8, [keywordOnlyVote]);
    expect(regions[0].reasoning).toContain("single-source penalty");
  });

  it("user-saved ParsedRegion + keyword vote → strong pass (user has already committed)", () => {
    const votes: RegionVote[] = [
      keywordOnlyVote,
      {
        source: "parsed-region",
        bbox: [0.1, 0.1, 0.5, 0.5],
        score: 0.99,
        category: "door-schedule",
      },
    ];
    const regions = reduceRegionVotes(8, votes);
    expect(regions[0].tableProbability).toBeGreaterThan(0.75);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Vote adapters
// ═══════════════════════════════════════════════════════════════════

describe("vote adapters", () => {
  it("votesFromClassifiedTables maps each table with category preserved", () => {
    const tables: ClassifiedTable[] = [
      {
        id: "region-0",
        type: "schedule-table",
        bbox: [0.1, 0.1, 0.4, 0.4],
        confidence: 0.85,
        wordCount: 50,
        category: "door-schedule",
        evidence: ["Keywords: DOOR, SCHEDULE"],
        pageNumber: 8,
        isPageSpecific: false,
      },
    ];
    const votes = votesFromClassifiedTables(tables);
    expect(votes).toHaveLength(1);
    expect(votes[0].source).toBe("table-classifier");
    expect(votes[0].category).toBe("door-schedule");
    expect(votes[0].score).toBe(0.85);
  });

  it("votesFromCompositeClassifier converts BboxMinMax → BboxLTWH", () => {
    const regions: ClassifiedRegion[] = [
      {
        kind: "table",
        bbox: [0.1, 0.2, 0.5, 0.6], // minmax
        confidence: 0.8,
        sources: ["yolo:tables"],
        pageNumber: 8,
      },
    ];
    const votes = votesFromCompositeClassifier(regions);
    expect(votes[0].bbox[0]).toBeCloseTo(0.1);
    expect(votes[0].bbox[1]).toBeCloseTo(0.2);
    expect(votes[0].bbox[2]).toBeCloseTo(0.4); // width
    expect(votes[0].bbox[3]).toBeCloseTo(0.4); // height
  });

  it("votesFromYoloHeatmap flattens confidentRegions", () => {
    const heatmap: YoloHeatmap = {
      pageNumber: 8,
      gridResolution: [16, 16],
      confidentRegions: [
        { bbox: [0.1, 0.1, 0.3, 0.3], confidence: 0.85, classes: ["text_box"], cellCount: 10 },
        { bbox: [0.5, 0.5, 0.3, 0.3], confidence: 0.7, classes: ["vertical_area"], cellCount: 6 },
      ],
      classContributions: { text_box: 0.6, vertical_area: 0.4 },
      summary: "2 confident regions",
    };
    const votes = votesFromYoloHeatmap(heatmap);
    expect(votes).toHaveLength(2);
    expect(votes.every((v) => v.source === "yolo-heatmap")).toBe(true);
  });

  it("votesFromParsedRegions filters to schedule + keynote only", () => {
    const parsed = [
      { id: "p1", type: "schedule", category: "door-schedule", bbox: [0.1, 0.1, 0.3, 0.3], confidence: 0.99, data: {} as any },
      { id: "p2", type: "legend", category: "symbol-legend", bbox: [0.5, 0.5, 0.3, 0.3], confidence: 0.99, data: {} as any },
      { id: "p3", type: "keynote", category: "keynote-table", bbox: [0.6, 0.6, 0.3, 0.3], confidence: 0.99, data: {} as any },
    ] as unknown as ParsedRegion[];
    const votes = votesFromParsedRegions(parsed);
    expect(votes).toHaveLength(2); // schedule + keynote
    expect(votes.every((v) => v.source === "parsed-region")).toBe(true);
  });

  it("collectAllVotes concatenates every adapter result", () => {
    const votes = collectAllVotes({
      classifiedTables: [],
      classifiedRegionsTables: [],
      yoloHeatmap: undefined,
      parsedRegions: [],
    });
    expect(votes).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Config tuning
// ═══════════════════════════════════════════════════════════════════

describe("config tuning", () => {
  it("lowering minDistinctVotes to 1 lets single sources pass", () => {
    const votes: RegionVote[] = [
      { source: "table-classifier", bbox: [0.1, 0.1, 0.4, 0.4], score: 0.95 },
    ];
    const regions = reduceRegionVotes(1, votes, { minDistinctVotes: 1, sourceWeights: { "table-classifier": 1.0 } });
    expect(regions.length).toBeGreaterThan(0);
  });

  it("raising probabilityThreshold suppresses lower-confidence regions", () => {
    const votes: RegionVote[] = [
      { source: "table-classifier", bbox: [0.1, 0.1, 0.4, 0.4], score: 0.6 },
      { source: "yolo-heatmap", bbox: [0.1, 0.1, 0.4, 0.4], score: 0.6 },
    ];
    const lenient = reduceRegionVotes(1, votes);
    const strict = reduceRegionVotes(1, votes, { probabilityThreshold: 0.9 });
    expect(strict.length).toBeLessThanOrEqual(lenient.length);
  });

  it("DEFAULT_ENSEMBLE_CONFIG is the expected shape", () => {
    expect(DEFAULT_ENSEMBLE_CONFIG.minDistinctVotes).toBe(2);
    expect(DEFAULT_ENSEMBLE_CONFIG.probabilityThreshold).toBe(0.5);
    expect(DEFAULT_ENSEMBLE_CONFIG.sourceWeights["table-classifier"]).toBeLessThan(1);
  });
});
