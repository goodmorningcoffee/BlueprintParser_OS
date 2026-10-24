// [tag-mapping v2 2026-10-24] Shape ensemble: the fusion rules of research/shapes/REPORT.md §8.
import { describe, expect, it } from "vitest";
import type { TextractWord } from "@/types";
import {
  buildShapeEnsemble, DEFAULT_SHAPE_ENSEMBLE_CONFIG, fuseInnerText, detailCalloutOf, isDetailTitle, mergeHalfBubbles,
  summarizeShapeEnsemble, storedShapeEnsemble, sameShapeEnsemble, fromCompactShape, SHAPE_SUMMARY_CAP,
  type EnsembleYoloInput, type EnsembleClassicalInput,
} from "@/lib/shape-ensemble";
import type { PageZones } from "@/lib/page-zones";

const SMALL = 40 / 10800;   // 40 px bubble — under YOLO's floor
const BIG = 150 / 10800;    // 150 px bubble

const yolo = (name: string, x: number, y: number, size: number, confidence = 0.8, annotationId?: number): EnsembleYoloInput =>
  ({ name, bbox: [x, y, x + size, y + size], confidence, modelName: "yolo_primitive", annotationId });
const classical = (shape: string, text: string, x: number, y: number, size: number, annotationId?: number): EnsembleClassicalInput =>
  ({ shape, text, bbox: [x, y, x + size, y + size], annotationId });
const word = (text: string, x: number, y: number, w = 0.004, h = 0.003): TextractWord => ({ text, confidence: 99, bbox: [x, y, w, h] });
const zones: PageZones = { titleBlock: [0.8, 0.8, 1, 1], drawings: [[0, 0, 0.7, 0.7]], tables: [[0.7, 0, 1, 0.3]], legends: [[0, 0.8, 0.3, 1]], source: "detector" };

describe("buildShapeEnsemble — sources", () => {
  it("a classical shape overlapping a YOLO shape is ONE shape: YOLO label, conf ≥ .85, crop text", () => {
    const r = buildShapeEnsemble({
      yolo: [yolo("circle", 0.1, 0.1, BIG, 0.42, 7)],
      classical: [classical("oval", "D-101", 0.1005, 0.1005, BIG * 0.98, 99)],
    });
    expect(r.shapes).toHaveLength(1);
    const s = r.shapes[0];
    expect(s.source).toBe("both");
    expect(s.cls).toBe("circle");
    expect(s.confidence).toBeCloseTo(DEFAULT_SHAPE_ENSEMBLE_CONFIG.bothConfidence, 2);
    expect(s.text).toBe("D-101");
    expect(s.textSource).toBe("crop");
    expect(s.yoloAnnotationId).toBe(7);
    expect(s.classicalAnnotationId).toBe(99);
    expect(r.counts).toMatchObject({ both: 1, yolo: 0, classical: 0 });
  });

  it("a small classical-only bubble with a read is kept; a large one is dropped (YOLO covers > 70 px)", () => {
    const r = buildShapeEnsemble({
      yolo: [],
      classical: [classical("circle", "W", 0.2, 0.2, SMALL), classical("circle", "7", 0.4, 0.4, BIG)],
    });
    expect(r.shapes.map((s) => [s.source, s.text])).toEqual([["classical", "W"]]);
    expect(r.drops.classicalLarge).toBe(1);
  });

  it("a classical-only bubble without any read is dropped", () => {
    const r = buildShapeEnsemble({ yolo: [], classical: [classical("square", "", 0.2, 0.2, SMALL)] });
    expect(r.shapes).toEqual([]);
    expect(r.drops.classicalTextless).toBe(1);
  });

  it("YOLO: a textless square / low-confidence shape is dropped, a textless hexagon at conf ≥ .5 kept", () => {
    const r = buildShapeEnsemble({
      yolo: [yolo("square", 0.1, 0.1, BIG, 0.9), yolo("circle", 0.3, 0.3, BIG, 0.3), yolo("hexagon", 0.5, 0.5, BIG, 0.6)],
      classical: [],
    });
    expect(r.shapes.map((s) => s.cls)).toEqual(["hexagon"]);
    expect(r.drops.yoloTextless).toBe(2);
  });

  it("a low-confidence YOLO circle WITH a Textract word inside is kept (true tags at .14–.26 exist)", () => {
    const r = buildShapeEnsemble({
      yolo: [yolo("circle", 0.3, 0.3, BIG, 0.18)],
      classical: [],
      words: [word("J", 0.305, 0.305)],
    });
    expect(r.shapes).toHaveLength(1);
    expect(r.shapes[0]).toMatchObject({ text: "J", textSource: "textract", source: "yolo" });
  });

  it("arches and spatial classes never enter the ensemble", () => {
    const r = buildShapeEnsemble({ yolo: [yolo("arches_archway", 0.1, 0.1, BIG, 0.9), yolo("horizontal_area", 0.3, 0.3, BIG, 0.9)], classical: [] });
    expect(r.shapes).toEqual([]);
    expect(r.drops.notTagClass).toBe(2);
  });
});

