// @vitest-environment node
// [table pipeline WP-3.A] The row METHODS one by one (R1: geometry only, a failure is an `error` and no vote),
// the fused shape set (R10) and the anchor prior (R6). Synthetic geometry and pseudo-text only (rule 12).
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COLUMN_SHAPE_LABELS } from "@/lib/classifier-engine/shape-column";
import { rowsInputFor, runRowMethods } from "../fuse";
import { anchorCentres, owningProposal } from "../rows/anchor-prior";
import { KEY_LIKE_RE, findKeyColumn, hangingIndentRows } from "../rows/hanging-indent";
import { layoutRows } from "../rows/layout";
import { ocrLinesRows } from "../rows/ocr-lines";
import { primitiveGridRows } from "../rows/primitive-grid";
import { shapeCentreRows } from "../rows/shape-centres";
import { textractCellRows } from "../rows/textract-cells";
import { ENGINE_COLUMN_SHAPE_LABELS, fuseShapes, fusedShapeColumn, shapeRegimeHolds } from "../shapes";
import { DEFAULT_ROW_WEIGHTS, ROW_METHODS } from "../types-rows";
import { loadSlices } from "./golden-harness";
import { evidence, evidenceFromFixture, proposalWithAnchors, shape, table, word, type Box } from "./rows-evidence-helpers";
import type { EngineWord } from "../types";

const BOX: Box = [0.1, 0.1, 0.6, 0.6];
const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;
const lines5 = (): EngineWord[] => [0.2, 0.22, 0.24, 0.26, 0.28].flatMap((y, i) => [word(`A${i}`, 0.11, y), word(`B${i}`, 0.2, y)]);

describe("R1: every method is asked, a failed one records an error and casts no vote", () => {
  it("on an empty box every method fails with a reason and no rowLines", () => {
    const hyps = runRowMethods(rowsInputFor(evidence({ words: [] }), BOX));
    expect(hyps.map((h) => h.method)).toEqual(ROW_METHODS.filter((m) => m !== "shape-centres"));
    for (const h of hyps) {
      expect(h.error, h.method).toBeTruthy();
      expect(h.rowLines, h.method).toBeUndefined();
      expect(h.conf).toBe(0);
    }
  });
  it("R8 weights are the plan's initial values", () => {
    expect(DEFAULT_ROW_WEIGHTS).toEqual({ "textract-cells": 1, rulings: 1, "hanging-indent": 0.6, "primitive-grid": 0.6, "ocr-lines": 0.5, layout: 0.4, img2table: 0.7, tatr: 0.8 });
  });
});

describe("ocr-lines", () => {
  it("lines mode: one boundary between consecutive visual lines at the gap midpoint, content top and bottom as the ends", () => {
    const h = ocrLinesRows(rowsInputFor(evidence({ words: lines5() }), BOX));
    expect(h.error).toBeUndefined();
    expect(h.rowLines!.map(r6)).toEqual([0.196, 0.21, 0.23, 0.25, 0.27, 0.284]);
    expect(h.conf).toBeCloseTo(0.85, 6); // perfectly regular pitch
  });
  it("a single line casts no vote; two overlapping lines are cut between their centres", () => {
    expect(ocrLinesRows(rowsInputFor(evidence({ words: [word("A", 0.11, 0.2)] }), BOX)).error).toMatch(/too few lines/);
    const h = ocrLinesRows(rowsInputFor(evidence({ words: [word("A", 0.11, 0.2, 0.02), word("B", 0.3, 0.212, 0.02)] }), BOX));
    expect(h.rowLines!.map(r6)).toEqual([0.19, 0.206, 0.222]);
  });
  it("legacy mode bails out like methodOcrPositions (< 6 words, < 3 clusters)", () => {
    expect(ocrLinesRows(rowsInputFor(evidence({ words: lines5().slice(0, 5) }), BOX), "legacy").error).toMatch(/too few words/);
    const twoRows = [0.2, 0.22].flatMap((y) => [word("A", 0.11, y), word("B", 0.2, y), word("C", 0.3, y)]);
    expect(ocrLinesRows(rowsInputFor(evidence({ words: twoRows }), BOX), "legacy").error).toMatch(/too few row clusters/);
    const ok = ocrLinesRows(rowsInputFor(evidence({ words: lines5() }), BOX), "legacy");
    expect(ok.rowLines!.map(r6)).toEqual([0.1, 0.21, 0.23, 0.25, 0.27, 0.6]);
  });
});

