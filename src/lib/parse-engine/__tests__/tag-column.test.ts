// @vitest-environment node
// [table pipeline WP-3.B, R9] The tag column is looked for in EVERY column (not only the left quarter):
// user ≻ shape ≻ header (body-arbitrated) ≻ body. Synthetic values only.
import { describe, expect, it } from "vitest";
import { pickTagColumn, tagValueScore } from "@/lib/parse-engine/tag-column";
import type { BboxMinMax } from "@/lib/parse-engine/types";

const cols = (labels: string[]) => labels.map((label, i) => ({ x0: 0.1 + i * 0.1, x1: 0.2 + i * 0.1, label }));
const BODY = [
  ["1", "ZQ PANEL", "EF-1", "2"],
  ["2", "QX PANEL", "EF-2", "1"],
  ["3", "XQ PANEL", "EF-3", "4"],
  ["4", "QQ PANEL", "EF-10", "1"],
];

describe("tagValueScore", () => {
  it("letters+digits 1, letters .8, digits .35, else 0 (dimensions, long words, stop list)", () => {
    expect(tagValueScore("EF-10")).toBe(1);
    expect(tagValueScore("A-101")).toBe(1);
    expect(tagValueScore("CL")).toBe(0.8);
    expect(tagValueScore("12")).toBe(0.35);
    expect(tagValueScore(`3'-0"`)).toBe(0);
    expect(tagValueScore("TYP")).toBe(0);
    expect(tagValueScore("NO")).toBe(0);
    expect(tagValueScore("DESCRIPTION")).toBe(0);
    expect(tagValueScore("(K-01)")).toBe(1);
  });

  it("room-number door marks (digits + a 1-2 letter suffix) score .9 (VERIFY MED-1)", () => {
    expect(tagValueScore("101A")).toBe(0.9);
    expect(tagValueScore("1B")).toBe(0.9);
    expect(tagValueScore("2104AB")).toBe(0.9);
    expect(tagValueScore("101")).toBe(0.35);
    expect(tagValueScore("101ABC")).toBe(0);
  });
});

describe("pickTagColumn (R9)", () => {
  it("finds a NON-LEFT tag column from the body when no header names one", () => {
    const pick = pickTagColumn({ kind: "schedule", cols: cols(["Column 1", "DESCRIPTION", "Column 3", "QTY"]), body: BODY });
    expect(pick).toMatchObject({ col: 2, src: "body", score: 1, scope: "project" });
    expect(pick?.pattern).toBeTypeOf("string");
  });

  it("a header nomination is arbitrated by the body: MARK (tags) beats NO. (row numbers)", () => {
    const pick = pickTagColumn({ kind: "schedule", cols: cols(["NO.", "DESCRIPTION", "MARK", "QTY"]), body: BODY });
    expect(pick).toMatchObject({ col: 2, src: "header" });
  });

  it("a lone header nomination with row numbers still holds (score ≥ .35)", () => {
    const pick = pickTagColumn({ kind: "keynote", cols: cols(["NO.", "DESCRIPTION"]), body: BODY.map((r) => r.slice(0, 2)) });
    expect(pick).toMatchObject({ col: 0, src: "header", score: 0.35, scope: "sheet" });
  });

  it("shapes in a middle column win over header and body", () => {
    const bands: [number, number][] = BODY.map((_, i) => [0.3 + i * 0.02, 0.32 + i * 0.02]);
    const shapes = bands.map(([y0, y1]): { b: BboxMinMax; cls: string } => ({ b: [0.32, y0 + 0.002, 0.38, y1 - 0.002], cls: "hexagon" }));
    const pick = pickTagColumn({ kind: "legend", cols: cols(["MARK", "DESCRIPTION", "SYMBOL", "QTY"]), body: BODY, bodyBands: bands, shapes });
    expect(pick).toMatchObject({ col: 2, src: "shape", shapeClass: "hexagon", scope: "sheet" });
  });

  it("too few shape rows fall through to the header rule", () => {
    const bands: [number, number][] = BODY.map((_, i) => [0.3 + i * 0.02, 0.32 + i * 0.02]);
    const shapes = [{ b: [0.12, 0.301, 0.18, 0.319] as BboxMinMax, cls: "circle" }];
    expect(pickTagColumn({ kind: "schedule", cols: cols(["NO.", "DESCRIPTION", "MARK", "QTY"]), body: BODY, bodyBands: bands, shapes })?.src).toBe("header");
  });

  it("the user's column wins; out of range is ignored", () => {
    expect(pickTagColumn({ kind: "schedule", cols: cols(["A", "B", "C", "D"]), body: BODY, user: 1 })).toMatchObject({ col: 1, src: "user" });
    expect(pickTagColumn({ kind: "schedule", cols: cols(["A", "B", "C", "D"]), body: BODY, user: 9 })?.src).toBe("body");
  });

  it("a MARK column of room-number marks is the tag column (VERIFY MED-1: it was null)", () => {
    const body = [["101", "Q PANEL"], ["101A", "Q PANEL"], ["102", "X PANEL"], ["102A", "X PANEL"], ["103", "Z PANEL"]];
    expect(pickTagColumn({ kind: "schedule", cols: cols(["MARK", "DESCRIPTION"]), body })).toMatchObject({ col: 0, src: "header", score: 0.57 });
    // no header naming it: the body rule (≥ .5) finds it too
    expect(pickTagColumn({ kind: "schedule", cols: cols(["Column 1", "DESCRIPTION"]), body })).toMatchObject({ col: 0, src: "body" });
  });

  it("a tag-named column with a filled, distinct body holds even when its values do not read as tags; a body tag column beats it", () => {
    const body = [["1-A", "Q PANEL", "x"], ["1-B", "Q PANEL", "x"], ["2-A", "X PANEL", "x"], ["2-B", "X PANEL", "x"]];
    expect(pickTagColumn({ kind: "schedule", cols: cols(["MARK", "DESCRIPTION", "C"]), body })).toMatchObject({ col: 0, src: "header", score: 0 });
    const withTags = body.map((r, i) => [r[0], r[1], `EF-${i + 1}`]);
    expect(pickTagColumn({ kind: "schedule", cols: cols(["MARK", "DESCRIPTION", "C"]), body: withTags })).toMatchObject({ col: 2, src: "body" });
    // a tag-named column that repeats its values is not one
    const repeated = body.map((r) => ["SAME", r[1], r[2]]);
    expect(pickTagColumn({ kind: "schedule", cols: cols(["MARK", "DESCRIPTION", "C"]), body: repeated })).toBeNull();
  });

  it("null when no column reads as tags", () => {
    expect(pickTagColumn({ kind: "schedule", cols: cols(["A", "B"]), body: [["WOOD", "PAINT"], ["STEEL", "SEALER"]] })).toBeNull();
    expect(pickTagColumn({ kind: "schedule", cols: [], body: [] })).toBeNull();
  });
});
