/**
 * csi-span-match.ts — CSI tagger v2, S3: the deterministic span matcher (no LLM at runtime).
 *
 * One UNIT (a line, a table cell, or a text unit) in, owned SPANS + division hints out.
 * Spec: PLAN §6.2–§6.6; IMPLEMENTATION §I (pinned `Unit` / `Span` / `Context` / `matchUnit`),
 * §IV E1, E2, E4 (as amended), E5, E6, E7, E9, E11, E13, E14; the S3 design ruling
 * `gitignore/projects/csi_tagger_v2/notes/S3_DESIGN_20261020T2320Z.md` (decisions J1–J21).
 * Page gates and confidence/emission (§6.7, §6.8) are S4 and live elsewhere.
 *
 * Client-safe: no fs, no runtime import of `@/lib/csi-kb` — callers pass the `LoadedKb`.
 *
 * Pipeline (`traceUnit` is the ONE code path; `matchUnit` is its projection):
 *   5.0 negation (§6.6, J6): a N.I.C. / NOT IN CONTRACT / BY OTHERS / BY OWNER marker ENDING the
 *       unit text marks every owned span `scope:'by_others'`, and tokens from the marker on are
 *       masked (so `EQUIPMENT BY OTHERS` owns nothing rather than 11 90 00 "Other Equipment").
 *   5.2 candidates (§6.2): anchor + generic postings of every unit token; each pattern once.
 *   5.3 support (§6.3, E5, E6): from each occurrence of the posting token, place every other
 *       pattern token at its nearest occurrence within ±(n+1) INSIDE THE SAME BOUNDARY SEGMENT
 *       (E1 `boundaryBefore`; a known-abbreviation dot is not a boundary); every diff token is
 *       mandatory; span width ≤ n + WINDOW_SLACK; coverage = matched mass / total ≥ 0.8;
 *       ⚠ DEVIATION from E5's letter (design §5.3, mutation table §7.5): E5 says "nearest occurrence,
 *       then reject the span if a boundaryBefore falls inside it". Searching only the anchor's
 *       segment instead treats a token beyond a boundary as NOT FOUND, so the pattern may still
 *       pass on the rest of its mass: `CONCRETE: AUTOCLAVED AERATED UNIT MASONRY` owns 04 22 26
 *       @0.884 [1-4] here, 04 20 00 [3-4] under the literal rule. Same invariant (no span crosses
 *       a boundary); measured cost of the literal rule: titles owned exact 8,446 → 8,445, corpus
 *       units with a code 8,252 → 8,251 (logs/s3-20261020T2320Z-fix1-e5-literal.txt).
 *       s = coverage × (contiguous ? 1 : 0.85, or 0.7 for a strict-order pattern out of printed order —
 *       S5); a `<=N` one-word term row needs a unit of ≤ N tokens (S5); a generic pattern needs s = 1; a multi-token
 *       pattern matched by ONE token is dropped (J5); one-token patterns yield spans only when
 *       `oneWordOk`, else they are hint-only (E6).
 *   5.4 regex term rows (E7) on the raw text, s = 1.
 *   5.5–5.8 frontier, descendant rule, ranges, ownership — `csi-span-own.ts`.
 *   5.9 hints (J7): 'NN 00 00', from hint-only tokens NOT inside a surviving span, plus the
 *       divisions of unowned ranges.
 *
 * Cost (fix2): linear in the unit for bounded pattern length — each occurrence scan is windowed to
 * ±radius by binary search, the span de-dup looks back one radius, the regex token lookup walks
 * forward, hint coverage is a difference array, and the frontier / descendant passes visit only
 * OVERLAPPING pairs (csi-span-own.ts). One 3,000-token cell (`BOARD GYPSUM WALL` ×1000): 541.78 ms
 * → ≈ 11 ms; output byte-identical on 381,570 traces (logs/s3-20261020T2320Z-fix2-trace-identity.txt).
 */

