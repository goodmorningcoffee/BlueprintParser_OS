#!/usr/bin/env -S npx tsx
/**
 * parse-engine-measure.ts — score the parse paths against the private gold (table-pipeline WP-2.G; PLAN §6.2).
 *
 *   NODE_OPTIONS=--max-old-space-size=3584 npx tsx scripts/parse-engine-measure.ts [--sets odd|even|all]
 *       [--private-dir <dir>] [--json <out.json>] [--tool ocr-positions,merger,…] [--gold G-TAB,G-PARA]
 *       [--seed 20261027] [--resamples 2000] [--baseline-tab legacy:merger] [--baseline-para legacy:notes-auto]
 *       [--synthetic] [--accept-headline-gaps] [--engine] [--profile <profile.json>]
 *     --sets       odd (fit) | even (held out, default) | all — split by the gold line's set number
 *     --private-dir the private gold root (else $BP_PRIVATE_GOLD_DIR; required except with --synthetic):
 *                  reads gold/G-TAB.v1.jsonl, gold/G-PARA.v1.jsonl and slices/<sliceId>.json
 *     --json       write the JSON report there and the markdown table beside it (.md); refused inside a BP2
 *                  checkout. Without it the markdown goes to stdout only.
 *     --tool       legacy paths to run (default: every path that applies to the gold set)
 *     --synthetic  dry run on the committed synthetic fixtures (their `truth` as gold; set n = fixture order)
 *     --engine     add the engine leg (`engine`, TP-3 WP-3.Q: runParseEngine on the same slice, `instant` budget; see
 *                  scripts/lib/parse-engine-leg.ts); async, so only through `runAsync` / the CLI
 *     --profile    with --engine: score these R8 weights instead of the shipped src/data/parse-engine/profile.json
 *     --promotion  with --engine: add the per-tool §6.4 table (tool's legacy baseline vs the engine; PROMOTION_TOOLS in
 *                  scripts/lib/parse-engine-leg.ts) to the markdown and the JSON (`promotion`)
 *     --inbox-coverage  instead of the gold: the corpus coverage of the inbox's sources vs `classifiedTables` /
 *                  `ensembleRegions` (scripts/lib/inbox-coverage.ts) [--corpus <corpus_v2>] [--research <dir>]
 *     --accept-headline-gaps  let §6.4 promote although some §6.3 headlines are not measured (HEADLINE_GAPS in
 *                  lib/parse-measure.ts); only once the owner / integrator has accepted the narrowed set. Without it a
 *                  would-be promote is reported undecided, and the report names the missing headlines either way.
 *
 * Legs: one per legacy path (`legacy:<path>`, through the WP-2.0a adapters in lib/legacy-joins/legacy-paths.ts),
 * plus the engine leg with --engine (TP-3 WP-3.Q, the same `Leg` shape, precomputed because the engine is async). Every headline gets a
 * seeded bootstrap 95 % CI over units, per stratum too, and a PAIRED CI of (leg − baseline) with the §6.4 verdict.
 * The report holds numbers, leg ids, strata and opaque gold ids only — never drawing text.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LegacyPathId, LegacySlice } from "@/lib/legacy-joins/legacy-paths";
import { LEGACY_PATH_IDS } from "@/lib/legacy-joins/legacy-paths";
import { argOf, inSplit, optionalPrivateDirOf, privateDirOf, readJsonl, refuseWrite, validateRecords, writePrivate, type GoldLine, type TabTruth } from "./gold/gold-lib";
import { legacyLegs, measure, reportMarkdown, type Leg, type MeasureReport, type Unit } from "./lib/parse-measure";
import { engineLeg, promotionMarkdown, promotionTable, type ToolVerdict } from "./lib/parse-engine-leg";
import { corpusCoveragePages, coverageMarkdown, coverageOf, type InboxCoverage } from "./lib/inbox-coverage";
import { resolveParseEngineProfile, type ParseEngineProfile } from "@/lib/parse-engine/profile";

type MinMax = [number, number, number, number];
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SYNTHETIC_DIR = join(REPO_ROOT, "src/lib/parse-engine/__fixtures__");

interface FixtureFile {
  id: string; kind: string; synthetic?: boolean; page: LegacySlice["page"]; shapes: LegacySlice["shapes"]; region: MinMax;
  manual: LegacySlice["manual"]; guided: LegacySlice["guided"];
  truth: { type: "grid"; headers: string[]; rows: string[][] } | { type: "items"; items: { key: string; text: string }[] };
}

const toSlice = (f: FixtureFile): LegacySlice => ({ id: f.id, page: f.page, shapes: f.shapes ?? [], region: f.region, manual: f.manual, guided: f.guided });

/** Manual / guided inputs drawn on the gold's own grid (as a user would end up), when the gold carries its edges. */
export function inputsFromTruth(t: TabTruth, region: MinMax): Pick<LegacySlice, "manual" | "guided"> | null {
  if (!t.colEdges || !t.rowEdges) return null;
  const ce = t.colEdges, re = t.rowEdges, h = t.headerRows.length;
  return {
    guided: { rows: re.slice(), cols: ce.slice() },
    manual: {
      columnBBs: ce.slice(0, -1).map((x, i) => [x, region[1], ce[i + 1], region[3]] as MinMax),
      rowBBs: re.slice(h, -1).map((y, i) => [region[0], y, region[2], re[h + i + 1]] as MinMax),
      columnNames: [],
    },
  };
}

