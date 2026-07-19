"use client";

import type { QueryClient } from "@tanstack/react-query";

import {
  SPLIT_ANNOTATION_BBOX_STORAGE_TOLERANCE,
  type SplitAnnotationRequest,
  type SplitAnnotationResponse,
  zSplitAnnotationResponse,
} from "@/lib/annotation-split-contract";
import { persistFetch } from "@/lib/client-persist";
import {
  captureProjectLifecycle,
  isCurrentProjectLifecycle,
  type ProjectLifecycleSnapshot,
} from "@/lib/project-lifecycle";
import { queryKeys } from "@/queries/queryKeys";
import type { ClientAnnotation } from "@/types";

/** The exact project/cache owner captured when a ready split is admitted. */
export interface CommitAnnotationSplitTarget {
  readonly publicId: string | null;
  readonly isDemo: boolean;
  readonly pageNumber: number;
  readonly lifecycle: ProjectLifecycleSnapshot | null;
  readonly source: ClientAnnotation;
}

export type CommitAnnotationSplitSkippedReason =
  | "demo"
  | "missing-public-id"
  | "nonpositive-source"
  | "lifecycle-retired"
  | "source-not-current";

export type CommitAnnotationSplitNotAdoptedReason =
  | "malformed-response"
  | "lifecycle-retired"
  | "cache-missing"
  | "source-not-current"
  | "right-id-collision"
  | "synchronous-successor";

export type CommitAnnotationSplitResult =
  | Readonly<{
      status: "adopted";
      left: ClientAnnotation;
      right: ClientAnnotation;
    }>
  | Readonly<{
      status: "persisted-not-adopted";
      reason: CommitAnnotationSplitNotAdoptedReason;
    }>
  | Readonly<{
      status: "skipped";
      reason: CommitAnnotationSplitSkippedReason;
    }>;

function ownsLifecycle(
  queryClient: QueryClient,
  publicId: string,
  isDemo: boolean,
  lifecycle: ProjectLifecycleSnapshot | null,
): boolean {
  if (lifecycle) {
    return (
      lifecycle.publicId === publicId &&
      lifecycle.demo === isDemo &&
      isCurrentProjectLifecycle(queryClient, lifecycle)
    );
  }

  // Component/unit harnesses that never install an open-project lifecycle retain their historical
  // behavior only while no lifecycle appears. A null capture can never borrow a later generation.
  return captureProjectLifecycle(queryClient) === null;
}

function sourceIndexByStrictIdentity(
  rows: ClientAnnotation[],
  source: ClientAnnotation,
  pageNumber: number,
): number {
  return rows.findIndex(
    (row) =>
      row.id === source.id && row.pageNumber === pageNumber && row === source,
  );
}

function polygonHasPositiveArea(
  vertices: readonly { x: number; y: number }[],
): boolean {
  let doubleArea = 0;
  for (let index = 0; index < vertices.length; index += 1) {
    const current = vertices[index];
    const next = vertices[(index + 1) % vertices.length];
    doubleArea += current.x * next.y - next.x * current.y;
  }
  return Number.isFinite(doubleArea) && Math.abs(doubleArea) > 0;
}

function bboxMatchesVertices(
  bbox: readonly [number, number, number, number],
  vertices: readonly { x: number; y: number }[],
): boolean {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const vertex of vertices) {
    minX = Math.min(minX, vertex.x);
    minY = Math.min(minY, vertex.y);
    maxX = Math.max(maxX, vertex.x);
    maxY = Math.max(maxY, vertex.y);
  }
  return (
    Math.abs(bbox[0] - minX) <= SPLIT_ANNOTATION_BBOX_STORAGE_TOLERANCE &&
    Math.abs(bbox[1] - minY) <= SPLIT_ANNOTATION_BBOX_STORAGE_TOLERANCE &&
    Math.abs(bbox[2] - maxX) <= SPLIT_ANNOTATION_BBOX_STORAGE_TOLERANCE &&
    Math.abs(bbox[3] - maxY) <= SPLIT_ANNOTATION_BBOX_STORAGE_TOLERANCE
  );
}

function sameStringArray(
  left: unknown,
  right: readonly string[] | undefined,
): boolean {
  if (left === undefined || right === undefined)
    return left === undefined && right === undefined;
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  );
}

/**
 * The shared schema proves the strict transport shape. These checks bind that shape to this exact
 * operation, so a valid annotation pair for a different page/item/request is still never adopted.
 */
