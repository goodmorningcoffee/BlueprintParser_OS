/**
 * yolo-heatmap-refresh.ts
 *
 * Client-side utility to recompute the YOLO density heatmap from Zustand
 * store state. Fires when the user uploads new blueprints and runs YOLO on
 * them — at that point the annotations table has fresh yolo-source rows and
 * the heatmap needs to reflect the new data without a server round-trip.
 *
 * Mirrors `csi-spatial-refresh.ts` pattern. Writes the new heatmap back into
 * `pageIntelligence.yoloHeatmap` via `store.setPageIntelligence`.
 *
 * `yolo-heatmap.ts` is pure math (no Node deps) so this is safe in the browser.
 */

import { computeYoloHeatmap } from "@/lib/spatial/yolo-heatmap";
import { useViewerStore } from "@/stores/viewerStore";
import type { ClientAnnotation, YoloHeatmapGridConfig } from "@/types";

/** Default YOLO class set — matches the server-side heatmap invocation in
 *  `/api/yolo/load` and `/api/admin/reprocess`. */
const DEFAULT_HEATMAP_CLASSES = ["text_box", "vertical_area", "horizontal_area"] as const;

/**
 * Recompute the YOLO heatmap for a given page using all client-side
 * annotations with `source: "yolo"`, and update pageIntelligence with the result.
 *
 * Caller-overridable class set + grid config for future use cases (e.g., the
 * auto-table-detector Stage 2c might want a different class tuple).
 */
export function refreshPageYoloHeatmap(
  pageNumber: number,
  opts?: {
    classes?: readonly string[];
    gridConfig?: YoloHeatmapGridConfig;
  },
): void {
  const store = useViewerStore.getState();
  const classes = opts?.classes ?? DEFAULT_HEATMAP_CLASSES;

  // Gather YOLO annotations on this page from the client-side store.
  const yoloAnns = store.annotations.filter(
    (a: ClientAnnotation) => a.pageNumber === pageNumber && a.source === "yolo",
  );

  // ClientAnnotation.bbox is already [minX, minY, maxX, maxY] normalized 0-1,
  // which matches the heatmap input shape directly.
  const heatmapInput = yoloAnns.map((a) => ({
    name: a.name,
    minX: a.bbox[0],
    minY: a.bbox[1],
    maxX: a.bbox[2],
    maxY: a.bbox[3],
    confidence: (a.data as { confidence?: number } | null | undefined)?.confidence ?? 0,
  }));

  const heatmap = computeYoloHeatmap(pageNumber, heatmapInput, {
    classes: [...classes],
    gridConfig: opts?.gridConfig,
  });

  // Merge into pageIntelligence (preserves other fields like classification,
  // csiSpatialMap, etc.). Always overwrite yoloHeatmap — even empty-result
  // heatmaps carry `classContributions` info the UI uses to advise.
  const intel = (store.pageIntelligence[pageNumber] || {}) as Record<string, unknown>;
  store.setPageIntelligence(pageNumber, {
    ...intel,
    yoloHeatmap: heatmap,
  });
}

/**
 * Refresh heatmaps for a list of pages (convenience wrapper). Used when a
 * batch of new blueprints just finished YOLO ingest — caller iterates the
 * affected pages and calls this once to cover all of them.
 */
export function refreshPagesYoloHeatmap(
  pageNumbers: readonly number[],
  opts?: Parameters<typeof refreshPageYoloHeatmap>[1],
): void {
  for (const pn of pageNumbers) refreshPageYoloHeatmap(pn, opts);
}
