// [2b heuristic port 2026-10-24] Rule → page-unit recipe conversion, the shipped heuristics.v1.json, and the
// company merge done ON READ (getEffectiveHeuristicRecipes).
import { describe, expect, it } from "vitest";
import heuristicsJson from "@/data/classifiers/heuristics.v1.json";
import { BUILT_IN_RECIPES, HEURISTIC_RECIPES, validateRecipe } from "@/lib/classifier-engine";
import { BUILT_IN_RULES, RETIRED_BUILT_IN_RULE_IDS, type HeuristicRule } from "@/lib/heuristic-rules";
import { DEGRADE_FACTOR, getEffectiveHeuristicRecipes, LEGACY_LADDER, ruleToRecipe } from "@/lib/heuristic-port";

const custom = (over: Partial<HeuristicRule> = {}): HeuristicRule => ({
  id: "c1", name: "Custom", source: "custom", enabled: true,
  yoloRequired: ["horizontal_area"], yoloBoosters: [], yoloAvailabilityMode: "require",
  textKeywordsRequired: ["KEY"], textKeywordsBoosters: [], textKeywordsMode: "any-required",
  overlapRequired: false, outputLabel: "c-label", minConfidence: 0.5, ...over,
});
const sig = (r: ReturnType<typeof ruleToRecipe>, id: string) => r.detect.signals.find((s) => s.id === id);

describe("heuristics.v1.json", () => {
  it("is exactly the converter's output for every live built-in rule (same order, nothing retired)", () => {
    expect(heuristicsJson).toEqual(JSON.parse(JSON.stringify(BUILT_IN_RULES.map(ruleToRecipe))));
    expect(HEURISTIC_RECIPES.map((r) => r.id)).toEqual(BUILT_IN_RULES.map((r) => r.id));
    for (const r of HEURISTIC_RECIPES) expect(RETIRED_BUILT_IN_RULE_IDS.has(r.id)).toBe(false);
  });

  it("validates as page-unit recipes and stays OUT of the proposal built-ins", () => {
    for (const r of HEURISTIC_RECIPES) {
      expect(r.unit).toBe("page");
      expect(r.heuristic?.minConfidence).toBeTypeOf("number");
    }
    expect(BUILT_IN_RECIPES.some((r) => r.unit === "page" || r.heuristic)).toBe(false);
  });

  it("D7: every built-in with required keywords gates on them", () => {
    for (const rule of BUILT_IN_RULES) {
      const gate = sig(HEURISTIC_RECIPES.find((r) => r.id === rule.id)!, "keywords-gate");
      expect(gate?.role).toBe("required");
      expect(gate?.spec).toEqual({ type: "text", terms: rule.textKeywordsRequired, mode: "any" });
    }
  });
});

