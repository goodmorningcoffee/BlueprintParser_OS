// [classifier builder track 3] Pure draft operations behind Admin › Classifiers: immutable signal /
// class / recipe edits, unique ids, the overlay a set of drafts saves as, page-spec parsing and the
// contribution formatter.
import { describe, expect, it } from "vitest";
import { BUILT_IN_RECIPES, DETECT, blankRecipe } from "@/lib/classifier-engine";
import {
  addClass, addSignal, duplicateSignal, formatContribution, groupClasses, isModified, newSignalId, overlayFromDrafts, parsePageSpec,
  removeClass, removeSignal, updateClass, updateRecipe, updateSignal,
} from "../classifiers/draft-ops";

const schedules = BUILT_IN_RECIPES.find((r) => r.id === "schedules.v1")!;
const door = (r: typeof schedules) => r.classes.find((c) => c.id === "door")!;

describe("draft-ops", () => {
  it("edits are immutable and scoped to one head", () => {
    const next = updateSignal(schedules, "door", "header", { weight: 9, enabled: false });
    expect(door(next).signals.find((s) => s.id === "header")).toMatchObject({ weight: 9, enabled: false });
    expect(door(schedules).signals.find((s) => s.id === "header")!.weight).not.toBe(9);
    expect(next.classes.find((c) => c.id === "window")!.signals.find((s) => s.id === "header")!.weight).toBe(door(schedules).signals.find((s) => s.id === "header")!.weight);
    expect(updateSignal(schedules, "nope", "header", { weight: 1 })).toEqual(schedules);
  });

  it("add / duplicate / remove signals with unique ids", () => {
    expect(newSignalId(door(schedules).signals, "Header")).toBe("header-2");
    expect(newSignalId([], "My New Signal!")).toBe("my-new-signal");
    let d = addSignal(schedules, DETECT, { label: "x", spec: { type: "sheet" }, weight: 1, role: "score", enabled: true }, "structure");
    expect(d.detect.signals.at(-1)!.id).toBe("structure-2");
    d = duplicateSignal(d, "door", "header");
    const ids = door(d).signals.map((s) => s.id);
    expect(ids[ids.indexOf("header") + 1]).toBe("header-2");
    expect(door(d).signals.find((s) => s.id === "header-2")!.label).toMatch(/\(copy\)$/);
    d = removeSignal(d, "door", "header-2");
    expect(door(d).signals.some((s) => s.id === "header-2")).toBe(false);
  });

  it("class and recipe edits", () => {
    let d = updateClass(schedules, "door", { bias: -1, threshold: 0.3 });
    expect(door(d)).toMatchObject({ bias: -1, threshold: 0.3 });
    d = addClass(d, { id: "louver", name: "Louver schedule", group: "arch", bias: -3, signals: [] });
    expect(d.classes.at(-1)!.id).toBe("louver");
    expect(addClass(d, { id: "louver", name: "dup", group: "arch", bias: 0, signals: [] }).classes.filter((c) => c.id === "louver")).toHaveLength(1);
    d = removeClass(d, "louver");
    expect(d.classes.some((c) => c.id === "louver")).toBe(false);
    d = updateRecipe(d, { nameThreshold: 0.7, detect: { threshold: 0.9 } });
    expect(d.nameThreshold).toBe(0.7);
    expect(d.detect).toMatchObject({ threshold: 0.9, bias: schedules.detect.bias });
    expect(d.detect.signals).toEqual(schedules.detect.signals);
    expect(groupClasses(schedules.classes).map(([g]) => g)).toEqual([...new Set(schedules.classes.map((c) => c.group))]);
  });

  it("overlayFromDrafts: a patch per modified built-in, custom drafts whole; isModified", () => {
    const edited = updateClass(schedules, "door", { bias: -1 });
    const custom = blankRecipe("acme.x", "Acme");
    const overlay = overlayFromDrafts(BUILT_IN_RECIPES, { [schedules.id]: edited, "regions.v1": BUILT_IN_RECIPES[1], "acme.x": custom });
    expect(Object.keys(overlay.patches)).toEqual([schedules.id]);
    expect(overlay.patches[schedules.id]).toEqual({ version: schedules.version, classBias: { door: -1 } });
    expect(overlay.custom).toEqual([custom]);
    expect(isModified(schedules, edited)).toBe(true);
    expect(isModified(schedules, schedules)).toBe(false);
    expect(isModified(undefined, custom)).toBe(false);
  });

  it("renaming a built-in class or recipe saves as RecipePatch.classMeta / name (never silently dropped)", () => {
    let d = updateClass(schedules, "door", { name: "Doors", group: "openings", legacyCategory: undefined });
    d = updateRecipe(d, { name: "Our schedules" });
    const patch = overlayFromDrafts(BUILT_IN_RECIPES, { [schedules.id]: d }).patches[schedules.id];
    expect(patch.name).toBe("Our schedules");
    expect(patch.classMeta).toEqual({ door: { name: "Doors", group: "openings", ...(schedules.classes.find((c) => c.id === "door")!.legacyCategory ? { legacyCategory: null } : {}) } });
    expect(isModified(schedules, d)).toBe(true);
  });

  it("parsePageSpec and formatContribution", () => {
    expect(parsePageSpec("1-3, 7 12")).toEqual([1, 2, 3, 7, 12]);
    expect(parsePageSpec("3-1")).toEqual([]);
    expect(parsePageSpec("a")).toEqual([]);
    expect(parsePageSpec("1-100")).toHaveLength(20);
    expect(parsePageSpec("")).toEqual([]);
    expect(formatContribution({ signalId: "door.csiDiv", label: "Div 08 share", value: 0.82, weight: 2, delta: 1.64, detail: "82% of 11 codes" })).toBe("Div 08 share +1.64 (82% of 11 codes)");
    expect(formatContribution({ signalId: "door.neg", label: "negatives", value: 0.5, weight: -1.5, delta: -0.75 })).toBe("negatives -0.75");
    expect(formatContribution({ signalId: "detect.req", label: "required words", value: 1, weight: 0, delta: 0 })).toBe("required words yes");
  });
});
