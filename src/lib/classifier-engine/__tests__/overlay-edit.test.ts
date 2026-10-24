// [classifier builder track 3] The editor model over the real built-ins: patch building round-trips
// through applyOverlay, scoped signal keys (a "header" edit in `door` leaves `window`'s header alone),
// spec patches, reset signal / class / recipe, diff lines, strict overlay validation (unknown ids,
// bad numbers, malformed specs, fitter-shaped overlays), and version bumps per changed recipe.
import { describe, expect, it } from "vitest";
import {
  BUILT_IN_RECIPES, DETECT, applyOverlay, buildRecipePatch, bumpOverlayVersions, describePatch, resetClass, resetRecipe, resetSignal,
  signalKey, validateOverlay, type ClassifierOverlay, type ClassifierRecipe, type WeightedSignal,
} from "..";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const schedules = BUILT_IN_RECIPES.find((r) => r.id === "schedules.v1")!;
const sig = (r: ClassifierRecipe, cls: string, id: string): WeightedSignal => r.classes.find((c) => c.id === cls)!.signals.find((s) => s.id === id)!;

function editedDraft(): ClassifierRecipe {
  const d = clone(schedules);
  d.detect.threshold = 0.6;
  d.detect.bias = -2;
  sig(d, "door", "header").weight = 4.5;
  sig(d, "door", "header").spec = { type: "words", where: "header", terms: { "DOOR SCHEDULE": 2 }, saturation: 1 };
  sig(d, "door", "body").enabled = false;
  d.classes.find((c) => c.id === "door")!.bias = -2.5;
  d.classes.find((c) => c.id === "door")!.threshold = 0.4;
  d.classes.find((c) => c.id === "door")!.signals = d.classes.find((c) => c.id === "door")!.signals.filter((s) => s.id !== "neg");
  d.classes.find((c) => c.id === "door")!.signals.push({ id: "louver", label: "louver words", spec: { type: "words", where: "box", terms: { LOUVER: 1 } }, weight: 1, role: "score", enabled: true });
  d.classes = d.classes.filter((c) => c.id !== "revision");
  d.classes.push({ id: "acme-custom", name: "Acme custom", group: "other", bias: -3, signals: [] });
  d.detect.signals.push({ id: "ratio", label: "wide", spec: { type: "structure", feature: "textCols", scale: 4 }, weight: 0.5, role: "score", enabled: true });
  d.scope = { ...d.scope, excludeDisciplines: ["T"] };
  return d;
}

describe("buildRecipePatch ↔ applyOverlay", () => {
  it("is null for an identical draft and round-trips an edited one", () => {
    expect(buildRecipePatch(schedules, clone(schedules))).toBeNull();
    const draft = editedDraft();
    const patch = buildRecipePatch(schedules, draft, 7)!;
    expect(patch.version).toBe(7);
    expect(patch.detectThreshold).toBe(0.6);
    expect(patch.detectBias).toBe(-2);
    expect(patch.signals![signalKey("door", "header")]).toEqual({ weight: 4.5, spec: { type: "words", where: "header", terms: { "DOOR SCHEDULE": 2 }, saturation: 1 } });
    expect(patch.signals![signalKey("door", "body")]).toEqual({ enabled: false });
    expect(patch.classBias).toEqual({ door: -2.5 });
    expect(patch.classThreshold).toEqual({ door: 0.4 });
    expect(patch.removed).toEqual([signalKey("door", "neg"), "class:revision"]);
    expect(patch.addedSignals!.map((a) => [a.classId, a.signal.id])).toEqual([[null, "ratio"], ["door", "louver"]]);
    expect(patch.addedClasses!.map((c) => c.id)).toEqual(["acme-custom"]);
    expect(patch.scope).toEqual(draft.scope);
    const [effective] = applyOverlay([schedules], { custom: [], patches: { [schedules.id]: patch } });
    expect(effective).toEqual({ ...draft, version: 7 });
    // the window class's header signal is untouched by the door edit (scoped keys)
    expect(sig(effective, "window", "header")).toEqual(sig(schedules, "window", "header"));
  });

  it("legacy bare-id patches still apply to every head, and feature-keyed ones win over them", () => {
    const [eff] = applyOverlay([schedules], { custom: [], patches: { [schedules.id]: { version: 3, signals: { header: { weight: 9 }, [signalKey("door", "header")]: { weight: 1 } } } } });
    expect(sig(eff, "window", "header").weight).toBe(9);
    expect(sig(eff, "door", "header").weight).toBe(1);
    expect(eff.version).toBe(3);
  });

  it("a malformed spec patch leaves the built-in spec and never throws", () => {
    const [eff] = applyOverlay([schedules], { custom: [], patches: { [schedules.id]: { version: 3, signals: { [signalKey("door", "header")]: { spec: { type: "words" } as never } } } } });
    expect(sig(eff, "door", "header").spec).toEqual(sig(schedules, "door", "header").spec);
  });
});

