import { describe, it, expect } from "vitest";
import { classifyTextRegions, parseNotesFromRegion } from "@/lib/text-region-classifier";
import type { TextractPageData, TextractLine, TextractWord, CsiCode } from "@/types";

// ═══════════════════════════════════════════════════════════════════
// Synthetic Textract fixture helpers
// ═══════════════════════════════════════════════════════════════════

function makeWord(text: string, x: number, y: number, w: number, h: number): TextractWord {
  return { text, confidence: 95, bbox: [x, y, w, h] };
}

function makeLine(text: string, x: number, y: number, w: number, h: number): TextractLine {
  const parts = text.split(/\s+/).filter(Boolean);
  let cursor = x;
  const words: TextractWord[] = parts.map((p) => {
    const wordWidth = (w * p.length) / Math.max(text.length, 1);
    const word = makeWord(p, cursor, y, wordWidth, h);
    cursor += wordWidth + 0.005;
    return word;
  });
  return { text, confidence: 95, bbox: [x, y, w, h], words };
}

function pageOf(lines: TextractLine[]): TextractPageData {
  const words: TextractWord[] = lines.flatMap((l) => l.words ?? []);
  return { lines, words };
}

// ═══════════════════════════════════════════════════════════════════
// Per-pattern-family fixtures
// ═══════════════════════════════════════════════════════════════════

/** GENERAL NOTES header + 6 numbered lines stacked in a single column. */
function fixtureNotesNumbered(): TextractPageData {
  return pageOf([
    makeLine("GENERAL NOTES", 0.1, 0.1, 0.3, 0.025), // taller header font
    makeLine("1. All dimensions are approximate.", 0.1, 0.14, 0.3, 0.02),
    makeLine("2. Contractor shall verify all dimensions.", 0.1, 0.17, 0.4, 0.02),
    makeLine("3. All doors shall match schedule.", 0.1, 0.20, 0.35, 0.02),
    makeLine("4. Fire rating as noted.", 0.1, 0.23, 0.25, 0.02),
    makeLine("5. See specifications for finishes.", 0.1, 0.26, 0.35, 0.02),
    makeLine("6. Verify with architect before installation.", 0.1, 0.29, 0.4, 0.02),
  ]);
}

/** DOOR SCHEDULE header + 4 rows × 4 columns. */
function fixtureScheduleTable(): TextractPageData {
  const lines: TextractLine[] = [
    makeLine("DOOR SCHEDULE", 0.2, 0.1, 0.3, 0.025),
  ];
  const headers = ["TAG", "TYPE", "WIDTH", "HEIGHT"];
  const xs = [0.1, 0.3, 0.5, 0.7];
  // header row
  for (let i = 0; i < headers.length; i++) {
    lines.push(makeLine(headers[i], xs[i], 0.14, 0.12, 0.02));
  }
  // 4 data rows
  const data = [
    ["D-01", "HM", "3'-0\"", "7'-0\""],
    ["D-02", "HM", "3'-0\"", "7'-0\""],
    ["D-03", "WD", "2'-8\"", "6'-8\""],
    ["D-04", "WD", "3'-0\"", "7'-0\""],
  ];
  for (let r = 0; r < data.length; r++) {
    for (let c = 0; c < data[r].length; c++) {
      lines.push(makeLine(data[r][c], xs[c], 0.17 + r * 0.03, 0.12, 0.02));
    }
  }
  return pageOf(lines);
}

/** Abbreviations legend — 2 columns: short-code + short-value. */
function fixtureNotesKeyValue(): TextractPageData {
  const pairs = [
    ["ABV", "ABOVE"],
    ["ADJ", "ADJACENT"],
    ["AFF", "ABOVE FLOOR"],
    ["APPROX", "APPROX"],
    ["BLDG", "BUILDING"],
  ];
  const lines: TextractLine[] = [
    makeLine("ABBREVIATIONS", 0.15, 0.1, 0.25, 0.025),
  ];
  for (let i = 0; i < pairs.length; i++) {
    lines.push(makeLine(pairs[i][0], 0.1, 0.14 + i * 0.03, 0.1, 0.02));
    lines.push(makeLine(pairs[i][1], 0.25, 0.14 + i * 0.03, 0.1, 0.02));
  }
  return pageOf(lines);
}

