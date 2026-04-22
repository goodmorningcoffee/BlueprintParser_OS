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

// ─── Text region classifier (Stage B–F tunables) ─────────────
// Used by text-region-classifier.ts. Consolidated here so thresholds
// can be audited in one place and adjusted without code-diving.

/** Stage B: Y-gap tolerance = factor × median line height. */
export const CLUSTER_Y_TOLERANCE_FACTOR = 0.5;

/** Stage B: X-bound tolerance for column-band clustering (normalized). */
export const CLUSTER_X_TOLERANCE = 0.02;

/** Stage D: Minimum IoU to draw a merge edge between cluster candidates. */
export const UNION_FIND_IOU_THRESHOLD = 0.4;

/** Stage D: Minimum containment ratio (max of IoS_a, IoS_b) to merge.
 *  Catches nested-box cases IoU misses (Docling's insight). */
export const UNION_FIND_CONTAIN_THRESHOLD = 0.6;

/** Stage C: Minimum inscribed rectangle area (as fraction of mask area)
 *  to qualify as a gutter candidate. */
export const WHITESPACE_RECT_MIN_AREA_FRACTION = 0.02;

/** Stage C: Height/width ratio above which a rectangle is classified as
 *  a vertical column gutter (below this, paragraph break). */
export const WHITESPACE_RECT_GUTTER_RATIO = 3.0;

/** Stage C: Mask resolution for rasterized word bboxes. */
export const CLASSIFIER_MASK_WIDTH = 500;
export const CLASSIFIER_MASK_HEIGHT = 700;

/** Stage E: A line is a candidate header if its median char height
 *  is at least this multiple of the cluster's median line height. */
export const HEADER_FONT_RATIO = 1.3;

/** Stage F: Fraction of lines starting with a numbered item to classify
 *  as `notes-numbered`. */
export const NUMBERED_RATIO_THRESHOLD = 0.6;

/** Stage F: Mean right-column string length cap for `notes-key-value`. */
export const KV_RIGHT_COL_MAX_LEN = 20;

/** Stage F: Maximum region width (normalized) for `spec-dense-columns`. */
export const SPEC_NARROW_MAX_WIDTH = 0.35;

/** Stage F: Minimum word count for `spec-dense-columns`. */
export const SPEC_MIN_WORD_COUNT = 50;

/** Stage F: Below this score, a region is labeled `unknown` instead of
 *  `paragraph`. Separates "low-confidence prose" from "undetermined pattern". */
export const CLASSIFIER_MIN_CONFIDENCE = 0.4;

/** Stage F: Minimum total word count for a region to be emitted at all.
 *  Prevents stray 1-2-word clusters from polluting pageIntelligence. */
export const CLASSIFIER_MIN_REGION_WORDS = 5;

/** Stage C skip-gate: only run whitespace-rectangle detection when there
 *  are enough words AND Stage B detected multi-column content. */
export const CLASSIFIER_WHITESPACE_SKIP_WORD_COUNT = 200;
