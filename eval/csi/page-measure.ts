/**
 * page-measure.ts — CSI tagger v2, S4 measurement harness for the page rules
 * (`src/lib/csi-page.ts` `detectCsiV2`) over the frozen corpus. MEASURES; tunes nothing.
 *
 * Contains NO drawing text. Every path comes from argv; client text read from the corpus is written
 * ONLY to the `--priv` directory (per-page records), never to stdout or `--out`.
 *
 *   npx esbuild eval/csi/page-measure.ts --bundle --platform=node --target=node20 \
 *     --alias:@=./src --external:pg-native --outfile=build/csi-page-measure.js
 *   node build/csi-page-measure.js src/data/csi-kb.json --corpus <corpus.ndjson> \
 *     [--priv <private dir>] [--out <aggregates.txt>] [--ts <timestamp for file names>]
 *
 * The run is guarded on the bundle name (`csi-page-measure`), like the other eval scripts, so an
 * import of this file does nothing.
 *
 * Modes (each with and without the corpus page discipline as `context.discipline`):
 *   text   — `{ text: rawText }`: the bare-text caller (units by the tokenizer's splitter; div 00/01
 *            allowed from ≥ 3-token patterns).
 *   lines  — `{ lines }` rebuilt from rawText's NEWLINES (one TextractLine per rawText line, words by
 *            whitespace) with SYNTHETIC geometry. The corpus `words[]` (Textract) cannot be re-attached
 *            to rawText lines: rawText's whitespace tokens equal the words sequence on only 24/471
 *            pages, and even the order-free MULTISET overlap has median 0.867 (p10 0.655) — the two
 *            are different text sources, not a reordering (measured 2026-10-21, S4). This mode
 *            measures the GEOMETRY-CALLER GATES on rawText's own line units; it says nothing about bboxes.
 *   words  — `{ lines }` rebuilt GEOMETRICALLY from the corpus Textract `words[]` with their REAL bboxes
 *            (`linesFromWords`: rows by vertical centre, split at horizontal gaps). Not Textract's own
 *            line segmentation (that needs `corpus-lines.ndjson`, S5), but every trigger bbox is a real
 *            word box, so this mode checks the output contract (zCsiCode, triggers present) at scale.
 *
 * Prints per mode: codes/page (mean, median, p90, min, max; PLAN band 5–12; old engine 42.4), share of
 * pages at the cap / in the band / empty, owned vs emitted spans, span drops by reason, code drops by
 * reason, tier mix, hints/page, top divisions and codes (codes are MasterFormat numbers, not drawing
 * text), and per-page time.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadCsiKbFromFile } from "@/lib/csi-kb";
import type { LoadedKb } from "@/lib/csi-kb-types";
import type { BboxLTWH, TextractLine } from "@/types";
import { zCsiCode } from "@/types/shapes/csi";
import { DEFAULT_CSI_V2_PAGE_CONFIG, detectCsiV2, type V2Input, type V2Result } from "@/lib/csi-page";

interface CorpusWord { text?: string; bbox?: number[] }
interface CorpusPage {
  bundle: string; pageNumber: number; drawingNumber?: string | null; discipline?: string | null; rawText?: string | null;
  words?: CorpusWord[] | null;
}
type Mode = "text" | "lines" | "words";

/** A word joins a row when its vertical centre is within this share of the taller height. */
const ROW_CENTRE_TOL = 0.5;
/** Inside a row, a horizontal gap wider than this × the row's median word height starts a new line. */
const LINE_GAP_FACTOR = 1.2;