describe("buildShapeEnsemble — zones and kinds", () => {
  it("shapes centred in a detected table or title block are dropped; in a legend they become legend keys", () => {
    const r = buildShapeEnsemble({
      yolo: [yolo("circle", 0.85, 0.1, BIG, 0.9), yolo("circle", 0.9, 0.9, BIG, 0.9), yolo("circle", 0.1, 0.9, BIG, 0.9), yolo("circle", 0.3, 0.3, BIG, 0.9)],
      classical: [],
      words: [word("1", 0.855, 0.105), word("2", 0.905, 0.905), word("3", 0.105, 0.905), word("4", 0.305, 0.305)],
      zones,
    });
    expect(r.drops.inTable).toBe(1);
    expect(r.drops.inTitleBlock).toBe(1);
    expect(r.shapes.map((s) => [s.text, s.kind, s.zone]).sort()).toEqual([["3", "legend_key", "legend"], ["4", "tag", "drawing"]]);
  });

  it("regionsV2 table boxes drop shapes too", () => {
    const r = buildShapeEnsemble({ yolo: [yolo("circle", 0.3, 0.3, BIG, 0.9)], classical: [], words: [word("4", 0.305, 0.305)], tableBoxes: [[0.25, 0.25, 0.4, 0.4]] });
    expect(r.shapes).toEqual([]);
    expect(r.drops.inTable).toBe(1);
  });

  it("'3 over R-3' with R-3 a project sheet is a detail callout, never tag 3 (owner rule 1)", () => {
    const r = buildShapeEnsemble({
      yolo: [yolo("circle", 0.3, 0.3, BIG, 0.9)],
      classical: [],
      words: [word("3", 0.305, 0.301), word("R-3", 0.303, 0.309)],
      sheetNumbers: ["R-1", "R-2", "R-3"],
    });
    expect(r.shapes[0].kind).toBe("detail_callout");
    expect(r.shapes[0].callout).toEqual({ detail: "3", sheet: "R-3" });
    expect(r.counts.callouts).toBe(1);
  });

  it("the same bubble on a project without an R-3 sheet stays a tag candidate", () => {
    const r = buildShapeEnsemble({
      yolo: [yolo("circle", 0.3, 0.3, BIG, 0.9)], classical: [], words: [word("3", 0.305, 0.301), word("R-3", 0.303, 0.309)], sheetNumbers: ["A-101"],
    });
    expect(r.shapes[0].kind).toBe("tag");
  });
});

describe("text fusion (rule 4: crop first, Textract validates)", () => {
  it("agreement raises confidence and marks both-agree", () => {
    expect(fuseInnerText("D-101", "D101")).toEqual({ text: "D-101", source: "both-agree", agree: true });
    const r = buildShapeEnsemble({ yolo: [yolo("circle", 0.1, 0.1, BIG, 0.9)], classical: [classical("circle", "D-101", 0.1, 0.1, BIG)], words: [word("D-101", 0.105, 0.105)] });
    expect(r.shapes[0].confidence).toBeCloseTo(0.95, 2);
    expect(r.shapes[0].textSource).toBe("both-agree");
  });
  it("disagreement prefers the tag-like read, else the crop read (93 % read rate)", () => {
    expect(fuseInnerText("C(", "C").text).toBe("C");          // Textract tag-like, crop not
    expect(fuseInnerText("P7", "Pt").text).toBe("P7");        // crop tag-like, Textract not
    expect(fuseInnerText("41", "1").text).toBe("41");         // both tag-like → crop
    expect(fuseInnerText("41", "1").source).toBe("both-disagree");
  });
  it("either reader alone is used as is", () => {
    expect(fuseInnerText("A1", null)).toMatchObject({ text: "A1", source: "crop" });
    expect(fuseInnerText(null, "a1 ")).toMatchObject({ text: "A1", source: "textract" });
    expect(fuseInnerText("", null)).toMatchObject({ text: null, source: null });
  });
  it("detailCalloutOf: arch_sheet_circle with two tokens resolves without a sheet list", () => {
    expect(detailCalloutOf("5 A-601", "arch_sheet_circle", new Set())).toEqual({ detail: "5", sheet: "A-601" });
    expect(detailCalloutOf("5", "circle", new Set())).toBeNull();
  });
});

