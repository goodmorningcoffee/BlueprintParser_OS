/**
 * classifier-engine/heads.ts — the scoring arithmetic of types.ts: a head's logit is
 * `bias + Σ weight × value` over its enabled "score" signals (sigmoid → p); a "required" signal
 * with value 0 rejects the head, a "veto" signal with value > 0 rejects it. The naming head picks
 * the class with the highest p; it wins only when p ≥ its threshold AND it beats the runner-up by
 * `minMargin`, else the recipe falls back (`classId: null`). Pure.
 */

import type { CandidateEvidence, PageEvidence } from "./evidence";
import { evaluateSignal } from "./signals";
import type { ClassifierClass, ClassifierRecipe, SignalContribution, WeightedSignal } from "./types";

export const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));
const r3 = (v: number): number => Math.round(v * 1000) / 1000;
/** Contributions kept on a proposal (|delta| descending). */
export const WHY_CAP = 8;

export interface HeadResult {
  logit: number;
  p: number;
  rejected: boolean;
  /** Every evaluated contribution (required / veto carry delta 0). */
  contributions: SignalContribution[];
  features: Record<string, number>;
}

export function evaluateHead(prefix: string, bias: number, signals: readonly WeightedSignal[], cand: CandidateEvidence, page: PageEvidence): HeadResult {
  let logit = bias;
  let rejected = false;
  const contributions: SignalContribution[] = [];
  const features: Record<string, number> = {};
  for (const s of signals) {
    if (!s.enabled) continue;
    const { value, detail } = evaluateSignal(s.spec, cand, page);
    const id = `${prefix}.${s.id}`;
    features[id] = value;
    const delta = s.role === "score" ? r3(s.weight * value) : 0;
    if (s.role === "score") logit += s.weight * value;
    else if (s.role === "required" && value <= 0) rejected = true;
    else if (s.role === "veto" && value > 0) rejected = true;
    contributions.push({ signalId: id, label: s.label, value, weight: s.weight, delta, ...(detail ? { detail } : {}) });
  }
  return { logit: r3(logit), p: r3(sigmoid(logit)), rejected, contributions, features };
}

export const topWhy = (c: readonly SignalContribution[]): SignalContribution[] =>
  [...c].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || b.value - a.value).slice(0, WHY_CAP);

export interface ClassPick {
  classId: string | null;
  className: string;
  group: string | null;
  nameP: number;
  margin: number;
  runnerUp?: { classId: string; nameP: number };
  legacyCategory?: string;
  why: SignalContribution[];
  features: Record<string, number>;
}

export function pickClass(recipe: Pick<ClassifierRecipe, "classes" | "nameThreshold" | "minMargin" | "fallbackClassName">, cand: CandidateEvidence, page: PageEvidence): ClassPick {
  const scored: Array<{ cls: ClassifierClass; head: HeadResult }> = [];
  const features: Record<string, number> = {};
  for (const cls of recipe.classes) {
    const head = evaluateHead(cls.id, cls.bias, cls.signals, cand, page);
    Object.assign(features, head.features);
    if (!head.rejected) scored.push({ cls, head });
  }
  scored.sort((a, b) => b.head.p - a.head.p || (a.cls.id < b.cls.id ? -1 : 1));
  const best = scored[0];
  const second = scored[1];
  const margin = best ? r3(best.head.p - (second?.head.p ?? 0)) : 0;
  const runnerUp = second ? { classId: second.cls.id, nameP: second.head.p } : undefined;
  if (best && best.head.p >= (best.cls.threshold ?? recipe.nameThreshold) && margin >= recipe.minMargin) {
    return {
      classId: best.cls.id, className: best.cls.name, group: best.cls.group, nameP: best.head.p, margin, runnerUp,
      ...(best.cls.legacyCategory ? { legacyCategory: best.cls.legacyCategory } : {}),
      why: topWhy(best.head.contributions), features,
    };
  }
  return {
    classId: null, className: recipe.fallbackClassName, group: null, nameP: best?.head.p ?? 0, margin, runnerUp,
    why: best ? topWhy(best.head.contributions) : [], features,
  };
}
