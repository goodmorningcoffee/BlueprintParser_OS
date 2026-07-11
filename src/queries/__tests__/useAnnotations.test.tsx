// [refactor jul11 P2.2⑥] C2 contract suite for the production-dead annotations cache facade.
//
// This suite deliberately tests the cache boundary, not viewerStore.annotations. It pins the
// behavior that C3 consumers will rely on: a permanently dormant, chunk-seeded query; functional
// CRUD versus value replacement; captured project keys; optimistic persistence; and the ordering
// of the three cache+zustand actions. Raw zustand subscribers are used for the cache-first checks
// because React notifications are intentionally deferred by TanStack Query.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  focusManager,
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
import { persistFetch } from "@/lib/client-persist";
import { queryKeys } from "@/queries/queryKeys";
import {
  readAnnotations,
  seedAnnotationsFromBootstrap,
  takeoffRedo,
  takeoffUndo,
  useAnnotations,
  writeAnns,
  type AnnotationUpdater,
  type NewAnnotationDraft,
  type PersistCreateOptions,
} from "@/queries/useAnnotations";
import { useViewerStore } from "@/stores/viewerStore";
import type { ClientAnnotation, ClientTakeoffItem } from "@/types";

vi.mock("@/lib/client-persist", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-persist")>();
  // Keep the real canPersist gate; only the transport is controlled by this suite.
  return { ...actual, persistFetch: vi.fn() };
});

const persistFetchMock = vi.mocked(persistFetch);
const rawFetchMock = vi.fn();
const clients = new Set<QueryClient>();
const NOW = 1_725_555_000_000;
const TEMP_ID = -NOW;

function freshClient(): QueryClient {
  const client = new QueryClient();
  clients.add(client);
  return client;
}

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function ann(
  id: number,
  overrides: Partial<ClientAnnotation> = {},
): ClientAnnotation {
  return {
    id,
    pageNumber: 1,
    name: `annotation-${id}`,
    bbox: [0.1, 0.1, 0.2, 0.2],
    note: null,
    source: "user",
    data: null,
    ...overrides,
  };
}

function takeoffAnn(
  id: number,
  takeoffItemId = 7,
  pageNumber = 1,
): ClientAnnotation {
  return ann(id, {
    pageNumber,
    name: `takeoff-${id}`,
    source: "takeoff",
    data: {
      type: "count-marker",
      shape: "circle",
      color: "#ef4444",
      takeoffItemId,
    },
  });
}

function draft(overrides: Partial<NewAnnotationDraft> = {}): NewAnnotationDraft {
  return {
    pageNumber: 4,
    name: "new annotation",
    bbox: [0.2, 0.2, 0.4, 0.4],
    note: null,
    source: "user",
    data: { type: "rectangle", clientOnly: true },
    ...overrides,
  };
}

const takeoffItem: ClientTakeoffItem = {
  id: 7,
  name: "Carpet",
  shape: "polygon",
  color: "#00ff00",
  size: 10,
  sortOrder: 0,
  groupId: null,
};

type ViewerSnapshot = ReturnType<typeof useViewerStore.getState>;
type PendingPolygon = NonNullable<ViewerSnapshot["bucketFillPendingPolygon"]>;

function pendingPolygon(overrides: Partial<PendingPolygon> = {}): PendingPolygon {
  return {
    vertices: [
      { x: 0.1, y: 0.1 },
      { x: 0.4, y: 0.1 },
      { x: 0.4, y: 0.4 },
    ],
    method: "pdf-vector",
    bbox: [0.1, 0.1, 0.4, 0.4],
    areaSqUnits: 120,
    unit: "sqft",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  useViewerStore.getState().resetProjectData();
  // resetProjectData intentionally does not own all tool-history fields yet.
  useViewerStore.setState({
    publicId: "A",
    isDemo: false,
    pageNumber: 1,
    activeTakeoffItemId: null,
    bucketFillPendingPolygon: null,
    bucketFillError: null,
    takeoffUndoStack: [],
    takeoffRedoStack: [],
  });

  persistFetchMock.mockReset();
  rawFetchMock.mockReset();
  rawFetchMock.mockImplementation((url: unknown) => {
    throw new Error(`unexpected raw fetch in useAnnotations suite: ${String(url)}`);
  });
  vi.stubGlobal("fetch", rawFetchMock);
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  onlineManager.setOnline(true);
  focusManager.setFocused(undefined);
});

afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
  vi.useRealTimers();
});

