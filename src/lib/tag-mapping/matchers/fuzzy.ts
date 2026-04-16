/**
 * matchers/fuzzy.ts — OCR-confusion-aware fuzzy match + shared nearest
 * binding helpers. Moved verbatim from yolo-tag-engine.ts to keep the
 * matchers' behavior identical.
 */

import type { ClientAnnotation, BboxMinMax, YoloTagInstance } from "@/types";
import { bboxCenterMinMax, bboxContainsPoint } from "@/lib/bbox-utils";

// ─── OCR confusion table + fuzzy candidate check ─────────────

/**
 * Characters that OCR commonly confuses. Used to decide whether a single-char
 * diff between two tags is a plausible OCR error (D-01 vs D-0l) vs. a
 * different tag number (D-01 vs D-02).
 */
export const OCR_CONFUSIONS: Record<string, string[]> = {
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
 * Allows: 0↔O, 1↔l/I, 5↔S, etc. (same-length OCR substitution) + dropped hyphen.
 * Rejects: digit↔digit substitution, letter-suffix differences, multiple diffs.
 * Both strings must be ≥ 3 chars.
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
  for (let j = i; j < shorter.length; j++) {
    if (shorter[j] !== longer[j + 1]) return false;
  }
  // Only allow dropped/added hyphens (D-01 ↔ D01)
  return longer[i] === "-";
}

// ─── Nearest-object binding (shared by Types 3, 4, 5) ────────

function annotationCenter(a: ClientAnnotation): { x: number; y: number } {
  return { x: (a.bbox[0] + a.bbox[2]) / 2, y: (a.bbox[1] + a.bbox[3]) / 2 };
}

function distanceSquared(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/**
 * Return the annotation whose bbox center is closest (Euclidean, squared) to
 * the given point. Assumes `candidates` is non-empty — callers must check.
 * No proximity cap: "map to the closest door regardless, the worst case is
 * technically wrong door but still counted as a door" (user feedback).
 */
export function findNearestAnnotation(
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

/**
 * Shared nearest-object binding core. Used by merge logic (Type 3 seed +
 * Type 2 sources) and by Types 4 and 5 standalone.
 *
 * Steps:
 *   1. Start with `seedHits` as the canonical counted base set.
 *   2. For each `sourceHit`, check if its center is already inside any seed
 *      hit bbox on the same page → skip (already counted via seed).
 *   3. Find the nearest `targetAnnotation` on the same page. If none → orphan,
 *      drop.
 *   4. If that target was already used (by seed or earlier binding) → skip.
 *   5. Emit a new instance with the TARGET's bbox and confidence from
 *      `boundConfidence`.
 */
export function bindToNearestTargets(
  sourceHits: YoloTagInstance[],
  seedHits: YoloTagInstance[],
  targetAnnotations: ClientAnnotation[],
  boundConfidence: { exact: number; fuzzy: number },
): YoloTagInstance[] {
  const merged: YoloTagInstance[] = [...seedHits];

  const usedAnnotationIds = new Set<number>();
  for (const h of seedHits) {
    if (h.annotationId >= 0) usedAnnotationIds.add(h.annotationId);
  }

  const targetsByPage = new Map<number, ClientAnnotation[]>();
  for (const a of targetAnnotations) {
    const list = targetsByPage.get(a.pageNumber);
    if (list) list.push(a);
    else targetsByPage.set(a.pageNumber, [a]);
  }

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

    const samePageSeeds = seedBboxesByPage.get(source.pageNumber);
    if (samePageSeeds && samePageSeeds.some((b) => bboxContainsPoint(b, sourceCenter))) {
      continue;
    }

    const candidates = targetsByPage.get(source.pageNumber);
    if (!candidates || candidates.length === 0) continue;
    const nearest = findNearestAnnotation(sourceCenter, candidates);

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
