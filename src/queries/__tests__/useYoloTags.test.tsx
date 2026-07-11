// [refactor jul11 P2.2⑨ C2] Production-dead facade contract. These tests exercise the new
// Query/cache owner before any production caller moves, keeping C2 additive and independently
// revertible. C3 deletes the overlapping viewerStore cases after every consumer is wired here.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
import { queryKeys } from "@/queries/queryKeys";
import {
  addYoloTagToCache,
  addYoloTagsBulkToCache,
  clearYoloTagsProject,
  navigateYoloTag,
  readYoloTags,
  removeYoloTagFromCache,
  seedYoloTagsFromBootstrap,
  updateYoloTagInCache,
  useYoloTagActions,
  useYoloTagById,
  useYoloTagCatalog,
  useYoloTagRows,
  useYoloTagsForPage,
} from "@/queries/useYoloTags";
import { useUiStore } from "@/stores/uiStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import type { YoloTag } from "@/types";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

let qc: QueryClient;
const fetchMock = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function tag(
  id: string,
  over: Partial<YoloTag> = {},
): YoloTag {
  return {
    id,
    name: id,
    tagText: id,
    yoloClass: "door",
    yoloModel: "fixture-model",
    source: "schedule",
    scope: "project",
    instances: [],
    ...over,
  };
}

