// [fix 2026-10-24 T1a] The post-YOLO page pass (extracted from services/yolo.ts yoloLoad). Real
// engine, composite classifier, heatmap and ensemble; only the table classifier is a stub, so its
// CSI input can be read back.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HeuristicRule } from "@/lib/heuristic-rules";
import { ruleToRecipe } from "@/lib/heuristic-port";
import type { CsiCode } from "@/types";

const spy = vi.hoisted(() => ({ classifyTables: vi.fn() }));
vi.mock("@/lib/table-classifier", () => ({ classifyTables: spy.classifyTables }));

import {
  enrichPageAfterYolo,
  type PostYoloDetection,
  stableStringify,
} from "@/server/services/yolo-post-enrichment";
import { BUILT_IN_RECIPES } from "@/lib/classifier-engine";

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
  rules: rules.map(ruleToRecipe), heatmapEnabled: true, ensembleEnabled: true, ensembleConfig: undefined,
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

describe("enrichPageAfterYolo — regions v2 runs in shadow", () => {
  const words = Array.from({ length: 12 }, (_, i) => ({
    text: ["DOOR", "SCHEDULE", "FRAME", "HARDWARE", "HM", "WD"][i % 6], confidence: 99,
    bbox: [0.11 + (i % 3) * 0.02, 0.11 + Math.floor(i / 3) * 0.02, 0.01, 0.005] as [number, number, number, number],
  }));
  const page = (textractData: unknown) => ({
    pageNumber: 2, rawText: "", csiCodes: [DOORS], textractData: textractData as never,
    pageIntelligence: { textRegions: [{ id: "r1", type: "schedule-table", bbox: [0.1, 0.1, 0.1, 0.1], confidence: 0.9, wordCount: 30 }] },
  });
  const tables = { name: "tables", modelName: "yolo_medium", confidence: 0.85, minX: 0.1, minY: 0.1, maxX: 0.2, maxY: 0.2 };

  it("persists regionsV2 beside the legacy keys without touching classifiedTables", () => {
    spy.classifyTables.mockReturnValue([{ id: "legacy", category: "material-schedule" }]);
    const { updated, pageChanged } = enrichPageAfterYolo(page({ words }), [tables], opts([]));
    expect(pageChanged).toBe(true);
    const v2 = updated.regionsV2 as { version: string; regions: Array<{ kind: string; className: string }> };
    expect(v2.version).toBe("rc-v2/0.1");
    expect(v2.regions).toEqual([expect.objectContaining({ kind: "table", className: "door schedule" })]);
    // classifiedTables is whatever the legacy classifier returned — v2 never replaces it
    expect(updated.classifiedTables).toBeUndefined(); // no inference fired ⇒ the legacy reclassifier did not run
    expect(spy.classifyTables).not.toHaveBeenCalled();
  });

  it("an unchanged record is not rewritten; a missing textractData still yields a (wordless) record", () => {
    // a yolo_text-only page: no anchors ⇒ an empty regionsV2 record + fixed-fallback zones are the ONLY
    // writes (the legacy composite/heatmap/ensemble steps flag a change whenever they emit anything).
    const textOnly = [{ ...tables, name: "text_box", modelName: "yolo_text" }];
    const first = enrichPageAfterYolo(page({ words }), textOnly, opts([]));
    expect(first.pageChanged).toBe(true);
    expect(first.updated.regionsV2).toMatchObject({ version: "rc-v2/0.1", regions: [] });
    const second = enrichPageAfterYolo({ ...page({ words }), pageIntelligence: first.updated }, textOnly, opts([]));
    expect(second.pageChanged).toBe(false);
    expect(second.updated.regionsV2).toBe(first.updated.regionsV2);
    const bare = enrichPageAfterYolo(page(null), [tables], opts([])).updated.regionsV2 as { regions: Array<{ className: string; signals: { words: number } }> };
    expect(bare.regions[0]).toMatchObject({ className: "unclassified", signals: { words: 0 } });
  });

  it("[T5 fix LOW 3] a stored record whose jsonb keys came back in another order is still 'unchanged'", () => {
    const first = enrichPageAfterYolo(page({ words }), [tables], opts([]));
    // Postgres reorders jsonb object keys: simulate a round trip by reversing every object's key order
    const reorder = (v: unknown): unknown => Array.isArray(v) ? v.map(reorder)
      : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).reverse().map((k) => [k, reorder((v as Record<string, unknown>)[k])])) : v;
    const stored = reorder({ ...page({ words }).pageIntelligence, regionsV2: first.updated.regionsV2, pageZones: first.updated.pageZones });
    expect(JSON.stringify(stored)).not.toBe(JSON.stringify({ ...page({ words }).pageIntelligence, regionsV2: first.updated.regionsV2, pageZones: first.updated.pageZones }));
    const second = enrichPageAfterYolo({ ...page({ words }), pageIntelligence: stored }, [tables], opts([]));
    expect(second.updated.regionsV2).toBe((stored as Record<string, unknown>).regionsV2); // the spread, untouched
    expect(second.updated.pageZones).toBe((stored as Record<string, unknown>).pageZones);
    expect(stableStringify({ b: [{ d: 1, c: 2 }], a: null })).toBe('{"a":null,"b":[{"c":2,"d":1}]}');
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

  it("a throwing evidence build is contained: evidence kept, the rest of the page still enriched", () => {
    const broken = { lines: [], words: [{ text: "X", confidence: 90, bbox: null }] } as never;
    const { updated, pageChanged } = enrichPageAfterYolo({ ...page({ evidence: "kept" }), textractData: broken }, dets, opts([]));
    expect(updated.evidence).toBe("kept");
    expect(pageChanged).toBe(true);
    expect(updated.pageZones).toBeDefined();
  });

  it("no textractData → evidence left as it was", () => {
    const { updated } = enrichPageAfterYolo({ ...page({ evidence: "kept" }), textractData: null }, dets, opts([]));
    expect(updated.evidence).toBe("kept");
  });
});

