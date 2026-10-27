// [shape-tags 2026-10-25] The shape-centre row builder: one row per column shape, continuation lines fold into
// the row above, the tag column reads the word inside the shape (else the crop read), the header comes from the
// words above the first band, the result merges through grid-merger as a 4th MethodResult, and a region without
// a column fails softly.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TextractWord } from "@/types";
import type { ColumnShape } from "@/lib/classifier-engine/shape-column";
import { mergeGrids } from "@/lib/grid-merger";
import { methodOcrPositions } from "@/lib/services/table-parse";
import { methodShapeRows, SHAPE_ROWS_METHOD } from "@/lib/services/table-rows-shapes";

const word = (text: string, x: number, y: number, h = 0.01): TextractWord => ({ text, confidence: 99, bbox: [x, y - h / 2, text.length * 0.006, h] });
const hex = (y: number, text?: string, source: ColumnShape["source"] = "yolo"): ColumnShape => ({ label: "hexagon", bbox: [0.11, y - 0.01, 0.13, y + 0.01], source, confidence: 0.8, ...(text ? { text } : {}) });
const REGION: [number, number, number, number] = [0.1, 0.1, 0.5, 0.4];
const ys = [0.16, 0.2, 0.24, 0.28];

function legend(): { words: TextractWord[]; shapes: ColumnShape[] } {
  const words = [word("SYM", 0.11, 0.125), word("DESCRIPTION", 0.2, 0.125), word("REMARKS", 0.4, 0.125)];
  const shapes: ColumnShape[] = [];
  ys.forEach((y, i) => {
    shapes.push(hex(y, undefined));
    words.push(word(`K${i + 1}`, 0.113, y), word("NEW", 0.2, y), word("WALL", 0.23, y), word("R", 0.4, y));
    if (i === 1) words.push(word("CONTINUED", 0.2, y + 0.012)); // a second description line without a shape
  });
  return { words, shapes };
}

describe("methodShapeRows", () => {
  it("builds one row per shape with the tag inside, folds the continuation line, names the columns from the header row", () => {
    const { words, shapes } = legend();
    const r = methodShapeRows(words, shapes, REGION);
    expect(r.method).toBe(SHAPE_ROWS_METHOD);
    expect(r.error).toBeUndefined();
    expect(r.headers).toEqual(["SYM", "DESCRIPTION", "REMARKS"]);
    expect(r.tagColumn).toBe("SYM");
    expect(r.rows).toHaveLength(4);
    expect(r.rows.map((row) => row.SYM)).toEqual(["K1", "K2", "K3", "K4"]);
    expect(r.rows[1].DESCRIPTION).toBe("NEW WALL CONTINUED");
    expect(r.rows[0].REMARKS).toBe("R");
    expect(r.confidence).toBe(0.6);
    expect(r.colBoundaries).toHaveLength(4);
    expect(r.rowBoundaries).toHaveLength(5);
    expect(r.rowBoundaries![0]).toBeLessThan(ys[0]);
    expect(r.debug?.intermediate).toMatchObject({ shapeCount: 4, regular: true, rowsWithTag: 4, headerRowDetected: true });
  });

  it("falls back to the classical crop read for the tag and to generic headers; an irregular column is weak", () => {
    const words = [word("ONE", 0.2, 0.16), word("TWO", 0.2, 0.2), word("THREE", 0.2, 0.33)];
    const shapes = [hex(0.16, "A", "classical"), hex(0.2, "B", "classical"), hex(0.33, "C", "classical")];
    const r = methodShapeRows(words, shapes, REGION);
    expect(r.headers).toEqual(["TAG", "Column 1"]);
    expect(r.rows.map((row) => [row.TAG, row["Column 1"]])).toEqual([["A", "ONE"], ["B", "TWO"], ["C", "THREE"]]);
    expect(r.confidence).toBe(0.35);
  });

  it("no column → soft failure with the reason; merges through grid-merger beside OCR positions AS THE BASE, keeping the folded row", () => {
    expect(methodShapeRows([], [], REGION)).toMatchObject({ method: SHAPE_ROWS_METHOD, confidence: 0, error: expect.stringContaining("no shape column") });
    const { words, shapes } = legend();
    const ocr = methodOcrPositions([...words], REGION);
    const shapeRows = methodShapeRows(words, shapes, REGION);
    const merged = mergeGrids([ocr, shapeRows]);
    expect(merged.methods.map((m) => m.name)).toContain(SHAPE_ROWS_METHOD);
    // [fix round] pinned: the regular column (confidence .6) is the merge base, so the continuation line stays folded
    expect(merged.mergerNotes?.baseMethod).toBe(SHAPE_ROWS_METHOD);
    expect(merged.rows).toHaveLength(4);
    expect(merged.rows[1].DESCRIPTION).toBe("NEW WALL CONTINUED");
    expect(merged.rows.map((r) => r.SYM)).toEqual(["K1", "K2", "K3", "K4"]);
  });

  it("[fix round] duplicate header texts stay separate columns", () => {
    const words = [word("SYM", 0.11, 0.125), word("QTY", 0.2, 0.125), word("QTY", 0.4, 0.125)];
    const shapes: ColumnShape[] = [];
    ys.forEach((y, i) => { shapes.push(hex(y)); words.push(word(`K${i + 1}`, 0.113, y), word(`${i}`, 0.2, y), word(`${i * 10}`, 0.4, y)); });
    const r = methodShapeRows(words, shapes, REGION);
    expect(r.headers).toEqual(["SYM", "QTY", "QTY (2)"]);
    expect(r.rows[3]).toEqual({ SYM: "K4", QTY: "3", "QTY (2)": "30" });
  });

  it("[WP-2.C fix round, MED-2] a note far below the last row, inside the region, does not join the last row", () => {
    const { words, shapes } = legend();
    const base = methodShapeRows(words, shapes, REGION);
    const r = methodShapeRows([...words, word("FOOTNOTE", 0.2, 0.38)], shapes, REGION);
    expect(r.rows[3]).toEqual(base.rows[3]);
    expect(r.rows[3].DESCRIPTION).toBe("NEW WALL");
    expect(r.rowBoundaries![4]).toBeLessThan(0.33);
    expect(r.rowBoundaries).toEqual(base.rowBoundaries);
  });

  it("[WP-2.C fix round, LOW-2] a cell's words are read in line order under a small y jitter (C02-F3)", () => {
    const words = [word("SYM", 0.11, 0.125), word("DESCRIPTION", 0.2, 0.125)];
    const shapes: ColumnShape[] = [];
    ys.forEach((y, i) => {
      shapes.push(hex(y));
      // the second word sits 0.003 higher than the first: an exact y-centre sort would read it first
      words.push(word(`K${i + 1}`, 0.113, y), word("ALPHA", 0.2, y + 0.0015), word("BETA", 0.234, y - 0.0015));
    });
    const r = methodShapeRows(words, shapes, REGION);
    expect(r.rows.map((row) => row.DESCRIPTION)).toEqual(ys.map(() => "ALPHA BETA"));
  });
});