/** Dense spec page — narrow column, section header, many words. */
function fixtureSpecDenseColumns(): TextractPageData {
  const lines: TextractLine[] = [];
  lines.push(makeLine("PART 1 - GENERAL", 0.1, 0.1, 0.2, 0.025));
  lines.push(makeLine("SECTION 08 11 00", 0.1, 0.13, 0.2, 0.025));
  // Two narrow columns side-by-side
  const col1X = 0.1;
  const col2X = 0.3;
  const colW = 0.15;
  const wordsPerLine = 5;
  for (let r = 0; r < 12; r++) {
    const y = 0.17 + r * 0.02;
    lines.push(
      makeLine(
        Array.from({ length: wordsPerLine }, (_, i) => `word${r}${i}`).join(" "),
        col1X,
        y,
        colW,
        0.015,
      ),
    );
    lines.push(
      makeLine(
        Array.from({ length: wordsPerLine }, (_, i) => `word${r}${i}b`).join(" "),
        col2X,
        y,
        colW,
        0.015,
      ),
    );
  }
  return pageOf(lines);
}

/** Free prose — no structure. */
function fixtureParagraph(): TextractPageData {
  const lines: TextractLine[] = [];
  for (let r = 0; r < 5; r++) {
    lines.push(
      makeLine(
        "This is plain prose without structured numbering or tabular columns.",
        0.1,
        0.2 + r * 0.03,
        0.6,
        0.02,
      ),
    );
  }
  return pageOf(lines);
}

// ═══════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════

const NO_CSI: CsiCode[] = [];

describe("classifyTextRegions — Stage 1 composite classifier", () => {
  it("returns empty array for missing textract data", () => {
    expect(classifyTextRegions({ lines: [], words: [] }, NO_CSI)).toEqual([]);
  });

  it("identifies notes-numbered with high confidence", () => {
    const regions = classifyTextRegions(fixtureNotesNumbered(), NO_CSI);
    expect(regions.length).toBeGreaterThan(0);
    const top = regions[0];
    expect(top.type).toBe("notes-numbered");
    expect(top.confidence).toBeGreaterThanOrEqual(0.6);
    expect(top.grid).toBeDefined();
    expect(top.grid?.headers).toEqual(["Key", "Note"]);
    expect(top.grid?.rows.length).toBeGreaterThanOrEqual(5);
  });

  it("binds numbered-row grid with Key and Note fields", () => {
    const regions = classifyTextRegions(fixtureNotesNumbered(), NO_CSI);
    const notes = regions.find((r) => r.type === "notes-numbered")!;
    expect(notes.grid?.rows[0].Key).toBe("1");
    expect(notes.grid?.rows[0].Note).toContain("All dimensions");
  });

  it("identifies schedule-table from 3+ columns with SCHEDULE header", () => {
    const regions = classifyTextRegions(fixtureScheduleTable(), NO_CSI);
    const scheduleCandidates = regions.filter((r) => r.type === "schedule-table");
    expect(scheduleCandidates.length).toBeGreaterThan(0);
    const top = scheduleCandidates[0];
    expect(top.columnCount).toBeGreaterThanOrEqual(3);
    expect(top.classifiedLabels?.tier1 ?? top.classifiedLabels?.tier2).toBeDefined();
  });

  it("tags schedule-table regions with SCHEDULE tier keywords", () => {
    const regions = classifyTextRegions(fixtureScheduleTable(), NO_CSI);
    const hasScheduleTier = regions.some(
      (r) => r.classifiedLabels?.tier1 === "SCHEDULE"
        || r.classifiedLabels?.tier2?.includes("SCHEDULE"),
    );
    expect(hasScheduleTier).toBe(true);
  });

  it("applies tier metadata without overriding structural type", () => {
    const regions = classifyTextRegions(fixtureScheduleTable(), NO_CSI);
    const schedule = regions.find((r) => r.type === "schedule-table");
    expect(schedule).toBeDefined();
    // Tier is metadata only — type should not shift because of keyword match
    expect(schedule!.type).toBe("schedule-table");
  });

  it("does NOT classify free prose as a table", () => {
    const regions = classifyTextRegions(fixtureParagraph(), NO_CSI);
    const schedules = regions.filter((r) => r.type === "schedule-table");
    expect(schedules.length).toBe(0);
  });

  it("lineCount is populated in output regions", () => {
    const regions = classifyTextRegions(fixtureNotesNumbered(), NO_CSI);
    expect(regions[0].lineCount).toBeGreaterThan(0);
  });

  it("legacy numbered-item variants match (e.g. '1)' and '(1)')", () => {
    const data = pageOf([
      makeLine("GENERAL NOTES", 0.1, 0.1, 0.3, 0.025),
      makeLine("1) First variant with parens", 0.1, 0.14, 0.3, 0.02),
      makeLine("2) Second variant", 0.1, 0.17, 0.3, 0.02),
      makeLine("3) Third variant", 0.1, 0.20, 0.3, 0.02),
      makeLine("4) Fourth", 0.1, 0.23, 0.2, 0.02),
      makeLine("5) Fifth", 0.1, 0.26, 0.2, 0.02),
    ]);
    const regions = classifyTextRegions(data, NO_CSI);
    const notes = regions.find((r) => r.type === "notes-numbered");
    expect(notes).toBeDefined();
  });

  it("debug bundle is emitted when opts.debug is true", () => {
    let capturedBundle: unknown = null;
    classifyTextRegions(fixtureNotesNumbered(), NO_CSI, {
      debug: true,
      onDebug: (bundle) => {
        capturedBundle = bundle;
      },
    });
    expect(capturedBundle).not.toBeNull();
    const b = capturedBundle as any;
    expect(b.stages.A.lineCount).toBeGreaterThan(0);
    expect(b.stages.B.candidateBboxes).toBeInstanceOf(Array);
    expect(b.stages.D.componentBboxes).toBeInstanceOf(Array);
    expect(b.stages.F).toBeInstanceOf(Array);
    expect(b.finalRegions).toBeInstanceOf(Array);
  });

  it("debug bundle carries decisionTrace for each region", () => {
    let bundle: any = null;
    classifyTextRegions(fixtureNotesNumbered(), NO_CSI, {
      debug: true,
      onDebug: (b) => (bundle = b),
    });
    expect(bundle.stages.F.length).toBeGreaterThan(0);
    for (const entry of bundle.stages.F) {
      expect(entry.decisionTrace).toBeInstanceOf(Array);
      expect(entry.decisionTrace.length).toBeGreaterThan(0);
    }
  });

  it("no new TextRegionType contains legacy strings", () => {
    const regions = classifyTextRegions(fixtureNotesNumbered(), NO_CSI);
    const legacyNames = new Set(["table-like", "notes-block", "spec-text", "key-value"]);
    for (const r of regions) {
      expect(legacyNames.has(r.type)).toBe(false);
    }
  });
});

