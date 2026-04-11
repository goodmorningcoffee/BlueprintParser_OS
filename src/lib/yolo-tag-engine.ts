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
 *
 * QTO-C (2026-04-11): when a yoloClass is specified, BOTH Type 3 (text
 * inside the shape) AND Type 5 (text near the shape) matches run. Orphan
 * floating text gets bound to the nearest target-class object on the same
 * page — even if technically bound to the "wrong" door, every countable
 * tagged door still gets counted. Orphans with no candidate object on the
 * page are dropped (Phase 2 will surface them for QA review).
 */

import type {
  ClientAnnotation,
  TextractPageData,
  BboxMinMax,
  YoloTagInstance,
} from "@/types";
import {
  bboxCenterLTWH,
  bboxCenterMinMax,
  bboxContainsPoint,
  ltwh2minmax,
} from "@/lib/ocr-utils";

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
 *
 * Behavior:
 *   - If `yoloClass` is empty: Type 2 only (free-floating text anywhere)
 *   - If `yoloClass` is set: Type 3 (text inside a shape of that class) UNION
 *     Type 5 (floating text bound to its nearest shape of that class on the
 *     same page). Dedupes against already-counted annotations so the same
 *     object is never counted twice.
 *
 * Pre-QTO-C behavior was to early-return on Type 3 only, silently missing
 * every tag whose text fell outside its parent object's bbox.
 */
export function mapYoloToOcrText(opts: MapYoloToOcrOptions): YoloTagInstance[] {
  const { tagText, yoloClass, yoloModel, scope, pageNumber, annotations, textractData } = opts;
  if (!tagText.trim()) return [];

  const normalizedTag = tagText.toUpperCase().trim();
  const isFreeFloating = !yoloClass;

  if (isFreeFloating) {
    return findFreeFloatingMatches(normalizedTag, scope, pageNumber, textractData);
  }

  // yoloClass is set — run BOTH Type 3 and Type 2 flows, then merge.
  const yoloHits = findYoloMatches(
    normalizedTag, yoloClass!, yoloModel, scope, pageNumber, annotations, textractData,
  );
  const floatingHits = findFreeFloatingMatches(
    normalizedTag, scope, pageNumber, textractData,
  );

  return mergeYoloAndFloatingHits(
    yoloHits, floatingHits, yoloClass!, yoloModel, annotations,
  );
}

/**
 * QTO-C merge: take Type 3 canonical hits (text inside the shape) and fold
 * in Type 5 hits (text outside the shape but near one of the target-class
 * objects on the same page). The rule from the user:
 *
 *   "Default-map a tag/floating text to the closest target object regardless;
 *    if it's literally orphan (no target on the page) drop it — Phase 2 will
 *    surface orphans for QA review."
 *
 * Dedupe rules (both required to avoid double-counting):
 *   1. If a floating text's center is inside any Type 3 hit bbox → skip
 *      (it's already counted via Type 3)
 *   2. If the nearest target object was already counted (Type 3 or an
 *      earlier Type 5 binding on this call) → skip
 */
function mergeYoloAndFloatingHits(
  yoloHits: YoloTagInstance[],
  floatingHits: YoloTagInstance[],
  yoloClass: string,
  yoloModel: string | undefined,
  annotations: ClientAnnotation[],
): YoloTagInstance[] {
  // Start with all Type 3 hits — these are canonical.
  const merged: YoloTagInstance[] = [...yoloHits];

  // Track which annotation IDs have been counted to prevent double-counts.
  const usedAnnotationIds = new Set<number>();
  for (const h of yoloHits) {
    if (h.annotationId >= 0) usedAnnotationIds.add(h.annotationId);
  }

  // Build per-page index of target-class annotations for nearest-object lookup.
  const targetsByPage = new Map<number, ClientAnnotation[]>();
  for (const a of annotations) {
    if (a.source !== "yolo") continue;
    if (a.name !== yoloClass) continue;
    if (yoloModel && (a.data as { modelName?: string } | null)?.modelName !== yoloModel) continue;
    const list = targetsByPage.get(a.pageNumber);
    if (list) list.push(a);
    else targetsByPage.set(a.pageNumber, [a]);
  }

  // Pre-compute Type 3 hit bboxes grouped by page for fast containment checks.
  const yoloHitBboxesByPage = new Map<number, BboxMinMax[]>();
  for (const h of yoloHits) {
    const list = yoloHitBboxesByPage.get(h.pageNumber);
    const bbox: BboxMinMax = [h.bbox[0], h.bbox[1], h.bbox[2], h.bbox[3]];
    if (list) list.push(bbox);
    else yoloHitBboxesByPage.set(h.pageNumber, [bbox]);
  }

  for (const floating of floatingHits) {
    const floatingCenter = bboxCenterMinMax([
      floating.bbox[0], floating.bbox[1], floating.bbox[2], floating.bbox[3],
    ]);

    // Dedupe 1: text center already inside a Type 3 hit → skip
    const samePageYoloBboxes = yoloHitBboxesByPage.get(floating.pageNumber);
    if (samePageYoloBboxes && samePageYoloBboxes.some((b) => bboxContainsPoint(b, floatingCenter))) {
      continue;
    }

    // Find nearest target-class object on the same page
    const candidates = targetsByPage.get(floating.pageNumber);
    if (!candidates || candidates.length === 0) {
      // Orphan — no target object on this page. Drop for SHIP 1.
      continue;
    }
    const nearest = findNearestAnnotation(floatingCenter, candidates);

    // Dedupe 2: this object was already counted → skip
    if (usedAnnotationIds.has(nearest.id)) continue;
    usedAnnotationIds.add(nearest.id);

    // Emit a Type 5 binding — count the OBJECT bbox, not the text bbox.
    // Confidence reduced vs Type 3 to signal the indirection (text not
    // actually inside the shape); halved further if the text match was fuzzy.
    merged.push({
      pageNumber: floating.pageNumber,
      annotationId: nearest.id,
      bbox: [nearest.bbox[0], nearest.bbox[1], nearest.bbox[2], nearest.bbox[3]],
      confidence: floating.confidence < 1.0 ? 0.7 : 0.8,
    });
  }

  return merged;
}

