// Duplicate-page detection: shared types + the stored mark (admin data tools, feature 2).
//
// The mark lives at pages.page_intelligence.duplicateOf. No schema change: page_intelligence
// is jsonb and unknown keys survive reprocess (src/lib/intelligence-merge.ts). It is typed here,
// NOT in src/types/index.ts (SHA-pinned declarations). Server-owned: updatePageIntelligence
// strips client copies of it.

/** exact = identical text · run = repeated sheet-number block ≥ 0.995 · near = ≥ 0.90 · possible = review. */
export type DuplicateTier = "exact" | "run" | "near" | "possible";

export const DUPLICATE_TIERS: readonly DuplicateTier[] = ["exact", "run", "near", "possible"];

/** One page as the detector sees it (stored columns only; no PDF or image is read). */
export interface DedupPageInput {
  pageNumber: number;
  drawingNumber: string | null;
  rawText: string | null;
}

/** A detected duplicate: `page` repeats `canonical` (the copy that stays visible by default). */
export interface DuplicatePair {
  page: number;
  canonical: number;
  tier: DuplicateTier;
  /** Jaccard of 3-word shingles with boilerplate (title-block lines, sheet number) removed. */
  content: number;
  /** Jaccard of 3-word shingles over the whole normalized text. Every bulk gate uses this. */
  full: number;
  /** Both drawing numbers non-null and equal. */
  sameNumber: boolean;
  /** Normalized texts identical. */
  identical: boolean;
  /** Id of the block this pair belongs to, or null for a lone pair (review only unless exact). */
  blockId: string | null;
}

/** Pages [start, start+length) repeated in order at [start+offset, start+offset+length). */
export interface DuplicateBlock {
  id: string;
  start: number;
  offset: number;
  length: number;
  tier: Exclude<DuplicateTier, "possible">;
  /** "repeat set" (exact/run) or "likely revision set" (near: same numbers, some text changed). */
  label: "repeat set" | "likely revision set";
  minContent: number;
  minFull: number;
}

export interface DuplicateCounts {
  pages: number;
  /** Pages with too little non-boilerplate text to compare (blank sheets hash alike). */
  blank: number;
  exact: number;
  run: number;
  near: number;
  possible: number;
  blocks: number;
}

export interface DuplicateReport {
  counts: DuplicateCounts;
  blocks: DuplicateBlock[];
  /** One entry per duplicate page (`page` unique), sorted by page. */
  pairs: DuplicatePair[];
  /** Non-null ⇒ "remove all" skips this project (it shows revision evidence); why, in words. */
  bulkHold: string | null;
}

export type DuplicateKeep = "latest" | "earliest";

/** Stored at pages.page_intelligence.duplicateOf. */
export interface DuplicateMark {
  v: 1;
  /** The canonical page this page duplicates (same project). Page numbers never change. */
  pageNumber: number;
  tier: DuplicateTier;
  /** The pair's `full` score (1 for exact). */
  score: number;
  content: number;
  full: number;
  /** ISO time of the scan the apply was checked against. */
  scannedAt: string;
  /** ISO time the page was hidden. Present ⇔ hidden (restore removes the whole mark). */
  hiddenAt?: string;
  /** Reserved for v1.1 cross-project marks (canonical page lives in another project). */
  project?: string;
  /** users.id of the admin who applied it. */
  by?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read the mark from an untrusted page_intelligence value; null when absent or malformed. */
export function getDuplicateOf(pageIntelligence: unknown): DuplicateMark | null {
  if (!isRecord(pageIntelligence)) return null;
  const mark = pageIntelligence.duplicateOf;
  if (!isRecord(mark)) return null;
  if (typeof mark.pageNumber !== "number" || !Number.isInteger(mark.pageNumber)) return null;
  if (typeof mark.tier !== "string" || !DUPLICATE_TIERS.includes(mark.tier as DuplicateTier)) return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    v: 1,
    pageNumber: mark.pageNumber,
    tier: mark.tier as DuplicateTier,
    score: num(mark.score),
    content: num(mark.content),
    full: num(mark.full),
    scannedAt: typeof mark.scannedAt === "string" ? mark.scannedAt : "",
    ...(typeof mark.hiddenAt === "string" ? { hiddenAt: mark.hiddenAt } : {}),
    ...(typeof mark.project === "string" ? { project: mark.project } : {}),
    ...(typeof mark.by === "number" ? { by: mark.by } : {}),
  };
}

/** True when the page is a hidden duplicate (excluded from page list, search, chat, LLM tools). */
export function isHiddenDuplicate(pageIntelligence: unknown): boolean {
  return Boolean(getDuplicateOf(pageIntelligence)?.hiddenAt);
}
