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
  QtoItemType,
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

// ═══════════════════════════════════════════════════════════════════
// SHIP 2 — 5-type item taxonomy
// ═══════════════════════════════════════════════════════════════════
//
// Every countable item in BlueprintParser is exactly one of five types.
// findItemOccurrences() is the single dispatcher the Auto-QTO flow uses
// going forward. The legacy mapYoloToOcrText() is kept as a backward-compat
// entry point for manual Map Tags + keynote parser, and is called internally
// for the "yolo-with-inner-text" branch.
//
// QtoItemType itself is exported from @/types so schema.ts + React components
// can reference it without pulling in the engine. See memory/project_qto_taxonomy.md
// for the full taxonomy rules.

/** Parameters for a single countable item, consumed by findItemOccurrences. */
export interface CountableItem {
  itemType: QtoItemType;
  label: string;                 // for error messages / UI
  yoloClass?: string;            // primary class (Types 1, 3, 4, 5)
  yoloModel?: string;            // optional model filter
  tagShapeClass?: string;        // secondary class for Type 4 (the tag shape)
  text?: string;                 // tag text (Types 2, 3, 4, 5)
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
 * SHIP 2 dispatcher — the canonical entry point for Auto-QTO. Takes a
 * CountableItem of any of the 5 types and routes to the right engine
 * function. All takeoff features (Auto-QTO batch, future map-tags rewrites)
 * should go through this rather than calling the individual match functions
 * directly.
 *
 * Backward compat: the existing `mapYoloToOcrText` stays usable. This
 * dispatcher calls it internally for the "yolo-with-inner-text" branch so
 * that Types 3 + 5 still go through the same merge logic shipped in SHIP 1.
 */
export function findItemOccurrences(
  item: CountableItem,
  scope: "page" | "project",
  pageNumber: number | undefined,
  annotations: ClientAnnotation[],
  textractData: Record<number, TextractPageData>,
): YoloTagInstance[] {
  switch (item.itemType) {
    case "yolo-only":
      if (!item.yoloClass) return [];
      return findYoloOnlyMatches(item.yoloClass, item.yoloModel, scope, pageNumber, annotations);

    case "text-only":
      if (!item.text?.trim()) return [];
      return findFreeFloatingMatches(
        item.text.toUpperCase().trim(),
        scope, pageNumber, textractData,
      );

    case "yolo-with-inner-text":
      if (!item.text?.trim() || !item.yoloClass) return [];
      return mapYoloToOcrText({
        tagText: item.text,
        yoloClass: item.yoloClass,
        yoloModel: item.yoloModel,
        scope,
        pageNumber,
        annotations,
        textractData,
      });

    case "yolo-object-with-tag-shape":
      return findObjectWithTagShapeMatches(item, scope, pageNumber, annotations, textractData);

    case "yolo-object-with-nearby-text":
      return findObjectWithNearbyTextMatches(item, scope, pageNumber, annotations, textractData);
  }
}

// ───────────────────────────────────────────────────────────────
// Type 1 — YOLO-only (no text match)
// ───────────────────────────────────────────────────────────────

/**
 * Count every YOLO annotation of the given class as one occurrence.
 * No text matching, no dedupe beyond the class filter. Useful for items
 * like duplex outlets, diffusers, fire extinguishers where each shape IS
 * the count and tag text is irrelevant.
 */
function findYoloOnlyMatches(
  yoloClass: string,
  yoloModel: string | undefined,
  scope: "page" | "project",
  pageNumber: number | undefined,
  annotations: ClientAnnotation[],
): YoloTagInstance[] {
  const out: YoloTagInstance[] = [];
  for (const a of annotations) {
    if (a.source !== "yolo") continue;
    if (a.name !== yoloClass) continue;
    if (yoloModel && (a.data as { modelName?: string } | null)?.modelName !== yoloModel) continue;
    if (scope === "page" && pageNumber != null && a.pageNumber !== pageNumber) continue;
    out.push({
      pageNumber: a.pageNumber,
      annotationId: a.id,
      bbox: [a.bbox[0], a.bbox[1], a.bbox[2], a.bbox[3]],
      confidence: 1.0,
    });
  }
  return out;
}

// ───────────────────────────────────────────────────────────────
// Type 4 — Object + tag-shape + text
// ───────────────────────────────────────────────────────────────

/**
 * Two-step matcher:
 *   Step 1: find tag-shape annotations (class = tagShapeClass) whose inner
 *           OCR text matches the target tag text. Reuses findYoloMatches.
 *   Step 2: for each hit, bind it to the nearest object annotation of class
 *           = yoloClass on the same page. Return the OBJECT's bbox as the
 *           occurrence — the tag shape is just a key, not counted itself.
 *
 * Example: door_single tagged by a `circle` containing "D-101". The circle
 * has inner text "D-101" (findYoloMatches finds it), then the circle's
 * center is used to find the nearest door_single on the same page, which
 * becomes the counted occurrence.
 *
 * Orphan rule: if no object of yoloClass exists on the tag-shape's page,
 * drop the hit (Phase 2 will surface these as "needs review").
 */
function findObjectWithTagShapeMatches(
  item: CountableItem,
  scope: "page" | "project",
  pageNumber: number | undefined,
  annotations: ClientAnnotation[],
  textractData: Record<number, TextractPageData>,
): YoloTagInstance[] {
  if (!item.yoloClass || !item.tagShapeClass || !item.text?.trim()) return [];
  const normalizedTag = item.text.toUpperCase().trim();

  // Step 1: text-inside-tag-shape matches via existing Type 3 logic
  const tagShapeHits = findYoloMatches(
    normalizedTag, item.tagShapeClass, item.yoloModel,
    scope, pageNumber, annotations, textractData,
  );
  if (tagShapeHits.length === 0) return [];

  // Step 2: gather object candidates (the things we actually COUNT)
  const objectTargets = annotations.filter((a) =>
    a.source === "yolo" &&
    a.name === item.yoloClass &&
    (!item.yoloModel || (a.data as { modelName?: string } | null)?.modelName === item.yoloModel) &&
    (scope !== "page" || pageNumber == null || a.pageNumber === pageNumber)
  );

  // Bind each tag-shape hit to nearest object. No seed — Type 4 has no
  // "canonical already counted" base set. Higher confidence than Type 5
  // because the tag was actually inside a purpose-built shape.
  return bindToNearestTargets(
    tagShapeHits, [], objectTargets, { exact: 0.9, fuzzy: 0.85 },
  );
}

// ───────────────────────────────────────────────────────────────
// Type 5 standalone — object + nearby floating text
// ───────────────────────────────────────────────────────────────

/**
 * Standalone version of the Type 5 logic that SHIP 1's mergeYoloAndFloatingHits
 * uses as a fallback. Finds free-floating text matches, binds each to the
 * nearest object of yoloClass on the same page.
 *
 * Use this when the user knows their tags don't sit inside the object bbox
 * (label placement convention for the project) and wants to skip Type 3
 * entirely. Going through findItemOccurrences with "yolo-with-inner-text"
 * would also find these matches via the fallback, but doing it standalone
 * is cheaper when there's zero chance of inner-text hits.
 */
function findObjectWithNearbyTextMatches(
  item: CountableItem,
  scope: "page" | "project",
  pageNumber: number | undefined,
  annotations: ClientAnnotation[],
  textractData: Record<number, TextractPageData>,
): YoloTagInstance[] {
  if (!item.yoloClass || !item.text?.trim()) return [];
  const normalizedTag = item.text.toUpperCase().trim();

  const floatingHits = findFreeFloatingMatches(normalizedTag, scope, pageNumber, textractData);
  if (floatingHits.length === 0) return [];

  const objectTargets = annotations.filter((a) =>
    a.source === "yolo" &&
    a.name === item.yoloClass &&
    (!item.yoloModel || (a.data as { modelName?: string } | null)?.modelName === item.yoloModel) &&
    (scope !== "page" || pageNumber == null || a.pageNumber === pageNumber)
  );

  return bindToNearestTargets(
    floatingHits, [], objectTargets, { exact: 0.8, fuzzy: 0.7 },
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
 * SHIP 2: thin wrapper around the shared bindToNearestTargets helper so that
 * Types 3, 4, and 5 all share the same dedupe + nearest-binding logic.
 */
function mergeYoloAndFloatingHits(
  yoloHits: YoloTagInstance[],
  floatingHits: YoloTagInstance[],
  yoloClass: string,
  yoloModel: string | undefined,
  annotations: ClientAnnotation[],
): YoloTagInstance[] {
  const targets = annotations.filter((a) =>
    a.source === "yolo" &&
    a.name === yoloClass &&
    (!yoloModel || (a.data as { modelName?: string } | null)?.modelName === yoloModel)
  );
  return bindToNearestTargets(
    floatingHits, yoloHits, targets, { exact: 0.8, fuzzy: 0.7 },
  );
}

/**
 * Shared nearest-object binding core. Used by:
 *   - mergeYoloAndFloatingHits (Type 3 seed + Type 2 sources, target = yoloClass)
 *   - findObjectWithTagShapeMatches (empty seed, tag-shape sources, target = object class)
 *   - findObjectWithNearbyTextMatches (empty seed, Type 2 sources, target = object class)
 *
 * Steps:
 *   1. Start with `seedHits` as the canonical counted base set.
 *   2. For each `sourceHit`, check if its center is already inside any seed
 *      hit bbox on the same page → skip (already counted via seed).
 *   3. Find the nearest `targetAnnotation` on the same page. If none → orphan,
 *      drop.
 *   4. If that target was already used (by seed or earlier binding) → skip
 *      (don't double-count the same object).
 *   5. Emit a new instance with the TARGET's bbox (not the source's) and
 *      confidence from the `boundConfidence` config.
 *
 * Returns `[...seedHits, ...newlyBoundHits]`.
 *
 * `boundConfidence.exact` is used when `sourceHit.confidence === 1.0`;
 * `boundConfidence.fuzzy` is used when source was a fuzzy OCR match.
 */
function bindToNearestTargets(
  sourceHits: YoloTagInstance[],
  seedHits: YoloTagInstance[],
  targetAnnotations: ClientAnnotation[],
  boundConfidence: { exact: number; fuzzy: number },
): YoloTagInstance[] {
  const merged: YoloTagInstance[] = [...seedHits];

  // usedAnnotationIds prevents double-counting the same target across all
  // binding attempts (both seed-contributed and newly-bound).
  const usedAnnotationIds = new Set<number>();
  for (const h of seedHits) {
    if (h.annotationId >= 0) usedAnnotationIds.add(h.annotationId);
  }

  // Per-page target index
  const targetsByPage = new Map<number, ClientAnnotation[]>();
  for (const a of targetAnnotations) {
    const list = targetsByPage.get(a.pageNumber);
    if (list) list.push(a);
    else targetsByPage.set(a.pageNumber, [a]);
  }

  // Per-page seed-bbox index for the "already inside a seed hit" dedupe
  const seedBboxesByPage = new Map<number, BboxMinMax[]>();
  for (const h of seedHits) {
    const list = seedBboxesByPage.get(h.pageNumber);
    const bbox: BboxMinMax = [h.bbox[0], h.bbox[1], h.bbox[2], h.bbox[3]];
    if (list) list.push(bbox);
    else seedBboxesByPage.set(h.pageNumber, [bbox]);
  }

  for (const source of sourceHits) {
    const sourceCenter = bboxCenterMinMax([
      source.bbox[0], source.bbox[1], source.bbox[2], source.bbox[3],
    ]);

    // Dedupe 1: source's center lies inside an existing seed hit on the
    // same page — already counted, skip.
    const samePageSeeds = seedBboxesByPage.get(source.pageNumber);
    if (samePageSeeds && samePageSeeds.some((b) => bboxContainsPoint(b, sourceCenter))) {
      continue;
    }

    // Nearest-target lookup on same page
    const candidates = targetsByPage.get(source.pageNumber);
    if (!candidates || candidates.length === 0) continue;  // orphan — drop
    const nearest = findNearestAnnotation(sourceCenter, candidates);

    // Dedupe 2: target already counted
    if (usedAnnotationIds.has(nearest.id)) continue;
    usedAnnotationIds.add(nearest.id);

    merged.push({
      pageNumber: source.pageNumber,
      annotationId: nearest.id,
      bbox: [nearest.bbox[0], nearest.bbox[1], nearest.bbox[2], nearest.bbox[3]],
      confidence: source.confidence < 1.0 ? boundConfidence.fuzzy : boundConfidence.exact,
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
