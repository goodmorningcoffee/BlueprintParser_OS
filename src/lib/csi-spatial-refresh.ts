/**
 * csi-spatial-refresh.ts
 *
 * Client-side utility to recompute the CSI spatial map from viewer/query client state.
 * Called after user parsing, YOLO load, or annotation CSI updates.
 *
 * csi-spatial.ts is client-safe (no Node.js deps), so this runs in the browser.
 */

import type { QueryClient } from "@tanstack/react-query";
import type { CsiSpatialGridConfig } from "@/lib/csi-spatial";
import { refreshPageCsiSpatialMapForTarget } from "@/lib/csi-spatial-refresh-target";
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

  refreshPageCsiSpatialMapForTarget(qc, publicId, pageNumber, gridConfig);
}