describe("textract-cells", () => {
  it("row edges from the cells, header rows from `hdr`, a one-cell spanning row as a section, cells carried on", () => {
    const t = table([[0.19, 0.21], [0.22, 0.24], [0.25, 0.27], [0.28, 0.3]], [[0.1, 0.2], [0.2, 0.5]], 1);
    // row 2 is a merged section title: one cell spanning both columns
    t.cells = t.cells.filter((c) => !(c.r === 2 && c.c === 1)).map((c) => (c.r === 2 ? { ...c, cs: 2, b: [0.1, 0.25, 0.5, 0.27] as Box } : c));
    const h = textractCellRows(rowsInputFor(evidence({ words: [], textractTables: [t] }), BOX));
    expect(h.error).toBeUndefined();
    expect(h.rowLines!.map(r6)).toEqual([0.19, 0.215, 0.245, 0.275, 0.3]);
    expect(h.headerRows).toBe(1);
    expect(h.headerBottom).toBeCloseTo(0.215, 9);
    expect(h.sections?.map((s) => s.map(r6))).toEqual([[0.245, 0.275]]);
    expect(h.cells).toHaveLength(7);
    expect(h.cells!.filter((c) => c.header)).toHaveLength(2);
    expect(h.conf).toBe(1);
  });
  it("a table elsewhere on the page (containment < .5) is not read; a spanning anchor never sets a row edge", () => {
    const far = table([[0.7, 0.72], [0.73, 0.75]], [[0.1, 0.5]]);
    expect(textractCellRows(rowsInputFor(evidence({ words: [], textractTables: [far] }), BOX)).error).toMatch(/no stored Textract table/);
    const t = table([[0.19, 0.21], [0.22, 0.24], [0.25, 0.27]], [[0.1, 0.2], [0.2, 0.5]]);
    t.cells = t.cells.filter((c) => !(c.r === 1 && c.c === 0)).map((c) => (c.r === 0 && c.c === 0 ? { ...c, rs: 2, b: [0.1, 0.19, 0.2, 0.24] as Box } : c));
    const h = textractCellRows(rowsInputFor(evidence({ words: [], textractTables: [t] }), BOX));
    expect(h.rowLines!.map(r6)).toEqual([0.19, 0.215, 0.245, 0.27]);
  });
});

describe("layout and primitive-grid", () => {
  it("layout: block edges vote, a section header is a section band, a title at the top is the header bottom; no LAYOUT → no vote", () => {
    const h = layoutRows(rowsInputFor(evidence({
      words: [], layout: [
        { k: "title", b: [0.1, 0.11, 0.3, 0.13] }, { k: "section-header", b: [0.1, 0.2, 0.5, 0.21] }, { k: "list", b: [0.1, 0.22, 0.5, 0.3] }, { k: "text", b: [0.1, 0.8, 0.5, 0.9] },
      ],
    }), BOX));
    expect(h.rowLines).toEqual([0.11, 0.13, 0.2, 0.21, 0.22, 0.3]);
    expect(h.sections).toEqual([[0.2, 0.21]]);
    expect(h.headerBottom).toBe(0.13);
    expect(layoutRows(rowsInputFor(evidence({ words: [] }), BOX)).error).toMatch(/no stored LAYOUT/);
  });
  it("primitive-grid: wide horizontal areas are row separators, grid edges bound the table, vertical areas are columns", () => {
    const h = primitiveGridRows(rowsInputFor(evidence({
      words: [], primitives: [
        { b: [0.1, 0.249, 0.5, 0.251], cls: "horizontal_area" }, { b: [0.3, 0.299, 0.35, 0.301], cls: "horizontal_area" } /* a cell fill */,
        { b: [0.1, 0.2, 0.5, 0.4], cls: "grid" }, { b: [0.249, 0.2, 0.251, 0.4], cls: "vertical_area" },
      ],
    }), BOX));
    expect(h.rowLines).toEqual([0.2, 0.25, 0.4]);
    expect(h.colLines).toEqual([0.1, 0.25, 0.5]);
    expect(primitiveGridRows(rowsInputFor(evidence({ words: [] }), BOX)).error).toMatch(/no grid primitive/);
  });
});

