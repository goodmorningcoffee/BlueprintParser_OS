/**
 * csi-span-own.ts — CSI tagger v2, S3: the prepared-KB view and the pure passes the span matcher
 * runs after support (frontier, descendant rule, ranges, ownership). PLAN §6.4–§6.5;
 * IMPLEMENTATION §IV E4 (as amended), E11, E13; design note
 * `gitignore/projects/csi_tagger_v2/notes/S3_DESIGN_20261020T2320Z.md` §3, §5.5–§5.8 (J1–J3, J8, J9, J17).
 *
 * Client-safe: type-only imports, no fs, no runtime import of `@/lib/csi-kb` (the KB is a
 * parameter). `csi-span-match.ts` imports this module; this module never imports that one.
 *
 * Rules implemented here (each is DECIDED in the design note; none is a runtime knob):
 *   - Frontier (E4 amended, J1): for two overlapping supported token spans x, y of different codes
 *     where set(tokens(x)) is a PROPER subset of set(tokens(y)): if y matched a token x lacks, x
 *     dies, else y dies. Simultaneous over all pairs. Regex spans take no part (no token set).
 *     `kb.up` is NOT consulted: the offline `up` lattice stops at same-code patterns (E3), the
 *     runtime subset test does not (measured +4 titles, 0 corpus loss).
 *   - Descendant rule (E13, J2): a frontier span dies when an overlapping span of a numeric
 *     DESCENDANT code also survives with s >= its own s (the s guard).
 *   - Ranges (J9): connected components of the closed [lo, hi] intervals of the survivors.
 *   - Ownership (§6.5, J3, J8, E11): per range only the top-s spans compete (maxS); one code →
 *     it owns; codes with a common ancestor of level >= 3 → the ancestor owns at s × 0.9 with
 *     `familyOf`; else the page discipline's divisions; else a curated term row with a
 *     discipline; else no owner and the top codes' divisions become hints.
 */

import type { KbSource, LoadedKb } from "@/lib/csi-kb-types";

// ── constants (PLAN §12 tags) ────────────────────────────────────────────────
/** §12 owner: a pattern is supported when the matched mass is >= 80% of its total mass. */
export const COVERAGE_MIN = 0.8;
/** §12 guess: a span may be at most len(p) + 2 tokens wide (E5). */
export const WINDOW_SLACK = 2;
/** §12 guess: s multiplier for a non-contiguous or out-of-order (strict-order) match. */
export const CONTIGUITY_FACTOR = 0.85;
/** §12 guess: a family owner (common ancestor) owns at the best member's s × 0.9 (E11). */
export const FAMILY_DISCOUNT = 0.9;
/** §12 (E11/§6.5): the common ancestor must be at least level 3 to own on behalf of a family. */
export const FAMILY_MIN_LEVEL = 3;
/** Float tolerance for every s / coverage comparison. */
export const EPS = 1e-9;

// pattern flags
export const F_HINT = 1;
export const F_ORDERFREE = 2;
export const F_GENERIC = 4;
export const F_REGEX = 8;
export const F_TERM = 16;
export const F_ONEWORD = 32;

/** Tie-break rank after s and width: a curated term row beats a title, …, an index phrase. */
export const SOURCE_RANK: Readonly<Record<KbSource, number>> = { term: 0, title: 1, tsv: 2, alt: 3, see: 4, index: 5 };

/** §6.5 discipline → division ranges (inclusive). Any other discipline string = no context (J19). */
export const DISCIPLINE_DIVISIONS: Readonly<Record<string, readonly [number, number]>> = {
  A: [3, 14], S: [3, 5], M: [23, 23], P: [22, 22], E: [26, 28], FP: [21, 21], C: [31, 35],
};

/** True when `code`'s two-digit division lies in `discipline`'s set. Unknown discipline → false. */
export function inDiscipline(discipline: string, code: string): boolean {
  const r = Object.prototype.hasOwnProperty.call(DISCIPLINE_DIVISIONS, discipline) ? DISCIPLINE_DIVISIONS[discipline] : undefined;
  if (!r) return false;
  const n = Number(code.slice(0, 2));
  return n >= r[0] && n <= r[1];
}

