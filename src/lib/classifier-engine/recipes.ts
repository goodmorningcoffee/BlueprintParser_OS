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
import heuristicsRaw from "@/data/classifiers/heuristics.v1.json";
import { CANDIDATE_TYPES, checkCandidates, checkScope, checkSpec } from "./spec-check";
import type { CandidateSource, ClassifierClass, ClassifierOverlay, ClassifierRecipe, HeuristicRecipeOutput, RecipePatch, SignalPatch, SignalRole, SignalSpec, WeightedSignal } from "./types";

export { SPEC_TYPES, CANDIDATE_TYPES } from "./spec-check";
export const ROLES = new Set<SignalRole>(["score", "required", "veto"]);
const AVAILABILITY = new Set<HeuristicRecipeOutput["yoloAvailabilityMode"]>(["require", "degrade", "ignore"]);
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isUnit = (v: unknown): v is number => isNum(v) && v >= 0 && v <= 1;
const fail = (label: string, msg: string): never => { throw new Error(`classifier recipe ${label}: ${msg}`); };

/** Field-level validation of one signal spec (spec-check.ts; throws the first problem with the signal named). */
export function validateSpec(spec: unknown, label: string, id: string): SignalSpec {
  const problems = checkSpec(spec, `signal "${id}"`);
  if (problems.length) fail(label, problems[0]);
  return spec as SignalSpec;
}

export function validateSignal(v: unknown, label: string, seen: Set<string>): WeightedSignal {
  if (!isRecord(v) || typeof v.id !== "string" || !v.id) fail(label, "signal needs an id");
  const s = v as Record<string, unknown>;
  const id = s.id as string;
  if (seen.has(id)) fail(label, `duplicate signal id "${id}"`);
  seen.add(id);
  if (!isNum(s.weight)) fail(label, `signal "${id}" weight must be a number`);
  if (!ROLES.has(s.role as SignalRole)) fail(label, `signal "${id}" role must be score | required | veto`);
  const spec = validateSpec(s.spec, label, id);
  return {
    id, label: typeof s.label === "string" ? s.label : id, spec, weight: s.weight as number,
    role: s.role as SignalRole, enabled: s.enabled !== false, ...(typeof s.note === "string" ? { note: s.note } : {}),
  };
}

