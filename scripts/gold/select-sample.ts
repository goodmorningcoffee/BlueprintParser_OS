#!/usr/bin/env -S npx tsx
/**
 * select-sample.ts — draw a stratified gold batch (table-pipeline WP-2.G; PLAN §6.1, DR-2.2).
 *
 *   npx tsx scripts/gold/select-sample.ts --batch b1 (--from-corpus | --candidates <cands.jsonl>)
 *       [--private-dir <dir>] [--quota G-TAB:shape-tag-schedule=40,…] [--per-set 2] [--seed 20261027]
 *     --from-corpus  propose candidates from the corpus: the kind labels (kinds.v1) for tables and the bundles'
 *                    System-1 text regions for paragraph blocks; strata are a first guess the labeller corrects
 *     --candidates   any other producer: JSONL of {gold, stratum, pid, setId, page, region, source}
 *     --quota        per gold set and stratum; default = the batch-1 minimums (DR-2.2)
 *     --per-set      at most this many units per set and stratum (default 2), so no one set dominates
 *
 * Writes <dir>/gold/batches/<batch>/sample.json (refuses to overwrite; refuses any path in a BP2 checkout).
 * Units get opaque ids `<tab|para|tagmap>-<batch>-NNNN`. Within a stratum the seeded order alternates odd and even
 * sets, so both halves fill. G-TAGMAP units are drawn from the sampled tables (project scope for schedules, sheet
 * scope for keynote legends). Prints counts only.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BboxMinMax } from "@/types";
import { bestShapeColumn, type ColumnShape } from "@/lib/classifier-engine/shape-column";
import { lineWordsFromLtwh, wordsToLines } from "@/lib/parse-engine/lines";
import { DEFAULT_RESEARCH, loadPage, textractTablesOf, textRegionsOf } from "../lib/corpus-v2-marks";
import { labelledSamplePages, noteGroup, readKindLabels } from "../lib/classifier-labels";
import {
  GOLD_ID_PREFIX, STRATA, argOf, canonicalJson, mulberry32, privateDirOf, readJsonl, seededShuffle, setParity, writePrivate, type GoldSet,
} from "./gold-lib";

export interface Candidate { gold: GoldSet; stratum: string; pid: string; setId: string; page: number; region: BboxMinMax; source: string }
export interface SampleItem extends Candidate { goldId: string; table?: string }
export interface Sample { schema: "bp-gold-sample/1"; batch: string; seed: number; perSet: number; quota: Record<string, number>; taken: Record<string, number>; items: SampleItem[] }

/** Batch-1 minimums (PLAN DR-2.2): 75 tables, 35 paragraph blocks, 15 tag maps. */
export const BATCH1_QUOTA: Record<string, number> = {
  "G-TAB:shape-tag-schedule": 40, "G-TAB:keynote-legend-shapes": 15, "G-TAB:symbol-legend": 10, "G-TAB:kv-legend": 10,
  "G-PARA:spec-hierarchy": 20, "G-PARA:multi-column-notes": 15,
  "G-TAGMAP:schedule-project": 10, "G-TAGMAP:keynote-sheet": 5,
};

export function parseQuota(s: string | undefined): Record<string, number> {
  if (!s) return { ...BATCH1_QUOTA };
  const q: Record<string, number> = {};
  for (const part of s.split(",")) {
    const [k, v] = part.split("=");
    const [gold, stratum] = k.split(":") as [GoldSet, string];
    if (!STRATA[gold]?.includes(stratum)) throw new Error(`--quota ${k}: unknown gold set or stratum`);
    q[k] = Number(v);
  }
  return q;
}