import { splitTextUnits, tokenize, type Tok } from "@/lib/csi-tokenize";
import type { LoadedKb } from "@/lib/csi-kb-types";
import type { BboxLTWH } from "@/types";
import {
  CONTIGUITY_FACTOR, COVERAGE_MIN, DISCIPLINE_DIVISIONS, EPS, F_GENERIC, F_HINT, F_ONEWORD, F_ORDERFREE, F_REGEX,
  OUT_OF_ORDER_FACTOR, WINDOW_SLACK, applyDescendantRule, applyFrontier, groupRanges, ownRanges, prepareKb,
  type Prepared, type RangeTrace, type Span, type SupportedSpan,
} from "@/lib/csi-span-own";

/** `Span` is defined in csi-span-own.ts (no import cycle) and pinned here by IMPLEMENTATION §I. */
export type { Span, SupportedSpan, RangeTrace, OwnRule } from "@/lib/csi-span-own";

/** One matching unit (IMPLEMENTATION §I). `tokens` are trusted as given (no re-tokenization). */
export interface Unit {
  text: string; tokens: Tok[];
  kind: 'line' | 'cell' | 'text';
  bbox?: BboxLTWH; lineIndex?: number; header?: string; tableTitle?: string;
}
/** Page context (IMPLEMENTATION §I). Only `discipline` is read in S3; values outside
 *  DISCIPLINE_DIVISIONS (FA, DM, G, …) are treated as no context (J19). */
export interface Context { discipline?: string; pageKind?: 'drawing' | 'notes' | 'spec' | 'cover' | 'unknown'; drawingNumber?: string; }

/** Every intermediate stage of one unit, for tests and the measurement harness. */
export interface MatchTrace {
  negated: boolean;
  /** UTF-16 offset of the negation marker in `unit.text`, or -1 when not negated. */
  negFrom: number;
  supported: SupportedSpan[];
  frontier: SupportedSpan[];
  survivors: SupportedSpan[];
  ranges: RangeTrace[];
  spans: Span[];
  divisionHints: string[];
}

/** §6.6 negation marker at the END of the unit (a cell's value is its last joined part, so a
 *  whole-cell N.I.C. is the same rule). The non-alphanumeric lead keeps a unit ENDING in CLINIC /
 *  PANIC / ELECTRONIC from reading as N.I.C. (pinned by `CARPET CLINIC`, `DOOR HARDWARE PANIC`). */
export const NEGATION_TAIL_RE = /(?:^|[^A-Za-z0-9])\(?(N\.?\s?I\.?\s?C\.?|NOT\s+IN\s+CONTRACT|BY\s+OTHERS|BY\s+OWNER)\)?[\s.,;:)]*$/i;

// ── unit builders ───────────────────────────────────────────────────────────
/** The tokenizer as the KB expects it: fold vocab = KB token set (E14), known abbreviations. */
export function csiTokenizeForKb(text: string, kb: LoadedKb): Tok[] {
  return tokenize(text, prepareKb(kb).vocab, kb.known);
}

export function unitFromText(text: string, kb: LoadedKb, opts?: { kind?: 'line' | 'text'; bbox?: BboxLTWH; lineIndex?: number }): Unit {
  const u: Unit = { text, tokens: csiTokenizeForKb(text, kb), kind: opts?.kind ?? 'text' };
  if (opts?.bbox) u.bbox = opts.bbox;
  if (opts?.lineIndex !== undefined) u.lineIndex = opts.lineIndex;
  return u;
}

/** Free text → units by the tokenizer's unit splitter (lines / sentences, PLAN §6.1). */
export function unitsFromText(text: string, kb: LoadedKb): Unit[] {
  return splitTextUnits(text, kb.known).map((t) => unitFromText(t, kb));
}

/** E9: a table cell is ONE unit — title, header, then text, joined with spaces and tokenized
 *  once, with NO boundary between the parts (boundaries inside a part stay). */
