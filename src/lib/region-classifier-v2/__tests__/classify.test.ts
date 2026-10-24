/**
 * classify.test.ts — the detector-first classifier end to end on a synthetic sheet: title-block
 * drop, widening, structure signals, L2 naming, kinds, dedupe/folding, determinism and the
 * stored-shape guard. Pure: no DB.
 */
import { describe, it, expect } from "vitest";
import type { BboxMinMax, CsiCode, TextractWord } from "@/types";
import { computePageZones } from "@/lib/page-zones";
import {
  classifyRegionsV2, isRegionsV2, storedRegionsV2, tableStructureScore, textStructureScore,
  REGIONS_V2_VERSION, REGION_CLASSES_HASH, UNCLASSIFIED,
  type RegionDetection, type RegionV2Signals,
} from "..";

const det = (name: string, [minX, minY, maxX, maxY]: BboxMinMax, modelName = "yolo_medium", confidence = 0.8): RegionDetection =>
  ({ name, minX, minY, maxX, maxY, modelName, confidence });

/** OCR words laid out in a grid inside `box` (LTWH words, as Textract stores them). */
function wordsIn(box: BboxMinMax, texts: string[], cols = 3): TextractWord[] {
  const [x0, y0, x1, y1] = box;
  const rows = Math.ceil(texts.length / cols);
  return texts.map((text, i) => ({
    text, confidence: 99,
    bbox: [x0 + ((i % cols) + 0.1) * ((x1 - x0) / cols), y0 + (Math.floor(i / cols) + 0.1) * ((y1 - y0) / rows), 0.01, 0.005],
  }));
}

/** yolo_text line boxes forming rows × cols inside `box`. */
function textLines(box: BboxMinMax, rows: number, cols: number): RegionDetection[] {
  const [x0, y0, x1, y1] = box;
  const out: RegionDetection[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = x0 + (c + 0.1) * ((x1 - x0) / cols);
    const y = y0 + (r + 0.1) * ((y1 - y0) / rows);
    out.push(det("text_box", [x, y, x + 0.02, y + 0.008], "yolo_text", 0.9));
  }
  return out;
}

const TITLE: BboxMinMax = [0.88, 0.02, 0.99, 0.98];
const SCHEDULE: BboxMinMax = [0.1, 0.1, 0.4, 0.3];
const REVISIONS: BboxMinMax = [0.89, 0.8, 0.98, 0.95]; // a "tables" box inside the title block
const LEGEND: BboxMinMax = [0.1, 0.7, 0.3, 0.9];
const NOTES: BboxMinMax = [0.5, 0.1, 0.8, 0.5];

const DOOR_WORDS = ["DOOR", "SCHEDULE", "MARK", "SIZE", "FRAME", "HARDWARE", "HM", "WD", "RATING", "101", "102", "103"];
const KEYNOTE_WORDS = ["KEYNOTES", "1", "PROVIDE", "NEW", "GWB", "2", "PATCH", "EXISTING", "3", "VERIFY", "IN", "FIELD"];

const sheet = (): RegionDetection[] => [
  det("title_block", TITLE, "yolo_medium", 0.95),
  det("tables", SCHEDULE, "yolo_medium", 0.85),
  det("tables", REVISIONS, "yolo_medium", 0.7),
  det("symbol_legend", LEGEND, "yolo_medium", 0.75),
  det("text_box", NOTES, "yolo_medium", 0.8),
  det("grid", [0.1, 0.1, 0.4, 0.3], "yolo_primitive", 0.8), // area box over the schedule
  det("drawings", [0.05, 0.35, 0.85, 0.95], "yolo_medium", 0.9),
  // tag shapes in the schedule, key shapes in the legend column
  ...[0.12, 0.14, 0.16, 0.18, 0.2].map((x) => det("circle", [x, 0.2, x + 0.01, 0.21], "yolo_primitive", 0.8)),
  ...[0.72, 0.75, 0.78, 0.81].map((y) => det("hexagon", [0.11, y, 0.12, y + 0.01], "yolo_primitive", 0.8)),
  ...textLines(SCHEDULE, 5, 3),
];

const words = (): TextractWord[] => [
  ...wordsIn(SCHEDULE, DOOR_WORDS),
  ...wordsIn(LEGEND, ["LEGEND", "DENOTES", "NEW", "WALL", "EXISTING", "TO", "REMAIN", "SYMBOL", "DESCRIPTION", "A", "B", "C"]),
  ...wordsIn(NOTES, KEYNOTE_WORDS),
  ...wordsIn([0.89, 0.1, 0.98, 0.3], ["ARCHITECTURAL", "DOOR", "SCHEDULES"]), // title-block OCR
];

