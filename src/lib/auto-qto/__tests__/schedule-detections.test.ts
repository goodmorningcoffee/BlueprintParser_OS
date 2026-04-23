import { describe, it, expect } from "vitest";
import { computeScheduleDetections } from "../schedule-detections";
import type { ScheduleSummaryEntry } from "@/types";

describe("computeScheduleDetections — per-page three-tier fallback", () => {
  it("prefers Tier 1 (ensembleRegions) when present on a page", () => {
    const pageIntelligence = {
      1: {
        ensembleRegions: [{ category: "door-schedule", tableProbability: 0.92 }],
        classifiedTables: [{ category: "door-schedule", confidence: 0.55 }],
      },
    };
    const summaries: ScheduleSummaryEntry[] = [
      { pageNum: 1, category: "door-schedule", name: "Door Sch", confidence: 0.6 },
    ];
    const result = computeScheduleDetections(pageIntelligence, summaries, { 1: "A-1" });
    expect(result["door-schedule"]).toHaveLength(1);
    expect(result["door-schedule"][0]).toMatchObject({ pageNum: 1, confidence: 0.92, name: "A-1" });
  });

  it("falls back to Tier 2 (summaries) on pages WITHOUT ensembleRegions — even when other pages have ensembleRegions", () => {
    // Partial-reprocess scenario: p1 reprocessed, p2 not
    const pageIntelligence = {
      1: { ensembleRegions: [{ category: "door-schedule", tableProbability: 0.9 }] },
      2: {},
    };
    const summaries: ScheduleSummaryEntry[] = [
      { pageNum: 2, category: "finish-schedule", name: "Finish Sch", confidence: 0.7 },
    ];
    const result = computeScheduleDetections(pageIntelligence, summaries, {});
    expect(result["door-schedule"]).toHaveLength(1);
    expect(result["door-schedule"][0].pageNum).toBe(1);
    // REGRESSION GUARD: the old code returned immediately after Tier 1 and
    // dropped p2's summaries entry — this assertion locks the fix.
    expect(result["finish-schedule"]).toHaveLength(1);
    expect(result["finish-schedule"][0].pageNum).toBe(2);
  });

  it("falls back to Tier 3 (classifiedTables) when neither Tier 1 nor Tier 2 available for a page", () => {
    const pageIntelligence = {
      3: { classifiedTables: [{ category: "equipment-schedule", confidence: 0.5 }] },
    };
    const result = computeScheduleDetections(pageIntelligence, [], { 3: "M-1" });
    expect(result["equipment-schedule"]).toHaveLength(1);
    expect(result["equipment-schedule"][0]).toMatchObject({ pageNum: 3, confidence: 0.5, name: "M-1" });
  });

  it("includes pages that only exist in summaries (not yet in pageIntelligence)", () => {
    const pageIntelligence = {
      1: { ensembleRegions: [{ category: "door-schedule", tableProbability: 0.9 }] },
    };
    const summaries: ScheduleSummaryEntry[] = [
      { pageNum: 40, category: "door-schedule", name: "Page 40 Doors", confidence: 0.75 },
    ];
    const result = computeScheduleDetections(pageIntelligence, summaries, {});
    const pages = result["door-schedule"].map((d) => d.pageNum).sort((a, b) => a - b);
    expect(pages).toEqual([1, 40]);
  });

  it("skips pages with no source data", () => {
    const result = computeScheduleDetections({ 5: {} }, [], {});
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("ignores ensembleRegions without a category", () => {
    const pageIntelligence = {
      1: {
        ensembleRegions: [
          { category: undefined, tableProbability: 0.99 },
          { category: "door-schedule", tableProbability: 0.8 },
        ],
      },
    };
    const result = computeScheduleDetections(pageIntelligence, [], {});
    expect(result["door-schedule"]).toHaveLength(1);
  });

  it("merges multiple ensemble regions on one page into the same category", () => {
    const pageIntelligence = {
      1: {
        ensembleRegions: [
          { category: "door-schedule", tableProbability: 0.9 },
          { category: "door-schedule", tableProbability: 0.8 },
        ],
      },
    };
    const result = computeScheduleDetections(pageIntelligence, [], {});
    expect(result["door-schedule"]).toHaveLength(2);
  });
});
