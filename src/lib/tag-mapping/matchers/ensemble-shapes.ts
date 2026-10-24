/**
 * matchers/ensemble-shapes.ts — [tag-mapping v2 2026-10-24] Tag-shape candidates from the shape
 * ensemble (src/lib/shape-ensemble) instead of `source === "yolo"` annotations only.
 *
 * Replaces the shape half of Types 1, 3 and 4 when the item's shape class is a tag class and the
 * context carries `shapes`: a shape both detectors found, a YOLO-only bubble, or a small
 * classical-only bubble (the +31 % tag-recall arm, research/shapes §7a) are all candidates, with
 * the ensemble's fused inner text (per-crop OCR validated by Textract) as the text to match.
 *
 * Excluded by construction: legend keys (inside a detected legend) and detail callouts — unless
 * the tag searched IS a sheet number, in which case the callouts pointing at that sheet are the
 * occurrences ("3 over R-3" resolves to sheet R-3, owner rule 1).
 */

import type { YoloTagInstance } from "@/types";
import { isSheetNumber, isTagLike as isTagLikeText, sheetKey, type EnsembleShape } from "@/lib/shape-ensemble";
import { isFuzzyCandidate } from "./fuzzy";

/** A raw hit that remembers the shape it came from (scored as `shapeContainBoost`). */
export interface ShapeBackedInstance extends YoloTagInstance {
  shapeConfidence?: number;
  shapeSource?: EnsembleShape["source"];
}

export function ensembleAnnotationId(s: EnsembleShape): number {
  return s.yoloAnnotationId ?? s.classicalAnnotationId ?? -1;
}

/** Exact (1.0) / OCR-confusion (0.9) match of the tag against any of the shape's reads, else null. */
export function shapeTextConfidence(s: EnsembleShape, normalizedTag: string): number | null {
  const reads = [s.text, s.cropText, s.textractText].filter((t): t is string => !!t);
  if (reads.some((t) => t === normalizedTag)) return 1.0;
  if (reads.some((t) => isFuzzyCandidate(t, normalizedTag))) return 0.9;
  return null;
}

/**
 * `normalizedTag` null → every tag shape of `cls` (Type 1). Otherwise the shapes of `cls` whose
 * inner text matches (Types 3 / 4).
 */
export function findEnsembleShapeMatches(
  normalizedTag: string | null,
  cls: string,
  scope: "page" | "project",
  pageNumber: number | undefined,
  shapesByPage: Record<number, readonly EnsembleShape[] | undefined>,
  sheets: ReadonlySet<string>,
): ShapeBackedInstance[] {
  const out: ShapeBackedInstance[] = [];
  const tagIsSheet = normalizedTag != null && isSheetNumber(normalizedTag, sheets);
  const tagSheetKey = normalizedTag != null ? sheetKey(normalizedTag) : null;
  const pageNums = scope === "page" && pageNumber != null
    ? [pageNumber]
    : Object.keys(shapesByPage).map(Number);
  for (const pn of pageNums) {
    for (const s of shapesByPage[pn] ?? []) {
      if (s.cls !== cls) continue;
      let confidence: number | null = null;
      if (s.kind === "detail_callout") {
        if (!tagIsSheet || !s.callout || sheetKey(s.callout.sheet) !== tagSheetKey) continue;
        confidence = 1.0;
      } else if (s.kind !== "tag") {
        continue;
      } else if (normalizedTag == null) {
        confidence = 1.0;
      } else {
        confidence = shapeTextConfidence(s, normalizedTag);
        if (confidence == null) continue;
      }
      out.push({
        pageNumber: pn,
        annotationId: ensembleAnnotationId(s),
        bbox: [s.bbox[0], s.bbox[1], s.bbox[2], s.bbox[3]],
        confidence,
        shapeConfidence: s.confidence,
        shapeSource: s.source,
      });
    }
  }
  return out;
}

/** Floating words bind to a shape only within this many shape long-sides of its centre
 *  (research/shapes §4: "nearest word within one box width" lifts Textract binding 56 → 64 %;
 *  beyond that a word belongs to something else). */
export const FLOATING_BIND_REACH = 1.5;

/**
 * v2's Type 3 fallback: bind free-floating word hits that passed the text rules to the nearest
 * ensemble tag shape of `cls` on the same page, each shape used once.
 *
 * `reach === null` keeps v1's binding semantics (nearest shape at ANY distance, whatever it holds)
 * — the default, because no owner rule covers it. With a reach (in shape long-sides, see
 * FLOATING_BIND_REACH) a word binds only to a shape within reach that does not already hold a
 * different tag-like text. MEASURED (scripts/tag-mapping-v2-measure.ts, 12 sets): ~85 % of v1's
 * Type 3 count is floating words bound at arbitrary distance; the owner decides whether to cap it.
 */
export function bindFloatingToShapes(
  floatingHits: readonly YoloTagInstance[],
  shapeHits: readonly ShapeBackedInstance[],
  normalizedTag: string,
  cls: string,
  shapesByPage: Record<number, readonly EnsembleShape[] | undefined>,
  reach: number | null = null,
  boundConfidence: { exact: number; fuzzy: number } = { exact: 0.8, fuzzy: 0.7 },
): ShapeBackedInstance[] {
  const merged: ShapeBackedInstance[] = [...shapeHits];
  const used = new Set<string>();
  for (const h of shapeHits) used.add(`${h.pageNumber}:${h.bbox.join(",")}`);
  for (const f of floatingHits) {
    const fx = (f.bbox[0] + f.bbox[2]) / 2;
    const fy = (f.bbox[1] + f.bbox[3]) / 2;
    // Already counted by a direct shape hit whose box holds the word → skip.
    if (shapeHits.some((s) => s.pageNumber === f.pageNumber && fx >= s.bbox[0] && fx <= s.bbox[2] && fy >= s.bbox[1] && fy <= s.bbox[3])) continue;
    let best: EnsembleShape | null = null;
    let bestD = Infinity;
    for (const s of shapesByPage[f.pageNumber] ?? []) {
      if (s.cls !== cls || s.kind !== "tag") continue;
      if (reach != null && s.text && s.text !== normalizedTag && isTagLikeText(s.text)) continue; // holds another tag
      const key = `${f.pageNumber}:${s.bbox.join(",")}`;
      if (used.has(key)) continue;
      const cx = (s.bbox[0] + s.bbox[2]) / 2;
      const cy = (s.bbox[1] + s.bbox[3]) / 2;
      const d = Math.hypot(cx - fx, cy - fy);
      if (reach != null && d > reach * Math.max(s.longSide, f.bbox[2] - f.bbox[0])) continue;
      if (d < bestD) { bestD = d; best = s; }
    }
    if (!best) continue;
    used.add(`${f.pageNumber}:${best.bbox.join(",")}`);
    merged.push({
      pageNumber: f.pageNumber,
      annotationId: ensembleAnnotationId(best),
      bbox: [best.bbox[0], best.bbox[1], best.bbox[2], best.bbox[3]],
      confidence: f.confidence < 1.0 ? boundConfidence.fuzzy : boundConfidence.exact,
      shapeConfidence: best.confidence,
      shapeSource: best.source,
    });
  }
  return merged;
}
