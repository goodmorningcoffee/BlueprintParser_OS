// @vitest-environment node
// [refactor jul19 P3.2] Atomic Split query command: server-first wire and exact cache adoption.

import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  SplitAnnotationRequest,
  SplitAnnotationResponse,
} from "@/lib/annotation-split-contract";
import { persistFetch } from "@/lib/client-persist";
import {
  captureProjectLifecycle,
  isCurrentProjectLifecycle,
  type ProjectLifecycleSnapshot,
} from "@/lib/project-lifecycle";
import {
  commitAnnotationSplit,
  type CommitAnnotationSplitTarget,
} from "@/queries/annotationSplit";
import { queryKeys } from "@/queries/queryKeys";
import type { ClientAnnotation } from "@/types";

vi.mock("@/lib/client-persist", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-persist")>();
  return { ...actual, persistFetch: vi.fn() };
});

vi.mock("@/lib/project-lifecycle", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/project-lifecycle")>();
  return {
    ...actual,
    captureProjectLifecycle: vi.fn(),
    isCurrentProjectLifecycle: vi.fn(),
  };
});

const captureLifecycleMock = vi.mocked(captureProjectLifecycle);
const isCurrentLifecycleMock = vi.mocked(isCurrentProjectLifecycle);
const persistMock = vi.mocked(persistFetch);

const PUBLIC_ID = "project-A";
const PAGE = 4;
const SOURCE_ID = 41;
const RIGHT_ID = 73;
const KEY = queryKeys.annotations.all(PUBLIC_ID);

function sourceAnnotation(
  overrides: Partial<ClientAnnotation> = {},
): ClientAnnotation {
  return {
    id: SOURCE_ID,
    pageNumber: PAGE,
    name: "Source item name",
    bbox: [0.1, 0.1, 0.9, 0.9],
    note: "preserve-left-note",
    source: "takeoff",
    data: {
      type: "area-polygon",
      takeoffItemId: 17,
      color: "#123456",
      vertices: [
        { x: 0.1, y: 0.1 },
        { x: 0.9, y: 0.1 },
        { x: 0.9, y: 0.9 },
        { x: 0.1, y: 0.9 },
      ],
      areaSqUnits: 100,
      unit: "SF",
      csiCodes: ["03 30 00"],
      keywords: ["slab"],
    },
    ...overrides,
  };
}

function neighbor(id: number, pageNumber = PAGE): ClientAnnotation {
  return {
    id,
    pageNumber,
    name: `neighbor-${id}`,
    bbox: [0.01, 0.01, 0.02, 0.02],
    note: null,
    source: "user",
    data: null,
  };
}

function splitRequest(source: ClientAnnotation): SplitAnnotationRequest {
  return {
    sourceAnnotationId: source.id,
    expectedSource: {
      pageNumber: source.pageNumber,
      bbox: source.bbox,
      data: source.data as Record<string, unknown>,
    },
    lineA: { x: 0.5, y: 0 },
    lineB: { x: 0.5, y: 1 },
    measurements: {
      leftAreaSqUnits: 40,
      rightAreaSqUnits: 60,
      unit: "SF",
    },
  };
}

function splitResponse(): SplitAnnotationResponse {
  return {
    left: {
      id: SOURCE_ID,
      pageNumber: PAGE,
      name: "Source item name",
      bbox: [0.1, 0.1, 0.5, 0.9],
      note: "preserve-left-note",
      source: "takeoff",
      data: {
        type: "area-polygon",
        takeoffItemId: 17,
        color: "#abcdef",
        vertices: [
          { x: 0.1, y: 0.1 },
          { x: 0.5, y: 0.1 },
          { x: 0.5, y: 0.9 },
          { x: 0.1, y: 0.9 },
        ],
        areaSqUnits: 40,
        unit: "SF",
        csiCodes: ["03 30 00"],
        keywords: ["slab"],
      },
    },
    right: {
      id: RIGHT_ID,
      pageNumber: PAGE,
      name: "Current item name",
      bbox: [0.5, 0.1, 0.9, 0.9],
      note: null,
      source: "takeoff",
      data: {
        type: "area-polygon",
        takeoffItemId: 17,
        color: "#abcdef",
        vertices: [
          { x: 0.5, y: 0.1 },
          { x: 0.9, y: 0.1 },
          { x: 0.9, y: 0.9 },
          { x: 0.5, y: 0.9 },
        ],
        areaSqUnits: 60,
        unit: "SF",
        csiCodes: ["03 30 00"],
        keywords: ["slab"],
      },
    },
  };
}

