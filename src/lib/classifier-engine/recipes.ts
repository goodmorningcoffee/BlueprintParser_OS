/**
 * classifier-engine/recipes.ts — the built-in recipes (src/data/classifiers/*.json, validated at
 * import so a malformed file throws at build time rather than naming nothing), their provenance
 * hash, and the per-company overlay merge (`companies.pipeline_config.classifiers`, a
 * `ClassifierOverlay`): sparse patches of built-ins by recipe / signal / class id, plus whole custom
 * recipes. Patches never change a built-in's structure; `removed` disables signals or classes by id.
 * The effective list is what the engine runs. Pure.
 */

import schedulesRaw from "@/data/classifiers/schedules.v1.json";
import regionsRaw from "@/data/classifiers/regions.v1.json";
import type { ClassifierClass, ClassifierOverlay, ClassifierRecipe, SignalRole, SignalSpec, WeightedSignal } from "./types";

const SPEC_TYPES = new Set<SignalSpec["type"]>(["words", "csi", "sheet", "yolo", "structure", "textract-table", "shapes", "zone", "channel"]);
const ROLES = new Set<SignalRole>(["score", "required", "veto"]);
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const fail = (label: string, msg: string): never => { throw new Error(`classifier recipe ${label}: ${msg}`); };

function validateSignal(v: unknown, label: string, seen: Set<string>): WeightedSignal {
  if (!isRecord(v) || typeof v.id !== "string" || !v.id) fail(label, "signal needs an id");
  const s = v as Record<string, unknown>;
  const id = s.id as string;
  if (seen.has(id)) fail(label, `duplicate signal id "${id}"`);
  seen.add(id);
  if (typeof s.weight !== "number" || !Number.isFinite(s.weight)) fail(label, `signal "${id}" weight must be a number`);
  if (!ROLES.has(s.role as SignalRole)) fail(label, `signal "${id}" role must be score | required | veto`);
  const spec = s.spec;
  if (!isRecord(spec) || !SPEC_TYPES.has(spec.type as SignalSpec["type"])) throw new Error(`classifier recipe ${label}: signal "${id}" has an unknown spec type`);
  if (spec.type === "words" && !isRecord(spec.terms)) throw new Error(`classifier recipe ${label}: signal "${id}" words spec needs terms`);
  return {
    id, label: typeof s.label === "string" ? s.label : id, spec: spec as unknown as SignalSpec, weight: s.weight as number,
    role: s.role as SignalRole, enabled: s.enabled !== false, ...(typeof s.note === "string" ? { note: s.note } : {}),
  };
}

function validateClass(v: unknown, label: string, seen: Set<string>): ClassifierClass {
  if (!isRecord(v) || typeof v.id !== "string" || !v.id || typeof v.name !== "string") fail(label, "class needs id + name");
  const c = v as Record<string, unknown>;
  const id = c.id as string;
  if (seen.has(id)) fail(label, `duplicate class id "${id}"`);
  seen.add(id);
  if (typeof c.bias !== "number") fail(label, `class "${id}" bias must be a number`);
  if (!Array.isArray(c.signals)) fail(label, `class "${id}" needs signals[]`);
  const sids = new Set<string>();
  return {
    id, name: c.name as string, group: typeof c.group === "string" ? c.group : "other", bias: c.bias as number,
    signals: (c.signals as unknown[]).map((s) => validateSignal(s, `${label} class "${id}"`, sids)),
    ...(typeof c.legacyCategory === "string" ? { legacyCategory: c.legacyCategory } : {}),
    ...(typeof c.threshold === "number" ? { threshold: c.threshold } : {}),
  };
}

/** Structural validation of one recipe (built-in or custom). Throws with the recipe named. */
export function validateRecipe(v: unknown, source: "built-in" | "custom"): ClassifierRecipe {
  if (!isRecord(v) || typeof v.id !== "string" || !v.id) fail("?", "recipe needs an id");
  const r = v as Record<string, unknown>;
  const label = `"${r.id as string}"`;
  if (typeof r.name !== "string" || typeof r.version !== "number" || typeof r.target !== "string") fail(label, "needs name, numeric version and target");
  if (r.unit !== "region" && r.unit !== "page") fail(label, "unit must be region | page");
  if (!Array.isArray(r.candidates) || !isRecord(r.scope) || !isRecord(r.detect) || !Array.isArray(r.detect.signals) || typeof r.detect.bias !== "number" || typeof r.detect.threshold !== "number") {
    fail(label, "needs candidates[], scope, detect {bias, signals[], threshold}");
  }
  if (!Array.isArray(r.classes) || typeof r.nameThreshold !== "number" || typeof r.minMargin !== "number" || typeof r.fallbackClassName !== "string") {
    fail(label, "needs classes[], nameThreshold, minMargin, fallbackClassName");
  }
  const detect = r.detect as Record<string, unknown>;
  const cids = new Set<string>();
  return {
    id: r.id as string, name: r.name as string, version: r.version as number, enabled: r.enabled !== false, source,
    unit: r.unit as ClassifierRecipe["unit"], target: r.target as string,
    candidates: r.candidates as ClassifierRecipe["candidates"], scope: r.scope as ClassifierRecipe["scope"],
    detect: { bias: detect.bias as number, threshold: detect.threshold as number, signals: (detect.signals as unknown[]).map((s) => validateSignal(s, `${label} detect`, new Set())) },
    classes: (r.classes as unknown[]).map((c) => validateClass(c, label, cids)),
    nameThreshold: r.nameThreshold as number, minMargin: r.minMargin as number, deriveName: r.deriveName !== false,
    fallbackClassName: r.fallbackClassName as string, ...(typeof r.note === "string" ? { note: r.note } : {}),
  };
}

