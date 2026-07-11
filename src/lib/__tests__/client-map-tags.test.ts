// @vitest-environment node
// [refactor jul11 P2.4 C1] Production-dead typed map transport contract.

import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  requestMapTagsBatch,
  type MapTagsHttpResult,
  type MapTagsMapRequest,
  type MapTagsMapResponse,
  type MapTagsRequestOptions,
  type MapTagsScanRequest,
  type MapTagsScanResponse,
} from "@/lib/client-map-tags";
import type { ClassScanResult, DropReason, ScoredMatch } from "@/lib/tag-mapping";
import type { QtoItemType } from "@/types";

// The contravariant form is deliberately stricter than mutual assignability: structural object
// assignment can ignore an added optional key, while this equality ledger must reject it.
type ExactType<Actual, Expected> =
  (<Value>() => Value extends Actual ? 1 : 2) extends
    (<Value>() => Value extends Expected ? 1 : 2)
    ? (<Value>() => Value extends Expected ? 1 : 2) extends
        (<Value>() => Value extends Actual ? 1 : 2)
      ? true
      : false
    : false;

type ExpectedMapRequest = {
  action?: "map";
  tags: string[];
  yoloClass?: string;
  yoloModel?: string;
  itemType?: QtoItemType;
  tagShapeClass?: string;
  selectedPages?: number[];
  strictnessMode?: "strict" | "balanced" | "lenient";
  drawingNumberPrefixes?: string[];
};
type ExpectedScanRequest = {
  action: "scanClass";
  yoloClass: string;
  yoloModel?: string;
};
type ExpectedMapResponse = {
  results: Record<string, ScoredMatch[]>;
  dropCounts: Record<DropReason, number>;
  strictnessMode: "strict" | "balanced" | "lenient";
};
type ExpectedScanResponse = { texts: ClassScanResult[] };
type ExpectedOptions = { signal?: AbortSignal };
type ExpectedResult =
  | { ok: true; data: { marker: true } }
  | { ok: false; status: number };

// Independent compile-time ledgers: exported types cannot make their own optional/required shape
// mutation look valid merely because runtime fixtures happen not to exercise the changed field.
const MAP_REQUEST_TYPE_IS_EXACT: ExactType<MapTagsMapRequest, ExpectedMapRequest> = true;
const SCAN_REQUEST_TYPE_IS_EXACT: ExactType<MapTagsScanRequest, ExpectedScanRequest> = true;
const MAP_RESPONSE_TYPE_IS_EXACT: ExactType<MapTagsMapResponse, ExpectedMapResponse> = true;
const SCAN_RESPONSE_TYPE_IS_EXACT: ExactType<MapTagsScanResponse, ExpectedScanResponse> = true;
const OPTIONS_TYPE_IS_EXACT: ExactType<MapTagsRequestOptions, ExpectedOptions> = true;
const RESULT_TYPE_IS_EXACT: ExactType<
  MapTagsHttpResult<{ marker: true }>,
  ExpectedResult
> = true;
void [
  MAP_REQUEST_TYPE_IS_EXACT,
  SCAN_REQUEST_TYPE_IS_EXACT,
  MAP_RESPONSE_TYPE_IS_EXACT,
  SCAN_RESPONSE_TYPE_IS_EXACT,
  OPTIONS_TYPE_IS_EXACT,
  RESULT_TYPE_IS_EXACT,
];

const fetchMock = vi.fn();