/**
 * Return the annotation whose bbox center is closest (Euclidean, squared) to
 * the given point. Assumes `candidates` is non-empty — callers must check.
 * No proximity cap per user feedback: "map to the closest door regardless,
 * the worst case is technically wrong door but still counted as a door."
 */
function findNearestAnnotation(
  point: { x: number; y: number },
  candidates: ClientAnnotation[],
): ClientAnnotation {
  let best = candidates[0];
  let bestDistSq = distanceSquared(point, annotationCenter(best));
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i];
    const d = distanceSquared(point, annotationCenter(c));
    if (d < bestDistSq) {
      bestDistSq = d;
      best = c;
    }
  }
  return best;
}

function annotationCenter(a: ClientAnnotation): { x: number; y: number } {
  return { x: (a.bbox[0] + a.bbox[2]) / 2, y: (a.bbox[1] + a.bbox[3]) / 2 };
}

function distanceSquared(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
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

    // Fuzzy match: only OCR-plausible errors (D-Ol ↔ D-01), NOT D-01 ↔ D-02
    if (isFuzzyCandidate(candidateText, normalizedTag)) {
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
        if (wText === normalizedTag || isFuzzyCandidate(wText, normalizedTag)) {
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
        if (windowText === normalizedTag || isFuzzyCandidate(windowText, normalizedTag)) {
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

/**
 * Characters that OCR commonly confuses. Keys map to confusable alternatives.
 * Used to decide whether a single-char diff between two tags is a plausible
 * OCR error (D-01 vs D-0l) vs. a different tag number (D-01 vs D-02).
 */
const OCR_CONFUSIONS: Record<string, string[]> = {
  "0": ["O", "Q", "D"], "O": ["0", "Q", "D"], "Q": ["0", "O"], "D": ["0", "O"],
  "1": ["l", "I", "|", "T"], "l": ["1", "I", "|"], "I": ["1", "l", "|"],
  "5": ["S"], "S": ["5"],
  "6": ["G"], "G": ["6"],
  "8": ["B"], "B": ["8"],
  "2": ["Z"], "Z": ["2"],
  "9": ["g", "q"], "g": ["9", "q"], "q": ["9", "g"],
};

function isOcrConfusable(a: string, b: string): boolean {
  return OCR_CONFUSIONS[a]?.includes(b) ?? false;
}

/**
 * True if two tag strings differ by exactly one OCR-plausible error.
 * Replaces blanket editDistance <= 1 fuzzy matching, which would match
 * D-01 to D-02, D-03, etc. (every sequential tag in a schedule).
 *
 * Allows: 0↔O, 1↔l/I, 5↔S, etc. (same-length OCR substitution) + dropped hyphen.
 * Rejects: digit↔digit substitution, letter-suffix differences, multiple diffs.
 */
export function isFuzzyCandidate(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 3 || b.length < 3) return false;
  const lenDiff = Math.abs(a.length - b.length);
  if (lenDiff > 1) return false;

  // Same length: find the one substitution position
  if (a.length === b.length) {
    let diffIdx = -1;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        if (diffIdx !== -1) return false; // > 1 diff
        diffIdx = i;
      }
    }
    if (diffIdx === -1) return true;
    return isOcrConfusable(a[diffIdx], b[diffIdx]);
  }

  // Insertion/deletion of exactly one char
  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < shorter.length && shorter[i] === longer[i]) i++;
  // Verify the remainder matches after skipping the inserted char
  for (let j = i; j < shorter.length; j++) {
    if (shorter[j] !== longer[j + 1]) return false;
  }
  // Only allow dropped/added hyphens (D-01 ↔ D01)
  return longer[i] === "-";
}
