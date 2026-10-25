#!/usr/bin/env -S npx tsx
/**
 * classifier-fit.ts — plan step 4: fit the schedules.v1 weights (src/lib/classifier-engine/fit.ts) on the
 * corpus kind labels and compare them with the hand weights, honestly.
 *
 *   npx tsx scripts/classifier-fit.ts [--labels <kinds.v1.json>] [--corpus <dir>] [--research <dir>]
 *                                     [--out-dir <dir>] [--lambdas 0.1,0.3,1,3,10,30]
 *
 * 1. Every region-v2 table candidate on the labelled pages is run through the engine with the detect
 *    threshold at 0 (so non-schedules the hand head drops still carry features), joined to its label
 *    (scripts/lib/classifier-labels.ts, the classifier-measure.ts join). Label: not-a-schedule → not the
 *    target; any other kind → target, class = the kind (other-schedule → fallback).
 * 2. λ (naming and detect separately) by leave-one-set-out CV over the ODD sets only.
 * 3. Fit on odd sets, score ONCE on the even sets (held out), hand vs fitted.
 * 4. Leave-one-set-out over all sets with those λ (hand weights were tuned on the odd sets, so the hand
 *    side is optimistic there).
 * 5. The proposed overlay is fitted on ALL labelled sets and written to <out-dir>/4-fitted-overlay.json
 *    (a ClassifierOverlay; never applied here); the report to <out-dir>/4-fit-report.txt.
 * Naming accuracy is the naming head alone over every labelled schedule candidate (detect not applied),
 * so n can exceed classifier-measure's, which only counts proposals that passed detect. No OCR text and
 * no project names are printed; projects are "set N".
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyRegionsV2 } from "@/lib/region-classifier-v2";
import { BUILT_IN_RECIPES, NOT_A_SCHEDULE, runClassifierEngine, type ClassifierRecipe } from "@/lib/classifier-engine";
import { createCsiBoxTagger } from "@/lib/classifier-engine/csi-box-tagger";
import { fitRecipe, overlayFromFits, MIN_POSITIVES, type FitOptions } from "@/lib/classifier-engine/fit";
import { evaluateRecipe, scoreFeatures, type Acc, type EvalMetrics, type FitSample } from "@/lib/classifier-engine/fit-score";
import { DEFAULT_CORPUS, DEFAULT_RESEARCH, loadPage, textractTablesOf } from "./lib/corpus-v2-marks";
import { DEFAULT_LABELS, isTableLabel, labelledSamplePages, labelsByPage, matchLabel, readKindLabels } from "./lib/classifier-labels";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const CORPUS = opt("corpus") ?? DEFAULT_CORPUS;
const RESEARCH = opt("research") ?? DEFAULT_RESEARCH;
const LABELS = opt("labels") ?? DEFAULT_LABELS;
const OUT_DIR = opt("out-dir") ?? "/workspaces/projects/gitignore/projects/classifier_builder/logs";
const LAMBDAS = (opt("lambdas") ?? "0.1,0.3,1,3,10,30").split(",").map(Number).filter((x) => x > 0);

const hand = BUILT_IN_RECIPES.find((r) => r.id === "schedules.v1");
if (!hand) throw new Error("schedules.v1 built-in missing");
const labels = readKindLabels(LABELS);
if (!labels) throw new Error(`no labels file at ${LABELS}`);
const classIds = new Set(hand.classes.map((c) => c.id));
const openDetect: ClassifierRecipe = { ...hand, detect: { ...hand.detect, threshold: 0 } };

// ── 1. samples ──
const t0 = Date.now();
const byPage = labelsByPage(labels.items);
const tagger = createCsiBoxTagger();
const samples: FitSample[] = [];
let pages = 0, candidates = 0, noCandidate = 0, fidelityP = 0, fidelityClass = 0;
for (const s of labelledSamplePages(RESEARCH, LABELS, opt("pages"))) {
  const pageLabels = byPage.get(`${s.set}:${s.page}`);
  if (!pageLabels?.length) continue;
  const loaded = loadPage(s, CORPUS);
  if (!loaded) { noCandidate += pageLabels.length; continue; }
  const { detections, words, csiCodes, drawingNumber } = loaded;
  // [shape-tags] bundle Textract tables + classical shapes, as production holds them (pages.textractData.tables / pages.keynotes).
  const tables = textractTablesOf(s.pid, s.page, CORPUS);
  const regionsV2 = classifyRegionsV2({ pageNumber: s.page, detections, textractData: { words, tables }, csiCodes });
  const run = runClassifierEngine({ pageNumber: s.page, detections, textractData: { words, tables }, csiCodes, regionsV2, drawingNumber, tagger, keynotes: loaded.keynotes }, [openDetect]);
  pages++;
  const proposals = run.result.proposals;
  candidates += proposals.length;
  for (const p of proposals) { // re-scoring from stored features must reproduce the engine (fit-score.ts)
    const sc = scoreFeatures(hand, p.features);
    if (sc.detectP !== p.p) fidelityP++;
    if (sc.classId !== p.classId) fidelityClass++;
  }
  for (const l of pageLabels) {
    const p = matchLabel(proposals, l);
    if (!p) { noCandidate++; continue; }
    const isTarget = l.kind !== NOT_A_SCHEDULE;
    samples.push({ features: p.features, isTarget, classId: isTarget && classIds.has(l.kind) ? l.kind : null, fold: s.set, isTable: isTableLabel(l) });
  }
}
const loadMs = Date.now() - t0;
const progress = (msg: string) => process.stderr.write(`[classifier-fit ${((Date.now() - t0) / 1000).toFixed(1)} s] ${msg}\n`);
progress(`${samples.length} samples from ${pages} pages`);

// ── helpers ──
const odd = samples.filter((s) => s.fold! % 2 === 1);
const even = samples.filter((s) => s.fold! % 2 === 0);
const setsOf = (xs: readonly FitSample[]) => [...new Set(xs.map((s) => s.fold!))].sort((a, b) => a - b);

function mergeAcc(a: Record<string, Acc>, b: Record<string, Acc>): Record<string, Acc> {
  const out: Record<string, Acc> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = { n: (out[k]?.n ?? 0) + v.n, ok: (out[k]?.ok ?? 0) + v.ok };
  return out;
}
function merge(a: EvalMetrics | null, b: EvalMetrics): EvalMetrics {
  if (!a) return b;
  const d = { tp: a.detect.tp + b.detect.tp, fp: a.detect.fp + b.detect.fp, fn: a.detect.fn + b.detect.fn, tn: a.detect.tn + b.detect.tn };
  const ratio = (x: number, y: number) => (y ? x / y : null);
  return {
    detect: { ...d, precision: ratio(d.tp, d.tp + d.fp), recall: ratio(d.tp, d.tp + d.fn), nonTargetFiltered: ratio(d.tn, d.tn + d.fp) },
    naming: {
      top1: { n: a.naming.top1.n + b.naming.top1.n, ok: a.naming.top1.ok + b.naming.top1.ok },
      named: { n: a.naming.named.n + b.naming.named.n, ok: a.naming.named.ok + b.naming.named.ok },
      byGroup: mergeAcc(a.naming.byGroup, b.naming.byGroup), byKind: mergeAcc(a.naming.byKind, b.naming.byKind),
    },
  };
}

/** Leave-one-set-out over `xs`: each set scored by a fit on the others. */
function loso(xs: readonly FitSample[], opts: FitOptions): { hand: EvalMetrics; fitted: EvalMetrics; fittedFolds: number } {
  let h: EvalMetrics | null = null, f: EvalMetrics | null = null, fittedFolds = 0;
  for (const set of setsOf(xs)) {
    const test = xs.filter((s) => s.fold === set);
    const fit = fitRecipe(hand!, xs.filter((s) => s.fold !== set), opts);
    if (fit.patch) fittedFolds++;
    h = merge(h, evaluateRecipe(hand!, test));
    f = merge(f, evaluateRecipe(fit.fitted, test));
  }
  return { hand: h!, fitted: f!, fittedFolds };
}

