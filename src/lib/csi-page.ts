/**
 * csi-page.ts — CSI tagger v2, S4: page rules over the S3 span matcher (no LLM at runtime).
 *
 * A PAGE (Textract lines, table cells, or bare text) in; emitted MasterFormat codes, every owned
 * span as a trigger record, and division hints out.
 * Spec: PLAN §6.1 (units), §6.7 (gates), §6.8 (confidence / emission / output), §12 (constants);
 * IMPLEMENTATION §I (pinned `V2Config` / `V2Trigger` / `V2Code` / `V2Result` / `V2Input` /
 * `detectCsiV2`), §II S4, §IV E1, E9, E11. The matcher (`csi-span-match.ts`, `csi-span-own.ts`)
 * decides spans and ownership; NOTHING here re-decides a span.
 *
 * Client-safe: type-only imports of the KB and shared types, no fs, no runtime import of
 * `@/lib/csi-kb` — callers pass the `LoadedKb`.
 *
 * Pipeline:
 *   1 units (§6.1): `lines` (non-empty) → one unit per TextractLine (`unitFromLine`: every token
 *     carries the bbox of the Textract word it came from, E1); else `cells` (non-empty) → one unit
 *     per cell, title + header + text joined with no internal boundary (E9 / `unitFromCell`), never
 *     joined across cells; else `text` → the tokenizer's unit splitter. No continuation merge.
 *   2 spans: `matchUnit` per unit with `input.context`; its division hints are kept.
 *   3 gates (§6.7), per span unless noted:
 *       by_others (§6.6)              → excluded from codes, kept as an `emitted:false` record;
 *       division 00/01, lines/cells   → hint only (`project_geometry`), its division joins the hints;
 *       division 00/01, text          → allowed only from a pattern of ≥ 3 tokens (`project_short`);
 *       divisions 33–35, 40–48 (CODE) → emit only with ≥ 2 distinct ranges owned by the code itself
 *                                       (not a family owner) from CODE-UNIQUE patterns (the pattern's
 *                                       token set — or regex — belongs to no other code), or
 *                                       `context.discipline === 'C'` (`facility`).
 *   4 confidence (§6.8): conf = clamp(best s × (0.85 + 0.03·min(distinct ranges, 5)), 0, 1) over the
 *     code's surviving spans. A range is distinct per (line, tokenStart, tokenEnd) for lines, per
 *     (unit, tokenStart, tokenEnd) for text, and per (table title, header) for cells with a header
 *     (E9: "repetition for cells counts once per (table, column)"; a header-less cell is its own).
 *   5 emission: conf ≥ τ AND best owned s ≥ 0.8 (a family owner's s already carries × 0.9, E11).
 *     Sort conf desc, then deeper level, then code; cap `maxCodesPerPage`. Every span not on an
 *     emitted code stays in `spans` with `emitted:false` and a `drop` reason.
 *   6 output: `V2Code` rows (KB title as description, E8) with `ancestors` nearest-first and
 *     `alternatives` = the family members a family owner stood for. `triggers` carry geometry
 *     (zCsiCode requires a bbox), so a caller without geometry (bare text, cells without bbox)
 *     gets `triggers: undefined` and reads the spans on the result (IMPLEMENTATION §I).
 *
 * Decided here (S4), each measured or spec-letter, none a runtime knob:
 *   - J15: a cell's `title` stays a unit PART (E9 letter: title, header, text), not context only.
 *     Known cost (S3 measurement): {DOOR SCHEDULE / MATERIAL / HM} → 08 06 10 Door Schedule. S5 item.
 *   - The facility gate adds NO division hint (§6.7 says hint-only for 00/01 only); 00/01 gated
 *     spans add `NN 00 00` to `divisionHints`.
 *
 * ⚠ Two documented extensions of the §I letter (both additive):
 *   - `V2Result.spans` is `V2Span[]` — a `V2Trigger` with `bbox` OPTIONAL plus `code` and `drop`.
 *     §I types it `V2Trigger[]`, whose bbox is required, which a bare-text caller cannot satisfy;
 *     and a span record without its code cannot be read. Every `V2Trigger` is a `V2Span`.
 *   - `tier` on a trigger is the tier of its CODE's confidence (§6.8 defines tier from conf).
 */