describe("reset / diff", () => {
  it("resetSignal restores a built-in signal in place, re-inserts a removed one, drops an added one", () => {
    let d = editedDraft();
    d = resetSignal(d, schedules, "door", "header");
    expect(sig(d, "door", "header")).toEqual(sig(schedules, "door", "header"));
    expect(d.classes.find((c) => c.id === "door")!.signals.map((s) => s.id).indexOf("header")).toBe(schedules.classes.find((c) => c.id === "door")!.signals.map((s) => s.id).indexOf("header"));
    d = resetSignal(d, schedules, "door", "neg");
    expect(sig(d, "door", "neg")).toEqual(sig(schedules, "door", "neg"));
    d = resetSignal(d, schedules, "door", "louver");
    expect(d.classes.find((c) => c.id === "door")!.signals.some((s) => s.id === "louver")).toBe(false);
    d = resetSignal(d, schedules, DETECT, "ratio");
    expect(d.detect.signals.some((s) => s.id === "ratio")).toBe(false);
  });

  it("resetClass and resetRecipe", () => {
    let d = editedDraft();
    d = resetClass(d, schedules, "door");
    expect(d.classes.find((c) => c.id === "door")).toEqual(schedules.classes.find((c) => c.id === "door"));
    d = resetClass(d, schedules, "revision");
    expect(d.classes.some((c) => c.id === "revision")).toBe(true);
    d = resetClass(d, schedules, "acme-custom");
    expect(d.classes.some((c) => c.id === "acme-custom")).toBe(false);
    expect(buildRecipePatch(schedules, resetRecipe(schedules))).toBeNull();
  });

  it("describePatch lists every change with built-in and company values", () => {
    const lines = describePatch(schedules, buildRecipePatch(schedules, editedDraft()));
    const paths = lines.map((l) => `${l.kind} ${l.path}`);
    expect(paths).toContain("changed detect threshold");
    expect(paths).toContain("changed Door schedule · header: weight");
    expect(paths).toContain("changed Door schedule: bias");
    expect(paths).toContain("added Door schedule · louver");
    expect(paths).toContain("added class Acme custom");
    expect(paths).toContain("removed Door schedule · neg");
    expect(paths).toContain("removed class Revision schedule");
    expect(lines.find((l) => l.path === "Door schedule · header: weight")).toMatchObject({ from: "3", to: "4.5" });
    expect(describePatch(schedules, null)).toEqual([]);
  });
});