const areaOf = (b: readonly number[]): number => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const interOf = (a: readonly number[], b: readonly number[]): number => areaOf([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);

/**
 * Seeded stratified draw. Per stratum: shuffle, then alternate odd and even sets, skipping a set that already has
 * `perSet` units of that stratum and any region already taken (same page, IoU-ish overlap ≥ .5).
 */
export function drawSample(cands: readonly Candidate[], quota: Record<string, number>, batch: string, seed: number, perSet = 2): Sample {
  const rand = mulberry32(seed);
  const items: SampleItem[] = [];
  const taken: Record<string, number> = {};
  const counters: Record<string, number> = {};
  const nextId = (gold: GoldSet) => { counters[gold] = (counters[gold] ?? 0) + 1; return `${GOLD_ID_PREFIX[gold]}-${batch}-${String(counters[gold]).padStart(4, "0")}`; };
  const sorted = cands.slice().sort((a, b) => canonicalJson(a) < canonicalJson(b) ? -1 : 1); // input order never matters
  for (const key of Object.keys(quota).filter((k) => !k.startsWith("G-TAGMAP:")).sort()) {
    const [gold, stratum] = key.split(":") as [GoldSet, string];
    const pool = seededShuffle(sorted.filter((c) => c.gold === gold && c.stratum === stratum), rand);
    const odd = pool.filter((c) => setParity(c.setId) === "odd"), even = pool.filter((c) => setParity(c.setId) === "even");
    const perSetCount = new Map<string, number>();
    let wantOdd = true;
    while ((taken[key] ?? 0) < quota[key] && (odd.length || even.length)) {
      const q = wantOdd ? (odd.length ? odd : even) : (even.length ? even : odd);
      wantOdd = !wantOdd;
      const c = q.shift()!;
      if ((perSetCount.get(c.setId) ?? 0) >= perSet) continue;
      if (items.some((x) => x.pid === c.pid && x.page === c.page && interOf(x.region, c.region) >= 0.5 * Math.min(areaOf(x.region), areaOf(c.region)))) continue;
      perSetCount.set(c.setId, (perSetCount.get(c.setId) ?? 0) + 1);
      items.push({ ...c, goldId: nextId(gold) });
      taken[key] = (taken[key] ?? 0) + 1;
    }
  }
  // tag maps: from the sampled tables, by scope
  for (const [key, tableStratum] of [["G-TAGMAP:schedule-project", "shape-tag-schedule"], ["G-TAGMAP:keynote-sheet", "keynote-legend-shapes"]] as const) {
    if (!quota[key]) continue;
    const pool = seededShuffle(items.filter((x) => x.gold === "G-TAB" && x.stratum === tableStratum), rand);
    for (const t of pool.slice(0, quota[key])) {
      items.push({ gold: "G-TAGMAP", stratum: key.split(":")[1], pid: t.pid, setId: t.setId, page: t.page, region: t.region, source: `table:${t.goldId}`, goldId: nextId("G-TAGMAP"), table: t.goldId });
      taken[key] = (taken[key] ?? 0) + 1;
    }
  }
  return { schema: "bp-gold-sample/1", batch, seed, perSet, quota, taken, items };
}

/** G-PARA stratum guess from the block's own lines: spec numbering → spec, ≥ 2 key columns → multi-column notes. */
export function guessParaStratum(lines: readonly { text: string; b: readonly number[] }[], region: readonly number[]): string {
  const spec = lines.filter((l) => /^(PART\s+\d|SECTION\s+\d|\d+\.\d{2}\b)/i.test(l.text.trim())).length;
  if (spec >= 2) return "spec-hierarchy";
  const keyed = lines.filter((l) => /^(\d{1,3}[.)]|[A-Z][.)])\s/.test(l.text.trim())).map((l) => l.b[0]);
  const w = region[2] - region[0];
  if (keyed.length >= 4 && w > 0) {
    const xs = keyed.slice().sort((a, b) => a - b);
    if (xs[xs.length - 1] - xs[0] > 0.25 * w) return "multi-column-notes";
  }
  return "notes";
}