/** The synthetic fixtures as gold units (dry run): grid truth → G-TAB, item truth → G-PARA; key-value legends are 2-column tables. */
export function syntheticUnits(dir = SYNTHETIC_DIR): Unit[] {
  const files = readdirSync(dir).filter((f) => /^syn-.*\.synthetic\.json$/.test(f)).sort();
  return files.map((f, i): Unit => {
    const fx = JSON.parse(readFileSync(join(dir, f), "utf8")) as FixtureFile;
    const setId = `set-${i + 1}`;
    const slice = toSlice(fx);
    const shapes = (fx.shapes ?? []).length > 0, tables = (fx.page.tables ?? []).length > 0;
    if (fx.truth.type === "grid" || fx.kind === "kv-legend") {
      const grid = fx.truth.type === "grid" ? fx.truth : { headers: [], rows: fx.truth.items.map((x) => [x.key, x.text]) };
      const ncols = Math.max(grid.headers.length, ...grid.rows.map((r) => r.length));
      const stratum = fx.kind === "kv-legend" ? "kv-legend"
        : fx.kind === "keynote" ? (shapes ? "keynote-legend-shapes" : "kv-legend")
          : shapes ? "shape-tag-schedule" : tables ? "ruled-no-shape" : /two-tier/.test(fx.id) ? "two-tier-wrapped" : "unruled";
      const truth: TabTruth = {
        headerRows: grid.headers.length ? [grid.headers] : [],
        rows: grid.rows.map((cells) => (cells.length === 1 && ncols > 1 ? { cells, section: true as const } : { cells })),
      };
      return { gold: "G-TAB", goldId: `tab-${fx.id}`, setId, stratum, slice, truth };
    }
    const stratum = fx.kind === "spec" ? "spec-hierarchy" : /two-column|multicolumn/.test(fx.id) ? "multi-column-notes" : "notes";
    return { gold: "G-PARA", goldId: `para-${fx.id}`, setId, stratum, slice, truth: { items: fx.truth.items } };
  });
}

