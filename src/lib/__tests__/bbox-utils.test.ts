import { describe, it, expect } from "vitest";
import {
  ltwh2minmax, minmax2ltwh,
  bboxCenterLTWH, bboxCenterMinMax,
  bboxContainsPoint, bboxOverlap, bboxIoU,
  bboxAreaMinMax, bboxAreaLTWH,
  validateBbox, isValidMinMax, isValidLTWH,
} from "@/lib/bbox-utils";

// ─── Format conversion ─────────────────────────────────────

describe("ltwh2minmax", () => {
  it("converts standard bbox", () => {
    const r = ltwh2minmax([0.1, 0.2, 0.3, 0.4]);
    expect(r[0]).toBeCloseTo(0.1);
    expect(r[2]).toBeCloseTo(0.4);
    expect(r[3]).toBeCloseTo(0.6);
  });

  it("handles zero position", () => {
    expect(ltwh2minmax([0, 0, 0.5, 0.5])).toEqual([0, 0, 0.5, 0.5]);
  });

  it("handles full-page bbox", () => {
    expect(ltwh2minmax([0, 0, 1, 1])).toEqual([0, 0, 1, 1]);
  });
});

describe("minmax2ltwh", () => {
  it("converts standard bbox", () => {
    const r = minmax2ltwh([0.1, 0.2, 0.4, 0.6]);
    expect(r[0]).toBeCloseTo(0.1);
    expect(r[2]).toBeCloseTo(0.3);
    expect(r[3]).toBeCloseTo(0.4);
  });

  it("roundtrips with ltwh2minmax", () => {
    const original: [number, number, number, number] = [0.15, 0.25, 0.35, 0.45];
    const rt = minmax2ltwh(ltwh2minmax(original));
    for (let i = 0; i < 4; i++) expect(rt[i]).toBeCloseTo(original[i]);
  });
});

// ─── Center point ───────────────────────────────────────────

describe("bboxCenterLTWH", () => {
  it("computes center of LTWH bbox", () => {
    const { cx, cy } = bboxCenterLTWH([0.2, 0.3, 0.4, 0.2]);
    expect(cx).toBeCloseTo(0.4); // 0.2 + 0.4/2
    expect(cy).toBeCloseTo(0.4); // 0.3 + 0.2/2
  });
});

describe("bboxCenterMinMax", () => {
  it("computes center of MinMax bbox", () => {
    const { cx, cy } = bboxCenterMinMax([0.2, 0.3, 0.6, 0.5]);
    expect(cx).toBeCloseTo(0.4); // (0.2+0.6)/2
    expect(cy).toBeCloseTo(0.4); // (0.3+0.5)/2
  });

  it("matches LTWH center after conversion", () => {
    const ltwh: [number, number, number, number] = [0.1, 0.2, 0.3, 0.4];
    const minmax = ltwh2minmax(ltwh);
    const c1 = bboxCenterLTWH(ltwh);
    const c2 = bboxCenterMinMax(minmax);
    expect(c1.cx).toBeCloseTo(c2.cx);
    expect(c1.cy).toBeCloseTo(c2.cy);
  });
});

// ─── Containment & overlap ──────────────────────────────────

describe("bboxContainsPoint", () => {
  const bbox: [number, number, number, number] = [0.2, 0.3, 0.6, 0.7];

  it("returns true for point inside", () => {
    expect(bboxContainsPoint(bbox, { x: 0.4, y: 0.5 })).toBe(true);
  });

  it("returns true for point on edge", () => {
    expect(bboxContainsPoint(bbox, { x: 0.2, y: 0.3 })).toBe(true);
    expect(bboxContainsPoint(bbox, { x: 0.6, y: 0.7 })).toBe(true);
  });

  it("returns false for point outside", () => {
    expect(bboxContainsPoint(bbox, { x: 0.1, y: 0.5 })).toBe(false);
    expect(bboxContainsPoint(bbox, { x: 0.4, y: 0.8 })).toBe(false);
  });
});

describe("bboxOverlap", () => {
  it("returns 0 for non-overlapping boxes", () => {
    expect(bboxOverlap([0, 0, 0.3, 0.3], [0.5, 0.5, 1, 1])).toBe(0);
  });

  it("returns correct area for overlapping boxes", () => {
    const overlap = bboxOverlap([0, 0, 0.5, 0.5], [0.25, 0.25, 0.75, 0.75]);
    expect(overlap).toBeCloseTo(0.0625); // 0.25 * 0.25
  });

  it("returns full area when one box contains the other", () => {
    const overlap = bboxOverlap([0, 0, 1, 1], [0.2, 0.2, 0.4, 0.4]);
    expect(overlap).toBeCloseTo(0.04); // 0.2 * 0.2
  });

  it("returns 0 for adjacent boxes (touching edge)", () => {
    expect(bboxOverlap([0, 0, 0.5, 0.5], [0.5, 0, 1, 0.5])).toBe(0);
  });
});

