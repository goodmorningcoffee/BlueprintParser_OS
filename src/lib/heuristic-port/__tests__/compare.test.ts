// [2b heuristic port 2026-10-24] OLD ENGINE vs PORT on the heuristic test fixtures and a page × rule matrix.
// The only difference allowed is D7 (REPORT §5): the old engine let a YOLO-gated rule fire WITHOUT its required
// keywords; the port gates every rule on them. Every other inference must match exactly — ruleId, label,
// confidence (same float), evidence (same strings, same order), bbox and csiTags — and in the same order.
import { describe, expect, it } from "vitest";
import { getEffectiveRules, runHeuristicEngine, type HeuristicRule } from "@/lib/heuristic-engine";
import { BUILT_IN_RULES } from "@/lib/heuristic-rules";
import { getEffectiveHeuristicRecipes, runHeuristicRecipes, type HeuristicDetection, type HeuristicPageContext } from "@/lib/heuristic-port";
import { isWholeWordMatch } from "@/lib/text-match-utils";
import type { CsiCode, HeuristicInference } from "@/types";

const det = (name: string, modelName: string | undefined, x: number, y: number, w = 0.04, h = 0.02): HeuristicDetection => ({
  name, modelName, confidence: 0.9, minX: x, minY: y, maxX: x + w, maxY: y + h,
});
const code = (c: string): CsiCode => ({ code: c, description: "d", trade: "t", division: `${c.slice(0, 2)} 00 00` });

/** D7: the old engine fired this rule although its required keywords do not match the page text. */
function isD7(rule: HeuristicRule, rawText: string): boolean {
  const kws = rule.textKeywordsRequired;
  if (!kws.length) return false;
  const match = rule.textKeywordsMode === "all-required" ? kws.every((k) => isWholeWordMatch(rawText, k)) : kws.some((k) => isWholeWordMatch(rawText, k));
  return !match;
}

function compare(company: unknown[] | undefined, ctx: HeuristicPageContext): { old: HeuristicInference[]; port: HeuristicInference[]; d7: string[] } {
  const oldRules = getEffectiveRules(company as HeuristicRule[] | undefined);
  const old = runHeuristicEngine(oldRules, ctx as Parameters<typeof runHeuristicEngine>[1]);
  const port = runHeuristicRecipes(getEffectiveHeuristicRecipes(company), ctx);
  const d7 = old.filter((i) => isD7(oldRules.find((r) => r.id === i.ruleId)!, ctx.rawText)).map((i) => i.ruleId);
  // Strict: same objects, same order, once the D7 firings are removed from the old output.
  expect(JSON.parse(JSON.stringify(port))).toEqual(JSON.parse(JSON.stringify(old.filter((i) => !d7.includes(i.ruleId)))));
  for (const i of port) expect(i.confidence).toBe(old.find((o) => o.ruleId === i.ruleId)!.confidence);
  return { old, port, d7 };
}

