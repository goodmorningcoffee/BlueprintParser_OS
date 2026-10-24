#!/usr/bin/env -S npx tsx
/**
 * tag-mapping-v2-measure.ts — run tag mapping v1 (source === "yolo" shapes, no text rules) and v2
 * (shape ensemble + owner rules) over corpus_v2 bundles and report before/after counts.
 *
 *   NODE_OPTIONS=--max-old-space-size=3584 npx tsx scripts/tag-mapping-v2-measure.ts [--sets 10] [--tags 40]
 *       [--json out.json] [--spot spot.json] [--seed 20261024]
 *     --corpus   corpus_v2 root (default /workspaces/projects/gitignore/corpus_v2)
 *     --extract  research/shapes/bundle_extract dir (per-set classifiedTables excerpt → the tag strings)
 *     --sets     how many sets (ranked by the number of tag-like schedule / keynote keys)
 *     --tags     tag strings per set (most frequent first)
 *
 * Tag source (research/shapes/tagfind.py): classifiedTables grid rows whose first column is tag-like
 * (≥ 2 chars) in tables holding ≥ 3 such keys. For each tag: Type 2 (text-only) v1 vs v2 and Type 3
 * (yolo-with-inner-text) v1 vs v2 for the set's three most common tag-shape classes. v2-only Type 3
 * hits are sampled into --spot for a pixel spot check (crops cut by a separate Python step).
 * Projects are reported as "set N" (data/set_names.json); no OCR text beyond tag strings is printed.
 * Corpus caveat: classifiedTables carry no quantity column and parsedRegions are 4 corpus-wide, so
 * completeness certificates are NOT measurable here.
 */
import { readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ClientAnnotation, TextractPageData } from "@/types";
import {
  findOccurrences, buildEnsembleContext, DEFAULT_TAG_RULES, allPagesScope,
  type MatchContext, type CountableItem, type ScoredMatch,
} from "@/lib/tag-mapping";
import { findFreeFloatingMatches, type TextRulesContext } from "@/lib/tag-mapping/matchers/type2-text-only";
import { discoverTagFamilies, isTagLike, TAG_SHAPE_CLASSES, type EnsembleShape } from "@/lib/shape-ensemble";
import { FLOATING_BIND_REACH } from "@/lib/tag-mapping/matchers/ensemble-shapes";
import { zoneOf } from "@/lib/page-zones";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const CORPUS = opt("corpus") ?? "/workspaces/projects/gitignore/corpus_v2";
const EXTRACT = opt("extract") ?? "/workspaces/projects/gitignore/projects/master_plan_2026-10-24/research/shapes/bundle_extract";
const N_SETS = Number(opt("sets") ?? 10);
const N_TAGS = Number(opt("tags") ?? 40);
const SEED = Number(opt("seed") ?? 20261024);
const MAX_BUNDLE_BYTES = 120 * 1024 * 1024;

const setNames = JSON.parse(readFileSync(join(CORPUS, "data", "set_names.json"), "utf8")) as Record<string, number>;
const setNo = (pid: string): string => `set ${setNames[pid] ?? "?"}`;

// Deterministic PRNG (mulberry32) for the spot sample.
let seed = SEED >>> 0;
const rand = (): number => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

interface ExtractPage { classifiedTables?: Array<{ grid?: { rows?: Array<Record<string, string>> } }> | { _truncated: true } }
interface Extract { publicId: string; pages: Record<string, ExtractPage> }

/** Tag strings of a set, most frequent first, from the classifiedTables excerpt. */
function tagsOf(extract: Extract): Map<string, number> {
  const tags = new Map<string, number>();
  for (const page of Object.values(extract.pages)) {
    const ct = page.classifiedTables;
    if (!ct || !Array.isArray(ct)) continue;
    for (const t of ct) {
      const rows = t.grid?.rows ?? [];
      const keys = rows.map((r) => String(Object.values(r)[0] ?? "").toUpperCase().trim()).filter((k) => k.length >= 2 && isTagLike(k));
      if (keys.length < 3) continue;
      for (const k of keys) tags.set(k, (tags.get(k) ?? 0) + 1);
    }
  }
  return tags;
}

interface BundlePage { pageNumber: number; drawingNumber: string | null; textractData: TextractPageData | null; pageIntelligence: unknown }
interface BundleAnnotation { id: number; name: string; bbox: [number, number, number, number]; pageNumber: number; source: ClientAnnotation["source"]; data: Record<string, unknown> | null; note: string | null }
interface Bundle { project: { publicId: string }; pages: BundlePage[]; annotations: BundleAnnotation[] }

