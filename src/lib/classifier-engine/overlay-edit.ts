/**
 * classifier-engine/overlay-edit.ts — the builder's editor model, pure and shared by the admin tab
 * and PUT /api/admin/classifiers/overlay:
 *   • buildRecipePatch   a built-in and its edited draft → the sparse RecipePatch (null = no change)
 *   • describePatch      a patch → human-readable diff lines ("door · header: weight 3 → 4")
 *   • resetSignal / resetClass / resetRecipe   put the built-in value back into a draft
 *   • validateOverlay    strict shape + reference validation (unknown recipe / signal / class ids,
 *                        non-finite numbers, malformed specs) — the server never stores an overlay
 *                        that fails it, the client shows the same messages before saving
 *   • bumpOverlayVersions   per patched / custom recipe: version +1 when its content changed
 * Patches key signals by feature key ("detect.<id>" / "<classId>.<id>"), the key `features` and
 * fitted overlays use, so a fitter's overlay goes through the same validation unchanged.
 */

import type { RegionV2Signals } from "@/lib/region-classifier-v2/types";
import { ROLES, applyOverlay, classRemovalKey, signalKey, validateClass, validateRecipe, validateSignal } from "./recipes";
import { checkCandidates, checkScope, checkSpec } from "./spec-check";
import type {
  ClassMetaPatch, ClassifierClass, ClassifierOverlay, ClassifierRecipe, ClassifierScope, RecipePatch, SignalPatch, WeightedSignal,
} from "./types";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
/** Key-order-independent JSON text (a stored jsonb value comes back with its keys reordered). */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** "detect", "table" (the table-ness head, when the recipe has one) or a class id. */
export type HeadId = string;
export const DETECT: HeadId = "detect";
/** [shape-tags fix round] The table-ness head's id in feature keys ("table.<id>") and patches. */
export const TABLE: HeadId = "table";

export function headSignals(recipe: ClassifierRecipe, head: HeadId): WeightedSignal[] | undefined {
  if (head === DETECT) return recipe.detect.signals;
  if (head === TABLE) return recipe.tableHead?.signals;
  return recipe.classes.find((c) => c.id === head)?.signals;
}

const SIGNAL_FIELDS = ["weight", "role", "enabled", "label", "note", "spec"] as const;

function signalPatch(base: WeightedSignal, draft: WeightedSignal): SignalPatch | null {
  const out: SignalPatch = {};
  for (const f of SIGNAL_FIELDS) {
    if (!same(base[f], draft[f])) (out as Record<string, unknown>)[f] = draft[f];
  }
  return Object.keys(out).length ? out : null;
}

function patchHead(head: HeadId, base: readonly WeightedSignal[], draft: readonly WeightedSignal[], patch: RecipePatch, classId: string | null): void {
  for (const b of base) {
    const d = draft.find((s) => s.id === b.id);
    if (!d) { (patch.removed ??= []).push(signalKey(head, b.id)); continue; }
    const p = signalPatch(b, d);
    if (p) (patch.signals ??= {})[signalKey(head, b.id)] = p;
  }
  for (const d of draft) if (!base.some((s) => s.id === d.id)) (patch.addedSignals ??= []).push({ classId, signal: clone(d) });
}

/**
 * The sparse patch that turns `builtIn` into `draft`; null when they are the same. `version` is the caller's;
 * `baseVersion` records the built-in the patch was made against (recipes.ts `patchRecipe` drops a stale patch's
 * detect / table head numbers).
 */