// ── the existing fixtures (heuristic-engine-builtins / -csi-tag / yolo-post-enrichment tests) ──
describe("existing heuristic fixtures: port == old engine", () => {
  const generalNotes = BUILT_IN_RULES.find((r) => r.id === "general-notes")!;
  const notesRegion = { id: "n1", type: "notes-numbered", bbox: [0.1, 0.1, 0.3, 0.3], confidence: 0.9, wordCount: 40 };
  const page = (dets: HeuristicDetection[]) => ({
    rawText: "GENERAL NOTES", textRegions: [notesRegion], yoloDetections: [det("vertical_area", "yolo_primitive", 0.1, 0.1), ...dets], pageNumber: 1,
  });

  it("general-notes text_box booster: yolo_text ignored, yolo_medium / legacy rows boost, a custom copy sees all", () => {
    for (const d of [det("text_box", "yolo_text", 0.1, 0.1), det("text_box", "yolo_medium", 0.1, 0.1), det("text_box", undefined, 0.1, 0.1)]) {
      expect(compare([generalNotes], page([d])).port).toHaveLength(1);
      expect(compare([{ ...generalNotes, id: "my-notes", source: "custom" }], page([d])).d7).toEqual([]);
    }
    const r = compare(undefined, page([det("text_box", "yolo_text", 0.1, 0.1)]));
    expect(r.port.find((i) => i.ruleId === "general-notes")?.evidence).not.toContain("YOLO booster: text_box");
  });

  it("outputCsiCode → csiTags across stored code formats", () => {
    const rule: HeuristicRule = {
      id: "t-door", name: "door", source: "custom", enabled: true, yoloRequired: [], yoloBoosters: [], yoloAvailabilityMode: "require",
      textKeywordsRequired: ["DOOR"], textKeywordsBoosters: [], textKeywordsMode: "any-required", overlapRequired: false,
      outputLabel: "door-schedule", outputCsiCode: "08 11 16", minConfidence: 0.01,
    };
    for (const codes of [[], [{ ...code("081116") }], [code("08 11 16")], [code("08 11 16.13")]]) {
      const r = compare([rule], { rawText: "DOOR SCHEDULE", csiCodes: codes, pageNumber: 1 });
      expect(r.port.find((i) => i.ruleId === "t-door")?.csiTags).toEqual(r.old.find((i) => i.ruleId === "t-door")?.csiTags);
    }
  });

  it("a CSI-division custom rule after YOLO (yolo-post-enrichment fixture)", () => {
    const div08: HeuristicRule = {
      id: "div08", name: "Div 08 page", source: "custom", enabled: true, yoloRequired: [], yoloBoosters: [], yoloAvailabilityMode: "require",
      textKeywordsRequired: ["OPENINGS"], textKeywordsBoosters: [], textKeywordsMode: "any-required", overlapRequired: false,
      csiDivisionsRequired: ["08"], outputLabel: "openings-page", minConfidence: 0.1,
    };
    const ctx = (csi: CsiCode[]) => ({ rawText: "OPENINGS", yoloDetections: [det("tables", "yolo_medium", 0.1, 0.1)], textRegions: [], csiCodes: csi, pageNumber: 3 });
    expect(compare([div08], ctx([code("08 11 16")])).port.map((i) => i.evidence)).toEqual([["Required keywords: OPENINGS", "CSI division: 08"]]);
    expect(compare([div08], ctx([])).port).toEqual([]);
  });
});

// ── a page × rule matrix: built-ins alone, and a company config of overrides + every custom-rule feature ──
const CUSTOMS: HeuristicRule[] = [
  { ...BUILT_IN_RULES.find((r) => r.id === "section-cut")!, minConfidence: 0.3 }, // a stored override of a built-in
  { id: "deg", name: "Degrade", source: "custom", enabled: true, yoloRequired: ["horizontal_area"], yoloBoosters: ["grid"], yoloAvailabilityMode: "degrade",
    textKeywordsRequired: ["LEGEND"], textKeywordsBoosters: ["SYMBOL"], textKeywordsMode: "any-required", overlapRequired: true, outputLabel: "deg", minConfidence: 0.2 },
  { id: "ign", name: "Ignore", source: "custom", enabled: true, yoloRequired: ["horizontal_area"], yoloBoosters: [], yoloAvailabilityMode: "ignore",
    textKeywordsRequired: ["SECTION", "TYPICAL"], textKeywordsBoosters: [], textKeywordsMode: "all-required", overlapRequired: false,
    textRegionType: "notes-block", outputLabel: "ign", minConfidence: 0.25 },
  { id: "spat", name: "Spatial", source: "custom", enabled: true, yoloRequired: ["horizontal_area"], yoloBoosters: ["oval", "table"], yoloAvailabilityMode: "require",
    textKeywordsRequired: [], textKeywordsBoosters: [], textKeywordsMode: "any-required", overlapRequired: true, outputLabel: "spat", minConfidence: 0.45,
    spatialConditions: [
      { operator: "contains", classA: "horizontal_area", classB: "oval", minInstances: 3 },
      { operator: "overlaps", classA: "horizontal_area", classB: "*" },
      { operator: "near", classA: "oval", classB: "text_box", maxDistance: 0.05 },
      { operator: "aligned", classA: "horizontal_area", classB: "oval", minInstances: 3, axis: "vertical" },
    ] },
  { id: "csi9", name: "Div 09", source: "custom", enabled: true, yoloRequired: [], yoloBoosters: ["text_box"], yoloAvailabilityMode: "require",
    textKeywordsRequired: ["FINISH", "GENERAL NOTES"], textKeywordsBoosters: ["TYP"], textKeywordsMode: "any-required", overlapRequired: false,
    csiDivisionsRequired: ["09", "08"], outputLabel: "csi9", outputCsiCode: "09 00 00", minConfidence: 0 },
  { id: "zero", name: "Zero floor", source: "custom", enabled: true, yoloRequired: [], yoloBoosters: ["grid"], yoloAvailabilityMode: "require",
    textKeywordsRequired: [], textKeywordsBoosters: [], textKeywordsMode: "any-required", overlapRequired: false, outputLabel: "zero", minConfidence: 0 },
];