/** Threshold-free detect ranking quality: P(a random schedule scores above a random non-schedule), ties count ½. */
function detectAuc(recipe: ClassifierRecipe, xs: readonly FitSample[]): number | null {
  const pos = xs.filter((s) => s.isTarget).map((s) => scoreFeatures(recipe, s.features).detectP);
  const neg = xs.filter((s) => !s.isTarget).map((s) => scoreFeatures(recipe, s.features).detectP);
  if (!pos.length || !neg.length) return null;
  let wins = 0;
  for (const a of pos) for (const b of neg) wins += a > b ? 1 : a === b ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}
/** Share of non-schedules a threshold set ON `xs` itself would filter while keeping `recall` of the schedules (descriptive, not held out). */
function filteredAtRecall(recipe: ClassifierRecipe, xs: readonly FitSample[], recall: number): number | null {
  const pos = xs.filter((s) => s.isTarget).map((s) => scoreFeatures(recipe, s.features).detectP).sort((a, b) => b - a);
  const neg = xs.filter((s) => !s.isTarget).map((s) => scoreFeatures(recipe, s.features).detectP);
  if (!pos.length || !neg.length) return null;
  const t = pos[Math.max(0, Math.ceil(recall * pos.length) - 1)];
  return neg.filter((p) => p < t).length / neg.length;
}

const detectAcc = (m: EvalMetrics) => (m.detect.tp + m.detect.tn) / Math.max(1, m.detect.tp + m.detect.tn + m.detect.fp + m.detect.fn);

