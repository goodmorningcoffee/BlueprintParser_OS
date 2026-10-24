// Header-name derivation over synthetic words: the title line in the header band or just above
// the box, cleaned of scale text / detail bubbles / leading numbers, with a confidence.
import { describe, expect, it } from "vitest";
import type { TextractWord } from "@/types";
import { buildCandidateEvidence, buildPageEvidence, groupRows, type EvWord } from "../evidence";
import { cleanTitle, deriveName } from "../derive-name";

const word = (text: string, x: number, y: number, h = 0.01): TextractWord => ({ text, confidence: 99, bbox: [x, y, text.length * 0.006, h] });
const ev = (ws: TextractWord[]): EvWord[] => buildPageEvidence({ pageNumber: 1, detections: [], textractData: { words: ws } }).words;

describe("cleanTitle", () => {
  it("strips scale text, detail bubbles and leading numbers, keeps the title", () => {
    expect(cleanTitle("3 DOOR SCHEDULE SCALE: 1/4\" = 1'-0\"")).toBe("DOOR SCHEDULE");
    expect(cleanTitle("A1 / A-501 WINDOW TYPES N.T.S.")).toBe("WINDOW TYPES");
    expect(cleanTitle("12. finish schedule:")).toBe("FINISH SCHEDULE");
    expect(cleanTitle("1/8\"=1'-0\" ROOM FINISH SCHEDULE")).toBe("ROOM FINISH SCHEDULE");
    expect(cleanTitle("   ")).toBe("");
  });
});

describe("deriveName", () => {
  it("prefers the SCHEDULE line over a taller numeric line and reports source + confidence", () => {
    const rows = groupRows(ev([word("101", 0.1, 0.10, 0.02), word("DOOR", 0.1, 0.13), word("SCHEDULE", 0.14, 0.13), word("MARK", 0.1, 0.16), word("SIZE", 0.16, 0.16)]));
    const out = deriveName({ headerRows: rows, aboveRows: [], lineHeight: 0.01 });
    expect(out?.text).toBe("DOOR SCHEDULE");
    expect(out?.source).toBe("header");
    expect(out?.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("takes a title that sits just above the box and joins a title split across two segments", () => {
    const ws = [
      word("PLUMBING", 0.30, 0.185, 0.018), word("FIXTURE", 0.40, 0.185, 0.018), word("SCHEDULE", 0.48, 0.185, 0.018),
      word("MARK", 0.30, 0.22), word("CW", 0.40, 0.22), word("HW", 0.45, 0.22), word("WC-1", 0.30, 0.25), word("1/2\"", 0.40, 0.25), word("1/2\"", 0.45, 0.25),
    ];
    const page = buildPageEvidence({ pageNumber: 1, detections: [], textractData: { words: ws } });
    const cand = buildCandidateEvidence(page, { source: "yolo", bbox: [0.28, 0.21, 0.6, 0.3], anchorBbox: [0.28, 0.21, 0.6, 0.3] });
    expect(cand.derivedName).toMatchObject({ text: "PLUMBING FIXTURE SCHEDULE", source: "above" });
    expect(cand.bands.above.tokens.get("SCHEDULE")).toBe(1);
    // no in-box title → the first rows are the column headers, the rest the body
    expect(cand.bands.header.words).toHaveLength(0);
    expect(cand.bands.columns.tokens.has("MARK")).toBe(true);
  });

  it("returns undefined when nothing title-like exists and a low confidence for a bare topmost line", () => {
    expect(deriveName({ headerRows: [], aboveRows: [], lineHeight: 0.01 })).toBeUndefined();
    const rows = groupRows(ev([word("HM", 0.1, 0.1), word("WD", 0.14, 0.1)]));
    const out = deriveName({ headerRows: rows, aboveRows: [], lineHeight: 0.01 });
    expect(out?.confidence).toBeLessThan(0.6);
  });
});
