// [tag-mapping v2 2026-10-24] The orchestrator with a shape ensemble + owner rules in the context,
// and the proof that a context WITHOUT them is v1 verbatim.
import { describe, expect, it } from "vitest";
import type { ClientAnnotation, TextractPageData } from "@/types";
import { findOccurrences } from "../find-occurrences";
import { allPagesScope } from "../primitives/scope";
import { buildEnsembleContext } from "../ensemble-context";
import { DEFAULT_TAG_RULES } from "../tag-rules";
import type { CountableItem, MatchContext } from "../types";

const SMALL = 40 / 10800;
const BIG = 150 / 10800;
const word = (text: string, x: number, y: number, w = 0.004, h = 0.003) => ({ text, confidence: 99, bbox: [x, y, w, h] as [number, number, number, number] });
const textract = (words: ReturnType<typeof word>[]): TextractPageData => ({ words, lines: [] });
let nextId = 1;
const yoloAnn = (name: string, page: number, x: number, y: number, size: number, confidence = 0.8): ClientAnnotation =>
  ({ id: nextId++, pageNumber: page, name, bbox: [x, y, x + size, y + size], note: null, source: "yolo", data: { modelName: "yolo_primitive", confidence } });
const shapeAnn = (shape: string, text: string, page: number, x: number, y: number, size: number): ClientAnnotation =>
  ({ id: nextId++, pageNumber: page, name: shape, bbox: [x, y, x + size, y + size], note: null, source: "shape-parse", data: { modelName: "shape-parse", shapeType: shape, text, confidence: 0.9 } });

function v2Context(annotations: ClientAnnotation[], textractData: Record<number, TextractPageData>, drawingNumbers: Record<number, string> = {}): MatchContext {
  const pages = Object.keys(textractData).map(Number).map((pageNumber) => ({ pageNumber, drawingNumber: drawingNumbers[pageNumber] ?? null, textractData: textractData[pageNumber] }));
  const ensemble = buildEnsembleContext(annotations, pages);
  return {
    scope: allPagesScope(), isPageScoped: false, annotations, textractData, classifiedRegionsByPage: {}, pattern: null,
    shapes: ensemble.shapes, sheetNumbers: ensemble.sheetNumbers, rules: DEFAULT_TAG_RULES,
  };
}
const v1Context = (annotations: ClientAnnotation[], textractData: Record<number, TextractPageData>): MatchContext =>
  ({ scope: allPagesScope(), isPageScoped: false, annotations, textractData, classifiedRegionsByPage: {}, pattern: null });

describe("Type 3 with the ensemble — the classical small-shape recall arm", () => {
  // Page 1: a YOLO circle holding "D-101" (Textract read it), and a 40 px classical-only circle
  // whose crop read is "D-101" but which Textract never saw (the 44 % case).
  const annotations = [yoloAnn("circle", 1, 0.1, 0.1, BIG, 0.9), shapeAnn("circle", "D-101", 1, 0.5, 0.5, SMALL)];
  const textractData = { 1: textract([word("D-101", 0.105, 0.105)]) };
  const item: CountableItem = { itemType: "yolo-with-inner-text", label: "D-101", yoloClass: "circle", text: "D-101" };

  it("v1 finds only the YOLO circle; v2 also finds the classical bubble", () => {
    const v1 = findOccurrences(item, v1Context(annotations, textractData));
    expect(v1.map((m) => m.annotationId)).toEqual([annotations[0].id]);
    const v2 = findOccurrences(item, v2Context(annotations, textractData));
    expect(v2.map((m) => m.annotationId).sort()).toEqual([annotations[0].id, annotations[1].id].sort());
    expect(v2.every((m) => (m.signals?.shapeContainBoost ?? 0) > 0)).toBe(true);
  });

  it("the ensemble shape's confidence enters the score as shapeContainBoost", () => {
    const v2 = findOccurrences(item, v2Context(annotations, textractData));
    const yoloHit = v2.find((m) => m.annotationId === annotations[0].id)!;
    const classicalHit = v2.find((m) => m.annotationId === annotations[1].id)!;
    expect(yoloHit.signals!.shapeContainBoost).toBeGreaterThan(classicalHit.signals!.shapeContainBoost);
    expect(yoloHit.confidence).toBe(1.0);
  });
});

