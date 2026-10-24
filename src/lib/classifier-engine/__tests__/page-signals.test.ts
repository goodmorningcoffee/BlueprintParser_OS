// [2b heuristic port] The additive page-level signal specs: text (whole-word on raw text), text-region,
// yolo-spatial, yolo `noDetections` + "*", csi where "pageCodes" / measure "presence"; and a page-unit recipe
// producing one whole-page proposal.
import { describe, expect, it } from "vitest";
import type { CsiCode } from "@/types";
import { buildCandidateEvidence, buildPageEvidence, type ClassifierPageInput } from "../evidence";
import { runClassifierEngine } from "../engine";
import { evaluateSignal } from "../signals";
import type { ClassifierRecipe, SignalSpec } from "../types";

const d = (name: string, x: number, y: number, w = 0.02, h = 0.02) => ({ name, modelName: "m", confidence: 0.9, minX: x, minY: y, maxX: x + w, maxY: y + h });
const noTrigger: CsiCode = { code: "09 30 00", description: "", trade: "", division: "09 00 00" };
const base: ClassifierPageInput = {
  pageNumber: 1, rawText: "GENERAL NOTES: TYP. INDOOR", textRegions: [{ type: "notes-block" }], csiCodes: [noTrigger],
  detections: [d("horizontal_area", 0.1, 0.1, 0.4, 0.5), d("oval", 0.12, 0.2), d("oval", 0.12, 0.3), d("oval", 0.12, 0.4)],
};
const value = (spec: SignalSpec, input: ClassifierPageInput = base): number => {
  const page = buildPageEvidence(input);
  return evaluateSignal(spec, buildCandidateEvidence(page, { source: "regions-v2", bbox: [0, 0, 1, 1], anchorBbox: [0, 0, 1, 1] }), page).value;
};

describe("page signals", () => {
  it("text: whole-word, case-insensitive, any / all; punctuation-tolerant; an empty term never matches", () => {
    expect(value({ type: "text", terms: ["notes:", "DOOR"], mode: "any" })).toBe(1); // DOOR ⊄ INDOOR
    expect(value({ type: "text", terms: ["TYP", "GENERAL NOTES"], mode: "all" })).toBe(1);
    expect(value({ type: "text", terms: ["TYP", "DOOR"], mode: "all" })).toBe(0);
    expect(value({ type: "text", terms: ["TYP", ""], mode: "all" })).toBe(0);
  });

  it("text-region: legacy stored types are migrated (notes-block → notes-numbered)", () => {
    expect(value({ type: "text-region", regionTypes: ["notes-numbered"] })).toBe(1);
    expect(value({ type: "text-region", regionTypes: ["schedule-table"] })).toBe(0);
  });

  it("yolo-spatial: contains / aligned / near / overlaps", () => {
    expect(value({ type: "yolo-spatial", operator: "contains", classA: "horizontal_area", classB: "oval", minInstances: 3 })).toBe(1);
    expect(value({ type: "yolo-spatial", operator: "contains", classA: "horizontal_area", classB: "oval", minInstances: 4 })).toBe(0);
    expect(value({ type: "yolo-spatial", operator: "aligned", classA: "horizontal_area", classB: "*", minInstances: 3, axis: "vertical" })).toBe(1);
    expect(value({ type: "yolo-spatial", operator: "aligned", classA: "horizontal_area", classB: "oval", minInstances: 3, axis: "horizontal" })).toBe(0);
    expect(value({ type: "yolo-spatial", operator: "near", classA: "oval", classB: "horizontal_area", maxDistance: 0.3 })).toBe(1);
    expect(value({ type: "yolo-spatial", operator: "overlaps", classA: "oval", classB: "horizontal_area" })).toBe(1);
  });

  it("yolo: \"*\" is any class; noDetections applies only when YOLO did not run", () => {
    expect(value({ type: "yolo", where: "page", classes: ["*"], measure: "presence" })).toBe(1);
    const textOnly = { ...base, detections: [] };
    expect(value({ type: "yolo", where: "page", classes: ["x"], measure: "presence", noDetections: 1 }, textOnly)).toBe(1);
    expect(value({ type: "yolo", where: "page", classes: ["x"], measure: "presence", noDetections: 1 }, { ...textOnly, yoloAvailable: true })).toBe(0);
    expect(value({ type: "yolo", where: "page", classes: ["x"], measure: "presence", noDetections: 1 })).toBe(0);
  });

  it("csi pageCodes reads every page code (no trigger needed); presence is 0/1", () => {
    expect(value({ type: "csi", where: "pageCodes", divisions: ["09"], measure: "presence" })).toBe(1);
    expect(value({ type: "csi", where: "page", divisions: ["09"], measure: "presence" })).toBe(0); // trigger-located only
    expect(value({ type: "csi", where: "pageCodes", divisions: ["08"], measure: "presence" })).toBe(0);
  });

  it("a page-unit recipe yields one whole-page proposal", () => {
    const recipe: ClassifierRecipe = {
      id: "pg", name: "Page", version: 1, enabled: true, source: "custom", unit: "page", target: "notes-page", candidates: [], scope: {},
      detect: { bias: -0.5, threshold: 0.5, signals: [{ id: "kw", label: "kw", spec: { type: "text", terms: ["GENERAL NOTES"], mode: "any" }, weight: 1, role: "score", enabled: true }] },
      classes: [], nameThreshold: 0, minMargin: 0, deriveName: false, fallbackClassName: "Page",
    };
    const { result } = runClassifierEngine(base, [recipe]);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].bbox).toEqual([0, 0, 1, 1]);
    expect(result.proposals[0].features["detect.kw"]).toBe(1);
  });
});
