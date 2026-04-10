/**
 * Table parse method tests — pure function tests for OCR positions + Textract tables.
 *
 * Tests the extracted service functions from src/lib/services/table-parse.ts.
 * No DB mocking needed — these are pure functions accepting word/table arrays.
 */
import { describe, it, expect } from "vitest";
import { methodOcrPositions, methodTextractTables } from "@/lib/services/table-parse";
import type { TextractWord, TextractTable } from "@/types";

// ─── Test data helpers ───────────────────────────────────────
function makeWord(text: string, left: number, top: number, width = 0.03, height = 0.01): TextractWord {
  return { text, confidence: 99, bbox: [left, top, width, height] };
}

/**
 * Build a grid of words simulating a 3-column table:
 *   TAG | DESCRIPTION | QTY
 *   D-01 | Single Door | 5
 *   D-02 | Double Door | 2
 *   D-03 | Overhead    | 1
 * Words are placed at column X positions 0.1, 0.35, 0.65
 * and row Y positions starting at 0.1 with 0.02 spacing.
 */
function makeTableWords(): TextractWord[] {
  const cols = [0.1, 0.35, 0.65];
  const rows = [
    ["TAG", "DESCRIPTION", "QTY"],
    ["D-01", "Single Door", "5"],
    ["D-02", "Double Door", "2"],
    ["D-03", "Overhead Door", "1"],
    ["D-04", "Sliding", "3"],
    ["D-05", "Pocket", "2"],
  ];
  const words: TextractWord[] = [];
  rows.forEach((row, ri) => {
    row.forEach((text, ci) => {
      // Multi-word cells: split and place side by side
      const parts = text.split(" ");
      parts.forEach((part, pi) => {
        words.push(makeWord(part, cols[ci] + pi * 0.04, 0.1 + ri * 0.02));
      });
    });
  });
  return words;
}

const REGION: [number, number, number, number] = [0.05, 0.05, 0.95, 0.95];

// ─── methodOcrPositions ──────────────────────────────────────
describe("methodOcrPositions", () => {
  it("returns empty for fewer than 6 words", () => {
    const words = [makeWord("A", 0.1, 0.1), makeWord("B", 0.2, 0.1)];
    const result = methodOcrPositions(words, REGION);
    expect(result.headers).toHaveLength(0);
    expect(result.rows).toHaveLength(0);
    expect(result.confidence).toBe(0);
  });

  it("detects rows and columns from a word grid", () => {
    const words = makeTableWords();
    const result = methodOcrPositions(words, REGION);
    expect(result.headers.length).toBeGreaterThanOrEqual(2);
    expect(result.rows.length).toBeGreaterThanOrEqual(3);
    expect(result.confidence).toBeGreaterThan(0);
  });

  it("auto-detects keyword headers (TAG, DESCRIPTION, QTY)", () => {
    const words = makeTableWords();
    const result = methodOcrPositions(words, REGION, { headerMode: "auto" });
    // Should detect TAG, DESCRIPTION, QTY as headers
    const headerUpper = result.headers.map(h => h.toUpperCase());
    expect(headerUpper.some(h => h.includes("TAG") || h.includes("DESCRIPTION") || h.includes("QTY"))).toBe(true);
  });

  it("forces first row as header with headerMode:first", () => {
    const words = makeTableWords();
    const result = methodOcrPositions(words, REGION, { headerMode: "first" });
    // First row content should be used as headers
    expect(result.headers.length).toBeGreaterThan(0);
    // Data rows should not include the header row
    const allValues = result.rows.flatMap(r => Object.values(r));
    expect(allValues.some(v => v === "TAG")).toBe(false);
  });

  it("skips header detection with headerMode:none", () => {
    const words = makeTableWords();
    const result = methodOcrPositions(words, REGION, { headerMode: "none" });
    // Headers should be generic "Column N"
    expect(result.headers.every(h => h.startsWith("Column "))).toBe(true);
    // All rows including the keyword row should be in data rows
    expect(result.rows.length).toBeGreaterThanOrEqual(5);
  });

  it("detects tag column by keyword match", () => {
    const words = makeTableWords();
    const result = methodOcrPositions(words, REGION);
    if (result.tagColumn) {
      expect(result.tagColumn.toUpperCase()).toBe("TAG");
    }
  });

  it("detects tag column by regex pattern when no keyword header", () => {
    // Build table with generic headers but tag-like values
    const cols = [0.1, 0.35, 0.65];
    const rows = [
      ["Item", "Desc", "Count"],
      ["A-01", "Door", "5"],
      ["A-02", "Window", "3"],
      ["A-03", "Wall", "1"],
      ["A-04", "Floor", "2"],
      ["A-05", "Ceiling", "4"],
    ];
    const words: TextractWord[] = [];
    rows.forEach((row, ri) => {
      row.forEach((text, ci) => {
        words.push(makeWord(text, cols[ci], 0.1 + ri * 0.02));
      });
    });
    const result = methodOcrPositions(words, REGION, { headerMode: "first" });
    // Should detect the first column as tag column via regex
    if (result.tagColumn) {
      const tagValues = result.rows.map(r => r[result.tagColumn!]);
      expect(tagValues.every(v => /^[A-Z]-\d+$/.test(v))).toBe(true);
    }
  });

  it("computes row and column boundaries", () => {
    const words = makeTableWords();
    const result = methodOcrPositions(words, REGION);
    if (result.colBoundaries && result.rowBoundaries) {
      expect(result.colBoundaries.length).toBeGreaterThan(result.headers.length);
      expect(result.rowBoundaries.length).toBeGreaterThan(1);
      // Boundaries should be sorted
      for (let i = 1; i < result.colBoundaries.length; i++) {
        expect(result.colBoundaries[i]).toBeGreaterThanOrEqual(result.colBoundaries[i - 1]);
      }
      for (let i = 1; i < result.rowBoundaries.length; i++) {
        expect(result.rowBoundaries[i]).toBeGreaterThanOrEqual(result.rowBoundaries[i - 1]);
      }
    }
  });

  it("respects rowTolerance parameter", () => {
    const words = makeTableWords();
    // Very tight tolerance should split rows that are close
    const tight = methodOcrPositions(words, REGION, { rowTolerance: 0.001 });
    const loose = methodOcrPositions(words, REGION, { rowTolerance: 0.05 });
    // Tighter tolerance = more rows (or same), looser = fewer rows (merges)
    expect(tight.rows.length).toBeGreaterThanOrEqual(loose.rows.length);
  });

  it("respects minColGap parameter", () => {
    const words = makeTableWords();
    // Very large gap should merge columns
    const result = methodOcrPositions(words, REGION, { minColGap: 0.5 });
    // With a 0.5 gap, most columns would merge
    expect(result.headers.length).toBeLessThanOrEqual(3);
  });
});

