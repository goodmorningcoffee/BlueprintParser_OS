#!/usr/bin/env -S npx tsx
/**
 * knowledge-graph-measure.ts — build the v1 knowledge graph (src/lib/knowledge-graph) over corpus_v2
 * bundles and report size + reference resolution, so the storage choice (S3 object vs jsonb) and
 * the resolution rates in the track report are measured, not guessed.
 *
 *   npx tsx scripts/knowledge-graph-measure.ts [--bundles DIR] [--sets 1,2,3] [--n 8] [--json out.json]
 *     --bundles  directory of bp-export bundles (default /workspaces/projects/gitignore/corpus_v2/data/bundles)
 *     --sets     1-based indexes into the sorted bundle listing ("set N" in reports)
 *     --n        the first N bundles (default 6) when --sets is absent
 *
 * Prints one row per set: pages · nodes · edges · serialized bytes · references total / resolved /
 * unresolved / ambiguous · how many came from each extractor. No OCR text and no project names
 * are printed — sets are referred to by index only.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildKnowledgeGraph,
  graphLinesFromTextract,
  graphWordsFromTextract,
  pageInputFromStored,
  summarizeGraph,
  type GraphPageInput,
} from "@/lib/knowledge-graph";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const bundlesDir = opt("bundles") ?? "/workspaces/projects/gitignore/corpus_v2/data/bundles";
const files = readdirSync(bundlesDir).filter((f) => f.endsWith(".json")).sort();
const picked = opt("sets") ? opt("sets")!.split(",").map((s) => parseInt(s, 10)) : Array.from({ length: parseInt(opt("n") ?? "6", 10) }, (_, i) => i + 1);

interface Row {
  set: number; pages: number; nodes: number; edges: number; bytes: number;
  refs: { total: number; resolved: number; unresolved: number; ambiguous: number; self: number; detailFound: number; detailMissing: number };
  byExtractor: Record<string, number>;
  /** Per extractor: how many of the edges it saw are cross-sheet resolved / self / not resolved. */
  byExtractorStatus: Record<string, { resolved: number; self: number; open: number }>;
  nodeTypes: Record<string, number>;
  edgeTypes: Record<string, number>;
  buildMs: number;
}

const rows: Row[] = [];
for (const set of picked) {
  const file = files[set - 1];
  if (!file) { console.error(`set ${set}: no bundle at that index (${files.length} bundles)`); continue; }
  const bundle = JSON.parse(readFileSync(join(bundlesDir, file), "utf8")) as {
    project: { publicId: string };
    pages: Array<{ pageNumber: number; name?: string | null; drawingNumber: string | null; pageIntelligence: unknown; csiCodes?: unknown; textAnnotations?: unknown; keynotes?: unknown; textractData?: { lines?: Array<{ text: string; bbox: [number, number, number, number] }>; words?: Array<{ text: string; bbox: [number, number, number, number] }> } | null }>;
  };
  const pages: GraphPageInput[] = bundle.pages.map((p) => pageInputFromStored({
    ...p,
    lines: graphLinesFromTextract(p.textractData?.lines ?? null),
    words: graphWordsFromTextract(p.textractData?.words ?? null),
  }));
  const t0 = performance.now();
  const graph = buildKnowledgeGraph({ publicId: bundle.project.publicId, pages }, { now: new Date(0) });
  const buildMs = Math.round(performance.now() - t0);
  const json = JSON.stringify(graph);
  const summary = summarizeGraph(graph, Buffer.byteLength(json));
  const byExtractor: Record<string, number> = {};
  const byExtractorStatus: Row["byExtractorStatus"] = {};
  for (const e of graph.edges) {
    if (e.type !== "references") continue;
    const seen = new Set(e.provenance.map((p) => p.extractor));
    for (const x of seen) {
      byExtractor[x] = (byExtractor[x] ?? 0) + 1;
      const b = (byExtractorStatus[x] ??= { resolved: 0, self: 0, open: 0 });
      if (e.self) b.self++; else if (e.status === "resolved") b.resolved++; else b.open++;
    }
  }
  rows.push({ set, pages: pages.length, nodes: graph.nodes.length, edges: graph.edges.length, bytes: summary.bytes, refs: summary.references, byExtractor, byExtractorStatus, nodeTypes: summary.nodes, edgeTypes: summary.edges, buildMs });
}

