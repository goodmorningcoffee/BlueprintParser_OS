// [fix 2026-10-24 T1a] Built-in rule set after retiring the four rules that required YOLO class
// "table" (the model emits "tables"), and model scoping of built-in layout classes.
import { describe, expect, it } from "vitest";
import {
  BUILT_IN_RULES,
  RETIRED_BUILT_IN_RULE_IDS,
  getEffectiveRules,
  runHeuristicEngine,
  type HeuristicRule,
} from "@/lib/heuristic-engine";

const det = (name: string, modelName?: string) => ({
  name, modelName, confidence: 0.9, minX: 0.1, minY: 0.1, maxX: 0.2, maxY: 0.2,
});

describe("BUILT_IN_RULES", () => {
  it("is the five live rules; none of the retired ids remain", () => {
    expect(BUILT_IN_RULES.map((r) => r.id)).toEqual([
      "keynote-table", "symbol-legend", "general-notes", "section-cut", "typical-plan",
    ]);
    for (const r of BUILT_IN_RULES) expect(RETIRED_BUILT_IN_RULE_IDS.has(r.id)).toBe(false);
  });

  it("no built-in REQUIRES a class the models do not emit (\"table\")", () => {
    for (const r of BUILT_IN_RULES) expect(r.yoloRequired).not.toContain("table");
  });
});

describe("getEffectiveRules — stored copies of retired built-ins", () => {
  const stored = (id: string, source: "built-in" | "custom") => ({
    ...BUILT_IN_RULES[0], id, name: id, source, yoloRequired: ["table"],
  }) as HeuristicRule;

  it("drops a stored built-in copy of a retired rule (the tab saves every rule it shows)", () => {
    const ids = getEffectiveRules([stored("door-schedule", "built-in"), stored("table-confidence-boost", "built-in")]).map((r) => r.id);
    expect(ids).toEqual(BUILT_IN_RULES.map((r) => r.id));
  });

  it("keeps a CUSTOM rule that reuses a retired id", () => {
    const rules = getEffectiveRules([stored("door-schedule", "custom")]);
    expect(rules.find((r) => r.id === "door-schedule")?.source).toBe("custom");
  });

  it("still applies overrides to live built-ins", () => {
    const off = { ...BUILT_IN_RULES.find((r) => r.id === "typical-plan")!, enabled: false };
    expect(getEffectiveRules([off]).map((r) => r.id)).not.toContain("typical-plan");
  });
});

describe("general-notes booster reads text_box from yolo_medium only", () => {
  const generalNotes = BUILT_IN_RULES.find((r) => r.id === "general-notes")!;
  // keyword .25 + notes-numbered region .15 + vertical_area booster .10 = .50 ≥ the 0.4 floor, so the
  // rule fires either way and only the text_box booster differs.
  const notesRegion = { id: "n1", type: "notes-numbered" as const, bbox: [0.1, 0.1, 0.3, 0.3] as [number, number, number, number], confidence: 0.9, wordCount: 40 };
  const run = (rules: HeuristicRule[], dets: ReturnType<typeof det>[]) =>
    runHeuristicEngine(rules, {
      rawText: "GENERAL NOTES", textRegions: [notesRegion],
      yoloDetections: [det("vertical_area", "yolo_primitive"), ...dets], pageNumber: 1,
    });
  const boosted = (rules: HeuristicRule[], dets: ReturnType<typeof det>[]) =>
    run(rules, dets)[0]?.evidence.includes("YOLO booster: text_box") ?? false;

  it("yolo_text text_box does NOT boost the built-in", () => {
    expect(run([generalNotes], [det("text_box", "yolo_text")])).toHaveLength(1); // fired, unboosted
    expect(boosted([generalNotes], [det("text_box", "yolo_text")])).toBe(false);
  });

  it("yolo_medium text_box does, and legacy rows without modelName still do", () => {
    expect(boosted([generalNotes], [det("text_box", "yolo_medium")])).toBe(true);
    expect(boosted([generalNotes], [det("text_box")])).toBe(true);
  });

  it("a CUSTOM rule naming text_box sees every model's boxes (user intent)", () => {
    const custom: HeuristicRule = { ...generalNotes, id: "my-notes", source: "custom" };
    expect(boosted([custom], [det("text_box", "yolo_text")])).toBe(true);
  });
});
