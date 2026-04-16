/**
 * matchers/type3-yolo-with-inner-text.ts — Type 3: text inside a YOLO shape.
 *
 * Finds YOLO annotations of a given class whose OCR text (inside the bbox)
 * matches a target tag. Then merges with Type 2 free-floating matches and
 * binds orphan floating text to the nearest target-class object on the
 * same page (QTO-C merge behavior, preserved from pre-refactor code).
 *
 * Two exports:
 *   - findYoloMatches:       raw inner-text match (Type 3 only)
 *   - mergeYoloAndFloatingHits: Type 3 + Type 2 + nearest binding
 *     (the full pipeline that the legacy mapYoloToOcrText exposes)
 *
 * Behavior preserved verbatim from yolo-tag-engine.ts.
 */

import type {
  ClientAnnotation,
  TextractPageData,
  BboxMinMax,
  YoloTagInstance,
} from "@/types";
import { findWordsInBbox, sortWordsReadingOrder } from "@/lib/ocr-utils";
import { isFuzzyCandidate, bindToNearestTargets } from "./fuzzy";

export function findYoloMatches(
  normalizedTag: string,
  yoloClass: string,
  yoloModel: string | undefined,
  scope: "page" | "project",
  pageNumber: number | undefined,
  annotations: ClientAnnotation[],
  textractData: Record<number, TextractPageData>,
): YoloTagInstance[] {
  const filtered = annotations.filter((a) => {
    if (a.source !== "yolo") return false;
    if (a.name !== yoloClass) return false;
    if (yoloModel && (a.data as { modelName?: string } | null)?.modelName !== yoloModel) return false;
    if (scope === "page" && pageNumber != null && a.pageNumber !== pageNumber) return false;
    return true;
  });

  const instances: YoloTagInstance[] = [];

  for (const ann of filtered) {
    const words = textractData[ann.pageNumber]?.words;
    if (!words || words.length === 0) continue;

    const annBbox: BboxMinMax = [ann.bbox[0], ann.bbox[1], ann.bbox[2], ann.bbox[3]];
    const insideWords = findWordsInBbox(words, annBbox);
    if (insideWords.length === 0) continue;

    const candidateText = sortWordsReadingOrder(insideWords)
      .map((w) => w.text)
      .join(" ")
      .toUpperCase()
      .trim();

    if (!candidateText) continue;

    if (candidateText === normalizedTag) {
      instances.push({
        pageNumber: ann.pageNumber,
        annotationId: ann.id,
        bbox: ann.bbox,
        confidence: 1.0,
      });
      continue;
    }

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

/**
 * QTO-C merge: Type 3 seed (text inside shape) + Type 2 sources (floating
 * text) + nearest-target binding. Thin wrapper around bindToNearestTargets
 * so Types 3, 4, 5 share the same dedupe + nearest logic.
 */
export function mergeYoloAndFloatingHits(
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