const ranked = readdirSync(EXTRACT).filter((f) => f.endsWith(".json")).map((f) => {
  const ex = JSON.parse(readFileSync(join(EXTRACT, f), "utf8")) as Extract;
  const tags = tagsOf(ex);
  return { pid: ex.publicId, tags, score: tags.size };
}).filter((s) => s.score >= 3)
  .filter((s) => { try { return statSync(join(CORPUS, "data", "bundles", `${s.pid}.json`)).size <= MAX_BUNDLE_BYTES; } catch { return false; } })
  .sort((a, b) => b.score - a.score || a.pid.localeCompare(b.pid))
  .slice(0, N_SETS);

interface SetReport {
  set: string; pages: number; tags: number;
  ensemble: { yolo: number; classical: number; both: number; callouts: number; detailTitles: number; legendKeys: number; drops: Record<string, number> };
  families3: number;
  textOnly: { v1: number; v2: number; rejected: Record<string, number> };
  /** v1Only: hits v2 no longer emits, by cause — direct inner-text hit on a shape the ensemble now calls a
   *  detail callout / dropped (table, title block) / not emitted, or a floating word bound to a nearest
   *  shape (v1 binds to ANY YOLO shape of the class; v2 only to ensemble tag shapes, and the word must
   *  pass the text rules). */
  type3: Array<{ cls: string; v1: number; v2: number; v2r: number; v2OnlyBySource: Record<string, number>; v1Only: number; v1OnlyBy: Record<string, number> }>;
}
interface Spot { set: string; pid: string; page: number; tag: string; cls: string; bbox: [number, number, number, number]; source: string; text: string | null; confidence: number }

const reports: SetReport[] = [];
const spots: Spot[] = [];
const key = (m: ScoredMatch) => `${m.pageNumber}:${m.annotationId}:${m.bbox.map((n) => n.toFixed(5)).join(",")}`;

