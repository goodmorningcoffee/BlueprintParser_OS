/**
 * sweep-tau.ts — CSI v2 S5 τ sweep (IMPLEMENTATION §II S5, PLAN §8).
 *
 * Input: ONE capture taken at τ=0 whose pages carry `codeDetails[].confidence`. For each τ the
 * emitted set is re-derived offline — confidence ≥ τ, sorted confidence desc then code asc, capped
 * at maxCodesPerPage — and scored with compare.ts's arithmetic on the distinct gold pages.
 *
 * VALIDITY: re-deriving equals re-running only if detectCsiV2's τ is a final confidence cut ahead
 * of the cap (§I V2Config). Filtering a capped τ=0 list is still exact (everything ≥ τ outranks
 * everything below it). `--check=<tau>=<capture-at-tau.json>` verifies the assumption against a
 * direct run and exits 2 on any page whose derived codes differ.
 *
 * Also reports the acceptance probe from PLAN v1 §8: the τ whose strict/section recall first
 * meets OLD's, and the precision there vs 2× OLD.
 *
 * Build + run (from the repo root):
 *   npx esbuild eval/csi/sweep-tau.ts --bundle --platform=node --target=node20 --alias:@=./src \
 *     --external:pg-native --outfile=build/csi-sweep-tau.js
 *   node build/csi-sweep-tau.js --gold=<gold.json> --frame=eval/csi/gold-frame.json \
 *     --corpus=<corpus.ndjson> --capture=<v2-engine.json> [--taus=0.5,0.55,…] [--cap=40] \
 *     [--old-recall=0.2054 --old-precision=0.0393] [--out=<numbers.json>] [--check=<tau>=<f>]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { exact, isCertifiedPage, type GoldPage } from "./score";
import {
  type Capture, type CapturePage, type Cell, type Variant,
  codesPerPage, dedupe, isScoredText, pageKey, readCorpus, scoreEngine, weightFn,
} from "./compare";

export const DEFAULT_TAUS = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95];

/** Emitted codes at τ from a τ=0 capture page (confidence ≥ τ, conf desc / code asc, cap). */
export function deriveAtTau(p: CapturePage, tau: number, cap: number): string[] {
  if (!p.codeDetails) throw new Error(`page ${pageKey(p.bundle, p.page)} has no codeDetails — sweep needs a τ=0 capture with confidences`);
  return p.codeDetails
    .filter(d => typeof d.confidence === "number" && d.confidence >= tau)
    .sort((a, b) => (b.confidence as number) - (a.confidence as number) || a.code.localeCompare(b.code))
    .slice(0, cap)
    .map(d => d.code);
}

export function captureAtTau(c: Capture, tau: number, cap: number): Capture {
  return { ...c, pages: c.pages.map(p => ({ bundle: p.bundle, page: p.page, codes: deriveAtTau(p, tau, cap) })) };
}

/** Pages whose derived set ≠ a direct run's set (order-insensitive, exact keys). */
export function checkDerived(derived: Capture, direct: Capture): string[] {
  const by = new Map(direct.pages.map(p => [pageKey(p.bundle, p.page), p.codes]));
  const bad: string[] = [];
  for (const p of derived.pages) {
    const k = pageKey(p.bundle, p.page);
    const d = by.get(k);
    const a = [...new Set(p.codes.map(exact))].sort().join(",");
    const b = d ? [...new Set(d.map(exact))].sort().join(",") : null;
    if (a !== b) bad.push(k);
  }
  return bad;
}

export interface SweepRow {
  tau: number;
  codesPerPage: number | null;
  cells: Record<string, { section: Cell; exact: Cell }>;
}

/**
 * The HIGHEST τ whose section recall (given variant) still ≥ `oldRecall` — the most selective
 * setting that keeps OLD's recall — and whether its precision reaches 2× OLD. τ=null when none does.
 * Pass OLD's numbers from compare.ts on the SAME deduped gold (run-eval.sh does); the defaults are
 * OLD strict/section on the 19 distinct pilot pages (0.2054 / 0.0393), not score.ts's 20-page 0.2253.
 */
export function matchOld(rows: SweepRow[], variant: Variant, oldRecall: number, oldPrecision: number) {
  const ok = rows.filter(r => (r.cells[variant]?.section.recall ?? -1) >= oldRecall);
  if (!ok.length) return { tau: null, precision: null, recall: null, meets2xOld: null, target: +(2 * oldPrecision).toFixed(4) };
  const best = ok.reduce((a, b) => (b.tau > a.tau ? b : a));
  const c = best.cells[variant].section;
  return { tau: best.tau, precision: c.precision, recall: c.recall, meets2xOld: c.precision !== null && c.precision >= 2 * oldPrecision, target: +(2 * oldPrecision).toFixed(4) };
}