// ── types ───────────────────────────────────────────────────────────────────
/** An owned span (IMPLEMENTATION §I; re-exported by `csi-span-match.ts`, where §I pins it).
 *  `tokenStart`/`tokenEnd` are inclusive INDICES into `unit.tokens` (not `Tok.pos`).
 *  For a FAMILY owner (`familyOf` set) `code` is the common ancestor while `patternId`, `source`
 *  and `contiguous` come from the best member span, so `patterns[patternId].code !== code` (J17). */
export interface Span {
  patternId: number; code: string; level: number;
  tokenStart: number; tokenEnd: number;
  s: number;
  contiguous: boolean; source: KbSource;
  familyOf?: string[];
  scope?: 'by_others';
}

/** A supported pattern occurrence (PLAN §6.3). `positions` are the ascending unit token indices
 *  actually matched; `matched` the token ids at those slots (empty for regex rows). */
export interface SupportedSpan {
  pid: number; codeIdx: number; lo: number; hi: number; s: number; coverage: number; contiguous: boolean;
  positions: Int32Array; matched: Int32Array; isRegex: boolean;
}
export type OwnRule = 'single' | 'family' | 'discipline' | 'termDiscipline' | 'none';
export interface RangeTrace { lo: number; hi: number; members: SupportedSpan[]; top: SupportedSpan[]; rule: OwnRule; owner: Span | null; }

/** The KB in flat typed arrays (design §3). Built once per LoadedKb (WeakMap), ≈ 35 ms.
 *  Pattern p's tokens live in `tok[off[p] .. off[p+1])` (printed order) and `stok` (sorted). */
export interface Prepared {
  kb: LoadedKb;
  vocab: Set<string>;
  off: Int32Array; tok: Int32Array; stok: Int32Array; mass: Float64Array; isDiff: Uint8Array; total: Float64Array;
  anchorSlot: Int32Array; codeIdx: Int32Array; flags: Uint8Array; srcRank: Uint8Array;
  discipline: (string | undefined)[];
  codes: string[]; codeIndex: Map<string, number>; parentIdx: Int32Array; level: Int8Array; division: string[];
  regexRows: { pid: number; re: RegExp }[];
  posBuf: Int32Array;
  stamp: Int32Array; epoch: number;
  ancestorsMemo: Map<number, Int32Array>;
}

/** Longest token pattern the scratch buffer supports (measured max 11 on kb-v2.4). */
export const MAX_PATTERN_TOKENS = 16;

const prepCache = new WeakMap<LoadedKb, Prepared>();

