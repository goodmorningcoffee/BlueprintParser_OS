// @vitest-environment node
// [table pipeline WP-2.0b] The one ParsedRegion.bbox reader (K04): stored MinMax is read as MinMax.

import { describe, expect, it } from "vitest";
import { parsedRegionMinMax } from "@/lib/parsed-region-bbox";

describe("parsedRegionMinMax", () => {
  it("reads a stored schedule box as MinMax, not LTWH (no [.6,.1,1.5,.5])", () => {
    expect(parsedRegionMinMax({ bbox: [0.6, 0.1, 0.9, 0.4] })).toEqual([0.6, 0.1, 0.9, 0.4]);
  });

  it("returns a fresh tuple", () => {
    const bbox = [0.1, 0.2, 0.3, 0.4];
    const out = parsedRegionMinMax({ bbox });
    expect(out).not.toBe(bbox);
    out![0] = 9;
    expect(bbox[0]).toBe(0.1);
  });

  it("returns null for a missing or malformed box", () => {
    expect(parsedRegionMinMax(null)).toBeNull();
    expect(parsedRegionMinMax(undefined)).toBeNull();
    expect(parsedRegionMinMax({})).toBeNull();
    expect(parsedRegionMinMax({ bbox: null })).toBeNull();
    expect(parsedRegionMinMax({ bbox: [0.1, 0.2, 0.3] })).toBeNull();
    expect(parsedRegionMinMax({ bbox: [0.1, 0.2, Number.NaN, 0.4] })).toBeNull();
    expect(parsedRegionMinMax({ bbox: ["0.1", 0.2, 0.3, 0.4] as unknown as number[] })).toBeNull();
  });
});