function main(): void {
  const args = process.argv.slice(2);
  const one = (n: string) => args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const gold = one("gold"), frame = one("frame"), capturePath = one("capture");
  if (!gold || !frame || !capturePath) {
    console.error("usage: node csi-sweep-tau.js --gold=<f> --frame=<f> --capture=<τ=0 capture> [--corpus=<f>] [--taus=a,b,…] [--cap=40] [--old-recall=0.2054] [--old-precision=0.0393] [--out=<f>] [--check=<tau>=<f>] [--min-level=2]");
    process.exit(1);
  }
  const taus = (one("taus") ?? DEFAULT_TAUS.join(",")).split(",").map(Number);
  if (taus.some(t => !(t >= 0 && t <= 1))) throw new Error(`bad --taus ${one("taus")}`);
  const cap = Number(one("cap") ?? "40");
  const oldRecall = Number(one("old-recall") ?? "0.2054");
  const oldPrecision = Number(one("old-precision") ?? "0.0393");
  const minLevel = Number(one("min-level") ?? "2");
  const weightOf = weightFn(JSON.parse(readFileSync(frame, "utf-8")));
  const corpusPath = one("corpus");
  const corpus = corpusPath ? readCorpus(corpusPath) : null;
  const cap0 = JSON.parse(readFileSync(capturePath, "utf-8")) as Capture;
  const dk = (b: string, n: number) => corpus?.get(pageKey(b, n))?.textSha ?? pageKey(b, n);
  const goldPages = dedupe((JSON.parse(readFileSync(gold, "utf-8")) as { pages: GoldPage[] }).pages, p => dk(p.bundle, p.page)).kept;
  const variants: Variant[] = goldPages.length && goldPages.every(isCertifiedPage) ? ["certified"] : ["strict", "generous"];

  const check = one("check");
  if (check) {
    const i = check.indexOf("=");
    const t = Number(check.slice(0, i));
    const bad = checkDerived(captureAtTau(cap0, t, cap), JSON.parse(readFileSync(check.slice(i + 1), "utf-8")) as Capture);
    if (bad.length) { console.error(`sweep: CHECK FAILED at τ=${t}: ${bad.length} page(s) differ from the direct run, e.g. ${bad.slice(0, 3).join(" ")}`); process.exit(2); }
    console.error(`[sweep] check τ=${t}: derived == direct on all ${cap0.pages.length} pages`);
  }

  const rows: SweepRow[] = taus.map(tau => {
    const c = captureAtTau(cap0, tau, cap);
    const s = scoreEngine(goldPages, new Map(c.pages.map(p => [pageKey(p.bundle, p.page), p.codes])), weightOf, variants, minLevel);
    const distinct = dedupe(c.pages, p => dk(p.bundle, p.page)).kept;
    const scored = corpus ? distinct.filter(p => isScoredText(corpus.get(pageKey(p.bundle, p.page))?.text)) : distinct;
    return { tau, codesPerPage: codesPerPage(scored).mean, cells: s.cells };
  });
  const probe = matchOld(rows, variants[0], oldRecall, oldPrecision);
  const out = { schemaVersion: "csi-sweep/1", generatedAt: new Date().toISOString(), cap, oldRecall, oldPrecision, variants, rows, matchOld: probe };
  const outPath = one("out");
  if (outPath) writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  const f = (x: number | null | undefined) => (x === null || x === undefined ? "  —   " : x.toFixed(4));
  console.error(`tau   codes/pg  ${variants.map(v => `${v}/section P  R  F0.5 | hierP hierR`).join(" || ")}`);
  for (const r of rows) {
    console.error(`${r.tau.toFixed(2)}  ${String(r.codesPerPage).padEnd(8)}  ${variants.map(v => {
      const c = r.cells[v].section;
      return `${f(c.precision)} ${f(c.recall)} ${f(c.f05)} | ${f(c.hier.precision)} ${f(c.hier.recall)}`;
    }).join(" || ")}`);
  }
  console.error(`[sweep] matchOld(${variants[0]}/section, R≥${oldRecall}): τ=${probe.tau} P=${probe.precision} vs 2×OLD=${probe.target} → ${probe.meets2xOld}`);
}

// Only run as the CLI entry point (bundle name contains csi-sweep-tau).
if (process.argv[1]?.includes("csi-sweep-tau")) main();