function response(body: unknown = { success: true }, ok = true, status = ok ? 200 : 500) {
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
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

async function flushPromises() {
  // persistFetch has fetch + json awaits, followed by the coordinator's catch/then/drain chain.
  // Keep this fake-timer-safe (RTL waitFor can hang under Vitest fake time).
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  resetProjectData();
  setViewerStoreStateForTest({ publicId: "project-A", isDemo: false });
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(response());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  clearYoloTagsProject(qc, "project-A");
  clearYoloTagsProject(qc, "project-B");
  vi.clearAllTimers();
  vi.useRealTimers();
  qc.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("yoloTags bootstrap/query ownership", () => {
  it("seeds the canonical key, strips the hidden PI copy, and never persists hydration", async () => {
    const rows = [tag("D-101")];
    const withoutTags = seedYoloTagsFromBootstrap(qc, "project-A", {
      csiGraph: { divisions: ["08"] },
      futureKey: { keep: true },
      yoloTags: rows,
    });

    expect(readYoloTags(qc, "project-A")).toEqual(rows);
    expect(withoutTags).toEqual({
      csiGraph: { divisions: ["08"] },
      futureKey: { keep: true },
    });
    expect(withoutTags).not.toHaveProperty("yoloTags");
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("unconditionally maps absent/null/malformed tags to [] and overwrites a same-key seed", () => {
    seedYoloTagsFromBootstrap(qc, "project-A", { yoloTags: [tag("stale")] });
    expect(seedYoloTagsFromBootstrap(qc, "project-A", {})).toEqual({});
    expect(readYoloTags(qc, "project-A")).toEqual([]);

    seedYoloTagsFromBootstrap(qc, "project-A", { yoloTags: "corrupt" });
    expect(readYoloTags(qc, "project-A")).toEqual([]);
    seedYoloTagsFromBootstrap(qc, "project-A", {
      yoloTags: [null, { ...tag("bad"), instances: [{ pageNumber: 1 }] }, tag("valid")],
    });
    expect(readYoloTags(qc, "project-A")).toEqual([tag("valid")]);
    expect(seedYoloTagsFromBootstrap(qc, "project-A", null)).toBeNull();
    expect(readYoloTags(qc, "project-A")).toEqual([]);
  });

  it("isolates projects and exact cleanup preserves sibling project-domain keys", () => {
    seedYoloTagsFromBootstrap(qc, "project-A", { yoloTags: [tag("A")] });
    seedYoloTagsFromBootstrap(qc, "project-B", { yoloTags: [tag("B")] });
    qc.setQueryData(queryKeys.annotations.all("project-A"), [{ id: 99 }]);

    clearYoloTagsProject(qc, "project-A");
    expect(qc.getQueryData(queryKeys.yoloTags.all("project-A"))).toBeUndefined();
    expect(readYoloTags(qc, "project-B")).toEqual([tag("B")]);
    expect(qc.getQueryData(queryKeys.annotations.all("project-A"))).toEqual([{ id: 99 }]);
  });

  it("disabled observer reads [] without invoking the throwing no-GET queryFn", () => {
    const { result } = renderHook(() => useYoloTagRows(), { wrapper });
    expect(result.current).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();

    const query = qc.getQueryCache().find({ queryKey: queryKeys.yoloTags.all("project-A"), exact: true });
    const options = query?.options as { staleTime?: number; gcTime?: number } | undefined;
    expect(options?.staleTime).toBe(Infinity);
    expect(options?.gcTime).toBe(Infinity);
  });
});

describe("yoloTags synchronous collection actions", () => {
  it("single/bulk add use the exact case-folded tuple, retain order, and incoming last-wins", () => {
    const first = tag("first", { tagText: "D-101" });
    const replacement = tag("replacement", { tagText: "d-101", name: "new" });
    const distinctSource = tag("keynote", { tagText: "D-101", source: "keynote" });
    const distinctScope = tag("page", { tagText: "D-101", scope: "page", pageNumber: 2 });
    const distinctClass = tag("window", { tagText: "D-101", yoloClass: "window" });

    addYoloTagToCache(qc, "project-A", true, first);
    addYoloTagsBulkToCache(qc, "project-A", true, [
      distinctSource,
      replacement,
      distinctScope,
      distinctClass,
    ]);

    expect(readYoloTags(qc, "project-A").map((row) => row.id)).toEqual([
      "replacement", // replaces first without moving the original Map position
      "keynote",
      "page",
      "window",
    ]);
  });

  it("empty bulk is a reference-stable no-op and never schedules persistence", async () => {
    seedYoloTagsFromBootstrap(qc, "project-A", { yoloTags: [tag("keep")] });
    const before = readYoloTags(qc, "project-A");
    const returned = addYoloTagsBulkToCache(qc, "project-A", false, []);

    expect(returned).toBe(before);
    expect(readYoloTags(qc, "project-A")).toBe(before);
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("update/remove preserve missing-id semantics and update does not re-dedupe collisions", () => {
    seedYoloTagsFromBootstrap(qc, "project-A", {
      yoloTags: [tag("a", { tagText: "A" }), tag("b", { tagText: "B" })],
    });

    updateYoloTagInCache(qc, "project-A", true, "missing", { name: "ignored" });
    removeYoloTagFromCache(qc, "project-A", true, "missing");
    updateYoloTagInCache(qc, "project-A", true, "b", { tagText: "A" });
    expect(readYoloTags(qc, "project-A")).toHaveLength(2);
    expect(readYoloTags(qc, "project-A").map((row) => row.tagText)).toEqual(["A", "A"]);

    removeYoloTagFromCache(qc, "project-A", true, "a");
    expect(readYoloTags(qc, "project-A").map((row) => row.id)).toEqual(["b"]);
  });

  it("every nonempty action is synchronously visible through the live bridge", () => {
    addYoloTagToCache(qc, "project-A", true, tag("same-tick"));
    expect(readYoloTags(qc, "project-A")[0].id).toBe("same-tick");
    updateYoloTagInCache(qc, "project-A", true, "same-tick", { name: "updated" });
    expect(readYoloTags(qc, "project-A")[0].name).toBe("updated");
    removeYoloTagFromCache(qc, "project-A", true, "same-tick");
    expect(readYoloTags(qc, "project-A")).toEqual([]);
  });
});

describe("yoloTags debounced save coordinator", () => {
  it("waits 500ms, coalesces, and PUTs the latest whole snapshot to captured project identity", async () => {
    addYoloTagToCache(qc, "project-A", false, tag("one"));
    await vi.advanceTimersByTimeAsync(300);
    addYoloTagToCache(qc, "project-A", false, tag("two"));
    setViewerStoreStateForTest({ publicId: "project-B" });

    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/project-A", expect.objectContaining({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ yoloTags: [tag("one"), tag("two")] }),
      signal: expect.any(AbortSignal),
    }));
  });

  it("keeps project and QueryClient debounce lanes independent", async () => {
    const otherClient = new QueryClient();
    addYoloTagToCache(qc, "project-A", false, tag("A"));
    addYoloTagToCache(qc, "project-B", false, tag("B"));
    addYoloTagToCache(otherClient, "project-A", false, tag("other-A"));

    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([url]) => url).sort()).toEqual([
      "/api/projects/project-A",
      "/api/projects/project-A",
      "/api/projects/project-B",
    ]);

    clearYoloTagsProject(otherClient, "project-A");
    otherClient.clear();
  });

  it("serializes overlapping full-array PUTs and sends only the newest dirty snapshot next", async () => {
    const first = deferred<Response>();
    fetchMock.mockReturnValueOnce(first.promise).mockResolvedValueOnce(response());

    addYoloTagToCache(qc, "project-A", false, tag("v1"));
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    addYoloTagToCache(qc, "project-A", false, tag("v2"));
    updateYoloTagInCache(qc, "project-A", false, "v2", { name: "latest" });
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMock).toHaveBeenCalledTimes(1); // first request still owns the lane

    first.resolve(response());
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, secondInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(secondInit.body))).toEqual({
      yoloTags: [tag("v1"), { ...tag("v2"), name: "latest" }],
    });
  });

  it("demo and empty-publicId actions remain local without allocating a request", async () => {
    addYoloTagToCache(qc, "project-A", true, tag("demo-local"));
    addYoloTagToCache(qc, "", false, tag("pre-bootstrap"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(readYoloTags(qc, "project-A")).toEqual([tag("demo-local")]);
    expect(readYoloTags(qc, "")).toEqual([tag("pre-bootstrap")]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps local rows on HTTP failure, logs it, and lets a newer snapshot continue", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchMock.mockResolvedValueOnce(response({ error: { message: "denied" } }, false, 403));

    addYoloTagToCache(qc, "project-A", false, tag("local-survivor"));
    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();

    expect(readYoloTags(qc, "project-A")).toEqual([tag("local-survivor")]);
    expect(consoleError).toHaveBeenCalledWith(
      "[yoloTags] Save failed:",
      expect.objectContaining({ message: "denied" }),
    );
  });

  it("exact cleanup cancels a pending (not yet dispatched) save", async () => {
    addYoloTagToCache(qc, "project-A", false, tag("abandoned"));
    await vi.advanceTimersByTimeAsync(499);
    clearYoloTagsProject(qc, "project-A");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(qc.getQueryData(queryKeys.yoloTags.all("project-A"))).toBeUndefined();
  });

  it("aborts an already-dispatched save during exact project cleanup", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let requestSignal: AbortSignal | undefined;
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => {
      requestSignal = init.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });

    addYoloTagToCache(qc, "project-A", false, tag("in-flight"));
    await vi.advanceTimersByTimeAsync(500);
    expect(requestSignal?.aborted).toBe(false);

    clearYoloTagsProject(qc, "project-A");
    expect(requestSignal?.aborted).toBe(true);
    await flushPromises();
    expect(consoleError).toHaveBeenCalledWith(
      "[yoloTags] Save failed:",
      expect.objectContaining({ message: expect.stringContaining("aborted") }),
    );
  });
});

