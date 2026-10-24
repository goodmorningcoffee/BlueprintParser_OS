/**
 * page-zones.test.ts — the detector-zone layer (T2, 2026-10-24). Pure: no DB, no KB.
 *
 * Pins (a) the fixed-fallback contract — no `title_block` detection ⇒ byte-identical to
 * `DEFAULT_TITLE_BLOCK_REGION`, so pages without YOLO behave as before; (b) the ≥ 70 %
 * containment rule; (c) zoneOf precedence; (d) the stored-shape guard.
 */
import { describe, it, expect } from "vitest";
import {
  computePageZones,
  containmentRatio,
  isInsideZone,
  isPageZones,
  zoneOf,
  FIXED_TITLE_BLOCK_ZONE,
  ZONE_CONTAINMENT_THRESHOLD,
  type PageZoneDetection,
} from "@/lib/page-zones";
import { DEFAULT_TITLE_BLOCK_REGION } from "@/lib/spatial-constants";
import type { BboxMinMax } from "@/types";

const det = (
  name: string,
  [minX, minY, maxX, maxY]: BboxMinMax,
  extra: Partial<PageZoneDetection> = {},
): PageZoneDetection => ({ name, minX, minY, maxX, maxY, ...extra });

// A typical sheet: title block strip along the right edge (NOT the fixed bottom-right corner),
// one big plan, a door schedule inset in the top-left, a legend bottom-left.
const TITLE: BboxMinMax = [0.88, 0.02, 0.99, 0.98];
const PLAN: BboxMinMax = [0.05, 0.05, 0.85, 0.95];
const SCHEDULE: BboxMinMax = [0.06, 0.06, 0.3, 0.3];
const LEGEND: BboxMinMax = [0.06, 0.8, 0.25, 0.94];
const SHEET = [
  det("title_block", TITLE, { confidence: 0.91, modelName: "yolo_medium" }),
  det("drawings", PLAN, { confidence: 0.8, modelName: "yolo_medium" }),
  det("tables", SCHEDULE, { confidence: 0.77, modelName: "yolo_medium" }),
  det("symbol_legend", LEGEND, { confidence: 0.7, modelName: "yolo_medium" }),
  det("text_box", [0.5, 0.5, 0.52, 0.51], { confidence: 0.9, modelName: "yolo_text" }),
  det("door_single", [0.4, 0.4, 0.42, 0.43], { confidence: 0.6, modelName: "yolo_medium" }),
];

describe("computePageZones — fixed fallback", () => {
  it("no detections at all ⇒ today's fixed zone, source fixed-fallback", () => {
    for (const input of [undefined, null, []] as const) {
      const z = computePageZones(input);
      expect(z.source).toBe("fixed-fallback");
      expect(z.titleBlock).toEqual([
        DEFAULT_TITLE_BLOCK_REGION.minX, DEFAULT_TITLE_BLOCK_REGION.minY,
        DEFAULT_TITLE_BLOCK_REGION.maxX, DEFAULT_TITLE_BLOCK_REGION.maxY,
      ]);
      expect(z.titleBlock).toEqual(FIXED_TITLE_BLOCK_ZONE);
      expect(z.drawings).toEqual([]);
      expect(z.tables).toEqual([]);
      expect(z.legends).toEqual([]);
    }
  });

  it("the fixed constant is exactly {.45,.7,1,1} — the value every legacy consumer used", () => {
    expect(FIXED_TITLE_BLOCK_ZONE).toEqual([0.45, 0.7, 1, 1]);
  });

  it("detections without a title_block keep their drawings/tables/legends but fall back for the title block", () => {
    const z = computePageZones(SHEET.filter((d) => d.name !== "title_block"));
    expect(z.source).toBe("fixed-fallback");
    expect(z.titleBlock).toEqual(FIXED_TITLE_BLOCK_ZONE);
    expect(z.drawings).toEqual([PLAN]);
    expect(z.tables).toEqual([SCHEDULE]);
    expect(z.legends).toEqual([LEGEND]);
  });

  it("returns a fresh copy of the fixed zone each call (callers may not alias the constant)", () => {
    const a = computePageZones([]);
    const b = computePageZones([]);
    expect(a.titleBlock).not.toBe(b.titleBlock);
    expect(a.titleBlock).not.toBe(FIXED_TITLE_BLOCK_ZONE);
  });
});

describe("computePageZones — detector source", () => {
  it("maps the four yolo_medium classes and ignores every other class", () => {
    const z = computePageZones(SHEET);
    expect(z.source).toBe("detector");
    expect(z.titleBlock).toEqual(TITLE);
    expect(z.drawings).toEqual([PLAN]);
    expect(z.tables).toEqual([SCHEDULE]);
    expect(z.legends).toEqual([LEGEND]);
  });

  it("ignores detections from a yolo_text model even when the class name matches", () => {
    const z = computePageZones([
      det("title_block", TITLE, { modelName: "yolo_text_v3" }),
      det("tables", SCHEDULE, { modelName: "yolo_text" }),
    ]);
    expect(z.source).toBe("fixed-fallback");
    expect(z.tables).toEqual([]);
  });

  it("picks the highest-confidence title block; ties go to the bottom-right-most box", () => {
    const small: BboxMinMax = [0.9, 0.9, 0.99, 0.99];
    const byConf = computePageZones([
      det("title_block", small, { confidence: 0.95 }),
      det("title_block", TITLE, { confidence: 0.6 }),
    ]);
    expect(byConf.titleBlock).toEqual(small);

    const topLeft: BboxMinMax = [0.0, 0.0, 0.3, 0.1];
    const tie = computePageZones([
      det("title_block", topLeft), // confidence undefined ⇒ 0 for both
      det("title_block", small),
    ]);
    expect(tie.titleBlock).toEqual(small);
    // and the first-seen box is kept when a later one is NOT further bottom-right
    const tie2 = computePageZones([det("title_block", small), det("title_block", topLeft)]);
    expect(tie2.titleBlock).toEqual(small);
  });

  it("drops degenerate or non-finite boxes instead of producing NaN zones", () => {
    const z = computePageZones([
      det("tables", [0.5, 0.5, 0.5, 0.6]),
      det("tables", [0.2, 0.2, 0.1, 0.3]),
      det("title_block", [Number.NaN, 0, 1, 1]),
      det("drawings", [0.1, 0.1, 0.9, 0.9]),
    ]);
    expect(z.tables).toEqual([]);
    expect(z.source).toBe("fixed-fallback");
    expect(z.drawings).toEqual([[0.1, 0.1, 0.9, 0.9]]);
  });
});

