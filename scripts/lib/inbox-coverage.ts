/**
 * inbox-coverage.ts — how much of the legacy table detections the workspace inbox's sources cover, on the corpus
 * (table-pipeline WP-3.Q acceptance; PLAN §5 WP-3.Q, C2-m7: `classifiedTables` / `ensembleRegions` are NOT inbox
 * sources, so whatever only they found never reaches the inbox).
 *
 * Per research-sample page: the classifier proposals (built-in recipes at their hand thresholds; the same run as
 * scripts/classifier-measure.ts, through scripts/lib/corpus-v2-marks.ts) vs the bundle's stored `classifiedTables` and
 * `ensembleRegions` (ensemble: `tableProbability ≥ .5`). Reports, per legacy source, the share of its boxes some
 * proposal overlaps at IoU ≥ .5 and ≥ .3, and the share of proposals no legacy box overlaps. Counts and set numbers
 * only; no text.
 */
import type { BboxMinMax } from "@/types";
import { BUILT_IN_RECIPES, runClassifierEngine } from "@/lib/classifier-engine";
import { createCsiBoxTagger } from "@/lib/classifier-engine/csi-box-tagger";
import { classifyRegionsV2 } from "@/lib/region-classifier-v2";
import { classifiedSourcesOf, DEFAULT_CORPUS, DEFAULT_RESEARCH, loadPage, readSample, textractTablesOf, type SamplePage } from "./corpus-v2-marks";

export function iouMinMax(a: readonly number[], b: readonly number[]): number {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])), iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const i = ix * iy, u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i;
  return u > 0 ? i / u : 0;
}

export interface CoveragePage { set: number; proposals: BboxMinMax[]; classifiedTables: BboxMinMax[]; ensembleRegions: BboxMinMax[] }
export interface SourceCoverage { boxes: number; coveredIou50: number; coveredIou30: number; share50: number; share30: number }
export interface InboxCoverage {
  schema: "bp-inbox-coverage/1";
  pages: number; pagesWithLegacy: number; proposals: number;
  classifiedTables: SourceCoverage; ensembleRegions: SourceCoverage;
  /** Proposals no legacy box overlaps at IoU ≥ .3 (what the inbox adds over the legacy detectors). */
  proposalsOnlyInInbox: number;
  bySet: Record<string, { pages: number; proposals: number; legacy: number; legacyCovered50: number }>;
}

const r4 = (v: number): number => (Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : 0);
const best = (b: readonly number[], others: readonly (readonly number[])[]): number => others.reduce((m, o) => Math.max(m, iouMinMax(b, o)), 0);

/** Pure: coverage over already-loaded pages. */
export function coverageOf(pages: readonly CoveragePage[]): InboxCoverage {
  const src = (pick: (p: CoveragePage) => BboxMinMax[]): SourceCoverage => {
    let boxes = 0, c50 = 0, c30 = 0;
    for (const p of pages) for (const b of pick(p)) { boxes++; const m = best(b, p.proposals); if (m >= 0.5) c50++; if (m >= 0.3) c30++; }
    return { boxes, coveredIou50: c50, coveredIou30: c30, share50: r4(boxes ? c50 / boxes : NaN), share30: r4(boxes ? c30 / boxes : NaN) };
  };
  const bySet: InboxCoverage["bySet"] = {};
  let only = 0;
  for (const p of pages) {
    const legacy = [...p.classifiedTables, ...p.ensembleRegions];
    for (const b of p.proposals) if (best(b, legacy) < 0.3) only++;
    const k = `set-${p.set}`;
    const s = (bySet[k] ??= { pages: 0, proposals: 0, legacy: 0, legacyCovered50: 0 });
    s.pages++; s.proposals += p.proposals.length; s.legacy += legacy.length;
    s.legacyCovered50 += legacy.filter((b) => best(b, p.proposals) >= 0.5).length;
  }
  return {
    schema: "bp-inbox-coverage/1", pages: pages.length,
    pagesWithLegacy: pages.filter((p) => p.classifiedTables.length + p.ensembleRegions.length > 0).length,
    proposals: pages.reduce((s, p) => s + p.proposals.length, 0),
    classifiedTables: src((p) => p.classifiedTables), ensembleRegions: src((p) => p.ensembleRegions),
    proposalsOnlyInInbox: only, bySet,
  };
}

/** Load the research sample from the corpus and run the built-in recipes (hand thresholds) per page. */
export function corpusCoveragePages(o: { corpus?: string; research?: string; sets?: string } = {}): CoveragePage[] {
  const corpus = o.corpus ?? DEFAULT_CORPUS;
  const sample: SamplePage[] = readSample(o.research ?? DEFAULT_RESEARCH);
  const want = (set: number) => !o.sets || o.sets === "all" || (o.sets === "odd" ? set % 2 === 1 : o.sets === "even" ? set % 2 === 0 : o.sets.split(",").map(Number).includes(set));
  const tagger = createCsiBoxTagger();
  const out: CoveragePage[] = [];
  for (const s of sample) {
    if (!want(s.set)) continue;
    const loaded = loadPage(s, corpus);
    if (!loaded) continue;
    const { detections, words, csiCodes, drawingNumber } = loaded;
    const tables = textractTablesOf(s.pid, s.page, corpus);
    const regionsV2 = classifyRegionsV2({ pageNumber: s.page, detections, textractData: { words, tables }, csiCodes });
    const run = runClassifierEngine({ pageNumber: s.page, detections, textractData: { words, tables }, csiCodes, regionsV2, drawingNumber, tagger, keynotes: loaded.keynotes }, BUILT_IN_RECIPES);
    const thresholds = new Map(BUILT_IN_RECIPES.map((r) => [r.id, r.detect.threshold]));
    const proposals = run.result.proposals.filter((p) => p.p >= (thresholds.get(p.recipeId) ?? 0.5) && !(p.bbox[0] === 0 && p.bbox[1] === 0 && p.bbox[2] === 1 && p.bbox[3] === 1)).map((p) => p.bbox);
    const legacy = classifiedSourcesOf(s.pid, s.page, corpus);
    out.push({ set: s.set, proposals, classifiedTables: legacy.classifiedTables.map((t) => t.bbox), ensembleRegions: legacy.ensembleRegions.filter((e) => e.tableProbability >= 0.5).map((e) => e.bbox) });
  }
  return out;
}

const pct = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(1)} %` : "n/a");

export function coverageMarkdown(c: InboxCoverage): string {
  return [
    `# inbox coverage — ${c.pages} research-sample pages (${c.pagesWithLegacy} with a legacy detection), ${c.proposals} proposals`, "",
    "| legacy source (not an inbox source) | boxes | a proposal at IoU ≥ .5 | at IoU ≥ .3 |", "|---|---|---|---|",
    `| classifiedTables | ${c.classifiedTables.boxes} | ${c.classifiedTables.coveredIou50} (${pct(c.classifiedTables.share50)}) | ${c.classifiedTables.coveredIou30} (${pct(c.classifiedTables.share30)}) |`,
    `| ensembleRegions (tableProbability ≥ .5) | ${c.ensembleRegions.boxes} | ${c.ensembleRegions.coveredIou50} (${pct(c.ensembleRegions.share50)}) | ${c.ensembleRegions.coveredIou30} (${pct(c.ensembleRegions.share30)}) |`,
    "", `Proposals with no legacy box at IoU ≥ .3: ${c.proposalsOnlyInInbox} of ${c.proposals}.`, "",
  ].join("\n");
}
