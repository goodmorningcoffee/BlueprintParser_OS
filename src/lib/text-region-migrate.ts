/**
 * text-region-migrate.ts
 *
 * Read-time migration from legacy `TextRegion` type values to the new union.
 * Legacy strings: "table-like", "notes-block", "spec-text", "key-value".
 * New strings:    "schedule-table", "notes-numbered", "spec-dense-columns", "notes-key-value".
 * "paragraph" is preserved in both schemas.
 *
 * Applied at every consumer that reads `pageIntelligence.textRegions` from DB
 * (pages processed before the Stage-1 classifier rewrite may carry legacy
 * values). Helpers are idempotent: passing an already-new region returns it
 * untouched.
 *
 * Used also by heuristic-rule-migrate.ts to translate rule-level
 * `textRegionType` filter strings so old rules targeting "notes-block"
 * automatically match new "notes-numbered" regions without DB edits.
 */

import type { TextRegion, TextRegionType, LegacyTextRegionType } from "@/types";

const LEGACY_TO_NEW: Record<LegacyTextRegionType, TextRegionType> = {
  "table-like": "schedule-table",
  "notes-block": "notes-numbered",
  "spec-text": "spec-dense-columns",
  "key-value": "notes-key-value",
};

/** Shape of a region as it may appear in legacy DB payloads. `type` may be
 *  a legacy or a new string; other fields match the old, narrower interface
 *  (no `lineCount`, `classifiedLabels`, or `grid`). */
export interface LegacyTextRegion {
  id: string;
  type: TextRegionType | LegacyTextRegionType;
  bbox: TextRegion["bbox"];
  confidence: number;
  csiTags?: TextRegion["csiTags"];
  wordCount: number;
  columnCount?: number;
  rowCount?: number;
  hasNumberedItems?: boolean;
  headerText?: string;
  containedText?: string;
  // new fields may or may not be present
  lineCount?: number;
  classifiedLabels?: TextRegion["classifiedLabels"];
  grid?: TextRegion["grid"];
}

/**
 * Map a legacy `TextRegionType` or new type string to the current union.
 * Returns input unchanged if already-new.
 */
export function migrateTextRegionType(
  t: TextRegionType | LegacyTextRegionType | string | undefined,
): TextRegionType | undefined {
  if (t === undefined) return undefined;
  if (t in LEGACY_TO_NEW) return LEGACY_TO_NEW[t as LegacyTextRegionType];
  // Any string matching a new union value is returned as-is; unknown strings
  // pass through typed as string → TextRegionType via the caller's narrowing.
  return t as TextRegionType;
}

/**
 * Normalize a region (legacy-or-new) to the current TextRegion shape.
 * Idempotent — passing an already-new region is a no-op structural copy.
 */
export function migrateTextRegion(r: LegacyTextRegion | TextRegion): TextRegion {
  const newType = migrateTextRegionType(r.type);
  return {
    id: r.id,
    type: (newType ?? "unknown") as TextRegionType,
    bbox: r.bbox,
    confidence: r.confidence,
    csiTags: r.csiTags,
    wordCount: r.wordCount,
    lineCount: (r as TextRegion).lineCount,
    columnCount: r.columnCount,
    rowCount: r.rowCount,
    hasNumberedItems: r.hasNumberedItems,
    headerText: r.headerText,
    classifiedLabels: (r as TextRegion).classifiedLabels,
    grid: (r as TextRegion).grid,
    containedText: r.containedText,
  };
}

/** Bulk helper: migrate an array of regions. Returns a new array. */
export function migrateTextRegions(
  regions: ReadonlyArray<LegacyTextRegion | TextRegion> | undefined,
): TextRegion[] | undefined {
  if (!regions) return undefined;
  return regions.map(migrateTextRegion);
}
