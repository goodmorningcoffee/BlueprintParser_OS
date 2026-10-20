/**
 * csi-kb-types.ts — the CSI v2 knowledge-base shapes (IMPLEMENTATION.md §I).
 *
 * Client-safe: types only, no imports, no runtime code. The loader that builds a
 * `LoadedKb` lives in the server-only `csi-kb.ts` (S2); only its shape is pinned here.
 */

export type KbSource = 'title' | 'index' | 'alt' | 'see' | 'term' | 'tsv';
export type PatternKind = 'tokens' | 'regex';

export interface KbPattern {
  id: number;                 // dense 0..P-1
  code: string;               // spaced 'NN NN NN' | 'NN NN NN.NN'
  source: KbSource;
  kind: PatternKind;
  tokens: string[];           // canonical, in printed order (sets for index/term)
  mass: number[];             // per-token IDF weight (filler already halved)
  diff: number[];             // indices into tokens that are MANDATORY (lattice diff ∪ title-diff for titles)
  anchor: number | null;      // index into tokens; null ⇒ generic-list pattern (all tokens floored)
  up: number[];               // pattern ids this pattern extends (maximal subsets, other codes)
  orderFree: boolean;         // true for index/term sets
  oneWordOk?: boolean;        // only meaningful when tokens.length === 1
  hintOnly?: boolean;         // E6/E12: build-time = tokens.length === 1 && !oneWordOk; never yields spans
  discipline?: string;        // term rows only: 'A'|'S'|'M'|'P'|'E'|'FP'|'C'
  regex?: string;             // kind === 'regex' only (e.g. 'R-\\d+ INSULATION')
  text: string;               // original surface form, for triggers/debug
}

export interface KbCode {
  code: string; level: 2|3|4|5; parent: string | null; title: string; trade: string;
  division: string;           // 'NN 00 00'
  aliases: string[];          // tsv title when different, see-synonyms
  patternIds: number[];
}

export interface CsiKbHeader {
  schemaVersion: 'csi-kb/2'; builderVersion: string;
  sources: { path: string; sha256: string }[];   // pdf, csi-masterformat.tsv, csi.tsv, csi_terms.tsv, src/lib/csi-tokenize.ts (E12; sha of RAW bytes)
  counts: Record<string, number>;                 // codes, patterns by source, drops, … (informational)
  report: Record<string, number>;                 // §5.6 counters, exact key list E12a (all 0 except the two reach counters)
  floorTokens: string[]; fillerTokens: string[]; boilerplateTokens: string[];
  abbrevTokens: string[];                         // E12: canonical tokens of csi_terms `abbrev` rows → the runtime `known` set
}
export interface CsiKb { header: CsiKbHeader; codes: KbCode[]; patterns: KbPattern[]; }

/** Shape returned by `loadCsiKb()` in `csi-kb.ts` (server-only; S2). Layout per IMPLEMENTATION
 *  §IV E10 (amended 2026-10-20): tokens are interned to ids at load; `up*` is not precomputed. */
export interface LoadedKb extends CsiKb {
  byCode: Map<string, KbCode>;
  tokenId: Map<string, number>;                   // interned at load; the key set doubles as the fold vocab (E12b)
  anchorIndex: Map<number, Int32Array>;           // tokenId → pattern ids (anchor postings)
  genericIndex: Map<number, Int32Array>;          // tokenId → pattern ids with anchor === null
  up: Int32Array[];                               // per pattern id
  idf: Map<string, number>;                       // token → idf (string-keyed for callers/tests)
  known: Set<string>;                             // = header.abbrevTokens, passed to tokenize()/splitTextUnits()
}