// ── 2. λ by LOSO on odd sets ──
const grid = LAMBDAS.map((lambda) => { const g = { lambda, ...loso(odd, { lambda, detectLambda: lambda }) }; progress(`λ ${lambda} done`); return g; });
const pick = (score: (g: (typeof grid)[number]) => number) => grid.reduce((best, g) => (score(g) > score(best) + 1e-12 || (Math.abs(score(g) - score(best)) <= 1e-12 && g.lambda > best.lambda) ? g : best));
const lambda = pick((g) => g.fitted.naming.top1.ok).lambda;
const detectLambda = pick((g) => detectAcc(g.fitted)).lambda;
const opts: FitOptions = { lambda, detectLambda };

// ── 3. odd → even held out ──
const oddFit = fitRecipe(hand, odd, opts);
const heldHand = evaluateRecipe(hand, even);
const heldFit = evaluateRecipe(oddFit.fitted, even);

// ── 4. LOSO over all sets ──
const all = loso(samples, opts);

// ── 5. final overlay on all sets ──
const finalFit = fitRecipe(hand, samples, opts);
const at = new Date().toISOString();
const overlay = overlayFromFits([finalFit], at);

// ── report ──
const pct = (a: Acc | undefined) => (a && a.n ? `${((100 * a.ok) / a.n).toFixed(1)} % (${a.ok}/${a.n})` : "n/a");
const num = (x: number | null) => (x === null ? "n/a" : `${(100 * x).toFixed(1)} %`);
const L: string[] = [];
const compare = (title: string, h: EvalMetrics, f: EvalMetrics) => {
  L.push(title);
  L.push(`  naming top-1 kind     hand ${pct(h.naming.top1).padEnd(20)} fitted ${pct(f.naming.top1)}`);
  L.push(`  named precision       hand ${pct(h.naming.named).padEnd(20)} fitted ${pct(f.naming.named)}`);
  for (const g of [...new Set([...Object.keys(h.naming.byGroup), ...Object.keys(f.naming.byGroup)])].sort()) {
    L.push(`    group ${g.padEnd(7)}       hand ${pct(h.naming.byGroup[g]).padEnd(20)} fitted ${pct(f.naming.byGroup[g])}`);
  }
  L.push(`  detect (schedule)     hand precision ${num(h.detect.precision)} recall ${num(h.detect.recall)} · fitted precision ${num(f.detect.precision)} recall ${num(f.detect.recall)}`);
  L.push(`  not-a-schedule        hand filters ${h.detect.tn}/${h.detect.tn + h.detect.fp} (${num(h.detect.nonTargetFiltered)}) · fitted filters ${f.detect.tn}/${f.detect.tn + f.detect.fp} (${num(f.detect.nonTargetFiltered)})`);
};
const verdict = (h: EvalMetrics, f: EvalMetrics): string => {
  const dn = f.naming.top1.ok - h.naming.top1.ok;
  const dd = f.detect.tn - h.detect.tn;
  const dr = f.detect.tp - h.detect.tp;
  return `naming ${dn > 0 ? `+${dn} correct (fitted better)` : dn < 0 ? `${dn} correct (fitted WORSE)` : "no change"}; detect: ${dd >= 0 ? "+" : ""}${dd} non-schedules filtered, ${dr >= 0 ? "+" : ""}${dr} schedules kept`;
};

