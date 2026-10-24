// Every SignalSpec type → a value in [0, 1] with evidence; the head arithmetic (logit = bias +
// Σ weight × value, sigmoid), the roles (score / required / veto) and the class pick with
// threshold + margin, else fallback.
import { describe, expect, it } from "vitest";
import type { CsiCode, TextractWord } from "@/types";
import { buildCandidateEvidence, buildPageEvidence, type BoxTagger, type ClassifierPageInput } from "../evidence";
import { evaluateHead, pickClass, sigmoid } from "../heads";
import { evaluateSignal } from "../signals";
import type { ClassifierClass, WeightedSignal } from "../types";

const word = (text: string, x: number, y: number, h = 0.01): TextractWord => ({ text, confidence: 99, bbox: [x, y, text.length * 0.006, h] });
const BOX: [number, number, number, number] = [0.1, 0.1, 0.5, 0.4];
const words = [
  word("DOOR", 0.12, 0.11, 0.016), word("SCHEDULE", 0.17, 0.11, 0.016),
  word("DOOR", 0.12, 0.14), word("NO", 0.16, 0.14), word("FRAME", 0.22, 0.14), word("HDWR", 0.30, 0.14),
  word("101", 0.12, 0.17), word("HM", 0.22, 0.17), word("HM", 0.30, 0.17), word("102", 0.12, 0.19), word("WD", 0.22, 0.19), word("HM", 0.30, 0.19),
  word("GENERAL", 0.7, 0.9), word("NOTES", 0.75, 0.9),
];
const DOORS: CsiCode = { code: "08 11 16", description: "", trade: "", division: "08 00 00", triggers: [{ text: "hm", tier: 1, bbox: [0.22, 0.17, 0.02, 0.01] }] };
const tagger: BoxTagger = () => [{ code: "08 11 13", division: "08 00 00" }, { code: "08 71 00", division: "08 00 00" }, { code: "09 91 23", division: "09 00 00" }];
const input: ClassifierPageInput = {
  pageNumber: 2,
  detections: [
    { name: "tables", modelName: "yolo_medium", confidence: 0.9, minX: BOX[0], minY: BOX[1], maxX: BOX[2], maxY: BOX[3] },
    { name: "circle", modelName: "yolo_primitive", confidence: 0.8, minX: 0.11, minY: 0.17, maxX: 0.13, maxY: 0.18 },
    { name: "circle", modelName: "yolo_primitive", confidence: 0.8, minX: 0.11, minY: 0.19, maxX: 0.13, maxY: 0.2 },
    { name: "title_block", modelName: "yolo_medium", confidence: 0.9, minX: 0.85, minY: 0.0, maxX: 1, maxY: 1 },
  ],
  textractData: { words, tables: [{ bbox: [0.3, 0.3, 0.4, 0.3], cells: [], rowCount: 3, colCount: 3 }] },
  csiCodes: [DOORS],
  drawingNumber: "A-601",
  channelKind: "vector",
  tagger,
};
const page = buildPageEvidence(input);
const cand = buildCandidateEvidence(page, {
  source: "regions-v2", bbox: BOX, anchorBbox: BOX, regionId: "rv2-1",
  structure: { detConf: 0.9, areaCover: 0.5, textLines: 9, textRows: 3, textCols: 3, words: 12, textractTable: 1, tagShapes: 2, shapes: 2, legendColumn: false, keyShapes: true, scheduleWord: true, csiCodes: 1, structureScore: 0.8 },
});

