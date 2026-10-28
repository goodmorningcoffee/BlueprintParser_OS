/**
 * classifier-engine/fit-score.ts — re-score a recipe from STORED feature values (a proposal's or a
 * verdict's `features`, keyed "detect.<id>" / "<classId>.<id>") without the page evidence, and the
 * metrics the weight fitter (fit.ts) reports. The arithmetic is heads.ts's, step for step (same
 * signal order, same rounding, same tie-break), so scoring the hand recipe from a proposal's own
 * features reproduces its `p` and `classId`. A feature missing from the record scores 0. Pure.
 */

import { sigmoid } from "./heads";
import { OTHER_SCHEDULE, scheduleKind } from "./vocabulary";
import type { ClassifierRecipe, WeightedSignal } from "./types";

const r3 = (v: number): number => Math.round(v * 1000) / 1000;

/** One labelled candidate for fitting / scoring. */
export interface FitSample {
  features: Record<string, number>;
  /** Detect label: the candidate IS the recipe's target (verdict accept / rename; corpus kind ≠ not-a-schedule). */
  isTarget: boolean;
  /** Naming label when `isTarget`: the final class id, or null (fallback: other schedule, or a kind the recipe has no class for). */
  classId: string | null;
  /** [shape-tags] Table-ness label (schedule ∪ legend / keynote list) for the recipe's `tableHead`; absent → the head is not fitted. */
  isTable?: boolean;
  /** CV fold key (set number); the fitter never reads it. */
  fold?: number;
  /** [TP-3 WP-3.Q] Weight in the logistic loss (default 1). `samplesFromVerdicts` gives a `via:"parse"` accept
   *  `PARSE_ACCEPT_WEIGHT`: a parse-save shows the region is a table, not that its stored class is right (K58). */
  weight?: number;
}

export interface HeadScore { logit: number; p: number; rejected: boolean }

export function scoreHead(prefix: string, bias: number, signals: readonly WeightedSignal[], features: Record<string, number>): HeadScore {
  let logit = bias;
  let rejected = false;
  for (const s of signals) {
    if (!s.enabled) continue;
    const value = features[`${prefix}.${s.id}`] ?? 0;
    if (s.role === "score") logit += s.weight * value;
    else if (s.role === "required" && value <= 0) rejected = true;
    else if (s.role === "veto" && value > 0) rejected = true;
  }
  return { logit, p: r3(sigmoid(logit)), rejected };
}

export interface ScoredSample {
  detectP: number;
  /** Passes the detect head (not rejected, p ≥ threshold). */
  detected: boolean;
  /** Naming head winner, null on fallback (scored regardless of `detected`). */
  classId: string | null;
  nameP: number;
}

/** heads.ts pickClass over stored features. */
export function scoreFeatures(recipe: ClassifierRecipe, features: Record<string, number>): ScoredSample {
  const d = scoreHead("detect", recipe.detect.bias, recipe.detect.signals, features);
  const scored = recipe.classes
    .map((cls) => ({ cls, head: scoreHead(cls.id, cls.bias, cls.signals, features) }))
    .filter((x) => !x.head.rejected)
    .sort((a, b) => b.head.p - a.head.p || (a.cls.id < b.cls.id ? -1 : 1));
  const best = scored[0];
  const margin = best ? r3(best.head.p - (scored[1]?.head.p ?? 0)) : 0;
  const named = !!best && best.head.p >= (best.cls.threshold ?? recipe.nameThreshold) && margin >= recipe.minMargin;
  return { detectP: d.p, detected: !d.rejected && d.p >= recipe.detect.threshold, classId: named ? best.cls.id : null, nameP: best?.head.p ?? 0 };
}

export interface Acc { n: number; ok: number }
export interface EvalMetrics {
  /** Detect head over every sample: tp = target kept, fp = non-target kept, fn = target dropped, tn = non-target dropped. */
  detect: { tp: number; fp: number; fn: number; tn: number; precision: number | null; recall: number | null; nonTargetFiltered: number | null };
  /** Naming head over the target samples (independent of detect): top-1 kind, fallback counted as "other-schedule". */
  naming: { top1: Acc; byGroup: Record<string, Acc>; byKind: Record<string, Acc>; named: Acc };
}

const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);
const bump = (m: Record<string, Acc>, k: string, ok: boolean) => { const a = (m[k] ??= { n: 0, ok: 0 }); a.n++; if (ok) a.ok++; };
export const kindOf = (classId: string | null): string => classId ?? OTHER_SCHEDULE;
export const groupOf = (kind: string): string => scheduleKind(kind)?.group ?? "other";

export function evaluateRecipe(recipe: ClassifierRecipe, samples: readonly FitSample[]): EvalMetrics {
  const det = { tp: 0, fp: 0, fn: 0, tn: 0 };
  const top1: Acc = { n: 0, ok: 0 };
  const named: Acc = { n: 0, ok: 0 };
  const byGroup: Record<string, Acc> = {};
  const byKind: Record<string, Acc> = {};
  for (const s of samples) {
    const sc = scoreFeatures(recipe, s.features);
    if (s.isTarget) { if (sc.detected) det.tp++; else det.fn++; } else if (sc.detected) det.fp++; else det.tn++;
    if (!s.isTarget) continue;
    const kind = kindOf(s.classId);
    const ok = kindOf(sc.classId) === kind;
    top1.n++; if (ok) top1.ok++;
    if (sc.classId) { named.n++; if (ok) named.ok++; }
    bump(byGroup, groupOf(kind), ok);
    bump(byKind, kind, ok);
  }
  return {
    detect: { ...det, precision: ratio(det.tp, det.tp + det.fp), recall: ratio(det.tp, det.tp + det.fn), nonTargetFiltered: ratio(det.tn, det.tn + det.fp) },
    naming: { top1, byGroup, byKind, named },
  };
}