const csi = (): CsiCode[] => [
  { code: "08 11 13", description: "", trade: "", division: "08 00 00", triggers: [{ text: "HM", tier: 1, bbox: [0.15, 0.15, 0.01, 0.005] }] },
  { code: "08 71 00", description: "", trade: "", division: "08 00 00", triggers: [{ text: "HARDWARE", tier: 1, bbox: [0.2, 0.15, 0.01, 0.005] }] },
];

describe("classifyRegionsV2 — a synthetic sheet", () => {
  const out = classifyRegionsV2({
    pageNumber: 7, detections: sheet(), textractData: { words: words(), tables: [{ bbox: [0.1, 0.1, 0.3, 0.2], cells: [], rowCount: 5, colCount: 3 }] }, csiCodes: csi(),
  });
  const byAnchor = (a: string) => out.regions.filter((r) => r.anchor === a);

  it("stamps version + classes hash and counts anchors", () => {
    expect(out.version).toBe(REGIONS_V2_VERSION);
    expect(out.classesHash).toBe(REGION_CLASSES_HASH);
    expect(out.stats).toMatchObject({ rawTables: 2, rawLegends: 1, rawTextBoxes: 1, inTitleBlock: 1 });
  });

  it("drops the tables box inside the detected title block (revision grid) and keeps the schedule", () => {
    const tables = byAnchor("tables");
    expect(tables).toHaveLength(1);
    expect(tables[0].anchorBbox).toEqual(SCHEDULE);
    expect(tables[0].kind).toBe("table");
  });

  it("names the schedule from the words + CSI inside and the title-block prior", () => {
    const t = byAnchor("tables")[0];
    expect(t.className).toBe("door schedule");
    expect(t.nameScore).toBeGreaterThan(0.9);
    expect(t.nameRaw.best).toBe("door schedule");
    expect(t.nameRaw.hits).toContain("DOOR SCHEDULE");
    expect(t.evidence.join(" | ")).toMatch(/title block says DOOR/);
    expect(t.evidence.join(" | ")).toMatch(/5 shape tags inside/);
    expect(t.signals).toMatchObject({ detConf: 0.85, tagShapes: 5, csiCodes: 2, textLines: 15, textRows: 5, textCols: 3, words: 12, scheduleWord: true });
    expect(t.signals.textractTable).toBeCloseTo(1, 5); // the Textract table lies inside the box
    expect(t.signals.areaCover).toBe(1);
    expect(t.structureScore).toBeGreaterThan(0.9);
    expect(t.modelVersion).toBe(REGIONS_V2_VERSION);
  });

  it("the legend keeps kind legend; the key-shape column raises its structure", () => {
    const l = byAnchor("symbol_legend")[0];
    expect(l.kind).toBe("legend");
    expect(l.className).toBe("symbol legend");
    expect(l.signals).toMatchObject({ shapes: 4, keyShapes: true, legendColumn: true });
    expect(l.structureScore).toBeGreaterThan(textStructureScore({ ...l.signals, shapes: 0, keyShapes: false, legendColumn: false }));
  });

  it("a text_box whose words say KEYNOTES becomes kind keynotes", () => {
    const n = byAnchor("text_box")[0];
    expect(n.kind).toBe("keynotes");
    expect(n.className).toBe("keynotes");
  });

  it("ids are stable per page + anchor box, and the output is deterministic", () => {
    const again = classifyRegionsV2({ pageNumber: 7, detections: sheet(), textractData: { words: words() }, csiCodes: csi() });
    expect(again.regions.map((r) => r.id)).toEqual(out.regions.map((r) => r.id));
    expect(out.regions.every((r) => /^rv2-[0-9a-f]{8}$/.test(r.id))).toBe(true);
    const other = classifyRegionsV2({ pageNumber: 8, detections: sheet(), textractData: { words: words() } });
    expect(other.regions[0].id).not.toBe(out.regions[0].id);
  });

  it("accepts the caller's zones (pageZones) instead of recomputing them", () => {
    const zones = computePageZones(sheet());
    const withZones = classifyRegionsV2({ pageNumber: 7, detections: sheet(), zones, textractData: { words: words() }, csiCodes: csi() });
    expect(withZones.stats.inTitleBlock).toBe(1);
    // a fixed-fallback zone (no title block detected) drops only what sits in the legacy corner
    const noTitle = classifyRegionsV2({ pageNumber: 7, detections: sheet().filter((d) => d.name !== "title_block"), textractData: { words: words() } });
    expect(noTitle.stats.inTitleBlock).toBe(1); // REVISIONS lies in {.45,.7,1,1} too
  });

  it("drops against EVERY yolo_medium title_block detection, not only the zone's best one", () => {
    // a second, weaker title block (agency stamp) top-left with a tables box inside it
    const stamp: BboxMinMax = [0.02, 0.02, 0.2, 0.08];
    const dets = [...sheet(), det("title_block", stamp, "yolo_medium", 0.4), det("tables", [0.03, 0.03, 0.18, 0.07], "yolo_medium", 0.8)];
    const out = classifyRegionsV2({ pageNumber: 7, detections: dets, textractData: { words: words() } });
    expect(computePageZones(dets).titleBlock).toEqual(TITLE); // zones still pick the strongest
    expect(out.stats).toMatchObject({ rawTables: 3, inTitleBlock: 2 });
    expect(out.regions.filter((r) => r.anchor === "tables").map((r) => r.anchorBbox)).toEqual([SCHEDULE]);
    // a custom model's title_block does not drop anything
    const custom = [...sheet(), det("title_block", stamp, "acme_custom", 0.9), det("tables", [0.03, 0.03, 0.18, 0.07], "yolo_medium", 0.8)];
    expect(classifyRegionsV2({ pageNumber: 7, detections: custom }).stats.inTitleBlock).toBe(1);
  });
});