describe("enrichPageAfterYolo — shape ensemble [tag-mapping v2]", () => {
  const page = {
    pageNumber: 4, rawText: "", pageIntelligence: {}, csiCodes: [] as CsiCode[],
    textractData: { words: [{ text: "D-101", confidence: 99, bbox: [0.105, 0.105, 0.004, 0.003] as [number, number, number, number] }] },
    keynotes: [{ shape: "circle", text: "W", bbox: [0.5, 0.5, 0.5 + 40 / 10800, 0.5 + 40 / 10800] as [number, number, number, number] }],
  };
  const bubble: PostYoloDetection = { name: "circle", modelName: "yolo_primitive", confidence: 0.9, minX: 0.1, minY: 0.1, maxX: 0.114, maxY: 0.114 };

  it("writes `shapes` (YOLO bubble with Textract text + small classical bubble) and is stable on a re-run", () => {
    const { updated, pageChanged } = enrichPageAfterYolo(page, [bubble], opts([]));
    expect(pageChanged).toBe(true);
    const shapes = updated.shapes as { shapes: Array<{ t: string | null; s: string }>; counts: { yolo: number; classical: number } };
    expect(shapes.counts).toMatchObject({ yolo: 1, classical: 1 });
    expect(shapes.shapes.map((s) => [s.s, s.t]).sort()).toEqual([["c", "W"], ["y", "D-101"]]);
    const again = enrichPageAfterYolo({ ...page, pageIntelligence: updated }, [bubble], opts([]));
    expect(again.updated.shapes).toBe(updated.shapes);
  });

  it("without keynotes the ensemble is YOLO-only; without OCR a textless bubble at .9 survives", () => {
    const { updated } = enrichPageAfterYolo({ ...page, keynotes: null, textractData: null }, [bubble], opts([]));
    const shapes = updated.shapes as { shapes: Array<{ t: string | null }>; counts: { classical: number } };
    expect(shapes.counts.classical).toBe(0);
    expect(shapes.shapes.map((s) => s.t)).toEqual([null]);
  });
});

