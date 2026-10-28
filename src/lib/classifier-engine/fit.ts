/**
 * classifier-engine/fit.ts — weight fitting (plan step 4): an L2-regularised logistic regression per
 * head over stored feature values, compared against the hand weights, emitted as a PROPOSED
 * `ClassifierOverlay` patch. Nothing here applies it: the builder's overlay save does, on a person's say.
 *
 *   detect head  features "detect.*", label = the candidate is the target (verdict accept / rename = 1,
 *                reject = 0; corpus kind ≠ not-a-schedule)
 *   each class   one-vs-rest over the target samples, features "<classId>.*", label = final class
 *                (accept → proposedClassId, rename → classId)
 *
 * The penalty pulls the weights toward the HAND weights, not toward 0, so a signal the data says nothing
 * about (always 0, e.g. Textract tables on a corpus without them) keeps its hand weight. Only enabled
 * "score" signals are fitted; required / veto roles, disabled signals and recipe structure never change.
 * A head with fewer than `minPositives` positives (or negatives) keeps its hand weights. The detect
 * threshold is re-chosen to keep the hand recall, and the fit is kept only if precision is ≥ hand there;
 * the naming threshold is the one with the best top-1 whose named-precision is ≥ hand. All in-sample:
 * held-out numbers come from the caller (scripts/classifier-fit.ts). Damped Newton, deterministic. Pure.
 */

import { applyOverlay } from "./recipes";
import { evaluateRecipe, scoreFeatures, scoreHead, type EvalMetrics, type FitSample } from "./fit-score";
import type { ClassifierOverlay, ClassifierRecipe, ProposalVerdict, WeightedSignal } from "./types";
import { OTHER_SCHEDULE } from "./vocabulary";

export const FIT_VERSION = "clf-fit/1";
export const MIN_POSITIVES = 8;
export const DEFAULT_LAMBDA = 1;
/** [TP-3 WP-3.Q, K58] Sample weight of a `via:"parse"` accept: the save of a parse started from the proposal records the
 *  proposal's OWN class (`classId ?? proposedClassId`), so it is weak evidence for naming and detection alike. */
export const PARSE_ACCEPT_WEIGHT = 0.25;
export type RecipePatch = ClassifierOverlay["patches"][string];

const r3 = (v: number): number => Math.round(v * 1000) / 1000;

// ── solver ─────────────────────────────────────────────────────────────────────────────────────

export interface LogisticOptions {
  /** L2 strength on the weights (> 0), pulling toward `prior.weights`. The loss is a SUM over samples. */
  lambda: number;
  prior?: { bias: number; weights: readonly number[] };
  /** L2 on the bias toward `prior.bias` (default 1e-3: keeps a one-sided or separable set finite). */
  biasLambda?: number;
  maxIter?: number;
  /** Converged when the largest gradient component is below this (default 1e-9). */
  tol?: number;
  /** Per-sample weights in the loss (default all 1; finite, ≥ 0, one per row of X). */
  sampleWeights?: readonly number[];
}
export interface LogisticResult { bias: number; weights: number[]; iterations: number; converged: boolean; loss: number }

const softplus = (z: number): number => (z > 0 ? z + Math.log1p(Math.exp(-z)) : Math.log1p(Math.exp(z)));
const sig = (z: number): number => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

/** Solve A x = b for symmetric positive-definite A (Cholesky). Null when A is not PD. */
function choleskySolve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const L = A.map(() => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) { if (!(s > 0)) return null; L[i][i] = Math.sqrt(s); } else L[i][j] = s / L[j][j];
    }
  }
  const z = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i][k] * z[k]; z[i] = s / L[i][i]; }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) { let s = z[i]; for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k]; x[i] = s / L[i][i]; }
  return x;
}

