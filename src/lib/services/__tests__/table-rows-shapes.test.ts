// [shape-tags 2026-10-25] The shape-centre row builder: one row per column shape, continuation lines fold into
// the row above, the tag column reads the word inside the shape (else the crop read), the header comes from the
// words above the first band, the result merges through grid-merger as a 4th MethodResult, and a region without
// a column fails softly.
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

  it("no column → soft failure with the reason; merges through grid-merger beside OCR positions", () => {
    expect(methodShapeRows([], [], REGION)).toMatchObject({ method: SHAPE_ROWS_METHOD, confidence: 0, error: expect.stringContaining("no shape column") });
    const { words, shapes } = legend();
    const ocr = methodOcrPositions([...words], REGION);
    const shapeRows = methodShapeRows(words, shapes, REGION);
    const merged = mergeGrids([ocr, shapeRows]);
    expect(merged.methods.map((m) => m.name)).toContain(SHAPE_ROWS_METHOD);
    expect(merged.rows.length).toBeGreaterThanOrEqual(4);
  });
});
