#!/usr/bin/env -S npx tsx
/**
 * cross-set-links-measure.ts — run the v2 cross-set linker (src/lib/knowledge-graph/cross-set.ts) over
 * the corpus_v2 bp-export bundles, treating EVERY set as one company, and report what it links.
 *
 *   npx tsx scripts/cross-set-links-measure.ts [--bundles DIR] [--n N] [--sets 1,2,3] [--min 0.5] [--sample 10] [--seed 7] [--titles] [--json out.json]
 *     --bundles  directory of bp-export bundles (default /workspaces/projects/gitignore/corpus_v2/data/bundles)
 *     --n        the first N bundles in sorted order (default: all)
 *     --sets     1-based indexes into the sorted bundle listing ("set N" in reports)
 *     --min      revision_of content floor (default REVISION_MIN_CONTENT)
 *     --sample   how many revision_of pairs to print for judgement (default 10)
 *     --titles   print the title line of each sampled page (OFF by default: a title line can carry a
 *                client's project name — keep titled output out of any tracked log)
 *
 * Bundles carry no createdAt: the sorted listing index stands in (set 1 oldest), so "direction" here
 * is a stand-in, not a measurement. Each bundle is read, reduced to keys + shingles and dropped before
 * the next one is read (the service's memory shape). Prints counts of twin / revision / copy links, the
 * revision score histogram over every same-number cross-set pair (what the floor cuts), and a sample of
 * revision_of pairs as "set N pM (sheet) · title". In the bundles pages.name IS the drawing number, so
 * the title shown is the first OCR line that reads like a sheet title (≥ 2 alphabetic words, not a
 * sheet number, ≤ 40 chars) — one short line per page, never the body text, never a project name.
 * Also prints the near misses just under the floor, so the floor is judged against what it excludes.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  computeCrossSetLinks,
  reduceCrossSetProject,
  REVISION_MIN_CONTENT,
  type CrossSetProjectKeys,
} from "@/lib/knowledge-graph";
import { jaccard, jaccardUpperBound } from "@/lib/page-dedup/similarity";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const bundlesDir = opt("bundles") ?? "/workspaces/projects/gitignore/corpus_v2/data/bundles";
const files = readdirSync(bundlesDir).filter((f) => f.endsWith(".json")).sort();
const picked = opt("sets")
  ? opt("sets")!.split(",").map((s) => parseInt(s, 10))
  : Array.from({ length: Math.min(files.length, parseInt(opt("n") ?? String(files.length), 10)) }, (_, i) => i + 1);
const revisionMin = opt("min") ? parseFloat(opt("min")!) : REVISION_MIN_CONTENT;
const sampleN = parseInt(opt("sample") ?? "10", 10);
const seed = parseInt(opt("seed") ?? "7", 10);
const showTitles = args.includes("--titles");

interface Bundle {
  project: { publicId: string };
  pages: Array<{ pageNumber: number; name?: string | null; drawingNumber: string | null; rawText?: string | null; pageIntelligence?: { duplicateOf?: { hiddenAt?: string } } | null }>;
}

const setOf = new Map<string, number>();
const titles = new Map<string, string>(); // `${publicId}:${page}` → first title-like OCR line
const RE_SHEETISH = /^[A-Z]{1,3}[\s\-_]?\d{1,4}(\.\d{1,2})?$/;
function titleLine(rawText: string | null | undefined): string | null {
  if (!rawText) return null;
  for (const raw of rawText.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length < 6 || line.length > 40 || RE_SHEETISH.test(line.toUpperCase())) continue;
    const words = line.split(/\s+/).filter((w) => /^[A-Za-z][A-Za-z\-\/&]*$/.test(w));
    if (words.length >= 2 && words.length === line.split(/\s+/).length) return line.toUpperCase();
  }
  return null;
}
const keys: CrossSetProjectKeys[] = [];
let pagesRead = 0;
const t0 = performance.now();
for (const set of picked) {
  const file = files[set - 1];
  if (!file) { console.error(`set ${set}: no bundle at that index (${files.length} bundles)`); continue; }
  const bundle = JSON.parse(readFileSync(join(bundlesDir, file), "utf8")) as Bundle;
  const publicId = bundle.project.publicId;
  setOf.set(publicId, set);
  for (const p of bundle.pages) { const t = titleLine(p.rawText); if (t) titles.set(`${publicId}:${p.pageNumber}`, t); }
  pagesRead += bundle.pages.length;
  keys.push(reduceCrossSetProject({
    publicId,
    // stand-in age: listing order
    createdAt: new Date(Date.UTC(2020, 0, 1) + set * 86_400_000),
    pages: bundle.pages.map((p) => ({ pageNumber: p.pageNumber, drawingNumber: p.drawingNumber, title: p.name ?? null, rawText: p.rawText ?? null, hidden: Boolean(p.pageIntelligence?.duplicateOf?.hiddenAt) })),
  }));
}
const readMs = Math.round(performance.now() - t0);

const t1 = performance.now();
const result = computeCrossSetLinks(keys, { now: new Date(0), revisionMin });
const computeMs = Math.round(performance.now() - t1);

// Score histogram over EVERY same-number cross-set pair (not just those over the floor), so the floor
// is placed by a measurement, not a guess. Same O(Σ bucket²) walk as the linker, scores only.
const hist = new Array<number>(10).fill(0);
let sameNumberPairs = 0;
let identicalPairs = 0;
type Scored = { score: number; from: { project: string; page: number; sheet: string | null }; to: { project: string; page: number; sheet: string | null } };
const nearMisses: Scored[] = [];
{
  const bySheet = new Map<string, Array<{ pi: number; textKey: string; content: Uint32Array }>>();
  const ends = new Map<string, { project: string; page: number; sheet: string | null }>();
  keys.forEach((p, pi) => { for (const pg of p.pages) if (pg.sheetKey) { (bySheet.get(pg.sheetKey) ?? bySheet.set(pg.sheetKey, []).get(pg.sheetKey)!).push({ pi, textKey: pg.textKey, content: pg.content }); ends.set(`${pi}:${pg.textKey}:${pg.content.length}`, { project: p.publicId, page: pg.pageNumber, sheet: pg.drawingNumber }); } });
  for (const slots of bySheet.values()) {
    if (slots.length > 200) continue;
    for (let i = 0; i < slots.length; i++) for (let j = i + 1; j < slots.length; j++) {
      if (slots[i].pi === slots[j].pi) continue;
      sameNumberPairs++;
      if (slots[i].textKey === slots[j].textKey) { identicalPairs++; continue; }
      const s = jaccardUpperBound(slots[i].content.length, slots[j].content.length) < 0.1 ? 0 : jaccard(slots[i].content, slots[j].content);
      hist[Math.min(9, Math.floor(s * 10))]++;
      if (s >= revisionMin - 0.2 && s < revisionMin) {
        const a = ends.get(`${slots[i].pi}:${slots[i].textKey}:${slots[i].content.length}`)!;
        const b = ends.get(`${slots[j].pi}:${slots[j].textKey}:${slots[j].content.length}`)!;
        nearMisses.push({ score: s, from: a, to: b });
      }
    }
  }
}

const twins = result.links.filter((l) => l.kind === "twin_of");
const revisions = result.links.filter((l) => l.kind === "revision_of");
const label = (e: { project: string; page: number; sheet: string | null }) =>
  `set ${setOf.get(e.project)} p${e.page} (${e.sheet ?? "—"})${showTitles ? ` · ${(titles.get(`${e.project}:${e.page}`) ?? "—").slice(0, 48)}` : ""}`;

console.log(`${keys.length} sets · ${pagesRead} pages read · ${result.pages} comparable (visible, non-blank) · read ${readMs} ms · compute ${computeMs} ms`);
console.log(`links: twin_of ${twins.length} · revision_of ${revisions.length} (floor ${revisionMin}) · copy_of ${result.projectLinks.length}`);
console.log(`dropped: stock texts ${result.dropped.stockTexts} · stock sheets ${result.dropped.stockSheets} · oversized buckets ${result.dropped.oversizedBuckets} · truncated buckets ${result.dropped.truncatedBuckets} · comparisons ${result.dropped.comparisons}`);
const projectPairs = new Set(result.links.map((l) => `${l.from.project}|${l.to.project}`));
console.log(`set pairs with ≥1 page link: ${projectPairs.size} · sets with any link: ${new Set(result.links.flatMap((l) => [l.from.project, l.to.project])).size}`);
console.log(`same-number cross-set pairs: ${sameNumberPairs} · identical text ${identicalPairs} · content-score histogram (0.0–0.1 … 0.9–1.0): ${hist.join(" ")}`);
const titleMatched = revisions.filter((l) => l.titleMatch).length;
console.log(`revision_of with matching title: ${titleMatched}/${revisions.length}`);
for (const p of result.projectLinks) console.log(`copy_of: set ${setOf.get(p.from)} is a copy of set ${setOf.get(p.to)} (${p.shared}/${p.pages} pages)`);

// deterministic sample (LCG) of revision_of pairs, spread across the score range
let x = seed >>> 0;
const rnd = () => (x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const pool = [...revisions];
const sample: typeof revisions = [];
while (sample.length < sampleN && pool.length) sample.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
sample.sort((a, b) => b.confidence - a.confidence);
console.log(`\nsample of ${sample.length} revision_of pairs (judge each: plausible / implausible):`);
for (const l of sample) console.log(`  ${l.confidence.toFixed(3)}${l.titleMatch ? " T" : "  "}  ${label(l.from)}  →  ${label(l.to)}`);

const pairCounts = new Map<string, { twins: number; revisions: number }>();
for (const l of result.links) { const k = `set ${setOf.get(l.from.project)} → set ${setOf.get(l.to.project)}`; const c = pairCounts.get(k) ?? { twins: 0, revisions: 0 }; if (l.kind === "twin_of") c.twins++; else c.revisions++; pairCounts.set(k, c); }
console.log(`\nlinked set pairs (twins / revisions): ${[...pairCounts.entries()].map(([k, c]) => `${k}: ${c.twins}/${c.revisions}`).join(" · ")}`);
nearMisses.sort((a, b) => b.score - a.score);
console.log(`\nnear misses just under the floor (${revisionMin - 0.2} ≤ score < ${revisionMin}), top ${sampleN} of ${nearMisses.length}:`);
for (const m of nearMisses.slice(0, sampleN)) console.log(`  ${m.score.toFixed(3)}    ${label(m.from)}  →  ${label(m.to)}`);

const out = opt("json");
if (out) {
  writeFileSync(out, JSON.stringify({
    bundlesDir, sets: keys.length, pagesRead, comparable: result.pages, revisionMin, readMs, computeMs,
    counts: { twin: twins.length, revision: revisions.length, copy: result.projectLinks.length, setPairs: projectPairs.size },
    dropped: result.dropped, sameNumberPairs, identicalPairs, hist, titleMatched,
    sample: sample.map((l) => ({ confidence: l.confidence, titleMatch: Boolean(l.titleMatch), from: label(l.from), to: label(l.to) })),
  }, null, 2));
}