const TEXTS = ["", "KEYNOTES LEGEND", "GENERAL NOTES: TYP.", "SECTION A-A TYPICAL", "SYMBOL LEGEND FINISH", "INDOOR KEY NOTES"];
const ovalColumn = [0.2, 0.3, 0.4].map((y) => det("oval", "yolo_primitive", 0.12, y, 0.02, 0.02));
const DETS: Array<HeuristicDetection[] | undefined> = [
  undefined,
  [],
  [det("horizontal_area", "yolo_primitive", 0.1, 0.1, 0.4, 0.5), ...ovalColumn],
  [det("horizontal_area", "yolo_primitive", 0.1, 0.1, 0.4, 0.5), det("table", "yolo_medium", 0.15, 0.15, 0.3, 0.3), det("grid", "yolo_medium", 0.6, 0.6), det("text_box", "yolo_medium", 0.13, 0.21)],
  [det("horizontal_area", "yolo_text", 0.1, 0.1, 0.4, 0.5), det("text_box", "yolo_text", 0.5, 0.5), ...ovalColumn],
  [det("horizontal_area", undefined, 0.1, 0.1, 0.4, 0.5), det("symbol_legend", "yolo_medium", 0.1, 0.1), ...ovalColumn.slice(0, 2)],
];
const REGIONS: unknown[] = [undefined, [{ id: "r", type: "notes-numbered" }], [{ id: "r", type: "notes-key-value" }], [{ id: "r", type: "notes-block" }]];
const CSI: CsiCode[][] = [[], [code("08 11 16")], [code("09 30 00"), code("08 71 00")]];

function matrix(company: unknown[] | undefined) {
  const d7: Array<{ rule: string; text: number; dets: number }> = [];
  let pages = 0;
  let fired = 0;
  TEXTS.forEach((rawText, ti) => DETS.forEach((yoloDetections, di) => REGIONS.forEach((textRegions) => CSI.forEach((csiCodes) => {
    pages++;
    const r = compare(company, { rawText, yoloDetections, textRegions, csiCodes, pageNumber: 1 });
    fired += r.port.length;
    for (const rule of r.d7) d7.push({ rule, text: ti, dets: di });
  }))));
  return { pages, fired, d7 };
}

describe("page × rule matrix: port == old engine except D7", () => {
  it("built-in rules: identical outside D7; D7 drops are keynote-table / symbol-legend firings on keyword-free pages", () => {
    const { pages, fired, d7 } = matrix(undefined);
    expect(pages).toBe(432);
    expect(fired).toBeGreaterThan(50);
    // The D7 firings, explicitly: only the two YOLO-gated built-ins whose ladder reaches .5 without keywords
    // (.3 class + .2 spatial [+ boosters / region]); section-cut tops out at .3 without its keyword.
    expect([...new Set(d7.map((d) => d.rule))].sort()).toEqual(["keynote-table", "symbol-legend"]);
    // …only on pages with YOLO data and a layout-scoped horizontal_area (DETS 2, 3, 5), never text-only.
    expect([...new Set(d7.map((d) => d.dets))].sort()).toEqual([2, 3, 5]);
    // …and only where the text lacks every required keyword of the rule.
    for (const d of d7) expect(isD7(BUILT_IN_RULES.find((r) => r.id === d.rule)!, TEXTS[d.text])).toBe(true);
    expect(d7.length).toBe(D7_BUILT_IN_COUNT);
  });

  it("company config (built-in override + degrade / ignore / spatial / CSI / zero-floor customs): identical outside D7", () => {
    const { fired, d7 } = matrix(CUSTOMS);
    expect(fired).toBeGreaterThan(100);
    // D7 here, explicitly: the two built-ins as above, the section-cut override (floor lowered to .3, which its
    // .3 class increment alone reaches), and the YOLO-gated customs deg / ign — each only with YOLO data
    // (ign / deg pass their gate on text-only runs, where the old engine already required the keywords).
    expect([...new Set(d7.map((d) => d.rule))].sort()).toEqual(["deg", "ign", "keynote-table", "section-cut", "symbol-legend"]);
    expect(d7.every((d) => d.dets >= 2)).toBe(true);
    // The rules without keywords (spat, zero) and the keyword-only customs never differ.
    expect(d7.some((d) => ["spat", "zero", "csi9"].includes(d.rule))).toBe(false);
  });
});

/** Pinned so a change in either engine shows up as a count change (measured on this matrix). */
const D7_BUILT_IN_COUNT = 180;