function target(
  source: ClientAnnotation,
  overrides: Partial<CommitAnnotationSplitTarget> = {},
): CommitAnnotationSplitTarget {
  return {
    publicId: PUBLIC_ID,
    isDemo: false,
    pageNumber: PAGE,
    lifecycle: null,
    source,
    ...overrides,
  };
}

function seed(rows: ClientAnnotation[]): ClientAnnotation[] {
  queryClient.setQueryData<ClientAnnotation[]>(KEY, rows);
  return queryClient.getQueryData<ClientAnnotation[]>(KEY)!;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeLifecycle(): ProjectLifecycleSnapshot {
  return {
    generation: 9,
    publicId: PUBLIC_ID,
    demo: false,
  } as unknown as ProjectLifecycleSnapshot;
}

let queryClient: QueryClient;

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  persistMock.mockReset();
  captureLifecycleMock.mockReset();
  captureLifecycleMock.mockReturnValue(null);
  isCurrentLifecycleMock.mockReset();
  isCurrentLifecycleMock.mockReturnValue(true);
});

afterEach(() => {
  queryClient.clear();
  vi.restoreAllMocks();
});

describe("commitAnnotationSplit", () => {
  it("sends one exact POST, keeps the cache cold until settlement, then adopts at source position", async () => {
    const beforeNeighbor = neighbor(11);
    const initialSource = sourceAnnotation();
    const afterNeighbor = neighbor(12);
    const admitted = seed([beforeNeighbor, initialSource, afterNeighbor]);
    const source = admitted[1];
    const request = splitRequest(source);
    const response = splitResponse();
    const wire = deferred<unknown>();
    persistMock.mockReturnValueOnce(wire.promise);
    const setSpy = vi.spyOn(queryClient, "setQueryData");

    const pending = commitAnnotationSplit(queryClient, target(source), request);

    expect(persistMock).toHaveBeenCalledTimes(1);
    expect(persistMock).toHaveBeenCalledWith(
      "/api/annotations/split",
      request,
      "POST",
    );
    expect(queryClient.getQueryData<ClientAnnotation[]>(KEY)).toBe(admitted);
    expect(queryClient.getQueryData<ClientAnnotation[]>(KEY)?.[1]).toBe(source);
    expect(setSpy).not.toHaveBeenCalled();

    wire.resolve(response);
    const result = await pending;
    const adopted = queryClient.getQueryData<ClientAnnotation[]>(KEY)!;

    expect(result.status).toBe("adopted");
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(typeof setSpy.mock.calls[0][1]).toBe("function");
    expect(adopted).not.toBe(admitted);
    expect(adopted).toHaveLength(4);
    expect(adopted[0]).toBe(beforeNeighbor);
    expect(adopted[1]).toEqual(response.left);
    expect(adopted[2]).toBe(afterNeighbor);
    expect(adopted[3]).toEqual(response.right);
    if (result.status === "adopted") {
      expect(result.left).toBe(adopted[1]);
      expect(result.right).toBe(adopted[3]);
    }
  });

  it("uses strict ID+page identity and preserves a pending interleaved append by reference", async () => {
    const sameIdOtherPage = sourceAnnotation({
      pageNumber: PAGE + 1,
      name: "other-page",
    });
    const initialSource = sourceAnnotation();
    const admitted = seed([sameIdOtherPage, initialSource]);
    const source = admitted[1];
    const wire = deferred<unknown>();
    persistMock.mockReturnValueOnce(wire.promise);

    const pending = commitAnnotationSplit(
      queryClient,
      target(source),
      splitRequest(source),
    );
    const interleaved = neighbor(88);
    queryClient.setQueryData<ClientAnnotation[]>(KEY, (current) => [
      ...current!,
      interleaved,
    ]);
    const interleavedRows = queryClient.getQueryData<ClientAnnotation[]>(KEY)!;
    wire.resolve(splitResponse());

    await expect(pending).resolves.toMatchObject({ status: "adopted" });
    const adopted = queryClient.getQueryData<ClientAnnotation[]>(KEY)!;
    expect(adopted[0]).toBe(sameIdOtherPage);
    expect(adopted[1]).toEqual(splitResponse().left);
    expect(adopted[2]).toBe(interleavedRows[2]);
    expect(adopted[2]).toBe(interleaved);
    expect(adopted[3]).toEqual(splitResponse().right);
  });

  it("refuses demo, missing project, nonpositive source, and cold/replaced source before wire", async () => {
    const positive = sourceAnnotation();
    const admitted = seed([positive]);
    const source = admitted[0];
    const request = splitRequest(source);
    const exactBefore = queryClient.getQueryData<ClientAnnotation[]>(KEY);

    await expect(
      commitAnnotationSplit(
        queryClient,
        target(source, { isDemo: true }),
        request,
      ),
    ).resolves.toEqual({ status: "skipped", reason: "demo" });
    await expect(
      commitAnnotationSplit(
        queryClient,
        target(source, { publicId: null }),
        request,
      ),
    ).resolves.toEqual({ status: "skipped", reason: "missing-public-id" });

    const negative = sourceAnnotation({ id: -10 });
    seed([negative]);
    const canonicalNegative =
      queryClient.getQueryData<ClientAnnotation[]>(KEY)![0];
    await expect(
      commitAnnotationSplit(
        queryClient,
        target(canonicalNegative),
        splitRequest(canonicalNegative),
      ),
    ).resolves.toEqual({ status: "skipped", reason: "nonpositive-source" });

    seed([source]);
    await expect(
      commitAnnotationSplit(queryClient, target({ ...source }), request),
    ).resolves.toEqual({ status: "skipped", reason: "source-not-current" });

    queryClient.removeQueries({ queryKey: KEY, exact: true });
    await expect(
      commitAnnotationSplit(queryClient, target(source), request),
    ).resolves.toEqual({ status: "skipped", reason: "source-not-current" });

    expect(persistMock).not.toHaveBeenCalled();
    expect(exactBefore?.[0]).toBe(source);
    expect(queryClient.getQueryState(KEY)).toBeUndefined();
  });

  it("refuses an already-retired lifecycle before wire", async () => {
    const admitted = seed([sourceAnnotation()]);
    const source = admitted[0];
    isCurrentLifecycleMock.mockReturnValue(false);

    await expect(
      commitAnnotationSplit(
        queryClient,
        target(source, { lifecycle: fakeLifecycle() }),
        splitRequest(source),
      ),
    ).resolves.toEqual({ status: "skipped", reason: "lifecycle-retired" });
    expect(persistMock).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(KEY)).toBe(admitted);
  });

  it("throws a server/transport rejection with the cache reference-exact", async () => {
    const admitted = seed([sourceAnnotation()]);
    const source = admitted[0];
    const error = new Error("stale source");
    persistMock.mockRejectedValueOnce(error);

    await expect(
      commitAnnotationSplit(queryClient, target(source), splitRequest(source)),
    ).rejects.toBe(error);
    expect(persistMock).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(KEY)).toBe(admitted);
    expect(queryClient.getQueryData<ClientAnnotation[]>(KEY)?.[0]).toBe(source);
  });

  it("settles durably but does not adopt after lifecycle retirement", async () => {
    const admitted = seed([sourceAnnotation()]);
    const source = admitted[0];
    const lifecycle = fakeLifecycle();
    const wire = deferred<unknown>();
    persistMock.mockReturnValueOnce(wire.promise);

    const pending = commitAnnotationSplit(
      queryClient,
      target(source, { lifecycle }),
      splitRequest(source),
    );
    isCurrentLifecycleMock.mockReturnValue(false);
    wire.resolve(splitResponse());

    await expect(pending).resolves.toEqual({
      status: "persisted-not-adopted",
      reason: "lifecycle-retired",
    });
    expect(queryClient.getQueryData(KEY)).toBe(admitted);
  });

  it("rechecks lifecycle inside the functional updater", async () => {
    const admitted = seed([sourceAnnotation()]);
    const source = admitted[0];
    const lifecycle = fakeLifecycle();
    persistMock.mockResolvedValueOnce(splitResponse());
    isCurrentLifecycleMock
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    await expect(
      commitAnnotationSplit(
        queryClient,
        target(source, { lifecycle }),
        splitRequest(source),
      ),
    ).resolves.toEqual({
      status: "persisted-not-adopted",
      reason: "lifecycle-retired",
    });
    expect(queryClient.getQueryData(KEY)).toBe(admitted);
  });

  it("does not overwrite an exact-ID/page source successor installed while the request is pending", async () => {
    const admitted = seed([sourceAnnotation(), neighbor(12)]);
    const source = admitted[0];
    const wire = deferred<unknown>();
    persistMock.mockReturnValueOnce(wire.promise);
    const pending = commitAnnotationSplit(
      queryClient,
      target(source),
      splitRequest(source),
    );

    queryClient.setQueryData<ClientAnnotation[]>(KEY, (current) =>
      current!.map((row) =>
        row === source ? { ...row, name: "same-lifecycle-successor" } : row,
      ),
    );
    const successor = queryClient.getQueryData<ClientAnnotation[]>(KEY)!;
    wire.resolve(splitResponse());

    await expect(pending).resolves.toEqual({
      status: "persisted-not-adopted",
      reason: "source-not-current",
    });
    expect(queryClient.getQueryData(KEY)).toBe(successor);
  });

  it("never recreates a cache removed while the request is pending", async () => {
    const admitted = seed([sourceAnnotation()]);
    const source = admitted[0];
    const wire = deferred<unknown>();
    persistMock.mockReturnValueOnce(wire.promise);
    const pending = commitAnnotationSplit(
      queryClient,
      target(source),
      splitRequest(source),
    );

    queryClient.removeQueries({ queryKey: KEY, exact: true });
    wire.resolve(splitResponse());

    await expect(pending).resolves.toEqual({
      status: "persisted-not-adopted",
      reason: "cache-missing",
    });
    expect(queryClient.getQueryState(KEY)).toBeUndefined();
  });

  it("does not adopt when the authoritative right ID collides with an interleaved row", async () => {
    const admitted = seed([sourceAnnotation()]);
    const source = admitted[0];
    const wire = deferred<unknown>();
    persistMock.mockReturnValueOnce(wire.promise);
    const pending = commitAnnotationSplit(
      queryClient,
      target(source),
      splitRequest(source),
    );

    queryClient.setQueryData<ClientAnnotation[]>(KEY, (current) => [
      ...current!,
      neighbor(RIGHT_ID),
    ]);
    const successor = queryClient.getQueryData<ClientAnnotation[]>(KEY)!;
    wire.resolve(splitResponse());

    await expect(pending).resolves.toEqual({
      status: "persisted-not-adopted",
      reason: "right-id-collision",
    });
    expect(queryClient.getQueryData(KEY)).toBe(successor);
  });

  it("adopts canonical float4-rounded bboxes that still match JSONB vertex extrema", async () => {
    const admitted = seed([sourceAnnotation()]);
    const source = admitted[0];
    const splitX = 1 / 3;
    const storedSplitX = Math.fround(splitX);
    const leftAreaSqUnits = 100 * ((splitX - 0.1) / 0.8);
    const rightAreaSqUnits = 100 - leftAreaSqUnits;
    const request = {
      ...splitRequest(source),
      lineA: { x: splitX, y: 0 },
      lineB: { x: splitX, y: 1 },
      measurements: {
        leftAreaSqUnits,
        rightAreaSqUnits,
        unit: "SF" as const,
      },
    };
    const response = splitResponse();
    response.left.bbox = [0.1, 0.1, storedSplitX, 0.9];
    response.left.data!.vertices = [
      { x: 0.1, y: 0.1 },
      { x: splitX, y: 0.1 },
      { x: splitX, y: 0.9 },
      { x: 0.1, y: 0.9 },
    ];
    response.left.data!.areaSqUnits = leftAreaSqUnits;
    response.right.bbox = [storedSplitX, 0.1, 0.9, 0.9];
    response.right.data!.vertices = [
      { x: splitX, y: 0.1 },
      { x: 0.9, y: 0.1 },
      { x: 0.9, y: 0.9 },
      { x: splitX, y: 0.9 },
    ];
    response.right.data!.areaSqUnits = rightAreaSqUnits;
    persistMock.mockResolvedValueOnce(response);

    await expect(
      commitAnnotationSplit(queryClient, target(source), request),
    ).resolves.toMatchObject({ status: "adopted" });
    expect(queryClient.getQueryData<ClientAnnotation[]>(KEY)).toHaveLength(2);
  });

  it.each<[string, () => unknown]>([
    ["null", () => null],
    ["unknown top-level field", () => ({ ...splitResponse(), extra: true })],
    [
      "wrong left ID",
      () => {
        const response = splitResponse();
        return { ...response, left: { ...response.left, id: SOURCE_ID + 1 } };
      },
    ],
    [
      "same right ID",
      () => {
        const response = splitResponse();
        return { ...response, right: { ...response.right, id: SOURCE_ID } };
      },
    ],
    [
      "wrong page",
      () => {
        const response = splitResponse();
        return {
          ...response,
          right: { ...response.right, pageNumber: PAGE + 1 },
        };
      },
    ],
    [
      "wrong source",
      () => {
        const response = splitResponse();
        return { ...response, right: { ...response.right, source: "yolo" } };
      },
    ],
    [
      "different item",
      () => {
        const response = splitResponse();
        return {
          ...response,
          right: {
            ...response.right,
            data: { ...response.right.data!, takeoffItemId: 99 },
          },
        };
      },
    ],
    [
      "noncanonical empty holes",
      () => {
        const response = splitResponse();
        return {
          ...response,
          right: {
            ...response.right,
            data: { ...response.right.data!, holes: [] },
          },
        };
      },
    ],
    [
      "nonempty holes",
      () => {
        const response = splitResponse();
        return {
          ...response,
          right: {
            ...response.right,
            data: {
              ...response.right.data!,
              holes: [{ vertices: [{ x: 0.6, y: 0.6 }] }],
            },
          },
        };
      },
    ],
    [
      "unknown area-data extension",
      () => {
        const response = splitResponse();
        return {
          ...response,
          left: {
            ...response.left,
            data: { ...response.left.data!, futureGeometry: true },
          },
        };
      },
    ],
    [
      "bbox does not match vertices",
      () => {
        const response = splitResponse();
        return {
          ...response,
          left: { ...response.left, bbox: [0.1, 0.1, 0.6, 0.9] },
        };
      },
    ],
    [
      "zero-area polygon",
      () => {
        const response = splitResponse();
        return {
          ...response,
          left: {
            ...response.left,
            bbox: [0.125, 0.125, 0.875, 0.875],
            data: {
              ...response.left.data!,
              vertices: [
                { x: 0.125, y: 0.125 },
                { x: 0.5, y: 0.5 },
                { x: 0.875, y: 0.875 },
              ],
            },
          },
        };
      },
    ],
    [
      "oversized output polygon",
      () => {
        const response = splitResponse();
        return {
          ...response,
          left: {
            ...response.left,
            data: {
              ...response.left.data!,
              vertices: Array.from({ length: 10_003 }, (_, index) => ({
                x: index % 2 === 0 ? 0.125 : 0.5,
                y: index % 3 === 0 ? 0.125 : 0.875,
              })),
            },
          },
        };
      },
    ],
    [
      "measurement mismatch",
      () => {
        const response = splitResponse();
        return {
          ...response,
          left: {
            ...response.left,
            data: { ...response.left.data!, areaSqUnits: 41 },
          },
        };
      },
    ],
    [
      "extension loss",
      () => {
        const response = splitResponse();
        const { keywords: _keywords, ...withoutKeywords } =
          response.right.data!;
        return {
          ...response,
          right: { ...response.right, data: withoutKeywords },
        };
      },
    ],
    [
      "right note not canonical",
      () => {
        const response = splitResponse();
        return {
          ...response,
          right: { ...response.right, note: "unexpected" },
        };
      },
    ],
  ])(
    "treats a malformed 2xx (%s) as persisted but unusable",
    async (_label, malformed) => {
      const admitted = seed([sourceAnnotation(), neighbor(12)]);
      const source = admitted[0];
      persistMock.mockResolvedValueOnce(malformed());

      await expect(
        commitAnnotationSplit(
          queryClient,
          target(source),
          splitRequest(source),
        ),
      ).resolves.toEqual({
        status: "persisted-not-adopted",
        reason: "malformed-response",
      });
      expect(queryClient.getQueryData(KEY)).toBe(admitted);
    },
  );

  it("detects a synchronous cache-listener successor after publication", async () => {
    const admitted = seed([sourceAnnotation(), neighbor(12)]);
    const source = admitted[0];
    persistMock.mockResolvedValueOnce(splitResponse());
    let installed = false;
    let successor: ClientAnnotation[] | undefined;
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (
        installed ||
        event.type !== "updated" ||
        event.query.queryHash !== JSON.stringify(KEY)
      ) {
        return;
      }
      const rows = queryClient.getQueryData<ClientAnnotation[]>(KEY);
      if (!rows?.some((row) => row.id === RIGHT_ID)) return;
      installed = true;
      queryClient.setQueryData<ClientAnnotation[]>(KEY, (current) =>
        current!.map((row) =>
          row.id === SOURCE_ID && row.pageNumber === PAGE
            ? { ...row, name: "listener-successor" }
            : row,
        ),
      );
      successor = queryClient.getQueryData<ClientAnnotation[]>(KEY);
    });

    const result = await commitAnnotationSplit(
      queryClient,
      target(source),
      splitRequest(source),
    );
    unsubscribe();

    expect(installed).toBe(true);
    expect(result).toEqual({
      status: "persisted-not-adopted",
      reason: "synchronous-successor",
    });
    expect(queryClient.getQueryData(KEY)).toBe(successor);
    expect(successor?.[0].name).toBe("listener-successor");
  });

  it("detects lifecycle-only retirement by a synchronous publication listener", async () => {
    const admitted = seed([sourceAnnotation(), neighbor(12)]);
    const source = admitted[0];
    const lifecycle = fakeLifecycle();
    persistMock.mockResolvedValueOnce(splitResponse());
    let retired = false;
    let published: ClientAnnotation[] | undefined;
    isCurrentLifecycleMock.mockImplementation(() => !retired);
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (
        retired ||
        event.type !== "updated" ||
        event.query.queryHash !== JSON.stringify(KEY)
      ) {
        return;
      }
      const rows = queryClient.getQueryData<ClientAnnotation[]>(KEY);
      if (!rows?.some((row) => row.id === RIGHT_ID)) return;
      published = rows;
      retired = true;
    });

    const result = await commitAnnotationSplit(
      queryClient,
      target(source, { lifecycle }),
      splitRequest(source),
    );
    unsubscribe();

    expect(retired).toBe(true);
    expect(result).toEqual({
      status: "persisted-not-adopted",
      reason: "lifecycle-retired",
    });
    expect(queryClient.getQueryData(KEY)).toBe(published);
    expect(published).toHaveLength(3);
  });
});