import type { BboxLTWH, CsiCode, CsiCodeTrigger, TextractLine } from "@/types";
import type { KbSource, LoadedKb } from "@/lib/csi-kb-types";
import {
  matchUnit, unitFromCell, unitFromText, unitFromWords, unitsFromText, type Context, type Span, type Unit,
} from "@/lib/csi-span-match";
import { EPS, ancestorsIdx, prepareKb, type Prepared } from "@/lib/csi-span-own";

export type { Context } from "@/lib/csi-span-match";

// ── constants (PLAN §12 tags) ────────────────────────────────────────────────
/** IMPLEMENTATION §I: DEFAULT { tau: 0.75 (guess → swept in S5), maxCodesPerPage: 40 (legacy) }. */
export const DEFAULT_CSI_V2_PAGE_CONFIG: Readonly<V2Config> = { tau: 0.75, maxCodesPerPage: 40 };
/** §12 guess, tied to coverage: the owning span must have s ≥ 0.8 to emit (§6.8). */
export const STRONG_SPAN_MIN = 0.8;
/** §12 guess: repetition = 0.85 + 0.03·min(n, 5). */
export const REPETITION_BASE = 0.85;
export const REPETITION_STEP = 0.03;
export const REPETITION_CAP = 5;
/** §6.7: a text caller may emit division 00/01 only from a pattern of at least this many tokens. */
export const PROJECT_TEXT_MIN_TOKENS = 3;
/** §12 measured (225 + 150 spans): divisions 33–35 / 40–48 need this many code-unique ranges. */
export const FACILITY_MIN_UNIQUE_RANGES = 2;
/** §I: tier 1 at conf ≥ 0.8, tier 2 at ≥ 0.6, else 3. */
export const TIER1_MIN = 0.8;
export const TIER2_MIN = 0.6;
/** Sort-key resolution for confidence (§6.8 "sort by conf desc"): 1e-9, the matcher's EPS. */
const CONF_GRID = 1e9;

// ── types (IMPLEMENTATION §I; src/types/index.ts is hash-pinned, so they live here) ──
export interface V2Config { tau: number; maxCodesPerPage: number; }

export interface V2Trigger extends CsiCodeTrigger {
  bboxes?: BboxLTWH[]; line?: number; tokenStart?: number; tokenEnd?: number;
  pattern?: string; source?: KbSource; score?: number; scope?: 'by_others' | 'legend'; emitted: boolean;
}

/** Why a span did not reach an emitted code (absent on emitted spans). */
export type V2DropReason =
  | 'by_others' | 'project_geometry' | 'project_short' | 'facility' | 'weak' | 'below_tau' | 'cap';

/** One owned span on the page (see the header: `bbox` optional, plus `code` and `drop`). */
export type V2Span = Omit<V2Trigger, 'bbox'> & { bbox?: BboxLTWH; code: string; drop?: V2DropReason };

export interface V2Code extends CsiCode {
  confidence: number; level: number; ancestors: string[]; triggers?: V2Trigger[]; alternatives?: string[];
}
export interface V2Result { codes: V2Code[]; spans: V2Span[]; divisionHints: string[]; }

export interface V2Cell { text: string; header?: string; title?: string; bbox?: BboxLTWH; }
export interface V2Input { lines?: TextractLine[]; cells?: V2Cell[]; text?: string; context?: Context; }

export type V2InputKind = 'lines' | 'cells' | 'text' | 'none';

// ── small pure helpers (exported for tests and the eval harness) ────────────
/** §6.8 confidence of a code from its best owned s and its count of distinct ranges. */
export function confidenceOf(bestS: number, distinctRanges: number): number {
  const c = bestS * (REPETITION_BASE + REPETITION_STEP * Math.min(distinctRanges, REPETITION_CAP));
  return c < 0 ? 0 : c > 1 ? 1 : c;
}

/** §I tier from confidence. */
export function tierOf(conf: number): 1 | 2 | 3 {
  return conf >= TIER1_MIN - EPS ? 1 : conf >= TIER2_MIN - EPS ? 2 : 3;
}

/** §6.7: divisions 00 and 01 (procurement / general requirements). */
export function isProjectDivision(code: string): boolean {
  const d = code.slice(0, 2);
  return d === "00" || d === "01";
}

