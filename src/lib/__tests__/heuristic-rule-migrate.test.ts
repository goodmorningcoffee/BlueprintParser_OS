import { describe, it, expect } from "vitest";
import { migrateRule, type LegacyHeuristicRule } from "@/lib/heuristic-rule-migrate";
import type { HeuristicRule } from "@/lib/heuristic-engine";

const legacyRule: LegacyHeuristicRule = {
  id: "door-schedule",
  name: "Door Schedule",
  source: "built-in",
  enabled: true,
  yoloRequired: ["table"],
  yoloBoosters: ["grid"],
  textKeywords: ["DOOR", "SCHEDULE"],
  overlapRequired: true,
  textRegionType: "table-like",
  outputLabel: "door-schedule",
  outputCsiCode: "08 11 16",
  minConfidence: 0.5,
};

describe("migrateRule", () => {
  it("splits legacy textKeywords into required + empty boosters", () => {
    const migrated = migrateRule(legacyRule);
    expect(migrated.textKeywordsRequired).toEqual(["DOOR", "SCHEDULE"]);
    expect(migrated.textKeywordsBoosters).toEqual([]);
  });

  it("defaults textKeywordsMode to all-required (preserves legacy every() semantics)", () => {
    const migrated = migrateRule(legacyRule);
    expect(migrated.textKeywordsMode).toBe("all-required");
  });

  it("defaults yoloAvailabilityMode to require", () => {
    const migrated = migrateRule(legacyRule);
    expect(migrated.yoloAvailabilityMode).toBe("require");
  });

  it("migrates legacy textRegionType via text-region-migrate", () => {
    expect(migrateRule(legacyRule).textRegionType).toBe("schedule-table");
    expect(migrateRule({ ...legacyRule, textRegionType: "notes-block" }).textRegionType).toBe(
      "notes-numbered",
    );
    expect(migrateRule({ ...legacyRule, textRegionType: "key-value" }).textRegionType).toBe(
      "notes-key-value",
    );
  });

  it("preserves id, name, outputLabel, outputCsiCode, minConfidence", () => {
    const migrated = migrateRule(legacyRule);
    expect(migrated.id).toBe("door-schedule");
    expect(migrated.name).toBe("Door Schedule");
    expect(migrated.outputLabel).toBe("door-schedule");
    expect(migrated.outputCsiCode).toBe("08 11 16");
    expect(migrated.minConfidence).toBe(0.5);
  });

  it("preserves yoloRequired and yoloBoosters arrays", () => {
    const migrated = migrateRule(legacyRule);
    expect(migrated.yoloRequired).toEqual(["table"]);
    expect(migrated.yoloBoosters).toEqual(["grid"]);
  });

  it("is idempotent on already-new rules", () => {
    const newRule: HeuristicRule = {
      id: "custom-1",
      name: "Custom",
      source: "custom",
      enabled: true,
      yoloRequired: [],
      yoloBoosters: [],
      yoloAvailabilityMode: "degrade",
      textKeywordsRequired: ["FOO", "BAR"],
      textKeywordsBoosters: ["BAZ"],
      textKeywordsMode: "any-required",
      overlapRequired: false,
      outputLabel: "custom-1",
      minConfidence: 0.3,
    };
    const migrated = migrateRule(newRule);
    expect(migrated.textKeywordsRequired).toEqual(["FOO", "BAR"]);
    expect(migrated.textKeywordsBoosters).toEqual(["BAZ"]);
    expect(migrated.textKeywordsMode).toBe("any-required");
    expect(migrated.yoloAvailabilityMode).toBe("degrade");
  });

  it("handles missing textKeywords with empty required list", () => {
    const noKw: LegacyHeuristicRule = { ...legacyRule, textKeywords: undefined };
    const migrated = migrateRule(noKw);
    expect(migrated.textKeywordsRequired).toEqual([]);
    expect(migrated.textKeywordsBoosters).toEqual([]);
  });

  it("respects explicit yoloAvailabilityMode on legacy input", () => {
    const explicit: LegacyHeuristicRule = { ...legacyRule, yoloAvailabilityMode: "ignore" };
    expect(migrateRule(explicit).yoloAvailabilityMode).toBe("ignore");
  });

  it("falls back to empty arrays for missing spatial/csi fields", () => {
    const minimal: LegacyHeuristicRule = {
      id: "x",
      name: "X",
      source: "custom",
      enabled: true,
      yoloRequired: [],
      yoloBoosters: [],
      overlapRequired: false,
      outputLabel: "x",
      minConfidence: 0.1,
    };
    const migrated = migrateRule(minimal);
    expect(migrated.textKeywordsRequired).toEqual([]);
    expect(migrated.spatialConditions).toBeUndefined();
    expect(migrated.csiDivisionsRequired).toBeUndefined();
  });
});
