/**
 * csi-spatial-refresh.ts
 *
 * Client-side utility to recompute the CSI spatial map from Zustand store state.
 * Called after user parsing, YOLO load, or annotation CSI updates.
 *
 * csi-spatial.ts is client-safe (no Node.js deps), so this runs in the browser.
 */

import { computeCsiSpatialMap, type CsiSpatialGridConfig } from "@/lib/csi-spatial";
import { useViewerStore } from "@/stores/viewerStore";

/**
 * Recompute the CSI spatial map for a given page using all available data
 * from the Zustand store, and update pageIntelligence with the result.
 */
export function refreshPageCsiSpatialMap(pageNumber: number, gridConfig?: CsiSpatialGridConfig): void {
  const store = useViewerStore.getState();

  // Gather data sources
  const textAnnotations = store.textAnnotations[pageNumber] || [];
  const intel = (store.pageIntelligence[pageNumber] || {}) as Record<string, unknown>;
  const classifiedTables = (intel.classifiedTables || []) as any[];
  const parsedRegions = (intel.parsedRegions || []) as any[];
  const yoloTags = store.yoloTags.filter(
    (t) => t.instances.some((inst) => inst.pageNumber === pageNumber),
  );

  // Collect YOLO + user annotations with CSI codes for this page
  const dbAnnotations = store.annotations.filter(
    (a) => a.pageNumber === pageNumber && (a as any).data?.csiCodes?.length > 0,
  );

  // Recompute spatial map
  const newMap = computeCsiSpatialMap(
    pageNumber,
    textAnnotations,
    undefined, // yoloDetections — covered by dbAnnotations
    classifiedTables,
    parsedRegions,
    yoloTags,
    dbAnnotations,
    gridConfig,
  );

  // Update pageIntelligence in store
  store.setPageIntelligence(pageNumber, {
    ...intel,
    csiSpatialMap: newMap,
  });
}