/** The prepared view of `kb`, built on first use and cached for the KB object's lifetime. */
export function prepareKb(kb: LoadedKb): Prepared {
  const hit = prepCache.get(kb);
  if (hit) return hit;
  const P = kb.patterns.length;
  const C = kb.codes.length;
  const codes = kb.codes.map((c) => c.code);
  const codeIndex = new Map<string, number>();
  codes.forEach((c, i) => codeIndex.set(c, i));
  const parentIdx = new Int32Array(C).fill(-1);
  const level = new Int8Array(C);
  const division: string[] = new Array<string>(C);
  kb.codes.forEach((c, i) => {
    level[i] = c.level;
    division[i] = c.division;
    if (c.parent !== null) {
      const pi = codeIndex.get(c.parent);
      if (pi === undefined) throw new Error(`CSI span matcher: code ${c.code} has parent ${c.parent}, which is not in the KB`);
      parentIdx[i] = pi;
    }
  });
  const off = new Int32Array(P + 1);
  for (let p = 0; p < P; p++) off[p + 1] = off[p] + kb.patterns[p].tokens.length;
  const L = off[P];
  const tok = new Int32Array(L);
  const stok = new Int32Array(L);
  const mass = new Float64Array(L);
  const isDiff = new Uint8Array(L);
  const total = new Float64Array(P);
  const anchorSlot = new Int32Array(P).fill(-1);
  const codeIdx = new Int32Array(P);
  const flags = new Uint8Array(P);
  const srcRank = new Uint8Array(P);
  const discipline: (string | undefined)[] = new Array<string | undefined>(P);
  const regexRows: { pid: number; re: RegExp }[] = [];
  for (let p = 0; p < P; p++) {
    const pat = kb.patterns[p];
    const ci = codeIndex.get(pat.code);
    if (ci === undefined) throw new Error(`CSI span matcher: pattern ${p} has unknown code ${pat.code}`);
    codeIdx[p] = ci;
    srcRank[p] = SOURCE_RANK[pat.source];
    discipline[p] = pat.discipline;
    let f = 0;
    if (pat.hintOnly) f |= F_HINT;
    if (pat.orderFree) f |= F_ORDERFREE;
    if (pat.source === "term") f |= F_TERM;
    if (pat.oneWordOk) f |= F_ONEWORD;
    if (pat.kind === "regex") {
      f |= F_REGEX;
      if (typeof pat.regex !== "string" || /\(\?<[^=!]/.test(pat.regex)) {
        throw new Error(`CSI span matcher: regex pattern ${p} is missing or uses named groups (tsc target ES2017)`);
      }
      regexRows.push({ pid: p, re: new RegExp(pat.regex, "gi") });
    } else {
      if (pat.tokens.length > MAX_PATTERN_TOKENS) throw new Error(`CSI span matcher: pattern ${p} has ${pat.tokens.length} tokens (> ${MAX_PATTERN_TOKENS})`);
      if (pat.anchor === null) f |= F_GENERIC;
      else anchorSlot[p] = pat.anchor;
      const ids: number[] = [];
      let t = 0;
      for (let j = 0; j < pat.tokens.length; j++) {
        const id = kb.tokenId.get(pat.tokens[j]);
        if (id === undefined) throw new Error(`CSI span matcher: pattern ${p} token "${pat.tokens[j]}" is not interned`);
        if (ids.includes(id)) throw new Error(`CSI span matcher: pattern ${p} repeats token "${pat.tokens[j]}"`);
        ids.push(id);
        tok[off[p] + j] = id;
        mass[off[p] + j] = pat.mass[j];
        t += pat.mass[j];
      }
      for (const d of pat.diff) isDiff[off[p] + d] = 1;
      total[p] = t;
      ids.sort((a, b) => a - b);
      for (let j = 0; j < ids.length; j++) stok[off[p] + j] = ids[j];
    }
    flags[p] = f;
  }
  const prep: Prepared = {
    kb, vocab: new Set(kb.tokenId.keys()),
    off, tok, stok, mass, isDiff, total, anchorSlot, codeIdx, flags, srcRank, discipline,
    codes, codeIndex, parentIdx, level, division, regexRows,
    posBuf: new Int32Array(MAX_PATTERN_TOKENS), stamp: new Int32Array(P), epoch: 0,
    ancestorsMemo: new Map(),
  };
  prepCache.set(kb, prep);
  return prep;
}

/** Proper ancestors of code index `c`, nearest first (memoised). */
export function ancestorsIdx(prep: Prepared, c: number): Int32Array {
  const hit = prep.ancestorsMemo.get(c);
  if (hit) return hit;
  const out: number[] = [];
  for (let a = prep.parentIdx[c]; a >= 0; a = prep.parentIdx[a]) out.push(a);
  const arr = Int32Array.from(out);
  prep.ancestorsMemo.set(c, arr);
  return arr;
}

/** True when code index `a` is a proper numeric ancestor of code index `d`. */
export function isAncestorIdx(prep: Prepared, a: number, d: number): boolean {
  for (let x = prep.parentIdx[d]; x >= 0; x = prep.parentIdx[x]) if (x === a) return true;
  return false;
}

/** set(tokens(p)) ⊊ set(tokens(q)) — two-pointer merge over the sorted token ids (J1). */
export function dominates(prep: Prepared, p: number, q: number): boolean {
  const { off, stok } = prep;
  const pa = off[p], pb = off[p + 1], qa = off[q], qb = off[q + 1];
  if (pb - pa >= qb - qa || pb === pa) return false;
  let j = qa;
  for (let i = pa; i < pb; i++) {
    const v = stok[i];
    while (j < qb && stok[j] < v) j++;
    if (j >= qb || stok[j] !== v) return false;
    j++;
  }
  return true;
}

function patternHas(prep: Prepared, p: number, id: number): boolean {
  for (let i = prep.off[p]; i < prep.off[p + 1]; i++) if (prep.tok[i] === id) return true;
  return false;
}

/** Calls `visit(a, b)` once per unordered pair of OVERLAPPING spans (indices into `ss`): a sweep over
 *  the spans sorted by `lo` (fix2). Token spans are at most len(p) + WINDOW_SLACK wide, so on a long
 *  unit each span meets only its neighbours — linear in the unit, where the all-pairs loop was quadratic. */
function forOverlappingPairs(ss: SupportedSpan[], visit: (a: number, b: number) => void): void {
  const order = ss.map((_, i) => i).sort((a, b) => ss[a].lo - ss[b].lo || a - b);
  for (let i = 0; i < order.length; i++) {
    const hi = ss[order[i]].hi;
    for (let j = i + 1; j < order.length && ss[order[j]].lo <= hi; j++) visit(order[i], order[j]);
  }
}

/** E4 amended (J1): the frontier of the supported spans, simultaneous kill set. */
export function applyFrontier(prep: Prepared, supported: SupportedSpan[]): SupportedSpan[] {
  const n = supported.length;
  if (n < 2) return supported.slice();
  const dead = new Uint8Array(n);
  // ordered pair (a, b): x = supported[a] a proper token subset of y = supported[b]
  const kill = (a: number, b: number) => {
    const x = supported[a], y = supported[b];
    if (x.isRegex || y.isRegex || x.codeIdx === y.codeIdx || !dominates(prep, x.pid, y.pid)) return;
    let outside = false;
    for (let k = 0; k < y.matched.length; k++) if (!patternHas(prep, x.pid, y.matched[k])) { outside = true; break; }
    if (outside) dead[a] = 1;
    else dead[b] = 1;
  };
  forOverlappingPairs(supported, (a, b) => { kill(a, b); kill(b, a); });
  return supported.filter((_, i) => dead[i] === 0);
}

/** E13 with the s guard (J2): drop x when an overlapping survivor of a DESCENDANT code has s >= x.s. */
export function applyDescendantRule(prep: Prepared, frontier: SupportedSpan[]): SupportedSpan[] {
  if (frontier.length < 2) return frontier.slice();
  const dead = new Uint8Array(frontier.length);
  // ordered pair (a, b): frontier[a] is the ancestor, frontier[b] the descendant
  const kill = (a: number, b: number) => {
    const x = frontier[a], y = frontier[b];
    if (y.codeIdx !== x.codeIdx && y.s >= x.s - EPS && isAncestorIdx(prep, x.codeIdx, y.codeIdx)) dead[a] = 1;
  };
  forOverlappingPairs(frontier, (a, b) => { kill(a, b); kill(b, a); });
  return frontier.filter((_, i) => dead[i] === 0);
}

/** J9: connected components of the survivors' closed intervals, in token order. */
export function groupRanges(survivors: SupportedSpan[]): SupportedSpan[][] {
  const sorted = survivors.slice().sort((a, b) => a.lo - b.lo || a.hi - b.hi);
  const out: SupportedSpan[][] = [];
  let cur: SupportedSpan[] = [];
  let curHi = -1;
  for (const s of sorted) {
    if (cur.length && s.lo <= curHi) {
      cur.push(s);
      if (s.hi > curHi) curHi = s.hi;
    } else {
      if (cur.length) out.push(cur);
      cur = [s];
      curHi = s.hi;
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

/** < 0 when `a` is the better span: s desc → width desc → source rank asc → pid asc → lo asc. */
export function compareSpans(prep: Prepared, a: SupportedSpan, b: SupportedSpan): number {
  if (Math.abs(a.s - b.s) > EPS) return b.s - a.s;
  const w = (b.hi - b.lo) - (a.hi - a.lo);
  if (w !== 0) return w;
  const r = prep.srcRank[a.pid] - prep.srcRank[b.pid];
  if (r !== 0) return r;
  return a.pid - b.pid || a.lo - b.lo;
}

function best(prep: Prepared, ss: SupportedSpan[]): SupportedSpan {
  let b = ss[0];
  for (let i = 1; i < ss.length; i++) if (compareSpans(prep, ss[i], b) < 0) b = ss[i];
  return b;
}

/** Lowest common ancestor-or-self of the code indices, or -1. */
function lca(prep: Prepared, cs: number[]): number {
  let common = [cs[0], ...ancestorsIdx(prep, cs[0])];
  for (let i = 1; i < cs.length; i++) {
    const mine = new Set<number>([cs[i], ...ancestorsIdx(prep, cs[i])]);
    common = common.filter((a) => mine.has(a));
    if (!common.length) return -1;
  }
  return common.length ? common[0] : -1;
}

function decide(prep: Prepared, ss: SupportedSpan[], rule: OwnRule): { owner: Span; rule: OwnRule } | null {
  const cs = [...new Set(ss.map((s) => s.codeIdx))];
  const b = best(prep, ss);
  const pat = prep.kb.patterns[b.pid];
  if (cs.length === 1) {
    return { rule, owner: { patternId: b.pid, code: prep.codes[b.codeIdx], level: prep.level[b.codeIdx], tokenStart: b.lo, tokenEnd: b.hi, s: b.s, contiguous: b.contiguous, source: pat.source } };
  }
  const l = lca(prep, cs);
  if (l < 0 || prep.level[l] < FAMILY_MIN_LEVEL) return null;
  let lo = ss[0].lo, hi = ss[0].hi;
  for (const s of ss) { if (s.lo < lo) lo = s.lo; if (s.hi > hi) hi = s.hi; }
  return {
    rule: rule === 'single' ? 'family' : rule,
    owner: {
      patternId: b.pid, code: prep.codes[l], level: prep.level[l], tokenStart: lo, tokenEnd: hi, s: b.s * FAMILY_DISCOUNT,
      contiguous: b.contiguous, source: pat.source, familyOf: cs.map((c) => prep.codes[c]).sort(),
    },
  };
}

/** §6.5 ownership for every range (J3 maxS, J8 term-discipline step fires without ctx, J19).
 *  `discipline` must already be normalised: a key of DISCIPLINE_DIVISIONS or undefined.
 *  Returns one trace per range; unowned ranges carry rule 'none' and add their top divisions to `hints`. */
export function ownRanges(prep: Prepared, ranges: SupportedSpan[][], discipline: string | undefined, hints: Set<string>): RangeTrace[] {
  const out: RangeTrace[] = [];
  for (const members of ranges) {
    let mx = -Infinity;
    for (const s of members) if (s.s > mx) mx = s.s;
    const top = members.filter((s) => s.s >= mx - EPS);
    let lo = members[0].lo, hi = members[0].hi;
    for (const s of members) { if (s.lo < lo) lo = s.lo; if (s.hi > hi) hi = s.hi; }
    let d = decide(prep, top, 'single');
    if (!d && discipline !== undefined) {
      const f = top.filter((s) => inDiscipline(discipline, prep.codes[s.codeIdx]));
      if (f.length && f.length < top.length) d = decide(prep, f, 'discipline');
    }
    if (!d) {
      const rows = top.filter((s) => {
        const pd = prep.discipline[s.pid];
        return pd !== undefined && (discipline === undefined || pd === discipline);
      });
      if (rows.length) d = decide(prep, rows, 'termDiscipline');
    }
    if (d) out.push({ lo, hi, members, top, rule: d.rule, owner: d.owner });
    else {
      for (const s of top) hints.add(prep.division[s.codeIdx]);
      out.push({ lo, hi, members, top, rule: 'none', owner: null });
    }
  }
  return out;
}
