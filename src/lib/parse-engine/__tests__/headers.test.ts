// @vitest-environment node
// [table pipeline WP-3.B] Header rows (keyword / caps / COLUMN_HEADER flags / title skip / tiers), group
// spans from geometry, labels with dedupe (K06) and roles. Synthetic labels only.
import { describe, expect, it } from "vitest";
import { detectHeaderRows, headerLabels, headerSpansFromWords, isCapsHeaderRow, looksLikeHeaderKeyword, roleOfLabel, uniqueHeaders } from "@/lib/parse-engine/headers";
import { uniqueHeaders as reexported } from "@/lib/table-headers";
import type { ColWord } from "@/lib/parse-engine/cells";
import type { BboxMinMax } from "@/lib/parse-engine/types";

describe("detectHeaderRows", () => {
  it("keyword rule: the best keyword row in the scan window (ocr-positions pass 1)", () => {
    const rows = [["ZZQ", "", ""], ["MARK", "DESCRIPTION", "QTY"], ["D1", "XX", "2"], ["D2", "YY", "3"]];
    expect(detectHeaderRows({ rows })).toEqual({ start: 1, count: 1, src: "keyword", conf: 0.8 });
  });

  it("widens up over a group tier and down over a wrapped label, never over a title or a digit row", () => {
    const rows = [
      ["DOOR SCHEDULE", "", "", ""], // title: one cell on a 4-column grid
      ["", "DOOR", "", "FRAME"], // group tier (keywords)
      ["MARK", "TYPE", "MATERIAL", "TYPE"], // the best keyword row
      ["", "", "", "RATING"], // a label wrapped onto a second line (keyword, no digits)
      ["D1", "A", "WD", "B"],
    ];
    expect(detectHeaderRows({ rows })).toEqual({ start: 1, count: 3, src: "keyword", conf: 0.8 });
  });

  it("COLUMN_HEADER flags win over keywords; a hint wins over both", () => {
    const rows = [["A", "B"], ["MARK", "TYPE"], ["1", "2"]];
    expect(detectHeaderRows({ rows, flags: [true, false, false] })).toEqual({ start: 0, count: 1, src: "flags", conf: 0.9 });
    expect(detectHeaderRows({ rows, flags: [true, true, false], hint: 0 })).toEqual({ start: 0, count: 0, src: "hint", conf: 1 });
  });

  it("caps fallback (ocr-positions pass 2), and the title band is skipped", () => {
    const rows = [["ABBR", "MEANING"], ["AFF", "ABOVE FIN GRADE"], ["1A", "x"]];
    expect(detectHeaderRows({ rows })).toEqual({ start: 0, count: 1, src: "caps", conf: 0.5 });
    expect(detectHeaderRows({ rows, skip: 1 })).toEqual({ start: 1, count: 1, src: "caps", conf: 0.5 });
  });

  it("no header", () => {
    expect(detectHeaderRows({ rows: [["1", "a"], ["2", "b"]] })).toEqual({ start: 0, count: 0, src: "none", conf: 0 });
  });

  it("the keyword and caps predicates keep ocr-positions' rules", () => {
    expect(looksLikeHeaderKeyword("HDW SET")).toBe(true);
    expect(looksLikeHeaderKeyword("Mark:")).toBe(true);
    expect(looksLikeHeaderKeyword("WOOD")).toBe(false);
    expect(isCapsHeaderRow(["ABC", "DEF"])).toBe(true);
    expect(isCapsHeaderRow(["ABC", "D1"])).toBe(false);
    expect(isCapsHeaderRow(["ABC"])).toBe(false);
    expect(isCapsHeaderRow(["ABC", "A VERY LONG LABEL TEXT"])).toBe(false);
  });
});

describe("headerSpansFromWords + headerLabels", () => {
  const w = (t: string, x0: number, x1: number, y0: number): ColWord => ({ t, b: [x0, y0, x1, y0 + 0.008] as BboxMinMax });
  const COLS = [0.1, 0.15, 0.25, 0.35, 0.45, 0.55];
  const TIERS = [0.1, 0.112, 0.124];

  it("two-tier DOOR / FRAME × TYPE / MATERIAL keeps four distinct labels with their groups (K06)", () => {
    // tier 0: DOOR set loose over columns 2-3, FRAME over columns 4-5 (each covers two column centres)
    const words = [w("DOOR", 0.18, 0.32, 0.102), w("FRAME", 0.38, 0.52, 0.102), w("MARK", 0.105, 0.14, 0.114), w("TYPE", 0.16, 0.2, 0.114),
      w("MATERIAL", 0.26, 0.33, 0.114), w("TYPE", 0.36, 0.4, 0.114), w("MATERIAL", 0.46, 0.53, 0.114)];
    const spans = headerSpansFromWords(words, TIERS, COLS);
    expect(spans).toEqual([{ r: 0, c: 1, rs: 1, cs: 2 }, { r: 0, c: 3, rs: 1, cs: 2 }]);
    const tiers = [["", "DOOR", "", "FRAME", ""], ["MARK", "TYPE", "MATERIAL", "TYPE", "MATERIAL"]];
    const labels = headerLabels({ tiers, spans });
    expect(labels.map((l) => l.label)).toEqual(["MARK", "DOOR TYPE", "DOOR MATERIAL", "FRAME TYPE", "FRAME MATERIAL"]);
    expect(labels.map((l) => l.group ?? null)).toEqual([null, "DOOR", "DOOR", "FRAME", "FRAME"]);
    expect(labels.map((l) => l.role ?? null)).toEqual(["tag", "type", "material", "type", "material"]);
  });

  it("without spans, identical labels are deduped and blanks get Column n", () => {
    const labels = headerLabels({ tiers: [["TYPE", "", "TYPE"]] });
    expect(labels.map((l) => l.label)).toEqual(["TYPE", "Column 2", "TYPE (2)"]);
    expect(labels.map((l) => l.labelRaw)).toEqual(["TYPE", "", "TYPE"]);
  });

  it("a vertically merged header reads once", () => {
    const labels = headerLabels({ tiers: [["MARK", "SIZE"], ["", "W"]], spans: [{ r: 0, c: 0, rs: 2, cs: 1 }] });
    expect(labels.map((l) => l.label)).toEqual(["MARK", "SIZE W"]);
  });

  it("the last tier never spans", () => {
    expect(headerSpansFromWords([w("WIDE LABEL", 0.11, 0.4, 0.114)], TIERS, COLS)).toEqual([]);
  });
});

describe("roleOfLabel", () => {
  it("qty before tag (\"NO. REQ'D\" is a quantity)", () => {
    expect(roleOfLabel("NO. REQ'D")).toBe("qty");
    expect(roleOfLabel("DOOR NO.")).toBe("tag");
    expect(roleOfLabel("REMARKS")).toBe("remarks");
    expect(roleOfLabel("DESCRIPTION")).toBe("description");
    expect(roleOfLabel("WIDTH")).toBe("size");
    expect(roleOfLabel("FINISH")).toBe("material");
    expect(roleOfLabel("WOOD")).toBeUndefined();
    expect(roleOfLabel("")).toBeUndefined();
  });
});

describe("uniqueHeaders moved into the engine", () => {
  it("lib/table-headers re-exports the same function", () => {
    expect(reexported).toBe(uniqueHeaders);
    expect(uniqueHeaders(["X", "X", "X (2)"])).toEqual(["X", "X (3)", "X (2)"]);
  });
});