describe("useAnnotations query configuration and notification profile", () => {
  it("uses the exact project key and a stable frozen empty result with success/idle/∞ config", () => {
    const client = freshClient();
    const hook = renderHook(() => useAnnotations(), { wrapper: makeWrapper(client) });
    const firstEmpty = hook.result.current.annotations;

    expect(queryKeys.annotations.all("A")).toEqual(["project", "A", "annotations"]);
    expect(firstEmpty).toEqual([]);
    expect(Object.isFrozen(firstEmpty)).toBe(true);

    hook.rerender();
    expect(hook.result.current.annotations).toBe(firstEmpty);

    const query = client.getQueryCache().find({ queryKey: queryKeys.annotations.all("A") });
    expect(query).toBeDefined();
    expect(query?.state.status).toBe("success");
    expect(query?.state.fetchStatus).toBe("idle");
    expect(query?.isStale()).toBe(false);
    // staleTime is observer-only in TanStack's public QueryOptions typing even though the
    // concrete cache query retains it; narrow just the two configuration values under test.
    const configuredTimes = query?.options as
      | { staleTime?: number; gcTime?: number }
      | undefined;
    expect(configuredTimes?.staleTime).toBe(Infinity);
    expect(configuredTimes?.gcTime).toBe(Infinity);
    const queryFn = query?.options.queryFn;
    expect(queryFn).toBeTypeOf("function");
    expect(() => (queryFn as unknown as () => unknown)()).toThrow(
      "annotations are chunk-seeded (no GET); queryFn must never run",
    );
  });

  it("never executes the dormant query across mount, invalidation, focus, or reconnect", async () => {
    const client = freshClient();
    const seeded = [ann(1)];
    client.setQueryData(queryKeys.annotations.all("A"), seeded);
    const { result } = renderHook(() => useAnnotations(), { wrapper: makeWrapper(client) });

    await waitFor(() => expect(result.current.annotations).toHaveLength(1));
    await act(async () => {
      await client.invalidateQueries({ queryKey: queryKeys.annotations.all("A") });
    });
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });
    await flushMicrotasks();

    const query = client.getQueryCache().find({ queryKey: queryKeys.annotations.all("A") });
    expect(query?.state.status).toBe("success");
    expect(query?.state.fetchStatus).toBe("idle");
    expect(result.current.annotations).toEqual(seeded);
    expect(rawFetchMock).not.toHaveBeenCalled();
    expect(persistFetchMock).not.toHaveBeenCalled();
  });

  it("keeps the sole windowed entry across an observer-less day", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const client = freshClient();
    const rows = [ann(-1, { name: "demo/temp survivor" })];
    client.setQueryData(queryKeys.annotations.all("A"), rows);

    const first = renderHook(() => useAnnotations(), { wrapper: makeWrapper(client) });
    expect(first.result.current.annotations).toEqual(rows);
    first.unmount();

    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(readAnnotations(client, "A")).toEqual(rows);

    const second = renderHook(() => useAnnotations(), { wrapper: makeWrapper(client) });
    expect(second.result.current.annotations).toEqual(rows);
  });

  it("deduplicates byte-identical writes, ignores unrelated keys, and preserves untouched rows", async () => {
    const client = freshClient();
    const first = ann(1, { name: "first" });
    const second = ann(2, { name: "second" });
    client.setQueryData(queryKeys.annotations.all("A"), [first, second]);
    let renders = 0;
    const { result } = renderHook(
      () => {
        renders++;
        return useAnnotations();
      },
      { wrapper: makeWrapper(client) },
    );
    await waitFor(() => expect(result.current.annotations).toHaveLength(2));

    const topBefore = result.current.annotations;
    const rendersBefore = renders;
    act(() => {
      client.setQueryData(queryKeys.annotations.all("A"), [
        ann(1, { name: "first" }),
        ann(2, { name: "second" }),
      ]);
    });
    await flushMicrotasks();
    expect(result.current.annotations).toBe(topBefore);
    expect(renders).toBe(rendersBefore);

    act(() => client.setQueryData(queryKeys.annotations.all("OTHER"), [ann(99)]));
    await flushMicrotasks();
    expect(renders).toBe(rendersBefore);

    act(() => result.current.updateAnnotation(1, { note: "changed" }));
    await waitFor(() => expect(result.current.annotations[0].note).toBe("changed"));
    expect(result.current.annotations).not.toBe(topBefore);
    expect(result.current.annotations[1]).toBe(second);
    expect(renders).toBe(rendersBefore + 1);
  });
});