export function buildRecipePatch(builtIn: ClassifierRecipe, draft: ClassifierRecipe, version: number = builtIn.version): RecipePatch | null {
  const patch: RecipePatch = { version, baseVersion: builtIn.version };
  if (builtIn.enabled !== draft.enabled) patch.enabled = draft.enabled;
  if (builtIn.name !== draft.name) patch.name = draft.name;
  if (builtIn.detect.bias !== draft.detect.bias) patch.detectBias = draft.detect.bias;
  if (builtIn.tableHead && draft.tableHead && builtIn.tableHead.bias !== draft.tableHead.bias) patch.tableBias = draft.tableHead.bias;
  if (builtIn.detect.threshold !== draft.detect.threshold) patch.detectThreshold = draft.detect.threshold;
  if (builtIn.nameThreshold !== draft.nameThreshold) patch.nameThreshold = draft.nameThreshold;
  if (builtIn.minMargin !== draft.minMargin) patch.minMargin = draft.minMargin;
  if (!same(builtIn.scope, draft.scope)) patch.scope = clone(draft.scope);
  if (!same(builtIn.candidates, draft.candidates)) patch.candidates = clone(draft.candidates);
  patchHead(DETECT, builtIn.detect.signals, draft.detect.signals, patch, null);
  if (builtIn.tableHead && draft.tableHead) patchHead(TABLE, builtIn.tableHead.signals, draft.tableHead.signals, patch, TABLE);
  for (const b of builtIn.classes) {
    const d = draft.classes.find((c) => c.id === b.id);
    if (!d) { (patch.removed ??= []).push(classRemovalKey(b.id)); continue; }
    if (b.bias !== d.bias) (patch.classBias ??= {})[b.id] = d.bias;
    if (!same(b.threshold, d.threshold) && d.threshold !== undefined) (patch.classThreshold ??= {})[b.id] = d.threshold;
    const meta: ClassMetaPatch = {};
    if (b.name !== d.name) meta.name = d.name;
    if (b.group !== d.group) meta.group = d.group;
    if (!same(b.legacyCategory, d.legacyCategory)) meta.legacyCategory = d.legacyCategory ?? null;
    if (Object.keys(meta).length) (patch.classMeta ??= {})[b.id] = meta;
    patchHead(b.id, b.signals, d.signals, patch, b.id);
  }
  for (const d of draft.classes) if (!builtIn.classes.some((c) => c.id === d.id)) (patch.addedClasses ??= []).push(clone(d));
  return Object.keys(patch).length > 2 ? patch : null;
}

export interface DiffLine { path: string; kind: "changed" | "added" | "removed"; from?: string; to?: string }

const show = (v: unknown): string => (v === undefined ? "—" : typeof v === "string" ? v : JSON.stringify(v));

/** Human-readable lines for a patch over its built-in (unknown ids are still listed, flagged in the path). */
export function describePatch(builtIn: ClassifierRecipe, patch: RecipePatch | null | undefined): DiffLine[] {
  if (!patch) return [];
  const out: DiffLine[] = [];
  const top: Array<[keyof RecipePatch, string, unknown]> = [
    ["name", "name", builtIn.name], ["enabled", "enabled", builtIn.enabled], ["detectBias", "detect bias", builtIn.detect.bias], ["detectThreshold", "detect threshold", builtIn.detect.threshold],
    ["tableBias", "table-ness bias", builtIn.tableHead?.bias],
    ["nameThreshold", "name threshold", builtIn.nameThreshold], ["minMargin", "min margin", builtIn.minMargin], ["scope", "scope", builtIn.scope], ["candidates", "candidates", builtIn.candidates],
  ];
  for (const [key, label, base] of top) if (patch[key] !== undefined) out.push({ path: label, kind: "changed", from: show(base), to: show(patch[key]) });
  const className = (id: string): string => builtIn.classes.find((c) => c.id === id)?.name ?? id;
  const headLabel = (head: string): string => (head === DETECT ? "detect" : head === TABLE ? "table-ness" : className(head));
  for (const [key, p] of Object.entries(patch.signals ?? {})) {
    const dot = key.indexOf(".");
    const head = dot === -1 ? "*" : key.slice(0, dot);
    const sid = dot === -1 ? key : key.slice(dot + 1);
    const base = (head === "*" ? allSignals(builtIn) : headSignals(builtIn, head) ?? []).find((s) => s.id === sid);
    for (const [f, v] of Object.entries(p)) {
      out.push({ path: `${head === "*" ? "every head" : headLabel(head)} · ${sid}: ${f}`, kind: "changed", from: show(base ? (base as unknown as Record<string, unknown>)[f] : undefined), to: show(v) });
    }
  }
  for (const [cid, v] of Object.entries(patch.classBias ?? {})) out.push({ path: `${className(cid)}: bias`, kind: "changed", from: show(builtIn.classes.find((c) => c.id === cid)?.bias), to: show(v) });
  for (const [cid, v] of Object.entries(patch.classThreshold ?? {})) out.push({ path: `${className(cid)}: threshold`, kind: "changed", from: show(builtIn.classes.find((c) => c.id === cid)?.threshold), to: show(v) });
  for (const [cid, meta] of Object.entries(patch.classMeta ?? {})) {
    for (const [f, v] of Object.entries(meta ?? {})) out.push({ path: `${className(cid)}: ${f === "legacyCategory" ? "legacy category" : f}`, kind: "changed", from: show((builtIn.classes.find((c) => c.id === cid) as unknown as Record<string, unknown> | undefined)?.[f]), to: v === null ? "—" : show(v) });
  }
  for (const a of patch.addedSignals ?? []) out.push({ path: `${a.classId === null ? "detect" : headLabel(a.classId)} · ${a.signal?.id ?? "?"}`, kind: "added", to: a.signal?.label });
  for (const c of patch.addedClasses ?? []) out.push({ path: `class ${c.name ?? c.id}`, kind: "added", to: `${c.signals?.length ?? 0} signals` });
  for (const r of patch.removed ?? []) {
    if (r.startsWith("class:")) out.push({ path: `class ${className(r.slice(6))}`, kind: "removed" });
    else { const dot = r.indexOf("."); out.push({ path: dot === -1 ? `every head · ${r}` : `${headLabel(r.slice(0, dot))} · ${r.slice(dot + 1)}`, kind: "removed" }); }
  }
  return out;
}

