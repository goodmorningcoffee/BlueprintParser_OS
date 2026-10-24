/**
 * geometry.test.ts — the MinMax arithmetic ported from regions_rc.py. Values are hand-computed
 * from the Python definitions so a drift in either port shows here.
 */
import { describe, it, expect } from "vitest";
import { area, cover, inter, iou, inside, ltwhToMinMax, minMaxToLtwh, overlapSmaller, textGrid, widenToward } from "../geometry";
import type { BboxMinMax } from "@/types";

const A: BboxMinMax = [0.1, 0.1, 0.3, 0.3];
const B: BboxMinMax = [0.2, 0.2, 0.4, 0.4];

describe("box arithmetic", () => {
  it("area / inter / iou / containment", () => {
    expect(area(A)).toBeCloseTo(0.04, 10);
    expect(inter(A, B)).toBeCloseTo(0.01, 10);
    expect(iou(A, B)).toBeCloseTo(0.01 / 0.07, 10);
    expect(overlapSmaller(A, [0.15, 0.15, 0.25, 0.25])).toBeCloseTo(1, 10); // the small box is inside A
    expect(iou([0, 0, 0, 0], A)).toBe(0); // degenerate → 0, never NaN
    expect(inside([0.3, 0.3], A)).toBe(true); // edges inclusive, as in Python
    expect(inside([0.31, 0.3], A)).toBe(false);
  });

  it("LTWH ↔ MinMax round-trips", () => {
    const close = (got: readonly number[], want: readonly number[]) => got.forEach((v, i) => expect(v).toBeCloseTo(want[i], 10));
    close(ltwhToMinMax([0.1, 0.2, 0.3, 0.4]), [0.1, 0.2, 0.4, 0.6]);
    close(minMaxToLtwh([0.1, 0.2, 0.4, 0.6]), [0.1, 0.2, 0.3, 0.4]);
  });

  it("cover samples a 24×24 grid of cell centres", () => {
    expect(cover(A, [])).toBe(0);
    expect(cover(A, [A])).toBe(1);
    // left half covered exactly → the 12 left columns of 24 hit
    expect(cover(A, [[0.1, 0.1, 0.2, 0.3]])).toBeCloseTo(0.5, 10);
    // union, not sum: two identical boxes still cover 0.5
    expect(cover(A, [[0.1, 0.1, 0.2, 0.3], [0.1, 0.1, 0.2, 0.3]])).toBeCloseTo(0.5, 10);
  });
});

describe("textGrid (yolo_text rows × aligned columns)", () => {
  const box = (x: number, y: number): BboxMinMax => [x, y, x + 0.03, y + 0.01];
  it("fewer than 6 boxes is never a grid", () => {
    expect(textGrid([box(0, 0), box(0.1, 0), box(0, 0.05)])).toEqual({ lines: 3, rows: 0, cols: 0 });
  });
  it("counts rows (≥ 2 boxes) and left-edge columns (≥ 3 boxes)", () => {
    const boxes: BboxMinMax[] = [];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) boxes.push(box(0.1 + c * 0.1, 0.1 + r * 0.05));
    expect(textGrid(boxes)).toEqual({ lines: 12, rows: 4, cols: 3 });
    // a lone box in its own row and its own column counts for neither
    expect(textGrid([...boxes, box(0.9, 0.9)])).toEqual({ lines: 13, rows: 4, cols: 3 });
  });
});

describe("widenToward (regions_rc.py widening rule)", () => {
  const T: BboxMinMax = [0.4, 0.4, 0.5, 0.5];
  it("a box no larger than the anchor, or ≥ 80 % inside it, is support only", () => {
    const w = widenToward(T, [{ label: "grid", bbox: [0.41, 0.41, 0.49, 0.49] }]);
    expect(w.bbox).toEqual(T);
    expect(w.support).toEqual({ grid: 1 });
    expect(w.grown).toEqual({});
  });
  it("a larger box covering < 30 % of the anchor is ignored", () => {
    const w = widenToward(T, [{ label: "horizontal_area", bbox: [0.0, 0.48, 0.9, 0.9] }]); // covers 20 % of T
    expect(w.bbox).toEqual(T);
    expect(w.support).toEqual({});
  });
  it("a larger box covering ≥ 30 % widens the anchor toward it, at most 2× per side, clipped to the page", () => {
    const w = widenToward(T, [{ label: "grid", bbox: [0.0, 0.0, 1.0, 0.47] }]); // covers 70 % of T
    // left: min(0.4, 0) but ≥ 0.4 − 0.2 = 0.2; top: ≥ 0.4 − 0.2 = 0.2; right: ≤ 0.5 + 0.2 = 0.7; bottom unchanged
    w.bbox.forEach((v, i) => expect(v).toBeCloseTo([0.2, 0.2, 0.7, 0.5][i], 10));
    expect(w.grown).toEqual({ grid: 1 });
    expect(w.support).toEqual({ grid: 1 });
  });
});
