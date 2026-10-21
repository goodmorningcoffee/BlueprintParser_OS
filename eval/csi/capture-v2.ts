/**
 * capture-v2.ts — CSI tagger v2, S5: run `detectCsiV2` over the frozen corpus (IMPLEMENTATION §II S5,
 * PLAN §8). The v2 counterpart of `capture.ts`; it MEASURES, it tunes nothing.
 *
 * Joins `corpus.ndjson` (page facts: discipline, drawingNumber, rawText) with `corpus-lines.ndjson`
 * (the Textract LINES with word bboxes, built by extract-corpus-lines.sh) on `bundle:pageNumber`
 * and calls, per page, exactly what S6 wires into processing.ts / reprocess.ts / pages.ts (PLAN §7):
 *
 *   detectCsiV2({ lines, context: { discipline, drawingNumber } }, config, kb)   → build/v2-engine.json
 *   detectCsiV2({ lines }, config, kb)                                           → build/v2-engine-noctx.json
 *
 * Each page row is the baseline shape (`{bundle, page, inputSha, codes}`, see capture.ts) plus:
 *   - `codes`       at the DEFAULT config (τ 0.75, cap 40) — what compare.ts scores;
 *   - `codeDetails` every code emitted at τ = 0 with its `confidence` (sweep-tau.ts re-derives any τ
 *                   from these) and its owned spans as `triggers` WITHOUT drawing text (code, pattern =
 *                   KB phrase, source, score, emitted, scope); `sweep-tau --check=0.75=<this file>`
 *                   proves derived(0.75) == `codes` page by page;
 *   - `checks`      per-page integrity counts that need the KB (PLAN §8): emitted codes vs emitted
 *                   spans, emitted spans whose pattern's diff token is absent from the span range.
 * Header: `engineSha` (sha256 of every v2 source file the result depends on), `kbSha` (sha256 of the
 * KB file + its builderVersion), `corpusSha`, `linesSha`, the call and the config.
 *
 * Client text (span text, bboxes, hints per page) goes ONLY to `<privateDir>/v2-spans[-noctx].ndjson`.
 * The build/ captures carry MasterFormat phrases (KB text, D1: not for GitHub) but no drawing text;
 * build/ is gitignored.
 *
 * Pages with < 10 characters of rawText are skipped (codes []), as the live csi-detect contract does.
 *
 * Build + run (from the repo root; the bundle name must contain `csi-capture-v2`):
 *   npx esbuild eval/csi/capture-v2.ts --bundle --platform=node --target=node20 --alias:@=./src \
 *     --external:pg-native --outfile=build/csi-capture-v2.js
 *   node build/csi-capture-v2.js <corpus.ndjson> <corpus-lines.ndjson> <out.json> <out-noctx.json> <privateDir>
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CSI_KB_FILE, loadCsiKbFromFile } from "@/lib/csi-kb";
import type { LoadedKb } from "@/lib/csi-kb-types";
import { DEFAULT_CSI_V2_PAGE_CONFIG, detectCsiV2, tierOf, unitFromLine, type V2Config, type V2Input, type V2Result } from "@/lib/csi-page";
import type { Context } from "@/lib/csi-span-match";
import type { TextractLine } from "@/types";

/** Files the v2 result depends on (hashed into `engineSha`; the KB is `kbSha`). */
export const V2_ENGINE_FILES = [
  "src/lib/csi-page.ts", "src/lib/csi-span-match.ts", "src/lib/csi-span-own.ts", "src/lib/csi-kb.ts",
  "src/lib/csi-kb-types.ts", "src/lib/csi-tokenize.ts",
];

export interface CorpusRow { bundle: string; pageNumber: number; drawingNumber?: string | null; discipline?: string | null; rawText?: string | null }
export interface LinesRow { bundle: string; pageNumber: number; lines: TextractLine[] }
export interface Joined { row: CorpusRow; lines: TextractLine[] }