describe("hanging-indent", () => {
  it("a key opens a row and the wrapped lines continue it; without a key column it casts no vote", () => {
    const words: EngineWord[] = [];
    [["1.", 0.2], ["2.", 0.24], ["3.", 0.3]].forEach(([k, y]) => { words.push(word(k as string, 0.11, y as number), word("ZFKMP SNIEV LOZC", 0.13, y as number)); });
    words.push(word("QEISL ZYSFM", 0.13, 0.21), word("HFBLJ", 0.13, 0.25), word("ERKZM GATDK", 0.13, 0.26), word("WRIS", 0.13, 0.27));
    const input = rowsInputFor(evidence({ words }), BOX);
    const col = findKeyColumn(input)!;
    expect(col).not.toBeNull();
    expect(col.x0).toBe(0.11);
    const h = hangingIndentRows(input);
    expect(h.rowLines!.length).toBe(4);
    expect(h.rowLines!.map(r6)).toEqual([0.196, 0.225, 0.285, 0.304]);
    expect(h.conf).toBe(0.9);
    expect(hangingIndentRows(rowsInputFor(evidence({ words: lines5().map((w) => ({ ...w, t: "ZFKMP" })) }), BOX)).error).toMatch(/no key column/);
  });
  it("KEY_LIKE_RE accepts printed keys and refuses prose and dimensions", () => {
    for (const k of ["1", "1.", "(a)", "A.", "K-01", "1.01", "2.3", "12)", "EF-10", "a)"]) expect(KEY_LIKE_RE.test(k), k).toBe(true);
    for (const k of ["ZFKMP", "3'-0\"", "1:50", "2.5MM", "NOTE", "08 71 00"]) expect(KEY_LIKE_RE.test(k), k).toBe(false);
  });
  it("on the wrapped-hanging notes fixture the key column holds every numbered note", () => {
    const s = loadSlices(join(__dirname, "../__fixtures__"), ".synthetic.json").find((x) => x.id === "syn-notes-wrapped-hanging")!;
    const h = hangingIndentRows(rowsInputFor(evidenceFromFixture(s), s.region));
    expect(h.error).toBeUndefined();
    expect(h.rowLines!.length - 1).toBeGreaterThanOrEqual(3);
    expect(h.conf).toBeGreaterThanOrEqual(0.74); // ≥ 60 % key-like starts
  });
});

