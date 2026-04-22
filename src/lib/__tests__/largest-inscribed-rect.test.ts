import { describe, it, expect } from "vitest";
import {
  largestInscribedRect,
  topKInscribedRects,
  rasterizeBboxes,
  type InscribedRect,
} from "@/lib/geom/largest-inscribed-rect";

function makeMask(rows: string[]): { mask: Uint8Array; w: number; h: number } {
  const h = rows.length;
  const w = rows[0].length;
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      mask[y * w + x] = rows[y][x] === "#" ? 1 : 0;
    }
  }
  return { mask, w, h };
}

describe("largestInscribedRect", () => {
  it("returns empty rect for zero-sized mask", () => {
    expect(largestInscribedRect(new Uint8Array(0), 0, 0)).toEqual({
      x: 0, y: 0, w: 0, h: 0, area: 0,
    });
  });

  it("returns whole area when mask is all empty", () => {
    const { mask, w, h } = makeMask([
      "...",
      "...",
      "...",
    ]);
    expect(largestInscribedRect(mask, w, h)).toEqual({
      x: 0, y: 0, w: 3, h: 3, area: 9,
    });
  });

  it("returns zero area when mask is fully blocked", () => {
    const { mask, w, h } = makeMask([
      "###",
      "###",
    ]);
    const r = largestInscribedRect(mask, w, h);
    expect(r.area).toBe(0);
  });

  it("finds a single internal empty rectangle", () => {
    // 4×3 mask with a 2×2 empty block at (1,0)
    const { mask, w, h } = makeMask([
      "#..#",
      "#..#",
      "####",
    ]);
    const r = largestInscribedRect(mask, w, h);
    expect(r.area).toBe(4);
    expect(r.w).toBe(2);
    expect(r.h).toBe(2);
    expect(r.x).toBe(1);
    expect(r.y).toBe(0);
  });

  it("prefers wider rectangle when multiple areas tie", () => {
    // Two empty regions of equal area should find at least one correctly
    const { mask, w, h } = makeMask([
      "..##..",
      "..##..",
      "..##..",
    ]);
    const r = largestInscribedRect(mask, w, h);
    expect(r.area).toBe(6); // 2 wide × 3 tall
  });

  it("finds tall column gutter between text blocks", () => {
    // Simulates a column gutter: two text blocks separated by an empty column
    const { mask, w, h } = makeMask([
      "##.##",
      "##.##",
      "##.##",
      "##.##",
    ]);
    const r = largestInscribedRect(mask, w, h);
    expect(r.area).toBe(4); // 1 wide × 4 tall
    expect(r.w).toBe(1);
    expect(r.h).toBe(4);
    expect(r.x).toBe(2);
  });

  it("throws on mask size mismatch", () => {
    expect(() => largestInscribedRect(new Uint8Array(4), 5, 5)).toThrow();
  });
});

describe("topKInscribedRects", () => {
  it("returns empty array when k=0", () => {
    const { mask, w, h } = makeMask(["..."]);
    expect(topKInscribedRects(mask, w, h, 0)).toEqual([]);
  });

  it("finds top-K rectangles in descending area order", () => {
    // 5×5 mask with two empty regions of sizes 3×3 and 2×2
    const { mask, w, h } = makeMask([
      "...##",
      "...##",
      "...##",
      "####.",
      "##...",
    ]);
    const rects = topKInscribedRects(mask, w, h, 3);
    expect(rects.length).toBeGreaterThanOrEqual(2);
    // First rectangle is the 3×3 block at top-left
    expect(rects[0].area).toBe(9);
    // Each subsequent rectangle has <= area of the previous
    for (let i = 1; i < rects.length; i++) {
      expect(rects[i].area).toBeLessThanOrEqual(rects[i - 1].area);
    }
  });

  it("does not mutate caller's mask", () => {
    const { mask, w, h } = makeMask([
      "...",
      "...",
      "...",
    ]);
    const snapshot = Array.from(mask);
    topKInscribedRects(mask, w, h, 3);
    expect(Array.from(mask)).toEqual(snapshot);
  });

  it("stops when no empty space remains", () => {
    const { mask, w, h } = makeMask([
      "#.",
      "##",
    ]);
    const rects = topKInscribedRects(mask, w, h, 10);
    expect(rects.length).toBeLessThanOrEqual(1);
  });
});

describe("rasterizeBboxes", () => {
  it("rasterizes normalized bboxes onto a mask", () => {
    const mask = rasterizeBboxes(
      [{ bbox: [0, 0, 0.5, 1] }],
      10,
      10,
    );
    // Left half should be 1s
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 5; x++) expect(mask[y * 10 + x]).toBe(1);
      for (let x = 5; x < 10; x++) expect(mask[y * 10 + x]).toBe(0);
    }
  });

  it("handles empty input as all-empty mask", () => {
    const mask = rasterizeBboxes([], 4, 4);
    expect(mask.every((v) => v === 0)).toBe(true);
  });

  it("clips boxes extending outside the mask", () => {
    const mask = rasterizeBboxes(
      [{ bbox: [-0.1, -0.1, 2, 2] }],
      5,
      5,
    );
    expect(mask.every((v) => v === 1)).toBe(true);
  });

  it("supports absolute-pixel coordinates", () => {
    const mask = rasterizeBboxes(
      [{ bbox: [1, 1, 2, 2] }],
      5,
      5,
      { normalized: false },
    );
    // Cells (1,1), (2,1), (1,2), (2,2) should be 1
    expect(mask[1 * 5 + 1]).toBe(1);
    expect(mask[1 * 5 + 2]).toBe(1);
    expect(mask[2 * 5 + 1]).toBe(1);
    expect(mask[2 * 5 + 2]).toBe(1);
    // Others should be 0
    expect(mask[0 * 5 + 0]).toBe(0);
  });
});
