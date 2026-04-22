import { describe, it, expect } from "vitest";
import {
  detectAutoTables,
  detectAutoTablesForProject,
  DEFAULT_AUTO_DETECT_CONFIG,
} from "@/lib/auto-detect/auto-table-detector";
import type { EnsembleRegion } from "@/types";

function makeEnsembleRegion(
  pageNumber: number,
  tableProbability: number,
  category?: string,
  voteSources: any[] = ["table-classifier", "yolo-heatmap"],
): EnsembleRegion {
  return {
    bbox: [0.1, 0.1, 0.4, 0.4],
    tableProbability,
    contributingVotes: [],
    voteSources,
    category,
    reasoning: `test region p=${tableProbability}`,
    pageNumber,
  };
}

describe("detectAutoTables", () => {
  it("returns empty array for undefined / empty input", () => {
    expect(detectAutoTables(1, undefined)).toEqual([]);
    expect(detectAutoTables(1, [])).toEqual([]);
  });

  it("emits proposals for regions at/above the probability floor", () => {
    const regions = [
      makeEnsembleRegion(5, 0.9, "door-schedule"),
      makeEnsembleRegion(5, 0.7, "finish-schedule"),
    ];
    const props = detectAutoTables(5, regions);
    expect(props).toHaveLength(2);
    expect(props[0].category).toBe("door-schedule");
    expect(props[0].tableProbability).toBe(0.9);
  });

  it("filters out regions below minProbability", () => {
    const regions = [
      makeEnsembleRegion(5, 0.9),
      makeEnsembleRegion(5, 0.6), // below default 0.65
      makeEnsembleRegion(5, 0.5),
    ];
    const props = detectAutoTables(5, regions);
    expect(props).toHaveLength(1);
    expect(props[0].tableProbability).toBe(0.9);
  });

  it("respects custom minProbability override", () => {
    const regions = [
      makeEnsembleRegion(5, 0.9),
      makeEnsembleRegion(5, 0.55),
    ];
    const props = detectAutoTables(5, regions, { minProbability: 0.5 });
    expect(props).toHaveLength(2);
  });

  it("honors categoryFilter when provided", () => {
    const regions = [
      makeEnsembleRegion(5, 0.8, "door-schedule"),
      makeEnsembleRegion(5, 0.85, "symbol-legend"),
      makeEnsembleRegion(5, 0.9, "finish-schedule"),
    ];
    const props = detectAutoTables(5, regions, {
      categoryFilter: ["door-schedule", "finish-schedule"],
    });
    expect(props.map((p) => p.category).sort()).toEqual(["door-schedule", "finish-schedule"]);
  });

  it("empty categoryFilter means accept all", () => {
    const regions = [makeEnsembleRegion(5, 0.8, "x"), makeEnsembleRegion(5, 0.9, "y")];
    const props = detectAutoTables(5, regions, { categoryFilter: [] });
    expect(props).toHaveLength(2);
  });

  it("skips uncategorized regions when a category filter is active", () => {
    const regions = [
      makeEnsembleRegion(5, 0.9, undefined),
      makeEnsembleRegion(5, 0.9, "door-schedule"),
    ];
    const props = detectAutoTables(5, regions, { categoryFilter: ["door-schedule"] });
    expect(props).toHaveLength(1);
    expect(props[0].category).toBe("door-schedule");
  });

  it("propagates tableProbability, category, reasoning, and voteSources", () => {
    const region = makeEnsembleRegion(5, 0.88, "door-schedule", ["table-classifier", "composite-classifier", "yolo-heatmap"]);
    const [prop] = detectAutoTables(5, [region]);
    expect(prop.tableProbability).toBe(0.88);
    expect(prop.category).toBe("door-schedule");
    expect(prop.reasoning).toContain("p=0.88");
    expect(prop.voteSources).toHaveLength(3);
  });

  it("respects maxPerPage cap", () => {
    const regions = Array.from({ length: 15 }, () => makeEnsembleRegion(5, 0.9));
    const props = detectAutoTables(5, regions, { maxPerPage: 3 });
    expect(props).toHaveLength(3);
  });

  it("default config is the expected shape", () => {
    expect(DEFAULT_AUTO_DETECT_CONFIG.minProbability).toBe(0.65);
    expect(DEFAULT_AUTO_DETECT_CONFIG.maxPerPage).toBe(10);
  });

  it("proposal IDs are deterministic per-page", () => {
    const regions = [
      makeEnsembleRegion(5, 0.9, "door-schedule"),
      makeEnsembleRegion(5, 0.8, "finish-schedule"),
    ];
    const props = detectAutoTables(5, regions);
    expect(props[0].id).toBe("auto-5-0");
    expect(props[1].id).toBe("auto-5-1");
  });
});

describe("detectAutoTablesForProject", () => {
  it("fans out per-page and skips pages with no proposals", () => {
    const input = new Map([
      [1, [makeEnsembleRegion(1, 0.9, "door-schedule")]],
      [2, [makeEnsembleRegion(2, 0.4)]], // below threshold → no proposal
      [3, [makeEnsembleRegion(3, 0.85, "finish-schedule")]],
    ]);
    const out = detectAutoTablesForProject(input);
    expect([...out.keys()].sort()).toEqual([1, 3]);
    expect(out.get(1)!).toHaveLength(1);
    expect(out.get(3)!).toHaveLength(1);
  });

  it("passes config through to per-page calls", () => {
    const input = new Map([[1, [makeEnsembleRegion(1, 0.55)]]]);
    const out = detectAutoTablesForProject(input, { minProbability: 0.5 });
    expect(out.get(1)).toHaveLength(1);
  });
});

describe("door-schedule false-positive defense", () => {
  // Ensemble regions from keyword-only-suppressed pages never reach the
  // auto-detector because they're already absent from ensembleRegions.
  // Sanity-check: a region that somehow leaked through with low probability
  // is still rejected by the auto-detector's floor.
  it("auto-detector rejects low-probability leakage", () => {
    const regions = [makeEnsembleRegion(8, 0.4, "door-schedule")];
    expect(detectAutoTables(8, regions)).toEqual([]);
  });
});