export function unitFromCell(cell: { text: string; header?: string; title?: string; bbox?: BboxLTWH }, kb: LoadedKb): Unit {
  const parts = [cell.title, cell.header, cell.text].map((p) => (p ?? "").trim()).filter((p) => p !== "");
  const text = parts.join(" ");
  const tokens = csiTokenizeForKb(text, kb);
  let offset = 0;
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) {
      const t = tokens.find((x) => x.start >= offset);
      if (t && t.boundaryBefore) delete t.boundaryBefore;
    }
    offset += parts[i].length + 1;
  }
  const u: Unit = { text, tokens, kind: 'cell' };
  if (cell.bbox) u.bbox = cell.bbox;
  if (cell.header !== undefined) u.header = cell.header;
  if (cell.title !== undefined) u.tableTitle = cell.title;
  return u;
}

/** S4's line builder: words joined with single spaces; each token takes the bbox of the word its
 *  first character falls in (robust to a word text that itself contains whitespace). */
export function unitFromWords(words: { text: string; bbox?: BboxLTWH }[], kb: LoadedKb, lineIndex?: number): Unit {
  const text = words.map((w) => w.text).join(" ");
  const tokens = csiTokenizeForKb(text, kb);
  const starts: number[] = [];
  let at = 0;
  for (const w of words) { starts.push(at); at += w.text.length + 1; }
  let wi = 0;
  for (const t of tokens) {
    while (wi + 1 < starts.length && starts[wi + 1] <= t.start) wi++;
    const bbox = words[wi]?.bbox;
    if (bbox) t.bbox = bbox;
  }
  const u: Unit = { text, tokens, kind: 'line' };
  if (lineIndex !== undefined) u.lineIndex = lineIndex;
  return u;
}

// ── support (5.3) ───────────────────────────────────────────────────────────
interface UnitArrays { tid: Int32Array; seg: Int32Array; occ: Map<number, number[]> }