describe("ruleToRecipe", () => {
  it("weights mirror the old ladder; bias −minConfidence, threshold .5", () => {
    const r = ruleToRecipe(custom({
      yoloBoosters: ["grid"], textKeywordsBoosters: ["X"], overlapRequired: true, textRegionType: "notes-key-value",
      spatialConditions: [{ operator: "contains", classA: "horizontal_area", classB: "oval", minInstances: 3 }], csiDivisionsRequired: ["08"],
      outputCsiCode: "08 11 16",
    }));
    expect(r.detect.bias).toBe(-0.5);
    expect(r.detect.threshold).toBe(0.5);
    expect(r.detect.signals.map((s) => [s.id, s.role, s.weight])).toEqual([
      ["yolo-gate", "required", 0], ["yolo-required", "score", LEGACY_LADDER.yoloRequired], ["yolo-booster-0", "score", 0.1],
      ["keywords-gate", "required", 0], ["keywords", "score", 0.25], ["overlap", "score", 0.15], ["keyword-booster-0", "score", 0.05],
      ["spatial-0", "score", 0.2], ["text-region", "score", 0.15], ["csi-gate", "required", 0], ["csi", "score", 0.15],
    ]);
    expect(r.heuristic).toEqual({ minConfidence: 0.5, yoloAvailabilityMode: "require", outputCsiCode: "08 11 16", bboxClass: "horizontal_area" });
    expect(r.target).toBe("c-label");
    expect(sig(r, "yolo-gate")?.spec).not.toHaveProperty("noDetections");
  });

  it("degrade: the gate passes on a text-only run and the threshold shifts to min/.6", () => {
    const r = ruleToRecipe(custom({ yoloAvailabilityMode: "degrade", minConfidence: 0.3 }));
    expect(sig(r, "yolo-gate")?.spec).toMatchObject({ noDetections: 1 });
    expect(r.detect.bias).toBeCloseTo(-0.3 / DEGRADE_FACTOR, 12);
    expect(sig(r, "yolo-available")?.weight).toBeCloseTo(0.3 / DEGRADE_FACTOR - 0.3, 12);
  });

  it("ignore: the gate passes on a text-only run, no threshold shift", () => {
    const r = ruleToRecipe(custom({ yoloAvailabilityMode: "ignore" }));
    expect(sig(r, "yolo-gate")?.spec).toMatchObject({ noDetections: 1 });
    expect(sig(r, "yolo-available")).toBeUndefined();
    expect(r.detect.bias).toBe(-0.5);
  });

  it("all-required keywords map to mode all; no keywords → no keyword signals and no overlap", () => {
    expect(sig(ruleToRecipe(custom({ textKeywordsMode: "all-required" })), "keywords")?.spec).toMatchObject({ mode: "all" });
    const bare = ruleToRecipe(custom({ textKeywordsRequired: [], overlapRequired: true }));
    expect(bare.detect.signals.map((s) => s.id)).toEqual(["yolo-gate", "yolo-required"]);
  });

  it("a duplicated booster keeps two signals (the old engine counted it twice)", () => {
    const r = ruleToRecipe(custom({ yoloBoosters: ["grid", "grid"] }));
    expect(r.detect.signals.filter((s) => s.label === "YOLO booster: grid")).toHaveLength(2);
    expect(() => validateRecipe(r, "custom")).not.toThrow();
  });

  it("throws on a rule whose class lists are not arrays (the old engine threw at scoring)", () => {
    expect(() => ruleToRecipe(custom({ yoloRequired: undefined as unknown as string[] }))).toThrow(/yoloRequired/);
  });

  it("enabled is truthiness, like the old filter", () => {
    expect(ruleToRecipe(custom({ enabled: undefined as unknown as boolean })).enabled).toBe(false);
  });
});

describe("getEffectiveHeuristicRecipes (company rules converted on read)", () => {
  const ids = (rs: ReturnType<typeof getEffectiveHeuristicRecipes>) => rs.map((r) => r.id);

  it("no company rules → the shipped recipes", () => {
    expect(getEffectiveHeuristicRecipes(undefined)).toEqual(HEURISTIC_RECIPES.filter((r) => r.enabled));
    expect(getEffectiveHeuristicRecipes([])).toEqual(HEURISTIC_RECIPES.filter((r) => r.enabled));
  });

  it("a company copy of a built-in replaces it field by field and stays built-in; disabled ones drop", () => {
    const base = BUILT_IN_RULES.find((r) => r.id === "section-cut")!;
    const got = getEffectiveHeuristicRecipes([{ ...base, minConfidence: 0.2 }, { ...BUILT_IN_RULES.find((r) => r.id === "typical-plan")!, enabled: false }]);
    expect(ids(got)).toEqual(["keynote-table", "symbol-legend", "general-notes", "section-cut"]);
    const sc = got.find((r) => r.id === "section-cut")!;
    expect(sc.source).toBe("built-in");
    expect(sc.heuristic?.minConfidence).toBe(0.2);
  });

  it("drops stored copies of retired built-ins; keeps customs (even reusing a retired id), legacy shape migrated", () => {
    const legacy = { id: "old", name: "Old", source: "custom", enabled: true, yoloRequired: [], yoloBoosters: [], textKeywords: ["A", "B"], overlapRequired: false, outputLabel: "old", minConfidence: 0.1 };
    const got = getEffectiveHeuristicRecipes([
      custom({ id: "door-schedule", source: "built-in" }), custom({ id: "door-schedule", source: "custom" }), legacy,
    ]);
    expect(ids(got)).toEqual([...BUILT_IN_RULES.map((r) => r.id), "door-schedule", "old"]);
    expect(got.find((r) => r.id === "old")!.detect.signals.find((s) => s.id === "keywords")?.spec).toEqual({ type: "text", terms: ["A", "B"], mode: "all" });
  });

  it("a malformed company rule is skipped, never fatal", () => {
    const got = getEffectiveHeuristicRecipes([null, { id: "bad", source: "custom", enabled: true }, custom()]);
    expect(ids(got)).toEqual([...BUILT_IN_RULES.map((r) => r.id), "c1"]);
  });
});
