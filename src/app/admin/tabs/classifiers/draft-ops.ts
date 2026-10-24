// [classifier builder track 3 2026-10-24] Pure draft operations behind Admin › Classifiers: immutable
// edits of a recipe draft (signals, classes, fields), the overlay a set of drafts saves as, and the small
// formatters the preview pane uses. No React, no fetch — unit-tested in __tests__/classifier-draft-ops.test.ts.

import {
  DETECT, buildRecipePatch, headSignals, signalKey,
  type ClassifierClass, type ClassifierOverlay, type ClassifierRecipe, type SignalContribution, type WeightedSignal, type HeadId,
} from "@/lib/classifier-engine";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export type Drafts = Record<string, ClassifierRecipe>;

/** The overlay to PUT: a patch per modified built-in, every custom draft whole. */
export function overlayFromDrafts(builtIns: readonly ClassifierRecipe[], drafts: Drafts): ClassifierOverlay {
  const overlay: ClassifierOverlay = { custom: [], patches: {} };
  for (const draft of Object.values(drafts)) {
    const builtIn = builtIns.find((r) => r.id === draft.id);
    if (!builtIn) { overlay.custom.push(clone(draft)); continue; }
    const patch = buildRecipePatch(builtIn, draft, draft.version);
    if (patch) overlay.patches[draft.id] = patch;
  }
  return overlay;
}

export const isModified = (builtIn: ClassifierRecipe | undefined, draft: ClassifierRecipe): boolean =>
  !!builtIn && buildRecipePatch(builtIn, draft) !== null;

function withHead(recipe: ClassifierRecipe, head: HeadId, fn: (signals: WeightedSignal[]) => void): ClassifierRecipe {
  const next = clone(recipe);
  const list = headSignals(next, head);
  if (list) fn(list);
  return next;
}

export function updateSignal(recipe: ClassifierRecipe, head: HeadId, signalId: string, patch: Partial<WeightedSignal>): ClassifierRecipe {
  return withHead(recipe, head, (list) => {
    const i = list.findIndex((s) => s.id === signalId);
    if (i !== -1) list[i] = { ...list[i], ...patch };
  });
}

/** An id unique within the head: `base`, `base-2`, `base-3`, … */
export function newSignalId(existing: readonly WeightedSignal[], base: string): string {
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "signal";
  if (!existing.some((s) => s.id === slug)) return slug;
  for (let n = 2; ; n++) if (!existing.some((s) => s.id === `${slug}-${n}`)) return `${slug}-${n}`;
}

export function addSignal(recipe: ClassifierRecipe, head: HeadId, signal: Omit<WeightedSignal, "id">, baseId: string): ClassifierRecipe {
  return withHead(recipe, head, (list) => { list.push({ ...signal, id: newSignalId(list, baseId) }); });
}

export function duplicateSignal(recipe: ClassifierRecipe, head: HeadId, signalId: string): ClassifierRecipe {
  return withHead(recipe, head, (list) => {
    const i = list.findIndex((s) => s.id === signalId);
    if (i === -1) return;
    const copy = clone(list[i]);
    list.splice(i + 1, 0, { ...copy, id: newSignalId(list, copy.id), label: `${copy.label} (copy)` });
  });
}

export function removeSignal(recipe: ClassifierRecipe, head: HeadId, signalId: string): ClassifierRecipe {
  return withHead(recipe, head, (list) => {
    const i = list.findIndex((s) => s.id === signalId);
    if (i !== -1) list.splice(i, 1);
  });
}

export function updateClass(recipe: ClassifierRecipe, classId: string, patch: Partial<Omit<ClassifierClass, "signals">>): ClassifierRecipe {
  const next = clone(recipe);
  const i = next.classes.findIndex((c) => c.id === classId);
  if (i !== -1) next.classes[i] = { ...next.classes[i], ...patch };
  return next;
}

export function addClass(recipe: ClassifierRecipe, cls: ClassifierClass): ClassifierRecipe {
  const next = clone(recipe);
  if (!next.classes.some((c) => c.id === cls.id)) next.classes.push(clone(cls));
  return next;
}

export function removeClass(recipe: ClassifierRecipe, classId: string): ClassifierRecipe {
  const next = clone(recipe);
  next.classes = next.classes.filter((c) => c.id !== classId);
  return next;
}

export function updateRecipe(recipe: ClassifierRecipe, patch: Partial<Omit<ClassifierRecipe, "classes" | "detect">> & { detect?: Partial<ClassifierRecipe["detect"]> }): ClassifierRecipe {
  const { detect, ...rest } = patch;
  return { ...clone(recipe), ...rest, detect: { ...recipe.detect, ...(detect ?? {}) } };
}

/** Classes grouped for display: group id → classes, in first-seen order. */
export function groupClasses(classes: readonly ClassifierClass[]): Array<[string, ClassifierClass[]]> {
  const out = new Map<string, ClassifierClass[]>();
  for (const c of classes) (out.get(c.group) ?? out.set(c.group, []).get(c.group)!).push(c);
  return [...out.entries()];
}

/** "1-3, 7, 12" → [1, 2, 3, 7, 12] (deduped, sorted, ≤ `cap`); invalid → []. */
export function parsePageSpec(text: string, cap = 20): number[] {
  const out = new Set<number>();
  for (const part of text.split(/[,\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return [];
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b < a) return [];
    for (let p = a; p <= b && out.size < cap; p++) out.add(p);
  }
  return [...out].sort((x, y) => x - y);
}

const r1 = (v: number): string => (v >= 0 ? "+" : "") + (Math.round(v * 100) / 100).toString();

/** "Div 08 share +1.6" — a contribution as the preview list prints it. */
export function formatContribution(c: SignalContribution): string {
  const base = c.weight === 0 && c.delta === 0 ? `${c.label} ${c.value > 0 ? "yes" : "no"}` : `${c.label} ${r1(c.delta)}`;
  return c.detail ? `${base} (${c.detail})` : base;
}

export const pct = (v: number): string => `${Math.round(v * 100)}%`;

/** The feature key used in `features`, patches and the fitter: "detect.<id>" / "<classId>.<id>". */
export const featureKey = (head: HeadId, signalId: string): string => signalKey(head === DETECT ? "detect" : head, signalId);
