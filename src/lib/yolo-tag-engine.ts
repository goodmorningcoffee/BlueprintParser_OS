/**
 * yolo-tag-engine.ts — Shared YOLO-tag mapping engine.
 *
 * Finds all YOLO annotations (optionally filtered by class/model) where
 * the OCR text inside the bbox matches a target tag text. Used by:
 *   1. Keynote parser (page-scoped)
 *   2. Schedule/table parser (project-wide)
 *   3. Manual "Create Tag" tool (project-wide)
 *
 * Also supports free-floating tags (no YOLO shape) by searching OCR words
 * directly across pages.
 */

import type {
  ClientAnnotation,
  TextractPageData,
  BboxMinMax,
  YoloTagInstance,
} from "@/types";
import { bboxCenterLTWH, bboxContainsPoint, ltwh2minmax } from "@/lib/ocr-utils";

export interface MapYoloToOcrOptions {
  tagText: string;
  yoloClass?: string;       // "" or undefined = free-floating (no YOLO filter)
  yoloModel?: string;       // "" or undefined = any model
  scope: "page" | "project";
  pageNumber?: number;       // required when scope === "page"
  annotations: ClientAnnotation[];
  textractData: Record<number, TextractPageData>;
}

/**
 * Find all YOLO annotation instances where the OCR text inside matches `tagText`.
 * For free-floating mode (no yoloClass), searches OCR words directly.
 */
export function mapYoloToOcrText(opts: MapYoloToOcrOptions): YoloTagInstance[] {
  const { tagText, yoloClass, yoloModel, scope, pageNumber, annotations, textractData } = opts;
  if (!tagText.trim()) return [];

  const normalizedTag = tagText.toUpperCase().trim();
  const isFreeFloating = !yoloClass;

  if (isFreeFloating) {
    return findFreeFloatingMatches(normalizedTag, scope, pageNumber, textractData);
  }

  return findYoloMatches(normalizedTag, yoloClass!, yoloModel, scope, pageNumber, annotations, textractData);
}

/** Find matches inside YOLO annotation bboxes. */
function findYoloMatches(
  normalizedTag: string,
  yoloClass: string,
  yoloModel: string | undefined,
  scope: "page" | "project",
  pageNumber: number | undefined,
  annotations: ClientAnnotation[],
  textractData: Record<number, TextractPageData>,
): YoloTagInstance[] {
  // Filter annotations by class + model + page
  const filtered = annotations.filter((a) => {
    if (a.source !== "yolo") return false;
    if (a.name !== yoloClass) return false;
    if (yoloModel && (a.data as any)?.modelName !== yoloModel) return false;
    if (scope === "page" && pageNumber != null && a.pageNumber !== pageNumber) return false;
    return true;
  });

  const instances: YoloTagInstance[] = [];

  for (const ann of filtered) {
    const words = textractData[ann.pageNumber]?.words;
    if (!words || words.length === 0) continue;

    const annBbox: BboxMinMax = [ann.bbox[0], ann.bbox[1], ann.bbox[2], ann.bbox[3]];

    // Find OCR words whose center falls inside this annotation
    const insideWords = words.filter((w) => {
      const center = bboxCenterLTWH(w.bbox);
      return bboxContainsPoint(annBbox, center);
    });

    if (insideWords.length === 0) continue;

    // Concatenate words left-to-right
    const candidateText = insideWords
      .sort((a, b) => a.bbox[0] - b.bbox[0])
      .map((w) => w.text)
      .join(" ")
      .toUpperCase()
      .trim();

    if (!candidateText) continue;

    // Exact match
    if (candidateText === normalizedTag) {
      instances.push({
        pageNumber: ann.pageNumber,
        annotationId: ann.id,
        bbox: ann.bbox,
        confidence: 1.0,
      });
      continue;
    }

    // Fuzzy match: edit distance <= 1, but only for text >= 3 chars
    // Short text (1-2 chars) like single digits must match exactly —
    // otherwise "3" matches "8" (edit distance 1) which is wrong
    if (normalizedTag.length >= 3 && candidateText.length >= 3 && editDistance(candidateText, normalizedTag) <= 1) {
      instances.push({
        pageNumber: ann.pageNumber,
        annotationId: ann.id,
        bbox: ann.bbox,
        confidence: 0.9,
      });
    }
  }

  return instances;
}