export function validateClass(v: unknown, label: string, seen: Set<string>): ClassifierClass {
  if (!isRecord(v) || typeof v.id !== "string" || !v.id || typeof v.name !== "string") fail(label, "class needs id + name");
  const c = v as Record<string, unknown>;
  const id = c.id as string;
  if (seen.has(id)) fail(label, `duplicate class id "${id}"`);
  seen.add(id);
  if (!isNum(c.bias)) fail(label, `class "${id}" bias must be a number`);
  if (c.threshold !== undefined && !isUnit(c.threshold)) fail(label, `class "${id}" threshold must be a number in [0, 1]`);
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
  if (!Array.isArray(r.candidates) || !isRecord(r.scope) || !isRecord(r.detect) || !Array.isArray(r.detect.signals) || !isNum(r.detect.bias) || !isUnit(r.detect.threshold)) {
    fail(label, "needs candidates[], scope, detect {bias, signals[], threshold in [0, 1]}");
  }
  if (!Array.isArray(r.classes) || !isUnit(r.nameThreshold) || !isUnit(r.minMargin) || typeof r.fallbackClassName !== "string") {
    fail(label, "needs classes[], nameThreshold and minMargin in [0, 1], fallbackClassName");
  }
  const shape = [...checkScope(r.scope, "scope:"), ...checkCandidates(r.candidates, "", r.unit === "page")];
  if (shape.length) fail(label, shape[0].trim());
  const detect = r.detect as Record<string, unknown>;
  const cids = new Set<string>();
  const h = r.heuristic;
  if (h !== undefined && (!isRecord(h) || typeof h.minConfidence !== "number" || !AVAILABILITY.has(h.yoloAvailabilityMode as HeuristicRecipeOutput["yoloAvailabilityMode"]))) {
    fail(label, "heuristic needs minConfidence and yoloAvailabilityMode require | degrade | ignore");
  }
  return {
    id: r.id as string, name: r.name as string, version: r.version as number, enabled: r.enabled !== false, source,
    unit: r.unit as ClassifierRecipe["unit"], target: r.target as string,
    candidates: r.candidates as ClassifierRecipe["candidates"], scope: r.scope as ClassifierRecipe["scope"],
    detect: { bias: detect.bias as number, threshold: detect.threshold as number, signals: (detect.signals as unknown[]).map((s) => validateSignal(s, `${label} detect`, new Set())) },
    classes: (r.classes as unknown[]).map((c) => validateClass(c, label, cids)),
    nameThreshold: r.nameThreshold as number, minMargin: r.minMargin as number, deriveName: r.deriveName !== false,
    fallbackClassName: r.fallbackClassName as string, ...(typeof r.note === "string" ? { note: r.note } : {}),
    ...(isRecord(h) ? { heuristic: {
      minConfidence: h.minConfidence as number, yoloAvailabilityMode: h.yoloAvailabilityMode as HeuristicRecipeOutput["yoloAvailabilityMode"],
      ...(typeof h.outputCsiCode === "string" ? { outputCsiCode: h.outputCsiCode } : {}), ...(typeof h.bboxClass === "string" ? { bboxClass: h.bboxClass } : {}),
    } } : {}),
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

/**
 * [2b] The legacy heuristic engine's live built-in rules as page-unit recipes (src/lib/heuristic-port). NOT in
 * BUILT_IN_RECIPES: their output is `pageIntelligence.heuristicInferences` (through the port's adapter), not
 * classifier proposals, so they never reach the proposals panel.
 */
export const HEURISTIC_RECIPES: readonly ClassifierRecipe[] = (heuristicsRaw as unknown[]).map((r) => validateRecipe(r, "built-in"));

/** Loose shape check of a stored overlay (jsonb, so nothing is guaranteed). */
export function isClassifierOverlay(v: unknown): v is ClassifierOverlay {
  return isRecord(v) && (v.custom === undefined || Array.isArray(v.custom)) && (v.patches === undefined || isRecord(v.patches));
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Feature key of a signal in a head: "detect.<id>" or "<classId>.<id>" (types.ts `SignalContribution.signalId`). */
export const signalKey = (head: string, signalId: string): string => `${head}.${signalId}`;
/** `removed` entry for a whole class. */
export const classRemovalKey = (classId: string): string => `class:${classId}`;

/**
 * One head's signals with the patch applied. A patch entry keyed by the feature key ("<head>.<id>") wins
 * over a legacy bare-id entry; `removed` matches the feature key or the bare id. A patched `spec` that
 * fails validation leaves the built-in spec in place.
 */
function patchSignals(head: string, signals: WeightedSignal[], patch: RecipePatch, removed: Set<string>, label: string): WeightedSignal[] {
  const bySignal = isRecord(patch.signals) ? patch.signals : {};
  return signals.filter((s) => !removed.has(signalKey(head, s.id)) && !removed.has(s.id)).map((s) => {
    const p = (bySignal[signalKey(head, s.id)] ?? bySignal[s.id]) as SignalPatch | undefined;
    if (!isRecord(p)) return s;
    let spec = s.spec;
    if (p.spec !== undefined) { try { spec = validateSpec(p.spec, label, s.id); } catch { /* keep the built-in spec */ } }
    return {
      ...s,
      spec,
      ...(typeof p.weight === "number" && Number.isFinite(p.weight) ? { weight: p.weight } : {}),
      ...(p.role && ROLES.has(p.role) ? { role: p.role } : {}),
      ...(typeof p.enabled === "boolean" ? { enabled: p.enabled } : {}),
      ...(typeof p.label === "string" ? { label: p.label } : {}),
      ...(typeof p.note === "string" ? { note: p.note } : {}),
    };
  });
}

/**
 * One built-in with one company patch applied. The patch is jsonb written by the builder UI (step 3), so
 * every field is shape-checked here and a field of the wrong shape is ignored (`removed: 5`,
 * `addedSignals: {}`, `signals: "x"`, `classBias: null`); the caller also catches, so a patch can never
 * take the recipe (or the whole post-YOLO enrichment that runs it) down.
 */
export function patchRecipe(r: ClassifierRecipe, patch: RecipePatch): ClassifierRecipe {
  const label = `"${r.id}" overlay`;
  const removed = new Set(Array.isArray(patch.removed) ? patch.removed.filter((id): id is string => typeof id === "string") : []);
  const classBias = isRecord(patch.classBias) ? patch.classBias : {};
  const classThreshold = isRecord(patch.classThreshold) ? patch.classThreshold : {};
  const classMeta = isRecord(patch.classMeta) ? patch.classMeta : {};
  const next = clone(r);
  if (typeof patch.version === "number") next.version = patch.version;
  if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
  if (typeof patch.name === "string" && patch.name.trim()) next.name = patch.name;
  if (typeof patch.detectBias === "number" && Number.isFinite(patch.detectBias)) next.detect.bias = patch.detectBias;
  if (typeof patch.detectThreshold === "number") next.detect.threshold = patch.detectThreshold;
  if (typeof patch.nameThreshold === "number") next.nameThreshold = patch.nameThreshold;
  if (typeof patch.minMargin === "number") next.minMargin = patch.minMargin;
  if (isRecord(patch.scope)) next.scope = clone(patch.scope) as ClassifierRecipe["scope"];
  if (Array.isArray(patch.candidates)) {
    const cands = patch.candidates.filter((c) => isRecord(c) && CANDIDATE_TYPES.has(c.type as CandidateSource["type"]));
    if (cands.length) next.candidates = clone(cands) as CandidateSource[];
  }
  next.detect.signals = patchSignals("detect", next.detect.signals, patch, removed, label);
  next.classes = next.classes.filter((c) => !removed.has(classRemovalKey(c.id)) && !removed.has(c.id)).map((c) => {
    const meta = isRecord(classMeta[c.id]) ? (classMeta[c.id] as Record<string, unknown>) : {};
    const out: ClassifierClass = {
      ...c,
      ...(typeof meta.name === "string" && meta.name.trim() ? { name: meta.name } : {}),
      ...(typeof meta.group === "string" && meta.group.trim() ? { group: meta.group } : {}),
      ...(typeof meta.legacyCategory === "string" && meta.legacyCategory.trim() ? { legacyCategory: meta.legacyCategory } : {}),
      bias: typeof classBias[c.id] === "number" ? (classBias[c.id] as number) : c.bias,
      ...(typeof classThreshold[c.id] === "number" ? { threshold: classThreshold[c.id] as number } : {}),
      signals: patchSignals(c.id, c.signals, patch, removed, label),
    };
    if (meta.legacyCategory === null) delete out.legacyCategory;
    return out;
  });
  for (const add of Array.isArray(patch.addedSignals) ? patch.addedSignals : []) {
    try {
      if (!isRecord(add)) continue;
      const sig = validateSignal(add.signal, label, new Set());
      const target = add.classId === null ? next.detect.signals : next.classes.find((c) => c.id === add.classId)?.signals;
      if (target && !target.some((s) => s.id === sig.id)) target.push(sig);
    } catch { /* a malformed added signal is skipped, never fatal */ }
  }
  for (const add of Array.isArray(patch.addedClasses) ? patch.addedClasses : []) {
    try { if (!next.classes.some((c) => c.id === (add as ClassifierClass).id)) next.classes.push(validateClass(add, label, new Set())); } catch { /* skipped */ }
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
