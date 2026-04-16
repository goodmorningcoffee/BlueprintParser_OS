/**
 * matchers/type5-yolo-object-with-nearby-text.ts — Type 5: object + nearby text.
 *
 * Standalone: free-floating text matches, each bound to the nearest object
 * of yoloClass on the same page. Used when the project's labeling convention
 * places tags OUTSIDE the object bbox (e.g., a door number floating near
 * but not inside the door swing), where Type 3 would miss everything.
 *
 * Going through Type 3 ("yolo-with-inner-text") also finds these via the
 * Type 2 fallback in mergeYoloAndFloatingHits. Type 5 standalone is cheaper
 * when there's zero chance of inner-text hits.
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
import { findFreeFloatingMatches } from "./type2-text-only";

export function findObjectWithNearbyTextMatches(
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
