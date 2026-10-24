// [classifier builder track 3] The editor model over the real built-ins: patch building round-trips
// through applyOverlay, scoped signal keys (a "header" edit in `door` leaves `window`'s header alone),
// spec patches, reset signal / class / recipe, diff lines, strict overlay validation (unknown ids,
// bad numbers, malformed specs, fitter-shaped overlays), and version bumps per changed recipe.
import { describe, expect, it } from "vitest";
import {
  BUILT_IN_RECIPES, DETECT, applyOverlay, buildRecipePatch, bumpOverlayVersions, describePatch, mergeOverlay, resetClass, resetRecipe, resetSignal,
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
  d.name = "Our schedules";
  const win = d.classes.find((c) => c.id === "window")!;
  win.name = "Windows"; win.group = "openings"; win.legacyCategory = "window-schedule";
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
    expect(patch.name).toBe("Our schedules");
    expect(patch.classMeta).toEqual({ window: { name: "Windows", group: "openings", legacyCategory: "window-schedule" } });
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

  it("classMeta: legacyCategory null clears the built-in's bridge category; blank names are ignored", () => {
    const regions = BUILT_IN_RECIPES.find((r) => r.id === "regions.v1")!;
    const withLegacy = regions.classes.find((c) => c.legacyCategory)!;
    const d = clone(regions);
    delete d.classes.find((c) => c.id === withLegacy.id)!.legacyCategory;
    const patch = buildRecipePatch(regions, d)!;
    expect(patch.classMeta).toEqual({ [withLegacy.id]: { legacyCategory: null } });
    const [eff] = applyOverlay([regions], { custom: [], patches: { [regions.id]: patch } });
    expect(eff.classes.find((c) => c.id === withLegacy.id)!.legacyCategory).toBeUndefined();
    const [kept] = applyOverlay([regions], { custom: [], patches: { [regions.id]: { version: 1, name: "  ", classMeta: { [withLegacy.id]: { name: "" } } } } });
    expect(kept.name).toBe(regions.name);
    expect(kept.classes.find((c) => c.id === withLegacy.id)!.name).toBe(withLegacy.name);
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
    expect(paths).toContain("changed name");
    expect(paths).toContain("changed Window / glazing schedule: name");
    expect(paths).toContain("changed Window / glazing schedule: legacy category");
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

  it("checks a spec patch field by field: scope names, term weights, division strings, list element types, enums, regexes", () => {
    const errs = (v: unknown) => validateOverlay(v, BUILT_IN_RECIPES).errors;
    const spec = (s: unknown, key = "door.header") => ({ patches: { [schedules.id]: { version: 1, signals: { [key]: { spec: s } } } } });
    expect(errs(spec({ type: "words", where: "nowhere", terms: { DOOR: 1 } }))[0]).toMatch(/where must be one of box \| header/);
    expect(errs(spec({ type: "words", where: "header", terms: { DOOR: "abc" } }))[0]).toMatch(/term weights must be numbers/);
    expect(errs(spec({ type: "words", where: "header", terms: {} }))[0]).toMatch(/at least one term/);
    expect(errs(spec({ type: "words", where: "header", terms: { DOOR: 1 }, saturation: 0 }))[0]).toMatch(/saturation/);
    expect(errs(spec({ type: "words", where: "header", terms: { DOOR: 1 }, bogus: 1 }))[0]).toMatch(/unknown field "bogus"/);
    expect(errs(spec({ type: "csi", where: "box", divisions: [8], measure: "share" }, "door.csiDiv"))[0]).toMatch(/divisions must be a list of strings/);
    expect(errs(spec({ type: "csi", where: "box", divisions: ["8"], measure: "share" }, "door.csiDiv"))[0]).toMatch(/two digits/);
    expect(errs(spec({ type: "csi", where: "header", divisions: ["08"], measure: "share" }, "door.csiDiv"))[0]).toMatch(/where must be one of box \| page/);
    expect(errs(spec({ type: "csi", where: "box", measure: "share" }, "door.csiDiv"))[0]).toMatch(/divisions or sectionPrefixes/);
    expect(errs(spec({ type: "csi", where: "box", divisions: ["08"], measure: "share", minCodes: 0.5 }, "door.csiDiv"))[0]).toMatch(/minCodes/);
    expect(errs(spec({ type: "sheet", disciplines: [1] }, "door.sheet"))[0]).toMatch(/disciplines must be a list of strings/);
    expect(errs(spec({ type: "sheet", numberPattern: "(" }, "door.sheet"))[0]).toMatch(/regular expression/);
    const added = (s: unknown) => ({ patches: { [schedules.id]: { version: 1, addedSignals: [{ classId: null, signal: { id: "x", spec: s, weight: 1, role: "score" } }] } } });
    expect(errs(added({ type: "yolo", where: "inside", classes: [null], measure: "presence" }))[0]).toMatch(/classes must be a list of strings/);
    expect(errs(added({ type: "yolo", where: "inside", classes: [], measure: "presence" }))[0]).toMatch(/classes needs at least one entry/);
    expect(errs(added({ type: "yolo", where: "inside", classes: ["tables"], measure: "presence", minConfidence: 2 }))[0]).toMatch(/minConfidence/);
    expect(errs(added({ type: "structure", feature: "nope" }))[0]).toMatch(/feature must be one of/);
    expect(errs(added({ type: "structure", feature: "textCols", scale: -1 }))[0]).toMatch(/scale/);
    expect(errs(added({ type: "shapes", shapes: ["circle"], where: "outside" }))[0]).toMatch(/where must be one of inside \| leftColumn/);
    expect(errs(added({ type: "zone", zone: "sky" }))[0]).toMatch(/zone must be one of/);
    expect(errs(added({ type: "channel", pageKinds: ["paper"] }))[0]).toMatch(/invalid page kinds/);
    expect(errs(added({ type: "textract-table", minContainment: 1.5 }))[0]).toMatch(/minContainment/);
    // every valid shape still passes
    expect(errs(added({ type: "yolo", where: "near", classes: ["tables"], measure: "cover", model: "yolo_medium", minConfidence: 0.3 }))).toEqual([]);
    expect(errs(added({ type: "channel", pageKinds: ["vector"] }))).toEqual([]);
    expect(errs(added({ type: "sheet", disciplines: ["A"], numberPattern: "^A-?6" }))).toEqual([]);
    // scope and candidates patches are checked the same way
    expect(errs({ patches: { [schedules.id]: { version: 1, scope: { sheetNumberPattern: "(" } } } })[0]).toMatch(/regular expression/);
    expect(errs({ patches: { [schedules.id]: { version: 1, scope: { minWords: 5, maxWords: 2 } } } })[0]).toMatch(/maxWords/);
    expect(errs({ patches: { [schedules.id]: { version: 1, scope: { pageKinds: ["paper"] } } } })[0]).toMatch(/page kinds/);
    expect(errs({ patches: { [schedules.id]: { version: 1, candidates: [{ type: "regions-v2", kinds: ["blob"] }] } } })[0]).toMatch(/region kinds/);
    expect(errs({ patches: { [schedules.id]: { version: 1, candidates: [null] } } })[0]).toMatch(/unknown type/);
    expect(errs({ patches: { [schedules.id]: { version: 1, candidates: [{ type: "textract-tables", minRows: -1 }] } } })[0]).toMatch(/minRows/);
  });

  it("a custom recipe is checked as deeply as a patch (candidates, scope, thresholds, classes)", () => {
    const errs = (v: unknown) => validateOverlay(v, BUILT_IN_RECIPES).errors;
    const custom = (over: Record<string, unknown>) => ({ custom: [{ ...clone(schedules), id: "acme.x", ...over }] });
    expect(errs(custom({ candidates: [null] }))[0]).toMatch(/candidates\[0\] has an unknown type/);
    expect(errs(custom({ scope: { sheetNumberPattern: "(" } }))[0]).toMatch(/regular expression/);
    expect(errs(custom({ nameThreshold: 7 }))[0]).toMatch(/nameThreshold and minMargin in \[0, 1\]/);
    expect(errs(custom({ detect: { ...schedules.detect, bias: Number.NaN } }))[0]).toMatch(/detect/);
    expect(errs(custom({ classes: [null] }))[0]).toMatch(/class needs id \+ name/);
    expect(errs(custom({ classes: [{ id: "a", name: "A", group: "x", bias: 0, signals: [], threshold: 2 }] }))[0]).toMatch(/threshold must be a number in \[0, 1\]/);
    expect(errs(custom({}))).toEqual([]);
  });

  it("rejects a rename patch on an unknown class, a blank name, and unknown classMeta fields", () => {
    const errs = (v: unknown) => validateOverlay(v, BUILT_IN_RECIPES).errors;
    expect(errs({ patches: { [schedules.id]: { version: 1, classMeta: { spaceship: { name: "x" } } } } })[0]).toMatch(/unknown class "spaceship"/);
    expect(errs({ patches: { [schedules.id]: { version: 1, classMeta: { door: { name: " " } } } } })[0]).toMatch(/classMeta.door.name/);
    expect(errs({ patches: { [schedules.id]: { version: 1, classMeta: { door: { colour: "red" } } } } })[0]).toMatch(/unknown field "colour"/);
    expect(errs({ patches: { [schedules.id]: { version: 1, name: "" } } })[0]).toMatch(/name must be a non-empty string/);
    expect(errs({ patches: { [schedules.id]: { version: 1, name: "Ours", classMeta: { door: { name: "Doors", group: "openings", legacyCategory: null } } } } })).toEqual([]);
  });

  it("a valid custom recipe is normalized (enabled default, source custom)", () => {
    const custom = { ...clone(schedules), id: "acme.schedules", version: 1 } as Record<string, unknown>;
    delete custom.enabled;
    const r = validateOverlay({ custom: [custom] }, BUILT_IN_RECIPES);
    expect(r.errors).toEqual([]);
    expect(r.overlay!.custom[0]).toMatchObject({ id: "acme.schedules", enabled: true, source: "custom" });
  });
});

describe("mergeOverlay", () => {
  it("replaces by recipe id and keeps everything else in the stored overlay", () => {
    const custom = { ...clone(schedules), id: "acme.x", source: "custom" as const };
    const stored: ClassifierOverlay = { custom: [custom], patches: { [schedules.id]: { version: 2, classBias: { door: -1 } }, "regions.v1": { version: 1, enabled: false } } };
    const merged = mergeOverlay(stored, { custom: [], patches: { [schedules.id]: { version: 1, signals: { "door.header": { weight: 9 } } } } });
    expect(merged.patches[schedules.id]).toEqual({ version: 1, signals: { "door.header": { weight: 9 } } });
    expect(merged.patches["regions.v1"]).toEqual({ version: 1, enabled: false });
    expect(merged.custom).toEqual([custom]);
    const replaced = mergeOverlay(merged, { custom: [{ ...custom, nameThreshold: 0.9 }, { ...custom, id: "acme.y" }], patches: {} });
    expect(replaced.custom.map((r) => [r.id, r.nameThreshold])).toEqual([["acme.x", 0.9], ["acme.y", custom.nameThreshold]]);
    expect(replaced.patches).toEqual(merged.patches);
    expect(mergeOverlay(null, { custom: [], patches: {} })).toEqual({ custom: [], patches: {} });
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
