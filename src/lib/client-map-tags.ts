import type { QtoItemType } from "@/types";
import type {
  ClassScanResult,
  DropReason,
  ScoredMatch,
} from "@/lib/tag-mapping";

/**
 * [refactor jul11 P2.4 C1/C3] Store-free wire boundary for map-tags-batch.
 *
 * Payload construction, request ownership, retry/abort policy, result interpretation, cache
 * publication, and UI errors stay with callers. This leaf owns only shared HTTP mechanics; C3
 * converged six callers here without creating a cross-feature command object.
 */

export type MapTagsStrictnessMode = "strict" | "balanced" | "lenient";

export interface MapTagsMapRequest {
  /** Omitted by all current map callers; accepted to mirror the route's explicit mode. */
  action?: "map";
  tags: string[];
  yoloClass?: string;
  yoloModel?: string;
  itemType?: QtoItemType;
  tagShapeClass?: string;
  selectedPages?: number[];
  strictnessMode?: MapTagsStrictnessMode;
  drawingNumberPrefixes?: string[];
}

export interface MapTagsScanRequest {
  action: "scanClass";
  yoloClass: string;
  yoloModel?: string;
}

export interface MapTagsMapResponse {
  results: Record<string, ScoredMatch[]>;
  dropCounts: Record<DropReason, number>;
  strictnessMode: MapTagsStrictnessMode;
}

export interface MapTagsScanResponse {
  texts: ClassScanResult[];
}

export type MapTagsHttpResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number };

export interface MapTagsRequestOptions {
  signal?: AbortSignal;
}

export function requestMapTagsBatch(
  publicId: string,
  request: MapTagsScanRequest,
  options?: MapTagsRequestOptions,
): Promise<MapTagsHttpResult<MapTagsScanResponse>>;
export function requestMapTagsBatch(
  publicId: string,
  request: MapTagsMapRequest,
  options?: MapTagsRequestOptions,
): Promise<MapTagsHttpResult<MapTagsMapResponse>>;
export async function requestMapTagsBatch(
  publicId: string,
  request: MapTagsMapRequest | MapTagsScanRequest,
  options: MapTagsRequestOptions = {},
): Promise<MapTagsHttpResult<MapTagsMapResponse | MapTagsScanResponse>> {
  const response = await fetch(`/api/projects/${publicId}/map-tags-batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  // Caller-specific error text differs across all six current owners. Preserve that policy by
  // returning only status and, critically, never consuming a non-OK body here.
  if (!response.ok) return { ok: false, status: response.status };

  return {
    ok: true,
    data: await response.json() as MapTagsMapResponse | MapTagsScanResponse,
  };
}
