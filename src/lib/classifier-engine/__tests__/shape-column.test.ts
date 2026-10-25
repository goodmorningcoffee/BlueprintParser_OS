// [shape-tags 2026-10-25] The shape-tag column rule (shape-column.ts): aligned shapes in the left part of a box
// form a column, off-axis and oversized rectangles do not, gap regularity, the text shares, the tag map with its
// rows (tag text inside the shape, else the classical crop read, else null; continuation lines fold into the row
// above; cap), and the new engine signals / head / summary fields that ride on it.
import { describe, expect, it } from "vitest";
import type { BboxMinMax, TextractWord } from "@/types";
import { classifyRegionsV2 } from "@/lib/region-classifier-v2";
import { BUILT_IN_RECIPES, runClassifierEngine, buildProjectProposalSummary, checkSpec, SIGNAL_TYPES, SPEC_TYPES, validateRecipe } from "..";
import { buildCandidateEvidence, buildPageEvidence, type ClassifierPageInput } from "../evidence";
import { evaluateSignal } from "../signals";
import { bestShapeColumn, buildTagMap, columnTextShares, findShapeColumn, rowBands, type ColumnShape, type ColumnWord } from "../shape-column";
import { TAG_MAP_ROW_CAP } from "../types";

const BOX: BboxMinMax = [0.1, 0.1, 0.5, 0.4];
const circle = (y: number, x = 0.12, source: ColumnShape["source"] = "yolo", text?: string): ColumnShape =>
  ({ label: "circle", bbox: [x - 0.01, y - 0.008, x + 0.01, y + 0.008], source, confidence: 0.8, ...(text ? { text } : {}) });
const word = (text: string, x: number, y: number, h = 0.01): ColumnWord => ({ text, bbox: [x, y - h / 2, x + text.length * 0.006, y + h / 2], c: [x + text.length * 0.003, y], h });
const ys = [0.15, 0.18, 0.21, 0.24, 0.27];

describe("findShapeColumn", () => {
  it("5 aligned circles in the left quarter form a column; the gap CV is 0; the off-axis and right-side shapes are dropped", () => {
    const shapes = [...ys.map((y) => circle(y)), circle(0.3, 0.16), circle(0.33, 0.4)];
    const col = findShapeColumn(shapes, BOX, "yolo");
    expect(col).toMatchObject({ source: "yolo", shapeClass: "circle", n: 5 });
    expect(col!.gapCv).toBeCloseTo(0, 6);
    expect(col!.right).toBeCloseTo(0.13, 6);
    expect(col!.pitch).toBeCloseTo(0.03, 6);
    expect(col!.shapes.map((s) => (s.bbox[1] + s.bbox[3]) / 2)).toEqual(ys);
    expect(findShapeColumn(shapes, BOX, "classical")).toBeNull();
    expect(findShapeColumn(shapes.slice(0, 2), BOX, "yolo")).toBeNull();
  });

  it("rectangles wider than the 250 px cap are table cells, not tags; a double-fired bubble counts once", () => {
    const big: ColumnShape[] = ys.map((y) => ({ label: "rectangle", bbox: [0.11, y - 0.005, 0.11 + 300 / 10800, y + 0.005], source: "classical", confidence: 1 }));
    expect(findShapeColumn(big, BOX, "classical")).toBeNull();
    const small: ColumnShape[] = ys.map((y) => ({ label: "rectangle", bbox: [0.11, y - 0.005, 0.11 + 200 / 10800, y + 0.005], source: "classical", confidence: 1 }));
    expect(findShapeColumn(small, BOX, "classical")?.n).toBe(5);
    const doubled = [...ys.map((y) => circle(y)), { ...circle(0.15), label: "arch_sheet_circle", confidence: 0.9 }];
    const col = findShapeColumn(doubled, BOX, "yolo")!;
    expect(col.n).toBe(5);
    expect(col.shapes[0].label).toBe("arch_sheet_circle"); // the more confident of the pair stays
    expect(col.shapeClass).toBe("circle");
  });

  it("irregular gaps raise the CV; bestShapeColumn prefers more shapes, then classical", () => {
    const col = findShapeColumn([circle(0.15), circle(0.16), circle(0.3)], BOX, "yolo")!;
    expect(col.gapCv).toBeGreaterThan(0.5);
    const both = [...ys.map((y) => circle(y)), ...ys.slice(0, 3).map((y) => circle(y, 0.12, "classical", "A1"))];
    expect(bestShapeColumn(both, BOX, "any")?.source).toBe("yolo");
    const tie = [...ys.slice(0, 3).map((y) => circle(y)), ...ys.slice(0, 3).map((y) => circle(y, 0.12, "classical"))];
    expect(bestShapeColumn(tie, BOX, "any")?.source).toBe("classical");
    expect(bestShapeColumn([], BOX, "any")).toBeNull();
  });

  it("text shares and row bands: continuation lines fold into the row above; the last band ends half a pitch below", () => {
    const col = findShapeColumn(ys.map((y) => circle(y)), BOX, "yolo")!;
    const words = [word("1", 0.117, 0.15), word("WALL", 0.2, 0.15), word("TYPE", 0.2, 0.18), word("A", 0.2, 0.195), word("DOOR", 0.2, 0.24)];
    expect(columnTextShares(col, words)).toEqual({ textInside: 0.2, textRight: 0.6 });
    const bands = rowBands(col, BOX);
    expect(bands).toHaveLength(5);
    expect(bands[0][1]).toBeCloseTo(0.142, 6);
    expect(bands[0][3]).toBeCloseTo(0.172, 6); // the next band's top
    expect(bands[4][3]).toBeCloseTo(0.278 + 0.015, 6);
    expect(bands.every((b) => b[0] === BOX[0] && b[2] === BOX[2])).toBe(true);
  });
});