/** Candidates from the corpus: kind-labelled boxes → G-TAB; System-1 paragraph / notes regions → G-PARA. */
export function corpusCandidates(): Candidate[] {
  const labels = readKindLabels();
  if (!labels) throw new Error("--from-corpus: the kind labels file is absent");
  const pages = new Map(labelledSamplePages(DEFAULT_RESEARCH).map((s) => [`${s.set}:${s.page}`, s]));
  const out: Candidate[] = [];
  const seenPara = new Set<string>();
  for (const l of labels.items) {
    const s = pages.get(`${l.set}:${l.page}`);
    if (!s || !l.bbox) continue;
    const lp = loadPage(s);
    if (!lp) continue;
    const setId = `set-${l.set}`;
    const shapes: ColumnShape[] = [
      ...lp.detections.filter((d) => d.modelName === "yolo_primitive").map((d) => ({ label: d.name, bbox: [d.minX, d.minY, d.maxX, d.maxY] as BboxMinMax, source: "yolo" as const, confidence: d.confidence ?? 0 })),
      ...lp.keynotes.map((k) => ({ label: k.shape, bbox: k.bbox as BboxMinMax, source: "classical" as const, confidence: 1, text: k.text })),
    ];
    const hasColumn = !!bestShapeColumn(shapes, l.bbox, "any");
    const group = noteGroup(l);
    const note = (l.note ?? "").toLowerCase();
    let stratum: string | null = null;
    if (group === "schedule") {
      const ruled = textractTablesOf(s.pid, s.page).some((t) => interOf([t.bbox[0], t.bbox[1], t.bbox[0] + t.bbox[2], t.bbox[1] + t.bbox[3]], l.bbox!) >= 0.5 * areaOf(l.bbox!));
      stratum = hasColumn ? "shape-tag-schedule" : ruled ? "ruled-no-shape" : "unruled";
    } else if (group === "legend-keynote") {
      stratum = note.includes("abbrev") ? "kv-legend" : /keynote|key note|coded note/.test(note) ? (hasColumn ? "keynote-legend-shapes" : "kv-legend") : "symbol-legend";
    }
    if (stratum) out.push({ gold: "G-TAB", stratum, pid: s.pid, setId, page: s.page, region: l.bbox, source: `kinds:${l.regionId ?? "bbox"}` });
    // paragraph blocks on the same page (each page once)
    if (seenPara.has(`${s.pid}:${s.page}`)) continue;
    seenPara.add(`${s.pid}:${s.page}`);
    const lines = wordsToLines(lineWordsFromLtwh(lp.words), { splitGap: 1.2 });
    for (const tr of textRegionsOf(s.pid, s.page)) {
      if (tr.type !== "paragraph" && tr.type !== "notes-key-value" && tr.type !== "spec-dense-columns") continue;
      const inside = lines.filter((x) => { const cx = (x.b[0] + x.b[2]) / 2, cy = (x.b[1] + x.b[3]) / 2; return cx >= tr.bbox[0] && cx <= tr.bbox[2] && cy >= tr.bbox[1] && cy <= tr.bbox[3]; });
      if (inside.length < 3) continue;
      out.push({ gold: "G-PARA", stratum: guessParaStratum(inside, tr.bbox), pid: s.pid, setId, page: s.page, region: tr.bbox, source: `textRegion:${tr.type}` });
    }
  }
  return out;
}

export function main(argv: readonly string[]): number {
  const batch = argOf(argv, "batch");
  if (!batch || !/^[0-9a-z]+$/.test(batch)) { console.error("usage: select-sample.ts --batch <b1> (--from-corpus | --candidates <file.jsonl>) [--private-dir d] [--quota …] [--per-set 2] [--seed n]"); return 2; }
  const privateDir = privateDirOf(argOf(argv, "private-dir"));
  const candFile = argOf(argv, "candidates");
  const cands = candFile ? (readJsonl(resolve(candFile)) as Candidate[]) : argv.includes("--from-corpus") ? corpusCandidates() : null;
  if (!cands) { console.error("select-sample: pass --from-corpus or --candidates <file.jsonl>"); return 2; }
  const out = join(privateDir, "gold", "batches", batch, "sample.json");
  if (existsSync(out)) { console.error(`select-sample: ${out} exists; a batch is drawn once (pick a new --batch)`); return 2; }
  const sample = drawSample(cands, parseQuota(argOf(argv, "quota")), batch, Number(argOf(argv, "seed") ?? 20261027), Number(argOf(argv, "per-set") ?? 2));
  writePrivate(out, JSON.stringify(sample, null, 1) + "\n", privateDir);
  const short = Object.entries(sample.quota).filter(([k, n]) => (sample.taken[k] ?? 0) < n).map(([k, n]) => `${k} ${sample.taken[k] ?? 0}/${n}`);
  console.log(`select-sample: ${cands.length} candidates → ${sample.items.length} units in ${out}`);
  console.log(`  taken: ${Object.entries(sample.taken).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  if (short.length) console.log(`  SHORT of quota: ${short.join(", ")}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