describe("classifyRegionsV2 — edges", () => {
  it("no yolo_medium detections ⇒ an empty record (yolo_text / yolo_primitive alone propose nothing)", () => {
    const out = classifyRegionsV2({ pageNumber: 1, detections: [det("grid", SCHEDULE, "yolo_primitive"), ...textLines(SCHEDULE, 4, 3)] });
    expect(out.regions).toEqual([]);
    expect(out.stats).toEqual({ rawTables: 0, rawLegends: 0, rawTextBoxes: 0, inTitleBlock: 0, labelsDropped: 0, merged: 0 });
  });

  it("a table with no words is unclassified but kept; SCHEDULE alone stays unclassified too", () => {
    const bare = classifyRegionsV2({ pageNumber: 1, detections: [det("tables", SCHEDULE)] });
    expect(bare.regions[0]).toMatchObject({ kind: "table", className: UNCLASSIFIED, signals: { words: 0 } });
    const sched = classifyRegionsV2({ pageNumber: 1, detections: [det("tables", SCHEDULE)], textractData: { words: wordsIn(SCHEDULE, ["SCHEDULE", "A", "B"]) } });
    expect(sched.regions[0]).toMatchObject({ className: UNCLASSIFIED, signals: { scheduleWord: true } });
    expect(sched.regions[0].evidence.at(-1)).toMatch(/SCHEDULE inside/);
  });

  it("duplicate table boxes (IoU ≥ .6) collapse to the stronger one", () => {
    const out = classifyRegionsV2({ pageNumber: 1, detections: [det("tables", SCHEDULE, "yolo_medium", 0.6), det("tables", [0.11, 0.1, 0.4, 0.31], "yolo_medium", 0.9)] });
    expect(out.regions).toHaveLength(1);
    expect(out.regions[0].signals.detConf).toBe(0.9);
    expect(out.stats.merged).toBe(1);
  });

  it("a text box ≥ 80 % inside a kept legend folds into it (a near-identical one is a duplicate first)", () => {
    const dup = classifyRegionsV2({ pageNumber: 1, detections: [det("symbol_legend", LEGEND), det("text_box", [0.12, 0.72, 0.28, 0.88])] });
    expect(dup.regions.map((r) => r.anchor)).toEqual(["symbol_legend"]); // IoU .64 ≥ .6 ⇒ duplicate, as in regions_rc2.py
    expect(dup.stats.merged).toBe(1);
    const out = classifyRegionsV2({
      pageNumber: 1,
      detections: [det("symbol_legend", LEGEND), det("text_box", [0.12, 0.72, 0.2, 0.8])],
      textractData: { words: wordsIn(LEGEND, Array.from({ length: 12 }, (_, i) => `W${i}`)) },
    });
    expect(out.regions.map((r) => r.anchor)).toEqual(["symbol_legend"]);
    expect(out.regions[0].evidence).toContain("text box folded in");
    expect(out.stats.merged).toBe(1);
  });

  it("text boxes the fallback calls page labels are dropped; untitled notes and spec text are kept", () => {
    const label = classifyRegionsV2({ pageNumber: 1, detections: [det("text_box", NOTES)], textractData: { words: wordsIn(NOTES, ["ROOM", "101"]) } });
    expect(label.regions).toEqual([]);
    expect(label.stats.labelsDropped).toBe(1);
    const notes = ["CONTRACTOR", "SHALL", "VERIFY", "ALL", ...Array.from({ length: 20 }, (_, i) => `X${i}`)];
    const untitled = classifyRegionsV2({ pageNumber: 1, detections: [det("text_box", NOTES)], textractData: { words: wordsIn(NOTES, notes) } });
    expect(untitled.regions[0]).toMatchObject({ kind: "notes", className: "notes (untitled)" });
    const unknown = classifyRegionsV2({ pageNumber: 1, detections: [det("text_box", NOTES)], textractData: { words: wordsIn(NOTES, Array.from({ length: 12 }, (_, i) => `ZQ${"X".repeat(i)}`)) } });
    expect(unknown.regions[0]).toMatchObject({ kind: "notes", className: UNCLASSIFIED });
  });

  it("a text box over a kept table is table text, not a notes region", () => {
    const out = classifyRegionsV2({
      pageNumber: 1,
      detections: [det("tables", SCHEDULE), det("text_box", [0.1, 0.1, 0.4, 0.3])],
      textractData: { words: wordsIn(SCHEDULE, DOOR_WORDS) },
    });
    expect(out.regions.map((r) => r.anchor)).toEqual(["tables"]);
    expect(out.stats.merged).toBe(1);
  });

  it("malformed detections are skipped, never thrown on", () => {
    const out = classifyRegionsV2({ pageNumber: 1, detections: [det("tables", [0.5, 0.5, 0.4, 0.6]), { name: "tables", minX: NaN, minY: 0, maxX: 1, maxY: 1, modelName: "yolo_medium" }] });
    expect(out.regions).toEqual([]);
  });
});

