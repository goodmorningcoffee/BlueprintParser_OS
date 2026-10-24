// Built-in recipes validate and hash; the company overlay merges by id (patches, added signals /
// classes, removed ids, custom recipes); malformed overlays never break the built-ins. The project
// proposal summary joins verdicts and caps at PROJECT_PROPOSALS_CAP.
import { describe, expect, it } from "vitest";
import { SCHEDULE_KINDS } from "../vocabulary";
import { applyOverlay, BUILT_IN_RECIPES, BUILT_IN_RECIPES_HASH, effectiveRecipes, hashRecipes, isClassifierOverlay, validateRecipe } from "../recipes";
import { buildProjectProposalSummary, storedProposalVerdicts } from "../summary";
import { CLASSIFIER_ENGINE_VERSION, PROJECT_PROPOSALS_CAP, type ClassifierOverlay, type ClassifierProposal } from "../types";

describe("built-in recipes", () => {
  it("load, validate, and cover one class per vocabulary kind (other-schedule is the fallback)", () => {
    const schedules = BUILT_IN_RECIPES.find((r) => r.id === "schedules.v1")!;
    const regions = BUILT_IN_RECIPES.find((r) => r.id === "regions.v1")!;
    expect(schedules).toMatchObject({ source: "built-in", unit: "region", target: "schedule", enabled: true, deriveName: true });
    expect(schedules.candidates[0]).toEqual({ type: "regions-v2", kinds: ["table"] });
    const kinds = SCHEDULE_KINDS.filter((k) => k.id !== "other-schedule").map((k) => k.id).sort();
    expect(schedules.classes.map((c) => c.id).sort()).toEqual(kinds);
    for (const c of schedules.classes) expect(c.group).toBe(SCHEDULE_KINDS.find((k) => k.id === c.id)!.group);
    expect(regions.classes.map((c) => c.id)).toContain("keynotes");
    expect(regions.classes.find((c) => c.id === "keynotes")?.legacyCategory).toBe("keynote-table");
    expect(BUILT_IN_RECIPES_HASH).toMatch(/^[0-9a-f]{8}$/);
    expect(hashRecipes(BUILT_IN_RECIPES)).toBe(BUILT_IN_RECIPES_HASH);
    expect(BUILT_IN_RECIPES.every((r) => r.classes.every((c) => c.signals.every((s) => s.spec.type === "words" ? Object.keys((s.spec as { terms: object }).terms).length > 0 : true)))).toBe(true);
  });

  it("validateRecipe names the recipe and the fault", () => {
    expect(() => validateRecipe({ id: "x" }, "custom")).toThrow(/"x".*needs name/);
    expect(() => validateRecipe({ ...BUILT_IN_RECIPES[0], classes: [{ id: "a", name: "A", bias: 0, signals: [{ id: "s", spec: { type: "nope" }, weight: 1, role: "score" }] }] }, "custom")).toThrow(/unknown spec type/);
    expect(() => validateRecipe({ ...BUILT_IN_RECIPES[0], classes: [{ id: "a", name: "A", bias: 0, signals: [] }, { id: "a", name: "A", bias: 0, signals: [] }] }, "custom")).toThrow(/duplicate class id/);
  });
});