describe("read/write bridges and collection actions", () => {
  it("bootstrap adapter seeds the passed project key and never the live store key", () => {
    const client = freshClient();
    useViewerStore.setState({ publicId: "LIVE-WRONG" });
    const liveSentinel = [ann(99, { name: "must remain isolated" })];
    client.setQueryData(queryKeys.annotations.all("LIVE-WRONG"), liveSentinel);
    const seeded = [ann(1), ann(2)];

    seedAnnotationsFromBootstrap(client, "SERVER-CANONICAL", { annotations: seeded });

    expect(readAnnotations(client, "SERVER-CANONICAL")).toEqual(seeded);
    expect(readAnnotations(client, "LIVE-WRONG")).toEqual(liveSentinel);
  });

  it.each([
    { label: "null chunk", chunk: null },
    { label: "omitted collection", chunk: {} },
    { label: "null collection", chunk: { annotations: null } },
  ])("bootstrap adapter clears a stale entry for $label", ({ chunk }) => {
    const client = freshClient();
    client.setQueryData(queryKeys.annotations.all("A"), [ann(77, { name: "stale" })]);

    seedAnnotationsFromBootstrap(client, "A", chunk);

    expect(readAnnotations(client, "A")).toEqual([]);
  });

  it("readAnnotations returns one stable frozen fallback; writeAnns updates only its passed key", () => {
    const client = freshClient();
    const emptyA = readAnnotations(client, "missing-A");
    const emptyB = readAnnotations(client, "missing-B");
    expect(emptyB).toBe(emptyA);
    expect(Object.isFrozen(emptyA)).toBe(true);

    useViewerStore.setState({ publicId: "B" });
    const row = ann(1);
    const append: AnnotationUpdater = (rows) => [...rows, row];
    writeAnns(client, "A", append);
    expect(readAnnotations(client, "A")).toEqual([row]);
    expect(readAnnotations(client, "B")).toBe(emptyA);
  });

  it("CRUD actions compose functionally and update/remove preserve the expected row references", async () => {
    const client = freshClient();
    const kept = ann(10, { name: "kept" });
    client.setQueryData(queryKeys.annotations.all("A"), [kept]);
    const { result } = renderHook(() => useAnnotations(), { wrapper: makeWrapper(client) });

    act(() => {
      result.current.addAnnotation(ann(1));
      result.current.addAnnotation(ann(2));
      result.current.addAnnotation(ann(1, { name: "duplicate id" }));
    });
    await waitFor(() =>
      expect(result.current.annotations.map((row) => row.id)).toEqual([10, 1, 2, 1]),
    );

    act(() => result.current.updateAnnotation(1, { name: "renamed", note: "memo" }));
    await waitFor(() =>
      expect(result.current.annotations.filter((row) => row.id === 1)).toEqual([
        expect.objectContaining({ id: 1, name: "renamed", note: "memo" }),
        expect.objectContaining({ id: 1, name: "renamed", note: "memo" }),
      ]),
    );
    expect(result.current.annotations[0]).toBe(kept);
    expect(result.current.annotations[1]).toMatchObject({ id: 1, name: "renamed", note: "memo" });

    act(() => result.current.removeAnnotation(1));
    await waitFor(() => expect(result.current.annotations.map((row) => row.id)).toEqual([10, 2]));
    expect(result.current.annotations[0]).toBe(kept);
  });

  it("setAnnotations is a value replacement and deliberately drops an interleaved row", async () => {
    const client = freshClient();
    client.setQueryData(queryKeys.annotations.all("A"), [ann(1)]);
    const { result } = renderHook(() => useAnnotations(), { wrapper: makeWrapper(client) });
    const capturedReplacement = [ann(1, { name: "captured rename" })];

    act(() => result.current.addAnnotation(ann(2, { name: "concurrent" })));
    await waitFor(() => expect(result.current.annotations).toHaveLength(2));
    act(() => result.current.setAnnotations(capturedReplacement));

    await waitFor(() => expect(result.current.annotations).toEqual(capturedReplacement));
    expect(result.current.annotations.some((row) => row.id === 2)).toBe(false);
  });

  it("switches subscriptions by publicId while every captured CRUD callback keeps its original key", async () => {
    const client = freshClient();
    const a1 = ann(1, { name: "A-one" });
    const a2 = ann(2, { name: "A-two" });
    const b1 = ann(20, { name: "B-one" });
    client.setQueryData(queryKeys.annotations.all("A"), [a1, a2]);
    client.setQueryData(queryKeys.annotations.all("B"), [b1]);
    const { result } = renderHook(() => useAnnotations(), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(result.current.annotations.map((row) => row.id)).toEqual([1, 2]));
    const captured = result.current;

    act(() => useViewerStore.setState({ publicId: "B" }));
    await waitFor(() => expect(result.current.annotations.map((row) => row.id)).toEqual([20]));

    act(() => {
      captured.setAnnotations([a1, a2]);
      captured.addAnnotation(ann(3, { name: "A-three" }));
      captured.updateAnnotation(1, { name: "A-renamed" });
      captured.removeAnnotation(2);
    });

    expect(readAnnotations(client, "A").map((row) => [row.id, row.name])).toEqual([
      [1, "A-renamed"],
      [3, "A-three"],
    ]);
    expect(readAnnotations(client, "B")).toEqual([b1]);
    expect(result.current.annotations).toEqual([b1]);
  });

  it("RACE-1 reconcile after a wholesale refresh is a same-ref, zero-notify no-op", async () => {
    const client = freshClient();
    client.setQueryData(queryKeys.annotations.all("A"), [ann(TEMP_ID, { pageNumber: 5 })]);
    let renders = 0;
    const { result } = renderHook(
      () => {
        renders++;
        return useAnnotations();
      },
      { wrapper: makeWrapper(client) },
    );
    const serverWindow = [ann(40, { pageNumber: 4 }), ann(60, { pageNumber: 6 })];

    act(() => result.current.setAnnotations(serverWindow));
    await waitFor(() => expect(result.current.annotations.map((row) => row.id)).toEqual([40, 60]));
    const windowRef = result.current.annotations;
    const rendersBeforeReconcile = renders;

    act(() => result.current.updateAnnotation(TEMP_ID, { id: 500 }));
    await flushMicrotasks();

    expect(result.current.annotations).toBe(windowRef);
    expect(result.current.annotations.map((row) => row.id)).toEqual([40, 60]);
    expect(renders).toBe(rendersBeforeReconcile);
  });
});

