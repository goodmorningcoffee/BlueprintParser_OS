import type { QueryClient } from "@tanstack/react-query";

import {
  deletePersistedParsedRegion,
  promoteParsedRegion,
  type DeletePersistedParsedRegionResponse,
  type ParsedRegionKind,
  type ParsedRegionPromotionCsiTag,
  type PromoteParsedRegionResponse,
} from "@/lib/client-persist";
import { refreshPageCsiSpatialMapForTarget } from "@/lib/csi-spatial-refresh-target";
import {
  setPageIntelligenceForPage,
  updatePageIntelligenceForPage,
} from "@/queries/usePageWindow";
import { seedSummariesCache } from "@/queries/useSummaries";
import type { BboxMinMax } from "@/types";

/**
 * [refactor jul11 P2.4 C1] Query-aware ParsedRegion commit tail.
 *
 * C2 routes all twelve save tails here. The command accepts a fully captured target and request
 * description, reads no live store/UI/tool state, and owns only persistence plus authoritative
 * cache adoption. Optimistic/local writes, CSI detection, busy state, errors, wizard reset,
 * map-tags, and modal close remain caller policy.
 */

export interface SaveParsedRegionTarget {
  readonly publicId: string | null;
  readonly isDemo: boolean;
  readonly pageNumber: number;
}

export type ParsedRegionPromotion =
  | {
      via: "parser";
      type: ParsedRegionKind;
      regionId: string;
      bboxMinMax: BboxMinMax;
      data: Record<string, unknown>;
      category?: string;
      csiTags?: ParsedRegionPromotionCsiTag[];
    }
  | {
      via: "classifier";
      type: ParsedRegionKind;
      sourceTextRegionId: string;
    };

export type SaveParsedRegionResult =
  | { status: "persisted"; response: PromoteParsedRegionResponse }
  | { status: "local"; reason: "demo" }
  | { status: "skipped"; reason: "missing-public-id" };

export interface DeleteParsedRegionTarget {
  readonly publicId: string | null;
  readonly isDemo: boolean;
  readonly pageNumber: number;
  readonly regionId: string | null;
}

export type DeleteParsedRegionResult =
  | { status: "persisted"; response: DeletePersistedParsedRegionResponse }
  | { status: "local"; reason: "demo" }
  | { status: "skipped"; reason: "missing-public-id" | "missing-region-id" };

function isNonArrayObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertPromotionResponse(
  response: unknown,
): asserts response is PromoteParsedRegionResponse {
  const updatedIntelligence = isNonArrayObject(response)
    ? response.updatedIntelligence
    : null;
  if (
    !isNonArrayObject(response) ||
    response.ok !== true ||
    !isNonArrayObject(response.parsedRegion) ||
    !isNonArrayObject(updatedIntelligence) ||
    !Array.isArray(updatedIntelligence.parsedRegions) ||
    (response.summaries !== null && !isNonArrayObject(response.summaries))
  ) {
    throw new Error("Malformed parsed-region promotion response");
  }
}

function assertDeletionResponse(
  response: unknown,
): asserts response is DeletePersistedParsedRegionResponse {
  const updatedIntelligence = isNonArrayObject(response)
    ? response.updatedIntelligence
    : null;
  const parsedRegions = isNonArrayObject(updatedIntelligence)
    ? updatedIntelligence.parsedRegions
    : undefined;
  if (
    !isNonArrayObject(response) ||
    response.ok !== true ||
    typeof response.deleted !== "boolean" ||
    !isNonArrayObject(updatedIntelligence) ||
    (parsedRegions !== undefined && !Array.isArray(parsedRegions)) ||
    (response.deleted && !Array.isArray(parsedRegions)) ||
    (response.summaries !== null && !isNonArrayObject(response.summaries))
  ) {
    throw new Error("Malformed parsed-region deletion response");
  }
}

// Row-local UI barriers cannot order two different rows. Keep one fulfilled tail per project/page
// so locked server snapshots are also adopted in commit order inside this browser module. This is
// intentionally delete/delete-only; save/delete ordering remains a separate server/CAS problem.
const deletionTails = new Map<string, Promise<void>>();

