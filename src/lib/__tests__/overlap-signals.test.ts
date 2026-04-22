import { describe, it, expect } from "vitest";
import {
  area,
  intersectionArea,
  iou,
  iosA,
  iosB,
  maxContainment,
} from "@/lib/geom/overlap-signals";
import type { BboxLTWH } from "@/types";

describe("overlap-signals", () => {
  const unit: BboxLTWH = [0, 0, 1, 1];
  const halfRight: BboxLTWH = [0.5, 0, 0.5, 1];
  const disjoint: BboxLTWH = [2, 2, 1, 1];
  const fullyInside: BboxLTWH = [0.25, 0.25, 0.5, 0.5];
  const degenerate: BboxLTWH = [0, 0, 0, 1];

  describe("area", () => {
    it("computes w*h for positive box", () => {
      expect(area(unit)).toBe(1);
      expect(area([0, 0, 2, 3])).toBe(6);
    });

    it("returns 0 for degenerate width or height", () => {
      expect(area(degenerate)).toBe(0);
      expect(area([0, 0, 1, 0])).toBe(0);
      expect(area([0, 0, -1, 1])).toBe(0);
    });
  });

  describe("intersectionArea", () => {
    it("computes overlapping rectangle area", () => {
      expect(intersectionArea(unit, halfRight)).toBeCloseTo(0.5);
    });

    it("returns 0 for disjoint boxes", () => {
      expect(intersectionArea(unit, disjoint)).toBe(0);
    });

    it("returns contained area for nested boxes", () => {
      expect(intersectionArea(unit, fullyInside)).toBeCloseTo(0.25);
    });

    it("is symmetric", () => {
      expect(intersectionArea(unit, halfRight)).toBe(intersectionArea(halfRight, unit));
    });
  });

  describe("iou", () => {
    it("returns 1 for identical boxes", () => {
      expect(iou(unit, unit)).toBeCloseTo(1);
    });

    it("returns 0 for disjoint boxes", () => {
      expect(iou(unit, disjoint)).toBe(0);
    });

    it("returns 0 for degenerate boxes", () => {
      expect(iou(degenerate, unit)).toBe(0);
    });

    it("half box fully inside unit: 0.5 / (1 + 0.5 - 0.5) = 0.5", () => {
      // unit area 1, halfRight area 0.5, intersection 0.5 → IoU = 0.5/1.0
      expect(iou(unit, halfRight)).toBeCloseTo(0.5);
    });

    it("nested (25% inside): 0.25 / 1.0 = 0.25", () => {
      expect(iou(unit, fullyInside)).toBeCloseTo(0.25);
    });
  });

  describe("iosA / iosB", () => {
    it("iosA = 1 when A fully inside B", () => {
      expect(iosA(fullyInside, unit)).toBeCloseTo(1);
    });

    it("iosB = 1 when B fully inside A (same scenario, flipped)", () => {
      expect(iosB(unit, fullyInside)).toBeCloseTo(1);
    });

    it("iosA = 0 for disjoint", () => {
      expect(iosA(unit, disjoint)).toBe(0);
    });

    it("iosA = 0 for degenerate A", () => {
      expect(iosA(degenerate, unit)).toBe(0);
    });

    it("iosA = 0.5 for half overlap on equal-size boxes", () => {
      expect(iosA(unit, halfRight)).toBeCloseTo(0.5);
    });
  });

  describe("maxContainment", () => {
    it("catches nested case where IoU is low", () => {
      const tiny: BboxLTWH = [0, 0, 0.1, 0.1];
      expect(iou(unit, tiny)).toBeLessThan(0.02);
      expect(maxContainment(unit, tiny)).toBeCloseTo(1); // tiny fully inside unit
    });

    it("returns 0 for disjoint", () => {
      expect(maxContainment(unit, disjoint)).toBe(0);
    });
  });
});
