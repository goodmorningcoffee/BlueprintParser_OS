/**
 * Unit tests for findHoleBorders — the riskiest piece of new logic in PR 1.
 *
 * findHoleBorders is the JS equivalent of OpenCV's RETR_CCOMP hierarchy:
 * it takes a filled binary mask and returns the borders of any enclosed
 * holes (e.g., a courtyard inside a U-shaped hallway).
 *
 * Algorithm under test:
 *   1. Mark all unfilled pixels as "hole candidate" (value 2)
 *   2. Flood from image edges through unfilled pixels, marking as "outside"
 *   3. Remaining "hole candidate" pixels are enclosed → group via BFS
 *   4. Trace each component with Moore neighbor border tracing
 *
 * These tests validate the cases PR 1 was designed to fix (the "bucket fill
 * swallows courtyard" bug) plus a few pathological shapes I was worried
 * about when reviewing the PR.
 *
 * jsdom note: this imports from the worker file, which contains a
 * `self.addEventListener("message", ...)` at module load. jsdom provides
 * `self` as a global, so importing works without a special setup step.
 */

import { describe, it, expect } from "vitest";
import { findHoleBorders, traceBorder } from "@/workers/bucket-fill.worker";

/** Build a filled mask where `setter(x, y)` decides each pixel. */
function makeFilled(w: number, h: number, setter: (x: number, y: number) => boolean): Uint8Array {
  const filled = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (setter(x, y)) filled[y * w + x] = 1;
    }
  }
  return filled;
}

