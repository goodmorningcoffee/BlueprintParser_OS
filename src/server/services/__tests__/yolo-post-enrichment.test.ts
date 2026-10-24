// [fix 2026-10-24 T1a] The post-YOLO page pass (extracted from services/yolo.ts yoloLoad). Real
// engine, composite classifier, heatmap and ensemble; only the table classifier is a stub, so its
// CSI input can be read back.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HeuristicRule } from "@/lib/heuristic-engine";
import type { CsiCode } from "@/types";

const spy = vi.hoisted(() => ({ classifyTables: vi.fn() }));
vi.mock("@/lib/table-classifier", () => ({ classifyTables: spy.classifyTables }));

import {
  enrichPageAfterYolo,
  type PostYoloDetection,
} from "@/server/services/yolo-post-enrichment";

const DOORS: CsiCode = { code: "08 11 16", description: "Aluminum Doors and Frames", trade: "Openings", division: "08 00 00" };

/** A custom rule gated ONLY on the page carrying a Division 08 code. */
const div08Rule: HeuristicRule = {
  id: "div08", name: "Div 08 page", source: "custom", enabled: true,
  yoloRequired: [], yoloBoosters: [], yoloAvailabilityMode: "require",
  textKeywordsRequired: ["OPENINGS"], textKeywordsBoosters: [], textKeywordsMode: "any-required",
  overlapRequired: false, csiDivisionsRequired: ["08"],
  outputLabel: "openings-page", minConfidence: 0.1,
};

const det = (name: string, modelName: string, x: number, y: number, confidence = 0.8): PostYoloDetection => ({
  name, modelName, confidence, minX: x, minY: y, maxX: x + 0.04, maxY: y + 0.02,
});

const opts = (rules: HeuristicRule[] = [div08Rule]) => ({
  rules, heatmapEnabled: true, ensembleEnabled: true, ensembleConfig: undefined,
});

beforeEach(() => {
  spy.classifyTables.mockReset();
  spy.classifyTables.mockReturnValue([]);
});

describe("enrichPageAfterYolo — CSI codes come from pages.csiCodes", () => {
  const page = (csiCodes: CsiCode[] | null) => ({
    pageNumber: 3,
    rawText: "OPENINGS",
    // pageIntelligence has NO csiCodes key — the old code read it from here and got undefined.
    pageIntelligence: {
      textRegions: [{ id: "r1", type: "schedule-table", bbox: [0.1, 0.1, 0.3, 0.3], headerText: "DOOR SCHEDULE", confidence: 0.9, wordCount: 30, lineCount: 6 }],
    },
    csiCodes,
  });

  it("a CSI-division rule fires when the page's csiCodes carry the division", () => {
    const { updated, pageChanged } = enrichPageAfterYolo(page([DOORS]), [det("tables", "yolo_medium", 0.1, 0.1)], opts());
    expect(pageChanged).toBe(true);
    const inferences = updated.heuristicInferences as Array<{ ruleId: string; evidence: string[] }>;
    expect(inferences.map((i) => i.ruleId)).toEqual(["div08"]);
    expect(inferences[0].evidence).toContain("CSI division: 08");
  });

  it("…and does not fire without them (no stale pageIntelligence.csiCodes fallback)", () => {
    const p = page(null);
    (p.pageIntelligence as Record<string, unknown>).csiCodes = [DOORS]; // a decoy at the wrong path
    const { updated } = enrichPageAfterYolo(p, [det("tables", "yolo_medium", 0.1, 0.1)], opts());
    expect(updated.heuristicInferences).toBeUndefined();
  });

  it("the table reclassifier gets the same page csiCodes", () => {
    enrichPageAfterYolo(page([DOORS]), [det("tables", "yolo_medium", 0.1, 0.1)], opts());
    expect(spy.classifyTables).toHaveBeenCalledTimes(1);
    expect(spy.classifyTables.mock.calls[0][0].csiCodes).toEqual([DOORS]);
  });
});

describe("enrichPageAfterYolo — heatmap layout classes are model-scoped", () => {
  const page = { pageNumber: 1, rawText: "", pageIntelligence: {}, csiCodes: [] };
  const layout = [
    det("text_box", "yolo_medium", 0.05, 0.05, 0.9),
    det("vertical_area", "yolo_primitive", 0.06, 0.05, 0.9),
    det("horizontal_area", "yolo_primitive", 0.05, 0.06, 0.9),
  ];
  // yolo_text emits one text_box per word cluster, spread over the sheet
  const words = Array.from({ length: 300 }, (_, i) =>
    det("text_box", "yolo_text", 0.3 + (i % 20) * 0.03, 0.3 + Math.floor(i / 20) * 0.04, 0.95));

  it("yolo_text text_box boxes do not change the heatmap", () => {
    const base = enrichPageAfterYolo(page, layout, opts([])).updated.yoloHeatmap;
    const flooded = enrichPageAfterYolo(page, [...layout, ...words], opts([])).updated.yoloHeatmap;
    expect(base).toBeDefined();
    expect(flooded).toEqual(base);
  });

  it("legacy rows without a modelName still count", () => {
    const legacy = layout.map(({ modelName: _drop, ...d }) => d);
    const heatmap = enrichPageAfterYolo(page, legacy, opts([])).updated.yoloHeatmap as {
      classContributions: Record<string, number>;
    };
    expect(heatmap.classContributions.text_box).toBeGreaterThan(0);
  });

  it("heatmapEnabled=false skips it", () => {
    const { updated } = enrichPageAfterYolo(page, layout, { ...opts([]), heatmapEnabled: false });
    expect(updated.yoloHeatmap).toBeUndefined();
  });
});

describe("enrichPageAfterYolo — [evidence T4] evidence summary", () => {
  const textractData = {
    lines: [],
    words: [{ text: "DOOR", confidence: 90, bbox: [0.1, 0.1, 0.04, 0.01] as [number, number, number, number] }],
  };
  const dets = [
    det("text_box", "yolo_text", 0.09, 0.095, 0.9), // holds the word centre (0.12, 0.105)
    det("text_box", "yolo_text", 0.6, 0.6, 0.6), // no word → hole
    det("title_block", "yolo_medium", 0.8, 0.8, 0.9),
  ];
  const page = (pageIntelligence: unknown = {}) => ({ pageNumber: 1, rawText: "", pageIntelligence, csiCodes: [], textractData });

  it("writes the fused summary with the same zones as pageZones", () => {
    const { updated, pageChanged } = enrichPageAfterYolo(page(), dets, opts([]));
    expect(pageChanged).toBe(true);
    const ev = updated.evidence as { counts: Record<string, unknown>; zonesSource: string; holes: unknown[] };
    expect(ev.counts).toMatchObject({ ocrWords: 1, both: 1, holes: 1, yoloTextBoxes: 2 });
    expect(ev.zonesSource).toBe((updated.pageZones as { source: string }).source);
  });

  it("an unchanged summary is kept as stored (computedAt not churned)", () => {
    const first = enrichPageAfterYolo(page(), dets, opts([])).updated;
    const stored = { ...first, evidence: { ...(first.evidence as object), computedAt: "2026-01-01T00:00:00.000Z" } };
    const again = enrichPageAfterYolo(page(stored), dets, opts([])).updated;
    expect((again.evidence as { computedAt: string }).computedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("no textractData → evidence left as it was", () => {
    const { updated } = enrichPageAfterYolo({ ...page({ evidence: "kept" }), textractData: null }, dets, opts([]));
    expect(updated.evidence).toBe("kept");
  });
});
