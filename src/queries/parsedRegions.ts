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

const PARSED_REGION_TYPES = new Set(["schedule", "keynote", "legend", "notes", "spec"]);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(isFiniteNumber);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isCsiTagPayload(value: unknown): boolean {
  return isNonArrayObject(value) &&
    typeof value.code === "string" &&
    typeof value.description === "string";
}

function isParsedRegionPayload(value: unknown): value is Record<string, unknown> {
  if (!isNonArrayObject(value)) return false;
  if (
    typeof value.id !== "string" || value.id.length === 0 ||
    typeof value.type !== "string" || !PARSED_REGION_TYPES.has(value.type) ||
    typeof value.category !== "string" ||
    !Array.isArray(value.bbox) || value.bbox.length !== 4 || !value.bbox.every(isFiniteNumber) ||
    !isFiniteNumber(value.confidence) ||
    !isNonArrayObject(value.data) ||
    (value.source !== undefined && value.source !== "user" && value.source !== "auto-detected") ||
    (value.sourceTextRegionId !== undefined && typeof value.sourceTextRegionId !== "string")
  ) {
    return false;
  }
  return value.csiTags === undefined || (
    Array.isArray(value.csiTags) && value.csiTags.every(isCsiTagPayload)
  );
}

/** Compare JSON response values without depending on object-property insertion order. */
function isJsonEquivalent(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => isJsonEquivalent(entry, right[index]));
  }
  if (!isNonArrayObject(left) || !isNonArrayObject(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) =>
      key === rightKeys[index] && isJsonEquivalent(left[key], right[key]));
}

function isRecordOf(
  value: unknown,
  predicate: (entry: unknown) => boolean,
): value is Record<string, unknown> {
  return isNonArrayObject(value) && Object.values(value).every(predicate);
}

function hasValidSummaryOptionals(value: Record<string, unknown>): boolean {
  return (
    (value.pageName === undefined || typeof value.pageName === "string") &&
    (value.drawingNumber === undefined || value.drawingNumber === null ||
      typeof value.drawingNumber === "string") &&
    (value.headerText === undefined || typeof value.headerText === "string") &&
    (value.tier1 === undefined || typeof value.tier1 === "string") &&
    (value.tier2 === undefined || typeof value.tier2 === "string") &&
    (value.csiTags === undefined || (
      Array.isArray(value.csiTags) && value.csiTags.every(isCsiTagPayload)
    )) &&
    (value.bbox === undefined || (
      Array.isArray(value.bbox) && value.bbox.length === 4 && value.bbox.every(isFiniteNumber)
    )) &&
    (value.regionId === undefined || typeof value.regionId === "string")
  );
}

function isNotesSummaryPayload(value: unknown): boolean {
  return isNonArrayObject(value) &&
    isFiniteNumber(value.pageNum) &&
    (value.type === "notes-numbered" || value.type === "notes-key-value") &&
    isFiniteNumber(value.confidence) &&
    (value.trade === undefined || typeof value.trade === "string") &&
    (value.rowCount === undefined || isFiniteNumber(value.rowCount)) &&
    hasValidSummaryOptionals(value);
}

function isSpecSummaryPayload(value: unknown): boolean {
  return isNonArrayObject(value) &&
    isFiniteNumber(value.pageNum) &&
    isFiniteNumber(value.confidence) &&
    (value.wordCount === undefined || isFiniteNumber(value.wordCount)) &&
    hasValidSummaryOptionals(value);
}

function isProjectSummariesPayload(value: unknown): boolean {
  if (!isNonArrayObject(value)) return false;
  const annotationSummary = value.annotationSummary;
  if (!isNonArrayObject(annotationSummary)) return false;

  return (
    Array.isArray(value.schedules) && value.schedules.every((entry) =>
      isNonArrayObject(entry) && isFiniteNumber(entry.pageNum) &&
      typeof entry.category === "string" && typeof entry.name === "string" &&
      isFiniteNumber(entry.confidence)) &&
    Array.isArray(value.parsedTables) && value.parsedTables.every((entry) =>
      isNonArrayObject(entry) && isFiniteNumber(entry.pageNum) &&
      typeof entry.name === "string" && typeof entry.category === "string" &&
      isFiniteNumber(entry.rowCount) && isFiniteNumber(entry.colCount)) &&
    Array.isArray(value.keynoteTablePages) && value.keynoteTablePages.every((entry) =>
      isNonArrayObject(entry) && isFiniteNumber(entry.pageNum) &&
    isFiniteNumber(entry.confidence)) &&
    (value.notesRegions === undefined || (
      Array.isArray(value.notesRegions) && value.notesRegions.every(isNotesSummaryPayload)
    )) &&
    (value.specRegions === undefined || (
      Array.isArray(value.specRegions) && value.specRegions.every(isSpecSummaryPayload)
    )) &&
    isRecordOf(value.csiPageIndex, isNumberArray) &&
    isRecordOf(value.tradePageIndex, isNumberArray) &&
    isRecordOf(value.keynotePageIndex, isNumberArray) &&
    isRecordOf(value.textAnnotationPageIndex, isNumberArray) &&
    isRecordOf(value.pageClassifications, (entry) =>
      isNonArrayObject(entry) && typeof entry.discipline === "string" &&
      typeof entry.prefix === "string") &&
    isStringArray(annotationSummary.modelNames) &&
    isRecordOf(annotationSummary.categoryCounts, (entry) =>
      isNonArrayObject(entry) && isFiniteNumber(entry.count) && isNumberArray(entry.pages)) &&
    isRecordOf(annotationSummary.pageAnnotationCounts, (entry) =>
      isNonArrayObject(entry) && isFiniteNumber(entry.yolo) &&
      isFiniteNumber(entry.user) && isFiniteNumber(entry.takeoff)) &&
    isRecordOf(value.takeoffTotals, (entry) =>
      isNonArrayObject(entry) && isFiniteNumber(entry.count) &&
      isFiniteNumber(entry.totalArea) && isNumberArray(entry.pages)) &&
    isStringArray(value.allTrades) &&
    Array.isArray(value.allCsiCodes) && value.allCsiCodes.every((entry) =>
      isNonArrayObject(entry) && typeof entry.code === "string" &&
      typeof entry.description === "string")
  );
}

function assertPromotionResponse(
  response: unknown,
): asserts response is PromoteParsedRegionResponse {
  const updatedIntelligence = isNonArrayObject(response)
    ? response.updatedIntelligence
    : null;
  const parsedRegions = isNonArrayObject(updatedIntelligence)
    ? updatedIntelligence.parsedRegions
    : null;
  if (
    !isNonArrayObject(response) ||
    response.ok !== true ||
    !isParsedRegionPayload(response.parsedRegion) ||
    !isNonArrayObject(updatedIntelligence) ||
    !Array.isArray(parsedRegions) ||
    !parsedRegions.every(isParsedRegionPayload) ||
    !parsedRegions.some((region) => isJsonEquivalent(region, response.parsedRegion)) ||
    (response.summaries !== null && !isProjectSummariesPayload(response.summaries))
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
    (Array.isArray(parsedRegions) && !parsedRegions.every(isParsedRegionPayload)) ||
    (response.summaries !== null && !isProjectSummariesPayload(response.summaries))
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
