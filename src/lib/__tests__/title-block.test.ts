/**
 * title-block.test.ts — [zones T2] `extractDrawingNumber` with and without detector zones.
 *
 * Pins: the 2-arg call (upload path) and a fixed-fallback `zones` are byte-identical to the
 * legacy fixed-corner search; detector zones move the SEARCH to the detected title block, which
 * fixes the audit's "returns null when the fixed corner is empty even though YOLO found the title
 * block" (tools_audit §2.12d) and stops a cross-reference in the corner winning over the real
 * sheet number in a left/top title block.
 */
import { describe, it, expect } from "vitest";
import { extractDrawingNumber } from "@/lib/title-block";
import { computePageZones } from "@/lib/page-zones";
import type { TextractPageData, TextractWord } from "@/types";

const W = (text: string, x: number, y: number, w = 0.05, h = 0.02): TextractWord =>
  ({ text, confidence: 95, bbox: [x, y, w, h] });

const page = (words: TextractWord[]): TextractPageData => ({ words, lines: [] });

/** Title block along the TOP-LEFT (outside the fixed bottom-right corner). */
const TOP_LEFT_TITLE = [W("SHEET", 0.05, 0.05), W("NO.", 0.11, 0.05, 0.03), W("A-201", 0.15, 0.05)];
/** A detail cross-reference that happens to sit in the fixed corner. */
const CORNER_XREF = [W("SEE", 0.55, 0.8), W("E-345", 0.61, 0.8)];

const detectedTopLeft = computePageZones([
  { name: "title_block", minX: 0, minY: 0, maxX: 0.4, maxY: 0.15, confidence: 0.9, modelName: "yolo_medium" },
]);

describe("extractDrawingNumber — legacy paths unchanged", () => {
  it("2-arg call searches the fixed bottom-right corner (upload path)", () => {
    expect(extractDrawingNumber(page([...TOP_LEFT_TITLE, ...CORNER_XREF]))).toBe("E-345");
  });

  it("fixed-fallback zones are identical to the 2-arg call", () => {
    const data = page([...TOP_LEFT_TITLE, ...CORNER_XREF]);
    expect(extractDrawingNumber(data, null, computePageZones([]))).toBe(extractDrawingNumber(data));
    expect(extractDrawingNumber(data, undefined, computePageZones([]))).toBe("E-345");
  });

  it("the audit bug, pinned as-is for the legacy path: empty fixed corner ⇒ null even with a YOLO box", () => {
    expect(extractDrawingNumber(page(TOP_LEFT_TITLE))).toBeNull();
    expect(extractDrawingNumber(page(TOP_LEFT_TITLE), { minX: 0, minY: 0, maxX: 0.4, maxY: 0.15 })).toBeNull();
  });

  it("legacy yoloTitleBlock still re-ranks and searches the YOLO box when the corner has words", () => {
    const data = page([...TOP_LEFT_TITLE, ...CORNER_XREF]);
    expect(extractDrawingNumber(data, { minX: 0, minY: 0, maxX: 0.4, maxY: 0.15 })).toBe("A-201");
  });

  it("returns null without words", () => {
    expect(extractDrawingNumber(page([]))).toBeNull();
    expect(extractDrawingNumber(page([]), null, detectedTopLeft)).toBeNull();
  });
});

describe("extractDrawingNumber — detector zones", () => {
  it("searches INSIDE the detected title block: the label-anchored sheet number wins over the corner xref", () => {
    expect(extractDrawingNumber(page([...TOP_LEFT_TITLE, ...CORNER_XREF]), null, detectedTopLeft)).toBe("A-201");
  });

  it("finds the sheet number when the fixed corner is empty (the audit's null case)", () => {
    expect(extractDrawingNumber(page(TOP_LEFT_TITLE), null, detectedTopLeft)).toBe("A-201");
  });

  it("an explicit yoloTitleBlock still takes precedence as the validation region", () => {
    // validation box deliberately covers only the corner: A-201 (label-anchored 1.0) is penalised
    // to 0.6; E-345, low in the corner, enters via the fresh in-box search at 0.5 + 0.15 = 0.65.
    const corner = { minX: 0.45, minY: 0.7, maxX: 1, maxY: 1 };
    const lowXref = [W("SEE", 0.55, 0.9), W("E-345", 0.61, 0.9)];
    const data = page([...TOP_LEFT_TITLE, ...lowXref]);
    expect(extractDrawingNumber(data, corner, detectedTopLeft)).toBe("E-345");
    // without the explicit box the detected block validates, and A-201 wins
    expect(extractDrawingNumber(data, null, detectedTopLeft)).toBe("A-201");
  });

  it("a detected title block that yields no candidate falls back to the legacy corner search", () => {
    // a mis-detection (or an OCR-empty box) must never cost a sheet number the old search found
    const farRight = computePageZones([{ name: "title_block", minX: 0.95, minY: 0, maxX: 1, maxY: 1, modelName: "yolo_medium" }]);
    expect(extractDrawingNumber(page([...TOP_LEFT_TITLE, ...CORNER_XREF]), null, farRight)).toBe("E-345");
    // …and when the corner is empty too, null — same as legacy
    expect(extractDrawingNumber(page(TOP_LEFT_TITLE), null, farRight)).toBeNull();
  });
});