// [table pipeline WP-2.C] K13 + C2-m4 on the synthetic shape fixtures (WP-2.0a): the parsed grid equals each
// fixture's hand-written truth (centred 3-line rows, a tall last row, classical crop keys that lost their dot,
// hexagon keys, centred keynotes), and the top-aligned keynote-bubble legend keeps every note whole.
describe("methodShapeRows on the synthetic shape fixtures (K13, C2-m4)", () => {
  const fixture = (id: string) => JSON.parse(readFileSync(join(__dirname, "../../parse-engine/__fixtures__", `${id}.synthetic.json`), "utf8"));
  for (const id of ["syn-sched-shapes-centred-3line", "syn-sched-shapes-tall-last", "syn-sched-shapes-classical-dotted", "syn-sched-shapes-hex", "syn-keynote-shapes"]) {
    it(`${id}: headers and rows equal the truth`, () => {
      const f = fixture(id);
      const r = methodShapeRows(f.page.words, f.shapes, f.region);
      expect(r.headers).toEqual(f.truth.headers);
      expect(r.rows.map((row) => r.headers.map((h) => row[h]))).toEqual(f.truth.rows);
    });
  }

  it("dotted keys survive the crop fallback, flagged in the debug counts", () => {
    const f = fixture("syn-sched-shapes-classical-dotted");
    const r = methodShapeRows(f.page.words, f.shapes, f.region);
    expect(r.debug?.intermediate).toMatchObject({ keyFromCrop: 2, keysRepaired: 2, bandAlign: "centre" });
  });

  it("the top-aligned keynote-bubble legend keeps each note's lines together", () => {
    const f = fixture("syn-notes-keynote-bubbles");
    const r = methodShapeRows(f.page.words, f.shapes, f.region);
    expect(r.debug?.intermediate).toMatchObject({ bandAlign: "top" });
    expect(r.rows.map((row) => r.headers.map((h) => row[h]))).toEqual(f.truth.items.map((it: { key: string; text: string }) => [it.key, it.text]));
  });
});