/** FNV-1a 32-bit over the JSON text — a provenance stamp, not a security hash. */
export function hashRecipes(recipes: readonly ClassifierRecipe[]): string {
  const s = JSON.stringify(recipes);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

export const BUILT_IN_RECIPES: readonly ClassifierRecipe[] = [validateRecipe(schedulesRaw, "built-in"), validateRecipe(regionsRaw, "built-in")];
export const BUILT_IN_RECIPES_HASH = hashRecipes(BUILT_IN_RECIPES);

/** Loose shape check of a stored overlay (jsonb, so nothing is guaranteed). */
export function isClassifierOverlay(v: unknown): v is ClassifierOverlay {
  return isRecord(v) && (v.custom === undefined || Array.isArray(v.custom)) && (v.patches === undefined || isRecord(v.patches));
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

type RecipePatch = NonNullable<ClassifierOverlay["patches"][string]>;

/** `prefix` is the head ("detect" or the class id): a qualified key "<prefix>.<id>" wins over the bare id. */
function patchSignals(signals: WeightedSignal[], patch: RecipePatch, removed: Set<string>, prefix: string): WeightedSignal[] {
  const bySignal = isRecord(patch.signals) ? patch.signals : {};
  return signals.filter((s) => !removed.has(s.id)).map((s) => {
    const p = isRecord(bySignal[`${prefix}.${s.id}`]) ? bySignal[`${prefix}.${s.id}`] : bySignal[s.id];
    if (!isRecord(p)) return s;
    return {
      ...s,
      ...(typeof p.weight === "number" ? { weight: p.weight } : {}),
      ...(p.role && ROLES.has(p.role) ? { role: p.role } : {}),
      ...(typeof p.enabled === "boolean" ? { enabled: p.enabled } : {}),
      ...(typeof p.label === "string" ? { label: p.label } : {}),
    };
  });
}

/**
 * One built-in with one company patch applied. The patch is jsonb written by the builder UI (step 3), so
 * every field is shape-checked here and a field of the wrong shape is ignored (`removed: 5`,
 * `addedSignals: {}`, `signals: "x"`, `classBias: null`); the caller also catches, so a patch can never
 * take the recipe (or the whole post-YOLO enrichment that runs it) down.
 */
function patchRecipe(r: ClassifierRecipe, patch: RecipePatch): ClassifierRecipe {
  const removed = new Set(Array.isArray(patch.removed) ? patch.removed.filter((id): id is string => typeof id === "string") : []);
  const classBias = isRecord(patch.classBias) ? patch.classBias : {};
  const next = clone(r);
  if (typeof patch.version === "number") next.version = patch.version;
  if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
  if (typeof patch.detectThreshold === "number") next.detect.threshold = patch.detectThreshold;
  if (typeof patch.nameThreshold === "number") next.nameThreshold = patch.nameThreshold;
  if (typeof patch.minMargin === "number") next.minMargin = patch.minMargin;
  if (typeof patch.detectBias === "number" && Number.isFinite(patch.detectBias)) next.detect.bias = patch.detectBias;
  next.detect.signals = patchSignals(next.detect.signals, patch, removed, "detect");
  next.classes = next.classes.filter((c) => !removed.has(c.id)).map((c) => ({
    ...c, bias: typeof classBias[c.id] === "number" ? (classBias[c.id] as number) : c.bias, signals: patchSignals(c.signals, patch, removed, c.id),
  }));
  for (const add of Array.isArray(patch.addedSignals) ? patch.addedSignals : []) {
    try {
      if (!isRecord(add)) continue;
      const sig = validateSignal(add.signal, `"${r.id}" overlay`, new Set());
      if (add.classId === null) next.detect.signals.push(sig);
      else next.classes.find((c) => c.id === add.classId)?.signals.push(sig);
    } catch { /* a malformed added signal is skipped, never fatal */ }
  }
  for (const add of Array.isArray(patch.addedClasses) ? patch.addedClasses : []) {
    try { if (!next.classes.some((c) => c.id === (add as ClassifierClass).id)) next.classes.push(validateClass(add, `"${r.id}" overlay`, new Set())); } catch { /* skipped */ }
  }
  return next;
}

/** Built-ins with the company's patches applied (a malformed patch leaves its built-in as is), then its custom recipes (invalid ones skipped). */
export function applyOverlay(builtIns: readonly ClassifierRecipe[], overlay: ClassifierOverlay | null | undefined): ClassifierRecipe[] {
  const patches = isRecord(overlay?.patches) ? overlay.patches : {};
  const out: ClassifierRecipe[] = builtIns.map((r) => {
    const patch = patches[r.id];
    if (!isRecord(patch)) return r;
    try { return patchRecipe(r, patch as RecipePatch); } catch { return r; }
  });
  for (const custom of Array.isArray(overlay?.custom) ? overlay.custom : []) {
    try {
      const rec = validateRecipe(custom, "custom");
      if (!out.some((r) => r.id === rec.id)) out.push(rec);
    } catch { /* skipped */ }
  }
  return out;
}

/** The recipes the engine runs for a company: built-ins + its overlay (unknown / malformed overlay → built-ins). Never throws. */
export function effectiveRecipes(overlay?: unknown): ClassifierRecipe[] {
  try { return applyOverlay(BUILT_IN_RECIPES, isClassifierOverlay(overlay) ? overlay : null); } catch { return [...BUILT_IN_RECIPES]; }
}