/** Textract words → geometric lines (eval-only heuristic; see the header). Deterministic. */
export function linesFromWords(words: CorpusWord[]): TextractLine[] {
  const ok: { text: string; bbox: BboxLTWH; yc: number; h: number }[] = [];
  for (const w of words) {
    const b = w.bbox;
    if (typeof w.text !== "string" || w.text.trim() === "" || !Array.isArray(b) || b.length !== 4 || !b.every((v) => Number.isFinite(v))) continue;
    const bbox: BboxLTWH = [b[0], b[1], b[2], b[3]];
    ok.push({ text: w.text.trim(), bbox, yc: b[1] + b[3] / 2, h: Math.max(b[3], 1e-4) });
  }
  ok.sort((a, b) => a.yc - b.yc || a.bbox[0] - b.bbox[0]);
  const rows: (typeof ok)[] = [];
  let cur: typeof ok = [];
  let curYc = 0, curH = 0;
  for (const w of ok) {
    if (cur.length && Math.abs(w.yc - curYc) <= ROW_CENTRE_TOL * Math.max(w.h, curH)) {
      cur.push(w);
      curYc = (curYc * (cur.length - 1) + w.yc) / cur.length;
      curH = Math.max(curH, w.h);
    } else {
      if (cur.length) rows.push(cur);
      cur = [w]; curYc = w.yc; curH = w.h;
    }
  }
  if (cur.length) rows.push(cur);
  const out: TextractLine[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.bbox[0] - b.bbox[0] || a.yc - b.yc);
    const hs = row.map((w) => w.h).sort((a, b) => a - b);
    const gapMax = LINE_GAP_FACTOR * hs[Math.floor(hs.length / 2)];
    let seg: typeof ok = [];
    const flush = () => {
      if (!seg.length) return;
      const bbox = seg.reduce<BboxLTWH>((u, w) => {
        const l = Math.min(u[0], w.bbox[0]), t = Math.min(u[1], w.bbox[1]);
        return [l, t, Math.max(u[0] + u[2], w.bbox[0] + w.bbox[2]) - l, Math.max(u[1] + u[3], w.bbox[1] + w.bbox[3]) - t];
      }, seg[0].bbox);
      out.push({ text: seg.map((w) => w.text).join(" "), confidence: 99, bbox, words: seg.map((w) => ({ text: w.text, confidence: 99, bbox: w.bbox })) });
      seg = [];
    };
    for (const w of row) {
      const prev = seg[seg.length - 1];
      if (prev && w.bbox[0] - (prev.bbox[0] + prev.bbox[2]) > gapMax) flush();
      seg.push(w);
    }
    flush();
  }
  return out;
}

/** rawText line → a TextractLine with synthetic, non-overlapping geometry (see the header). */
export function syntheticLines(rawText: string): TextractLine[] {
  const out: TextractLine[] = [];
  const rows = rawText.split("\n");
  rows.forEach((text, r) => {
    const ws = text.split(/\s+/).filter((w) => w !== "");
    if (!ws.length) return;
    const y = (r + 0.5) / (rows.length + 1);
    const box = (i: number): BboxLTWH => [0.001 + 0.002 * i, y, 0.0015, 0.0005];
    out.push({ text: ws.join(" "), confidence: 99, bbox: [0.001, y, 0.002 * ws.length, 0.0005], words: ws.map((w, i) => ({ text: w, confidence: 99, bbox: box(i) })) });
  });
  return out;
}

const pct = (xs: number[], q: number): number => {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
};
const inc = (m: Map<string, number>, k: string, by = 1) => m.set(k, (m.get(k) ?? 0) + by);
const top = (m: Map<string, number>, n: number) => [...m].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, n).map(([k, v]) => `${k}×${v}`).join(" ");
const f = (x: number, d = 2) => x.toFixed(d);

function inputOf(p: CorpusPage, mode: Mode, withCtx: boolean): V2Input {
  const raw = p.rawText ?? "";
  const inp: V2Input = mode === "text" ? { text: raw } : mode === "lines" ? { lines: syntheticLines(raw) } : { lines: linesFromWords(p.words ?? []) };
  if (withCtx && p.discipline) inp.context = { discipline: p.discipline };
  return inp;
}

