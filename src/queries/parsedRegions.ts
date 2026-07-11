import type { QueryClient } from "@tanstack/react-query";

import {
  promoteParsedRegion,
  type ParsedRegionKind,
  type ParsedRegionPromotionCsiTag,
  type PromoteParsedRegionResponse,
} from "@/lib/client-persist";
import { refreshPageCsiSpatialMapForTarget } from "@/lib/csi-spatial-refresh-target";
import { setPageIntelligenceForPage } from "@/queries/usePageWindow";
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

  const response = await promoteParsedRegion(
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