describe("buildTagMap", () => {
  const words = [word("1", 0.117, 0.15), word("WALL", 0.2, 0.15), word("TYPE", 0.2, 0.18), word("A", 0.2, 0.195), word("DOOR", 0.2, 0.24), word("TITLE", 0.2, 0.12)];

  it("one row per column shape: tag from the word inside, else the crop read, else null; row text joins the band and its continuation", () => {
    const shapes = [circle(0.15), circle(0.18, 0.12, "yolo", "ignored"), circle(0.21, 0.12, "classical"), circle(0.24), circle(0.27)];
    const map = buildTagMap(shapes.filter((s) => s.source === "yolo"), words, BOX)!;
    expect(map.column).toEqual({ source: "yolo", shapeClass: "circle", n: 4, gapCv: expect.any(Number), textInside: 0.25 });
    expect(map.rows.map((r) => [r.tag, r.rowText])).toEqual([["1", "WALL"], ["ignored", "TYPE A"], [null, "DOOR"], [null, ""]]);
    expect(map.rows[0].rowBbox[0]).toBe(BOX[0]);
    expect(map.truncated).toBe(false);
    expect(buildTagMap([], words, BOX)).toBeUndefined();
  });

  it("caps the rows at TAG_MAP_ROW_CAP and says so", () => {
    const many = Array.from({ length: TAG_MAP_ROW_CAP + 5 }, (_, i) => circle(0.12 + i * 0.01));
    const map = buildTagMap(many, [], [0.1, 0.1, 0.5, 0.9])!;
    expect(map.rows).toHaveLength(TAG_MAP_ROW_CAP);
    expect(map.truncated).toBe(true);
    expect(map.column.n).toBe(TAG_MAP_ROW_CAP + 5);
  });
});

/** A legend-like box: five hexagons down the left, a word inside each, a description to the right, on a regular pitch. */
function legendInput(): ClassifierPageInput {
  const words: TextractWord[] = [{ text: "LEGEND", confidence: 99, bbox: [0.12, 0.11, 0.05, 0.012] }];
  const dets = [{ name: "tables", modelName: "yolo_medium", confidence: 0.9, minX: BOX[0], minY: BOX[1], maxX: BOX[2], maxY: BOX[3] }];
  ys.forEach((y, i) => {
    words.push({ text: `K${i + 1}`, confidence: 99, bbox: [0.113, y - 0.005, 0.014, 0.01] });
    ["NEW", "WALL", "TYPE", String(i)].forEach((t, j) => words.push({ text: t, confidence: 99, bbox: [0.16 + j * 0.05, y - 0.005, 0.03, 0.01] }));
    dets.push({ name: "hexagon", modelName: "yolo_primitive", confidence: 0.7, minX: 0.11, minY: y - 0.01, maxX: 0.13, maxY: y + 0.01 });
  });
  dets.push({ name: "grid", modelName: "yolo_primitive", confidence: 0.6, minX: 0.1, minY: 0.13, maxX: 0.5, maxY: 0.3 });
  return { pageNumber: 4, detections: dets, textractData: { words, tables: [{ bbox: [0.1, 0.1, 0.4, 0.3], cells: [], rowCount: 6, colCount: 2 }] }, csiCodes: [], drawingNumber: "A-001", tagger: () => [] };
}

