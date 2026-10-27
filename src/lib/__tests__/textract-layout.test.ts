// @vitest-environment node
// [table pipeline WP-2.E, K17] parseTextractResponse keeps, compactly and with no text, the LAYOUT
// blocks, the COLUMN_HEADER flags and the MERGED_CELL spans that AnalyzeDocument already returns,
// and leaves every pre-existing field (words, lines, tables' cells / counts) exactly as before.
// The AnalyzeDocument response below is SYNTHETIC (rule 12): invented words, invented geometry.
import type { Block } from "@aws-sdk/client-textract";
import { describe, expect, it } from "vitest";
import { parseTextractResponse } from "@/lib/textract";
import { zTextractLayoutBlock } from "@/types/shapes";

const box = (Left: number, Top: number, Width: number, Height: number) => ({ Geometry: { BoundingBox: { Left, Top, Width, Height } } });

function syntheticResponse(): Block[] {
  const words: Block[] = [
    { Id: "w1", BlockType: "WORD", Text: "QXMARK", Confidence: 99, ...box(0.1, 0.1, 0.05, 0.01) },
    { Id: "w2", BlockType: "WORD", Text: "LOREM", Confidence: 98, ...box(0.2, 0.1, 0.05, 0.01) },
    { Id: "w3", BlockType: "WORD", Text: "QX-1", Confidence: 97, ...box(0.1, 0.12, 0.04, 0.01) },
    { Id: "w4", BlockType: "WORD", Text: "IPSUM", Confidence: 96, ...box(0.2, 0.12, 0.05, 0.01) },
    { Id: "w5", BlockType: "WORD", Text: "DOLOR", Confidence: 95, ...box(0.1, 0.3, 0.06, 0.01) },
  ];
  const lines: Block[] = [
    { Id: "l1", BlockType: "LINE", Text: "QXMARK LOREM", Confidence: 98, ...box(0.1, 0.1, 0.15, 0.01), Relationships: [{ Type: "CHILD", Ids: ["w1", "w2"] }] },
    { Id: "l2", BlockType: "LINE", Text: "QX-1 IPSUM", Confidence: 96, ...box(0.1, 0.12, 0.15, 0.01), Relationships: [{ Type: "CHILD", Ids: ["w3", "w4"] }] },
    { Id: "l3", BlockType: "LINE", Text: "DOLOR", Confidence: 95, ...box(0.1, 0.3, 0.06, 0.01), Relationships: [{ Type: "CHILD", Ids: ["w5"] }] },
  ];
  const cells: Block[] = [
    { Id: "c11", BlockType: "CELL", RowIndex: 1, ColumnIndex: 1, RowSpan: 1, ColumnSpan: 1, Confidence: 90, EntityTypes: ["COLUMN_HEADER"], ...box(0.1, 0.1, 0.1, 0.02), Relationships: [{ Type: "CHILD", Ids: ["w1"] }] },
    { Id: "c12", BlockType: "CELL", RowIndex: 1, ColumnIndex: 2, RowSpan: 1, ColumnSpan: 1, Confidence: 90, EntityTypes: ["COLUMN_HEADER"], ...box(0.2, 0.1, 0.1, 0.02), Relationships: [{ Type: "CHILD", Ids: ["w2"] }] },
    { Id: "c21", BlockType: "CELL", RowIndex: 2, ColumnIndex: 1, RowSpan: 1, ColumnSpan: 1, Confidence: 80, ...box(0.1, 0.12, 0.1, 0.02), Relationships: [{ Type: "CHILD", Ids: ["w3"] }] },
    { Id: "c22", BlockType: "CELL", RowIndex: 2, ColumnIndex: 2, RowSpan: 1, ColumnSpan: 1, Confidence: 80, ...box(0.2, 0.12, 0.1, 0.02), Relationships: [{ Type: "CHILD", Ids: ["w4"] }] },
    { Id: "c31", BlockType: "CELL", RowIndex: 3, ColumnIndex: 1, RowSpan: 1, ColumnSpan: 1, Confidence: 70, ...box(0.1, 0.14, 0.1, 0.02) },
    { Id: "c32", BlockType: "CELL", RowIndex: 3, ColumnIndex: 2, RowSpan: 1, ColumnSpan: 1, Confidence: 70, ...box(0.2, 0.14, 0.1, 0.02) },
  ];
  const merged: Block = { Id: "m1", BlockType: "MERGED_CELL", RowIndex: 3, ColumnIndex: 1, RowSpan: 1, ColumnSpan: 2, ...box(0.1, 0.14, 0.2, 0.02), Relationships: [{ Type: "CHILD", Ids: ["c31", "c32"] }] };
  const table: Block = {
    Id: "t1", BlockType: "TABLE", ...box(0.1, 0.1, 0.2, 0.06),
    Relationships: [{ Type: "CHILD", Ids: cells.map((c) => c.Id!) }, { Type: "MERGED_CELL", Ids: ["m1"] }],
  };
  const layout: Block[] = [
    { Id: "y1", BlockType: "LAYOUT_TITLE", Text: "", ...box(0.1, 0.05, 0.3, 0.02), Relationships: [{ Type: "CHILD", Ids: ["l1"] }] },
    { Id: "y2", BlockType: "LAYOUT_TABLE", ...box(0.1, 0.1, 0.2, 0.06) },
    { Id: "y3", BlockType: "LAYOUT_SECTION_HEADER", ...box(0.1, 0.28, 0.12345678, 0.0123456) },
    { Id: "y4", BlockType: "LAYOUT_LIST", ...box(0.1, 0.3, 0.2, 0.1) },
    { Id: "y5", BlockType: "LAYOUT_TEXT", ...box(0.1, 0.31, 0.2, 0.02), Relationships: [{ Type: "CHILD", Ids: ["l3"] }] },
    { Id: "y6", BlockType: "LAYOUT_PAGE_NUMBER", ...box(0.9, 0.95, 0.02, 0.01) },
    { Id: "y7", BlockType: "LAYOUT_FIGURE", ...box(0.5, 0.5, 0.3, 0.3) },
  ];
  return [{ Id: "page", BlockType: "PAGE", ...box(0, 0, 1, 1) }, ...layout, ...lines, ...words, table, ...cells, merged];
}

