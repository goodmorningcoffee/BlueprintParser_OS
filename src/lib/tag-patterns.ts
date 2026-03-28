/**
 * tag-patterns.ts
 *
 * Spatial tag pattern detection: correlate YOLO bounding boxes with OCR text
 * to find repeating patterns (e.g., circles containing "T-01", "T-02" = tile tags).
 *
 * Runs after YOLO load (not at processing time) since it needs both YOLO + OCR data.
 */

import type { TextractPageData, TextractWord, BboxMinMax } from "@/types";
import { bboxCenterLTWH, bboxContainsPoint } from "@/lib/ocr-utils";

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

export interface TagInstance {
  pageNumber: number;
  yoloBbox: BboxMinMax;
  text: string;
  annotationId: number;
}

export interface TagGroup {
  id: string;                    // "circle_T"
  yoloClass: string;             // "circle"
  textPattern: string;           // "T-##"
  regexPattern: string;          // "T-\\d+"
  displayName: string;           // "Circle Tags (T-series)"
  instances: TagInstance[];
  pageCount: number;
  uniqueValues: string[];        // ["T-01", "T-02", ...]
  confidence: "confirmed" | "possible";
}

interface YoloDetectionInput {
  id: number;
  name: string;           // yolo class
  pageNumber: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// ═══════════════════════════════════════════════════════════════════
// Core Algorithm
// ═══════════════════════════════════════════════════════════════════

/**
 * For each YOLO detection, find OCR words whose center falls inside the bbox.
 * Group detections by (class + text prefix pattern). Return tag groups.
 */
export function detectTagPatterns(
  pageTextract: Record<number, TextractPageData>,
  yoloDetections: YoloDetectionInput[],
  minInstances: number = 3,
): TagGroup[] {
  if (yoloDetections.length === 0) return [];

  // Step 1: For each detection, find overlapping OCR words
  const tuples: { yoloClass: string; text: string; page: number; bbox: BboxMinMax; annId: number }[] = [];

  for (const det of yoloDetections) {
    const pageData = pageTextract[det.pageNumber];
    if (!pageData?.words?.length) continue;

    const detBbox: BboxMinMax = [det.minX, det.minY, det.maxX, det.maxY];
    const overlapping: TextractWord[] = [];

    for (const word of pageData.words) {
      const center = bboxCenterLTWH(word.bbox);
      if (bboxContainsPoint(detBbox, center)) {
        overlapping.push(word);
      }
    }

    if (overlapping.length === 0) continue;

    // Sort left-to-right, concatenate
    overlapping.sort((a, b) => a.bbox[0] - b.bbox[0]);
    const text = overlapping.map(w => w.text).join(" ").trim();
    if (!text) continue;

    tuples.push({
      yoloClass: det.name,
      text,
      page: det.pageNumber,
      bbox: detBbox,
      annId: det.id,
    });
  }

  if (tuples.length === 0) return [];

  // Step 2: Group by (class + prefix pattern)
  const groupMap = new Map<string, {
    yoloClass: string;
    prefix: string;
    instances: TagInstance[];
    values: Set<string>;
    pages: Set<number>;
  }>();

  for (const t of tuples) {
    const prefix = extractPrefix(t.text);
    if (!prefix) continue;

    const key = `${t.yoloClass}__${prefix}`;
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        yoloClass: t.yoloClass,
        prefix,
        instances: [],
        values: new Set(),
        pages: new Set(),
      });
    }
    const group = groupMap.get(key)!;
    group.instances.push({
      pageNumber: t.page,
      yoloBbox: t.bbox,
      text: t.text,
      annotationId: t.annId,
    });
    group.values.add(t.text);
    group.pages.add(t.page);
  }

  // Step 3: Build TagGroup objects, filter by min instances
  const results: TagGroup[] = [];
  for (const [key, g] of groupMap) {
    const confidence = g.instances.length >= minInstances ? "confirmed" : "possible";
    if (confidence === "possible" && g.instances.length < 2) continue;

    const regexPattern = buildRegexPattern(g.prefix);
    results.push({
      id: `${g.yoloClass}_${g.prefix.replace(/[^a-zA-Z0-9]/g, "")}`,
      yoloClass: g.yoloClass,
      textPattern: `${g.prefix}##`,
      regexPattern,
      displayName: `${g.yoloClass} tags (${g.prefix}-series)`,
      instances: g.instances,
      pageCount: g.pages.size,
      uniqueValues: [...g.values].sort(),
      confidence,
    });
  }

  // Sort by instance count descending
  results.sort((a, b) => b.instances.length - a.instances.length);
  return results;
}

// ═══════════════════════════════════════════════════════════════════
// Pattern Extraction
// ═══════════════════════════════════════════════════════════════════

/**
 * Extract the prefix pattern from detection text.
 * "T-01" → "T-", "EQ-101A" → "EQ-", "3" → null (no prefix)
 */
function extractPrefix(text: string): string | null {
  const normalized = text.trim().toUpperCase();
  if (!normalized) return null;

  // Pattern: letters + separator + digits (e.g., T-01, EQ-101, P.03)
  const match = /^([A-Z]{1,4}[-.]?)/.exec(normalized);
  if (match && /\d/.test(normalized.slice(match[1].length))) {
    return match[1];
  }

  // Pure numeric (e.g., keynote numbers: "1", "2", "3")
  if (/^\d+$/.test(normalized) && normalized.length <= 3) {
    return "#";
  }

  return null;
}

/** Build a regex pattern from a prefix. "T-" → "T-\\d+" */
function buildRegexPattern(prefix: string): string {
  if (prefix === "#") return "\\d+";
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `${escaped}\\d+`;
}