describe("Type 1 — tag classes read the ensemble, object classes keep v1", () => {
  it("counting circles includes the small classical bubble; counting doors reads YOLO rows only", () => {
    const annotations = [yoloAnn("circle", 1, 0.1, 0.1, BIG, 0.9), shapeAnn("circle", "7", 1, 0.5, 0.5, SMALL), yoloAnn("door_single", 1, 0.3, 0.3, BIG, 0.9)];
    const textractData = { 1: textract([word("7", 0.105, 0.105)]) };
    const circles = findOccurrences({ itemType: "yolo-only", label: "circle", yoloClass: "circle" }, v2Context(annotations, textractData));
    expect(circles).toHaveLength(2);
    const doors = findOccurrences({ itemType: "yolo-only", label: "door", yoloClass: "door_single" }, v2Context(annotations, textractData));
    expect(doors.map((m) => m.annotationId)).toEqual([annotations[2].id]);
  });

  it("a textless low-confidence YOLO circle is not counted by v2 (it was by v1)", () => {
    const annotations = [yoloAnn("circle", 1, 0.1, 0.1, BIG, 0.2)];
    const textractData = { 1: textract([]) };
    const item: CountableItem = { itemType: "yolo-only", label: "circle", yoloClass: "circle" };
    expect(findOccurrences(item, v1Context(annotations, textractData))).toHaveLength(1);
    expect(findOccurrences(item, v2Context(annotations, textractData))).toHaveLength(0);
  });
});

describe("Type 2 — owner rules on free-floating text", () => {
  it("dimensions and words glued to a neighbour are dropped; the plain word stays", () => {
    const h = 0.003;
    const words = [
      word("8", 0.1, 0.1), word("'-0\"", 0.1 + 0.004 + h * 0.1, 0.1),          // dimension pair
      word("D-", 0.3, 0.3), word("8", 0.3 + 0.004 + h * 0.1, 0.3),              // split token
      word("8", 0.6, 0.6),                                                       // standing alone
    ];
    const textractData = { 1: textract(words) };
    const item: CountableItem = { itemType: "text-only", label: "8", text: "8" };
    expect(findOccurrences(item, v1Context([], textractData))).toHaveLength(3);
    const v2 = findOccurrences(item, v2Context([], textractData));
    expect(v2).toHaveLength(1);
    expect(v2[0].bbox[0]).toBeCloseTo(0.6, 6);
  });

  it("a 1-letter tag in a sentence is dropped unless it sits in a shape", () => {
    const words = [word("PROVIDE", 0.1, 0.1, 0.02), word("A", 0.1 + 0.02 + 0.003 * 0.8, 0.1, 0.003), word("SOLUTION", 0.1 + 0.02 + 0.003 * 0.8 + 0.003 + 0.003 * 0.8, 0.1, 0.02)];
    const textractData = { 1: textract(words) };
    const item: CountableItem = { itemType: "text-only", label: "A", text: "A" };
    expect(findOccurrences(item, v2Context([], textractData))).toHaveLength(0);
    const bubble = yoloAnn("circle", 1, 0.1 + 0.02 + 0.003 * 0.8 - 0.001, 0.1 - 0.001, 0.006, 0.9);
    expect(findOccurrences(item, v2Context([bubble], textractData))).toHaveLength(1);
  });

  it("detail callouts: '3' inside '3 over R-3' is not tag 3, but it IS a reference to sheet R-3", () => {
    const annotations = [yoloAnn("circle", 1, 0.3, 0.3, BIG, 0.9)];
    const textractData = { 1: textract([word("3", 0.305, 0.301), word("R-3", 0.303, 0.309)]), 2: textract([]) };
    const drawing = { 1: "A-101", 2: "R-3" };
    const three = findOccurrences({ itemType: "yolo-with-inner-text", label: "3", yoloClass: "circle", text: "3" }, v2Context(annotations, textractData, drawing));
    expect(three).toHaveLength(0);
    const sheet = findOccurrences({ itemType: "yolo-with-inner-text", label: "R-3", yoloClass: "circle", text: "R-3" }, v2Context(annotations, textractData, drawing));
    expect(sheet.map((m) => m.annotationId)).toEqual([annotations[0].id]);
    // v1 counted the callout's "3" as a tag 3 occurrence (the 547 false tags the owner's R2 removed).
    expect(findOccurrences({ itemType: "yolo-with-inner-text", label: "3", yoloClass: "circle", text: "3" }, v1Context(annotations, textractData))).toHaveLength(1);
  });
});