/** L2-regularised logistic regression (bias + weights) by Newton's method with a backtracking line search. */
export function fitLogistic(X: readonly (readonly number[])[], y: readonly number[], opts: LogisticOptions): LogisticResult {
  if (!(opts.lambda > 0)) throw new Error("fitLogistic: lambda must be > 0");
  if (X.length !== y.length) throw new Error("fitLogistic: X and y differ in length");
  const d = opts.prior?.weights.length ?? X[0]?.length ?? 0;
  if (X.some((row) => row.length !== d)) throw new Error("fitLogistic: ragged X");
  const sw = opts.sampleWeights ?? X.map(() => 1);
  if (sw.length !== X.length || sw.some((w) => !Number.isFinite(w) || w < 0)) throw new Error("fitLogistic: sampleWeights must be one finite weight ≥ 0 per row");
  const m = [opts.prior?.bias ?? 0, ...(opts.prior?.weights ?? new Array<number>(d).fill(0))];
  const reg = [opts.biasLambda ?? 1e-3, ...new Array<number>(d).fill(opts.lambda)];
  const maxIter = opts.maxIter ?? 100;
  const tol = opts.tol ?? 1e-9;
  const z = (t: readonly number[], row: readonly number[]) => { let v = t[0]; for (let j = 0; j < d; j++) v += t[j + 1] * row[j]; return v; };
  const loss = (t: readonly number[]) => {
    let L = 0;
    for (let i = 0; i < X.length; i++) { const zi = z(t, X[i]); L += sw[i] * (softplus(zi) - y[i] * zi); }
    for (let j = 0; j <= d; j++) L += 0.5 * reg[j] * (t[j] - m[j]) ** 2;
    return L;
  };
  let theta = [...m];
  let current = loss(theta);
  let iterations = 0;
  let converged = false;
  for (; iterations < maxIter; iterations++) {
    const g = theta.map((t, j) => reg[j] * (t - m[j]));
    const H = theta.map((_, i) => theta.map((__, j) => (i === j ? reg[i] : 0)));
    for (let i = 0; i < X.length; i++) {
      const p = sig(z(theta, X[i]));
      const xi = [1, ...X[i]];
      const w = sw[i] * p * (1 - p);
      for (let a = 0; a <= d; a++) {
        g[a] += sw[i] * (p - y[i]) * xi[a];
        for (let b = 0; b <= a; b++) H[a][b] += w * xi[a] * xi[b];
      }
    }
    for (let a = 0; a <= d; a++) for (let b = 0; b < a; b++) H[b][a] = H[a][b];
    if (Math.max(...g.map(Math.abs)) < tol) { converged = true; break; }
    const step = choleskySolve(H, g);
    if (!step) break;
    const slope = g.reduce((s, gj, j) => s + gj * step[j], 0);
    let t = 1;
    let accepted = false;
    while (t > 1e-12) {
      const cand = theta.map((v, j) => v - t * step[j]);
      const next = loss(cand);
      if (next <= current - 1e-4 * t * slope) { theta = cand; current = next; accepted = true; break; }
      t /= 2;
    }
    if (!accepted) { converged = true; break; } // at the optimum to machine precision
  }
  return { bias: theta[0], weights: theta.slice(1), iterations, converged, loss: current };
}

// ── heads ──────────────────────────────────────────────────────────────────────────────────────

export type HeadStatus = "fitted" | "small-n" | "no-gain";
export interface HeadFit {
  /** "detect" or the class id. */
  head: string;
  n: number;
  positives: number;
  status: HeadStatus;
  hand: { bias: number; weights: Record<string, number> };
  fitted?: { bias: number; weights: Record<string, number>; iterations: number; converged: boolean };
}

export interface FitOptions { lambda?: number; detectLambda?: number; minPositives?: number }

const scoreSignals = (signals: readonly WeightedSignal[]) => signals.filter((s) => s.enabled && s.role === "score");

function fitHead(prefix: string, bias: number, signals: readonly WeightedSignal[], samples: readonly FitSample[], label: (s: FitSample) => boolean, lambda: number, minPositives: number): HeadFit {
  const sigs = scoreSignals(signals);
  const keys = sigs.map((s) => `${prefix}.${s.id}`);
  const hand = { bias, weights: Object.fromEntries(sigs.map((s, i) => [keys[i], s.weight])) };
  // A sample missing a key was computed under another recipe version; a rejected head (required / veto) can't be moved by weights.
  const usable = samples.filter((s) => keys.every((k) => typeof s.features[k] === "number") && !scoreHead(prefix, bias, signals, s.features).rejected);
  const y = usable.map((s) => (label(s) ? 1 : 0));
  const positives = y.reduce((a: number, b) => a + b, 0);
  const base = { head: prefix, n: usable.length, positives, hand };
  if (positives < minPositives || usable.length - positives < minPositives) return { ...base, status: "small-n" };
  const fit = fitLogistic(usable.map((s) => keys.map((k) => s.features[k])), y, { lambda, prior: { bias, weights: sigs.map((s) => s.weight) }, sampleWeights: usable.map((s) => s.weight ?? 1) });
  return {
    ...base, status: "fitted",
    fitted: { bias: r3(fit.bias), weights: Object.fromEntries(keys.map((k, i) => [k, r3(fit.weights[i])])), iterations: fit.iterations, converged: fit.converged },
  };
}