/** §6.7: facility divisions 33–35 and 40–48. */
export function isFacilityDivision(code: string): boolean {
  const n = Number(code.slice(0, 2));
  return (n >= 33 && n <= 35) || (n >= 40 && n <= 48);
}

/** The unit kind the input selects (§6.1): lines, else cells, else text. Empty arrays fall through. */
export function inputKindOf(input: V2Input): V2InputKind {
  if (input.lines && input.lines.length > 0) return 'lines';
  if (input.cells && input.cells.length > 0) return 'cells';
  if (typeof input.text === "string" && input.text.trim() !== "") return 'text';
  return 'none';
}

/** Missing / non-finite config fields take the default; maxCodesPerPage is floored at 0. */
export function resolveV2Config(config?: Partial<V2Config>): V2Config {
  const tau = config && typeof config.tau === "number" && Number.isFinite(config.tau) ? config.tau : DEFAULT_CSI_V2_PAGE_CONFIG.tau;
  const m = config && typeof config.maxCodesPerPage === "number" && Number.isFinite(config.maxCodesPerPage)
    ? Math.max(0, Math.floor(config.maxCodesPerPage)) : DEFAULT_CSI_V2_PAGE_CONFIG.maxCodesPerPage;
  return { tau, maxCodesPerPage: m };
}

/** E1: one TextractLine → one `line` unit. Text = the words joined by single spaces; each token
 *  carries the bbox of the Textract word it came from (`words[tok.pos]` for whitespace-free words,
 *  located by character offset in `unitFromWords`); `unit.bbox` = the line bbox. A line with no
 *  words falls back to its text, every token taking the line bbox. */
export function unitFromLine(line: TextractLine, kb: LoadedKb, lineIndex?: number): Unit {
  if (line.words && line.words.length > 0) {
    const u = unitFromWords(line.words, kb, lineIndex);
    if (line.bbox) u.bbox = line.bbox;
    return u;
  }
  const u = unitFromText(line.text || "", kb, { kind: 'line', bbox: line.bbox, lineIndex });
  if (line.bbox) for (const t of u.tokens) t.bbox = line.bbox;
  return u;
}

const uniqueCache = new WeakMap<LoadedKb, Uint8Array>();

/** Per pattern id: 1 when no OTHER code has a pattern with the same token set (or the same regex). */
export function codeUniquePatterns(kb: LoadedKb): Uint8Array {
  const hit = uniqueCache.get(kb);
  if (hit) return hit;
  const P = kb.patterns.length;
  const keyOf = (p: number): string => {
    const pat = kb.patterns[p];
    return pat.kind === "regex" ? `re:${pat.regex ?? ""}` : `t:${pat.tokens.slice().sort().join(" ")}`;
  };
  const codesByKey = new Map<string, Set<string>>();
  const keys: string[] = new Array<string>(P);
  for (let p = 0; p < P; p++) {
    const k = keyOf(p);
    keys[p] = k;
    const s = codesByKey.get(k);
    if (s) s.add(kb.patterns[p].code);
    else codesByKey.set(k, new Set([kb.patterns[p].code]));
  }
  const out = new Uint8Array(P);
  for (let p = 0; p < P; p++) out[p] = (codesByKey.get(keys[p])?.size ?? 0) === 1 ? 1 : 0;
  uniqueCache.set(kb, out);
  return out;
}

/** Union of LTWH boxes (normalized page coordinates); one box comes back exactly. */
export function unionBbox(boxes: BboxLTWH[]): BboxLTWH {
  if (boxes.length === 1) return [boxes[0][0], boxes[0][1], boxes[0][2], boxes[0][3]]; // exact, no float round trip
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const [x, y, w, h] of boxes) {
    if (x < l) l = x;
    if (y < t) t = y;
    if (x + w > r) r = x + w;
    if (y + h > b) b = y + h;
  }
  return [l, t, r - l, b - t];
}

// ── page assembly ───────────────────────────────────────────────────────────
interface PageUnit { unit: Unit; index: number; cellKey?: string }