function response(args: {
  ok: boolean;
  status?: number;
  json?: ReturnType<typeof vi.fn>;
}): Response {
  return {
    ok: args.ok,
    status: args.status ?? (args.ok ? 200 : 500),
    json: args.json ?? vi.fn().mockResolvedValue({}),
  } as unknown as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("requestMapTagsBatch wire boundary", () => {
  it("posts the exact caller map object and forwards the exact AbortSignal", async () => {
    const request: MapTagsMapRequest = {
      tags: ["D-101", "D-102"],
      yoloClass: "door_single",
      yoloModel: "doors-v4",
      itemType: "yolo-with-inner-text",
      selectedPages: [3, 7],
      strictnessMode: "strict",
      drawingNumberPrefixes: ["A-"],
    };
    const signal = new AbortController().signal;
    const serverData: MapTagsMapResponse = {
      results: { "D-101": [] },
      dropCounts: {
        outside_scope: 1,
        pattern_mismatch: 0,
        inside_title_block: 0,
        inside_table: 2,
        outside_drawings: 0,
      },
      strictnessMode: "strict",
    };
    fetchMock.mockResolvedValue(response({
      ok: true,
      json: vi.fn().mockResolvedValue(serverData),
    }));

    const promise = requestMapTagsBatch("project-A", request, { signal });
    expectTypeOf(promise).toEqualTypeOf<Promise<MapTagsHttpResult<MapTagsMapResponse>>>();
    const result = await promise;

    expect(result).toEqual({ ok: true, data: serverData });
    expect(result.ok && result.data).toBe(serverData);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/projects/project-A/map-tags-batch");
    expect(fetchMock.mock.calls[0][1]).toEqual({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
    expect(fetchMock.mock.calls[0][1].signal).toBe(signal);
    expect(request).toEqual({
      tags: ["D-101", "D-102"],
      yoloClass: "door_single",
      yoloModel: "doors-v4",
      itemType: "yolo-with-inner-text",
      selectedPages: [3, 7],
      strictnessMode: "strict",
      drawingNumberPrefixes: ["A-"],
    });
  });

  it("keeps scanClass on its distinct typed request and response shape", async () => {
    const texts: MapTagsScanResponse["texts"] = [{
      text: "D-101",
      count: 2,
      pages: [1, 4],
      instances: [],
    }];
    const serverData: MapTagsScanResponse = { texts };
    const json = vi.fn().mockResolvedValue(serverData);
    fetchMock.mockResolvedValue(response({ ok: true, json }));

    const promise = requestMapTagsBatch("project-B", {
      action: "scanClass",
      yoloClass: "door_single",
      yoloModel: "doors-v4",
    });
    expectTypeOf(promise).toEqualTypeOf<Promise<MapTagsHttpResult<MapTagsScanResponse>>>();
    await expect(promise).resolves.toEqual({ ok: true, data: serverData });
    expect(fetchMock.mock.calls[0][1]).toEqual({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "scanClass",
        yoloClass: "door_single",
        yoloModel: "doors-v4",
      }),
    });
    expect(json).toHaveBeenCalledTimes(1);
  });

  it("does not inject map action/defaults and preserves explicit empty arrays on the wire", async () => {
    const request: MapTagsMapRequest = {
      tags: ["T-1"],
      yoloClass: undefined,
      selectedPages: [],
      drawingNumberPrefixes: [],
    };
    fetchMock.mockResolvedValue(response({
      ok: true,
      json: vi.fn().mockResolvedValue({
        results: {},
        dropCounts: {},
        strictnessMode: "balanced",
      }),
    }));

    await requestMapTagsBatch("P", request);

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      tags: ["T-1"],
      selectedPages: [],
      drawingNumberPrefixes: [],
    });
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty("signal");
    expect(request).toHaveProperty("yoloClass", undefined);
    expect(request).not.toHaveProperty("action");
  });

  it("returns only non-OK status and never consumes its body", async () => {
    const json = vi.fn().mockRejectedValue(new Error("must not parse"));
    fetchMock.mockResolvedValue(response({ ok: false, status: 429, json }));

    await expect(requestMapTagsBatch("P", { tags: ["T"] })).resolves.toEqual({
      ok: false,
      status: 429,
    });
    expect(json).not.toHaveBeenCalled();
  });

  it("does not add defaults or normalize a successful JSON object", async () => {
    const serverData = { results: {}, serverOnly: { retain: true } };
    fetchMock.mockResolvedValue(response({
      ok: true,
      json: vi.fn().mockResolvedValue(serverData),
    }));

    const result = await requestMapTagsBatch("P", { tags: [" raw "] });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe(serverData);
  });

  it("propagates network, AbortError, and success-JSON failures unchanged", async () => {
    const networkError = new TypeError("socket closed");
    fetchMock.mockRejectedValueOnce(networkError);
    await expect(requestMapTagsBatch("P", { tags: ["T"] })).rejects.toBe(networkError);

    const abortError = new DOMException("cancelled", "AbortError");
    fetchMock.mockRejectedValueOnce(abortError);
    await expect(requestMapTagsBatch("P", { tags: ["T"] })).rejects.toBe(abortError);

    const jsonError = new SyntaxError("bad json");
    fetchMock.mockResolvedValueOnce(response({
      ok: true,
      json: vi.fn().mockRejectedValue(jsonError),
    }));
    await expect(requestMapTagsBatch("P", { tags: ["T"] })).rejects.toBe(jsonError);
  });
});