/** The built-in's signal back into the draft (at its original position); an added signal is dropped. */
export function resetSignal(draft: ClassifierRecipe, builtIn: ClassifierRecipe, head: HeadId, signalId: string): ClassifierRecipe {
  const next = clone(draft);
  const target = headSignals(next, head);
  if (!target) return next;
  const baseList = headSignals(builtIn, head) ?? [];
  const baseIdx = baseList.findIndex((s) => s.id === signalId);
  const idx = target.findIndex((s) => s.id === signalId);
  if (baseIdx === -1) { if (idx !== -1) target.splice(idx, 1); return next; }
  const base = clone(baseList[baseIdx]);
  if (idx === -1) target.splice(Math.min(baseIdx, target.length), 0, base);
  else target[idx] = base;
  return next;
}

/** The built-in's class back into the draft; an added class is dropped. */
export function resetClass(draft: ClassifierRecipe, builtIn: ClassifierRecipe, classId: string): ClassifierRecipe {
  const next = clone(draft);
  const baseIdx = builtIn.classes.findIndex((c) => c.id === classId);
  const idx = next.classes.findIndex((c) => c.id === classId);
  if (baseIdx === -1) { if (idx !== -1) next.classes.splice(idx, 1); return next; }
  const base = clone(builtIn.classes[baseIdx]);
  if (idx === -1) next.classes.splice(Math.min(baseIdx, next.classes.length), 0, base);
  else next.classes[idx] = base;
  return next;
}

export const resetRecipe = (builtIn: ClassifierRecipe): ClassifierRecipe => clone(builtIn);

// ── strict validation ────────────────────────────────────────────────────────

const STR_LIST = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
/** Every signal of every head (bare-id patch keys match across heads). */
const allSignals = (r: ClassifierRecipe): WeightedSignal[] => [...r.detect.signals, ...(r.tableHead?.signals ?? []), ...r.classes.flatMap((c) => c.signals)];

function validateClassMeta(meta: unknown, classIds: Set<string>, at: string, errors: string[]): void {
  if (!isRecord(meta)) { errors.push(`${at}: classMeta must be an object keyed by class id`); return; }
  for (const [cid, m] of Object.entries(meta)) {
    if (!classIds.has(cid)) { errors.push(`${at}: classMeta names unknown class "${cid}"`); continue; }
    if (!isRecord(m)) { errors.push(`${at}: classMeta.${cid} must be an object`); continue; }
    for (const f of ["name", "group"]) if (m[f] !== undefined && !nonEmpty(m[f])) errors.push(`${at}: classMeta.${cid}.${f} must be a non-empty string`);
    if (m.legacyCategory !== undefined && m.legacyCategory !== null && !nonEmpty(m.legacyCategory)) errors.push(`${at}: classMeta.${cid}.legacyCategory must be a non-empty string or null`);
    for (const f of Object.keys(m)) if (!["name", "group", "legacyCategory"].includes(f)) errors.push(`${at}: classMeta.${cid} has an unknown field "${f}"`);
  }
}