describe("fix round 1 — detail titles and the model filter", () => {
  // A bubble "3" with "ADMIN SUITE SCALE: 1/4\"" to its right (a detail title) and an unrelated empty
  // circle elsewhere on the page.
  const annotations = [yoloAnn("circle", 1, 0.1, 0.1, 0.006, 0.9), yoloAnn("circle", 1, 0.5, 0.5, 0.006, 0.9)];
  const textractData = { 1: textract([word("3", 0.1015, 0.1015, 0.002), word("ADMIN", 0.12, 0.102), word("SUITE", 0.13, 0.102), word("SCALE:", 0.15, 0.102), word('1/4"', 0.16, 0.102)]) };

  it("the title's '3' is neither a Type 2 hit nor a Type 3 instance bound to the other circle (any reach)", () => {
    const ctx = v2Context(annotations, textractData);
    expect(ctx.shapes![1]!.map((s) => s.kind)).toEqual(["detail_title", "tag"]);
    expect(findOccurrences({ itemType: "text-only", label: "3", text: "3" }, ctx)).toHaveLength(0);
    expect(findOccurrences({ itemType: "yolo-with-inner-text", label: "3", yoloClass: "circle", text: "3" }, ctx)).toHaveLength(0);
    // even with no text rules in the context the floating fallback never binds a word inside a non-tag shape
    expect(findOccurrences({ itemType: "yolo-with-inner-text", label: "3", yoloClass: "circle", text: "3" }, { ...ctx, rules: undefined })).toHaveLength(0);
  });

  it("item.yoloModel filters YOLO-backed shapes as in v1; classical-only bubbles stay", () => {
    const custom: ClientAnnotation = { id: nextId++, pageNumber: 1, name: "circle", bbox: [0.3, 0.3, 0.3 + BIG, 0.3 + BIG], note: null, source: "yolo", data: { modelName: "custom", confidence: 0.9 } };
    const anns = [yoloAnn("circle", 1, 0.1, 0.1, BIG, 0.9), custom, shapeAnn("circle", "7", 1, 0.6, 0.6, SMALL)];
    const td = { 1: textract([word("7", 0.105, 0.105), word("7", 0.305, 0.305)]) };
    const count = (yoloModel?: string) => findOccurrences({ itemType: "yolo-only", label: "circle", yoloClass: "circle", yoloModel }, v2Context(anns, td)).map((m) => m.annotationId).sort();
    expect(count()).toEqual([anns[0].id, custom.id, anns[2].id].sort());
    expect(count("yolo_primitive")).toEqual([anns[0].id, anns[2].id].sort());
    expect(count("custom")).toEqual([custom.id, anns[2].id].sort());
    const sevens = findOccurrences({ itemType: "yolo-with-inner-text", label: "7", yoloClass: "circle", yoloModel: "yolo_primitive", text: "7" }, v2Context(anns, td));
    expect(sevens.map((m) => m.annotationId).sort()).toEqual([anns[0].id, anns[2].id].sort());
  });
});

describe("Type 4 with the ensemble", () => {
  it("binds the matched tag shape to the nearest object and keeps v1 confidences", () => {
    const annotations = [yoloAnn("door_single", 1, 0.2, 0.2, BIG, 0.9), shapeAnn("hexagon", "101", 1, 0.2 + BIG + 0.002, 0.2, SMALL)];
    const textractData = { 1: textract([]) };
    const item: CountableItem = { itemType: "yolo-object-with-tag-shape", label: "101", yoloClass: "door_single", tagShapeClass: "hexagon", text: "101" };
    expect(findOccurrences(item, v1Context(annotations, textractData))).toHaveLength(0);
    const v2 = findOccurrences(item, v2Context(annotations, textractData));
    expect(v2.map((m) => [m.annotationId, m.confidence])).toEqual([[annotations[0].id, 0.9]]);
  });
});

describe("Type 3 floating fallback — binding reach is an owner option", () => {
  // A floating "D-101" word far from the only circle on the page (the circle holds "D-7").
  const annotations = [yoloAnn("circle", 1, 0.1, 0.1, BIG, 0.9)];
  const textractData = { 1: textract([word("D-7", 0.105, 0.105), word("D-101", 0.8, 0.8)]) };
  const item: CountableItem = { itemType: "yolo-with-inner-text", label: "D-101", yoloClass: "circle", text: "D-101" };

  it("default (floatingBindReach null) keeps v1 semantics: the far word binds to the nearest circle", () => {
    const v1 = findOccurrences(item, v1Context(annotations, textractData));
    const v2 = findOccurrences(item, v2Context(annotations, textractData));
    expect(v1.map((m) => [m.annotationId, m.confidence])).toEqual([[annotations[0].id, 0.8]]);
    expect(v2.map((m) => [m.annotationId, m.confidence])).toEqual([[annotations[0].id, 0.8]]);
  });

  it("with a reach cap the far word does not bind, and a word within reach of an empty circle does", () => {
    const capped = { ...v2Context(annotations, textractData), rules: { ...DEFAULT_TAG_RULES, floatingBindReach: 1.5 } };
    expect(findOccurrences(item, capped)).toHaveLength(0);
    const empty = [yoloAnn("circle", 1, 0.5, 0.5, BIG, 0.9)];
    const near = { 1: textract([word("D-101", 0.5 + BIG + 0.002, 0.5 + BIG / 2)]) };
    const hits = findOccurrences(item, { ...v2Context(empty, near), rules: { ...DEFAULT_TAG_RULES, floatingBindReach: 1.5 } });
    expect(hits.map((m) => [m.annotationId, m.confidence])).toEqual([[empty[0].id, 0.8]]);
  });
});
