/**
 * csi-kb-overlay.ts — a company's custom CSI list as a per-tenant overlay on the v2 KB (S6).
 *
 * Spec: PLAN §7 ("Company upload ADDS codes: custom rows become title patterns in a per-tenant
 * overlay; builtin IDF/anchors are FROZEN, overlay-only tokens get a default IDF (so tenants cannot
 * move builtin results)"), IMPLEMENTATION §II S6.
 *
 * Client-safe and pure: it takes the builtin `LoadedKb` (from the server-only loader) and a parsed
 * `CsiDatabase` (the custom TSV, `parseCsiTsv`) and returns a NEW `LoadedKb`. Nothing in the base KB
 * is mutated — every builtin pattern keeps its tokens, mass, diff and anchor byte-for-byte, and the
 * base maps are copied before the overlay rows are added.
 *
 * One custom row → at most one `source:'title'` pattern, built the way the S2 builder builds a title:
 *   - tokens: `tokenize(description)` with NO fold vocab (E14 fold-always), de-duplicated, printed order;
 *   - mass: the builtin idf of the token (frozen), or `defaultIdf` for a token the builtin KB lacks
 *     (= the largest builtin idf, i.e. a codeDF-1 token), halved for filler tokens (D4);
 *   - anchor: the rarest token that is not floored/boilerplate, non-filler first (E12e); null ⇒ generic;
 *   - diff: {anchor} ∪ the tokens absent from the numeric parent's TITLE patterns (E2), filler removed;
 *   - up: [] (the matcher's frontier uses token-subset dominance, not `up`; csi-span-own.ts header);
 *   - a one-token row is hint-only (E6: one-word patterns emit only from curated csi_terms rows).
 * A row is SKIPPED (counted in `stats`) when its code is not MasterFormat-shaped, it has no tokens or
 * more than `MAX_PATTERN_TOKENS`, or its token set equals ANY builtin pattern's set (the builtin
 * already owns that phrase; a tenant cannot take it) or an earlier overlay row's set for that code.
 * A code the builtin lacks becomes a new `KbCode` (level by digit shape, parent = nearest existing
 * shape ancestor, division `NN 00 00`, title/trade from its first row); a builtin code gains the
 * pattern on a COPY of its `KbCode`.
 *
 * ⚠ Freezing IDF/anchors does NOT by itself keep builtin RESULTS fixed: overlay patterns take part in
 * dominance and ownership, so a run on this KB alone can re-score or drop a builtin code (measured:
 * a custom phrase on 08 13 13 took a span from 08 11 13). The "tenants cannot move builtin results"
 * guarantee is enforced by the adapter (`csi-detect.ts` `run`), which keeps the builtin run's rows
 * and only ADDS the codes this overlay names.
 */

import type { CsiDatabase } from "@/lib/csi-database";
import type { KbCode, KbPattern, LoadedKb } from "@/lib/csi-kb-types";
import { MAX_PATTERN_TOKENS } from "@/lib/csi-span-own";
import { tokenize } from "@/lib/csi-tokenize";
import { normalizeCsiCode } from "@/lib/csi-utils";

/** Mass of a filler token = idf × this (must equal the builder's FILLER_FACTOR; asserted by test). */
export const OVERLAY_FILLER_FACTOR = 0.5;
/** Two idf values within this are a tie for "rarest" (first printed wins) — the loader's tolerance. */
const IDF_TIE_EPS = 2.5e-4;
const MF_CODE_RE = /^\d\d \d\d \d\d(?:\.\d\d)?$/;

export interface CsiOverlayStats {
  rows: number;
  patternsAdded: number;
  codesAdded: number;
  skippedBadCode: number;
  skippedNoTokens: number;
  skippedTooLong: number;
  skippedBuiltinDuplicate: number;
  skippedOverlayDuplicate: number;
}

export interface CsiOverlay { kb: LoadedKb; stats: CsiOverlayStats; defaultIdf: number }

const round4 = (x: number): number => Math.round(x * 1e4) / 1e4;