function validateSignalPatchEntry(key: string, p: unknown, recipe: ClassifierRecipe, at: string, errors: string[]): void {
  const dot = key.indexOf(".");
  const head = dot === -1 ? null : key.slice(0, dot);
  const sid = dot === -1 ? key : key.slice(dot + 1);
  const exists = head === null ? allSignals(recipe).some((s) => s.id === sid) : (headSignals(recipe, head) ?? []).some((s) => s.id === sid);
  if (!exists) { errors.push(`${at}: signal "${key}" does not exist`); return; }
  if (!isRecord(p)) { errors.push(`${at}: signal "${key}" patch must be an object`); return; }
  if (p.weight !== undefined && !isNum(p.weight)) errors.push(`${at}: signal "${key}" weight must be a number`);
  if (p.role !== undefined && !ROLES.has(p.role as never)) errors.push(`${at}: signal "${key}" role must be score | required | veto`);
  if (p.enabled !== undefined && typeof p.enabled !== "boolean") errors.push(`${at}: signal "${key}" enabled must be true/false`);
  for (const f of ["label", "note"]) if (p[f] !== undefined && typeof p[f] !== "string") errors.push(`${at}: signal "${key}" ${f} must be a string`);
  if (p.spec !== undefined) for (const m of checkSpec(p.spec, `signal "${key}"`)) errors.push(`${at}: ${m}`);
  for (const f of Object.keys(p)) if (!SIGNAL_FIELDS.includes(f as never)) errors.push(`${at}: signal "${key}" has an unknown field "${f}"`);
}

function validatePatch(id: string, patch: unknown, builtIn: ClassifierRecipe, errors: string[]): void {
  const at = `patch "${id}"`;
  if (!isRecord(patch)) { errors.push(`${at}: must be an object`); return; }
  for (const k of ["detectThreshold", "nameThreshold", "minMargin"]) if (patch[k] !== undefined && !(isNum(patch[k]) && (patch[k] as number) >= 0 && (patch[k] as number) <= 1)) errors.push(`${at}: ${k} must be a number in [0, 1]`);
  if (patch.detectBias !== undefined && !isNum(patch.detectBias)) errors.push(`${at}: detectBias must be a number`);
  if (patch.tableBias !== undefined && !isNum(patch.tableBias)) errors.push(`${at}: tableBias must be a number`);
  else if (patch.tableBias !== undefined && !builtIn.tableHead) errors.push(`${at}: tableBias set but the recipe has no table-ness head`);
  if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") errors.push(`${at}: enabled must be true/false`);
  if (patch.name !== undefined && !nonEmpty(patch.name)) errors.push(`${at}: name must be a non-empty string`);
  if (patch.version !== undefined && !isNum(patch.version)) errors.push(`${at}: version must be a number`);
  if (patch.baseVersion !== undefined && !isNum(patch.baseVersion)) errors.push(`${at}: baseVersion must be a number`);
  if (patch.scope !== undefined) for (const m of checkScope(patch.scope, "scope:")) errors.push(`${at}: ${m}`);
  if (patch.candidates !== undefined) for (const m of checkCandidates(patch.candidates, "")) errors.push(`${at}: ${m.trim()}`);
  const classIds = new Set(builtIn.classes.map((c) => c.id));
  if (patch.classMeta !== undefined) validateClassMeta(patch.classMeta, classIds, at, errors);
  if (patch.signals !== undefined) {
    if (!isRecord(patch.signals)) errors.push(`${at}: signals must be an object`);
    else for (const [key, p] of Object.entries(patch.signals)) validateSignalPatchEntry(key, p, builtIn, at, errors);
  }
  for (const k of ["classBias", "classThreshold"]) {
    const m = patch[k];
    if (m === undefined) continue;
    if (!isRecord(m)) { errors.push(`${at}: ${k} must be an object`); continue; }
    for (const [cid, v] of Object.entries(m)) {
      if (!classIds.has(cid)) errors.push(`${at}: ${k} names unknown class "${cid}"`);
      else if (!isNum(v) || (k === "classThreshold" && (v < 0 || v > 1))) errors.push(`${at}: ${k}.${cid} must be a number${k === "classThreshold" ? " in [0, 1]" : ""}`);
    }
  }
  const addedIds = new Map<string, Set<string>>();
  if (patch.addedSignals !== undefined) {
    if (!Array.isArray(patch.addedSignals)) errors.push(`${at}: addedSignals must be a list`);
    else patch.addedSignals.forEach((a, i) => {
      if (!isRecord(a) || (a.classId !== null && typeof a.classId !== "string")) { errors.push(`${at}: addedSignals[${i}] needs classId (null = detect) and signal`); return; }
      const head = a.classId === null ? DETECT : (a.classId as string);
      const existing = headSignals(builtIn, head);
      if (!existing) { errors.push(`${at}: addedSignals[${i}] names unknown ${head === TABLE ? "head" : "class"} "${head}"`); return; }
      try {
        const sig = validateSignal(a.signal, builtIn.id, new Set());
        const seen = addedIds.get(head) ?? addedIds.set(head, new Set()).get(head)!;
        if (existing.some((s) => s.id === sig.id) || seen.has(sig.id)) errors.push(`${at}: addedSignals[${i}] id "${sig.id}" already exists in ${head}`);
        seen.add(sig.id);
      } catch (e) { errors.push(`${at}: ${(e as Error).message}`); }
    });
  }
  if (patch.addedClasses !== undefined) {
    if (!Array.isArray(patch.addedClasses)) errors.push(`${at}: addedClasses must be a list`);
    else patch.addedClasses.forEach((c, i) => {
      try {
        const cls = validateClass(c, builtIn.id, new Set());
        if (classIds.has(cls.id)) errors.push(`${at}: addedClasses[${i}] id "${cls.id}" already exists`);
      } catch (e) { errors.push(`${at}: ${(e as Error).message}`); }
    });
  }
  if (patch.removed !== undefined) {
    if (!STR_LIST(patch.removed)) errors.push(`${at}: removed must be a list of ids`);
    else for (const r of patch.removed) {
      const ok = r.startsWith("class:") ? classIds.has(r.slice(6))
        : r.includes(".") ? (headSignals(builtIn, r.slice(0, r.indexOf("."))) ?? []).some((s) => s.id === r.slice(r.indexOf(".") + 1))
          : classIds.has(r) || allSignals(builtIn).some((s) => s.id === r);
      if (!ok) errors.push(`${at}: removed names unknown id "${r}"`);
    }
  }
  const KNOWN = new Set(["version", "baseVersion", "enabled", "name", "detectBias", "tableBias", "detectThreshold", "nameThreshold", "minMargin", "signals", "classBias", "classThreshold", "classMeta", "addedSignals", "addedClasses", "removed", "scope", "candidates"]);
  for (const k of Object.keys(patch)) if (!KNOWN.has(k)) errors.push(`${at}: unknown field "${k}"`);
  if (!errors.length) {
    try { validateRecipe(applyOverlay([builtIn], { custom: [], patches: { [id]: patch as unknown as RecipePatch } })[0], "built-in"); }
    catch (e) { errors.push(`${at}: ${(e as Error).message}`); }
  }
}