function buildUnits(input: V2Input, kind: V2InputKind, kb: LoadedKb): PageUnit[] {
  if (kind === 'lines') return (input.lines ?? []).map((l, i) => ({ unit: unitFromLine(l, kb, i), index: i }));
  if (kind === 'cells') {
    return (input.cells ?? []).map((c, i) => {
      const pu: PageUnit = { unit: unitFromCell(c, kb), index: i };
      if (c.header !== undefined && c.header.trim() !== "") pu.cellKey = `${c.title ?? ""}\u0000${c.header}`;
      return pu;
    });
  }
  if (kind === 'text') return unitsFromText(input.text ?? "", kb).map((u, i) => ({ unit: u, index: i }));
  return [];
}

/** One owned span plus everything the page rules need about it. */
interface Rec { span: Span; pu: PageUnit; repKey: string; drop?: V2DropReason; geom?: { bbox: BboxLTWH; bboxes: BboxLTWH[] } }

function geometryOf(span: Span, unit: Unit): { bbox: BboxLTWH; bboxes: BboxLTWH[] } | undefined {
  const boxes: BboxLTWH[] = [];
  const seen = new Set<string>();
  for (let i = span.tokenStart; i <= span.tokenEnd && i < unit.tokens.length; i++) {
    const b = unit.tokens[i].bbox;
    if (!b) continue;
    const k = b.join(",");
    if (seen.has(k)) continue;
    seen.add(k);
    boxes.push(b);
  }
  if (!boxes.length && unit.bbox) boxes.push(unit.bbox);
  if (!boxes.length) return undefined;
  return { bbox: unionBbox(boxes), bboxes: boxes };
}

function spanText(span: Span, unit: Unit): string {
  const a = unit.tokens[span.tokenStart], b = unit.tokens[span.tokenEnd];
  if (!a || !b) return "";
  return unit.text.slice(a.start, b.end).toLowerCase();
}

/** Tokens of the pattern behind a span; a regex row counts the unit tokens it covered. */
function patternTokenCount(span: Span, kb: LoadedKb): number {
  const pat = kb.patterns[span.patternId];
  return pat && pat.kind !== "regex" ? pat.tokens.length : span.tokenEnd - span.tokenStart + 1;
}

interface CodeAgg { code: string; codeIdx: number; recs: Rec[]; conf: number; bestS: number; distinct: number; live: Rec[] }

function aggregate(recs: Rec[]): { conf: number; bestS: number; distinct: number } {
  let bestS = -Infinity;
  const keys = new Set<string>();
  for (const r of recs) { if (r.span.s > bestS) bestS = r.span.s; keys.add(r.repKey); }
  return { conf: confidenceOf(bestS, keys.size), bestS, distinct: keys.size };
}

/**
 * IMPLEMENTATION §I: page in, codes + span records + division hints out. Deterministic and pure
 * (same input, same KB → identical output); the code list does not depend on line or cell order.
 */
