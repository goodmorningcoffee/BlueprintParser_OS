import { describe, it, expect } from "vitest";
import { resolveRegionType, weightFor } from "../primitives/region-weight";
import { DEFAULT_SCORING_CONFIG } from "../types";
import type { RegionLookup } from "../types";
import type { BboxMinMax } from "@/types";

function mkRegion(bbox: BboxMinMax): { bbox: BboxMinMax } {
  return { bbox };
}

describe("resolveRegionType", () => {
  it("returns unclassified when regions are undefined", () => {
    expect(resolveRegionType({ x: 0.5, y: 0.5 }, undefined)).toBe("unclassified");
  });

  it("returns unclassified for a point outside every region", () => {
    const regions: RegionLookup = {
      titleBlocks: [mkRegion([0.0, 0.0, 0.2, 0.1])],
      tables: [mkRegion([0.5, 0.5, 0.8, 0.7])],
      drawings: [mkRegion([0.1, 0.1, 0.4, 0.4])],
    };
    expect(resolveRegionType({ x: 0.9, y: 0.9 }, regions)).toBe("unclassified");
  });

  it("returns drawings when point is inside drawings only", () => {
    const regions: RegionLookup = {
      titleBlocks: [],
      tables: [],
      drawings: [mkRegion([0.1, 0.1, 0.9, 0.9])],
    };
    expect(resolveRegionType({ x: 0.5, y: 0.5 }, regions)).toBe("drawings");
  });

  it("returns tables when point is inside tables only", () => {
    const regions: RegionLookup = {
      titleBlocks: [],
      tables: [mkRegion([0.1, 0.1, 0.9, 0.9])],
      drawings: [],
    };
    expect(resolveRegionType({ x: 0.5, y: 0.5 }, regions)).toBe("tables");
  });

  it("returns title_block when point is inside title_block only", () => {
    const regions: RegionLookup = {
      titleBlocks: [mkRegion([0.0, 0.0, 0.9, 0.9])],
      tables: [],
      drawings: [],
    };
    expect(resolveRegionType({ x: 0.5, y: 0.5 }, regions)).toBe("title_block");
  });

  it("prefers title_block over tables when point is inside both", () => {
    // Preserves applyExclusionFilter precedence: title_block wins
    const regions: RegionLookup = {
      titleBlocks: [mkRegion([0.0, 0.0, 0.9, 0.9])],
      tables: [mkRegion([0.0, 0.0, 0.9, 0.9])],
      drawings: [],
    };
    expect(resolveRegionType({ x: 0.5, y: 0.5 }, regions)).toBe("title_block");
  });

  it("prefers tables over drawings when point is inside both", () => {
    // CRITICAL: matches applyExclusionFilter composite-classifier.ts:402
    // which drops inside_table even when also inside drawings
    const regions: RegionLookup = {
      titleBlocks: [],
      tables: [mkRegion([0.0, 0.0, 0.9, 0.9])],
      drawings: [mkRegion([0.0, 0.0, 0.9, 0.9])],
    };
    expect(resolveRegionType({ x: 0.5, y: 0.5 }, regions)).toBe("tables");
  });

  it("prefers title_block over tables over drawings in triple-overlap", () => {
    const regions: RegionLookup = {
      titleBlocks: [mkRegion([0.0, 0.0, 1.0, 1.0])],
      tables: [mkRegion([0.0, 0.0, 1.0, 1.0])],
      drawings: [mkRegion([0.0, 0.0, 1.0, 1.0])],
    };
    expect(resolveRegionType({ x: 0.5, y: 0.5 }, regions)).toBe("title_block");
  });

  it("handles multiple regions of the same kind", () => {
    const regions: RegionLookup = {
      titleBlocks: [],
      tables: [
        mkRegion([0.0, 0.0, 0.1, 0.1]),
        mkRegion([0.5, 0.5, 0.6, 0.6]),
      ],
      drawings: [],
    };
    expect(resolveRegionType({ x: 0.55, y: 0.55 }, regions)).toBe("tables");
    expect(resolveRegionType({ x: 0.05, y: 0.05 }, regions)).toBe("tables");
    expect(resolveRegionType({ x: 0.3, y: 0.3 }, regions)).toBe("unclassified");
  });
});

describe("weightFor", () => {
  it("returns the configured weight for each region type", () => {
    expect(weightFor("drawings", DEFAULT_SCORING_CONFIG)).toBe(1.0);
    expect(weightFor("unclassified", DEFAULT_SCORING_CONFIG)).toBe(0.5);
    expect(weightFor("tables", DEFAULT_SCORING_CONFIG)).toBe(0.3);
    expect(weightFor("title_block", DEFAULT_SCORING_CONFIG)).toBe(0.05);
  });

  it("uses overridden weights when passed a custom config", () => {
    const custom = {
      ...DEFAULT_SCORING_CONFIG,
      regionWeights: {
        drawings: 0.9,
        unclassified: 0.6,
        tables: 0.4,
        title_block: 0.1,
      },
    };
    expect(weightFor("drawings", custom)).toBe(0.9);
    expect(weightFor("tables", custom)).toBe(0.4);
  });
});
