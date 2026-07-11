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
import { readYoloTags } from "@/queries/useYoloTags";
import {
  readPageIntelligence,
  readTextAnnotationsForPage,
  updatePageIntelligenceForPage,
} from "@/queries/usePageWindow";
import { useSessionStore } from "@/stores/sessionStore";

/**
 * Recompute the CSI spatial map for a given project/page using all available client data.
 *
 * `publicId` is the request identity captured by the caller. Refuse to publish if the session has
 * since switched projects: mixing one project's live tags into another project's cache would
 * corrupt both projects.
 */
export function refreshPageCsiSpatialMap(
  qc: QueryClient,
  publicId: string,
  pageNumber: number,
  gridConfig?: CsiSpatialGridConfig,
): void {
  const store = useSessionStore.getState();
  if (store.publicId !== publicId) return;

  // Gather data sources
  const textAnnotations = readTextAnnotationsForPage(qc, publicId, pageNumber);
  const intel = (readPageIntelligence(qc, publicId, pageNumber) || {}) as Record<
    string,
    unknown
  >;
  const classifiedTables = (intel.classifiedTables || []) as any[];
  const parsedRegions = (intel.parsedRegions || []) as any[];
  // [refactor jul11 P2.2⑨] Library/event path reads the exact publicId-keyed collection. This is a
  // same-tick cache bridge, not a passive observer, and therefore cannot introduce render fan-out.
  const yoloTags = readYoloTags(qc, publicId).filter(
    (t) => t.instances.some((inst) => inst.pageNumber === pageNumber),
  );

  // Collect YOLO + user annotations with CSI codes for this page
  // [refactor jul11 P2.2⑥] Handler-time bridge preserves the old live getState read while the
  // server-owned window moves to its project cache. Never pass a render-captured annotation list.
  const dbAnnotations = readAnnotations(qc, publicId).filter(
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

  // Merge into the latest cache value. Computation intentionally used the single live snapshot
  // above, while publication preserves unrelated intelligence written during this invocation.
  updatePageIntelligenceForPage(qc, publicId, pageNumber, (current) => ({
    ...(current ?? {}),
    csiSpatialMap: newMap,
  }));
}