describe("parseNotesFromRegion — Stage 4 Parser wrapper", () => {
  it("returns Key/Note grid for a numbered-notes bbox", () => {
    const data = fixtureNotesNumbered();
    const regionBbox: [number, number, number, number] = [0.05, 0.05, 0.5, 0.35];
    const grid = parseNotesFromRegion(data, regionBbox);
    expect(grid).toBeDefined();
    expect(grid?.headers).toEqual(["Key", "Note"]);
    expect(grid?.rows.length).toBeGreaterThanOrEqual(5);
    expect(grid?.rows[0].Key).toBe("1");
    expect(grid?.rows[0].Note).toContain("All dimensions");
  });

  it("computes colBoundaries with three entries (left, keyColRight, right)", () => {
    const data = fixtureNotesNumbered();
    const regionBbox: [number, number, number, number] = [0.05, 0.05, 0.5, 0.35];
    const grid = parseNotesFromRegion(data, regionBbox);
    expect(grid?.colBoundaries).toBeDefined();
    expect(grid!.colBoundaries!.length).toBe(3);
    const [left, mid, right] = grid!.colBoundaries!;
    expect(left).toBeCloseTo(0.05);
    expect(right).toBeCloseTo(0.55);
    expect(mid).toBeGreaterThan(left);
    expect(mid).toBeLessThan(right);
  });

  it("returns undefined when no lines fall inside the bbox", () => {
    const data = fixtureNotesNumbered();
    const regionBbox: [number, number, number, number] = [0.9, 0.9, 0.05, 0.05];
    expect(parseNotesFromRegion(data, regionBbox)).toBeUndefined();
  });
});