function serializeParsedRegionDeletion<T>(
  publicId: string,
  pageNumber: number,
  task: () => Promise<T>,
): Promise<T> {
  const key = JSON.stringify([publicId, pageNumber]);
  const previous = deletionTails.get(key);
  const completion = previous ? previous.then(task) : task();
  const fulfilledTail = completion.then(
    () => undefined,
    () => undefined,
  );
  deletionTails.set(key, fulfilledTail);
  void fulfilledTail.then(() => {
    if (deletionTails.get(key) === fulfilledTail) deletionTails.delete(key);
  });
  return completion;
}

export async function saveParsedRegion(
  queryClient: QueryClient,
  target: SaveParsedRegionTarget,
  promotion: ParsedRegionPromotion,
): Promise<SaveParsedRegionResult> {
  // Capture identity before the first await. Callers normally pass a fresh object, but accepting a
  // mutable alias must never let P target A while A/S/X target a later B.
  const { publicId, isDemo, pageNumber } = target;
  // Demo is an intentional local-write product mode. Callers perform that local write before
  // entering this command; even a malformed/missing demo id must never become a persistence path.
  if (isDemo) return { status: "local", reason: "demo" };
  if (!publicId) return { status: "skipped", reason: "missing-public-id" };

  const response: unknown = await promoteParsedRegion(
    promotion.via === "parser"
      ? {
          publicId,
          pageNumber,
          type: promotion.type,
          regionId: promotion.regionId,
          bbox: promotion.bboxMinMax,
          data: promotion.data,
          category: promotion.category,
          csiTags: promotion.csiTags,
        }
      : {
          publicId,
          pageNumber,
          type: promotion.type,
          sourceTextRegionId: promotion.sourceTextRegionId,
        },
  );
  assertPromotionResponse(response);

  // Exact persistent tail: Persist -> authoritative Adoption -> optional Summaries -> spatial
  // recompute. The captured publicId/page owns every write, even if the visible session changes.
  setPageIntelligenceForPage(
    queryClient,
    publicId,
    pageNumber,
    response.updatedIntelligence,
  );
  if (response.summaries) {
    seedSummariesCache(queryClient, publicId, response.summaries);
  }
  refreshPageCsiSpatialMapForTarget(queryClient, publicId, pageNumber);

  return { status: "persisted", response };
}

/**
 * Transactional ParsedRegion deletion with one synchronously captured project/page/region target.
 * Real projects stay server-first; demos apply the same all-duplicates filter locally.
 */
export async function deleteParsedRegion(
  queryClient: QueryClient,
  target: DeleteParsedRegionTarget,
): Promise<DeleteParsedRegionResult> {
  const { publicId, isDemo, pageNumber, regionId } = target;
  if (!publicId) return { status: "skipped", reason: "missing-public-id" };
  if (!regionId) return { status: "skipped", reason: "missing-region-id" };

  if (isDemo) {
    updatePageIntelligenceForPage(queryClient, publicId, pageNumber, (current) => ({
      ...(current ?? {}),
      parsedRegions: (current?.parsedRegions ?? []).filter((region) => region.id !== regionId),
    }));
    refreshPageCsiSpatialMapForTarget(queryClient, publicId, pageNumber);
    return { status: "local", reason: "demo" };
  }

  return serializeParsedRegionDeletion(publicId, pageNumber, async () => {
    const response: unknown = await deletePersistedParsedRegion({
      publicId,
      pageNumber,
      regionId,
    });
    assertDeletionResponse(response);

    setPageIntelligenceForPage(
      queryClient,
      publicId,
      pageNumber,
      response.updatedIntelligence,
    );
    if (response.summaries) {
      seedSummariesCache(queryClient, publicId, response.summaries);
    }
    refreshPageCsiSpatialMapForTarget(queryClient, publicId, pageNumber);

    return { status: "persisted", response };
  });
}
