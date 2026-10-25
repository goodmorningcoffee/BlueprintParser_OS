#!/usr/bin/env -S npx tsx
/**
 * classifier-fit-detect.ts — [shape-tags 2026-10-25] fit ONLY the schedules.v1 DETECT head and TABLE-NESS head on
 * the ODD label sets, as a plain L2 logistic over the stored feature values (prior 0, not the hand weights), with
 * λ chosen by leave-one-set-out AUC over the odd sets and the bias shifted so that p ≥ .5 keeps `--recall`
 * (default .9) of the odd schedules. The even sets are never read. Output: a weights JSON for
 * gitignore/projects/classifier_builder/shape_tags/tools/patch_recipes.py --weights, plus the odd-set numbers.
 *
 *   npx tsx scripts/classifier-fit-detect.ts [--out weights.json] [--recall 0.9] [--lambdas 0.03,0.1,0.3,1,3]
 *
 * Why beside classifier-fit.ts: that fitter pulls toward the hand weights and picks λ by threshold accuracy at the
 * hand recall, which is the right contract for a proposed overlay but a weak one for a ranking signal set. This one
 * answers "which weights rank best on unseen sets". Projects are "set N"; no OCR text is printed.
 */
import { writeFileSync } from "node:fs";
import { classifyRegionsV2 } from "@/lib/region-classifier-v2";
import { BUILT_IN_RECIPES, NOT_A_SCHEDULE, runClassifierEngine, type ClassifierRecipe, type WeightedSignal } from "@/lib/classifier-engine";
import { createCsiBoxTagger } from "@/lib/classifier-engine/csi-box-tagger";
import { fitLogistic } from "@/lib/classifier-engine/fit";
import { DEFAULT_CORPUS, DEFAULT_RESEARCH, loadPage, textractTablesOf } from "./lib/corpus-v2-marks";
import { DEFAULT_LABELS, isTableLabel, labelledSamplePages, labelsByPage, matchLabel, readKindLabels } from "./lib/classifier-labels";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const OUT = opt("out") ?? "/workspaces/projects/gitignore/projects/classifier_builder/shape_tags/logs/fit-detect-weights.json";
const RECALL = Number(opt("recall") ?? 0.9);
const LAMBDAS = (opt("lambdas") ?? "0.03,0.1,0.3,1,3").split(",").map(Number).filter((x) => x > 0);

const hand = BUILT_IN_RECIPES.find((r) => r.id === "schedules.v1")!;
const openDetect: ClassifierRecipe = { ...hand, detect: { ...hand.detect, threshold: 0 } };
const labels = readKindLabels(DEFAULT_LABELS);
if (!labels) throw new Error("no labels");
const byPage = labelsByPage(labels.items);
const tagger = createCsiBoxTagger();

interface S { features: Record<string, number>; isSchedule: boolean; isTable: boolean; set: number }
const samples: S[] = [];
for (const s of labelledSamplePages(DEFAULT_RESEARCH, DEFAULT_LABELS)) {
  if (s.set % 2 !== 1) continue; // ODD sets only — even is held out, never loaded here
  const pageLabels = byPage.get(`${s.set}:${s.page}`);
  if (!pageLabels?.length) continue;
  const loaded = loadPage(s, DEFAULT_CORPUS);
  if (!loaded) continue;
  const { detections, words, csiCodes, drawingNumber } = loaded;
  const tables = textractTablesOf(s.pid, s.page, DEFAULT_CORPUS);
  const regionsV2 = classifyRegionsV2({ pageNumber: s.page, detections, textractData: { words, tables }, csiCodes });
  const run = runClassifierEngine({ pageNumber: s.page, detections, textractData: { words, tables }, csiCodes, regionsV2, drawingNumber, tagger, keynotes: loaded.keynotes }, [openDetect]);
  for (const l of pageLabels) {
    const p = matchLabel(run.result.proposals, l);
    if (!p) continue;
    samples.push({ features: p.features, isSchedule: l.kind !== NOT_A_SCHEDULE, isTable: isTableLabel(l), set: s.set });
  }
}
const sets = [...new Set(samples.map((s) => s.set))].sort((a, b) => a - b);
const L: string[] = [`classifier-fit-detect — ${samples.length} odd-set samples from ${sets.length} sets (${samples.filter((s) => s.isSchedule).length} schedules, ${samples.filter((s) => s.isTable).length} tables)`];

