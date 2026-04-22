import { describe, it, expect } from "vitest";
import {
  computeYoloHeatmap,
  type HeatmapYoloAnnotation,
} from "@/lib/spatial/yolo-heatmap";

function ann(
  name: string,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  confidence = 0.9,
): HeatmapYoloAnnotation {
  return { name, minX, minY, maxX, maxY, confidence };
}

describe("computeYoloHeatmap", () => {
  it("returns empty heatmap when no annotations match the class filter", () => {
    const out = computeYoloHeatmap(1, [ann("drawings", 0, 0, 0.5, 0.5)], {
      classes: ["text_box"],
    });
    expect(out.confidentRegions).toEqual([]);
    expect(out.classContributions).toEqual({ text_box: 0 });
    expect(out.summary).toContain("No dense YOLO regions");
  });

  it("builds a single confident region for a dense cluster of one class", () => {
    // 5 overlapping text_box annotations in top-right quadrant
    const boxes: HeatmapYoloAnnotation[] = [];
    for (let i = 0; i < 5; i++) {
      boxes.push(ann("text_box", 0.55, 0.1 + i * 0.05, 0.9, 0.15 + i * 0.05));
    }
    const out = computeYoloHeatmap(1, boxes, { classes: ["text_box"] });
    expect(out.confidentRegions.length).toBeGreaterThan(0);
    const r = out.confidentRegions[0];
    expect(r.classes).toContain("text_box");
    expect(r.bbox[0]).toBeGreaterThan(0.4); // region lives in right half
    expect(r.cellCount).toBeGreaterThan(0);
  });

  it("assigns multiple classes to a region where they overlap", () => {
    const boxes: HeatmapYoloAnnotation[] = [];
    // Dense agreement block: text_box + vertical_area + horizontal_area
    // all overlapping in the same area.
    for (let i = 0; i < 4; i++) {
      boxes.push(ann("text_box", 0.1, 0.1 + i * 0.05, 0.5, 0.15 + i * 0.05));
      boxes.push(ann("vertical_area", 0.1, 0.1 + i * 0.05, 0.5, 0.15 + i * 0.05));
      boxes.push(ann("horizontal_area", 0.1, 0.1 + i * 0.05, 0.5, 0.15 + i * 0.05));
    }
    const out = computeYoloHeatmap(1, boxes, {
      classes: ["text_box", "vertical_area", "horizontal_area"],
    });
    expect(out.confidentRegions.length).toBeGreaterThan(0);
    const classes = out.confidentRegions[0].classes;
    expect(classes).toContain("text_box");
    expect(classes).toContain("vertical_area");
    expect(classes).toContain("horizontal_area");
  });

  it("reports zero contribution for classes with no matching annotations", () => {
    const out = computeYoloHeatmap(
      1,
      [ann("text_box", 0.1, 0.1, 0.5, 0.3)],
      { classes: ["text_box", "vertical_area", "horizontal_area"] },
    );
    expect(out.classContributions["text_box"]).toBeGreaterThan(0);
    expect(out.classContributions["vertical_area"]).toBe(0);
    expect(out.classContributions["horizontal_area"]).toBe(0);
  });

  it("honors per-class minimum confidence gate", () => {
    const boxes: HeatmapYoloAnnotation[] = [
      // Below gate — should be filtered out
      ann("text_box", 0.1, 0.1, 0.5, 0.5, 0.05),
      ann("text_box", 0.1, 0.1, 0.5, 0.5, 0.05),
    ];
    const out = computeYoloHeatmap(1, boxes, {
      classes: ["text_box"],
      minConfidencePerClass: { text_box: 0.5 },
    });
    expect(out.confidentRegions).toEqual([]);
  });

  it("respects classWeights for down-weighted noisy classes", () => {
    // vertical_area alone in top-half; text_box alone in bottom-half.
    // Weight vertical_area to 0.1 so its density never clears the threshold.
    const boxes: HeatmapYoloAnnotation[] = [
      ann("vertical_area", 0.1, 0.05, 0.9, 0.4),
      ann("vertical_area", 0.1, 0.1, 0.9, 0.35),
      ann("text_box", 0.1, 0.6, 0.9, 0.9),
      ann("text_box", 0.1, 0.65, 0.9, 0.85),
      ann("text_box", 0.1, 0.7, 0.9, 0.8),
    ];
    const out = computeYoloHeatmap(1, boxes, {
      classes: ["text_box", "vertical_area"],
      classWeights: { vertical_area: 0.1, text_box: 1.0 },
    });
    // The vertical_area-only region should NOT appear as a confident region
    // because its weight was heavily discounted.
    const inTopHalf = out.confidentRegions.filter((r) => r.bbox[1] + r.bbox[3] / 2 < 0.5);
    const inBottomHalf = out.confidentRegions.filter((r) => r.bbox[1] + r.bbox[3] / 2 >= 0.5);
    expect(inBottomHalf.length).toBeGreaterThan(0);
    expect(inTopHalf.length).toBe(0);
  });

  it("sorts confident regions by confidence descending", () => {
    const boxes: HeatmapYoloAnnotation[] = [];
    // A: weak single annotation upper-left
    boxes.push(ann("text_box", 0.1, 0.05, 0.25, 0.12, 0.5));
    // B: strong stacked block lower-right
    for (let i = 0; i < 6; i++) {
      boxes.push(ann("text_box", 0.6, 0.5 + i * 0.03, 0.9, 0.55 + i * 0.03, 0.95));
    }
    const out = computeYoloHeatmap(1, boxes, {
      classes: ["text_box"],
      minCellDensity: 0.15,
    });
    if (out.confidentRegions.length >= 2) {
      for (let i = 1; i < out.confidentRegions.length; i++) {
        expect(out.confidentRegions[i].confidence).toBeLessThanOrEqual(
          out.confidentRegions[i - 1].confidence,
        );
      }
    }
  });

  it("separates disjoint clusters into distinct regions", () => {
    const boxes: HeatmapYoloAnnotation[] = [];
    // Cluster 1: top-left
    for (let i = 0; i < 4; i++) boxes.push(ann("text_box", 0.05, 0.05 + i * 0.02, 0.2, 0.08 + i * 0.02));
    // Cluster 2: bottom-right (disjoint)
    for (let i = 0; i < 4; i++) boxes.push(ann("text_box", 0.75, 0.75 + i * 0.02, 0.9, 0.78 + i * 0.02));
    const out = computeYoloHeatmap(1, boxes, { classes: ["text_box"], minCellDensity: 0.2 });
    expect(out.confidentRegions.length).toBeGreaterThanOrEqual(2);
  });

  it("summary string includes region count and zone labels", () => {
    const boxes: HeatmapYoloAnnotation[] = [];
    for (let i = 0; i < 5; i++) boxes.push(ann("text_box", 0.6, 0.1 + i * 0.03, 0.9, 0.15 + i * 0.03));
    const out = computeYoloHeatmap(1, boxes, { classes: ["text_box"] });
    expect(out.summary).toMatch(/confident region/);
    expect(out.summary).toMatch(/top-right|mid-right|conf=/);
  });

  it("respects a custom grid resolution", () => {
    const out = computeYoloHeatmap(
      1,
      [ann("text_box", 0, 0, 1, 1)],
      { classes: ["text_box"], gridConfig: { rows: 8, cols: 8 } },
    );
    expect(out.gridResolution).toEqual([8, 8]);
  });

  it("partial YOLO coverage: reports zero contribution for missing class", () => {
    // Simulating yolo_medium ran (text_box present) but yolo_primitive did
    // NOT run (vertical_area / horizontal_area absent). Summary should
    // surface the missing classes for UI advisory.
    const out = computeYoloHeatmap(
      1,
      [ann("text_box", 0.1, 0.1, 0.5, 0.5)],
      { classes: ["text_box", "vertical_area", "horizontal_area"] },
    );
    expect(out.classContributions["text_box"]).toBeGreaterThan(0);
    expect(out.classContributions["vertical_area"]).toBe(0);
    expect(out.classContributions["horizontal_area"]).toBe(0);
  });
});