/** Private gold → units. Lines whose slice is missing are counted in `skipped`, never silently dropped. */
export function privateUnits(privateDir: string, sets: string, golds: readonly string[]): { units: Unit[]; skipped: Record<string, number>; adjudicated: Record<string, number> } {
  const units: Unit[] = [];
  const skipped: Record<string, number> = {};
  const adjudicated: Record<string, number> = {};
  const bump = (k: string) => { skipped[k] = (skipped[k] ?? 0) + 1; };
  const lines: GoldLine[] = [];
  for (const g of golds) {
    const file = join(privateDir, "gold", `${g}.v1.jsonl`);
    if (!existsSync(file)) { bump(`${g}: no gold file`); continue; }
    const { lines: ls, problems } = validateRecords(readJsonl(file));
    if (problems.length) throw new Error(`${file}: ${problems.length} problems — run scripts/gold/validate.ts (first: ${problems[0]})`);
    lines.push(...ls);
  }
  for (const l of lines) {
    if ((l.gold !== "G-TAB" && l.gold !== "G-PARA") || !inSplit(l.setId, sets)) continue;
    if (!l.sliceId) { bump(`${l.gold}: no sliceId`); continue; }
    const sf = join(privateDir, "slices", `${l.sliceId}.json`);
    if (!existsSync(sf)) { bump(`${l.gold}: slice file missing`); continue; }
    const slice = { ...toSlice(JSON.parse(readFileSync(sf, "utf8")) as FixtureFile), region: l.region as MinMax };
    if (l.adjudicated) adjudicated[l.gold] = (adjudicated[l.gold] ?? 0) + 1;
    if (l.gold === "G-TAB") units.push({ gold: "G-TAB", goldId: l.goldId, setId: l.setId, stratum: l.stratum, truth: l.truth, slice: { ...slice, ...(inputsFromTruth(l.truth, l.region as MinMax) ?? {}) } });
    else units.push({ gold: "G-PARA", goldId: l.goldId, setId: l.setId, stratum: l.stratum, truth: l.truth, slice });
  }
  return { units, skipped, adjudicated };
}

/** The units, legs and options a run needs (shared by the sync legacy-only `run` and `runAsync`). */
function prepare(argv: readonly string[]) {
  const sets = argOf(argv, "sets") ?? "even";
  if (!["odd", "even", "all"].includes(sets)) throw new Error(`--sets must be odd, even or all (got ${sets})`);
  const golds = (argOf(argv, "gold") ?? "G-TAB,G-PARA").split(",");
  const tools = argOf(argv, "tool")?.split(",");
  for (const t of tools ?? []) if (!(LEGACY_PATH_IDS as readonly string[]).includes(t)) throw new Error(`--tool ${t}: not a legacy path (${LEGACY_PATH_IDS.join(", ")})`);
  const synthetic = argv.includes("--synthetic");
  // the synthetic dry run reads no gold, so it needs no private dir
  const privateDir = synthetic ? optionalPrivateDirOf(argOf(argv, "private-dir")) : privateDirOf(argOf(argv, "private-dir"));
  let units: Unit[], skipped: Record<string, number> = {}, adjudicated: Record<string, number> = {};
  if (synthetic) units = syntheticUnits().filter((u) => golds.includes(u.gold) && inSplit(u.setId, sets));
  else ({ units, skipped, adjudicated } = privateUnits(privateDir as string, sets, golds));
  const legs = legacyLegs(tools ? (id: LegacyPathId) => tools.includes(id) : undefined);
  const options = {
    sets, seed: Number(argOf(argv, "seed") ?? 20261027), resamples: Number(argOf(argv, "resamples") ?? 2000),
    baseline: { "G-TAB": argOf(argv, "baseline-tab"), "G-PARA": argOf(argv, "baseline-para") },
    acceptHeadlineGaps: argv.includes("--accept-headline-gaps"),
  };
  return { synthetic, privateDir, units, skipped, adjudicated, legs, options };
}