for (const s of ranked) {
  const bundle = JSON.parse(readFileSync(join(CORPUS, "data", "bundles", `${s.pid}.json`), "utf8")) as Bundle;
  const annotations: ClientAnnotation[] = bundle.annotations
    .filter((a) => a.source === "yolo" || a.source === "shape-parse")
    .map((a) => ({ id: a.id, pageNumber: a.pageNumber, name: a.name, bbox: a.bbox, note: a.note, source: a.source, data: a.data }));
  const textractData: Record<number, TextractPageData> = {};
  const pages = bundle.pages.map((p) => {
    if (p.textractData?.words) textractData[p.pageNumber] = { words: p.textractData.words, lines: [] };
    return { pageNumber: p.pageNumber, drawingNumber: p.drawingNumber, textractData: p.textractData ? { words: p.textractData.words } : null, pageIntelligence: p.pageIntelligence };
  });
  const ensemble = buildEnsembleContext(annotations, pages);
  const base = { scope: allPagesScope(), isPageScoped: false, annotations, textractData, classifiedRegionsByPage: {}, pattern: null } satisfies MatchContext;
  const v1: MatchContext = base;
  const v2: MatchContext = { ...base, shapes: ensemble.shapes, sheetNumbers: ensemble.sheetNumbers, rules: DEFAULT_TAG_RULES };
  // v2 + reach: the floating fallback capped at FLOATING_BIND_REACH shape long-sides (owner decision; off by default).
  const v2r: MatchContext = { ...v2, rules: { ...DEFAULT_TAG_RULES, floatingBindReach: FLOATING_BIND_REACH } };

  const ens = { yolo: 0, classical: 0, both: 0, callouts: 0, detailTitles: 0, legendKeys: 0, drops: {} as Record<string, number> };
  const shapeById = new Map<string, EnsembleShape>();
  for (const [pn, r] of Object.entries(ensemble.results)) {
    ens.yolo += r.counts.yolo; ens.classical += r.counts.classical; ens.both += r.counts.both; ens.callouts += r.counts.callouts; ens.detailTitles += r.counts.detailTitles; ens.legendKeys += r.counts.legendKeys;
    for (const [k, v] of Object.entries(r.drops)) ens.drops[k] = (ens.drops[k] ?? 0) + v;
    for (const sh of r.shapes) shapeById.set(`${pn}:${sh.yoloAnnotationId ?? sh.classicalAnnotationId ?? -1}`, sh);
  }
  const families3 = discoverTagFamilies(Object.entries(ensemble.shapes).map(([pn, shapes]) => ({ pageNumber: Number(pn), shapes }))).length;

  const tags = [...s.tags.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, N_TAGS).map(([t]) => t);
  const classCount = new Map<string, number>();
  for (const shapes of Object.values(ensemble.shapes)) for (const sh of shapes) if (sh.kind === "tag") classCount.set(sh.cls, (classCount.get(sh.cls) ?? 0) + 1);
  const topClasses = [...classCount.entries()].filter(([c]) => TAG_SHAPE_CLASSES.has(c)).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c]) => c);

  const textOnly = { v1: 0, v2: 0, rejected: {} as Record<string, number> };
  const type3 = topClasses.map((cls) => ({ cls, v1: 0, v2: 0, v2r: 0, v2OnlyBySource: {} as Record<string, number>, v1Only: 0, v1OnlyBy: {} as Record<string, number> }));
  const calloutIds = new Set<string>();
  const droppedZoneIds = new Set<string>();
  for (const [pn, r] of Object.entries(ensemble.results)) for (const sh of r.shapes) if (sh.kind === "detail_callout") calloutIds.add(`${pn}:${sh.yoloAnnotationId}`);
  for (const a of annotations) {
    if (a.source !== "yolo" || !TAG_SHAPE_CLASSES.has(a.name)) continue;
    const z = ensemble.zonesByPage[a.pageNumber];
    if (z && (zoneOf(z, a.bbox) === "table" || zoneOf(z, a.bbox) === "title_block")) droppedZoneIds.add(`${a.pageNumber}:${a.id}`);
  }
  for (const tag of tags) {
    const t2: CountableItem = { itemType: "text-only", label: tag, text: tag };
    textOnly.v1 += findOccurrences(t2, v1).length;
    const rules: TextRulesContext = { rules: DEFAULT_TAG_RULES, shapesByPage: ensemble.shapes, rejected: {} };
    textOnly.v2 += findFreeFloatingMatches(tag, "project", undefined, textractData, rules).length;
    for (const [k, v] of Object.entries(rules.rejected ?? {})) textOnly.rejected[k] = (textOnly.rejected[k] ?? 0) + v;
    for (const t3 of type3) {
      const item: CountableItem = { itemType: "yolo-with-inner-text", label: tag, yoloClass: t3.cls, text: tag };
      const a = findOccurrences(item, v1);
      const b = findOccurrences(item, v2);
      t3.v1 += a.length; t3.v2 += b.length; t3.v2r += findOccurrences(item, v2r).length;
      const aKeys = new Set(a.map(key));
      const bKeys = new Set(b.map(key));
      for (const m of a) {
        if (bKeys.has(key(m))) continue;
        t3.v1Only++;
        const cause = m.confidence < 0.9 ? "bound floating word" : calloutIds.has(`${m.pageNumber}:${m.annotationId}`) ? "direct: detail callout"
          : droppedZoneIds.has(`${m.pageNumber}:${m.annotationId}`) ? "direct: in table / title block" : "direct: other";
        t3.v1OnlyBy[cause] = (t3.v1OnlyBy[cause] ?? 0) + 1;
      }
      for (const m of b) {
        if (aKeys.has(key(m))) continue;
        const sh = shapeById.get(`${m.pageNumber}:${m.annotationId}`);
        const bound = m.confidence < 0.9;
        const src = bound ? "bound floating word" : sh ? sh.source : "?";
        t3.v2OnlyBySource[src] = (t3.v2OnlyBySource[src] ?? 0) + 1;
        if (sh && !bound) spots.push({ set: setNo(s.pid), pid: s.pid, page: m.pageNumber, tag, cls: t3.cls, bbox: [sh.bbox[0], sh.bbox[1], sh.bbox[2], sh.bbox[3]], source: sh.source, text: sh.text, confidence: sh.confidence });
      }
    }
  }
  reports.push({ set: setNo(s.pid), pages: pages.length, tags: tags.length, ensemble: ens, families3, textOnly, type3 });
  console.error(`${setNo(s.pid)}: ${pages.length} pages, ${tags.length} tags, ensemble y/c/b ${ens.yolo}/${ens.classical}/${ens.both}, text-only ${textOnly.v1}→${textOnly.v2}, type3 ${type3.map((t) => `${t.cls} ${t.v1}→${t.v2}`).join(" · ")}`);
}