describe("applyOverlay", () => {
  const overlay: ClassifierOverlay = {
    custom: [{ ...BUILT_IN_RECIPES[1], id: "custom.v1", name: "Custom" }, { id: "broken" } as never],
    patches: {
      "schedules.v1": {
        version: 7, enabled: true, detectThreshold: 0.6, nameThreshold: 0.55, minMargin: 0.2,
        signals: { header: { weight: 9, label: "renamed" }, structure: { enabled: false }, columns: { role: "required" } },
        classBias: { door: -1 },
        addedSignals: [{ classId: "door", signal: { id: "extra", label: "x", spec: { type: "sheet", disciplines: ["A"] }, weight: 1, role: "score", enabled: true } }, { classId: null, signal: { id: "dx", label: "dx", spec: { type: "channel", pageKinds: ["vector"] }, weight: 0.5, role: "score", enabled: true } }, { classId: "door", signal: { id: "bad" } as never }],
        addedClasses: [{ id: "widget", name: "Widget", group: "other", bias: -2, signals: [] }],
        removed: ["window", "body"],
      },
    },
  };

  it("patches built-ins by id and appends valid custom recipes; built-ins themselves are untouched", () => {
    const out = applyOverlay(BUILT_IN_RECIPES, overlay);
    const s = out.find((r) => r.id === "schedules.v1")!;
    expect(s).toMatchObject({ version: 7, nameThreshold: 0.55, minMargin: 0.2 });
    expect(s.detect.threshold).toBe(0.6);
    expect(s.detect.signals.find((x) => x.id === "structure")?.enabled).toBe(false);
    expect(s.detect.signals.some((x) => x.id === "dx")).toBe(true);
    const door = s.classes.find((c) => c.id === "door")!;
    expect(door.bias).toBe(-1);
    expect(door.signals.find((x) => x.id === "header")).toMatchObject({ weight: 9, label: "renamed" });
    expect(door.signals.find((x) => x.id === "columns")?.role).toBe("required");
    expect(door.signals.some((x) => x.id === "body")).toBe(false);
    expect(door.signals.some((x) => x.id === "extra")).toBe(true);
    expect(door.signals.some((x) => x.id === "bad")).toBe(false);
    expect(s.classes.some((c) => c.id === "window")).toBe(false);
    expect(s.classes.some((c) => c.id === "widget")).toBe(true);
    expect(out.map((r) => r.id)).toEqual(["schedules.v1", "regions.v1", "custom.v1"]);
    expect(out.find((r) => r.id === "custom.v1")?.source).toBe("custom");
    // the built-in object was not mutated
    expect(BUILT_IN_RECIPES[0].version).toBe(1);
    expect(BUILT_IN_RECIPES[0].classes.find((c) => c.id === "door")?.bias).toBe(-3);
    expect(BUILT_IN_RECIPES[0].classes.some((c) => c.id === "window")).toBe(true);
  });

  it("effectiveRecipes: an absent, malformed or non-object overlay yields the built-ins", () => {
    expect(effectiveRecipes(undefined)).toEqual(BUILT_IN_RECIPES);
    expect(effectiveRecipes("junk")).toEqual(BUILT_IN_RECIPES);
    expect(effectiveRecipes({ patches: [] })).toEqual(BUILT_IN_RECIPES);
    expect(effectiveRecipes({ patches: { "schedules.v1": { version: 2 } } })[0].version).toBe(2);
    expect(isClassifierOverlay({ custom: [], patches: {} })).toBe(true);
    expect(isClassifierOverlay({ custom: {} })).toBe(false);
  });
});

describe("buildProjectProposalSummary", () => {
  const proposal = (page: number, i: number): ClassifierProposal => ({
    id: `schedules.v1:p${page}:${i}`, recipeId: "schedules.v1", recipeVersion: 1, engineVersion: CLASSIFIER_ENGINE_VERSION, pageNumber: page,
    bbox: [0.1, 0.1 * i, 0.5, 0.1 * i + 0.05], target: "schedule", p: 0.9, classId: "door", className: "Door schedule", group: "arch", nameP: 0.8, margin: 0.3,
    displayName: "Door schedule", detectWhy: [], nameWhy: [], features: { "detect.structure": 0.8 },
  });
  const pageRecord = (page: number, n: number) => ({ engineVersion: CLASSIFIER_ENGINE_VERSION, recipes: { "schedules.v1": 1 }, proposals: Array.from({ length: n }, (_, i) => proposal(page, i)) });

  it("joins verdicts, orders by page, keeps only summary fields", () => {
    const pages = [
      { pageNumber: 2, pageIntelligence: { classifierProposals: pageRecord(2, 1) } },
      { pageNumber: 1, pageIntelligence: { classifierProposals: pageRecord(1, 2), proposalVerdicts: { "schedules.v1:p1:1": { proposalId: "schedules.v1:p1:1", recipeId: "schedules.v1", recipeVersion: 1, verdict: "rename", classId: "window", features: {}, proposedClassId: "door", userId: 1, at: "t" }, junk: 5 } } },
      { pageNumber: 3, pageIntelligence: { parsedRegions: [] } },
      { pageNumber: 4, pageIntelligence: null },
    ];
    const out = buildProjectProposalSummary(pages, "2026-10-24T00:00:00.000Z");
    expect(out).toMatchObject({ engineVersion: CLASSIFIER_ENGINE_VERSION, generatedAt: "2026-10-24T00:00:00.000Z", total: 3, truncated: false });
    expect(out.items.map((i) => i.id)).toEqual(["schedules.v1:p1:0", "schedules.v1:p1:1", "schedules.v1:p2:0"]);
    expect(out.items[1].verdict).toBe("rename");
    expect(out.items[0].verdict).toBeUndefined();
    expect(Object.keys(out.items[0]).sort()).toEqual(["bbox", "classId", "className", "displayName", "group", "id", "nameP", "p", "pageNumber", "recipeId", "target"]);
    expect(storedProposalVerdicts(pages[1].pageIntelligence)).toEqual({ "schedules.v1:p1:1": expect.objectContaining({ verdict: "rename" }) });
    expect(storedProposalVerdicts(null)).toEqual({});
  });

  it("caps at PROJECT_PROPOSALS_CAP and flags truncation", () => {
    const out = buildProjectProposalSummary([{ pageNumber: 1, pageIntelligence: { classifierProposals: pageRecord(1, PROJECT_PROPOSALS_CAP + 5) } }]);
    expect(out.total).toBe(PROJECT_PROPOSALS_CAP + 5);
    expect(out.items).toHaveLength(PROJECT_PROPOSALS_CAP);
    expect(out.truncated).toBe(true);
  });
});