L.push(`classifier-fit (step 4) — ${at}`);
L.push(`labels: ${labels.items.length} (labeller: ${labels.labeller}); ${pages} labelled pages, ${candidates} candidates, ${samples.length} labels joined (${samples.filter((s) => s.isTarget).length} schedules, ${samples.filter((s) => !s.isTarget).length} not-a-schedule), ${noCandidate} labels without a candidate (excluded); ${(loadMs / 1000).toFixed(1)} s`);
L.push(`sets: ${setsOf(samples).length} (odd ${setsOf(odd).length} · ${odd.length} samples, even ${setsOf(even).length} · ${even.length} samples)`);
L.push(`re-score fidelity (stored features vs engine, ${candidates} candidates): detect p mismatches ${fidelityP}, class mismatches ${fidelityClass}`);
L.push(`fit: L2 logistic toward the hand weights, damped Newton; classes need ≥ ${MIN_POSITIVES} positives (else hand weights). Hand weights were tuned on the ODD sets (wave 1).`);
L.push("");
L.push("λ GRID — leave-one-set-out over the odd sets (fitted side; hand: naming " + pct(grid[0].hand.naming.top1) + `, detect accuracy ${(100 * detectAcc(grid[0].hand)).toFixed(1)} %)`);
for (const g of grid) L.push(`  λ ${String(g.lambda).padEnd(5)} naming ${pct(g.fitted.naming.top1).padEnd(20)} detect accuracy ${(100 * detectAcc(g.fitted)).toFixed(1)} %  (folds with a patch ${g.fittedFolds}/${setsOf(odd).length})`);
L.push(`  chosen: naming λ ${lambda}, detect λ ${detectLambda}`);
L.push("");
const fitSummary = (title: string, f: ReturnType<typeof fitRecipe>) => {
  const r = f.report;
  L.push(`${title}: detect ${r.detect.status}${r.detect.fitted ? ` (bias ${r.detect.hand.bias} → ${r.detect.fitted.bias}, threshold ${r.detect.threshold.hand} → ${r.detect.threshold.fitted})` : ""}; naming ${r.naming}; classes fitted ${r.classes.filter((c) => c.status === "fitted").map((c) => `${c.head}(${c.positives})`).join(" ") || "none"}; nameThreshold ${r.nameThreshold.hand} → ${r.nameThreshold.fitted}`);
  for (const n of r.notes) L.push(`  note: ${n}`);
  if (r.detect.fitted) L.push(`  detect weights ${Object.entries(r.detect.fitted.weights).map(([k, w]) => `${k.slice(7)} ${r.detect.hand.weights[k]}→${w}`).join(", ")}`);
  if (r.table) L.push(`  table head ${r.table.status} (n ${r.table.n}, positives ${r.table.positives})${r.table.fitted ? `: bias ${r.table.hand.bias} → ${r.table.fitted.bias}; weights ${Object.entries(r.table.fitted.weights).map(([k, w]) => `${k.slice(6)} ${r.table!.hand.weights[k]}→${w}`).join(", ")}` : ""}`);
};
fitSummary("FIT ON ODD", oddFit);
L.push("");
compare(`HELD OUT (even sets, scored once) — ${verdict(heldHand, heldFit)}`, heldHand, heldFit);
const auc = (r: ClassifierRecipe) => { const v = detectAuc(r, even); return v === null ? "n/a" : v.toFixed(3); };
const curve = (r: ClassifierRecipe) => [0.95, 0.9, 0.8].map((q) => `${Math.round(q * 100)} % recall → ${num(filteredAtRecall(r, even, q))}`).join(", ");
L.push(`  detect ranking on even: AUC hand ${auc(hand)} · fitted ${auc(oddFit.fitted)}`);
L.push(`  non-schedules filtered if the threshold were set on even itself (descriptive): hand ${curve(hand)}; fitted ${curve(oddFit.fitted)}`);
L.push("");
compare(`LEAVE-ONE-SET-OUT, all ${setsOf(samples).length} sets (hand side optimistic on odd sets) — ${verdict(all.hand, all.fitted)}`, all.hand, all.fitted);
L.push("");
fitSummary("FINAL FIT ON ALL SETS (the proposed overlay)", finalFit);
const inS = finalFit.report.inSample;
L.push(`  in-sample (optimistic): naming hand ${pct(inS.hand.naming.top1)} fitted ${pct(inS.fitted.naming.top1)}; not-a-schedule filtered hand ${num(inS.hand.detect.nonTargetFiltered)} fitted ${num(inS.fitted.detect.nonTargetFiltered)}`);
L.push("");
const heldGain = heldFit.naming.top1.ok - heldHand.naming.top1.ok;
const losoGain = all.fitted.naming.top1.ok - all.hand.naming.top1.ok;
L.push("VERDICT");
L.push(heldGain > 0 && losoGain > 0
  ? `  Fitting beats the hand weights on naming, held out (${heldGain > 0 ? "+" : ""}${heldGain}) and leave-one-set-out (${losoGain > 0 ? "+" : ""}${losoGain}). Proposed, not applied.`
  : `  Fitting does NOT reliably beat the hand weights on naming (held out ${heldGain >= 0 ? "+" : ""}${heldGain}, leave-one-set-out ${losoGain >= 0 ? "+" : ""}${losoGain}). Do not apply the naming part on this evidence.`);
const heldDet = heldFit.detect.tn - heldHand.detect.tn, heldLost = heldHand.detect.tp - heldFit.detect.tp;
L.push(`  Detect, held out: ${heldDet >= 0 ? "+" : ""}${heldDet} non-schedules filtered at a cost of ${heldLost} schedules lost (hand recall kept on the TRAINING sets, not guaranteed held out).`);
L.push(`  Thin data: most kinds have < ${MIN_POSITIVES} labelled positives and keep their hand weights; single labeller; n per group is small — no claim beyond these counts.`);

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "4-fitted-overlay.json"), JSON.stringify(overlay, null, 1) + "\n");
writeFileSync(join(OUT_DIR, "4-fit-report.txt"), L.join("\n") + "\n");
console.log(L.join("\n"));
console.log(`\nwrote ${join(OUT_DIR, "4-fitted-overlay.json")} and ${join(OUT_DIR, "4-fit-report.txt")}`);
