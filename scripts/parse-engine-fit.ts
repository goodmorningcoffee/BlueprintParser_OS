#!/usr/bin/env -S npx tsx
/**
 * parse-engine-fit.ts — refit the R8 fusion weights on the ODD gold sets, score the refit on the EVEN sets
 * (table-pipeline WP-3.Q; PLAN §1.4 R8, §5 WP-3.Q, §6.4). Runs once per release.
 *
 *   NODE_OPTIONS=--max-old-space-size=3584 npx tsx scripts/parse-engine-fit.ts [--private-dir <dir>]
 *       [--json <out.json>] [--write] [--passes 2] [--seed 20261027] [--resamples 2000]
 *     --private-dir the private gold root (else $BP_PRIVATE_GOLD_DIR): gold/G-TAB.v1.jsonl + slices/
 *     --json       the fit report (numbers, method ids and opaque gold ids only) + a markdown table beside it;
 *                  refused inside a BP2 checkout
 *     --write      when the decision is `adopt`, write the refit to src/data/parse-engine/profile.json (PROFILE_PATH, a
 *                  ledger of numbers only, statically imported by the server). Never written on `keep-default`.
 *
 * 1. FIT (odd sets only): coordinate search over the weights the `instant` budget can exercise offline
 *    (`FIT_DIMS`), one weight at a time over `FIT_GRID`, `passes` sweeps in a fixed order. A move is kept only when it
 *    raises the objective by more than `MIN_GAIN`; ties keep the current weight, so a weight no odd unit exercises
 *    stays at its R8 value. The objective is the mean over the G-TAB headline metrics (TAB_METRICS) of the engine
 *    leg's per-metric mean (NaN units skipped). Paid / Python methods (rulings, img2table, tatr) never run offline and
 *    keep R8. Paragraph docs do not read the R8 weights, so G-PARA is not part of the fit.
 * 2. HOLD-OUT (even sets only): `engine:fitted` vs `engine:default` paired bootstrap per headline (§6.2).
 *    Decision `adopt` when the odd objective gained AND every even headline's lower bound is ≥ −0.01 (the §6.4
 *    non-regression bar); otherwise `keep-default` (the shipped profile stays `{v:1,id:"default"}` = R8).
 * Deterministic: no clock, seeded bootstrap; the same gold and seed give a byte-equal report.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_PROFILE, PROFILE_PATH, parseProfile, type MethodWeights, type ParseEngineProfile } from "@/lib/parse-engine/profile";
import type { MethodId } from "@/lib/parse-engine/types";
import { argOf, inSplit, privateDirOf, refuseWrite, writePrivate } from "./gold/gold-lib";
import { privateUnits } from "./parse-engine-measure";
import { engineLeg } from "./lib/parse-engine-leg";
import { measure, scoreUnit, TAB_METRICS, type Leg, type PairedCI, type Unit } from "./lib/parse-measure";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The weights an offline `instant` run can exercise (stored Textract, visual lines, hanging indent, primitives, LAYOUT). */
export const FIT_DIMS: { rows: readonly MethodId[]; cols: readonly MethodId[] } = {
  rows: ["textract-cells", "ocr-lines", "hanging-indent", "primitive-grid", "layout"],
  cols: ["textract-cells", "x-starts", "primitive-grid"],
};
export const FIT_GRID: readonly number[] = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
/** A move must raise the objective by more than this (a one-unit flip on 40 units is ≈ .004). */
export const MIN_GAIN = 1e-3;

/** Scores a profile on units (higher is better). The default runs the engine leg. */
export type Scorer = (units: readonly Unit[], profile: ParseEngineProfile) => Promise<number>;
/** Builds the engine leg for a profile (test seam). */
export type LegFactory = (units: readonly Unit[], profile: ParseEngineProfile, id: string) => Promise<Leg>;

const mean = (xs: readonly number[]): number => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;

export const defaultLegFactory: LegFactory = (units, profile, id) => engineLeg(units, { profile, id });

/** The objective of one leg on G-TAB units: mean over TAB_METRICS of the per-metric unit mean. */
export function objectiveOf(units: readonly Unit[], leg: Leg): number {
  const tab = units.filter((u) => u.gold === "G-TAB");
  const rows = tab.map((u) => scoreUnit(u, leg.run(u)));
  const perMetric = TAB_METRICS.map((m) => mean(rows.map((r) => r[m]).filter(Number.isFinite))).filter(Number.isFinite);
  return mean(perMetric);
}

export const engineScorer = (factory: LegFactory = defaultLegFactory): Scorer => async (units, profile) => objectiveOf(units, await factory(units, profile, "engine:trial"));

/** Throws unless every unit is from an odd (fit) set: the fit must never read the held-out half. */
export function assertFitUnits(units: readonly Unit[]): void {
  const even = units.filter((u) => !inSplit(u.setId, "odd"));
  if (even.length) throw new Error(`the fit read ${even.length} unit(s) from even (held-out) sets — refused (PLAN §6.1 split)`);
}