/** A custom code in the KB's spaced form ('NN NN NN' | 'NN NN NN.NN'), or null when it has none. */
export function overlayCode(raw: string): string | null {
  const n = normalizeCsiCode(raw);
  const c = /^\d\d$/.test(n) ? `${n} 00 00` : /^\d\d \d\d$/.test(n) ? `${n} 00` : n;
  return MF_CODE_RE.test(c) ? c : null;
}

/** MasterFormat level by digit shape (eval/csi/mf-parse.ts `levelOf`, copied: eval code is not imported). */
export function overlayLevelOf(code: string): 2 | 3 | 4 | 5 {
  if (code.includes(".")) return 5;
  const [, b, d] = code.split(" ");
  if (b === "00" && d === "00") return 2;
  if (d === "00") return 3;
  return 4;
}

/** Nearest shape ancestor `has` knows: `.NN → NN NN NN → NN NN 00 → NN N0 00 → NN 00 00` (builder P1). */
export function overlayParentOf(code: string, has: (c: string) => boolean): string | null {
  const d = code.replace(/\D/g, "");
  const six = d.slice(0, 6);
  const chain = [d.length > 6 ? six : "", `${six.slice(0, 4)}00`, `${six.slice(0, 3)}000`, `${six.slice(0, 2)}0000`];
  for (const c of chain) {
    if (!c || c === d) continue;
    const spaced = `${c.slice(0, 2)} ${c.slice(2, 4)} ${c.slice(4, 6)}`;
    if (spaced !== code && has(spaced)) return spaced;
  }
  return null;
}

const setKey = (tokens: readonly string[]): string => tokens.slice().sort().join(" ");

