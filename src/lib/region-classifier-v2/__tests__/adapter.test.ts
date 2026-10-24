/**
 * adapter.test.ts — the legacy-vocabulary bridge and the (unread) preferRegionsV2 flag.
 */
import { describe, it, expect } from "vitest";
import {
  legacyCategoryOf, regionsV2ToClassifiedTables, resolvePreferRegionsV2,
  PREFER_REGIONS_V2_CONFIG_KEY, PREFER_REGIONS_V2_SETTING_KEY, REGIONS_V2_VERSION, REGION_CLASSES_HASH, UNCLASSIFIED,
  type RegionV2, type RegionsV2,
} from "..";

const region = (over: Partial<RegionV2>): RegionV2 => ({
  id: "rv2-00000001", kind: "table", anchor: "tables", bbox: [0.1, 0.2, 0.4, 0.6], anchorBbox: [0.1, 0.2, 0.4, 0.6],
  structureScore: 0.9, className: "door schedule", nameScore: 0.95,
  nameRaw: { best: "door schedule", score: 9.1, second: 2, hits: ["DOOR SCHEDULE"] },
  signals: {
    detConf: 0.85, areaCover: 1, textLines: 15, textRows: 5, textCols: 3, words: 42, textractTable: 1, tagShapes: 5,
    shapes: 0, legendColumn: false, keyShapes: false, scheduleWord: true, csiCodes: 2,
  },
  evidence: ["detector table box (conf 0.85)"], modelVersion: REGIONS_V2_VERSION, ...over,
});

const record = (regions: RegionV2[]): RegionsV2 => ({
  version: REGIONS_V2_VERSION, classesHash: REGION_CLASSES_HASH, regions,
  stats: { rawTables: 1, rawLegends: 0, rawTextBoxes: 0, inTitleBlock: 0, labelsDropped: 0, merged: 0 },
});

describe("legacyCategoryOf", () => {
  it("maps the fine classes onto the eight legacy categories", () => {
    expect(legacyCategoryOf({ kind: "table", className: "door schedule" })).toBe("door-schedule");
    expect(legacyCategoryOf({ kind: "table", className: "finish schedule" })).toBe("finish-schedule");
    expect(legacyCategoryOf({ kind: "table", className: "lighting fixture schedule" })).toBe("material-schedule");
    expect(legacyCategoryOf({ kind: "table", className: "drawing list" })).toBe("material-schedule");
    expect(legacyCategoryOf({ kind: "table", className: UNCLASSIFIED })).toBe("unknown-table");
    expect(legacyCategoryOf({ kind: "legend", className: "symbol legend" })).toBe("symbol-legend");
    expect(legacyCategoryOf({ kind: "legend", className: UNCLASSIFIED })).toBe("symbol-legend");
    expect(legacyCategoryOf({ kind: "keynotes", className: "keynotes" })).toBe("keynote-table");
    expect(legacyCategoryOf({ kind: "notes", className: "code / life-safety notes" })).toBe("general-notes");
    expect(legacyCategoryOf({ kind: "notes", className: "specification text" })).toBe("spec-text");
    expect(legacyCategoryOf({ kind: "notes", className: UNCLASSIFIED })).toBeNull();
  });
});

describe("regionsV2ToClassifiedTables", () => {
  it("emits ClassifiedTable rows: LTWH bbox, stable id, structure × name confidence, provenance evidence", () => {
    const [t] = regionsV2ToClassifiedTables(record([region({})]), 7);
    expect(t).toMatchObject({
      id: "rv2-00000001", type: "schedule-table", category: "door-schedule", pageNumber: 7, isPageSpecific: true,
      wordCount: 42, headerText: "door schedule",
    });
    expect(t.bbox.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(t.confidence).toBeCloseTo(0.9 * 0.95, 3);
    expect(t.evidence[0]).toBe(`region-classifier-v2 ${REGIONS_V2_VERSION}`);
    expect(t.evidence).toContain("detector table box (conf 0.85)");
  });

  it("an unclassified table keeps its structure score as unknown-table; an unclassified notes box is omitted", () => {
    const out = regionsV2ToClassifiedTables(record([
      region({ id: "a", className: UNCLASSIFIED, nameScore: 0.1 }),
      region({ id: "b", kind: "notes", anchor: "text_box", className: UNCLASSIFIED }),
      region({ id: "c", kind: "keynotes", anchor: "text_box", className: "keynotes", structureScore: 0.6, nameScore: 0.63 }),
    ]), 1);
    expect(out.map((t) => [t.id, t.category, t.type])).toEqual([["a", "unknown-table", "schedule-table"], ["c", "keynote-table", "paragraph"]]);
    expect(out[0].confidence).toBe(0.9);
    expect(out[0].headerText).toBeUndefined();
    expect(out[1].confidence).toBeCloseTo(0.6 * 0.63, 3);
  });

  it("a weakly named class never drops below half its structure score; empty input → []", () => {
    const [t] = regionsV2ToClassifiedTables(record([region({ nameScore: 0.2 })]), 1);
    expect(t.confidence).toBeCloseTo(0.45, 3);
    expect(regionsV2ToClassifiedTables(undefined, 1)).toEqual([]);
    expect(regionsV2ToClassifiedTables(null, 1)).toEqual([]);
  });
});

describe("resolvePreferRegionsV2 — default false; company flag over root setting", () => {
  it("defaults to false", () => {
    expect(resolvePreferRegionsV2({})).toBe(false);
    expect(resolvePreferRegionsV2({ pipelineConfig: null, appSetting: undefined })).toBe(false);
    expect(resolvePreferRegionsV2({ pipelineConfig: { [PREFER_REGIONS_V2_CONFIG_KEY]: "yes" } })).toBe(false); // not a boolean
  });
  it("reads the company boolean, else the root app setting ({value} or bare)", () => {
    expect(resolvePreferRegionsV2({ pipelineConfig: { [PREFER_REGIONS_V2_CONFIG_KEY]: true } })).toBe(true);
    expect(resolvePreferRegionsV2({ pipelineConfig: { [PREFER_REGIONS_V2_CONFIG_KEY]: false }, appSetting: { value: true } })).toBe(false);
    expect(resolvePreferRegionsV2({ pipelineConfig: {}, appSetting: { value: true } })).toBe(true);
    expect(resolvePreferRegionsV2({ appSetting: true })).toBe(true);
    expect(PREFER_REGIONS_V2_SETTING_KEY).toBe("region_classifier_v2:prefer");
  });
});