const withPatch = (recipe: ClassifierRecipe, patch: RecipePatch): ClassifierRecipe => applyOverlay([recipe], { custom: [], patches: { [recipe.id]: patch } })[0];

/** The recipe without signal specs (scoring from features never reads them): trial patches clone this, not the 600 KB built-in. */
const slimRecipe = (r: ClassifierRecipe): ClassifierRecipe => {
  const slim = (signals: readonly WeightedSignal[]) => signals.map((s) => ({ ...s, spec: { type: s.spec.type } as WeightedSignal["spec"] }));
  return { ...r, candidates: [], detect: { ...r.detect, signals: slim(r.detect.signals) }, classes: r.classes.map((c) => ({ ...c, signals: slim(c.signals) })) };
};

function putHead(patch: RecipePatch, h: HeadFit): void {
  if (!h.fitted) return;
  patch.signals ??= {};
  for (const [k, w] of Object.entries(h.fitted.weights)) patch.signals[k] = { weight: w };
  if (h.head === "detect") patch.detectBias = h.fitted.bias;
  else if (h.head === "table") patch.tableBias = h.fitted.bias;
  else (patch.classBias ??= {})[h.head] = h.fitted.bias;
}

/** Largest threshold (a fitted p of some target) at which recall is still ≥ `recall`. */
function thresholdForRecall(recipe: ClassifierRecipe, samples: readonly FitSample[], recall: number): number {
  const targets = samples.filter((s) => s.isTarget).map((s) => ({ p: scoreFeatures(recipe, s.features).detectP, rejected: scoreHead("detect", recipe.detect.bias, recipe.detect.signals, s.features).rejected }));
  const ps = [...new Set(targets.filter((t) => !t.rejected).map((t) => t.p))].sort((a, b) => b - a);
  for (const t of ps) if (targets.filter((x) => !x.rejected && x.p >= t).length / targets.length >= recall - 1e-12) return t;
  return ps[ps.length - 1] ?? recipe.detect.threshold;
}

export interface RecipeFitReport {
  fitVersion: string;
  recipeId: string;
  recipeVersion: number;
  lambda: number;
  detectLambda: number;
  minPositives: number;
  samples: number;
  targets: number;
  detect: HeadFit & { threshold: { hand: number; fitted: number } };
  /** [shape-tags] The table-ness head, when the recipe has one and the samples carry `isTable`. */
  table?: HeadFit;
  classes: HeadFit[];
  nameThreshold: { hand: number; fitted: number };
  naming: HeadStatus;
  /** On the training samples (optimistic for the fitted side). */
  inSample: { hand: EvalMetrics; fitted: EvalMetrics };
  notes: string[];
}
export interface RecipeFit { report: RecipeFitReport; patch: RecipePatch | null; fitted: ClassifierRecipe }

const NAME_THRESHOLDS = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8];