const auc = (xs: Array<{ s: number; y: boolean }>): number => {
  const pos = xs.filter((x) => x.y).map((x) => x.s), neg = xs.filter((x) => !x.y).map((x) => x.s);
  if (!pos.length || !neg.length) return 0.5;
  let w = 0;
  for (const a of pos) for (const b of neg) w += a > b ? 1 : a === b ? 0.5 : 0;
  return w / (pos.length * neg.length);
};
const sig = (z: number) => 1 / (1 + Math.exp(-z));
const logit = (p: number) => Math.log(p / (1 - p));

function fitHead(prefix: string, signals: readonly WeightedSignal[], label: (s: S) => boolean): Record<string, number> {
  const sigs = signals.filter((s) => s.enabled && s.role === "score");
  const keys = sigs.map((s) => `${prefix}.${s.id}`);
  const X = (xs: S[]) => xs.map((s) => keys.map((k) => s.features[k] ?? 0));
  const y = (xs: S[]) => xs.map((s) => (label(s) ? 1 : 0));
  const score = (b: number, w: number[], s: S) => sig(b + keys.reduce((a, k, i) => a + w[i] * (s.features[k] ?? 0), 0));
  const zero = { bias: 0, weights: keys.map(() => 0) };
  // λ by leave-one-set-out AUC over the odd sets (pooled scores)
  let best = { lambda: LAMBDAS[0], auc: -1 };
  for (const lambda of LAMBDAS) {
    const pooled: Array<{ s: number; y: boolean }> = [];
    for (const set of sets) {
      const train = samples.filter((s) => s.set !== set), test = samples.filter((s) => s.set === set);
      const f = fitLogistic(X(train), y(train), { lambda, prior: zero });
      for (const s of test) pooled.push({ s: score(f.bias, f.weights, s), y: label(s) });
    }
    const a = auc(pooled);
    L.push(`  ${prefix}: λ ${lambda} LOSO-odd AUC ${a.toFixed(3)}`);
    if (a > best.auc) best = { lambda, auc: a };
  }
  const f = fitLogistic(X(samples), y(samples), { lambda: best.lambda, prior: zero });
  // bias shift: p ≥ .5 ⇔ old p ≥ t where t keeps RECALL of the positives on odd
  const ps = samples.filter(label).map((s) => score(f.bias, f.weights, s)).sort((a, b) => b - a);
  const t = ps[Math.max(0, Math.ceil(RECALL * ps.length) - 1)];
  const bias = f.bias - logit(t);
  const pooledIn = samples.map((s) => ({ s: score(bias, f.weights, s), y: label(s) }));
  const tp = pooledIn.filter((x) => x.y && x.s >= 0.5).length, fp = pooledIn.filter((x) => !x.y && x.s >= 0.5).length, fn = pooledIn.filter((x) => x.y && x.s < 0.5).length;
  L.push(`  ${prefix}: chosen λ ${best.lambda} (LOSO AUC ${best.auc.toFixed(3)}); in-sample odd AUC ${auc(pooledIn).toFixed(3)}; at p ≥ .5 (bias shifted for recall ${RECALL}): precision ${(tp / (tp + fp)).toFixed(3)} recall ${(tp / (tp + fn)).toFixed(3)} fp ${fp}`);
  const out: Record<string, number> = { [`${prefix}.bias`]: Math.round(bias * 1000) / 1000 };
  keys.forEach((k, i) => { out[k] = Math.round(f.weights[i] * 1000) / 1000; });
  L.push(`  ${prefix}: ${Object.entries(out).map(([k, v]) => `${k.slice(prefix.length + 1)} ${v}`).join(", ")}`);
  return out;
}

const detect = fitHead("detect", hand.detect.signals, (s) => s.isSchedule);
const table = hand.tableHead ? fitHead("table", hand.tableHead.signals, (s) => s.isTable) : {};
const weights = { "schedules.v1": { ...detect, ...table }, "regions.v1": { ...table } };
writeFileSync(OUT, JSON.stringify(weights, null, 1) + "\n");
L.push(`wrote ${OUT}`);
console.log(L.join("\n"));
