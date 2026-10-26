// [TP-1 WP-1.C, K12] Which saved symbol-search rows a new Save replaces: same page, same spot.
import { describe, expect, it } from "vitest";
import { bboxIou, symbolSaveReplaceIds, SYMBOL_REPLACE_IOU } from "@/lib/symbol-save";

const row = (id: number, pageNumber: number, bbox: number[], source = "symbol-search") => ({ id, pageNumber, source, bbox });

describe("bboxIou", () => {
  it("is 1 for identical boxes, 0 for disjoint or touching boxes", () => {
    expect(bboxIou([0, 0, 1, 1], [0, 0, 1, 1])).toBe(1);
    expect(bboxIou([0, 0, 0.1, 0.1], [0.2, 0.2, 0.3, 0.3])).toBe(0);
    expect(bboxIou([0, 0, 0.1, 0.1], [0.1, 0, 0.2, 0.1])).toBe(0);
  });

  it("is the overlap over the union", () => {
    expect(bboxIou([0, 0, 0.2, 0.1], [0.1, 0, 0.3, 0.1])).toBeCloseTo(1 / 3, 10);
  });

  it("is 0 for a degenerate box", () => {
    expect(bboxIou([0.1, 0.1, 0.1, 0.1], [0, 0, 1, 1])).toBe(0);
  });
});

describe("symbolSaveReplaceIds", () => {
  it("names only symbol-search rows on the same page that a new match overlaps enough", () => {
    const existing = [
      row(1, 4, [0.1, 0.1, 0.15, 0.15]), // template A, same spot as the new match → replaced
      row(2, 4, [0.6, 0.6, 0.65, 0.65]), // template A elsewhere on the page → kept
      row(3, 5, [0.1, 0.1, 0.15, 0.15]), // same spot, other page → kept
      row(4, 4, [0.1, 0.1, 0.15, 0.15], "user"), // not a symbol-search row → kept
    ];
    expect(symbolSaveReplaceIds(existing, [{ pageNumber: 4, bbox: [0.101, 0.1, 0.151, 0.15] }])).toEqual([1]);
  });

  it("keeps template A when template B lands elsewhere on the page", () => {
    const existing = [row(7, 4, [0.1, 0.1, 0.15, 0.15]), row(8, 4, [0.6, 0.6, 0.65, 0.65])];
    expect(symbolSaveReplaceIds(existing, [{ pageNumber: 4, bbox: [0.3, 0.3, 0.35, 0.35] }])).toEqual([]);
  });

  it("uses the IoU threshold inclusively and returns sorted unique ids", () => {
    expect(SYMBOL_REPLACE_IOU).toBe(0.5);
    const existing = [row(9, 1, [0, 0, 0.2, 0.1]), row(3, 1, [0, 0, 0.1, 0.1])];
    // [0,0,0.1,0.1] vs [0,0,0.2,0.1] → IoU 0.5 exactly; both new matches hit row 3.
    const ids = symbolSaveReplaceIds(existing, [
      { pageNumber: 1, bbox: [0, 0, 0.1, 0.1] },
      { pageNumber: 1, bbox: [0, 0, 0.1, 0.1] },
    ]);
    expect(ids).toEqual([3, 9]);
  });

  it("returns nothing for an empty save", () => {
    expect(symbolSaveReplaceIds([row(1, 1, [0, 0, 1, 1])], [])).toEqual([]);
  });
});