export interface OverlayValidation { errors: string[]; overlay: ClassifierOverlay | null }

/** Strict validation of a client / fitter overlay against the built-ins. errors empty ⇒ `overlay` is the normalized value to store. */
export function validateOverlay(input: unknown, builtIns: readonly ClassifierRecipe[]): OverlayValidation {
  const errors: string[] = [];
  if (!isRecord(input)) return { errors: ["overlay must be an object with custom[] and patches{}"], overlay: null };
  const custom: ClassifierRecipe[] = [];
  const builtInIds = new Set(builtIns.map((r) => r.id));
  if (input.custom !== undefined) {
    if (!Array.isArray(input.custom)) errors.push("custom must be a list of recipes");
    else input.custom.forEach((c, i) => {
      try {
        const rec = validateRecipe(c, "custom");
        if (builtInIds.has(rec.id)) errors.push(`custom[${i}]: id "${rec.id}" is a built-in recipe`);
        else if (custom.some((r) => r.id === rec.id)) errors.push(`custom[${i}]: duplicate id "${rec.id}"`);
        else if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(rec.id)) errors.push(`custom[${i}]: id "${rec.id}" must be lower-case letters, digits, dots, dashes`);
        else custom.push(rec);
      } catch (e) { errors.push(`custom[${i}]: ${(e as Error).message}`); }
    });
  }
  const patches: Record<string, RecipePatch> = {};
  if (input.patches !== undefined) {
    if (!isRecord(input.patches)) errors.push("patches must be an object keyed by built-in recipe id");
    else for (const [id, patch] of Object.entries(input.patches)) {
      const builtIn = builtIns.find((r) => r.id === id);
      if (!builtIn) { errors.push(`patch "${id}": no built-in recipe with that id`); continue; }
      const before = errors.length;
      validatePatch(id, patch, builtIn, errors);
      if (errors.length === before) patches[id] = clone(patch as RecipePatch);
    }
  }
  if (errors.length) return { errors, overlay: null };
  return { errors, overlay: { custom, patches } };
}