function supportPattern(prep: Prepared, ua: UnitArrays, pid: number, key: number, out: SupportedSpan[], hintPos: number[], hintDiv: string[]): void {
  const { off, tok, mass, isDiff, total, flags, posBuf } = prep;
  const f = flags[pid];
  const a0 = off[pid], np = off[pid + 1] - a0;
  const keyOcc = ua.occ.get(key);
  if (!keyOcc) return;
  if (f & F_HINT) { // E6: a hint-only one-word pattern never yields a span
    for (const a of keyOcc) { hintPos.push(a); hintDiv.push(prep.division[prep.codeIdx[pid]]); }
    return;
  }
  if (np === 1 && !(f & F_ONEWORD)) return; // one-word only with oneWordOk (§6.3)
  if (np === 1 && prep.unitCap[pid] > 0 && ua.tid.length > prep.unitCap[pid]) return; // S5 d3: `<=N` term rows
  // prefilters (speed only): every diff token present; best-case mass reaches the gate
  let ub = 0;
  for (let j = 0; j < np; j++) {
    const present = ua.occ.has(tok[a0 + j]);
    if (isDiff[a0 + j] && !present) return;
    if (present) ub += mass[a0 + j];
  }
  const tot = total[pid];
  if (ub < COVERAGE_MIN * tot - EPS) return;
  let ks = prep.anchorSlot[pid];
  if (ks < 0) for (let j = 0; j < np; j++) if (tok[a0 + j] === key) { ks = j; break; }
  const radius = np + 1;
  const firstOut = out.length;
  for (const a of keyOcc) {
    const sa = ua.seg[a];
    for (let j = 0; j < np; j++) posBuf[j] = -1;
    posBuf[ks] = a;
    for (let j = 0; j < np; j++) {
      if (j === ks) continue;
      const list = ua.occ.get(tok[a0 + j]);
      if (!list) continue;
      let bestQ = -1, bestD = radius + 1;
      // `list` is ascending: binary-search to a - radius, stop past a + radius (fix2: O(radius), not O(unit))
      let li = 0, ri = list.length;
      while (li < ri) { const mid = (li + ri) >> 1; if (list[mid] < a - radius) li = mid + 1; else ri = mid; }
      for (; li < list.length; li++) {
        const q = list[li];
        if (q > a + radius) break;
        const d = q > a ? q - a : a - q;
        if (d === 0 || ua.seg[q] !== sa) continue;
        if (d < bestD || (d === bestD && (j < ks) === (q < a))) { bestD = d; bestQ = q; }
      }
      posBuf[j] = bestQ;
    }
    let lo = Infinity, hi = -1, cnt = 0, got = 0, ordered = true, last = -1, diffMissing = false;
    for (let j = 0; j < np; j++) {
      const q = posBuf[j];
      if (q < 0) { if (isDiff[a0 + j]) { diffMissing = true; break; } continue; }
      cnt++;
      got += mass[a0 + j];
      if (q < lo) lo = q;
      if (q > hi) hi = q;
      if (q < last) ordered = false;
      last = q;
    }
    if (diffMissing) continue; // E2: a diff token is mandatory
    if (hi - lo + 1 > np + WINDOW_SLACK) continue; // E5 window gate
    const coverage = got / tot;
    if (coverage < COVERAGE_MIN - EPS) continue;
    const contiguous = cnt === hi - lo + 1 && ((f & F_ORDERFREE) !== 0 || ordered);
    if ((f & F_GENERIC) && !(coverage >= 1 - EPS && contiguous)) continue; // generic needs s = 1
    if (np >= 2 && cnt === 1) continue; // J5: one word never carries a multi-token pattern
    // de-dup against this pattern's earlier spans; pivots ascend and every span lies within ±radius
    // of its pivot, so once an earlier span ends radius left of lo none further back can match
    let dup = false;
    for (let k = out.length - 1; k >= firstOut; k--) {
      const o = out[k];
      if (o.hi + radius < lo) break;
      if (o.lo === lo && o.hi === hi) { dup = true; break; }
    }
    if (dup) continue;
    const positions = new Int32Array(cnt), matched = new Int32Array(cnt);
    let k = 0;
    for (let j = 0; j < np; j++) if (posBuf[j] >= 0) { positions[k] = posBuf[j]; matched[k] = tok[a0 + j]; k++; }
    positions.sort();
    const factor = contiguous ? 1 : !(f & F_ORDERFREE) && !ordered ? OUT_OF_ORDER_FACTOR : CONTIGUITY_FACTOR;
    out.push({ pid, codeIdx: prep.codeIdx[pid], lo, hi, s: coverage * factor, coverage, contiguous, positions, matched, isRegex: false });
  }
}

function regexSpans(prep: Prepared, unit: Unit, negFrom: number, out: SupportedSpan[]): void {
  const T = unit.tokens;
  for (const { pid, re } of prep.regexRows) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let i0 = 0; // matches ascend and tokens ascend, so the first token ending after `a` only moves right
    while ((m = re.exec(unit.text)) !== null) {
      const a = m.index, b = a + m[0].length;
      if (b === a) { re.lastIndex = a + 1; continue; }
      if (a >= negFrom) continue; // defensive: no kb-v2.4 regex row can start inside a tail marker
      while (i0 < T.length && T[i0].end <= a) i0++;
      const hit: number[] = [];
      for (let i = i0; i < T.length && T[i].start < b; i++) hit.push(i);
      if (!hit.length) continue;
      out.push({ pid, codeIdx: prep.codeIdx[pid], lo: hit[0], hi: hit[hit.length - 1], s: 1, coverage: 1, contiguous: true, positions: Int32Array.from(hit), matched: new Int32Array(0), isRegex: true });
    }
  }
}

