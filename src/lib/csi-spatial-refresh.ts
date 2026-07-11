/**
 * csi-spatial-refresh.ts
 *
 * Client-side utility to recompute the CSI spatial map from viewer/query client state.
 * Called after user parsing, YOLO load, or annotation CSI updates.
 *
 * csi-spatial.ts is client-safe (no Node.js deps), so this runs in the browser.
 */

import type { QueryClient } from "@tanstack/react-query";
import { computeCsiSpatialMap, type CsiSpatialGridConfig } from "@/lib/csi-spatial";
import { readAnnotations } from "@/queries/useAnnotations";
import { useViewerStore } from "@/stores/viewerStore";

/**
 * Recompute the CSI spatial map for a given page using all available client data and update
 * zustand-owned pageIntelligence with the result.
 */
export function refreshPageCsiSpatialMap(
  qc: QueryClient,
  pageNumber: number,
  gridConfig?: CsiSpatialGridConfig,
): void {
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
  // [refactor jul11 P2.2⑥] Handler-time bridge preserves the old live getState read while the
  // server-owned window moves to its project cache. Never pass a render-captured annotation list.
  const dbAnnotations = readAnnotations(qc, store.publicId).filter(
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
