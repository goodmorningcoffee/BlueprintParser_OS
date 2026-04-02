/**
 * text-region-classifier.ts
 *
 * System 1: OCR-based text region classification.
 * Analyzes OCR word positions to detect table-like structures, notes blocks,
 * spec text, key-value layouts, and paragraph regions.
 *
 * Pure OCR — no YOLO needed. Runs during processing after Textract.
 * Produces CSI-tagged TextRegion[] stored in page_intelligence.textRegions.
 */

import type {
  TextractPageData,
  TextractWord,
  TextRegion,
  TextRegionType,
  CsiCode,
  BboxLTWH,
} from "@/types";
import { mergeBbox, wordsToText, bboxCenterLTWH } from "@/lib/ocr-utils";
import { ROW_Y_TOLERANCE, COL_X_TOLERANCE } from "@/lib/spatial-constants";

// ═══════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════

const COL_TOLERANCE = COL_X_TOLERANCE;
const ROW_TOLERANCE = ROW_Y_TOLERANCE;
const MIN_COLS = 3;            // Minimum columns for table-like classification
const MIN_ROWS = 3;            // Minimum rows for table-like classification
const NARROW_COL_MAX = 0.35;   // Max X-range for spec-text classification
const MIN_REGION_WORDS = 5;    // Minimum words to consider as a region

const HEADER_KEYWORDS = new Set([
  "SCHEDULE", "KEYNOTE", "KEYNOTES", "KEY NOTES", "LEGEND", "SYMBOL",
  "GENERAL NOTES", "NOTES", "DRAWING NOTES", "SHEET NOTES",
  "DOOR SCHEDULE", "FINISH SCHEDULE", "WINDOW SCHEDULE",
  "EQUIPMENT SCHEDULE", "ROOM FINISH", "SPECIFICATIONS",
]);

const RE_NUMBERED_ITEM = /^(\d+)\.\s*/;
const RE_ALPHA_ITEM = /^[a-zA-Z]\.\s*/;

// ═══════════════════════════════════════════════════════════════════
// Word Clustering
// ═══════════════════════════════════════════════════════════════════

interface WordCluster {
  words: TextractWord[];
  bbox: BboxLTWH;
  xRange: [number, number];
  yRange: [number, number];
}

/**
 * Cluster words into spatial groups by proximity.
 * Words that are close in Y and share X ranges get grouped.
 */
function clusterWords(words: TextractWord[]): WordCluster[] {
  if (words.length === 0) return [];

  // Sort by Y then X
  const sorted = [...words].sort((a, b) => {
    const dy = a.bbox[1] - b.bbox[1];
    if (Math.abs(dy) > ROW_TOLERANCE * 3) return dy;
    return a.bbox[0] - b.bbox[0];
  });

  // Group into spatial clusters using gap detection
  const clusters: WordCluster[] = [];
  let current: TextractWord[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const word = sorted[i];
    const yGap = word.bbox[1] - (prev.bbox[1] + prev.bbox[3]);

    // Large Y gap = new cluster
    if (yGap > ROW_TOLERANCE * 8) {
      if (current.length >= MIN_REGION_WORDS) {
        clusters.push(buildCluster(current));
      }
      current = [word];
    } else {
      current.push(word);
    }
  }
  if (current.length >= MIN_REGION_WORDS) {
    clusters.push(buildCluster(current));
  }

  return clusters;
}

function buildCluster(words: TextractWord[]): WordCluster {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const w of words) {
    minX = Math.min(minX, w.bbox[0]);
    maxX = Math.max(maxX, w.bbox[0] + w.bbox[2]);
    minY = Math.min(minY, w.bbox[1]);
    maxY = Math.max(maxY, w.bbox[1] + w.bbox[3]);
  }
  return {
    words,
    bbox: mergeBbox(words),
    xRange: [minX, maxX],
    yRange: [minY, maxY],
  };
}

// ═══════════════════════════════════════════════════════════════════
// Column/Row Detection
// ═══════════════════════════════════════════════════════════════════

/** Find column positions — X-coordinates shared by many words. */
function detectColumns(words: TextractWord[]): number[] {
  // Collect left-edge X positions
  const xPositions = words.map(w => Math.round(w.bbox[0] / COL_TOLERANCE) * COL_TOLERANCE);
  const xCounts = new Map<number, number>();
  for (const x of xPositions) {
    xCounts.set(x, (xCounts.get(x) || 0) + 1);
  }

  // Columns: X positions appearing in 3+ words
  return [...xCounts.entries()]
    .filter(([, count]) => count >= 3)
    .sort(([a], [b]) => a - b)
    .map(([x]) => x);
}

