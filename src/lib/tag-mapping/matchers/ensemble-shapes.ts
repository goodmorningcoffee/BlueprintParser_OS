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
import { isSheetNumber, sheetKey, type EnsembleShape } from "@/lib/shape-ensemble";
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