describe("bboxIoU", () => {
  it("returns 0 for non-overlapping boxes", () => {
    expect(bboxIoU([0, 0, 0.3, 0.3], [0.5, 0.5, 1, 1])).toBe(0);
  });

  it("returns 1 for identical boxes", () => {
    expect(bboxIoU([0.2, 0.2, 0.8, 0.8], [0.2, 0.2, 0.8, 0.8])).toBeCloseTo(1);
  });

  it("returns value between 0 and 1 for partial overlap", () => {
    const iou = bboxIoU([0, 0, 0.5, 0.5], [0.25, 0.25, 0.75, 0.75]);
    expect(iou).toBeGreaterThan(0);
    expect(iou).toBeLessThan(1);
  });
});

// ─── Area ───────────────────────────────────────────────────

describe("bboxAreaMinMax", () => {
  it("computes area correctly", () => {
    expect(bboxAreaMinMax([0.1, 0.2, 0.5, 0.6])).toBeCloseTo(0.16); // 0.4 * 0.4
  });

  it("returns 0 for zero-size bbox", () => {
    expect(bboxAreaMinMax([0.5, 0.5, 0.5, 0.5])).toBe(0);
  });
});

describe("bboxAreaLTWH", () => {
  it("computes area correctly", () => {
    expect(bboxAreaLTWH([0.1, 0.2, 0.4, 0.4])).toBeCloseTo(0.16);
  });

  it("returns 0 for zero-size bbox", () => {
    expect(bboxAreaLTWH([0.5, 0.5, 0, 0])).toBe(0);
  });
});

// ─── Validation ─────────────────────────────────────────────

describe("validateBbox", () => {
  it("returns null for valid MinMax bbox", () => {
    expect(validateBbox([0.1, 0.2, 0.5, 0.6], "minmax")).toBeNull();
  });

  it("returns null for valid LTWH bbox", () => {
    expect(validateBbox([0.1, 0.2, 0.3, 0.4], "ltwh")).toBeNull();
  });

  it("rejects non-array", () => {
    expect(validateBbox("not an array")).not.toBeNull();
  });

  it("rejects wrong length", () => {
    expect(validateBbox([0.1, 0.2, 0.3])).not.toBeNull();
  });

  it("rejects NaN values", () => {
    expect(validateBbox([NaN, 0.2, 0.5, 0.6])).not.toBeNull();
  });

  it("rejects Infinity", () => {
    expect(validateBbox([0, 0, Infinity, 0.5])).not.toBeNull();
  });

  it("rejects out-of-range values", () => {
    expect(validateBbox([-0.1, 0, 0.5, 0.5])).not.toBeNull();
    expect(validateBbox([0, 0, 1.1, 0.5])).not.toBeNull();
  });

  it("rejects MinMax where min >= max", () => {
    expect(validateBbox([0.5, 0.5, 0.5, 0.8], "minmax")).not.toBeNull();
    expect(validateBbox([0.5, 0.8, 0.8, 0.5], "minmax")).not.toBeNull();
  });

  it("rejects LTWH where width/height <= 0", () => {
    expect(validateBbox([0.1, 0.2, 0, 0.3], "ltwh")).not.toBeNull();
    expect(validateBbox([0.1, 0.2, 0.3, 0], "ltwh")).not.toBeNull();
  });
});

describe("isValidMinMax", () => {
  it("returns true for valid MinMax", () => {
    expect(isValidMinMax([0.1, 0.2, 0.5, 0.6])).toBe(true);
  });

  it("returns false for invalid", () => {
    expect(isValidMinMax([0.5, 0.5, 0.5, 0.5])).toBe(false);
    expect(isValidMinMax("not a bbox")).toBe(false);
  });
});

describe("isValidLTWH", () => {
  it("returns true for valid LTWH", () => {
    expect(isValidLTWH([0.1, 0.2, 0.3, 0.4])).toBe(true);
  });

  it("returns false for zero dimensions", () => {
    expect(isValidLTWH([0.1, 0.2, 0, 0.4])).toBe(false);
  });
});