/** Find row positions — Y-coordinates shared by many words. */
function detectRows(words: TextractWord[]): number[] {
  const yPositions = words.map(w => Math.round(w.bbox[1] / ROW_TOLERANCE) * ROW_TOLERANCE);
  const yCounts = new Map<number, number>();
  for (const y of yPositions) {
    yCounts.set(y, (yCounts.get(y) || 0) + 1);
  }

  return [...yCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort(([a], [b]) => a - b)
    .map(([y]) => y);
}

// ═══════════════════════════════════════════════════════════════════
// Region Classification
// ═══════════════════════════════════════════════════════════════════

function classifyCluster(cluster: WordCluster): { type: TextRegionType; confidence: number; columns: number; rows: number; hasNumbered: boolean } {
  const { words, xRange } = cluster;
  const columns = detectColumns(words);
  const rows = detectRows(words);
  const xWidth = xRange[1] - xRange[0];

  // Check for numbered items
  const numberedCount = words.filter(w => RE_NUMBERED_ITEM.test(w.text) || RE_ALPHA_ITEM.test(w.text)).length;
  const hasNumbered = numberedCount >= 2;

  // Table-like: 3+ columns AND 3+ rows with consistent spacing
  if (columns.length >= MIN_COLS && rows.length >= MIN_ROWS) {
    return { type: "table-like", confidence: 0.7 + Math.min(columns.length, 10) * 0.02, columns: columns.length, rows: rows.length, hasNumbered };
  }

  // Notes block: numbered items stacked vertically
  if (hasNumbered && numberedCount >= 3) {
    return { type: "notes-block", confidence: 0.6 + Math.min(numberedCount, 10) * 0.03, columns: columns.length, rows: rows.length, hasNumbered: true };
  }

  // Key-value: exactly 2 prominent columns, multiple rows
  if (columns.length === 2 && rows.length >= 3) {
    return { type: "key-value", confidence: 0.65, columns: 2, rows: rows.length, hasNumbered };
  }

  // Spec-text: narrow column, high word density
  if (xWidth < NARROW_COL_MAX && words.length > 30) {
    return { type: "spec-text", confidence: 0.55, columns: columns.length, rows: rows.length, hasNumbered };
  }

  // Default: paragraph
  return { type: "paragraph", confidence: 0.3, columns: columns.length, rows: rows.length, hasNumbered };
}

/** Scan for header keywords in the top portion of a word cluster. */
function detectHeader(words: TextractWord[]): string | null {
  // Look at top 20% of words by Y position
  const sorted = [...words].sort((a, b) => a.bbox[1] - b.bbox[1]);
  const topCount = Math.max(5, Math.ceil(sorted.length * 0.2));
  const topWords = sorted.slice(0, topCount);

  // Build sliding text from top words
  const topText = topWords.map(w => w.text).join(" ").toUpperCase();

  for (const keyword of HEADER_KEYWORDS) {
    if (topText.includes(keyword)) return keyword;
  }
  return null;
}

/** Infer CSI codes from contained text annotations and keywords. */
function inferCsiTags(words: TextractWord[], csiCodes: CsiCode[]): CsiCode[] {
  if (!csiCodes.length) return [];

  const text = words.map(w => w.text.toLowerCase()).join(" ");
  const matches: CsiCode[] = [];

  for (const csi of csiCodes) {
    const descWords = csi.description.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    if (descWords.length === 0) continue;
    const overlap = descWords.filter(w => text.includes(w)).length;
    if (overlap >= Math.ceil(descWords.length * 0.4)) {
      matches.push(csi);
    }
  }

  // Deduplicate
  const seen = new Set<string>();
  return matches.filter(c => {
    if (seen.has(c.code)) return false;
    seen.add(c.code);
    return true;
  });
}

// ═══════════════════════════════════════════════════════════════════
// Main Export
// ═══════════════════════════════════════════════════════════════════

/**
 * Classify text regions on a page from OCR word positions.
 * Returns CSI-tagged TextRegion[] for storage in page_intelligence.textRegions.
 */
export function classifyTextRegions(
  textractData: TextractPageData,
  csiCodes: CsiCode[],
): TextRegion[] {
  if (!textractData?.words?.length) return [];

  // Filter out tiny words (likely noise) and title block region (bottom 15%)
  const words = textractData.words.filter(w =>
    w.text.length > 0 && (w.bbox[1] + w.bbox[3]) < 0.88
  );

  if (words.length < MIN_REGION_WORDS) return [];

  const clusters = clusterWords(words);
  const regions: TextRegion[] = [];
  let regionId = 0;

  for (const cluster of clusters) {
    const { type, confidence, columns, rows, hasNumbered } = classifyCluster(cluster);

    // Skip low-confidence paragraphs (too noisy)
    if (type === "paragraph" && confidence < 0.4) continue;

    const header = detectHeader(cluster.words);
    const csiTags = inferCsiTags(cluster.words, csiCodes);
    const containedText = wordsToText(cluster.words);

    // Boost confidence if header keyword found
    const boostedConfidence = header ? Math.min(confidence + 0.15, 0.99) : confidence;

    regions.push({
      id: `region-${regionId++}`,
      type,
      bbox: cluster.bbox,
      confidence: boostedConfidence,
      csiTags: csiTags.length > 0 ? csiTags : undefined,
      wordCount: cluster.words.length,
      columnCount: columns > 0 ? columns : undefined,
      rowCount: rows > 0 ? rows : undefined,
      hasNumberedItems: hasNumbered || undefined,
      headerText: header || undefined,
      containedText: containedText.length > 500 ? containedText.substring(0, 500) + "..." : containedText,
    });
  }

  // Sort by confidence descending
  regions.sort((a, b) => b.confidence - a.confidence);
  return regions;
}