// ── the pipeline ────────────────────────────────────────────────────────────
/** The full trace of one unit — the ONE code path (`matchUnit` projects it). */
export function traceUnit(unit: Unit, kb: LoadedKb, ctx?: Context): MatchTrace {
  const prep = prepareKb(kb);
  const nm = NEGATION_TAIL_RE.exec(unit.text);
  const negated = nm !== null;
  const negFrom = nm ? nm.index + nm[0].indexOf(nm[1]) : -1;
  const maskFrom = negated ? negFrom : Infinity;
  const T = unit.tokens;
  const n = T.length;
  const empty: MatchTrace = { negated, negFrom, supported: [], frontier: [], survivors: [], ranges: [], spans: [], divisionHints: [] };
  if (n === 0) return empty;

  // 5.1 per-unit arrays (masked tokens get id -1 and are absent from `occ`)
  const tid = new Int32Array(n), seg = new Int32Array(n);
  const occ = new Map<number, number[]>();
  let sg = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0 && T[i].boundaryBefore) sg++;
    seg[i] = sg;
    const id = T[i].start >= maskFrom ? -1 : (kb.tokenId.get(T[i].t) ?? -1);
    tid[i] = id;
    if (id < 0) continue;
    const list = occ.get(id);
    if (list) list.push(i);
    else occ.set(id, [i]);
  }
  const ua: UnitArrays = { tid, seg, occ };

  // 5.2 + 5.3 candidates and support
  const supported: SupportedSpan[] = [];
  const hintPos: number[] = [], hintDiv: string[] = [];
  const epoch = ++prep.epoch;
  for (const key of occ.keys()) {
    for (const idx of [kb.anchorIndex.get(key), kb.genericIndex.get(key)]) {
      if (!idx) continue;
      for (let i = 0; i < idx.length; i++) {
        const pid = idx[i];
        if (prep.stamp[pid] === epoch || (prep.flags[pid] & F_REGEX)) continue;
        prep.stamp[pid] = epoch;
        supportPattern(prep, ua, pid, key, supported, hintPos, hintDiv);
      }
    }
  }
  // 5.4 regex term rows
  regexSpans(prep, unit, maskFrom, supported);

  // 5.5–5.8
  const frontier = applyFrontier(prep, supported);
  const survivors = applyDescendantRule(prep, frontier);
  const disc = ctx?.discipline !== undefined && Object.prototype.hasOwnProperty.call(DISCIPLINE_DIVISIONS, ctx.discipline) ? ctx.discipline : undefined;
  const hints = new Set<string>();
  const ranges = ownRanges(prep, groupRanges(survivors), disc, hints);

  // 5.9 hints: hint-only tokens outside every surviving span (coverage by a difference array)
  if (hintPos.length) {
    const cover = new Int32Array(n + 1);
    for (const s of survivors) { cover[s.lo]++; cover[s.hi + 1]--; }
    for (let i = 1; i <= n; i++) cover[i] += cover[i - 1];
    for (let i = 0; i < hintPos.length; i++) if (cover[hintPos[i]] === 0) hints.add(hintDiv[i]);
  }

  // 5.10 output
  const spans: Span[] = [];
  for (const r of ranges) if (r.owner) spans.push(negated ? { ...r.owner, scope: 'by_others' } : r.owner);
  spans.sort((a, b) => a.tokenStart - b.tokenStart || a.tokenEnd - b.tokenEnd || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  return { negated, negFrom, supported, frontier, survivors, ranges, spans, divisionHints: [...hints].sort() };
}

/** IMPLEMENTATION §I: owned spans + division hints ('NN 00 00', sorted unique) for one unit. */
export function matchUnit(unit: Unit, kb: LoadedKb, ctx?: Context): { spans: Span[]; divisionHints: string[] } {
  const t = traceUnit(unit, kb, ctx);
  return { spans: t.spans, divisionHints: t.divisionHints };
}