describe("findHoleBorders", () => {
  it("returns empty array when the fill has no holes (simple square)", () => {
    const w = 20, h = 20;
    const filled = makeFilled(w, h, (x, y) => x >= 5 && x < 15 && y >= 5 && y < 15);
    const holes = findHoleBorders(filled, w, h);
    expect(holes).toHaveLength(0);
  });

  it("returns empty array for a completely empty fill", () => {
    const filled = new Uint8Array(20 * 20); // all zeros
    const holes = findHoleBorders(filled, 20, 20);
    expect(holes).toHaveLength(0);
  });

  it("returns empty array for a completely filled image (no holes possible)", () => {
    const filled = new Uint8Array(20 * 20).fill(1);
    const holes = findHoleBorders(filled, 20, 20);
    expect(holes).toHaveLength(0);
  });

  it("detects a single rectangular hole inside a filled region", () => {
    // 20x20 image with a 14x14 outer square (x=3..16, y=3..16) and a
    // 4x4 hole carved out at (x=8..11, y=8..11).
    const w = 20, h = 20;
    const filled = makeFilled(w, h, (x, y) => {
      const inOuter = x >= 3 && x < 17 && y >= 3 && y < 17;
      const inHole = x >= 8 && x < 12 && y >= 8 && y < 12;
      return inOuter && !inHole;
    });

    const holes = findHoleBorders(filled, w, h);
    expect(holes).toHaveLength(1);
    expect(holes[0].length).toBeGreaterThanOrEqual(3);

    // Every traced point must be on the hole's boundary, i.e. within the
    // hole's pixel bounding box. Moore tracing visits filled pixels of the
    // holeMask (= hole pixels in the original), so all points are in
    // [8..11] × [8..11].
    for (const p of holes[0]) {
      expect(p.x).toBeGreaterThanOrEqual(8);
      expect(p.x).toBeLessThanOrEqual(11);
      expect(p.y).toBeGreaterThanOrEqual(8);
      expect(p.y).toBeLessThanOrEqual(11);
    }
  });

  it("detects two separate holes in the same fill", () => {
    // 30x30 image with a 24x24 outer, two 4x4 holes at opposite corners.
    const w = 30, h = 30;
    const filled = makeFilled(w, h, (x, y) => {
      const inOuter = x >= 3 && x < 27 && y >= 3 && y < 27;
      const inHole1 = x >= 7 && x < 11 && y >= 7 && y < 11;
      const inHole2 = x >= 18 && x < 22 && y >= 18 && y < 22;
      return inOuter && !(inHole1 || inHole2);
    });

    const holes = findHoleBorders(filled, w, h);
    expect(holes).toHaveLength(2);
    for (const hole of holes) {
      expect(hole.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("detects an L-shaped hole (pathological non-convex shape)", () => {
    // 30x30 image, 24x24 outer, L-shaped hole carved by the union of a
    // horizontal bar (x=10..19, y=10..13) and a vertical bar (x=10..13, y=10..19).
    const w = 30, h = 30;
    const filled = makeFilled(w, h, (x, y) => {
      const inOuter = x >= 3 && x < 27 && y >= 3 && y < 27;
      const inHoleH = x >= 10 && x < 20 && y >= 10 && y < 14;
      const inHoleV = x >= 10 && x < 14 && y >= 10 && y < 20;
      const inHole = inHoleH || inHoleV;
      return inOuter && !inHole;
    });

    const holes = findHoleBorders(filled, w, h);
    expect(holes).toHaveLength(1);
    // An L has more boundary pixels than a square — should trace to a
    // non-trivial polygon, not a degenerate line.
    expect(holes[0].length).toBeGreaterThanOrEqual(6);

    // Every point must be inside the L's bounding box.
    for (const p of holes[0]) {
      expect(p.x).toBeGreaterThanOrEqual(10);
      expect(p.x).toBeLessThanOrEqual(19);
      expect(p.y).toBeGreaterThanOrEqual(10);
      expect(p.y).toBeLessThanOrEqual(19);
    }
  });

  it("still detects a hole when the fill touches the image edge", () => {
    // Bite check: my outside-flood seeds from image-edge unfilled pixels.
    // If the fill extends to the left edge (some edge pixels are filled),
    // those edge pixels are NOT seeded, but other edge pixels still are, so
    // outside flood still works. This test proves it with a specific case.
    const w = 20, h = 20;
    const filled = makeFilled(w, h, (x, y) => {
      // Fill extends from x=0 (touches left edge) to x=14. Hole in the middle.
      const inOuter = x >= 0 && x < 15 && y >= 3 && y < 17;
      const inHole = x >= 5 && x < 9 && y >= 7 && y < 11;
      return inOuter && !inHole;
    });

    const holes = findHoleBorders(filled, w, h);
    expect(holes).toHaveLength(1);
    expect(holes[0].length).toBeGreaterThanOrEqual(3);

    // Hole is still inside (5..8, 7..10)
    for (const p of holes[0]) {
      expect(p.x).toBeGreaterThanOrEqual(5);
      expect(p.x).toBeLessThanOrEqual(8);
      expect(p.y).toBeGreaterThanOrEqual(7);
      expect(p.y).toBeLessThanOrEqual(10);
    }
  });

  it("does not report 'outside' regions as holes (sanity for Bite 2)", () => {
    // This is the inverse of the "fill touches edge" test: what if there's
    // a big UNFILLED region in the middle of the image that happens to look
    // like a rectangle, but it's 4-connected to the image edge through some
    // corridor? It should NOT be reported as a hole.
    const w = 20, h = 20;
    const filled = makeFilled(w, h, (x, y) => {
      // A U-shape filled region — open to the top edge.
      // Two vertical bars (left + right) and a horizontal bar (bottom)
      // form a U. The interior of the U (middle-upper area) is unfilled
      // but reachable from the top edge — so it's "outside" not a hole.
      const leftBar = x >= 5 && x < 8 && y >= 5 && y < 15;
      const rightBar = x >= 12 && x < 15 && y >= 5 && y < 15;
      const bottomBar = x >= 5 && x < 15 && y >= 12 && y < 15;
      return leftBar || rightBar || bottomBar;
    });

    const holes = findHoleBorders(filled, w, h);
    // The interior of the U (above the bottom bar, between left and right
    // bars) is reachable from the top edge → no holes.
    expect(holes).toHaveLength(0);
  });
});

describe("traceBorder (sanity check — dependency of findHoleBorders)", () => {
  it("returns empty array for an empty filled mask", () => {
    const filled = new Uint8Array(10 * 10);
    const border = traceBorder(filled, 10, 10);
    expect(border).toEqual([]);
  });

  it("traces the boundary of a small solid block", () => {
    // 10x10 image with a 4x4 filled block at (3..6, 3..6).
    const w = 10, h = 10;
    const filled = makeFilled(w, h, (x, y) => x >= 3 && x < 7 && y >= 3 && y < 7);
    const border = traceBorder(filled, w, h);

    // A 4x4 block should produce a non-trivial border polygon.
    expect(border.length).toBeGreaterThanOrEqual(3);

    // Every traced point must be inside the block's bounding box.
    for (const p of border) {
      expect(p.x).toBeGreaterThanOrEqual(3);
      expect(p.x).toBeLessThanOrEqual(6);
      expect(p.y).toBeGreaterThanOrEqual(3);
      expect(p.y).toBeLessThanOrEqual(6);
    }

    // First traced point should be the topmost-leftmost filled pixel = (3, 3).
    expect(border[0]).toEqual({ x: 3, y: 3 });
  });
});
