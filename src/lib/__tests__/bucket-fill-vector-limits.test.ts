/**
 * The mask-dimension overflow guard, and the snap grid.
 *
 * The overflow test is the important one. `rastermask.ts` builds its adaptive threshold from a
 * `Uint32Array` summed-area table, and a grayscale cell contributes up to 255, so the largest
 * safe square mask is bounded by
 *
 *     dim² · 255 < 2³²
 *
 * Past that the accumulator WRAPS SILENTLY — Uint32Array truncates, it does not throw — and every
 * window mean after the wrap is wrong, so the threshold binarizes garbage. These tests pin the
 * arithmetic so the ceiling cannot be raised by someone who has only read the comment.
 */

import { describe, it, expect } from "vitest";
import {
  MASK_DIM_DEFAULT,
  MASK_MAX_DIM_HARD,
  MASK_DIM_OVERFLOW_CEILING,
  integralImageFits,
  clampMaskDim,
} from "@/lib/bucket-fill-vector-limits";
import { buildSnapGrid, NO_SNAP } from "@/lib/bucket-fill-snapgrid";
import { snapVertices, type Point } from "@/lib/oneclick/oneclick";

describe("mask dimension overflow ceiling", () => {
  it("locates the exact ceiling: 4104 fits in Uint32, 4105 does not", () => {
    // Computed here rather than quoted, so the test fails if the arithmetic ever stops holding.
    expect(integralImageFits(MASK_DIM_OVERFLOW_CEILING)).toBe(true);
    expect(integralImageFits(MASK_DIM_OVERFLOW_CEILING + 1)).toBe(false);
    expect(MASK_DIM_OVERFLOW_CEILING).toBe(4104);

    // The concrete numbers, for anyone reading a failure message.
    expect(4104 * 4104 * 255).toBe(4_294_918_080);
    expect(4104 * 4104 * 255).toBeLessThan(2 ** 32);
    expect(4105 * 4105 * 255).toBeGreaterThan(2 ** 32);
  });

  it("keeps the hard cap strictly below the ceiling, with headroom", () => {
    expect(MASK_MAX_DIM_HARD).toBeLessThan(MASK_DIM_OVERFLOW_CEILING);
    expect(integralImageFits(MASK_MAX_DIM_HARD)).toBe(true);
    expect(MASK_MAX_DIM_HARD).toBe(4096); // 2^12
  });

  it("keeps the pinned working value safely inside the cap", () => {
    expect(MASK_DIM_DEFAULT).toBe(3000);
    expect(MASK_DIM_DEFAULT).toBeLessThan(MASK_MAX_DIM_HARD);
    expect(integralImageFits(MASK_DIM_DEFAULT)).toBe(true);
  });

  it("demonstrates the wrap it prevents", () => {
    // Not a hypothetical: this is what Uint32Array does at the boundary. A guard that stops a
    // failure nobody has seen is easy to delete later; showing the failure is what keeps it.
    const acc = new Uint32Array(1);
    acc[0] = 4_294_967_295; // 2^32 - 1
    acc[0] += 1;
    expect(acc[0]).toBe(0); // silent wrap, no throw
  });
});

describe("clampMaskDim", () => {
  it("passes safe values through unchanged", () => {
    expect(clampMaskDim(3000)).toBe(3000);
    expect(clampMaskDim(1000)).toBe(1000);
    expect(clampMaskDim(MASK_MAX_DIM_HARD)).toBe(MASK_MAX_DIM_HARD);
  });

  it("clamps anything above the hard cap, including values that would overflow", () => {
    expect(clampMaskDim(5000)).toBe(MASK_MAX_DIM_HARD);
    expect(clampMaskDim(4105)).toBe(MASK_MAX_DIM_HARD);
    expect(clampMaskDim(100000)).toBe(MASK_MAX_DIM_HARD);
    expect(integralImageFits(clampMaskDim(100000))).toBe(true);
  });

  it("falls back to the default rather than propagating garbage into an allocation", () => {
    expect(clampMaskDim(0)).toBe(MASK_DIM_DEFAULT);
    expect(clampMaskDim(-1)).toBe(MASK_DIM_DEFAULT);
    expect(clampMaskDim(NaN)).toBe(MASK_DIM_DEFAULT);
    expect(clampMaskDim(Infinity)).toBe(MASK_DIM_DEFAULT);
  });

  it("floors fractional requests", () => {
    expect(clampMaskDim(2999.9)).toBe(2999);
  });
});

describe("snap grid", () => {
  const pts: Point[] = [
    [10, 10],
    [100, 100],
    [103, 101],
    [-50, -50], // negative coords: a CropBox offset can place geometry left of the origin
  ];

  it("finds the nearest endpoint inside the tolerance", () => {
    const g = buildSnapGrid(pts);
    expect(g.nearest(101, 101, 6)).toEqual([100, 100]);
    expect(g.size).toBe(4);
  });

  it("returns null when nothing is inside the tolerance", () => {
    const g = buildSnapGrid(pts);
    expect(g.nearest(500, 500, 6)).toBeNull();
    expect(g.nearest(101, 101, 0)).toBeNull();
  });

  it("handles negative coordinates without key collisions across the axis", () => {
    // An unbiased grid key would fold negative cells onto positive ones and return the wrong
    // point — the failure would look like a snap to a vertex on the far side of the sheet.
    const g = buildSnapGrid(pts);
    expect(g.nearest(-49, -49, 6)).toEqual([-50, -50]);
    expect(g.nearest(11, 11, 6)).toEqual([10, 10]);
  });

  it("picks the closest of several candidates in range", () => {
    const g = buildSnapGrid(pts);
    expect(g.nearest(102, 100.5, 8)).toEqual([103, 101]);
  });

  it("widens the search when maxDist exceeds the cell size", () => {
    const g = buildSnapGrid([[0, 0]], 2);
    expect(g.nearest(9, 0, 4)).toBeNull();
    expect(g.nearest(9, 0, 12)).toEqual([0, 0]);
  });

  it("is empty-safe", () => {
    expect(buildSnapGrid([]).nearest(0, 0, 10)).toBeNull();
  });

  it("drives the engine's snapVertices, and NO_SNAP leaves a polygon untouched", () => {
    const poly: Point[] = [
      [10.4, 10.4],
      [100.6, 100.6],
      [200, 10],
    ];
    // NO_SNAP is the shipping default while snapping stays disabled: identity.
    expect(snapVertices(poly, NO_SNAP, 6, 2)).toEqual(poly);

    // With the grid, near-miss corners pull onto real endpoints.
    const snapped = snapVertices(poly, buildSnapGrid(pts).nearest, 6, 2);
    expect(snapped).toContainEqual([10, 10]);
    expect(snapped).toContainEqual([100, 100]);
  });
});