describe("evaluateSignal", () => {
  it("words: sqrt-saturated term sum per band, phrases match inside the band text", () => {
    const header = evaluateSignal({ type: "words", where: "header", terms: { "DOOR SCHEDULE": 1.5 } }, cand, page);
    expect(header.value).toBeCloseTo(1 - Math.exp(-1.5), 3);
    expect(header.detail).toContain("DOOR SCHEDULE");
    const cols = evaluateSignal({ type: "words", where: "columns", terms: { FRAME: 1, HDWR: 1, CKT: 1 }, saturation: 2 }, cand, page);
    expect(cols.value).toBeCloseTo(1 - Math.exp(-2 / 2), 3);
    // the two rows under the title are the column band; the third row is the body
    expect(evaluateSignal({ type: "words", where: "box", terms: { HM: 1 } }, cand, page).value).toBeCloseTo(1 - Math.exp(-Math.sqrt(3)), 3);
    expect(evaluateSignal({ type: "words", where: "body", terms: { HM: 1 } }, cand, page).value).toBeCloseTo(1 - Math.exp(-1), 3);
    expect(evaluateSignal({ type: "words", where: "page", terms: { "GENERAL NOTES": 1 } }, cand, page).value).toBeGreaterThan(0);
    expect(evaluateSignal({ type: "words", where: "titleBlock", terms: { NOTES: 1 } }, cand, page).value).toBe(0); // no title block words
  });

  it("csi: the box's own tagged codes by division share / section prefix / count; page codes by triggers", () => {
    expect(evaluateSignal({ type: "csi", where: "box", divisions: ["08"], measure: "share" }, cand, page)).toMatchObject({ value: 0.667 });
    expect(evaluateSignal({ type: "csi", where: "box", sectionPrefixes: ["08 71"], measure: "share" }, cand, page).value).toBeCloseTo(0.333, 3);
    expect(evaluateSignal({ type: "csi", where: "box", divisions: ["08"], measure: "count" }, cand, page).value).toBeCloseTo(2 / 3, 3);
    expect(evaluateSignal({ type: "csi", where: "box", divisions: ["08"], measure: "share", minCodes: 5 }, cand, page).value).toBe(0);
    expect(evaluateSignal({ type: "csi", where: "page", divisions: ["08"], measure: "share" }, cand, page).value).toBe(1);
    expect(cand.csi.source).toBe("tagger");
  });

  it("csi falls back to the page triggers inside the box when no tagger is available", () => {
    const p2 = buildPageEvidence({ ...input, tagger: null });
    const c2 = buildCandidateEvidence(p2, { source: "yolo", bbox: BOX, anchorBbox: BOX });
    expect(c2.csi).toEqual({ codes: [{ code: "08 11 16", division: "08" }], source: "page" });
  });

  it("sheet / channel / zone / structure / textract / shapes / yolo", () => {
    expect(evaluateSignal({ type: "sheet", disciplines: ["A", "I"] }, cand, page)).toMatchObject({ value: 1 });
    expect(evaluateSignal({ type: "sheet", disciplines: ["E"] }, cand, page).value).toBe(0);
    expect(evaluateSignal({ type: "sheet", numberPattern: "^A-6" }, cand, page).value).toBe(1);
    expect(evaluateSignal({ type: "sheet", disciplines: ["A"], numberPattern: "^A-2" }, cand, page).value).toBe(0);
    expect(evaluateSignal({ type: "channel", pageKinds: ["vector", "mixed"] }, cand, page).value).toBe(1);
    expect(evaluateSignal({ type: "channel", pageKinds: ["scanned"] }, cand, page).value).toBe(0);
    expect(evaluateSignal({ type: "zone", zone: "titleBlock" }, cand, page).value).toBe(0);
    expect(evaluateSignal({ type: "structure", feature: "structureScore" }, cand, page).value).toBe(0.8);
    expect(evaluateSignal({ type: "structure", feature: "textRows", scale: 6 }, cand, page).value).toBe(0.5);
    expect(evaluateSignal({ type: "structure", feature: "words", min: 2, max: 22 }, cand, page).value).toBe(0.5);
    expect(evaluateSignal({ type: "structure", feature: "keyShapes" }, cand, page).value).toBe(1);
    // the Textract table [.3,.3,.7,.6] overlaps the box by .02 of .12 → 16.7 %, under the .5 default
    expect(evaluateSignal({ type: "textract-table" }, cand, page).value).toBe(0);
    expect(evaluateSignal({ type: "textract-table", minContainment: 0.1 }, cand, page).value).toBeCloseTo(0.167, 3);
    expect(evaluateSignal({ type: "shapes", shapes: ["circle"], where: "leftColumn", min: 2 }, cand, page).value).toBe(1);
    expect(evaluateSignal({ type: "shapes", shapes: ["hexagon"], where: "inside" }, cand, page).value).toBe(0);
    expect(evaluateSignal({ type: "yolo", where: "inside", classes: ["circle"], model: "yolo_primitive", measure: "count" }, cand, page).value).toBeCloseTo(2 / 3, 3);
    expect(evaluateSignal({ type: "yolo", where: "page", classes: ["title_block"], measure: "presence" }, cand, page).value).toBe(1);
    expect(evaluateSignal({ type: "yolo", where: "overlap", classes: ["tables"], measure: "maxConfidence" }, cand, page).value).toBe(0.9);
    expect(evaluateSignal({ type: "yolo", where: "near", classes: ["title_block"], measure: "presence" }, cand, page).value).toBe(0);
    expect(evaluateSignal({ type: "yolo", where: "inside", classes: ["circle"], minConfidence: 0.95, measure: "presence" }, cand, page).value).toBe(0);
  });

  it("an unknown spec type yields 0 and says so, never throws", () => {
    expect(evaluateSignal({ type: "future" } as never, cand, page)).toMatchObject({ value: 0, detail: expect.stringContaining("unknown") });
  });
});