describe("persistCreate extensibility seam", () => {
  it("adds optimistically, POSTs the draft, returns the server id, and reconciles ID only", async () => {
    const client = freshClient();
    const save = deferred<unknown>();
    persistFetchMock.mockReturnValueOnce(save.promise);
    const { result } = renderHook(() => useAnnotations(), { wrapper: makeWrapper(client) });
    const input = draft();
    let operation!: Promise<number>;

    act(() => {
      operation = result.current.persistCreate(input);
    });
    expect(readAnnotations(client, "A")).toEqual([{ id: TEMP_ID, ...input }]);
    expect(persistFetchMock).toHaveBeenCalledWith("/api/annotations", {
      projectId: "A",
      ...input,
    });

    save.resolve({ id: 4242, name: "server must not replace local draft", note: "server note" });
    let returned = 0;
    await act(async () => {
      returned = await operation;
    });

    expect(returned).toBe(4242);
    expect(readAnnotations(client, "A")).toEqual([{ id: 4242, ...input }]);
  });

  it("normalizes omitted client defaults without adding them to the POST payload", async () => {
    const client = freshClient();
    const save = deferred<unknown>();
    persistFetchMock.mockReturnValueOnce(save.promise);
    const { result } = renderHook(() => useAnnotations(), { wrapper: makeWrapper(client) });
    const sparseDraft: NewAnnotationDraft = {
      pageNumber: 8,
      name: "wire-shape witness",
      bbox: [0.1, 0.2, 0.3, 0.4],
    };
    let operation!: Promise<number>;

    act(() => {
      operation = result.current.persistCreate(sparseDraft);
    });

    expect(readAnnotations(client, "A")).toEqual([
      {
        id: TEMP_ID,
        ...sparseDraft,
        note: null,
        source: "user",
        data: null,
      },
    ]);
    expect(persistFetchMock).toHaveBeenCalledWith("/api/annotations", {
      projectId: "A",
      ...sparseDraft,
    });
    expect(persistFetchMock.mock.calls[0]?.[1]).not.toHaveProperty("note");
    expect(persistFetchMock.mock.calls[0]?.[1]).not.toHaveProperty("source");
    expect(persistFetchMock.mock.calls[0]?.[1]).not.toHaveProperty("data");

    save.resolve({ id: 8181 });
    await act(async () => {
      await operation;
    });
    expect(readAnnotations(client, "A")[0]?.id).toBe(8181);
  });

  it("keeps and returns the temp id when a successful response has no truthy id", async () => {
    const client = freshClient();
    persistFetchMock.mockResolvedValueOnce({ id: 0, name: "invalid id" });
    const { result } = renderHook(() => useAnnotations(), { wrapper: makeWrapper(client) });

    let returned = 0;
    await act(async () => {
      returned = await result.current.persistCreate(draft());
    });

    expect(returned).toBe(TEMP_ID);
    expect(readAnnotations(client, "A").map((row) => row.id)).toEqual([TEMP_ID]);
  });

  it.each([
    { label: "demo", publicId: "A", isDemo: true },
    { label: "pre-bootstrap", publicId: "", isDemo: false },
  ])("$label mode stays local and never invokes persistence", async ({ publicId, isDemo }) => {
    useViewerStore.setState({ publicId, isDemo });
    const client = freshClient();
    const { result } = renderHook(() => useAnnotations(), { wrapper: makeWrapper(client) });

    let returned = 0;
    await act(async () => {
      returned = await result.current.persistCreate(draft());
    });

    expect(returned).toBe(TEMP_ID);
    expect(readAnnotations(client, publicId).map((row) => row.id)).toEqual([TEMP_ID]);
    expect(persistFetchMock).not.toHaveBeenCalled();
  });

  it("uses a custom error channel and keeps the optimistic row by default", async () => {
    const client = freshClient();
    const failure = new Error("quota exceeded");
    const onError = vi.fn();
    persistFetchMock.mockRejectedValueOnce(failure);
    const { result } = renderHook(() => useAnnotations(), { wrapper: makeWrapper(client) });

    let returned = 0;
    await act(async () => {
      returned = await result.current.persistCreate(draft(), { onError });
    });

    expect(returned).toBe(TEMP_ID);
    expect(onError).toHaveBeenCalledWith(failure);
    expect(readAnnotations(client, "A").map((row) => row.id)).toEqual([TEMP_ID]);
  });

  it("keeps failures visible through the labeled default reporter", async () => {
    const client = freshClient();
    const failure = new Error("connection lost");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    persistFetchMock.mockRejectedValueOnce(failure);
    const { result } = renderHook(() => useAnnotations(), { wrapper: makeWrapper(client) });

    let returned = 0;
    await act(async () => {
      returned = await result.current.persistCreate(draft(), { errorLabel: "Door tool save" });
    });

    expect(returned).toBe(TEMP_ID);
    expect(consoleError).toHaveBeenCalledWith(
      "[ANNOTATIONS] Door tool save:",
      failure,
    );
    expect(readAnnotations(client, "A").map((row) => row.id)).toEqual([TEMP_ID]);
  });

  it("captures the rollback snapshot before optimistic add and restores it only when opted in", async () => {
    const client = freshClient();
    const prior = ann(1, { name: "pre-add row" });
    client.setQueryData(queryKeys.annotations.all("A"), [prior]);
    const failure = deferred<unknown>();
    persistFetchMock.mockReturnValueOnce(failure.promise);
    const onError = vi.fn();
    const options: PersistCreateOptions = { rollbackOnError: true, onError };
    const { result } = renderHook(() => useAnnotations(), { wrapper: makeWrapper(client) });
    let operation!: Promise<number>;

    act(() => {
      operation = result.current.persistCreate(draft(), options);
    });
    expect(readAnnotations(client, "A").map((row) => row.id)).toEqual([1, TEMP_ID]);

    failure.reject(new Error("save failed"));
    await act(async () => {
      await operation;
    });

    expect(readAnnotations(client, "A")).toEqual([prior]);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "save failed" }));
  });

  it("reconciles the creation project after a project switch while the request is in flight", async () => {
    const client = freshClient();
    const save = deferred<unknown>();
    persistFetchMock.mockReturnValueOnce(save.promise);
    const { result } = renderHook(() => useAnnotations(), { wrapper: makeWrapper(client) });
    let operation!: Promise<number>;

    act(() => {
      operation = result.current.persistCreate(draft({ name: "belongs to A" }));
    });
    const bRow = ann(20, { name: "B stays isolated" });
    act(() => {
      useViewerStore.setState({ publicId: "B" });
      client.setQueryData(queryKeys.annotations.all("B"), [bRow]);
    });
    await waitFor(() => expect(result.current.annotations).toEqual([bRow]));

    save.resolve({ id: 8080 });
    await act(async () => {
      await operation;
    });

    expect(persistFetchMock).toHaveBeenCalledWith(
      "/api/annotations",
      expect.objectContaining({ projectId: "A", name: "belongs to A" }),
    );
    expect(readAnnotations(client, "A").map((row) => row.id)).toEqual([8080]);
    expect(readAnnotations(client, "B")).toEqual([bRow]);
  });
});

