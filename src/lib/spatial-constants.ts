/**
 * spatial-constants.ts
 *
 * Centralized spatial thresholds and tolerances used across
 * the blueprint spatial reasoning pipeline. Import from here
 * instead of hardcoding magic numbers in individual modules.
 */

// ─── Page zone thresholds (normalized 0-1) ───────────────────
export const TITLE_BLOCK_Y_THRESHOLD = 0.85;
export const RIGHT_MARGIN_X_THRESHOLD = 0.75;
export const DEFAULT_TITLE_BLOCK_REGION = { minX: 0.45, minY: 0.7, maxX: 1.0, maxY: 1.0 } as const;

// ─── OCR clustering tolerances ───────────────────────────────
export const ROW_Y_TOLERANCE = 0.006;
export const COL_X_TOLERANCE = 0.02;
export const COL_X_GAP_MIN = 0.03;