/** Fit one recipe's heads on labelled samples; returns the proposed patch (null when nothing improved) and the report. */
export function fitRecipe(source: ClassifierRecipe, samples: readonly FitSample[], opts: FitOptions = {}): RecipeFit {
  const lambda = opts.lambda ?? DEFAULT_LAMBDA;
  const detectLambda = opts.detectLambda ?? lambda;
  const minPositives = opts.minPositives ?? MIN_POSITIVES;
  const notes: string[] = [];
  const recipe = slimRecipe(source);
  const handEval = evaluateRecipe(recipe, samples);
  const patch: RecipePatch = { version: recipe.version + 1 };

  // detect
  const det = fitHead("detect", recipe.detect.bias, recipe.detect.signals, samples, (s) => s.isTarget, detectLambda, minPositives);
  let detectThreshold = recipe.detect.threshold;
  if (det.fitted) {
    const trial: RecipePatch = { version: patch.version };
    putHead(trial, det);
    const candidate = withPatch(recipe, trial);
    const t = thresholdForRecall(candidate, samples, handEval.detect.recall ?? 1);
    const fittedEval = evaluateRecipe(withPatch(recipe, { ...trial, detectThreshold: t }), samples);
    if ((fittedEval.detect.precision ?? 0) + 1e-12 >= (handEval.detect.precision ?? 0)) {
      putHead(patch, det);
      patch.detectThreshold = detectThreshold = t;
    } else {
      det.status = "no-gain";
      notes.push(`detect: fitted precision ${fittedEval.detect.precision?.toFixed(3)} < hand ${handEval.detect.precision?.toFixed(3)} at hand recall; hand weights kept`);
    }
  }

  // [shape-tags] table-ness head: fitted on the samples that carry a table label, kept when it is a proper fit (no threshold here).
  let table: HeadFit | undefined;
  if (recipe.tableHead) {
    const labelled = samples.filter((s) => typeof s.isTable === "boolean");
    table = fitHead("table", recipe.tableHead.bias, recipe.tableHead.signals, labelled, (s) => s.isTable === true, detectLambda, minPositives);
    if (table.fitted) putHead(patch, table);
  }

  // naming (one-vs-rest over the target samples)
  const targets = samples.filter((s) => s.isTarget);
  const classes = recipe.classes.map((c) => fitHead(c.id, c.bias, c.signals, targets, (s) => s.classId === c.id, lambda, minPositives));
  let nameThreshold = recipe.nameThreshold;
  let naming: HeadStatus = classes.some((c) => c.fitted) ? "fitted" : "small-n";
  if (naming === "fitted") {
    const trial: RecipePatch = { ...patch, signals: { ...patch.signals } };
    for (const c of classes) putHead(trial, c);
    const handNamed = handEval.naming.named;
    const minPrecision = handNamed.n ? handNamed.ok / handNamed.n : 0;
    let best: { t: number; ok: number } | null = null;
    for (const t of [...new Set([recipe.nameThreshold, ...NAME_THRESHOLDS])]) {
      const ev = evaluateRecipe(withPatch(recipe, { ...trial, nameThreshold: t }), targets).naming;
      if (ev.named.n && ev.named.ok / ev.named.n + 1e-12 < minPrecision) continue;
      const better = !best || ev.top1.ok > best.ok || (ev.top1.ok === best.ok && Math.abs(t - recipe.nameThreshold) < Math.abs(best.t - recipe.nameThreshold));
      if (better) best = { t, ok: ev.top1.ok };
    }
    if (best && best.ok >= handEval.naming.top1.ok) {
      Object.assign(patch, trial);
      if (best.t !== recipe.nameThreshold) patch.nameThreshold = nameThreshold = best.t;
    } else {
      naming = "no-gain";
      for (const c of classes) if (c.status === "fitted") c.status = "no-gain";
      notes.push("naming: no threshold kept named-precision ≥ hand without losing top-1; hand weights kept");
    }
  }
  const small = classes.filter((c) => c.status === "small-n").length;
  if (small) notes.push(`${small} of ${classes.length} classes have < ${minPositives} positives (or negatives) and keep hand weights`);

  const changed = det.status === "fitted" || naming === "fitted" || table?.status === "fitted";
  const fitted = changed ? withPatch(source, patch) : source;
  return {
    patch: changed ? patch : null,
    fitted,
    report: {
      fitVersion: FIT_VERSION, recipeId: recipe.id, recipeVersion: recipe.version, lambda, detectLambda, minPositives,
      samples: samples.length, targets: targets.length,
      detect: { ...det, threshold: { hand: recipe.detect.threshold, fitted: detectThreshold } },
      ...(table ? { table } : {}),
      classes, nameThreshold: { hand: recipe.nameThreshold, fitted: nameThreshold }, naming,
      inSample: { hand: handEval, fitted: changed ? evaluateRecipe(fitted, samples) : handEval }, notes,
    },
  };
}

/** The proposed overlay: one patch per recipe that improved. Never applied here. */
export function overlayFromFits(fits: readonly RecipeFit[], at: string): ClassifierOverlay {
  const patches: ClassifierOverlay["patches"] = {};
  for (const f of fits) if (f.patch) patches[f.report.recipeId] = f.patch;
  return { custom: [], patches, updatedAt: at };
}

/** Stored verdicts of one recipe → samples. accept → the proposed class (or the accept's own classId); rename → its classId.
 *  A `via:"parse"` accept is down-weighted to `PARSE_ACCEPT_WEIGHT` (K58; TP-3 WP-3.Q). */
export function samplesFromVerdicts(verdicts: Iterable<ProposalVerdict>, recipe: ClassifierRecipe): FitSample[] {
  const classIds = new Set(recipe.classes.map((c) => c.id));
  const out: FitSample[] = [];
  for (const v of verdicts) {
    if (!v || v.recipeId !== recipe.id || !v.features || typeof v.features !== "object") continue;
    const isTarget = v.verdict !== "reject";
    const raw = v.verdict === "rename" ? v.classId : (v.classId ?? v.proposedClassId);
    const classId = isTarget && raw && raw !== OTHER_SCHEDULE && classIds.has(raw) ? raw : null;
    out.push({ features: v.features, isTarget, classId, ...(v.via === "parse" && v.verdict === "accept" ? { weight: PARSE_ACCEPT_WEIGHT } : {}) });
  }
  return out;
}