describe("commitBucketFill", () => {
  it("is a total no-op when there is no pending polygon", () => {
    const client = freshClient();
    client.setQueryData(queryKeys.annotations.all("A"), [ann(1)]);
    const { result } = renderHook(() => useAnnotations(), { wrapper: makeWrapper(client) });
    const rowsBefore = readAnnotations(client, "A");
    const storeBefore = useViewerStore.getState();

    act(() => result.current.commitBucketFill(takeoffItem));

    expect(readAnnotations(client, "A")).toBe(rowsBefore);
    expect(useViewerStore.getState()).toBe(storeBefore);
    expect(persistFetchMock).not.toHaveBeenCalled();
  });

  it("writes cache before clearing pending, keeps demo local, and omits empty holes/method", () => {
    const client = freshClient();
    useViewerStore.setState({
      isDemo: true,
      pageNumber: 3,
      bucketFillPendingPolygon: pendingPolygon({ holes: [] }),
      bucketFillError: null,
    });
    const { result } = renderHook(() => useAnnotations(), { wrapper: makeWrapper(client) });
    let rowsObservedAtPendingClear: ClientAnnotation[] | undefined;
    const unsubscribe = useViewerStore.subscribe((state, previous) => {
      if (previous.bucketFillPendingPolygon && state.bucketFillPendingPolygon === null) {
        rowsObservedAtPendingClear = readAnnotations(client, "A");
      }
    });

    act(() => result.current.commitBucketFill(takeoffItem));
    unsubscribe();

    expect(rowsObservedAtPendingClear?.map((row) => row.id)).toEqual([TEMP_ID]);
    expect(useViewerStore.getState().bucketFillPendingPolygon).toBeNull();
    expect(useViewerStore.getState().bucketFillError).toBeNull();
    expect(persistFetchMock).not.toHaveBeenCalled();
    const created = readAnnotations(client, "A")[0];
    expect(created).toMatchObject({
      id: TEMP_ID,
      pageNumber: 3,
      name: "Carpet",
      bbox: [0.1, 0.1, 0.4, 0.4],
      note: null,
      source: "takeoff",
      data: {
        type: "area-polygon",
        takeoffItemId: 7,
        color: "#00ff00",
        vertices: pendingPolygon().vertices,
        areaSqUnits: 120,
        unit: "sqft",
      },
    });
    expect(created.data).not.toHaveProperty("holes");
    expect(created.data).not.toHaveProperty("method");
  });

  it("uses invocation-time state and surfaces the exact G6 error for an empty publicId", async () => {
    const client = freshClient();
    const { result } = renderHook(() => useAnnotations(), { wrapper: makeWrapper(client) });
    const capturedCommit = result.current.commitBucketFill;

    act(() => {
      useViewerStore.setState({
        publicId: "",
        isDemo: false,
        pageNumber: 9,
        bucketFillPendingPolygon: pendingPolygon(),
      });
    });
    await waitFor(() => expect(result.current.annotations).toEqual([]));
    act(() => capturedCommit(takeoffItem));

    expect(readAnnotations(client, "")).toHaveLength(1);
    expect(readAnnotations(client, "A")).toEqual([]);
    expect(useViewerStore.getState().bucketFillError).toBe(
      "Project not ready yet — bucket fill was NOT saved. Redraw once the viewer finishes loading.",
    );
    expect(persistFetchMock).not.toHaveBeenCalled();
  });

  it("keeps the optimistic row and exposes the exact persistence error on failure", async () => {
    const client = freshClient();
    const failure = deferred<unknown>();
    persistFetchMock.mockReturnValueOnce(failure.promise);
    useViewerStore.setState({
      pageNumber: 2,
      bucketFillPendingPolygon: pendingPolygon(),
    });
    const { result } = renderHook(() => useAnnotations(), { wrapper: makeWrapper(client) });

    act(() => result.current.commitBucketFill(takeoffItem));
    expect(readAnnotations(client, "A").map((row) => row.id)).toEqual([TEMP_ID]);
    expect(useViewerStore.getState().bucketFillPendingPolygon).toBeNull();

    failure.reject(new Error("Forbidden"));
    await failure.promise.catch(() => undefined);
    await flushMicrotasks();

    expect(useViewerStore.getState().bucketFillError).toBe(
      "Bucket fill drawn locally but NOT saved: Forbidden",
    );
    expect(readAnnotations(client, "A").map((row) => row.id)).toEqual([TEMP_ID]);
  });

  it.each([
    { label: "zero id", response: { id: 0 } },
    { label: "missing id", response: {} },
  ])("keeps the optimistic id when bucket persistence returns $label", async ({ response }) => {
    const client = freshClient();
    persistFetchMock.mockResolvedValueOnce(response);
    useViewerStore.setState({
      pageNumber: 2,
      bucketFillPendingPolygon: pendingPolygon(),
    });
    const { result } = renderHook(() => useAnnotations(), { wrapper: makeWrapper(client) });

    act(() => result.current.commitBucketFill(takeoffItem));
    await flushMicrotasks();

    // [refactor jul11 P2.2⑥ DETECTOR] The legacy reconciler accepts only truthy server IDs.
    // Adopting 0/undefined would make the optimistic row unreachable to later ID-based actions.
    expect(readAnnotations(client, "A").map((row) => row.id)).toEqual([TEMP_ID]);
  });

  it("POSTs non-empty holes without method, then reconciles only the optimistic id", async () => {
    const client = freshClient();
    const save = deferred<unknown>();
    persistFetchMock.mockReturnValueOnce(save.promise);
    const holes = [{ vertices: [{ x: 0.2, y: 0.2 }, { x: 0.3, y: 0.2 }, { x: 0.3, y: 0.3 }] }];
    const pending = pendingPolygon({ holes });
    useViewerStore.setState({
      pageNumber: 5,
      bucketFillPendingPolygon: pending,
    });
    const { result } = renderHook(() => useAnnotations(), { wrapper: makeWrapper(client) });

    act(() => result.current.commitBucketFill(takeoffItem));
    const expectedData = {
      type: "area-polygon",
      takeoffItemId: 7,
      color: "#00ff00",
      vertices: pending.vertices,
      holes,
      areaSqUnits: 120,
      unit: "sqft",
    };
    expect(persistFetchMock).toHaveBeenCalledWith("/api/annotations", {
      projectId: "A",
      pageNumber: 5,
      name: "Carpet",
      bbox: pending.bbox,
      source: "takeoff",
      data: expectedData,
    });
    expect(readAnnotations(client, "A")[0].data).toEqual(expectedData);

    // Reconciliation must stay on the invocation-time key even if the viewer switches projects
    // while persistence is pending. The live B cache is unrelated and must remain untouched.
    const bRow = ann(900, { name: "project B row" });
    act(() => {
      useViewerStore.setState({ publicId: "B" });
      client.setQueryData(queryKeys.annotations.all("B"), [bRow]);
    });

    save.resolve({ id: 5150, name: "server rename must be ignored" });
    await save.promise;
    await flushMicrotasks();

    expect(readAnnotations(client, "A")).toEqual([
      {
        id: 5150,
        pageNumber: 5,
        name: "Carpet",
        bbox: pending.bbox,
        note: null,
        source: "takeoff",
        data: expectedData,
      },
    ]);
    expect(readAnnotations(client, "B")).toEqual([bRow]);
    expect(useViewerStore.getState().bucketFillError).toBeNull();
  });
});

