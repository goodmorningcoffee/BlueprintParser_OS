/**
 * yolo-class-scope.ts — which YOLO MODEL a built-in class-name consumer means.
 *
 * [fix 2026-10-24 T1a] YOLO detections share one row shape; the class name alone does not say which
 * model emitted it (`data.modelName` does). `text_box` collides: yolo_medium emits it as a LAYOUT
 * class (~10 boxes/page, a notes/legend block), the yolo_text model emits it for every word cluster
 * (~367 boxes/page, measured over the corpus_v2 exports). Matched by name only, yolo_text floods the
 * density heatmap's max-normalisation and turns the general-notes booster on for any page with text.
 *
 * Built-in consumers therefore read each layout class from the model that defines it. A detection
 * WITHOUT a modelName (legacy rows) is kept, as before. Custom heuristic rules are not scoped here —
 * a user rule names its classes on purpose.
 *
 * ⚠ Scoping is by model NAME, matching the deployed registry (yolo_medium, yolo_primitive). A model
 * registered under another name loses these built-in signals until it is listed here — so the first
 * drop per (class, model) pair is logged once per process; yolo_text's `text_box` is the expected one.
 */

import { logger } from "@/lib/logger";

export const LAYOUT_CLASS_MODELS: Readonly<Record<string, readonly string[]>> = {
  text_box: ["yolo_medium"],
  vertical_area: ["yolo_primitive"],
  horizontal_area: ["yolo_primitive"],
};

const loggedDrops = new Set<string>();

/** True when a built-in consumer may count this detection under its class name. */
export function inLayoutScope(det: { name: string; modelName?: string | null }): boolean {
  const allowed = LAYOUT_CLASS_MODELS[det.name];
  if (!allowed || det.modelName == null) return true;
  if (allowed.includes(det.modelName)) return true;
  const pair = `${det.name}@${det.modelName}`;
  if (!loggedDrops.has(pair)) {
    loggedDrops.add(pair);
    logger.info(
      `[yolo-class-scope] built-in consumers ignore "${det.name}" from model "${det.modelName}" ` +
        `(scoped to ${allowed.join(", ")}); a renamed layout model must be added to LAYOUT_CLASS_MODELS`,
    );
  }
  return false;
}

export function scopeLayoutDetections<T extends { name: string; modelName?: string | null }>(
  detections: readonly T[],
): T[] {
  return detections.filter(inLayoutScope);
}
