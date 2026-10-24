// [tag-mapping v2 2026-10-24] Tag families: shape class + text pattern, ≥ 3 instances (research §7b).
import { describe, expect, it } from "vitest";
import {
  discoverTagFamilies, tagFamiliesFromStoredPages, patternRegex, storedTagFamilies, summarizeShapeEnsemble, buildShapeEnsemble,
  type EnsembleShape,
} from "@/lib/shape-ensemble";

const shape = (cls: string, text: string | null, pageNumber: number, longSide = 0.012, over: Partial<EnsembleShape> = {}): EnsembleShape => ({
  id: `${cls}-${text}-${pageNumber}`, bbox: [0.1, 0.1, 0.1 + longSide, 0.1 + longSide], cls, source: "yolo", confidence: 0.8, kind: "tag",
  text, textSource: text ? "textract" : null, cropText: null, textractText: text, zone: "drawing", longSide,
  yoloAnnotationId: null, classicalAnnotationId: null, modelName: "yolo_primitive", ...over,
});

describe("discoverTagFamilies", () => {
  it("groups by class + digits→9 pattern and needs ≥ 3 instances", () => {
    const pages = [
      { pageNumber: 1, shapes: [shape("circle", "D-101", 1), shape("circle", "D-102", 1), shape("hexagon", "W1", 1)] },
      { pageNumber: 2, shapes: [shape("circle", "D-103", 2), shape("hexagon", "W2", 2), shape("circle", "7", 2)] },
    ];
    const fams = discoverTagFamilies(pages);
    expect(fams.map((f) => f.id)).toEqual(["circle:D-999"]);
    expect(fams[0]).toMatchObject({ cls: "circle", pattern: "D-999", instances: 3, pages: [1, 2], distinctValues: 3, regex: "^D-\\d{3}$" });
    expect(discoverTagFamilies(pages, { minInstances: 2 }).map((f) => f.id).sort()).toEqual(["circle:D-999", "hexagon:W9"]);
  });

  it("ignores callouts, legend keys and non-tag-like text; caps rectangle/square families by size", () => {
    const pages = [{
      pageNumber: 1,
      shapes: [
        shape("circle", "3", 1, 0.012, { kind: "detail_callout" }), shape("circle", "3", 1, 0.012, { kind: "detail_callout" }), shape("circle", "3", 1, 0.012, { kind: "detail_callout" }),
        shape("circle", "NOTE", 1), shape("circle", "NOTE", 1), shape("circle", "NOTE", 1),
        shape("rectangle", "W1", 1, 0.06), shape("rectangle", "W2", 1, 0.06), shape("rectangle", "W3", 1, 0.06),
        shape("square", "1", 1, 0.01), shape("square", "2", 1, 0.01), shape("square", "3", 1, 0.01),
      ],
    }];
    expect(discoverTagFamilies(pages).map((f) => f.id)).toEqual(["square:9"]);
  });

  it("ranks both-arm, Textract-confirmed families higher and lists the most frequent values", () => {
    const pages = [{
      pageNumber: 1,
      shapes: [
        shape("circle", "A1", 1, 0.012, { source: "both", textSource: "both-agree" }), shape("circle", "A1", 1, 0.012, { source: "both", textSource: "both-agree" }), shape("circle", "A2", 1, 0.012, { source: "both", textSource: "both-agree" }),
        shape("diamond", "F1", 1, 0.012, { source: "classical", textSource: "crop" }), shape("diamond", "F2", 1, 0.012, { source: "classical", textSource: "crop" }), shape("diamond", "F3", 1, 0.012, { source: "classical", textSource: "crop" }),
      ],
    }];
    const fams = discoverTagFamilies(pages);
    expect(fams.map((f) => f.id)).toEqual(["circle:A9", "diamond:F9"]);
    expect(fams[0].values).toEqual(["A1", "A2"]);
    expect(fams[0].sources).toEqual({ yolo: 0, classical: 0, both: 3 });
    expect(fams[0].textractConfirmedShare).toBe(1);
    expect(fams[1].rank).toBe(3);
  });

  it("reads families back from stored page summaries", () => {
    const build = (text: string) => summarizeShapeEnsemble(buildShapeEnsemble({
      yolo: [{ name: "circle", bbox: [0.1, 0.1, 0.11, 0.11], confidence: 0.9 }], classical: [],
      words: [{ text, confidence: 99, bbox: [0.102, 0.102, 0.004, 0.003] }],
    }));
    const summary = tagFamiliesFromStoredPages([
      { pageNumber: 1, pageIntelligence: { shapes: build("T-01") } },
      { pageNumber: 2, pageIntelligence: { shapes: build("T-02") } },
      { pageNumber: 3, pageIntelligence: { shapes: build("T-03") } },
      { pageNumber: 4, pageIntelligence: null },
    ], {}, new Date("2026-10-24T00:00:00Z"));
    expect(summary.pagesScanned).toBe(3);
    expect(summary.families.map((f) => [f.id, f.instances])).toEqual([["circle:T-99", 3]]);
    expect(storedTagFamilies({ tagFamilies: summary })).toEqual(summary);
    expect(storedTagFamilies({})).toBeUndefined();
  });

  it("patternRegex escapes and anchors", () => {
    expect(new RegExp(patternRegex("P.99")).test("P.07")).toBe(true);
    expect(new RegExp(patternRegex("P.99")).test("PX07")).toBe(false);
    expect(new RegExp(patternRegex("9")).test("12")).toBe(false);
  });
});