export function detectCsiV2(input: V2Input, config: Partial<V2Config>, kb: LoadedKb): V2Result {
  const cfg = resolveV2Config(config);
  const prep: Prepared = prepareKb(kb);
  const kind = inputKindOf(input);
  const ctx = input.context;
  const hints = new Set<string>();
  const unique = codeUniquePatterns(kb);
  const all: Rec[] = [];
  const byCode = new Map<string, Rec[]>();

  // 1 + 2: units and spans
  for (const pu of buildUnits(input, kind, kb)) {
    const m = matchUnit(pu.unit, kb, ctx);
    for (const h of m.divisionHints) hints.add(h);
    for (const span of m.spans) {
      const range = `${span.tokenStart}-${span.tokenEnd}`;
      const repKey = pu.cellKey !== undefined ? `c:${pu.cellKey}` : `${kind.charAt(0)}${pu.index}:${range}`;
      const rec: Rec = { span, pu, repKey };
      const g = geometryOf(span, pu.unit);
      if (g) rec.geom = g;
      // 3: span-level gates
      if (span.scope === 'by_others') rec.drop = 'by_others';
      else if (isProjectDivision(span.code)) {
        if (kind !== 'text') rec.drop = 'project_geometry';
        else if (patternTokenCount(span, kb) < PROJECT_TEXT_MIN_TOKENS) rec.drop = 'project_short';
        if (rec.drop) hints.add(`${span.code.slice(0, 2)} 00 00`);
      }
      all.push(rec);
      const list = byCode.get(span.code);
      if (list) list.push(rec);
      else byCode.set(span.code, [rec]);
    }
  }

  // 3 (code level): facility gate; 4: confidence
  const aggs: CodeAgg[] = [];
  for (const [code, recs] of byCode) {
    const codeIdx = prep.codeIndex.get(code);
    if (codeIdx === undefined) continue; // unreachable: every span code comes from the KB
    let live = recs.filter((r) => r.drop === undefined);
    if (live.length && isFacilityDivision(code) && ctx?.discipline !== 'C') {
      const own = new Set<string>();
      for (const r of live) if (!r.span.familyOf && unique[r.span.patternId] === 1) own.add(r.repKey);
      if (own.size < FACILITY_MIN_UNIQUE_RANGES) {
        for (const r of live) r.drop = 'facility';
        live = [];
      }
    }
    const a = aggregate(live.length ? live : recs);
    aggs.push({ code, codeIdx, recs, live, ...a });
  }

  // 5: emission, sort, cap
  const cands: CodeAgg[] = [];
  for (const g of aggs) {
    if (!g.live.length) continue;
    if (g.bestS < STRONG_SPAN_MIN - EPS) { for (const r of g.live) r.drop = 'weak'; continue; }
    if (g.conf < cfg.tau - EPS) { for (const r of g.live) r.drop = 'below_tau'; continue; }
    cands.push(g);
  }
  // conf compared on a 1e-9 grid: a total order (an EPS-tolerant compare is not transitive, so the
  // result could depend on the Map's insertion order, i.e. on line order)
  const q = (g: CodeAgg): number => Math.round(g.conf * CONF_GRID);
  cands.sort((x, y) => q(y) - q(x)
    || prep.level[y.codeIdx] - prep.level[x.codeIdx] || (x.code < y.code ? -1 : x.code > y.code ? 1 : 0));
  for (let i = cfg.maxCodesPerPage; i < cands.length; i++) for (const r of cands[i].live) r.drop = 'cap';
  const emitted = cands.slice(0, cfg.maxCodesPerPage);
  const confOf = new Map<string, number>();
  for (const g of aggs) confOf.set(g.code, g.conf);

  // 6: output
  const baseOf = (r: Rec): Omit<V2Trigger, 'bbox'> => {
    const pat = kb.patterns[r.span.patternId];
    const b: Omit<V2Trigger, 'bbox'> = {
      text: spanText(r.span, r.pu.unit), tier: tierOf(confOf.get(r.span.code) ?? 0),
      tokenStart: r.span.tokenStart, tokenEnd: r.span.tokenEnd, pattern: pat ? pat.text : "", source: r.span.source,
      score: r.span.s, emitted: r.drop === undefined,
    };
    if (r.geom) b.bboxes = r.geom.bboxes;
    if (kind === 'lines') b.line = r.pu.index;
    if (r.span.scope) b.scope = r.span.scope;
    return b;
  };
  const toSpan = (r: Rec): V2Span => {
    const s: V2Span = { code: r.span.code, ...baseOf(r) };
    if (r.geom) s.bbox = r.geom.bbox;
    if (r.drop) s.drop = r.drop;
    return s;
  };
  const codes: V2Code[] = emitted.map((g) => {
    const kc = kb.byCode.get(g.code);
    const out: V2Code = {
      code: g.code, description: kc ? kc.title : "", trade: kc ? kc.trade : "",
      division: `${g.code.slice(0, 2)} 00 00`, // §I rule letter (equals the KB field; pinned by test)
      confidence: g.conf, level: prep.level[g.codeIdx],
      ancestors: Array.from(ancestorsIdx(prep, g.codeIdx), (a) => prep.codes[a]),
    };
    const trig: V2Trigger[] = [];
    for (const r of g.recs) if (r.geom) trig.push({ ...baseOf(r), bbox: r.geom.bbox });
    if (trig.length) out.triggers = trig;
    const alts = new Set<string>();
    for (const r of g.live) for (const f of r.span.familyOf ?? []) alts.add(f);
    if (alts.size) out.alternatives = [...alts].sort();
    return out;
  });
  return { codes, spans: all.map(toSpan), divisionHints: [...hints].sort() };
}