describe("shapes (R10) and the shape-centres method", () => {
  it("the engine's tag classes equal the classifier's", () => {
    expect([...ENGINE_COLUMN_SHAPE_LABELS].sort()).toEqual([...COLUMN_SHAPE_LABELS].sort());
  });
  it("fuseShapes: yolo/classical twins at IoU ≥ .5 are one shape (yolo's box, the twin's crop read), doubles collapse, oversized rectangles and out-of-box shapes are dropped", () => {
    const y = shape(0.2);
    const twin = shape(0.2005, 0.1205, 0.0158, "circle", "classical", "7");
    const double = shape(0.2, 0.12, 0.016, "arch_sheet_circle");
    const lone = shape(0.3, 0.12, 0.016, "hexagon", "classical", "8");
    const bigRect = shape(0.4, 0.3, 0.05, "rectangle");
    const outside = shape(0.8);
    const fused = fuseShapes([y, twin, double, lone, bigRect, outside], BOX);
    expect(fused.map((s) => [s.cls, s.src, s.both, s.text])).toEqual([["circle", "yolo", true, "7"], ["hexagon", "classical", false, "8"]]);
    expect(fused[0].b).toEqual(y.b);
    expect(fused[0].textSrc).toBe("crop");
  });
  it("fusedShapeColumn picks the largest x-aligned cluster anywhere in the box; shapeRegimeHolds needs 3 shapes covering 60 % of the body lines", () => {
    const col = [0.2, 0.25, 0.3, 0.35].map((c) => shape(c, 0.42));
    const stray = [shape(0.22, 0.15), shape(0.27, 0.5)];
    const fc = fusedShapeColumn(fuseShapes([...col, ...stray], BOX))!;
    expect(fc.shapes).toHaveLength(4);
    expect(fc.shapeClass).toBe("circle");
    expect(fc.pitch).toBeCloseTo(0.05, 9);
    expect(fc.gapCv).toBeCloseTo(0, 9);
    expect([fc.x0, fc.x1].map(r6)).toEqual([0.412, 0.428]);
    expect(fusedShapeColumn(fuseShapes(col.slice(0, 2), BOX))).toBeNull();
    const body = rowsInputFor(evidence({ words: [0.19, 0.2, 0.21, 0.25, 0.3, 0.35].map((y) => word("ZFKMP", 0.45, y)) }), BOX);
    expect(shapeRegimeHolds(fc, body, null)).toBe(true);
    expect(shapeRegimeHolds(fc, body, 0.5)).toBe(false); // every line is header: no body
    const tall = rowsInputFor(evidence({ words: [...body.words, ...[0.42, 0.45, 0.48, 0.51, 0.54].map((y) => word("ZFKMP", 0.45, y))] }), BOX);
    expect(shapeRegimeHolds(fc, tall, null)).toBe(false); // 6 of 11 covered = 55 % (the lines far below are past the gap stop)
    expect(shapeRegimeHolds(null, body, null)).toBe(false);
  });
  it("shapeCentreRows: keys inside the shapes, a crop read flagged, an anchor row flagged `anchor`; bands follow the v1 midpoint rule", () => {
    const words = [word("D-101", 0.112, 0.2), word("D-103", 0.112, 0.3), ...[0.2, 0.25, 0.3].flatMap((y) => [word("ZFKMP", 0.2, y)])];
    const shapes = [shape(0.2), shape(0.25, 0.12, 0.016, "circle", "classical", "D-102"), shape(0.3)];
    const input = rowsInputFor(evidence({ words, shapes }), BOX);
    const col = fusedShapeColumn(fuseShapes(input.shapes, BOX))!;
    const out = shapeCentreRows(input, col, [{ b: [0.112, 0.342, 0.128, 0.358], tag: "D-104", shapeClass: "circle", proposalId: "p" }])!;
    expect(out.rows.map((r) => (r.key?.kind === "shape-text" ? r.key.text : null))).toEqual(["D-101", "D-102", "D-103", "D-104"]);
    expect(out.rows[1].flags).toContain("key-from-crop");
    expect(out.rows[3].flags).toEqual(["anchor"]);
    expect(out.rows.map((r) => [r6(r.y0), r6(r.y1)])).toEqual([[0.175, 0.225], [0.225, 0.275], [0.275, 0.325], [0.325, 0.375]]);
    expect(out.hypothesis.method).toBe("shape-centres");
    expect(out.hypothesis.rowLines!.map(r6)).toEqual([0.175, 0.225, 0.275, 0.325, 0.375]);
    expect(out.hypothesis.rowAnchors).toHaveLength(4);
  });
});

describe("anchor-prior (R6)", () => {
  const anchors = [0.2, 0.25, 0.3].map((c, i) => ({ b: shape(c).b, tag: `D-10${i + 1}` }));
  it("the hinted proposal wins, else the best IoU ≥ .5; anchors with a live shape or outside the box are dropped; rowBbox is never read", () => {
    const p1 = proposalWithAnchors("p1", BOX, anchors);
    const p2 = proposalWithAnchors("p2", [0.1, 0.1, 0.59, 0.59], anchors.slice(0, 1));
    const far = proposalWithAnchors("p3", [0.7, 0.7, 0.9, 0.9], anchors);
    const ev = evidence({ words: [], proposals: [far, p2, p1] });
    expect(owningProposal(rowsInputFor(ev, BOX, { proposalId: "p2" }))?.id).toBe("p2");
    expect(owningProposal(rowsInputFor(ev, BOX))?.id).toBe("p1");
    expect(owningProposal(rowsInputFor(evidence({ words: [], proposals: [far] }), BOX))).toBeNull();
    const live = fuseShapes([shape(0.2)], BOX);
    const out = anchorCentres(rowsInputFor(ev, BOX), live);
    expect(out.map((a) => a.tag)).toEqual(["D-102", "D-103"]);
    expect(out[0].proposalId).toBe("p1");
    const outsideBox = anchorCentres(rowsInputFor(evidence({ words: [], proposals: [proposalWithAnchors("q", BOX, [{ b: [0.7, 0.7, 0.72, 0.72], tag: "Z" }])] }), BOX), []);
    expect(outsideBox).toEqual([]);
  });
});