const sig = (id: string, spec: WeightedSignal["spec"], weight: number, role: WeightedSignal["role"] = "score", enabled = true): WeightedSignal => ({ id, label: id, spec, weight, role, enabled });

describe("evaluateHead", () => {
  it("logit = bias + Σ weight × value over enabled score signals; required / veto reject; features keyed by prefix", () => {
    const head = evaluateHead("detect", -1, [
      sig("s", { type: "structure", feature: "structureScore" }, 2),
      sig("off", { type: "structure", feature: "structureScore" }, 100, "score", false),
      sig("sheet", { type: "sheet", disciplines: ["A"] }, 0, "required"),
      sig("notE", { type: "sheet", disciplines: ["E"] }, 0, "veto"),
    ], cand, page);
    expect(head.logit).toBeCloseTo(-1 + 2 * 0.8, 3);
    expect(head.p).toBeCloseTo(sigmoid(0.6), 3);
    expect(head.rejected).toBe(false);
    expect(Object.keys(head.features)).toEqual(["detect.s", "detect.sheet", "detect.notE"]);
    expect(head.contributions.find((c) => c.signalId === "detect.sheet")?.delta).toBe(0);
    expect(evaluateHead("d", 0, [sig("r", { type: "sheet", disciplines: ["E"] }, 0, "required")], cand, page).rejected).toBe(true);
    expect(evaluateHead("d", 0, [sig("v", { type: "sheet", disciplines: ["A"] }, 0, "veto")], cand, page).rejected).toBe(true);
  });
});

describe("pickClass", () => {
  const klass = (id: string, bias: number, signals: WeightedSignal[], extra: Partial<ClassifierClass> = {}): ClassifierClass => ({ id, name: id.toUpperCase(), group: "arch", bias, signals, ...extra });
  const door = klass("door", -3, [sig("header", { type: "words", where: "header", terms: { "DOOR SCHEDULE": 1.5 } }, 3), sig("cols", { type: "words", where: "columns", terms: { FRAME: 1, HDWR: 1 }, saturation: 1.5 }, 2.5), sig("sheet", { type: "sheet", disciplines: ["A"] }, 1)], { legacyCategory: "door-schedule" });
  const window = klass("window", -3, [sig("cols", { type: "words", where: "columns", terms: { FRAME: 1 }, saturation: 1.5 }, 2.5), sig("sheet", { type: "sheet", disciplines: ["A"] }, 1)]);

  it("the top class wins when it clears the threshold and the margin; runner-up and legacy category are reported", () => {
    const pick = pickClass({ classes: [door, window], nameThreshold: 0.5, minMargin: 0.1, fallbackClassName: "Other" }, cand, page);
    expect(pick.classId).toBe("door");
    expect(pick.group).toBe("arch");
    expect(pick.legacyCategory).toBe("door-schedule");
    expect(pick.runnerUp?.classId).toBe("window");
    expect(pick.margin).toBeCloseTo(pick.nameP - pick.runnerUp!.nameP, 3);
    expect(pick.why[0].signalId).toBe("door.header");
    expect(Object.keys(pick.features).sort()).toEqual(["door.cols", "door.header", "door.sheet", "window.cols", "window.sheet"]);
  });

  it("falls back (classId null, fallback name, group null) below the threshold or inside the margin, and skips rejected classes", () => {
    const tight = pickClass({ classes: [door, window], nameThreshold: 0.5, minMargin: 0.9, fallbackClassName: "Other" }, cand, page);
    expect(tight).toMatchObject({ classId: null, className: "Other", group: null });
    expect(tight.nameP).toBeGreaterThan(0.5); // the nearest class's p is still reported
    const high = pickClass({ classes: [klass("x", -3, [], { threshold: 0.99 })], nameThreshold: 0.1, minMargin: 0, fallbackClassName: "Other" }, cand, page);
    expect(high.classId).toBeNull();
    const vetoed = pickClass({ classes: [klass("door", 5, [sig("notA", { type: "sheet", disciplines: ["A"] }, 0, "veto")]), window], nameThreshold: 0.1, minMargin: 0, fallbackClassName: "Other" }, cand, page);
    expect(vetoed.classId).toBe("window");
    expect(pickClass({ classes: [], nameThreshold: 0.5, minMargin: 0, fallbackClassName: "Other" }, cand, page)).toMatchObject({ classId: null, nameP: 0, why: [] });
  });
});