describe("containment", () => {
  const zone: BboxMinMax = [0.5, 0.5, 1, 1];

  it("containmentRatio is the fraction of the INNER box inside the zone", () => {
    expect(containmentRatio([0.6, 0.6, 0.8, 0.8], zone)).toBeCloseTo(1);
    expect(containmentRatio([0.4, 0.6, 0.6, 0.8], zone)).toBeCloseTo(0.5);
    expect(containmentRatio([0, 0, 0.4, 0.4], zone)).toBe(0);
    expect(containmentRatio([0.6, 0.6, 0.6, 0.8], zone)).toBe(0); // degenerate inner
  });

  it("isInsideZone uses the ≥ 70 % rule (not full containment, not centre-in)", () => {
    expect(ZONE_CONTAINMENT_THRESHOLD).toBe(0.7);
    // 75 % inside — a schedule slightly overhanging the title block still counts
    expect(isInsideZone([0.45, 0.6, 0.65, 1.0], zone)).toBe(true);
    // 50 % inside — not inside
    expect(isInsideZone([0.4, 0.6, 0.6, 0.8], zone)).toBe(false);
    // 69 % inside — just under the line
    expect(isInsideZone([0.438, 0.6, 0.638, 0.8], zone)).toBe(false);
  });
});

describe("zoneOf", () => {
  const zones = computePageZones(SHEET);

  it("classifies boxes by the zone that contains ≥ 70 % of them", () => {
    expect(zoneOf(zones, [0.9, 0.9, 0.98, 0.95])).toBe("title_block");
    expect(zoneOf(zones, [0.1, 0.1, 0.2, 0.2])).toBe("table");
    expect(zoneOf(zones, [0.08, 0.82, 0.2, 0.9])).toBe("legend");
    expect(zoneOf(zones, [0.4, 0.4, 0.6, 0.6])).toBe("drawing");
  });

  it("precedence: title_block > table > legend > drawing (an inset schedule is still a table)", () => {
    // SCHEDULE and LEGEND both sit inside PLAN
    expect(zoneOf(zones, SCHEDULE)).toBe("table");
    expect(zoneOf(zones, LEGEND)).toBe("legend");
    // a table detected inside the title block (51 % of corpus tables) is title_block
    const z2 = computePageZones([
      det("title_block", [0.5, 0.7, 1, 1]),
      det("tables", [0.6, 0.75, 0.9, 0.95]),
    ]);
    expect(zoneOf(z2, [0.62, 0.78, 0.88, 0.9])).toBe("title_block");
  });

  it("outside every zone: margin in the outer 3 % band, otherwise notes", () => {
    expect(zoneOf(zones, [0.86, 0.3, 0.87, 0.5])).toBe("notes"); // gutter between plan and title strip
    expect(zoneOf(zones, [0.0, 0.3, 0.02, 0.5])).toBe("margin");
    expect(zoneOf(zones, [0.3, 0.985, 0.6, 0.995])).toBe("margin");
  });

  it("with fixed-fallback zones the fixed corner is title_block and everything else is notes/margin", () => {
    const fb = computePageZones([]);
    expect(zoneOf(fb, [0.6, 0.8, 0.9, 0.95])).toBe("title_block");
    expect(zoneOf(fb, [0.1, 0.1, 0.5, 0.5])).toBe("notes");
    expect(zoneOf(fb, [0.5, 0.0, 0.6, 0.02])).toBe("margin");
  });
});

describe("isPageZones (stored jsonb guard)", () => {
  it("accepts what computePageZones emits, both sources", () => {
    expect(isPageZones(computePageZones(SHEET))).toBe(true);
    expect(isPageZones(computePageZones([]))).toBe(true);
    expect(isPageZones(JSON.parse(JSON.stringify(computePageZones(SHEET))))).toBe(true);
  });

  it("rejects malformed values", () => {
    expect(isPageZones(null)).toBe(false);
    expect(isPageZones([])).toBe(false);
    expect(isPageZones({ titleBlock: null, drawings: [], tables: [], legends: [] })).toBe(false);
    expect(isPageZones({ titleBlock: [0, 0, 1], drawings: [], tables: [], legends: [], source: "detector" })).toBe(false);
    expect(isPageZones({ titleBlock: null, drawings: [[0, 0, 1, "1"]], tables: [], legends: [], source: "detector" })).toBe(false);
    expect(isPageZones({ titleBlock: null, drawings: [], tables: [], legends: [], source: "yolo" })).toBe(false);
  });
});
