// [tag-mapping v2 2026-10-24] The owner's text rules on free-floating word hits.
import { describe, expect, it } from "vitest";
import type { TextractWord } from "@/types";
import { DEFAULT_TAG_RULES, verdictForWordHit } from "../tag-rules";
import { isTagLike, looksLikeDimension, isSheetNumber, sheetKeySet } from "@/lib/shape-ensemble";
import type { EnsembleShape } from "@/lib/shape-ensemble";

const H = 0.01;
const w = (text: string, x: number, y = 0.5, width = 0.02): TextractWord => ({ text, confidence: 99, bbox: [x, y, width, H] });
const ctx = { rules: DEFAULT_TAG_RULES };
const shape = (bbox: [number, number, number, number], kind: EnsembleShape["kind"] = "tag", callout?: EnsembleShape["callout"]): EnsembleShape => ({
  id: "s", bbox, cls: "circle", source: "yolo", confidence: 0.9, kind, text: "A", textSource: "textract", cropText: null, textractText: "A",
  zone: "drawing", longSide: bbox[2] - bbox[0], yoloAnnotationId: 1, classicalAnnotationId: null, modelName: "yolo_primitive", ...(callout ? { callout } : {}),
});

describe("rule 3 — dimensions are never tags", () => {
  it.each(["8'-0\"", "12\"", "3'", "450MM", "2.4M", "1/2", "2-1/2"])("%s is a dimension", (t) => expect(looksLikeDimension(t)).toBe(true));
  it.each(["D-101", "8", "A1", "W"])("%s is not", (t) => expect(looksLikeDimension(t)).toBe(false));
  it("a number glued to a quote mark on the line is a dimension", () => {
    const words = [w("8", 0.1), w("'-0\"", 0.1 + 0.02 + H * 0.1)];
    expect(verdictForWordHit([words[0]], words, "8", ctx)).toBe("dimension");
  });
});

describe("rule 4 — keep full strings", () => {
  it("'1' split off 'D-1' by Textract (glued neighbour) is a partial token; the same word with a space is fine", () => {
    const glued = [w("D-", 0.1), w("1", 0.1 + 0.02 + H * 0.1)];
    expect(verdictForWordHit([glued[1]], glued, "1", ctx)).toBe("partial_token");
    const spaced = [w("D-", 0.1), w("101", 0.1 + 0.02 + H * 0.8)];
    expect(verdictForWordHit([spaced[1]], spaced, "101", ctx)).toBe("ok");
  });
  it("a word from another line never glues", () => {
    const words = [w("D-", 0.1, 0.52), w("1", 0.1 + 0.02 + H * 0.1, 0.5)];
    expect(verdictForWordHit([words[1]], words, "1", ctx)).toBe("ok");
  });
});

describe("rule 2 — 1–2-character tags count only inside a shape or standing alone", () => {
  const sentence = [w("PROVIDE", 0.1, 0.5, 0.05), w("A", 0.1 + 0.05 + H * 0.8, 0.5, 0.008), w("SOLUTION", 0.1 + 0.05 + H * 0.8 + 0.008 + H * 0.8, 0.5, 0.05)];
  it("'A' inside a sentence is rejected", () => {
    expect(verdictForWordHit([sentence[1]], sentence, "A", ctx)).toBe("in_sentence");
  });
  it("'A' standing alone (nothing within 1.5 heights) is accepted", () => {
    const alone = [w("A", 0.3, 0.5, 0.008), w("NOTES", 0.6, 0.5, 0.05)];
    expect(verdictForWordHit([alone[0]], alone, "A", ctx)).toBe("ok");
  });
  it("'A' inside a tag shape is accepted even inside a sentence", () => {
    const [, a] = sentence;
    const bubble = shape([a.bbox[0] - 0.002, a.bbox[1] - 0.002, a.bbox[0] + a.bbox[2] + 0.002, a.bbox[1] + a.bbox[3] + 0.002]);
    expect(verdictForWordHit([a], sentence, "A", { ...ctx, shapes: [bubble] })).toBe("ok");
  });
  it("a 3+ character tag in a sentence is not short and passes (with normal spacing)", () => {
    const words = [w("DOOR", 0.1, 0.5, 0.03), w("D-101", 0.1 + 0.03 + H * 0.8, 0.5, 0.03), w("TYP", 0.1 + 0.03 + H * 0.8 + 0.03 + H * 0.8, 0.5, 0.02)];
    expect(verdictForWordHit([words[1]], words, "D-101", ctx)).toBe("ok");
  });
});

describe("rule 1 — detail callouts are detail titles", () => {
  const words = [w("3", 0.3, 0.3, 0.008), w("R-3", 0.3, 0.312, 0.012)];
  const callout = shape([0.29, 0.29, 0.32, 0.33], "detail_callout", { detail: "3", sheet: "R-3" });
  it("the '3' inside a callout bubble is not tag 3", () => {
    expect(verdictForWordHit([words[0]], words, "3", { ...ctx, shapes: [callout] })).toBe("detail_callout");
  });
  it("…but when the tag searched IS the sheet number, the callout is a hit", () => {
    expect(verdictForWordHit([words[1]], words, "R-3", { ...ctx, shapes: [callout], tagIsSheetNumber: true })).toBe("ok");
  });
  it("fix round 1: the '3' inside a detail TITLE bubble is not tag 3, nor is a word inside a legend key", () => {
    const title = [w("3", 0.3, 0.3, 0.008), w("ADMIN", 0.32, 0.3, 0.03), w("SUITE", 0.355, 0.3, 0.03), w("SCALE:", 0.39, 0.3, 0.03)];
    const bubble = shape([0.29, 0.29, 0.31, 0.31], "detail_title");
    expect(verdictForWordHit([title[0]], title, "3", { ...ctx, shapes: [bubble] })).toBe("detail_title");
    const key = shape([0.29, 0.29, 0.31, 0.31], "legend_key");
    expect(verdictForWordHit([title[0]], title, "3", { ...ctx, shapes: [key] })).toBe("legend_key");
    // a tag bubble whose box also lies inside a detail title's box: the non-tag kind decides
    expect(verdictForWordHit([title[0]], title, "3", { ...ctx, shapes: [shape([0.295, 0.295, 0.309, 0.309]), bubble] })).toBe("detail_title");
  });
  it("sheet-number guard compares modulo separators", () => {
    const sheets = sheetKeySet(["A-101.00", "R-3"]);
    expect(isSheetNumber("A101.00", sheets)).toBe(true);
    expect(isSheetNumber("r3", sheets)).toBe(true);
    expect(isSheetNumber("A-102", sheets)).toBe(false);
  });
});

describe("legacy behaviour", () => {
  it("without rules the matcher accepts everything (verdict helper is only consulted with a context)", () => {
    expect(isTagLike("D-101")).toBe(true);
    expect(isTagLike("OF")).toBe(false);
    expect(isTagLike("PROVIDE")).toBe(false);
  });
});