/** Score, then write the JSON + markdown where allowed. */
function finish(argv: readonly string[], p: ReturnType<typeof prepare>, legs: readonly Leg[], promotion?: readonly ToolVerdict[]): { report: MeasureReport & { promotion?: readonly ToolVerdict[] }; markdown: string; written: string[] } {
  const { synthetic, privateDir, units, skipped, adjudicated, options } = p;
  const report: MeasureReport & { promotion?: readonly ToolVerdict[] } = measure(units, legs, options);
  Object.assign(report.skipped, skipped);
  for (const [g, n] of Object.entries(adjudicated)) if (report.gold[g]) report.gold[g].adjudicated = n;
  if (promotion) report.promotion = promotion;
  const markdown = reportMarkdown(report) + (promotion ? `\n${promotionMarkdown(promotion)}` : "");
  const written: string[] = [];
  const json = argOf(argv, "json");
  if (json) {
    // reports may go to the private logs dir (outside the gold root), never into a BP2 checkout
    const root = privateDir ?? dirname(resolve(json));
    const refused = refuseWrite(json, root, false);
    if (refused) throw new Error(`refused --json: ${refused}`);
    const md = json.replace(/\.json$/, "") + ".md";
    writePrivate(json, JSON.stringify(report, null, 1) + "\n", root, false);
    writePrivate(md, `${synthetic ? "_synthetic dry run_\n\n" : ""}${markdown}`, root, false);
    written.push(json, md);
  }
  return { report, markdown, written };
}

/** Legacy legs only (synchronous). `--engine` needs `runAsync`. */
export function run(argv: readonly string[]): { report: MeasureReport; markdown: string; written: string[] } {
  if (argv.includes("--engine")) throw new Error("--engine is async: call runAsync (the CLI does)");
  const p = prepare(argv);
  return finish(argv, p, p.legs);
}

/** A profile file for --profile (refused when malformed: a silent fallback would score the defaults under another name). */
export function profileFromFile(file: string): ParseEngineProfile {
  const r = resolveParseEngineProfile(JSON.parse(readFileSync(file, "utf8")));
  if (r.error) throw new Error(`--profile ${file}: ${r.error}`);
  return r.profile;
}

/** Legacy legs, plus the engine leg with --engine (TP-3 WP-3.Q). */
export async function runAsync(argv: readonly string[]): Promise<{ report: MeasureReport & { promotion?: readonly ToolVerdict[] }; markdown: string; written: string[] }> {
  const p = prepare(argv);
  if (!argv.includes("--engine")) return finish(argv, p, p.legs);
  const file = argOf(argv, "profile");
  const leg = await engineLeg(p.units, file ? { profile: profileFromFile(file) } : {});
  if (leg.errors) p.skipped["engine threw (scored as empty)"] = leg.errors;
  const legs = [...p.legs, leg];
  const promotion = argv.includes("--promotion") ? promotionTable(p.units, legs, leg.id, { seed: p.options.seed, resamples: p.options.resamples }) : undefined;
  return finish(argv, p, legs, promotion);
}

/** --inbox-coverage: the corpus coverage table (numbers and set ids only); JSON beside the markdown with --json. */
export function runInboxCoverage(argv: readonly string[]): { coverage: InboxCoverage; markdown: string; written: string[] } {
  const coverage = coverageOf(corpusCoveragePages({ corpus: argOf(argv, "corpus"), research: argOf(argv, "research"), sets: argOf(argv, "sets") ?? "all" }));
  const markdown = coverageMarkdown(coverage);
  const written: string[] = [];
  const json = argOf(argv, "json");
  if (json) {
    const root = dirname(resolve(json));
    writePrivate(json, JSON.stringify(coverage, null, 1) + "\n", root, false);
    writePrivate(json.replace(/\.json$/, "") + ".md", markdown, root, false);
    written.push(json, json.replace(/\.json$/, "") + ".md");
  }
  return { coverage, markdown, written };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  (argv.includes("--inbox-coverage") ? Promise.resolve().then(() => runInboxCoverage(argv)) : runAsync(argv)).then(({ markdown, written }) => {
    process.stdout.write(markdown);
    for (const w of written) console.error(`parse-engine-measure: wrote ${w}`);
  }, (e: unknown) => {
    console.error(`parse-engine-measure: ${(e as Error).message}`);
    process.exitCode = 1;
  });
}