describe("half bubbles and the persisted summary", () => {
  it("two stacked half-circles merge into one arch_sheet_circle with 'top bottom' text", () => {
    const merged = mergeHalfBubbles([
      classical("half-circle", "3", 0.1, 0.1, 0.01),
      { shape: "half-circle", text: "A-501", bbox: [0.1, 0.1101, 0.11, 0.1201] },
      classical("circle", "X", 0.5, 0.5, 0.01),
    ]);
    expect(merged.map((m) => [m.cls, m.text])).toEqual([["arch_sheet_circle", "3 A-501"], ["circle", "X"]]);
    expect(merged[0].bbox).toEqual([0.1, 0.1, 0.11, 0.1201]);
  });

  it("summary round-trips the kept shapes compactly, caps the list and ignores computedAt when comparing", () => {
    const r = buildShapeEnsemble({ yolo: [yolo("circle", 0.1, 0.1, BIG, 0.9, 5)], classical: [classical("circle", "T-01", 0.1, 0.1, BIG, 6)] });
    const a = summarizeShapeEnsemble(r, new Date("2026-10-24T00:00:00Z"));
    const b = summarizeShapeEnsemble(r, new Date("2026-10-25T00:00:00Z"));
    expect(a.shapes).toHaveLength(1);
    expect(a.shapes[0]).toMatchObject({ c: "circle", s: "b", t: "T-01", ts: "c", kd: "t" });
    expect(sameShapeEnsemble(a, b)).toBe(true);
    expect(storedShapeEnsemble({ shapes: a })).toEqual(a);
    expect(storedShapeEnsemble({ shapes: { v: 99 } })).toBeUndefined();
    const widened = fromCompactShape(a.shapes[0], 0);
    expect(widened).toMatchObject({ cls: "circle", source: "both", text: "T-01", textSource: "crop", kind: "tag" });
    expect(a.truncated).toBe(0);
    expect(SHAPE_SUMMARY_CAP).toBeGreaterThan(100);
  });
});

describe("spot-check fixes (corpus 2026-10-24)", () => {
  it("a bare-number bubble with a view name and a scale to its right is a detail TITLE, not a tag", () => {
    const r = buildShapeEnsemble({
      yolo: [yolo("circle", 0.1, 0.5, BIG, 0.9)],
      classical: [],
      words: [word("12", 0.105, 0.505), word("ADMIN", 0.13, 0.503, 0.02), word("SUITE", 0.152, 0.503, 0.02), word('1/4"', 0.13, 0.512, 0.01), word("=", 0.142, 0.512, 0.003), word("1'-0\"", 0.147, 0.512, 0.012)],
    });
    expect(r.shapes[0].kind).toBe("detail_title");
    expect(r.counts.detailTitles).toBe(1);
    expect(isDetailTitle("12", [0.1, 0.5, 0.1 + BIG, 0.5 + BIG], [word("SCALE:", 0.13, 0.512)])).toBe(true);
    expect(isDetailTitle("D-12", [0.1, 0.5, 0.1 + BIG, 0.5 + BIG], [word("SCALE:", 0.13, 0.512)])).toBe(false);
    expect(isDetailTitle("12", [0.1, 0.5, 0.1 + BIG, 0.5 + BIG], [word("ADMIN", 0.13, 0.503)])).toBe(false);
  });

  it("a word nearer a neighbouring bubble's centre belongs to that bubble (A1 beside D1)", () => {
    const r = buildShapeEnsemble({
      yolo: [yolo("circle", 0.1, 0.1, BIG, 0.9, 1), yolo("circle", 0.1 + BIG * 0.9, 0.1, BIG, 0.9, 2)],
      classical: [],
      // "A1" sits in the overlap of the two boxes, nearer the first centre; "D1" nearer the second.
      words: [word("A1", 0.1 + BIG * 0.45, 0.1 + BIG * 0.5), word("D1", 0.1 + BIG * 1.35, 0.1 + BIG * 0.5)],
    });
    const byId = new Map(r.shapes.map((s) => [s.yoloAnnotationId, s.text]));
    expect(byId.get(1)).toBe("A1");
    expect(byId.get(2)).toBe("D1");
  });
});

describe("model name (fix round 1)", () => {
  it("a YOLO-backed shape carries its model; a classical-only shape and a stored summary carry null", () => {
    const r = buildShapeEnsemble({
      yolo: [{ name: "circle", bbox: [0.1, 0.1, 0.1 + BIG, 0.1 + BIG], confidence: 0.9, modelName: "custom" }],
      classical: [classical("circle", "7", 0.5, 0.5, SMALL)],
      words: [word("D-1", 0.105, 0.105)],
    });
    expect(r.shapes.map((s) => [s.source, s.modelName])).toEqual([["yolo", "custom"], ["classical", null]]);
    const stored = summarizeShapeEnsemble(r);
    expect(stored.shapes.map((c) => fromCompactShape(c, 0).modelName)).toEqual([null, null]);
    expect(JSON.stringify(stored)).not.toContain("custom");
  });
});

describe("word ownership never steals from the same bubble", () => {
  it("a classical half-circle inside a YOLO divided bubble does not take the bubble's words", () => {
    const r = buildShapeEnsemble({
      yolo: [yolo("circle", 0.3, 0.3, BIG, 0.9, 1)],
      classical: [{ shape: "half-circle", text: "", bbox: [0.3, 0.3, 0.3 + BIG, 0.3 + BIG / 2] }],
      words: [word("3", 0.305, 0.301), word("R-3", 0.303, 0.309)],
      sheetNumbers: ["R-3"],
    });
    expect(r.shapes.map((s) => [s.source, s.kind, s.text])).toEqual([["both", "detail_callout", "3 R-3"]]);
  });
});