interface Agg {
  label: string; perPage: number[]; ms: number[]; cap: number; empty: number; band: number;
  owned: number; emittedSpans: number; spanDrop: Map<string, number>; codeDrop: Map<string, number>;
  tiers: Map<string, number>; hints: number[]; div: Map<string, number>; code: Map<string, number>; source: Map<string, number>;
  family: number; zFail: number; noTrig: number; unitLines: number[];
}
const newAgg = (label: string): Agg => ({
  label, perPage: [], ms: [], cap: 0, empty: 0, band: 0, owned: 0, emittedSpans: 0, spanDrop: new Map(), codeDrop: new Map(),
  tiers: new Map(), hints: [], div: new Map(), code: new Map(), source: new Map(), family: 0, zFail: 0, noTrig: 0, unitLines: [],
});

function addPage(a: Agg, r: V2Result, ms: number, cap: number): void {
  const n = r.codes.length;
  a.perPage.push(n);
  a.ms.push(ms);
  if (n >= cap) a.cap++;
  if (n === 0) a.empty++;
  if (n >= 5 && n <= 12) a.band++;
  a.owned += r.spans.length;
  const emittedCodes = new Set(r.codes.map((c) => c.code));
  const codeReason = new Map<string, string>();
  for (const s of r.spans) {
    if (s.emitted) { a.emittedSpans++; inc(a.source, s.source ?? "?"); continue; }
    inc(a.spanDrop, s.drop ?? "?");
    // a code's drop reason = the reason on its spans when no span of it was emitted (first seen wins)
    if (!emittedCodes.has(s.code) && !codeReason.has(s.code)) codeReason.set(s.code, s.drop ?? "?");
  }
  for (const reason of codeReason.values()) inc(a.codeDrop, reason);
  for (const c of r.codes) {
    inc(a.tiers, String(c.confidence >= 0.8 - 1e-9 ? 1 : c.confidence >= 0.6 - 1e-9 ? 2 : 3));
    inc(a.div, c.division.slice(0, 2));
    inc(a.code, c.code);
    if (c.alternatives) a.family++;
    if (!zCsiCode.safeParse(c).success) a.zFail++;
    if (!c.triggers || !c.triggers.length) a.noTrig++;
  }
  a.hints.push(r.divisionHints.length);
}

function report(a: Agg, say: (s: string) => void): void {
  const N = a.perPage.length;
  const sum = a.perPage.reduce((x, y) => x + y, 0);
  const hs = a.hints.reduce((x, y) => x + y, 0);
  say(`── ${a.label}`);
  say(`  pages ${N} · codes/page mean ${f(sum / N)} · median ${pct(a.perPage, 0.5)} · p90 ${pct(a.perPage, 0.9)} · min ${Math.min(...a.perPage)} · max ${Math.max(...a.perPage)}  (PLAN band 5–12; old engine 42.4)`);
  say(`  pages in band 5–12 ${a.band} (${f((100 * a.band) / N, 1)} %) · at cap ${a.cap} (${f((100 * a.cap) / N, 1)} %) · empty ${a.empty} (${f((100 * a.empty) / N, 1)} %) · total codes ${sum}`);
  say(`  owned spans ${a.owned} · emitted spans ${a.emittedSpans} (${f((100 * a.emittedSpans) / Math.max(1, a.owned), 1)} %) · emitted by source ${top(a.source, 10)}`);
  say(`  span drops by reason: ${top(a.spanDrop, 10) || "none"}`);
  say(`  code drops by reason (codes with owned spans, none emitted; per page, summed): ${top(a.codeDrop, 10) || "none"}`);
  say(`  emitted tiers ${top(a.tiers, 3)} · family-owner codes ${a.family} · hints/page mean ${f(hs / N)} (total ${hs})`);
  say(`  emitted by division: ${top(a.div, 30)}`);
  say(`  top codes: ${top(a.code, 20)}`);
  if (a.unitLines.length) say(`  line units/page mean ${f(a.unitLines.reduce((x, y) => x + y, 0) / N, 1)} · median ${pct(a.unitLines, 0.5)}`);
  say(`  output contract: emitted codes failing zCsiCode ${a.zFail} · emitted codes without triggers ${a.noTrig}${a.label.startsWith("text") ? " (bare text → triggers undefined by design)" : ""}`);
  say(`  ms/page p50 ${f(pct(a.ms, 0.5), 1)} · p90 ${f(pct(a.ms, 0.9), 1)} · max ${f(Math.max(...a.ms), 1)}`);
}