describe("shape-column / ocr-grid signals and the table head", () => {
  const page = buildPageEvidence(legendInput());
  const cand = buildCandidateEvidence(page, { source: "yolo", bbox: BOX, anchorBbox: BOX });

  it("evaluate the column and the word grid on the box", () => {
    expect(evaluateSignal({ type: "shape-column", source: "yolo", measure: "count" }, cand, page)).toMatchObject({ value: 0.625, detail: "5 hexagon column (yolo)" });
    expect(evaluateSignal({ type: "shape-column", source: "any", measure: "regular" }, cand, page).value).toBe(1);
    expect(evaluateSignal({ type: "shape-column", source: "any", measure: "regular", maxGapCv: 0.01 }, cand, page).value).toBe(1);
    expect(evaluateSignal({ type: "shape-column", source: "any", measure: "textInside" }, cand, page).value).toBe(1);
    expect(evaluateSignal({ type: "shape-column", source: "any", measure: "textRight" }, cand, page).value).toBe(1);
    expect(evaluateSignal({ type: "shape-column", source: "classical", measure: "count" }, cand, page).value).toBe(0);
    expect(evaluateSignal({ type: "shape-column", source: "any", measure: "count", minShapes: 6 }, cand, page).value).toBe(0);
    expect(evaluateSignal({ type: "ocr-grid", measure: "rows" }, cand, page)).toMatchObject({ value: 0.625, detail: "5 rows × 5 cols" });
    expect(evaluateSignal({ type: "ocr-grid", measure: "cols", scale: 5 }, cand, page).value).toBe(1);
    expect(evaluateSignal({ type: "ocr-grid", measure: "grid" }, cand, page).value).toBe(1);
    expect(evaluateSignal({ type: "ocr-grid", measure: "regularity" }, cand, page).value).toBe(1);
    expect(evaluateSignal({ type: "textract-table", minContainment: 0.3, minRows: 10 }, cand, page).value).toBe(0);
    expect(evaluateSignal({ type: "textract-table", minContainment: 0.3, minRows: 6 }, cand, page).value).toBeGreaterThan(0.3);
    expect(evaluateSignal({ type: "yolo", where: "inside", measure: "cover", model: "yolo_primitive", classes: ["grid"] }, cand, page).value).toBeGreaterThan(0.5);
  });

  it("spec-check rejects unknown fields and bad values; the catalog has a row per spec type", () => {
    expect(checkSpec({ type: "shape-column", source: "any", measure: "count" }, "s")).toEqual([]);
    expect(checkSpec({ type: "shape-column", source: "both", measure: "count" }, "s")[0]).toContain("source");
    expect(checkSpec({ type: "shape-column", source: "any", measure: "count", bogus: 1 }, "s")[0]).toContain("bogus");
    expect(checkSpec({ type: "ocr-grid", measure: "rows", scale: 0 }, "s")[0]).toContain("scale");
    expect(checkSpec({ type: "ocr-grid", measure: "pitch" }, "s")[0]).toContain("measure");
    expect(checkSpec({ type: "textract-table", minRows: -1 }, "s")[0]).toContain("minRows");
    const rows = new Set(SIGNAL_TYPES.map((t) => t.type));
    expect(rows.has("shape-column") && rows.has("ocr-grid")).toBe(true);
    expect([...rows].every((t) => SPEC_TYPES.has(t))).toBe(true);
  });

  it("the engine stores tableP / tableWhy (features table.*), the tag map and the sheet on each proposal; the summary carries chips", () => {
    const input = legendInput();
    const regionsV2 = classifyRegionsV2({ pageNumber: 4, detections: input.detections, textractData: input.textractData, csiCodes: [] });
    const run = runClassifierEngine({ ...input, regionsV2 }, BUILT_IN_RECIPES);
    const p = run.result.proposals.find((x) => x.regionId);
    expect(p).toBeDefined();
    expect(p!.tableP).toBeGreaterThan(0.5);
    expect(p!.tableWhy!.length).toBeGreaterThan(0);
    expect(Object.keys(p!.features).some((k) => k.startsWith("table."))).toBe(true);
    expect(p!.tagMap!.column).toMatchObject({ source: "yolo", shapeClass: "hexagon", n: 5 });
    expect(p!.tagMap!.rows.map((r) => r.tag)).toEqual(["K1", "K2", "K3", "K4", "K5"]);
    expect(p!.tagMap!.rows[2].rowText).toBe("NEW WALL TYPE 2");
    expect(p).toMatchObject({ sheetNumber: "A-001", discipline: "A" });
    const summary = buildProjectProposalSummary([{ pageNumber: 4, pageIntelligence: { classifierProposals: run.result } }], "t");
    const item = summary.items.find((i) => i.id === p!.id)!;
    expect(item).toMatchObject({ tableP: p!.tableP, tagRows: 5, tags: ["K1", "K2", "K3", "K4", "K5"], tagShape: "hexagon" });
    // a recipe without a table head yields no tableP; a recipe with a malformed one fails validation
    const bare = { ...BUILT_IN_RECIPES[0], tableHead: undefined };
    const run2 = runClassifierEngine({ ...input, regionsV2 }, [bare]);
    expect(run2.result.proposals.every((x) => x.tableP === undefined && !Object.keys(x.features).some((k) => k.startsWith("table.")))).toBe(true);
    expect(() => validateRecipe({ ...BUILT_IN_RECIPES[0], tableHead: { bias: "x" } }, "custom")).toThrow(/tableHead/);
  });
});
