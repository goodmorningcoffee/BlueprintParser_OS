/**
 * legacy.ts — Back-compat adapter layer.
 *
 * Converts between ScoredMatch (new, rich) and YoloTagInstance (old, narrow)
 * so callers that still expect the pre-refactor shape keep working. Also
 * hosts the legacy `findItemOccurrences`, `mapYoloToOcrText`, and
 * `scanClassForTexts` signatures so `yolo-tag-engine.ts` can re-export them
 * from one place.
 */

import type {
  ClientAnnotation,
  TextractPageData,
  BboxMinMax,
  YoloTagInstance,
} from "@/types";
import {
  bboxCenterLTWH,
  bboxContainsPoint,
} from "@/lib/bbox-utils";
import type {
  CountableItem,
  MapYoloToOcrOptions,
  ScoredMatch,
  ClassScanResult,
  MatchContext,
} from "./types";
import { findOccurrences } from "./find-occurrences";
import { allPagesScope } from "./primitives/scope";
import { findYoloMatches, mergeYoloAndFloatingHits } from "./matchers/type3-yolo-with-inner-text";
import { findFreeFloatingMatches } from "./matchers/type2-text-only";

/**
 * Narrow a ScoredMatch to a YoloTagInstance by dropping the scoring fields.
 * Used by the shim to preserve the old function signatures.
 */
export function toYoloTagInstance(m: ScoredMatch): YoloTagInstance {
  return {
    pageNumber: m.pageNumber,
    annotationId: m.annotationId,
    bbox: m.bbox,
    confidence: m.confidence,
  };
}

export function toYoloTagInstances(scored: ScoredMatch[]): YoloTagInstance[] {
  return scored.map(toYoloTagInstance);
}

/**
 * Legacy `findItemOccurrences` signature — matches the pre-refactor API.
 * Calls findOccurrences under the hood with a permissive default context
 * (no scope filter, no pattern, no region data — reproduces pre-refactor
 * behavior where every match was returned and applyExclusionFilter ran
 * separately at the route level).
 */
export function findItemOccurrencesLegacy(
  item: CountableItem,
  scope: "page" | "project",
  pageNumber: number | undefined,
  annotations: ClientAnnotation[],
  textractData: Record<number, TextractPageData>,
): YoloTagInstance[] {
  const ctx: MatchContext = {
    scope: allPagesScope(),
    pageNumber,
    isPageScoped: scope === "page",
    annotations,
    textractData,
    classifiedRegionsByPage: {},   // no region data → everything unclassified (weight 0.5)
    pattern: null,                  // no pattern → no hard-zero
  };
  const scored = findOccurrences(item, ctx);
  return toYoloTagInstances(scored);
}

/**
 * Legacy `mapYoloToOcrText` — unchanged behavior. Runs Type 2 free-floating
 * OR the Type 3 + Type 2 merged path depending on whether yoloClass is set.
 * Preserved verbatim from yolo-tag-engine.ts so callers at KeynotePanel,
 * TableParsePanel, llm/tools.ts, and the single-tag map-tags route keep
 * working identically.
 */
export function mapYoloToOcrTextLegacy(opts: MapYoloToOcrOptions): YoloTagInstance[] {
  const { tagText, yoloClass, yoloModel, scope, pageNumber, annotations, textractData } = opts;
  if (!tagText.trim()) return [];

  const normalizedTag = tagText.toUpperCase().trim();
  const isFreeFloating = !yoloClass;

  if (isFreeFloating) {
    return findFreeFloatingMatches(normalizedTag, scope, pageNumber, textractData);
  }

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
 * `getOcrTextInAnnotation` — unchanged; returns OCR text inside a single
 * annotation's bbox.
 */
export function getOcrTextInAnnotationLegacy(
  annotation: ClientAnnotation,
  textractData: Record<number, TextractPageData>,
): string {
  const words = textractData[annotation.pageNumber]?.words;
  if (!words || words.length === 0) return "";

  const annBbox: BboxMinMax = [
    annotation.bbox[0], annotation.bbox[1], annotation.bbox[2], annotation.bbox[3],
  ];
  // Inline to avoid importing findWordsInBbox + sortWordsReadingOrder at
  // module top (would widen the dep surface of this adapter).
  const insideWords = words.filter((w) => {
    const center = bboxCenterLTWH(w.bbox);
    return bboxContainsPoint(annBbox, center);
  });
  return insideWords
    .sort((a, b) => {
      const ay = a.bbox[1] + a.bbox[3] / 2;
      const by = b.bbox[1] + b.bbox[3] / 2;
      const avgH = (a.bbox[3] + b.bbox[3]) / 2;
      if (Math.abs(ay - by) < avgH * 0.5) return a.bbox[0] - b.bbox[0];
      return ay - by;
    })
    .map((w) => w.text)
    .join(" ")
    .trim();
}

/**
 * `scanClassForTexts` — unchanged; scans all YOLO annotations of a class,
 * extracts inner OCR text, groups by unique text.
 */
export function scanClassForTextsLegacy(
  yoloClass: string,
  yoloModel: string | undefined,
  annotations: ClientAnnotation[],
  textractData: Record<number, TextractPageData>,
): ClassScanResult[] {
  const filtered = annotations.filter((a) => {
    if (a.source !== "yolo") return false;
    if (a.name !== yoloClass) return false;
    if (yoloModel && (a.data as { modelName?: string } | null)?.modelName !== yoloModel) return false;
    return true;
  });

  const textMap = new Map<string, { instances: YoloTagInstance[]; pages: Set<number> }>();

  for (const ann of filtered) {
    const words = textractData[ann.pageNumber]?.words;
    if (!words || words.length === 0) {
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

  return [...textMap.entries()]
    .map(([text, data]) => ({
      text: text || "",
      count: data.instances.length,
      pages: [...data.pages].sort((a, b) => a - b),
      instances: data.instances,
    }))
    .sort((a, b) => {
      if (!a.text && b.text) return 1;
      if (a.text && !b.text) return -1;
      return b.count - a.count;
    });
}