describe("[clf 2a] classifier engine after classifyRegionsV2", () => {
  const w = (text: string, x: number, y: number, h = 0.012) => ({ text, confidence: 99, bbox: [x, y, text.length * 0.007, h] as [number, number, number, number] });
  const words = [w("DOOR", 0.52, 0.19, 0.018), w("SCHEDULE", 0.57, 0.19, 0.018), ...["DOOR", "NO", "FRAME", "HDWR", "RATING", "SIZE"].map((t, i) => w(t, 0.51 + i * 0.07, 0.22))];
  for (let r = 0; r < 8; r++) words.push(w(`10${r}`, 0.51, 0.25 + r * 0.02), w("HM", 0.58, 0.25 + r * 0.02), w("WD", 0.65, 0.25 + r * 0.02), w("PR", 0.72, 0.25 + r * 0.02));
  const dets: PostYoloDetection[] = [{ name: "tables", modelName: "yolo_medium", confidence: 0.9, minX: 0.5, minY: 0.21, maxX: 0.9, maxY: 0.45 }];
  const page = (pageIntelligence: Record<string, unknown>) => ({ pageNumber: 7, rawText: "DOOR SCHEDULE", pageIntelligence, csiCodes: null, textractData: { words }, drawingNumber: "A-601" });

  it("writes classifierProposals (computed) beside regionsV2, leaves proposalVerdicts alone, and skips the write when unchanged", () => {
    const first = enrichPageAfterYolo(page({ proposalVerdicts: { keep: { verdict: "accept" } } }), dets, opts([]));
    expect(first.pageChanged).toBe(true);
    const stored = first.updated.classifierProposals as { engineVersion: string; proposals: Array<{ recipeId: string; classId: string | null; displayName: string }> };
    expect(stored.engineVersion).toBe("clf/0.1");
    expect(stored.proposals).toHaveLength(1);
    expect(stored.proposals[0]).toMatchObject({ recipeId: "schedules.v1", classId: "door", displayName: "Door schedule" });
    expect(first.updated.proposalVerdicts).toEqual({ keep: { verdict: "accept" } });
    expect(first.updated.classifiedTables).toBeUndefined(); // legacy path untouched (no textRegions on this page)
    // same page again, with everything it just wrote: the record is byte-stable, so the sameJson guard keeps it
    // (the legacy composite / heatmap steps still flag the page; they always did)
    const second = enrichPageAfterYolo(page(first.updated), dets, opts([]));
    expect(stableStringify(second.updated.classifierProposals)).toBe(stableStringify(stored));
  });

  it("a recipe that throws is contained — the page keeps its other enrichment and the other recipes' proposals", () => {
    // A words signal with no terms makes evaluateSignal throw on the first candidate (a bad scope regex is
    // caught by inScope and would never reach the engine's per-recipe guard).
    const broken = {
      ...BUILT_IN_RECIPES[0], id: "broken",
      detect: { ...BUILT_IN_RECIPES[0].detect, signals: [{ id: "bad", label: "bad", spec: { type: "words" as const, where: "box" as const, terms: null as never }, weight: 1, role: "score" as const, enabled: true }] },
    };
    const out = enrichPageAfterYolo(page({}), dets, { ...opts([]), classifierRecipes: [broken, BUILT_IN_RECIPES[0]] });
    expect(out.pageChanged).toBe(true);
    expect(out.updated.regionsV2).toBeDefined();
    expect((out.updated.classifierProposals as { proposals: Array<{ recipeId: string }> }).proposals.map((p) => p.recipeId)).toEqual(["schedules.v1"]);
  });
});