describe("yoloTags observer/action topology and navigation", () => {
  it("action-only hook creates no Query observer and refuses late A adoption after B becomes active", () => {
    seedYoloTagsFromBootstrap(qc, "project-A", { yoloTags: [] });
    const { result } = renderHook(() => useYoloTagActions(), { wrapper });
    const staleAddFromA = result.current.addYoloTag;
    const query = qc.getQueryCache().find({ queryKey: queryKeys.yoloTags.all("project-A"), exact: true });
    expect(query?.getObserversCount()).toBe(0);

    act(() => setViewerStoreStateForTest({ publicId: "project-B" }));
    // Invoke the callback captured by an A request before the project switch. `result.current`
    // already contains B's newly-rendered callback here and would correctly target B.
    act(() => staleAddFromA(tag("late-A")));
    expect(readYoloTags(qc, "project-A")).toEqual([]);
    expect(readYoloTags(qc, "project-B")).toEqual([]);
  });

  it("rejects stale actions across same-id demo transitions and same-project bootstrap epochs", () => {
    seedYoloTagsFromBootstrap(qc, "project-A", { yoloTags: [] });
    const first = renderHook(() => useYoloTagActions(), { wrapper });
    const staleBeforeDemo = first.result.current.addYoloTag;

    act(() => setViewerStoreStateForTest({ isDemo: true }));
    act(() => staleBeforeDemo(tag("must-not-write-from-auth-closure")));
    expect(readYoloTags(qc, "project-A")).toEqual([]);

    act(() => setViewerStoreStateForTest({ isDemo: false }));
    const freshBeforeReopen = first.result.current.addYoloTag;
    seedYoloTagsFromBootstrap(qc, "project-A", { yoloTags: [] }); // same-id loader epoch
    act(() => freshBeforeReopen(tag("must-not-write-after-reopen")));
    expect(readYoloTags(qc, "project-A")).toEqual([]);
  });

  it("by-id, page, and catalog observers expose their deliberately narrow projections", () => {
    seedYoloTagsFromBootstrap(qc, "project-A", {
      yoloTags: [
        tag("door", {
          pageNumber: 1,
          instances: [
            { pageNumber: 1, annotationId: 1, bbox: [0, 0, 0.1, 0.1], confidence: 1 },
            { pageNumber: 2, annotationId: 2, bbox: [0.2, 0.2, 0.3, 0.3], confidence: 1 },
          ],
        }),
        tag("empty", { source: "keynote", pageNumber: 1 }),
      ],
    });

    const byId = renderHook(() => useYoloTagById("door"), { wrapper });
    const page = renderHook(() => useYoloTagsForPage(1), { wrapper });
    const catalog = renderHook(() => useYoloTagCatalog(), { wrapper });

    expect(byId.result.current?.instances).toHaveLength(2);
    expect(page.result.current[0].instances).toHaveLength(1);
    expect(page.result.current[1].instances).toHaveLength(0); // all tag metadata/order retained
    expect(catalog.result.current).toEqual([
      { id: "door", tagText: "door", source: "schedule", pageNumber: 1, hasInstances: true },
      { id: "empty", tagText: "empty", source: "keynote", pageNumber: 1, hasInstances: false },
    ]);
  });

  it("preserves narrow projection identities when their observable data did not change", async () => {
    const pageOne = { pageNumber: 1, annotationId: 1, bbox: [0, 0, 0.1, 0.1] as [number, number, number, number], confidence: 1 };
    const pageTwo = { pageNumber: 2, annotationId: 2, bbox: [0.2, 0.2, 0.3, 0.3] as [number, number, number, number], confidence: 1 };
    seedYoloTagsFromBootstrap(qc, "project-A", {
      yoloTags: [tag("door", { instances: [pageOne, pageTwo] }), tag("other")],
    });

    const byId = renderHook(() => useYoloTagById("door"), { wrapper });
    const page = renderHook(() => useYoloTagsForPage(1), { wrapper });
    const catalog = renderHook(() => useYoloTagCatalog(), { wrapper });
    const beforeById = byId.result.current;
    const beforePage = page.result.current;
    const beforeCatalog = catalog.result.current;

    act(() => {
      updateYoloTagInCache(qc, "project-A", true, "door", {
        instances: [pageOne, { ...pageTwo, bbox: [0.6, 0.6, 0.7, 0.7] }],
      });
    });
    await act(async () => vi.advanceTimersByTimeAsync(0));

    expect(byId.result.current).not.toBe(beforeById); // full selected tag really changed
    expect(page.result.current).toBe(beforePage); // only another page's coordinate changed
    expect(catalog.result.current).toBe(beforeCatalog); // hasInstances stayed true

    const currentById = byId.result.current;
    act(() => updateYoloTagInCache(qc, "project-A", true, "other", { name: "changed" }));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(byId.result.current).toBe(currentById); // unrelated row edit
  });

  it("preserves missing, empty, negative-wrap, page, and exact highlight browse semantics", () => {
    const instances: YoloTag["instances"] = [
      { pageNumber: 2, annotationId: 1, bbox: [0, 0, 0.1, 0.1], confidence: 1 },
      { pageNumber: 5, annotationId: 2, bbox: [0.2, 0.2, 0.3, 0.3], confidence: 1 },
    ];
    seedYoloTagsFromBootstrap(qc, "project-A", {
      yoloTags: [tag("empty"), tag("D-201", { instances })],
    });
    setViewerStoreStateForTest({ pageNumber: 7, activeYoloTagId: "keep", tagBrowseIndex: 3 });
    const publications: string[] = [];
    const coreListener = vi.fn(() => publications.push("core"));
    const uiListener = vi.fn(() => publications.push("ui"));
    const unsubscribeCore = useViewerCoreStore.subscribe(coreListener);
    const unsubscribeUi = useUiStore.subscribe(uiListener);

    navigateYoloTag(qc, "project-A", "missing", 9);
    expect(coreListener).not.toHaveBeenCalled();
    expect(uiListener).not.toHaveBeenCalled();
    expect(useViewerCoreStore.getState().pageNumber).toBe(7);
    expect(useUiStore.getState()).toMatchObject({ activeYoloTagId: "keep", tagBrowseIndex: 3 });

    navigateYoloTag(qc, "project-A", "empty", 9);
    expect(coreListener).not.toHaveBeenCalled();
    expect(uiListener).toHaveBeenCalledTimes(1);
    expect(publications).toEqual(["ui"]);
    expect(useViewerCoreStore.getState().pageNumber).toBe(7);
    expect(useUiStore.getState()).toMatchObject({
      activeYoloTagId: "empty",
      tagBrowseId: "empty",
      tagBrowseIndex: 0,
      llmHighlight: null,
    });

    coreListener.mockClear();
    uiListener.mockClear();
    publications.length = 0;
    navigateYoloTag(qc, "project-A", "D-201", -1);
    expect(coreListener).toHaveBeenCalledTimes(1);
    expect(uiListener).toHaveBeenCalledTimes(1);
    expect(publications).toEqual(["core", "ui"]);
    expect(useViewerCoreStore.getState().pageNumber).toBe(5);
    expect(useUiStore.getState()).toMatchObject({
      activeYoloTagId: "D-201",
      tagBrowseId: "D-201",
      tagBrowseIndex: 1,
      llmHighlight: {
        pageNumber: 5,
        bbox: [0.2, 0.2, 0.3, 0.3],
        label: "D-201 — 2 of 2",
      },
    });
    unsubscribeCore();
    unsubscribeUi();
  });
});
