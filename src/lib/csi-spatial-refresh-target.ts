/**
 * Store-free CSI spatial recompute for an explicitly captured project/page target.
 *
 * The public session-aware wrapper remains in csi-spatial-refresh.ts for existing event callers.
 * Captured-target commands invoke this core only while their adoption authority is current; the
 * explicit Query key prevents a recompute from silently borrowing the visible successor session.
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

export function refreshPageCsiSpatialMapForTarget(
  qc: QueryClient,
  publicId: string,
  pageNumber: number,
  gridConfig?: CsiSpatialGridConfig,
): void {
  const textAnnotations = readTextAnnotationsForPage(qc, publicId, pageNumber);
  const intel = (readPageIntelligence(qc, publicId, pageNumber) || {}) as Record<
    string,
    unknown
  >;
  const classifiedTables = (intel.classifiedTables || []) as any[];
  const parsedRegions = (intel.parsedRegions || []) as any[];
  const yoloTags = readYoloTags(qc, publicId).filter(
    (tag) => tag.instances.some((instance) => instance.pageNumber === pageNumber),
  );
  const dbAnnotations = readAnnotations(qc, publicId).filter(
    (annotation) =>
      annotation.pageNumber === pageNumber &&
      (annotation as any).data?.csiCodes?.length > 0,
  );

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

  // Compute from one captured target snapshot, then merge into the latest target intelligence so
  // an unrelated page field written during computation is retained.
  updatePageIntelligenceForPage(qc, publicId, pageNumber, (current) => ({
    ...(current ?? {}),
    csiSpatialMap: newMap,
  }));
}