function validateResponseForTarget(
  value: unknown,
  target: CommitAnnotationSplitTarget,
  request: SplitAnnotationRequest,
): SplitAnnotationResponse | null {
  const parsed = zSplitAnnotationResponse.safeParse(value);
  if (!parsed.success) return null;
  const response = value as SplitAnnotationResponse;
  const { left, right } = response;
  // Use the schema-narrowed data for semantic checks while retaining the exact raw response rows
  // for TanStack's canonical structural-sharing pass below.
  const leftData = parsed.data.left.data;
  const rightData = parsed.data.right.data;
  const expectedItemId = request.expectedSource.data.takeoffItemId;
  const expectedCsiCodes = request.expectedSource.data.csiCodes;
  const expectedKeywords = request.expectedSource.data.keywords;

  if (
    left.id !== target.source.id ||
    left.id !== request.sourceAnnotationId ||
    right.id === left.id ||
    left.pageNumber !== target.pageNumber ||
    right.pageNumber !== target.pageNumber ||
    left.name !== target.source.name ||
    left.note !== target.source.note ||
    right.note !== null ||
    typeof expectedItemId !== "number" ||
    !Number.isSafeInteger(expectedItemId) ||
    expectedItemId <= 0 ||
    leftData.takeoffItemId !== expectedItemId ||
    rightData.takeoffItemId !== expectedItemId ||
    leftData.color !== rightData.color ||
    leftData.areaSqUnits !== request.measurements.leftAreaSqUnits ||
    rightData.areaSqUnits !== request.measurements.rightAreaSqUnits ||
    leftData.unit !== request.measurements.unit ||
    rightData.unit !== request.measurements.unit ||
    !sameStringArray(expectedCsiCodes, leftData.csiCodes) ||
    !sameStringArray(expectedCsiCodes, rightData.csiCodes) ||
    !sameStringArray(expectedKeywords, leftData.keywords) ||
    !sameStringArray(expectedKeywords, rightData.keywords) ||
    !polygonHasPositiveArea(leftData.vertices) ||
    !polygonHasPositiveArea(rightData.vertices) ||
    !bboxMatchesVertices(left.bbox, leftData.vertices) ||
    !bboxMatchesVertices(right.bbox, rightData.vertices)
  ) {
    return null;
  }

  return response;
}

/**
 * Persist one positive-ID Split through the atomic endpoint, then conditionally adopt both
 * canonical rows into the already-warm annotations cache. The command owns no UI state and adds no
 * Query observer; all pre-wire refusal is returned as `skipped` and transport/server rejection is
 * deliberately allowed to throw to the owning gesture terminal.
 */
export async function commitAnnotationSplit(
  queryClient: QueryClient,
  target: CommitAnnotationSplitTarget,
  request: SplitAnnotationRequest,
): Promise<CommitAnnotationSplitResult> {
  const { publicId, isDemo, pageNumber, lifecycle, source } = target;

  if (isDemo) return { status: "skipped", reason: "demo" };
  if (!publicId) return { status: "skipped", reason: "missing-public-id" };
  if (!Number.isSafeInteger(source.id) || source.id <= 0) {
    return { status: "skipped", reason: "nonpositive-source" };
  }
  if (!ownsLifecycle(queryClient, publicId, isDemo, lifecycle)) {
    return { status: "skipped", reason: "lifecycle-retired" };
  }
  if (
    source.pageNumber !== pageNumber ||
    request.sourceAnnotationId !== source.id ||
    request.expectedSource.pageNumber !== pageNumber
  ) {
    return { status: "skipped", reason: "source-not-current" };
  }

  const key = queryKeys.annotations.all(publicId);
  const admittedRows = queryClient.getQueryData<ClientAnnotation[]>(key);
  if (
    !admittedRows ||
    sourceIndexByStrictIdentity(admittedRows, source, pageNumber) === -1
  ) {
    return { status: "skipped", reason: "source-not-current" };
  }

  const responseValue: unknown = await persistFetch(
    "/api/annotations/split",
    request,
    "POST",
  );
  const response = validateResponseForTarget(responseValue, target, request);
  if (!response) {
    return { status: "persisted-not-adopted", reason: "malformed-response" };
  }
  if (!ownsLifecycle(queryClient, publicId, isDemo, lifecycle)) {
    return { status: "persisted-not-adopted", reason: "lifecycle-retired" };
  }

  let failure: CommitAnnotationSplitNotAdoptedReason = "source-not-current";
  let sourceIndex = -1;
  const published = queryClient.setQueryData<ClientAnnotation[]>(
    key,
    (current) => {
      if (!ownsLifecycle(queryClient, publicId, isDemo, lifecycle)) {
        failure = "lifecycle-retired";
        return undefined;
      }
      if (!current) {
        failure = "cache-missing";
        return undefined;
      }

      sourceIndex = sourceIndexByStrictIdentity(current, source, pageNumber);
      if (sourceIndex === -1) {
        failure = "source-not-current";
        return undefined;
      }
      if (current.some((row) => row.id === response.right.id)) {
        failure = "right-id-collision";
        return undefined;
      }

      const next = [...current];
      next[sourceIndex] = response.left;
      next.push(response.right);
      return next;
    },
  );

  if (!published || sourceIndex === -1) {
    return { status: "persisted-not-adopted", reason: failure };
  }

  // Query listeners run synchronously. A listener can retire the project lifecycle without
  // replacing this cache key, so cache-reference identity alone is not a post-publication fence.
  if (!ownsLifecycle(queryClient, publicId, isDemo, lifecycle)) {
    return { status: "persisted-not-adopted", reason: "lifecycle-retired" };
  }

  // Query cache listeners run synchronously. Re-read after setQueryData so a listener-installed
  // same-key successor cannot be mistaken for this operation's adopted publication.
  const current = queryClient.getQueryData<ClientAnnotation[]>(key);
  if (current !== published) {
    return { status: "persisted-not-adopted", reason: "synchronous-successor" };
  }

  return {
    status: "adopted",
    left: published[sourceIndex],
    right: published[published.length - 1],
  };
}
