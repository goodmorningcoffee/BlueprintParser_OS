/**
 * matchers/type1-yolo-only.ts — Type 1: count all YOLO shapes of a class.
 *
 * No text matching. Every YOLO annotation of the given class is one
 * occurrence. Used for items where the shape itself IS the count and tag
 * text is irrelevant (duplex outlets, diffusers, fire extinguishers).
 *
 * Behavior preserved verbatim from yolo-tag-engine.ts (pre-refactor).
 */

import type { ClientAnnotation, YoloTagInstance } from "@/types";

export function findYoloOnlyMatches(
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