/** Trigger record as committed to build/: no drawing text, no geometry. */
export interface DetailTrigger { pattern: string; source?: string; score?: number; emitted: boolean; scope?: string; drop?: string }
export interface CodeDetailV2 { code: string; confidence: number; level: number; tier: number; alternatives?: string[]; triggers: DetailTrigger[] }
export interface PageChecks { emittedCodes: number; emittedSpans: number; childWithoutDiffToken: number; familySpans: number; hints: number; parentBesideDescendantSameRange: number }
export interface CapturePageV2 { bundle: string; page: number; inputSha: string; codes: string[]; codeDetails: CodeDetailV2[]; checks: PageChecks }

const key = (b: string, n: number) => `${b}:${n}`;
const sha256 = (x: string | Buffer) => createHash("sha256").update(x).digest("hex");

export function readNdjson<T>(path: string): T[] {
  return readFileSync(path, "utf-8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as T);
}

/** Corpus ⋈ lines on bundle:pageNumber, in corpus order. Throws on a missing or duplicated key. */
export function joinCorpus(corpus: CorpusRow[], lines: LinesRow[]): Joined[] {
  const by = new Map<string, LinesRow>();
  for (const l of lines) {
    const k = key(l.bundle, l.pageNumber);
    if (by.has(k)) throw new Error(`capture-v2: duplicate lines row ${k}`);
    by.set(k, l);
  }
  const seen = new Set<string>();
  return corpus.map((row) => {
    const k = key(row.bundle, row.pageNumber);
    if (seen.has(k)) throw new Error(`capture-v2: duplicate corpus row ${k}`);
    seen.add(k);
    const l = by.get(k);
    if (!l) throw new Error(`capture-v2: corpus page ${k} has no lines row`);
    return { row, lines: l.lines ?? [] };
  });
}

/** The S6 call's context (PLAN §7): discipline + drawingNumber, absent fields omitted. */
export function contextOf(row: CorpusRow): Context {
  const c: Context = {};
  if (row.discipline) c.discipline = row.discipline;
  if (row.drawingNumber) c.drawingNumber = row.drawingNumber;
  return c;
}

/** The page input: Textract `lines` (the S6 page path, default) or the bare `rawText` (the text-caller
 *  path: annotation notes, group names; its §6.7 gate differs — div 00/01 from ≥ 3-token patterns). */
export function inputOf(j: Joined, withContext: boolean, kind: "lines" | "text" = "lines"): V2Input {
  const input: V2Input = kind === "text" ? { text: j.row.rawText ?? "" } : { lines: j.lines };
  if (withContext) input.context = contextOf(j.row);
  return input;
}

/** `${code}\t${source}\t${text}` → pattern ids (a V2Span names its pattern by text, not id). */
function patternLookup(kb: LoadedKb): Map<string, number[]> {
  const m = new Map<string, number[]>();
  kb.patterns.forEach((p, i) => {
    const k = `${p.code}\t${p.source}\t${p.text}`;
    const l = m.get(k);
    if (l) l.push(i); else m.set(k, [i]);
  });
  return m;
}
const lookupCache = new WeakMap<LoadedKb, Map<string, number[]>>();

/** PLAN §8 per-page checks on one τ=0 result (needs the page lines to re-read span tokens). */
export function pageChecks(res: V2Result, lines: TextractLine[], kb: LoadedKb): PageChecks {
  let look = lookupCache.get(kb);
  if (!look) { look = patternLookup(kb); lookupCache.set(kb, look); }
  const units = new Map<number, string[]>();
  const tokensOf = (li: number) => {
    let t = units.get(li);
    if (!t) { t = unitFromLine(lines[li], kb, li).tokens.map((x) => x.t); units.set(li, t); }
    return t;
  };
  let emittedSpans = 0, childWithoutDiffToken = 0, familySpans = 0;
  for (const s of res.spans) {
    if (!s.emitted) continue;
    emittedSpans++;
    const ids = look.get(`${s.code}\t${s.source}\t${s.pattern}`);
    if (!ids) { familySpans++; continue; } // a family owner: code = ancestor, pattern = a member's
    const kc = kb.byCode.get(s.code);
    if (!kc || kc.parent === null || s.line === undefined || s.tokenStart === undefined || s.tokenEnd === undefined) continue;
    const range = new Set(tokensOf(s.line).slice(s.tokenStart, s.tokenEnd + 1));
    const ok = ids.some((id) => {
      const p = kb.patterns[id];
      return p.kind === "regex" || p.diff.every((d) => range.has(p.tokens[d]));
    });
    if (!ok) childWithoutDiffToken++;
  }
  // §6.5 invariant: a parent is never emitted beside its own descendant on the SAME range (same line,
  // overlapping token ranges). The page-level pair count in compare.ts is a different, looser number.
  const isAnc = (a: string, d: string) => { for (let x = kb.byCode.get(d)?.parent ?? null; x; x = kb.byCode.get(x)?.parent ?? null) if (x === a) return true; return false; };
  const em = res.spans.filter((s) => s.emitted && s.line !== undefined && s.tokenStart !== undefined && s.tokenEnd !== undefined);
  let parentBesideDescendantSameRange = 0;
  for (let i = 0; i < em.length; i++) for (let k = 0; k < em.length; k++) {
    const a = em[i], b = em[k];
    if (i === k || a.line !== b.line || (a.tokenEnd as number) < (b.tokenStart as number) || (b.tokenEnd as number) < (a.tokenStart as number)) continue;
    if (isAnc(a.code, b.code)) parentBesideDescendantSameRange++;
  }
  return { emittedCodes: res.codes.length, emittedSpans, childWithoutDiffToken, familySpans, hints: res.divisionHints.length, parentBesideDescendantSameRange };
}

export interface CaptureOptions { withContext: boolean; config?: Partial<V2Config>; input?: "lines" | "text" }

/** One page: τ=0 details + default-config codes + checks; `res0` (client text) for the private dump. */
export function capturePage(j: Joined, kb: LoadedKb, opts: CaptureOptions): { page: CapturePageV2; res0: V2Result | null } {
  const raw = j.row.rawText ?? "";
  const input = inputOf(j, opts.withContext, opts.input);
  const base = { bundle: j.row.bundle, page: j.row.pageNumber, inputSha: sha256(JSON.stringify([input.lines ?? input.text ?? null, input.context ?? null])) };
  if (raw.length < 10) { // the live contract (csi-detect-legacy.ts: `rawText.length < 10`)
    return { page: { ...base, codes: [], codeDetails: [], checks: { emittedCodes: 0, emittedSpans: 0, childWithoutDiffToken: 0, familySpans: 0, hints: 0, parentBesideDescendantSameRange: 0 } }, res0: null };
  }
  const cfg = { ...DEFAULT_CSI_V2_PAGE_CONFIG, ...opts.config };
  const res = detectCsiV2(input, cfg, kb);
  const res0 = detectCsiV2(input, { ...cfg, tau: 0 }, kb);
  const codeDetails: CodeDetailV2[] = res0.codes.map((c) => {
    const d: CodeDetailV2 = {
      code: c.code, confidence: c.confidence, level: c.level, tier: tierOf(c.confidence),
      triggers: res0.spans.filter((s) => s.code === c.code).map((s) => {
        const t: DetailTrigger = { pattern: s.pattern ?? "", emitted: s.emitted };
        if (s.source) t.source = s.source;
        if (s.score !== undefined) t.score = +s.score.toFixed(4);
        if (s.scope) t.scope = s.scope;
        if (s.drop) t.drop = s.drop;
        return t;
      }),
    };
    if (c.alternatives) d.alternatives = c.alternatives;
    return d;
  });
  return { page: { ...base, codes: res.codes.map((c) => c.code).sort(), codeDetails, checks: pageChecks(res, j.lines, kb) }, res0 };
}

export function capturePages(joined: Joined[], kb: LoadedKb, opts: CaptureOptions): { pages: CapturePageV2[]; res0: (V2Result | null)[] } {
  const pages: CapturePageV2[] = [];
  const res0: (V2Result | null)[] = [];
  for (const j of joined) {
    const r = capturePage(j, kb, opts);
    pages.push(r.page);
    res0.push(r.res0);
  }
  return { pages, res0 };
}

function main(): void {
  const [corpusPath, linesPath, out, outNoctx, privateDir] = process.argv.slice(2);
  if (!corpusPath || !linesPath || !out || !outNoctx || !privateDir) {
    console.error("usage: node csi-capture-v2.js <corpus.ndjson> <corpus-lines.ndjson> <out.json> <out-noctx.json> <privateDir>");
    process.exit(1);
  }
  const root = process.cwd();
  const kbPath = join(root, CSI_KB_FILE);
  if (!existsSync(kbPath)) throw new Error(`capture-v2: ${CSI_KB_FILE} missing — build it (eval/csi/build-kb-v2.ts)`);
  const kbBytes = readFileSync(kbPath);
  const kb = loadCsiKbFromFile(kbPath);
  const joined = joinCorpus(readNdjson<CorpusRow>(corpusPath), readNdjson<LinesRow>(linesPath));
  const engineSha: Record<string, string> = {};
  for (const f of V2_ENGINE_FILES) engineSha[f] = sha256(readFileSync(join(root, f)));
  mkdirSync(privateDir, { recursive: true });
  for (const [withContext, path] of [[true, out], [false, outNoctx]] as const) {
    const t0 = Date.now();
    const { pages, res0 } = capturePages(joined, kb, { withContext });
    const ms = Date.now() - t0;
    const scored = pages.filter((_, i) => res0[i] !== null);
    const codesTotal = scored.reduce((a, p) => a + p.codes.length, 0);
    const artifact = {
      schemaVersion: "csi-baseline-v2/1",
      what: "CSI v2 detectCsiV2 over the full corpus (Textract lines), default config; codeDetails at tau 0.",
      capturedAt: new Date().toISOString(),
      call: withContext ? "detectCsiV2({ lines, context: { discipline, drawingNumber } }, config, kb)" : "detectCsiV2({ lines }, config, kb)",
      config: DEFAULT_CSI_V2_PAGE_CONFIG, detailsTau: 0, withContext,
      engineSha,
      kbSha: { file: CSI_KB_FILE, sha256: sha256(kbBytes), builderVersion: kb.header.builderVersion },
      corpusSha: sha256(readFileSync(corpusPath)), linesSha: sha256(readFileSync(linesPath)),
      summary: { pagesTotal: pages.length, pagesScored: scored.length, codesTotal, meanCodesPerScoredPage: scored.length ? +(codesTotal / scored.length).toFixed(3) : 0, elapsedMs: ms },
      pages,
    };
    writeFileSync(path, JSON.stringify(artifact) + "\n");
    const priv = join(privateDir, `v2-spans${withContext ? "" : "-noctx"}.ndjson`);
    writeFileSync(priv, joined.map((j, i) => JSON.stringify({ bundle: j.row.bundle, page: j.row.pageNumber, result: res0[i] })).join("\n") + "\n");
    console.error(`[capture-v2] ${withContext ? "ctx  " : "noctx"} ${pages.length} pages · ${scored.length} scored · ${codesTotal} codes · ${ms} ms → ${path} (spans → ${priv})`);
  }
}

// Only run as the CLI entry point (bundle name contains csi-capture-v2); tests import the helpers.
if (process.argv[1]?.includes("csi-capture-v2")) main();