const withWeight = (p: ParseEngineProfile, axis: "rows" | "cols", m: MethodId, w: number): ParseEngineProfile => ({ ...p, [axis]: { ...p[axis], [m]: w } });

export interface FitStep { axis: "rows" | "cols"; method: MethodId; from: number; to: number; objective: number }
export interface FitResult { profile: ParseEngineProfile; objective: { default: number; fitted: number }; steps: FitStep[]; evaluations: number }

/** Coordinate search on ODD units only. Deterministic (fixed dimension and grid order, ties keep the current weight). */
export async function fitWeights(units: readonly Unit[], score: Scorer, o: { passes?: number; grid?: readonly number[]; dims?: typeof FIT_DIMS; start?: ParseEngineProfile } = {}): Promise<FitResult> {
  assertFitUnits(units);
  const grid = o.grid ?? FIT_GRID, dims = o.dims ?? FIT_DIMS, passes = o.passes ?? 2;
  let current = o.start ?? DEFAULT_PROFILE;
  let evaluations = 1;
  const base = await score(units, current);
  let best = base;
  const steps: FitStep[] = [];
  for (let pass = 0; pass < passes; pass++) {
    let moved = false;
    for (const axis of ["rows", "cols"] as const) {
      for (const m of dims[axis]) {
        const from = current[axis][m] ?? 0;
        let bestW = from, bestV = best;
        for (const w of grid) {
          if (w === from) continue;
          const v = await score(units, withWeight(current, axis, m, w));
          evaluations++;
          if (v > bestV + MIN_GAIN) { bestV = v; bestW = w; }
        }
        if (bestW !== from) {
          current = withWeight(current, axis, m, bestW);
          best = bestV;
          steps.push({ axis, method: m, from, to: bestW, objective: r4(bestV) });
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  const changed = steps.length > 0;
  return { profile: changed ? { ...current, id: profileId(current) } : DEFAULT_PROFILE, objective: { default: r4(base), fitted: r4(best) }, steps, evaluations };
}

const sortedWeights = (w: MethodWeights): Record<string, number> => Object.fromEntries(Object.entries(w).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** A content id for a refit (so two different refits never share an id inside the engine's paramsHash). */
export function profileId(p: Pick<ParseEngineProfile, "rows" | "cols">): string {
  const h = createHash("sha1").update(JSON.stringify({ rows: sortedWeights(p.rows), cols: sortedWeights(p.cols) })).digest("hex").slice(0, 10);
  return `fit-${h}`;
}

/** The profile file text (`{v:1,id,rows,cols}`, keys sorted, 2-space JSON + newline). The default is `{v:1,id:"default"}`. */
export function serializeProfile(p: ParseEngineProfile): string {
  if (p.id === "default") return JSON.stringify({ v: 1, id: "default" }, null, 2) + "\n";
  return JSON.stringify({ v: 1, id: p.id, rows: sortedWeights(p.rows), cols: sortedWeights(p.cols) }, null, 2) + "\n";
}

/** Parse a profile file's text back (throws on an invalid file: the fit never writes one). */
export function parseProfileText(text: string): ParseEngineProfile {
  const r = parseProfile(JSON.parse(text));
  if ("error" in r) throw new Error(`invalid profile: ${r.error}`);
  return r.profile;
}

export interface HoldOut { units: number; metrics: Record<string, PairedCI>; objective: { default: number; fitted: number } }
export interface FitReport {
  schema: "bp-parse-engine-fit/1";
  seed: number; resamples: number;
  fit: { units: number; byStratum: Record<string, number>; evaluations: number; steps: FitStep[]; objective: { default: number; fitted: number } };
  holdOut: HoldOut | null;
  /** The refit weights (adopted only when `decision` is `adopt`; otherwise the shipped profile stays R8). */
  candidate: { id: string; rows: Record<string, number>; cols: Record<string, number> };
  decision: "adopt" | "keep-default";
  reason: string;
}

/** Fit on `oddUnits`, score on `evenUnits`, decide. The two lists are checked: odd ones only odd sets, even ones only even. */
export async function runFit(oddUnits: readonly Unit[], evenUnits: readonly Unit[], o: { seed?: number; resamples?: number; passes?: number; factory?: LegFactory } = {}): Promise<FitReport> {
  const seed = o.seed ?? 20261027, resamples = o.resamples ?? 2000, factory = o.factory ?? defaultLegFactory;
  const odd = oddUnits.filter((u) => u.gold === "G-TAB");
  const even = evenUnits.filter((u) => u.gold === "G-TAB");
  if (even.some((u) => !inSplit(u.setId, "even"))) throw new Error("the hold-out list holds odd-set units");
  const byStratum: Record<string, number> = {};
  for (const u of odd) byStratum[u.stratum] = (byStratum[u.stratum] ?? 0) + 1;
  const fit = await fitWeights(odd, engineScorer(factory), { passes: o.passes });
  const report: FitReport = {
    schema: "bp-parse-engine-fit/1", seed, resamples,
    fit: { units: odd.length, byStratum, evaluations: fit.evaluations, steps: fit.steps, objective: fit.objective },
    holdOut: null,
    candidate: { id: fit.profile.id, rows: sortedWeights(fit.profile.rows), cols: sortedWeights(fit.profile.cols) },
    decision: "keep-default", reason: "",
  };
  if (!fit.steps.length) { report.reason = "no weight move raised the odd-set objective by more than MIN_GAIN"; return report; }
  if (!even.length) { report.reason = "no held-out (even) G-TAB units to score the refit on"; return report; }
  const legs = [await factory(even, DEFAULT_PROFILE, "engine:default"), await factory(even, fit.profile, "engine:fitted")];
  const m = measure(even, legs, { sets: "even", seed, resamples, baseline: { "G-TAB": "engine:default" } });
  const metrics = m.paired["G-TAB"].legs["engine:fitted"].metrics;
  report.holdOut = { units: even.length, metrics, objective: { default: r4(objectiveOf(even, legs[0])), fitted: r4(objectiveOf(even, legs[1])) } };
  const blocking = Object.entries(metrics).filter(([, c]) => c.n > 0 && c.lo < -0.01).map(([k]) => k);
  if (blocking.length) report.reason = `held-out lower bound < −0.01 on ${blocking.join(", ")}`;
  else { report.decision = "adopt"; report.reason = "odd objective gained and every held-out headline's lower bound ≥ −0.01"; }
  return report;
}

const f3 = (v: number): string => (Number.isFinite(v) ? v.toFixed(3) : "n/a");

export function fitMarkdown(r: FitReport): string {
  const out = [`# parse-engine-fit — seed ${r.seed}, ${r.resamples} resamples`, "",
    `Fit (odd sets): ${r.fit.units} G-TAB units (${Object.entries(r.fit.byStratum).map(([s, n]) => `${s} ${n}`).join(", ")}), ${r.fit.evaluations} evaluations; objective ${f3(r.fit.objective.default)} → ${f3(r.fit.objective.fitted)}.`, ""];
  if (r.fit.steps.length) {
    out.push("| axis | method | R8 / previous | refit | objective |", "|---|---|---|---|---|");
    for (const s of r.fit.steps) out.push(`| ${s.axis} | ${s.method} | ${s.from} | ${s.to} | ${f3(s.objective)} |`);
    out.push("");
  }
  if (r.holdOut) {
    out.push(`Hold-out (even sets): ${r.holdOut.units} units; objective default ${f3(r.holdOut.objective.default)}, refit ${f3(r.holdOut.objective.fitted)}.`, "",
      "| metric | n | default | refit | diff [95 % CI] |", "|---|---|---|---|---|");
    for (const [k, c] of Object.entries(r.holdOut.metrics)) out.push(`| ${k} | ${c.n} | ${f3(c.meanBase)} | ${f3(c.meanLeg)} | ${f3(c.diff)} [${f3(c.lo)}, ${f3(c.hi)}] |`);
    out.push("");
  }
  out.push(`**Decision: ${r.decision}** — ${r.reason}. Candidate profile id \`${r.candidate.id}\`.`, "");
  return out.join("\n");
}

export async function main(argv: readonly string[]): Promise<{ report: FitReport; markdown: string; written: string[] }> {
  const dir = privateDirOf(argOf(argv, "private-dir"));
  const odd = privateUnits(dir, "odd", ["G-TAB"]).units;
  const even = privateUnits(dir, "even", ["G-TAB"]).units;
  const report = await runFit(odd, even, {
    seed: Number(argOf(argv, "seed") ?? 20261027), resamples: Number(argOf(argv, "resamples") ?? 2000), passes: Number(argOf(argv, "passes") ?? 2),
  });
  const markdown = fitMarkdown(report);
  const written: string[] = [];
  const json = argOf(argv, "json");
  if (json) {
    const root = dirname(resolve(json));
    const refused = refuseWrite(json, root, false);
    if (refused) throw new Error(`refused --json: ${refused}`);
    writePrivate(json, JSON.stringify(report, null, 1) + "\n", root, false);
    writePrivate(json.replace(/\.json$/, "") + ".md", markdown, root, false);
    written.push(json, json.replace(/\.json$/, "") + ".md");
  }
  if (argv.includes("--write") && report.decision === "adopt") {
    // numbers only (method ids and weights); this is the one BP2 file the fit writes
    const target = join(REPO_ROOT, PROFILE_PATH);
    writeFileSync(target, serializeProfile(parseProfileText(serializeProfile({ id: report.candidate.id, rows: report.candidate.rows as MethodWeights, cols: report.candidate.cols as MethodWeights }))));
    written.push(target);
  }
  return { report, markdown, written };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(({ markdown, written }) => {
    process.stdout.write(markdown);
    for (const w of written) console.error(`parse-engine-fit: wrote ${w}`);
  }, (e: unknown) => {
    console.error(`parse-engine-fit: ${(e as Error).message}`);
    process.exitCode = 1;
  });
}
