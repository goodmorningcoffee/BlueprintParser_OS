// @vitest-environment node
// [table pipeline WP-3.B, E-1] Cell assembly: text once, from page words, line-aware (K07); spans; the
// method-word exception; geometry-mapped spans. Synthetic words only.
import { describe, expect, it } from "vitest";
import { assembleCells, bandIndex, cellTextMatrix, normaliseSpans, spansFromBoxes, type ColWord } from "@/lib/parse-engine/cells";
import type { BboxMinMax } from "@/lib/parse-engine/types";

const w = (t: string, x0: number, y0: number, x1 = x0 + 0.02, y1 = y0 + 0.008): ColWord => ({ t, b: [x0, y0, x1, y1] as BboxMinMax });
const ROWS = [0.1, 0.12, 0.15, 0.17];
const COLS = [0.1, 0.2, 0.3, 0.4];
const RIDS = ["r1", "r2", "r3"];
const CIDS = ["c1", "c2", "c3"];

describe("bandIndex", () => {
  it("is half-open, closed on the last line, -1 outside", () => {
    expect(bandIndex(0.1, ROWS)).toBe(0);
    expect(bandIndex(0.12, ROWS)).toBe(1);
    expect(bandIndex(0.17, ROWS)).toBe(2);
    expect(bandIndex(0.0999, ROWS)).toBe(-1);
    expect(bandIndex(0.1701, ROWS)).toBe(-1);
    expect(bandIndex(Number.NaN, ROWS)).toBe(-1);
  });
});

describe("assembleCells", () => {
  it("reads a two-line cell line by line, not by x (K07), joined with a newline", () => {
    // line 1 "PAINTED METAL" over line 2 "HOLLOW FRAME"; x order alone would read PAINTED HOLLOW METAL FRAME
    const words = [w("METAL", 0.24, 0.121), w("PAINTED", 0.205, 0.1205), w("HOLLOW", 0.205, 0.131), w("FRAME", 0.235, 0.1312)];
    const cells = assembleCells({ rowLines: ROWS, colLines: COLS, rowIds: RIDS, colIds: CIDS, words, src: "x-starts" });
    expect(cells).toEqual([{ row: "r2", col: "c2", text: "PAINTED METAL\nHOLLOW FRAME", src: "x-starts", b: [0.205, 0.1205, 0.24 + 0.02, 0.1312 + 0.008] }]);
  });

  it("assigns by word centre, sparse output, row-major", () => {
    const words = [w("A", 0.11, 0.101), w("B", 0.31, 0.16), w("C", 0.21, 0.161), w("OUT", 0.5, 0.11)];
    const cells = assembleCells({ rowLines: ROWS, colLines: COLS, rowIds: RIDS, colIds: CIDS, words, src: "textract-cells", lineSep: " " });
    expect(cells.map((c) => [c.row, c.col, c.text])).toEqual([["r1", "c1", "A"], ["r3", "c2", "C"], ["r3", "c3", "B"]]);
    expect(cellTextMatrix(cells, RIDS, CIDS)).toEqual([["A", "", ""], ["", "", ""], ["", "C", "B"]]);
  });

  it("a span owns every band it covers; an empty anchor is kept", () => {
    const words = [w("GROUP", 0.25, 0.101), w("X", 0.12, 0.13)];
    const cells = assembleCells({
      rowLines: ROWS, colLines: COLS, rowIds: RIDS, colIds: CIDS, words, src: "x-starts",
      spans: [{ r: 0, c: 0, rs: 1, cs: 3 }, { r: 1, c: 1, rs: 2, cs: 2 }],
    });
    expect(cells).toEqual([
      { row: "r1", col: "c1", text: "GROUP", src: "x-starts", rs: 1, cs: 3, b: [0.25, 0.101, 0.25 + 0.02, 0.101 + 0.008] },
      { row: "r2", col: "c1", text: "X", src: "x-starts", b: [0.12, 0.13, 0.12 + 0.02, 0.13 + 0.008] },
      { row: "r2", col: "c2", text: "", src: "x-starts", rs: 2, cs: 2 },
    ]);
  });

  it("E-1 exception: a cell with no page words takes the method's crop words and names the method", () => {
    const cells = assembleCells({
      rowLines: ROWS, colLines: COLS, rowIds: RIDS, colIds: CIDS, words: [w("PAGE", 0.11, 0.101)], src: "rulings",
      methodWords: [{ method: "tatr", words: [w("CROP", 0.21, 0.101), w("IGNORED", 0.11, 0.102)] }],
    });
    expect(cells.map((c) => [c.col, c.text, c.src])).toEqual([["c1", "PAGE", "rulings"], ["c2", "CROP", "tatr"]]);
  });

  it("rejects a grid whose ids do not match its bands", () => {
    expect(assembleCells({ rowLines: ROWS, colLines: COLS, rowIds: ["r1"], colIds: CIDS, words: [w("A", 0.11, 0.101)], src: "x-starts" })).toEqual([]);
  });

  it("is deterministic and independent of word order (E-7)", () => {
    const words = [w("METAL", 0.24, 0.121), w("PAINTED", 0.205, 0.1205), w("HOLLOW", 0.205, 0.131), w("FRAME", 0.235, 0.1312), w("A", 0.11, 0.101)];
    const a = assembleCells({ rowLines: ROWS, colLines: COLS, rowIds: RIDS, colIds: CIDS, words, src: "x-starts" });
    const b = assembleCells({ rowLines: ROWS, colLines: COLS, rowIds: RIDS, colIds: CIDS, words: [...words].reverse(), src: "x-starts" });
    expect(b).toEqual(a);
  });
});

describe("spans", () => {
  it("maps merged boxes from another grid onto this one by band centres", () => {
    // a Textract MERGED box over columns 2-3 of row 1, and one over rows 2-3 of column 1
    expect(spansFromBoxes([[0.205, 0.101, 0.395, 0.118], [0.101, 0.121, 0.199, 0.169], [0.11, 0.1, 0.19, 0.11]], ROWS, COLS))
      .toEqual([{ r: 0, c: 1, rs: 1, cs: 2 }, { r: 1, c: 0, rs: 2, cs: 1 }]);
  });
  it("clips to the grid and drops overlapping or 1×1 spans (first wins)", () => {
    expect(normaliseSpans([{ r: 0, c: 0, rs: 9, cs: 2 }, { r: 1, c: 1, rs: 1, cs: 2 }, { r: 2, c: 2, rs: 1, cs: 1 }, { r: -1, c: 0, rs: 2, cs: 2 }], 3, 3))
      .toEqual([{ r: 0, c: 0, rs: 3, cs: 2 }]);
  });
});