describe("direct takeoff undo/redo bridges", () => {
  it("null-active and no-match undo preserve cache and both stack references exactly", () => {
    const client = freshClient();
    client.setQueryData(queryKeys.annotations.all("A"), [takeoffAnn(1, 7, 1)]);
    const priorUndo = [takeoffAnn(90)];
    const priorRedo = [takeoffAnn(91)];
    useViewerStore.setState({
      activeTakeoffItemId: null,
      pageNumber: 1,
      takeoffUndoStack: priorUndo,
      takeoffRedoStack: priorRedo,
    });
    const rowsBefore = readAnnotations(client, "A");

    takeoffUndo(client);
    expect(readAnnotations(client, "A")).toBe(rowsBefore);
    expect(useViewerStore.getState().takeoffUndoStack).toBe(priorUndo);
    expect(useViewerStore.getState().takeoffRedoStack).toBe(priorRedo);

    useViewerStore.setState({ activeTakeoffItemId: 7, pageNumber: 2 });
    const undoBeforeNoMatch = useViewerStore.getState().takeoffUndoStack;
    const redoBeforeNoMatch = useViewerStore.getState().takeoffRedoStack;
    takeoffUndo(client);
    expect(readAnnotations(client, "A")).toBe(rowsBefore);
    expect(useViewerStore.getState().takeoffUndoStack).toBe(undoBeforeNoMatch);
    expect(useViewerStore.getState().takeoffRedoStack).toBe(redoBeforeNoMatch);
  });

  it("undo removes the last matching row from the live project and writes cache before stacks", () => {
    const client = freshClient();
    const priorUndo = takeoffAnn(90);
    const staleRedo = takeoffAnn(91);
    const earlierMatch = takeoffAnn(2);
    const removed = takeoffAnn(5);
    const bRows = [
      ann(1),
      earlierMatch,
      takeoffAnn(3, 8),
      takeoffAnn(4, 7, 2),
      removed,
      takeoffAnn(6, 8),
    ];
    const aRows = [takeoffAnn(100)];
    client.setQueryData(queryKeys.annotations.all("A"), aRows);
    client.setQueryData(queryKeys.annotations.all("B"), bRows);
    useViewerStore.setState({
      publicId: "B",
      activeTakeoffItemId: 7,
      pageNumber: 1,
      takeoffUndoStack: [priorUndo],
      takeoffRedoStack: [staleRedo],
    });
    let cacheIdsAtStackWrite: number[] | undefined;
    const unsubscribe = useViewerStore.subscribe((state, previous) => {
      if (state.takeoffUndoStack !== previous.takeoffUndoStack) {
        cacheIdsAtStackWrite = readAnnotations(client, "B").map((row) => row.id);
      }
    });

    takeoffUndo(client);
    unsubscribe();

    expect(cacheIdsAtStackWrite).toEqual([1, 2, 3, 4, 6]);
    expect(readAnnotations(client, "B").map((row) => row.id)).toEqual([1, 2, 3, 4, 6]);
    expect(readAnnotations(client, "B")[1]).toBe(earlierMatch);
    expect(readAnnotations(client, "A")).toEqual(aRows);
    expect(useViewerStore.getState().takeoffUndoStack).toEqual([priorUndo, removed]);
    expect(useViewerStore.getState().takeoffUndoStack[1]).toBe(removed);
    expect(useViewerStore.getState().takeoffRedoStack).toEqual([]);
  });

  it("redo with an empty undo stack is an exact no-op even when redo history exists", () => {
    const client = freshClient();
    client.setQueryData(queryKeys.annotations.all("A"), [ann(1)]);
    const priorRedo = [takeoffAnn(91)];
    useViewerStore.setState({ takeoffUndoStack: [], takeoffRedoStack: priorRedo });
    const rowsBefore = readAnnotations(client, "A");
    const undoBefore = useViewerStore.getState().takeoffUndoStack;

    takeoffRedo(client);

    expect(readAnnotations(client, "A")).toBe(rowsBefore);
    expect(useViewerStore.getState().takeoffUndoStack).toBe(undoBefore);
    expect(useViewerStore.getState().takeoffRedoStack).toBe(priorRedo);
  });

  it("redo appends the exact undo top and writes cache before moving stack history", () => {
    const client = freshClient();
    const existing = ann(1);
    const restored = takeoffAnn(5);
    const priorRedo = takeoffAnn(91);
    client.setQueryData(queryKeys.annotations.all("A"), [existing]);
    useViewerStore.setState({
      activeTakeoffItemId: null,
      takeoffUndoStack: [restored],
      takeoffRedoStack: [priorRedo],
    });
    let cacheIdsAtStackWrite: number[] | undefined;
    const unsubscribe = useViewerStore.subscribe((state, previous) => {
      if (state.takeoffUndoStack !== previous.takeoffUndoStack) {
        cacheIdsAtStackWrite = readAnnotations(client, "A").map((row) => row.id);
      }
    });

    takeoffRedo(client);
    unsubscribe();

    expect(cacheIdsAtStackWrite).toEqual([1, 5]);
    expect(readAnnotations(client, "A")).toEqual([existing, restored]);
    expect(readAnnotations(client, "A")[1]).toBe(restored);
    expect(useViewerStore.getState().takeoffUndoStack).toEqual([]);
    expect(useViewerStore.getState().takeoffRedoStack).toEqual([priorRedo, restored]);
    expect(useViewerStore.getState().takeoffRedoStack[1]).toBe(restored);
  });
});