/** Find free-floating tag matches in OCR words (no YOLO annotation required). */
function findFreeFloatingMatches(
  normalizedTag: string,
  scope: "page" | "project",
  pageNumber: number | undefined,
  textractData: Record<number, TextractPageData>,
): YoloTagInstance[] {
  const instances: YoloTagInstance[] = [];
  const pageNums = scope === "page" && pageNumber != null
    ? [pageNumber]
    : Object.keys(textractData).map(Number);

  const tagWords = normalizedTag.split(/\s+/);

  for (const pn of pageNums) {
    const words = textractData[pn]?.words;
    if (!words || words.length === 0) continue;

    if (tagWords.length === 1) {
      // Single-word tag: scan each word
      for (const w of words) {
        const wText = w.text.toUpperCase().trim();
        if (wText === normalizedTag || editDistance(wText, normalizedTag) <= 1) {
          const mm = ltwh2minmax(w.bbox);
          instances.push({
            pageNumber: pn,
            annotationId: -1,
            bbox: [mm[0], mm[1], mm[2], mm[3]],
            confidence: wText === normalizedTag ? 1.0 : 0.9,
          });
        }
      }
    } else {
      // Multi-word tag: sliding window over adjacent words
      for (let i = 0; i <= words.length - tagWords.length; i++) {
        const window = words.slice(i, i + tagWords.length);
        const windowText = window.map((w) => w.text).join(" ").toUpperCase().trim();
        if (windowText === normalizedTag || editDistance(windowText, normalizedTag) <= 1) {
          // Merge bboxes of all words in the match
          const minX = Math.min(...window.map((w) => w.bbox[0]));
          const minY = Math.min(...window.map((w) => w.bbox[1]));
          const maxX = Math.max(...window.map((w) => w.bbox[0] + w.bbox[2]));
          const maxY = Math.max(...window.map((w) => w.bbox[1] + w.bbox[3]));
          instances.push({
            pageNumber: pn,
            annotationId: -1,
            bbox: [minX, minY, maxX, maxY],
            confidence: windowText === normalizedTag ? 1.0 : 0.9,
          });
        }
      }
    }
  }

  return instances;
}

/**
 * Get the OCR text inside a YOLO annotation bbox on a given page.
 * Used by "Create Tag" to read text from a clicked annotation.
 */
export function getOcrTextInAnnotation(
  annotation: ClientAnnotation,
  textractData: Record<number, TextractPageData>,
): string {
  const words = textractData[annotation.pageNumber]?.words;
  if (!words || words.length === 0) return "";

  const annBbox: BboxMinMax = [annotation.bbox[0], annotation.bbox[1], annotation.bbox[2], annotation.bbox[3]];

  const insideWords = words.filter((w) => {
    const center = bboxCenterLTWH(w.bbox);
    return bboxContainsPoint(annBbox, center);
  });

  return insideWords
    .sort((a, b) => a.bbox[0] - b.bbox[0])
    .map((w) => w.text)
    .join(" ")
    .trim();
}

/**
 * Scan all annotations of a given class and extract OCR text inside each bbox.
 * Groups by unique text → returns sorted list of { text, count, pages, instances }.
 * Used by the class-scan "Create Tag" flow.
 */
export interface ClassScanResult {
  text: string;
  count: number;
  pages: number[];
  instances: YoloTagInstance[];
}

export function scanClassForTexts(
  yoloClass: string,
  yoloModel: string | undefined,
  annotations: ClientAnnotation[],
  textractData: Record<number, TextractPageData>,
): ClassScanResult[] {
  // Filter annotations by class + model
  const filtered = annotations.filter((a) => {
    if (a.source !== "yolo") return false;
    if (a.name !== yoloClass) return false;
    if (yoloModel && (a.data as any)?.modelName !== yoloModel) return false;
    return true;
  });

  // For each annotation, extract OCR text inside bbox
  const textMap = new Map<string, { instances: YoloTagInstance[]; pages: Set<number> }>();

  for (const ann of filtered) {
    const words = textractData[ann.pageNumber]?.words;
    if (!words || words.length === 0) {
      // No OCR data — group under empty text
      const key = "";
      if (!textMap.has(key)) textMap.set(key, { instances: [], pages: new Set() });
      const entry = textMap.get(key)!;
      entry.instances.push({ pageNumber: ann.pageNumber, annotationId: ann.id, bbox: ann.bbox, confidence: 1.0 });
      entry.pages.add(ann.pageNumber);
      continue;
    }

    const annBbox: BboxMinMax = [ann.bbox[0], ann.bbox[1], ann.bbox[2], ann.bbox[3]];

    const insideWords = words.filter((w) => {
      const center = bboxCenterLTWH(w.bbox);
      return bboxContainsPoint(annBbox, center);
    });

    const text = insideWords
      .sort((a, b) => a.bbox[0] - b.bbox[0])
      .map((w) => w.text)
      .join(" ")
      .trim();

    const key = text.toUpperCase();
    if (!textMap.has(key)) textMap.set(key, { instances: [], pages: new Set() });
    const entry = textMap.get(key)!;
    entry.instances.push({ pageNumber: ann.pageNumber, annotationId: ann.id, bbox: ann.bbox, confidence: 1.0 });
    entry.pages.add(ann.pageNumber);
  }

  // Convert to sorted array (most instances first, empty text last)
  return [...textMap.entries()]
    .map(([text, data]) => ({
      text: text || "",
      count: data.instances.length,
      pages: [...data.pages].sort((a, b) => a - b),
      instances: data.instances,
    }))
    .sort((a, b) => {
      // Empty text goes last
      if (!a.text && b.text) return 1;
      if (a.text && !b.text) return -1;
      return b.count - a.count;
    });
}

/** Simple Levenshtein edit distance. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;

  let prev = Array.from({ length: lb + 1 }, (_, i) => i);
  for (let i = 1; i <= la; i++) {
    const curr = [i];
    for (let j = 1; j <= lb; j++) {
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = curr;
  }
  return prev[lb];
}