const kb = (b: number) => `${(b / 1024).toFixed(0)} KB`;
console.log("set  pages  nodes   edges   bytes     refs  resolved  unresolved  ambiguous  self  detail(found/missing)  ms   extractors");
for (const r of rows) {
  const ex = Object.entries(r.byExtractor).map(([k, v]) => `${k}=${v}`).join(" ");
  console.log(`${String(r.set).padStart(3)}  ${String(r.pages).padStart(5)}  ${String(r.nodes).padStart(5)}  ${String(r.edges).padStart(6)}  ${kb(r.bytes).padStart(8)}  ${String(r.refs.total).padStart(4)}  ${String(r.refs.resolved).padStart(8)}  ${String(r.refs.unresolved).padStart(10)}  ${String(r.refs.ambiguous).padStart(9)}  ${String(r.refs.self).padStart(4)}  ${String(`${r.refs.detailFound}/${r.refs.detailMissing}`).padStart(21)}  ${String(r.buildMs).padStart(3)}  ${ex}`);
}
const total = rows.reduce((a, r) => ({ total: a.total + r.refs.total, resolved: a.resolved + r.refs.resolved, unresolved: a.unresolved + r.refs.unresolved, ambiguous: a.ambiguous + r.refs.ambiguous, self: a.self + r.refs.self }), { total: 0, resolved: 0, unresolved: 0, ambiguous: 0, self: 0 });
const pct = (n: number) => (total.total ? `${((100 * n) / total.total).toFixed(1)}%` : "n/a");
console.log(`\n${rows.length} sets · references ${total.total}: cross-sheet resolved ${total.resolved} (${pct(total.resolved)}) · unresolved ${total.unresolved} (${pct(total.unresolved)}) · ambiguous ${total.ambiguous} (${pct(total.ambiguous)}) · self ${total.self} (${pct(total.self)})`);
const exTotals: Row["byExtractorStatus"] = {};
for (const r of rows) for (const [k, v] of Object.entries(r.byExtractorStatus)) { const t = (exTotals[k] ??= { resolved: 0, self: 0, open: 0 }); t.resolved += v.resolved; t.self += v.self; t.open += v.open; }
console.log(`by extractor (edges it saw: resolved/self/open): ${Object.entries(exTotals).map(([k, v]) => `${k}=${v.resolved}/${v.self}/${v.open}`).join(" ")}`);
console.log(`bytes: max ${kb(Math.max(0, ...rows.map((r) => r.bytes)))} · median ${kb([...rows.map((r) => r.bytes)].sort((a, b) => a - b)[Math.floor(rows.length / 2)] ?? 0)}`);
const nodeTotals: Record<string, number> = {};
for (const r of rows) for (const [k, v] of Object.entries(r.nodeTypes)) nodeTotals[k] = (nodeTotals[k] ?? 0) + v;
console.log(`nodes by type: ${Object.entries(nodeTotals).map(([k, v]) => `${k}=${v}`).join(" ")}`);
const edgeTotals: Record<string, number> = {};
for (const r of rows) for (const [k, v] of Object.entries(r.edgeTypes)) edgeTotals[k] = (edgeTotals[k] ?? 0) + v;
console.log(`edges by type: ${Object.entries(edgeTotals).map(([k, v]) => `${k}=${v}`).join(" ")}`);
const out = opt("json");
if (out) writeFileSync(out, JSON.stringify({ bundlesDir, rows, total }, null, 2));
