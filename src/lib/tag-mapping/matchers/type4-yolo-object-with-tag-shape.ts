/**
 * matchers/type4-yolo-object-with-tag-shape.ts — Type 4: object + tag shape.
 *
 * Two-step matcher:
 *   1. Find tag-shape annotations (class = tagShapeClass) whose inner OCR
 *      text matches the target tag. Reuses findYoloMatches.
 *   2. For each hit, bind it to the nearest object annotation of class =
 *      yoloClass on the same page. The OBJECT's bbox becomes the occurrence.
 *
 * Example: door_single tagged by a `circle` containing "D-101". The circle
 * has inner text → findYoloMatches finds it. Circle center → nearest
 * door_single on same page → counted occurrence uses door's bbox.
 *
 * Behavior preserved verbatim from yolo-tag-engine.ts.
 */

import type {
  ClientAnnotation,
  TextractPageData,
  YoloTagInstance,
} from "@/types";
import type { CountableItem } from "../types";
import { bindToNearestTargets } from "./fuzzy";
import { findYoloMatches } from "./type3-yolo-with-inner-text";

export function findObjectWithTagShapeMatches(
  item: CountableItem,
  scope: "page" | "project",
  pageNumber: number | undefined,
  annotations: ClientAnnotation[],
  textractData: Record<number, TextractPageData>,
): YoloTagInstance[] {
  if (!item.yoloClass || !item.tagShapeClass || !item.text?.trim()) return [];
  const normalizedTag = item.text.toUpperCase().trim();

  const tagShapeHits = findYoloMatches(
    normalizedTag, item.tagShapeClass, item.yoloModel,
    scope, pageNumber, annotations, textractData,
  );
  if (tagShapeHits.length === 0) return [];

  const objectTargets = annotations.filter((a) =>
    a.source === "yolo" &&
    a.name === item.yoloClass &&
    (!item.yoloModel || (a.data as { modelName?: string } | null)?.modelName === item.yoloModel) &&
    (scope !== "page" || pageNumber == null || a.pageNumber === pageNumber)
  );

  return bindToNearestTargets(
    tagShapeHits, [], objectTargets, { exact: 0.9, fuzzy: 0.85 },
  );
}