describe("validateOverlay", () => {
  it("accepts the patch the editor builds and a fitter-shaped overlay unchanged", () => {
    const patch = buildRecipePatch(schedules, editedDraft())!;
    const ok = validateOverlay({ custom: [], patches: { [schedules.id]: patch } }, BUILT_IN_RECIPES);
    expect(ok.errors).toEqual([]);
    expect(ok.overlay!.patches[schedules.id]).toEqual(patch);
    const fitter = { patches: { [schedules.id]: { version: 2, classBias: { door: -2.1 }, signals: { "door.header": { weight: 3.3 }, "detect.structure": { weight: 5.5 } } } } };
    const r = validateOverlay(fitter, BUILT_IN_RECIPES);
    expect(r.errors).toEqual([]);
    expect(r.overlay).toEqual({ custom: [], patches: fitter.patches });
  });

  it("rejects unknown recipe / signal / class ids, bad numbers, malformed specs, colliding added ids and built-in ids as custom", () => {
    const errs = (v: unknown) => validateOverlay(v, BUILT_IN_RECIPES).errors;
    expect(errs(null)).toEqual(["overlay must be an object with custom[] and patches{}"]);
    expect(errs({ patches: { nope: { version: 1 } } })[0]).toMatch(/no built-in recipe/);
    expect(errs({ patches: { [schedules.id]: { version: 1, signals: { "door.nothing": { weight: 1 } } } } })[0]).toMatch(/does not exist/);
    expect(errs({ patches: { [schedules.id]: { version: 1, signals: { "door.header": { weight: "3" } } } } })[0]).toMatch(/weight must be a number/);
    expect(errs({ patches: { [schedules.id]: { version: 1, signals: { "door.header": { role: "maybe" } } } } })[0]).toMatch(/role/);
    expect(errs({ patches: { [schedules.id]: { version: 1, signals: { "door.header": { spec: { type: "nope" } } } } } })[0]).toMatch(/unknown spec type/);
    expect(errs({ patches: { [schedules.id]: { version: 1, detectThreshold: 1.5 } } })[0]).toMatch(/detectThreshold/);
    expect(errs({ patches: { [schedules.id]: { version: 1, classBias: { spaceship: 1 } } } })[0]).toMatch(/unknown class/);
    expect(errs({ patches: { [schedules.id]: { version: 1, classBias: { door: Number.NaN } } } })[0]).toMatch(/classBias.door/);
    expect(errs({ patches: { [schedules.id]: { version: 1, removed: ["door.nothing"] } } })[0]).toMatch(/unknown id/);
    expect(errs({ patches: { [schedules.id]: { version: 1, addedSignals: [{ classId: "door", signal: { id: "header", label: "x", spec: { type: "sheet" }, weight: 1, role: "score" } }] } } })[0]).toMatch(/already exists/);
    expect(errs({ patches: { [schedules.id]: { version: 1, addedSignals: [{ classId: "nope", signal: { id: "x", spec: { type: "sheet" }, weight: 1, role: "score" } }] } } })[0]).toMatch(/unknown class/);
    expect(errs({ patches: { [schedules.id]: { version: 1, addedClasses: [{ id: "door", name: "Door", bias: 0, signals: [] }] } } })[0]).toMatch(/already exists/);
    expect(errs({ patches: { [schedules.id]: { version: 1, bogus: 1 } } })[0]).toMatch(/unknown field/);
    expect(errs({ custom: [{ ...clone(schedules) }] })[0]).toMatch(/is a built-in/);
    expect(errs({ custom: [{ id: "x" }] })[0]).toMatch(/custom\[0\]/);
    expect(errs({ custom: [{ ...clone(schedules), id: "Bad Id" }] })[0]).toMatch(/lower-case/);
    expect(errs({ custom: "x" })[0]).toMatch(/custom must be a list/);
  });

  it("a valid custom recipe is normalized (enabled default, source custom)", () => {
    const custom = { ...clone(schedules), id: "acme.schedules", version: 1 } as Record<string, unknown>;
    delete custom.enabled;
    const r = validateOverlay({ custom: [custom] }, BUILT_IN_RECIPES);
    expect(r.errors).toEqual([]);
    expect(r.overlay!.custom[0]).toMatchObject({ id: "acme.schedules", enabled: true, source: "custom" });
  });
});

describe("bumpOverlayVersions", () => {
  const base = schedules.version;
  it("bumps a changed patch past max(stored, built-in), keeps an unchanged one, and handles custom recipes", () => {
    const patch = { version: 0, classBias: { door: -2 } };
    const first = bumpOverlayVersions({ custom: [], patches: { [schedules.id]: patch } }, null, BUILT_IN_RECIPES);
    expect(first.patches[schedules.id].version).toBe(base + 1);
    const same = bumpOverlayVersions({ custom: [], patches: { [schedules.id]: { version: 99, classBias: { door: -2 } } } }, first, BUILT_IN_RECIPES);
    expect(same.patches[schedules.id].version).toBe(base + 1);
    const changed = bumpOverlayVersions({ custom: [], patches: { [schedules.id]: { version: 0, classBias: { door: -1 } } } }, first, BUILT_IN_RECIPES);
    expect(changed.patches[schedules.id].version).toBe(base + 2);
    const custom = { ...clone(schedules), id: "acme.x", source: "custom" as const, version: 5 };
    const c1 = bumpOverlayVersions({ custom: [custom], patches: {} }, null, BUILT_IN_RECIPES);
    expect(c1.custom[0].version).toBe(5);
    const c2 = bumpOverlayVersions({ custom: [{ ...custom, version: 1 }], patches: {} }, c1, BUILT_IN_RECIPES);
    expect(c2.custom[0].version).toBe(5);
    const c3 = bumpOverlayVersions({ custom: [{ ...custom, nameThreshold: 0.7 }], patches: {} }, c1, BUILT_IN_RECIPES);
    expect(c3.custom[0].version).toBe(6);
    const stale: ClassifierOverlay = { custom: [], patches: { [schedules.id]: { version: 1, classBias: { door: -2 } } } };
    expect(bumpOverlayVersions({ custom: [], patches: { [schedules.id]: { version: 1, classBias: { door: -3 } } } }, stale, BUILT_IN_RECIPES).patches[schedules.id].version).toBe(Math.max(1, base) + 1);
  });
});