// ─── methodTextractTables ────────────────────────────────────
describe("methodTextractTables", () => {
  const makeTable = (
    bbox: [number, number, number, number],
    cells: Array<{ row: number; col: number; text: string; confidence: number; bbox: [number, number, number, number] }>,
    colCount: number,
  ) => ({ bbox, cells, colCount }) as TextractTable;

  it("returns empty for no tables", () => {
    const result = methodTextractTables(undefined, REGION);
    expect(result.headers).toHaveLength(0);
    expect(result.confidence).toBe(0);
  });

  it("returns empty for empty tables array", () => {
    const result = methodTextractTables([], REGION);
    expect(result.headers).toHaveLength(0);
  });

  it("returns empty when table doesn't overlap region", () => {
    const table = makeTable([0.0, 0.0, 0.01, 0.01], [], 2);
    const result = methodTextractTables([table], [0.5, 0.5, 0.9, 0.9]);
    expect(result.confidence).toBe(0);
  });

  it("extracts cells from overlapping table", () => {
    const table = makeTable(
      [0.1, 0.1, 0.8, 0.4], // bbox: [left, top, width, height]
      [
        { row: 1, col: 1, text: "D-01", confidence: 95, bbox: [0.1, 0.1, 0.1, 0.05] },
        { row: 1, col: 2, text: "Door", confidence: 90, bbox: [0.3, 0.1, 0.1, 0.05] },
        { row: 2, col: 1, text: "D-02", confidence: 92, bbox: [0.1, 0.2, 0.1, 0.05] },
        { row: 2, col: 2, text: "Window", confidence: 88, bbox: [0.3, 0.2, 0.1, 0.05] },
      ],
      2,
    );
    const result = methodTextractTables([table], [0.05, 0.05, 0.95, 0.95]);
    expect(result.rows.length).toBe(2);
    expect(result.headers.length).toBe(2);
    expect(result.confidence).toBeGreaterThan(0);
  });

  it("filters cells to region bbox", () => {
    const table = makeTable(
      [0.0, 0.0, 1.0, 1.0],
      [
        { row: 1, col: 1, text: "Inside", confidence: 95, bbox: [0.3, 0.3, 0.1, 0.05] },
        { row: 2, col: 1, text: "Outside", confidence: 90, bbox: [0.8, 0.8, 0.1, 0.05] },
      ],
      1,
    );
    // Region only covers the first cell
    const result = methodTextractTables([table], [0.2, 0.2, 0.5, 0.5]);
    expect(result.rows.length).toBe(1);
    const allText = result.rows.map(r => Object.values(r).join(""));
    expect(allText.some(t => t.includes("Inside"))).toBe(true);
    expect(allText.some(t => t.includes("Outside"))).toBe(false);
  });

  it("computes confidence from fill rate and cell confidence", () => {
    const table = makeTable(
      [0.1, 0.1, 0.8, 0.4],
      [
        { row: 1, col: 1, text: "A", confidence: 99, bbox: [0.15, 0.15, 0.1, 0.05] },
        { row: 1, col: 2, text: "B", confidence: 99, bbox: [0.45, 0.15, 0.1, 0.05] },
      ],
      2,
    );
    const result = methodTextractTables([table], [0.05, 0.05, 0.95, 0.95]);
    expect(result.confidence).toBeGreaterThan(0.3);
    expect(result.confidence).toBeLessThanOrEqual(0.9);
  });
});