// ─── report ───
const sum = (f: (r: SetReport) => number) => reports.reduce((a, r) => a + f(r), 0);
console.log(`\nTAG MAPPING v1 → v2 on ${reports.length} corpus sets (${sum((r) => r.pages)} pages, ${sum((r) => r.tags)} tag strings)`);
console.log(`\nShape ensemble: yolo-only ${sum((r) => r.ensemble.yolo)} · classical-only ${sum((r) => r.ensemble.classical)} · both ${sum((r) => r.ensemble.both)} · detail callouts ${sum((r) => r.ensemble.callouts)} · detail titles ${sum((r) => r.ensemble.detailTitles)} · legend keys ${sum((r) => r.ensemble.legendKeys)}`);
const drops: Record<string, number> = {};
for (const r of reports) for (const [k, v] of Object.entries(r.ensemble.drops)) drops[k] = (drops[k] ?? 0) + v;
console.log(`  drops: ${Object.entries(drops).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
console.log(`  tag families (≥3 instances): ${sum((r) => r.families3)} across the sets`);
console.log(`\nType 2 text-only occurrences: v1 ${sum((r) => r.textOnly.v1)} → v2 ${sum((r) => r.textOnly.v2)}`);
const rej: Record<string, number> = {};
for (const r of reports) for (const [k, v] of Object.entries(r.textOnly.rejected)) rej[k] = (rej[k] ?? 0) + v;
console.log(`  rejected by rule: ${Object.entries(rej).map(([k, v]) => `${k} ${v}`).join(" · ") || "none"}`);
const t3: Record<string, { v1: number; v2: number; v2r: number; v1Only: number; src: Record<string, number>; by: Record<string, number> }> = {};
for (const r of reports) for (const t of r.type3) {
  const row = (t3[t.cls] ??= { v1: 0, v2: 0, v2r: 0, v1Only: 0, src: {}, by: {} });
  row.v1 += t.v1; row.v2 += t.v2; row.v2r += t.v2r; row.v1Only += t.v1Only;
  for (const [k, v] of Object.entries(t.v2OnlyBySource)) row.src[k] = (row.src[k] ?? 0) + v;
  for (const [k, v] of Object.entries(t.v1OnlyBy)) row.by[k] = (row.by[k] ?? 0) + v;
}
console.log(`\nType 3 (yolo-with-inner-text) occurrences by tag-shape class (v2 = ensemble shapes + rules, v1 binding reach; "reach cap" = floating words bind only within ${FLOATING_BIND_REACH} shape long-sides):`);
for (const [cls, row] of Object.entries(t3).sort((a, b) => b[1].v2 - a[1].v2)) {
  console.log(`  ${cls.padEnd(18)} v1 ${String(row.v1).padStart(6)} → v2 ${String(row.v2).padStart(6)}  (v2 + reach cap ${String(row.v2r).padStart(6)})   v2-only by shape source: ${Object.entries(row.src).map(([k, v]) => `${k} ${v}`).join(", ") || "-"}`);
  console.log(`  ${"".padEnd(18)} v1-only (not in v2): ${row.v1Only} — ${Object.entries(row.by).map(([k, v]) => `${k} ${v}`).join(", ") || "-"}`);
}
console.log(`\nPer set:`);
for (const r of reports) console.log(`  ${r.set.padEnd(8)} pages ${String(r.pages).padStart(4)} tags ${String(r.tags).padStart(3)}  text ${r.textOnly.v1}→${r.textOnly.v2}  ${r.type3.map((t) => `${t.cls} ${t.v1}→${t.v2} (${t.v2r})`).join(" · ")}  families ${r.families3}`);

if (opt("json")) writeFileSync(opt("json")!, JSON.stringify({ seed: SEED, reports, totals: { drops, rejected: rej, type3: t3 } }, null, 2));
if (opt("spot")) {
  const shuffled = [...spots].sort(() => rand() - 0.5);
  const picked: Spot[] = [];
  const perSet = new Map<string, number>();
  for (const sp of shuffled) {
    if ((perSet.get(sp.set) ?? 0) >= 3) continue;
    perSet.set(sp.set, (perSet.get(sp.set) ?? 0) + 1);
    picked.push(sp);
    if (picked.length >= 16) break;
  }
  writeFileSync(opt("spot")!, JSON.stringify({ seed: SEED, candidates: spots.length, picked }, null, 2));
  console.log(`\nSpot sample: ${picked.length} of ${spots.length} v2-only Type 3 hits → ${opt("spot")}`);
}
