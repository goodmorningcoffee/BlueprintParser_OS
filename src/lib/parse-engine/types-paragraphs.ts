/**
 * Paragraph-engine sibling types (WP-3.C; PLAN §1.6 rule 13 — the contract in `./types` is not edited).
 *
 * Inputs and outputs of `paragraphs/segment.ts` (the segmenter) and `paragraphs/resolve.ts` (the §1.7
 * reference resolver). Imports only `./types`.
 */

import type {
  BboxMinMax,
  EngineLayoutBlock,
  StructureIndexV1,
  StructureKind,
  StructureParagraphDoc,
} from "./types";

// ── segmenter ───────────────────────────────────────────────────────────────────────────────────

/** A text line as the segmenter reads it (the `KvLine` shape of `paragraphs/kv-pairs.ts`): MinMax box, words optional. */
export interface SegmentLine {
  text: string;
  b: BboxMinMax;
  words?: readonly { t: string; b: BboxMinMax }[];
}

export type SegmentMode = "auto" | "keyed" | "kv";

export interface SegmentRequest {
  /** The region (MinMax). Lines whose centre lies inside are read; the others are ignored. */
  bbox: BboxMinMax;
  /** The page's lines (or already the region's). */
  lines: readonly SegmentLine[];
  /** Compact Textract LAYOUT blocks of the page, when stored; `list`/`text` blocks inside the box define columns. */
  layout?: readonly EngineLayoutBlock[];
  /** `notes` or `spec`; absent → detected (a SECTION / PART header or two spec articles → `spec`). */
  kind?: "notes" | "spec";
  /** `keyed` (numbered / lettered / tagged paragraphs), `kv` (key–value legend rows through kv-pairs), or `auto`. */
  mode?: SegmentMode;
}

export interface SegmentOptions {
  /** A vertical gutter must be at least this × the median line height wide. Default 1.5. */
  minGutterHeights?: number;
  /** A key column tolerance: a key token within this × the median line height of the block's key column is aligned. Default 1.0. */
  keyColumnTolHeights?: number;
  /** An unkeyed line after a vertical gap larger than this × the median line height starts a new paragraph. Default 2.0. */
  paragraphGapHeights?: number;
  /** kv mode: the split gap must exceed this share of the row width (the K09 binder's `KV_MIN_GAP_RATIO`). Default 0.05. */
  kvMinGapRatio?: number;
  /** kv mode: only keys at most this long feed the median split (the K09 binder's `KV_RIGHT_COL_MAX_LEN`). Default 20. */
  kvMaxKeyLen?: number;
  /** kv auto-detection needs at least this many pairs with a value. Default 3. */
  kvMinPairs?: number;
}

/** The segmenter's result: the model plus the per-line assignment (for tests and the workspace's split/merge preview). */
export interface SegmentResult {
  doc: StructureParagraphDoc;
  /** For each input line index inside the box: the paragraph id it joined, the block id it heads, or null (dropped). */
  assignment: { line: number; paragraph: string | null; header: string | null }[];
  /** Column boxes used (one when the region is single-column). */
  columns: BboxMinMax[];
}

// ── resolver (§1.7) ─────────────────────────────────────────────────────────────────────────────

/** Kind hint from the reference grammar (§1.7 rule 1). */
export type RefKindHint = "note" | "general-note" | "keynote" | "spec";

export interface ReferenceQuery {
  /** The page the mention is on (P). */
  page: number;
  /** The referenced key as printed ("4", "12", "2.3", "2.3.A"); "" for a bare spec-section reference. */
  key: string;
  /** Explicit sheet (S) as printed, when the mention names one. */
  sheet?: string | null;
  /** Kind hint (K). */
  kind: RefKindHint;
  /** Spec section (Σ) as printed ("08 71 00"), when the mention names one. */
  section?: string | null;
  /** The mention's box, for the same-region rule (4a). */
  b?: BboxMinMax;
  /** The region the mention lies in, when the caller already knows it (4a). */
  regionId?: string | null;
}

/** One row of the sheet → page map (a slim `pages(page_number, drawing_number)` select; hidden pages excluded). */
export interface ResolverSheet {
  page: number;
  /** The CURRENT drawing number, raw. */
  raw: string | null;
  /** The page title / name, when known (for "general sheets", rule 4c). */
  title?: string | null;
}

/** A paragraph block as the resolver needs it (built by `blocksSliceOf` from a committed doc). */
export interface ResolverBlock {
  regionId: string;
  blockId: string;
  headerNorm: string | null;
  continued?: true;
}

export interface ResolverIndex {
  regions: StructureIndexV1["regions"];
  keys: StructureIndexV1["keys"];
  specSections: StructureIndexV1["specSections"];
  sheets: readonly ResolverSheet[];
  /** Optional: enables `(CONT.)` chaining (rule 5) and GENERAL NOTES detection on blocks without keys. */
  blocks?: Record<string /* page */, readonly ResolverBlock[]>;
}

export type ResolveLevel = "explicit-sheet" | "spec-section" | "same-region" | "same-sheet" | "general-notes";

export interface ResolvedCandidate {
  page: number;
  /** The page's sheet key (null when it has no readable drawing number). */
  sheet: string | null;
  regionId: string;
  kind: StructureKind;
  targetId: string;
  blockHeaderNorm: string | null;
  /** `committed` (workspace) or `classic` (a classic-tool region); the service adds `auto` for its read-time fallback. */
  origin: "committed" | "classic";
  level: ResolveLevel;
}

export type ResolveOutcome =
  | { status: "resolved"; level: ResolveLevel; hit: ResolvedCandidate }
  | { status: "ambiguous"; level: ResolveLevel; candidates: ResolvedCandidate[] }
  | {
      status: "unresolved";
      reason: "no-sheet" | "no-section" | "no-candidates";
      /** Pages the service should run the instant segmenter on (rule 6), in priority order. */
      fallbackPages: number[];
    };
