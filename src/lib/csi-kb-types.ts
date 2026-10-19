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
  sources: { path: string; sha256: string }[];   // pdf, tsv, csi.tsv, csi_terms.tsv
  counts: Record<string, number>;                 // codes, patterns by source, …
  report: Record<string, number>;                 // §5.6 counters (all must be 0 except the two reach counters)
  floorTokens: string[]; fillerTokens: string[]; boilerplateTokens: string[];
}
export interface CsiKb { header: CsiKbHeader; codes: KbCode[]; patterns: KbPattern[]; }

/** Shape returned by `loadCsiKb()` in `csi-kb.ts` (server-only; S2). */
export interface LoadedKb extends CsiKb {
  byCode: Map<string, KbCode>;
  anchorIndex: Map<string, Int32Array>;           // token → pattern ids (anchor postings)
  genericIndex: Map<string, Int32Array>;          // token → pattern ids with anchor === null
  idf: Map<string, number>;
}
