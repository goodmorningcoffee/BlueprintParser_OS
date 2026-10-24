/**
 * classes.test.ts — the shipped class table is the verbatim merge of corpus_v2's two Python
 * class files (same rows, same rules) and the loader rejects a malformed table.
 */
import { describe, it, expect } from "vitest";
import { REGION_CLASS_TABLE, REGION_CLASSES_HASH, hashClassTable, prepareRows, validateClassTable } from "../classes";

describe("region-classes.v2.json", () => {
  it("carries the 13 table classes and 8 text classes with the Python rules", () => {
    expect(REGION_CLASS_TABLE.version).toBe("rc-v2/0.1");
    expect(REGION_CLASS_TABLE.tables.classes.map((c) => c.name)).toEqual([
      "door schedule", "window schedule", "hardware schedule", "finish schedule", "room schedule", "plumbing fixture schedule",
      "HVAC equipment schedule", "air distribution schedule", "lighting fixture schedule", "electrical panel schedule",
      "other electrical equipment schedule", "structural schedule", "drawing list",
    ]);
    expect(REGION_CLASS_TABLE.tables.rules).toEqual({
      min_score: 4.0, min_keywords: 2, csi_weight: 2.0, csi_min_codes: 2, titleblock_weight: 1.0,
      sheet_yolo_weight: 1.5, tag_weight: 1.0, tag_min: 3, schedule_word_weight: 1.0,
    });
    expect(REGION_CLASS_TABLE.text.classes.map((c) => c.name)).toEqual([
      "keynotes", "symbol legend", "abbreviations", "general notes", "sheet / coded notes", "demolition notes",
      "code / life-safety notes", "structural notes",
    ]);
    expect(REGION_CLASS_TABLE.text.rules).toEqual({ min_score: 4.0, min_keywords: 1, csi_weight: 2.0, csi_min_codes: 2, titleblock_weight: 1.0 });
    expect(REGION_CLASS_TABLE.text.fallback?.rules.map((r) => r.name)).toEqual([
      "table text (see Tables tab)", "short label", "view title / callout", "specification text", "notes (untitled)",
      "room / space labels", "address / project info", "existing / new / demo callouts", "material callouts", "dimensions / data",
    ]);
    expect(REGION_CLASS_TABLE.tables.classes[0].keywords["DOOR SCHEDULE"]).toBe(4);
    expect(REGION_CLASS_TABLE.tables.classes[12].is_schedule).toBe(false);
  });

  it("hash is stable for the shipped table and changes with any row edit", () => {
    expect(REGION_CLASSES_HASH).toMatch(/^[0-9a-f]{8}$/);
    expect(hashClassTable(REGION_CLASS_TABLE)).toBe(REGION_CLASSES_HASH);
    const edited = JSON.parse(JSON.stringify(REGION_CLASS_TABLE));
    edited.tables.classes[0].keywords.DOOR = 1.6;
    expect(hashClassTable(edited)).not.toBe(REGION_CLASSES_HASH);
  });

  it("prepareRows splits phrases from words and upper-cases title-block words", () => {
    const [row] = prepareRows([{ name: "x", keywords: { "door schedule": 4, Door: 1 }, titleblock_plus: ["door"] }]);
    expect(row.kwp).toEqual({ "DOOR SCHEDULE": 4 });
    expect(row.kw1).toEqual({ DOOR: 1 });
    expect(row.tbp).toEqual(["DOOR"]);
  });

  it("validateClassTable rejects a malformed table", () => {
    expect(() => validateClassTable({})).toThrow(/version/);
    expect(() => validateClassTable({ version: "v", tables: { rules: {}, classes: [] }, text: REGION_CLASS_TABLE.text })).toThrow(/min_score/);
    expect(() => validateClassTable({
      version: "v", text: REGION_CLASS_TABLE.text,
      tables: { rules: REGION_CLASS_TABLE.tables.rules, classes: [{ name: "a", keywords: {} }, { name: "a", keywords: {} }] },
    })).toThrow(/duplicate/);
    expect(() => validateClassTable({
      version: "v", text: REGION_CLASS_TABLE.text,
      tables: { rules: REGION_CLASS_TABLE.tables.rules, classes: [{ name: "a", keywords: { X: "heavy" } }] },
    })).toThrow(/weight/);
  });
});