/**
 * Versions for a save: a built-in's patch gets `max(stored patch version, built-in version) + 1` when its
 * content (version / baseVersion aside) changed, else the stored version; a custom recipe gets `stored + 1`
 * when changed, else the stored version; a new custom recipe keeps its own version (≥ 1). Every built-in patch
 * is stamped `baseVersion` = the built-in's current version: the saver saw the heads it is layering on
 * (recipes.ts drops a stale patch's detect / table head numbers until it is saved again).
 */
export function bumpOverlayVersions(next: ClassifierOverlay, stored: ClassifierOverlay | null | undefined, builtIns: readonly ClassifierRecipe[]): ClassifierOverlay {
  const out: ClassifierOverlay = { custom: [], patches: {} };
  const strip = (p: RecipePatch): Omit<RecipePatch, "version" | "baseVersion"> => { const { version: _v, baseVersion: _b, ...rest } = p; return rest; };
  for (const [id, patch] of Object.entries(next.patches)) {
    const prev = stored?.patches?.[id];
    const base = builtIns.find((r) => r.id === id)?.version ?? 0;
    const prevVersion = isNum(prev?.version) ? Math.max(prev!.version, base) : base;
    const changed = !prev || !same(strip(prev), strip(patch));
    out.patches[id] = { ...patch, version: changed ? prevVersion + 1 : prevVersion, baseVersion: base };
  }
  for (const rec of next.custom) {
    const prev = stored?.custom?.find((r) => r.id === rec.id);
    const { version: _a, ...recBody } = rec;
    const { version: _b, ...prevBody } = prev ?? ({} as ClassifierRecipe);
    const version = !prev ? Math.max(1, Math.floor(rec.version) || 1) : same(recBody, prevBody) ? prev.version : prev.version + 1;
    out.custom.push({ ...rec, version });
  }
  return out;
}

/**
 * `incoming` laid over `stored` by recipe id: a patch replaces the stored patch of that built-in, a custom
 * recipe replaces the stored one with its id, everything else in `stored` is kept. For a fitter (or any
 * caller) that carries only the recipes it touched; the tab sends the whole overlay and replaces instead.
 */
export function mergeOverlay(stored: ClassifierOverlay | null | undefined, incoming: ClassifierOverlay): ClassifierOverlay {
  const patches: Record<string, RecipePatch> = {};
  for (const [id, p] of Object.entries(isRecord(stored?.patches) ? stored.patches : {})) if (isRecord(p)) patches[id] = clone(p);
  Object.assign(patches, clone(incoming.patches));
  const custom = (Array.isArray(stored?.custom) ? stored.custom : []).filter((r) => isRecord(r) && typeof r.id === "string").map(clone);
  for (const rec of incoming.custom) {
    const i = custom.findIndex((r) => r.id === rec.id);
    if (i === -1) custom.push(clone(rec)); else custom[i] = clone(rec);
  }
  return { custom, patches };
}

/** A class as "add class" creates it: no signals, neutral bias. */
export const blankClass = (id: string, name: string, group: string): ClassifierClass => ({ id, name, group, bias: -3, signals: [] });

/** A new custom recipe skeleton. */
export function blankRecipe(id: string, name: string): ClassifierRecipe {
  return {
    id, name, version: 1, enabled: true, source: "custom", unit: "region", target: "schedule",
    candidates: [{ type: "regions-v2", kinds: ["table"] }], scope: { excludeTitleBlock: true, minWords: 3 } as ClassifierScope,
    detect: { bias: -1, threshold: 0.5, signals: [{ id: "structure", label: "region v2 structure score", spec: { type: "structure", feature: "structureScore" as keyof RegionV2Signals }, weight: 4, role: "score", enabled: true }] },
    classes: [], nameThreshold: 0.5, minMargin: 0.1, deriveName: true, fallbackClassName: "Other",
  };
}
