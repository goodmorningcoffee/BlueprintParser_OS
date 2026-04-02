/**
 * ocr-utils.ts
 *
 * Shared OCR/bbox utilities extracted from text-annotations.ts and spatial.ts.
 * Single source of truth for word proximity, bbox math, and text grouping.
 */

import type {
  TextractWord,
  TextAnnotationType,
  AnnotationCategory,
  TextAnnotation,
  BboxLTWH,
  BboxMinMax,
} from "@/types";

// ═══════════════════════════════════════════════════════════════════
// Bbox primitives — re-exported from canonical source (bbox-utils.ts)
// ═══════════════════════════════════════════════════════════════════

export {
  ltwh2minmax,
  minmax2ltwh,
  bboxCenterLTWH,
  bboxCenterMinMax,
  bboxContainsPoint,
  bboxAreaMinMax,
  bboxAreaLTWH,
} from "@/lib/bbox-utils";

// ═══════════════════════════════════════════════════════════════════
// Word proximity helpers
// ═══════════════════════════════════════════════════════════════════

/** Check if two words are on the same line (y-centers within 1.5x avg height). */
export function isSameLine(a: TextractWord, b: TextractWord): boolean {
  const aCenter = a.bbox[1] + a.bbox[3] / 2;
  const bCenter = b.bbox[1] + b.bbox[3] / 2;
  const avgHeight = (a.bbox[3] + b.bbox[3]) / 2;
  return Math.abs(aCenter - bCenter) < avgHeight * 1.5;
}

/** Check spatial adjacency: same line and horizontally close. */
export function isAdjacent(a: TextractWord, b: TextractWord): boolean {
  if (!isSameLine(a, b)) return false;
  const aRight = a.bbox[0] + a.bbox[2];
  const gap = b.bbox[0] - aRight;
  const avgWidth = (a.bbox[2] + b.bbox[2]) / 2;
  return gap < avgWidth * 2 && gap > -avgWidth * 0.5;
}

/** Merge bounding boxes from multiple words. Returns LTWH format. */
export function mergeBbox(words: TextractWord[]): BboxLTWH {
  if (words.length === 0) return [0, 0, 0, 0];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const w of words) {
    const left = w.bbox[0];
    const top = w.bbox[1];
    const right = left + w.bbox[2];
    const bottom = top + w.bbox[3];
    if (left < minX) minX = left;
    if (top < minY) minY = top;
    if (right > maxX) maxX = right;
    if (bottom > maxY) maxY = bottom;
  }
  return [minX, minY, maxX - minX, maxY - minY];
}

/** Average confidence of a set of words. */
export function avgConf(words: TextractWord[]): number {
  if (words.length === 0) return 0;
  return words.reduce((sum, w) => sum + w.confidence, 0) / words.length;
}

// ═══════════════════════════════════════════════════════════════════
// Sliding window & annotation creation
// ═══════════════════════════════════════════════════════════════════

/** Yield contiguous groups of 1..maxLen adjacent words. */
export function* slidingWindow(words: TextractWord[], maxLen: number): Generator<{
  group: TextractWord[];
  indices: number[];
  text: string;
}> {
  for (let start = 0; start < words.length; start++) {
    const group: TextractWord[] = [words[start]];
    const indices: number[] = [start];
    yield { group: [...group], indices: [...indices], text: words[start].text };

    for (let end = start + 1; end < words.length && end < start + maxLen; end++) {
      if (!isAdjacent(words[end - 1], words[end])) break;
      group.push(words[end]);
      indices.push(end);
      yield {
        group: [...group],
        indices: [...indices],
        text: group.map(w => w.text).join(" "),
      };
    }
  }
}

/** Create a TextAnnotation from words. */
export function makeAnnotation(
  type: TextAnnotationType,
  category: AnnotationCategory,
  words: TextractWord[],
  wordIndices: number[],
  confidence: number,
  extra?: { group?: string; note?: string; meta?: Record<string, unknown> },
): TextAnnotation {
  return {
    type,
    category,
    text: words.map(w => w.text).join(" "),
    bbox: mergeBbox(words),
    confidence,
    wordIndices,
    ...extra,
  };
}

/** Find the index of a word in the full words array by bbox proximity. */
export function findWordIndex(words: TextractWord[], target: TextractWord): number {
  for (let i = 0; i < words.length; i++) {
    if (words[i].bbox[0] === target.bbox[0]
        && words[i].bbox[1] === target.bbox[1]
        && words[i].text === target.text) {
      return i;
    }
  }
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < words.length; i++) {
    const dx = words[i].bbox[0] - target.bbox[0];
    const dy = words[i].bbox[1] - target.bbox[1];
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

// ═══════════════════════════════════════════════════════════════════
// Text grouping (shared by spatial.ts and text-annotations.ts)
// ═══════════════════════════════════════════════════════════════════

const LINE_Y_THRESHOLD = 0.005;

/**
 * Convert a list of words to readable text by sorting into lines
 * (top-to-bottom, left-to-right) and grouping by Y proximity.
 */
export function wordsToText(words: TextractWord[]): string {
  if (words.length === 0) return "";

  const sorted = [...words].sort((a, b) => {
    const ya = a.bbox[1];
    const yb = b.bbox[1];
    if (Math.abs(ya - yb) > LINE_Y_THRESHOLD) return ya - yb;
    return a.bbox[0] - b.bbox[0];
  });

  const lines: string[] = [];
  let currentLine: string[] = [];
  let currentY = sorted[0].bbox[1];

  for (const word of sorted) {
    if (Math.abs(word.bbox[1] - currentY) > LINE_Y_THRESHOLD) {
      if (currentLine.length > 0) lines.push(currentLine.join(" "));
      currentLine = [];
      currentY = word.bbox[1];
    }
    currentLine.push(word.text);
  }
  if (currentLine.length > 0) lines.push(currentLine.join(" "));

  return lines.join("\n");
}
