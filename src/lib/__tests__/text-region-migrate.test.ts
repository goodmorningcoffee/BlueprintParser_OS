import { describe, it, expect } from "vitest";
import {
  migrateTextRegion,
  migrateTextRegionType,
  migrateTextRegions,
  type LegacyTextRegion,
} from "@/lib/text-region-migrate";
import type { TextRegion } from "@/types";

describe("migrateTextRegionType", () => {
  it("maps each legacy string to its new equivalent", () => {
    expect(migrateTextRegionType("table-like")).toBe("schedule-table");
    expect(migrateTextRegionType("notes-block")).toBe("notes-numbered");
    expect(migrateTextRegionType("spec-text")).toBe("spec-dense-columns");
    expect(migrateTextRegionType("key-value")).toBe("notes-key-value");
  });

  it("preserves 'paragraph' unchanged (identical in both schemas)", () => {
    expect(migrateTextRegionType("paragraph")).toBe("paragraph");
  });

  it("preserves new type strings unchanged (idempotent)", () => {
    expect(migrateTextRegionType("schedule-table")).toBe("schedule-table");
    expect(migrateTextRegionType("notes-numbered")).toBe("notes-numbered");
    expect(migrateTextRegionType("unknown")).toBe("unknown");
  });

  it("returns undefined for undefined input", () => {
    expect(migrateTextRegionType(undefined)).toBeUndefined();
  });
});

describe("migrateTextRegion", () => {
  it("migrates a legacy region to new shape", () => {
    const legacy: LegacyTextRegion = {
      id: "region-0",
      type: "notes-block",
      bbox: [0.1, 0.2, 0.3, 0.4],
      confidence: 0.75,
      wordCount: 42,
      columnCount: 1,
      rowCount: 5,
      hasNumberedItems: true,
      headerText: "GENERAL NOTES",
      containedText: "1. First note...",
    };
    const migrated = migrateTextRegion(legacy);
    expect(migrated.type).toBe("notes-numbered");
    expect(migrated.id).toBe("region-0");
    expect(migrated.bbox).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(migrated.wordCount).toBe(42);
    expect(migrated.headerText).toBe("GENERAL NOTES");
  });

  it("is idempotent on already-new regions", () => {
    const newShape: TextRegion = {
      id: "region-1",
      type: "notes-numbered",
      bbox: [0, 0, 1, 1],
      confidence: 0.9,
      wordCount: 30,
      lineCount: 5,
      classifiedLabels: { tier1: "NOTES", tier2: "GENERAL NOTES" },
    };
    const migrated = migrateTextRegion(newShape);
    expect(migrated.type).toBe("notes-numbered");
    expect(migrated.lineCount).toBe(5);
    expect(migrated.classifiedLabels?.tier2).toBe("GENERAL NOTES");
  });

  it("preserves all optional fields through migration", () => {
    const legacy: LegacyTextRegion = {
      id: "r",
      type: "table-like",
      bbox: [0, 0, 0.5, 0.5],
      confidence: 0.8,
      wordCount: 100,
      columnCount: 4,
      rowCount: 10,
      csiTags: [{ code: "08 11 16", description: "Hollow Metal Doors" } as any],
      headerText: "DOOR SCHEDULE",
      containedText: "TAG TYPE WIDTH...",
    };
    const m = migrateTextRegion(legacy);
    expect(m.type).toBe("schedule-table");
    expect(m.columnCount).toBe(4);
    expect(m.rowCount).toBe(10);
    expect(m.csiTags?.length).toBe(1);
    expect(m.headerText).toBe("DOOR SCHEDULE");
  });
});

describe("migrateTextRegions", () => {
  it("migrates each entry and preserves order", () => {
    const regions: LegacyTextRegion[] = [
      { id: "a", type: "table-like", bbox: [0, 0, 1, 1], confidence: 0.8, wordCount: 50 },
      { id: "b", type: "notes-block", bbox: [0, 0, 1, 1], confidence: 0.7, wordCount: 30 },
      { id: "c", type: "paragraph", bbox: [0, 0, 1, 1], confidence: 0.3, wordCount: 10 },
    ];
    const migrated = migrateTextRegions(regions)!;
    expect(migrated.map((r) => r.type)).toEqual([
      "schedule-table",
      "notes-numbered",
      "paragraph",
    ]);
    expect(migrated.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("returns undefined for undefined input", () => {
    expect(migrateTextRegions(undefined)).toBeUndefined();
  });

  it("returns empty array for empty input", () => {
    expect(migrateTextRegions([])).toEqual([]);
  });
});