/** The same response as an account without LAYOUT, header entity types or merged cells would return it. */
function withoutExtras(blocks: Block[]): Block[] {
  return blocks
    .filter((b) => !b.BlockType?.startsWith("LAYOUT_") && b.BlockType !== "MERGED_CELL")
    .map((b) => {
      const { EntityTypes: _e, ...rest } = b;
      return b.BlockType === "TABLE" ? { ...rest, Relationships: rest.Relationships?.filter((r) => r.Type !== "MERGED_CELL") } : rest;
    });
}

describe("parseTextractResponse — compact LAYOUT, header flags, merged cells (WP-2.E)", () => {
  const out = parseTextractResponse(syntheticResponse());

  it("keeps the five engine LAYOUT kinds as {k, b} MinMax rounded to 4 dp, with no text; drops the rest", () => {
    expect(out.layout).toEqual([
      { k: "title", b: [0.1, 0.05, 0.4, 0.07] },
      { k: "table", b: [0.1, 0.1, 0.3, 0.16] },
      { k: "section-header", b: [0.1, 0.28, 0.2235, 0.2923] },
      { k: "list", b: [0.1, 0.3, 0.3, 0.4] },
      { k: "text", b: [0.1, 0.31, 0.3, 0.33] },
    ]);
    for (const l of out.layout!) {
      expect(Object.keys(l).sort()).toEqual(["b", "k"]);
      expect(zTextractLayoutBlock.safeParse(l).success).toBe(true);
    }
  });

  it("flags COLUMN_HEADER cells with hdr:true and only those", () => {
    const cells = out.tables![0].cells;
    expect(cells.filter((c) => c.hdr).map((c) => [c.row, c.col])).toEqual([[1, 1], [1, 2]]);
    expect(cells.filter((c) => c.row > 1).every((c) => !("hdr" in c))).toBe(true);
  });

  it("records MERGED_CELL spans per table (1-based, as Textract numbers cells)", () => {
    expect(out.tables![0].merged).toEqual([{ r: 3, c: 1, rs: 1, cs: 2 }]);
  });

  it("leaves words, lines and every pre-existing table field byte-identical", () => {
    const legacy = parseTextractResponse(withoutExtras(syntheticResponse()));
    expect(legacy.layout).toBeUndefined();
    expect(legacy.tables![0].merged).toBeUndefined();
    const { layout: _l, ...rest } = out;
    const stripped = { ...rest, tables: rest.tables!.map(({ merged: _m, ...t }) => ({ ...t, cells: t.cells.map(({ hdr: _h, ...c }) => c) })) };
    expect(JSON.stringify(stripped)).toBe(JSON.stringify(legacy));
  });

  it("a response with no LAYOUT blocks adds no layout key (Tesseract / old responses unchanged)", () => {
    const words = syntheticResponse().filter((b) => b.BlockType === "WORD" || b.BlockType === "LINE");
    expect(Object.keys(parseTextractResponse(words)).sort()).toEqual(["lines", "words"]);
  });

  it("the compact layout is small: well under the word list it sits beside", () => {
    expect(JSON.stringify(out.layout).length).toBeLessThan(JSON.stringify(out.words).length);
  });
});