describe("structure scores", () => {
  const base: RegionV2Signals = {
    detConf: 0.8, areaCover: 0, textLines: 0, textRows: 0, textCols: 0, words: 0, textractTable: 0, tagShapes: 0,
    shapes: 0, legendColumn: false, keyShapes: false, scheduleWord: false, csiCodes: 0,
  };
  it("detector confidence carries the most weight; each measured signal adds; lined/ct are not inputs", () => {
    const conf = tableStructureScore(base);
    expect(tableStructureScore({ ...base, detConf: 0.4 })).toBeLessThan(conf);
    expect(tableStructureScore({ ...base, textRows: 6, textCols: 3 })).toBeGreaterThan(conf);
    expect(tableStructureScore({ ...base, words: 100 })).toBeGreaterThan(conf);
    expect(tableStructureScore({ ...base, textractTable: 1 })).toBeGreaterThan(conf);
    expect(tableStructureScore({ ...base, areaCover: 1 })).toBeGreaterThan(conf);
    expect(tableStructureScore({ ...base, tagShapes: 5 })).toBeGreaterThan(conf);
    const full = tableStructureScore({ ...base, textRows: 6, textCols: 3, words: 100, textractTable: 1, areaCover: 1, tagShapes: 5 });
    expect(full).toBeGreaterThan(0.95);
    expect(full).toBeLessThanOrEqual(1);
    expect(tableStructureScore({ ...base, detConf: 0 })).toBeLessThan(0.1);
    expect(Object.keys(base)).not.toContain("lined");
  });
  it("legend / notes: shapes and the legend column or key shapes add", () => {
    const conf = textStructureScore(base);
    expect(textStructureScore({ ...base, shapes: 6 })).toBeGreaterThan(conf);
    expect(textStructureScore({ ...base, keyShapes: true })).toBeGreaterThan(conf);
    expect(textStructureScore({ ...base, legendColumn: true })).toBe(textStructureScore({ ...base, keyShapes: true }));
  });
});

describe("stored-shape guard", () => {
  it("accepts a round-tripped record and rejects junk", () => {
    const out = classifyRegionsV2({ pageNumber: 1, detections: [det("tables", SCHEDULE)] });
    const stored = JSON.parse(JSON.stringify({ parsedRegions: [], regionsV2: out }));
    expect(storedRegionsV2(stored)).toEqual(out);
    expect(isRegionsV2({ version: "x" })).toBe(false);
    expect(isRegionsV2({ ...out, regions: [{ kind: "table" }] })).toBe(false);
    expect(storedRegionsV2(null)).toBeUndefined();
    expect(storedRegionsV2({ regionsV2: [] })).toBeUndefined();
  });
});