/** Build the overlay KB. Pure; `base` is never mutated. */
export function buildCsiOverlayKb(base: LoadedKb, custom: CsiDatabase): CsiOverlay {
  const stats: CsiOverlayStats = {
    rows: custom.entries.length, patternsAdded: 0, codesAdded: 0, skippedBadCode: 0, skippedNoTokens: 0,
    skippedTooLong: 0, skippedBuiltinDuplicate: 0, skippedOverlayDuplicate: 0,
  };
  let defaultIdf = 0;
  for (const v of base.idf.values()) if (v > defaultIdf) defaultIdf = v;
  defaultIdf = round4(defaultIdf);
  const noAnchor = new Set([...base.header.floorTokens, ...base.header.boilerplateTokens]);
  const filler = new Set(base.header.fillerTokens);

  const builtinSets = new Set<string>();
  const titleTokens = new Map<string, Set<string>>(); // code → tokens of its title patterns (E2 parent diff)
  for (const p of base.patterns) {
    if (p.kind === "regex") continue;
    builtinSets.add(setKey(p.tokens));
    if (p.source === "title") {
      const s = titleTokens.get(p.code) ?? new Set<string>();
      for (const t of p.tokens) s.add(t);
      titleTokens.set(p.code, s);
    }
  }

  const tokenId = new Map(base.tokenId);
  const idf = new Map(base.idf);
  const idfOf = (t: string): number => idf.get(t) ?? defaultIdf;
  const patterns: KbPattern[] = base.patterns.slice();
  const byCode = new Map(base.byCode);
  const codeOrder: KbCode[] = base.codes.slice();
  const codePos = new Map<string, number>();
  codeOrder.forEach((c, i) => codePos.set(c.code, i));
  const overlaySets = new Set<string>();
  const anchorAdds = new Map<number, number[]>();
  const genericAdds = new Map<number, number[]>();

  for (const e of custom.entries) {
    const code = overlayCode(e.code);
    if (!code) { stats.skippedBadCode++; continue; }
    const tokens: string[] = [];
    for (const tok of tokenize(e.description)) if (!tokens.includes(tok.t)) tokens.push(tok.t);
    if (!tokens.length) { stats.skippedNoTokens++; continue; }
    if (tokens.length > MAX_PATTERN_TOKENS) { stats.skippedTooLong++; continue; }
    const key = setKey(tokens);
    if (builtinSets.has(key)) { stats.skippedBuiltinDuplicate++; continue; }
    if (overlaySets.has(`${code}\u0000${key}`)) { stats.skippedOverlayDuplicate++; continue; }
    overlaySets.add(`${code}\u0000${key}`);

    // the code: a builtin/earlier code gains a pattern on a copy; a new code is created
    let kc = byCode.get(code);
    if (!kc) {
      const parent = overlayParentOf(code, (c) => byCode.has(c));
      kc = {
        code, level: overlayLevelOf(code), parent, title: e.description, trade: e.trade,
        division: `${code.slice(0, 2)} 00 00`, aliases: [], patternIds: [],
      };
      codePos.set(code, codeOrder.length);
      codeOrder.push(kc);
      stats.codesAdded++;
    }

    let anchor: number | null = null;
    for (const wantFiller of [false, true]) {
      for (let i = 0; i < tokens.length; i++) {
        if (noAnchor.has(tokens[i]) || filler.has(tokens[i]) !== wantFiller) continue;
        if (anchor === null || idfOf(tokens[i]) > idfOf(tokens[anchor]) + IDF_TIE_EPS) anchor = i;
      }
      if (anchor !== null) break;
    }
    const diff = new Set<number>();
    if (anchor !== null) diff.add(anchor);
    const pt = kc.parent ? titleTokens.get(kc.parent) : undefined;
    if (pt && pt.size) tokens.forEach((t, i) => { if (!pt.has(t)) diff.add(i); });

    const id = patterns.length;
    const pat: KbPattern = {
      id, code, source: "title", kind: "tokens", tokens,
      mass: tokens.map((t) => round4(idfOf(t) * (filler.has(t) ? OVERLAY_FILLER_FACTOR : 1))),
      diff: [...diff].filter((i) => !filler.has(tokens[i])).sort((a, b) => a - b),
      anchor, up: [], orderFree: false, text: e.description,
    };
    if (tokens.length === 1) pat.hintOnly = true;
    patterns.push(pat);
    stats.patternsAdded++;

    for (const t of tokens) {
      if (!tokenId.has(t)) tokenId.set(t, tokenId.size);
      if (!idf.has(t)) idf.set(t, defaultIdf);
    }
    let postKey = anchor;
    if (postKey === null) { // generic list: posted under its rarest token (loader rule)
      postKey = 0;
      for (let i = 1; i < tokens.length; i++) if (idfOf(tokens[i]) > idfOf(tokens[postKey]) + IDF_TIE_EPS) postKey = i;
    }
    const tid = tokenId.get(tokens[postKey]) as number;
    const adds = anchor !== null ? anchorAdds : genericAdds;
    const list = adds.get(tid);
    if (list) list.push(id);
    else adds.set(tid, [id]);

    const copy: KbCode = { ...kc, patternIds: [...kc.patternIds, id] };
    byCode.set(code, copy);
    codeOrder[codePos.get(code) as number] = copy;
  }

  const merge = (src: Map<number, Int32Array>, adds: Map<number, number[]>): Map<number, Int32Array> => {
    const out = new Map(src);
    for (const [tid, ids] of adds) {
      const prev = out.get(tid);
      const arr = new Int32Array((prev ? prev.length : 0) + ids.length);
      if (prev) arr.set(prev, 0);
      arr.set(ids, prev ? prev.length : 0);
      out.set(tid, arr);
    }
    return out;
  };
  const up = base.up.slice();
  for (let p = base.patterns.length; p < patterns.length; p++) up.push(new Int32Array(0));

  const kb: LoadedKb = {
    header: base.header,
    codes: codeOrder,
    patterns,
    byCode,
    tokenId,
    anchorIndex: merge(base.anchorIndex, anchorAdds),
    genericIndex: merge(base.genericIndex, genericAdds),
    up,
    idf,
    known: base.known,
  };
  return { kb, stats, defaultIdf };
}

const overlayMemo = new WeakMap<CsiDatabase, { base: LoadedKb; overlay: CsiOverlay }>();

/** The overlay for `custom` on `base`, built once per (custom bundle, base KB) and memoised on the
 *  bundle object (the company resolver caches one bundle per company per TTL, so this builds once). */
export function csiOverlayFor(base: LoadedKb, custom: CsiDatabase): CsiOverlay {
  const hit = overlayMemo.get(custom);
  if (hit && hit.base === base) return hit.overlay;
  const overlay = buildCsiOverlayKb(base, custom);
  overlayMemo.set(custom, { base, overlay });
  return overlay;
}