export function main(argv: string[]): void {
  const kbPath = argv[0];
  const opt = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const corpusPath = opt("--corpus"), privDir = opt("--priv"), outPath = opt("--out"), ts = opt("--ts") ?? "run";
  if (!kbPath || !corpusPath) { console.error("usage: csi-page-measure.js <kb.json> --corpus <corpus.ndjson> [--priv dir] [--out f] [--ts stamp]"); process.exit(2); }
  const kb: LoadedKb = loadCsiKbFromFile(kbPath);
  const lines: string[] = [];
  const say = (s: string) => { lines.push(s); console.log(s); };
  const corpusRaw = readFileSync(corpusPath);
  const pages: CorpusPage[] = corpusRaw.toString("utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as CorpusPage);
  const distinct = new Set(pages.map((p) => createHash("sha256").update(p.rawText ?? "").digest("hex"))).size;
  const cap = DEFAULT_CSI_V2_PAGE_CONFIG.maxCodesPerPage;
  say(`# S4 page-measure ${ts} — detectCsiV2 (csi-page.ts) at DEFAULT config tau ${DEFAULT_CSI_V2_PAGE_CONFIG.tau}, maxCodesPerPage ${cap}`);
  say(`# kb ${kb.header.builderVersion} sha256 ${createHash("sha256").update(readFileSync(kbPath)).digest("hex").slice(0, 16)}… · corpus sha256 ${createHash("sha256").update(corpusRaw).digest("hex").slice(0, 16)}… · pages ${pages.length} (distinct rawText ${distinct}) · aggregates over ALL pages`);
  say(`# lines mode = rawText newline lines with SYNTHETIC geometry (corpus words cannot be re-attached; real bboxes need corpus-lines, S5)`);
  say(`# words mode = lines rebuilt geometrically from the corpus Textract words (REAL word bboxes; row tol ${ROW_CENTRE_TOL}, gap ${LINE_GAP_FACTOR}×height; not Textract's own line segmentation)`);
  const priv: string[] = [];
  const disc = new Map<string, number>();
  for (const p of pages) inc(disc, p.discipline ?? "none");
  say(`# page disciplines: ${top(disc, 20)}`);
  for (const mode of ["text", "lines", "words"] as Mode[]) {
    for (const withCtx of [false, true]) {
      const a = newAgg(`${mode} ${withCtx ? "with page discipline as context" : "no context"}`);
      for (const p of pages) {
        const inp = inputOf(p, mode, withCtx);
        const t0 = process.hrtime.bigint();
        const r = detectCsiV2(inp, {}, kb);
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        addPage(a, r, ms, cap);
        if (inp.lines) a.unitLines.push(inp.lines.length);
        if (privDir) {
          priv.push(JSON.stringify({
            bundle: p.bundle, pageNumber: p.pageNumber, drawingNumber: p.drawingNumber ?? null, discipline: p.discipline ?? null, mode, ctx: withCtx,
            codes: r.codes.map((c) => ({ code: c.code, conf: +c.confidence.toFixed(4), level: c.level, alternatives: c.alternatives })),
            spans: r.spans.map((s) => ({ code: s.code, text: s.text, score: s.score === undefined ? null : +s.score.toFixed(4), source: s.source, line: s.line, emitted: s.emitted, drop: s.drop, scope: s.scope })),
            divisionHints: r.divisionHints,
          }));
        }
      }
      report(a, say);
    }
  }
  if (privDir) {
    mkdirSync(privDir, { recursive: true });
    const pf = join(privDir, `s4-${ts}-page-measure-pages.ndjson`);
    writeFileSync(pf, priv.join("\n") + "\n");
    say(`# per-page records (client text) → ${pf} (${priv.length} records)`);
  }
  if (outPath) writeFileSync(outPath, lines.join("\n") + "\n");
}

if (typeof process !== "undefined" && /csi-page-measure/.test(process.argv[1] ?? "")) main(process.argv.slice(2));
