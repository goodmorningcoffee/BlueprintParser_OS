// [refactor jul11 P2.2⑨ C2] Production-dead facade contract. These tests exercise the new
// Query/cache owner before any production caller moves, keeping C2 additive and independently
// revertible. C3 deletes the overlapping viewerStore cases after every consumer is wired here.
// [table pipeline WP-2.D2] The merge-key case and the debounced-save describe are rewritten for the
// id-keyed tag-ops transport (same coalescing, serialization, abort and lane semantics); the
// transport describe runs the real server op algebra as a fake project row.

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
  adoptServerYoloTags,
  clearYoloTagsProject,
  importYoloTagsToCache,
  isYoloTagMapped,
  navigateYoloTag,
  readYoloTags,
  removeYoloTagFromCache,
  replaceRegionYoloTagsInCache,
  seedYoloTagsFromBootstrap,
  updateYoloTagInCache,
  type YoloTagRow,
  useYoloTagActions,
  useYoloTagById,
  useYoloTagCatalog,
  useYoloTagRows,
  useYoloTagsForPage,
} from "@/queries/useYoloTags";
import { useUiStore } from "@/stores/uiStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import type { YoloTag } from "@/types";
import { applyTagOpsToRows, parseTagOps, type StoredYoloTag } from "@/server/services/tag-ops";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

let qc: QueryClient;
const fetchMock = vi.fn();
const OPS = "/api/projects/project-A/tags/ops";

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

function hit(pageNumber: number): YoloTag["instances"][number] {
  return { pageNumber, annotationId: -1, bbox: [0.1, 0.1, 0.2, 0.2], confidence: 1 };
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
  it("merges by the shared server key: page-aware for page scope, region-aware when linked (K05)", () => {
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
      "replacement", // replaces first without moving the original position (incoming last-wins)
      "keynote",
      "page",
      "window",
    ]);

    // K05: a page-scoped tag keys by its page, so sheet 3's keynote "3" survives sheet 7's.
    addYoloTagsBulkToCache(qc, "project-A", true, [
      tag("k3-on-3", { source: "keynote", scope: "page", pageNumber: 3, tagText: "3" }),
    ]);
    addYoloTagsBulkToCache(qc, "project-A", true, [
      tag("k3-on-7", { source: "keynote", scope: "page", pageNumber: 7, tagText: "3" }),
    ]);
    // A project-scoped tag still ignores its page (unchanged): the second replaces the first.
    addYoloTagsBulkToCache(qc, "project-A", true, [tag("p1", { tagText: "Q", pageNumber: 1 })]);
    addYoloTagsBulkToCache(qc, "project-A", true, [tag("p2", { tagText: "Q", pageNumber: 2 })]);
    expect(readYoloTags(qc, "project-A").map((row) => row.id).slice(4)).toEqual(["k3-on-3", "k3-on-7", "p2"]);
  });

  it("a region link keeps two schedules' row \"1\" apart and takes over the unlinked legacy row", () => {
    seedYoloTagsFromBootstrap(qc, "project-A", {
      yoloTags: [tag("legacy-1", { tagText: "1" }), tag("other", { tagText: "9" })],
    });

    addYoloTagsBulkToCache(qc, "project-A", true, [tag("a-1", { tagText: "1" })], { regionId: "pr-a" });
    addYoloTagsBulkToCache(qc, "project-A", true, [tag("b-1", { tagText: "1" })], { regionId: "pr-b" });

    const rows = readYoloTags(qc, "project-A") as YoloTagRow[];
    // pr-a's tag took the legacy row's place (same identity, now linked); pr-b's is a second tag.
    expect(rows.map((row) => [row.id, row.links?.regionId ?? null])).toEqual([
      ["a-1", "pr-a"],
      ["other", null],
      ["b-1", "pr-b"],
    ]);
  });

  it("isYoloTagMapped matches only the exact identity (K39), plus the unlinked legacy row of a region", () => {
    const rows = [
      tag("legacy", { tagText: "D1", yoloClass: "" }),
      { ...tag("linked", { tagText: "D2", yoloClass: "" }), links: { regionId: "pr-a" } },
      tag("kn", { tagText: "3", source: "keynote", scope: "page", pageNumber: 3, yoloClass: "" }),
    ];
    const probe = (over: Record<string, unknown>) => ({
      source: "schedule", scope: "project", tagText: "D1", yoloClass: "", ...over,
    });

    expect(isYoloTagMapped(rows, probe({}))).toBe(true);
    expect(isYoloTagMapped(rows, probe({ links: { regionId: "pr-a" } }))).toBe(true); // legacy D1
    expect(isYoloTagMapped(rows, probe({ tagText: "D2", links: { regionId: "pr-a" } }))).toBe(true);
    expect(isYoloTagMapped(rows, probe({ tagText: "D2", links: { regionId: "pr-b" } }))).toBe(false);
    expect(isYoloTagMapped(rows, probe({ tagText: "D2" }))).toBe(false); // linked rows are not legacy
    expect(isYoloTagMapped(rows, probe({ yoloClass: "door" }))).toBe(false);
    expect(isYoloTagMapped(rows, probe({ source: "keynote" }))).toBe(false);
    expect(isYoloTagMapped(rows, { source: "keynote", scope: "page", pageNumber: 7, tagText: "3", yoloClass: "" })).toBe(false);
    expect(isYoloTagMapped(rows, { source: "keynote", scope: "page", pageNumber: 3, tagText: "3", yoloClass: "" })).toBe(true);
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

describe("yoloTags debounced save coordinator (id-keyed tag ops)", () => {
  function bodyOf(call: unknown[]): unknown {
    return JSON.parse(String((call[1] as RequestInit).body));
  }

  it("waits 500ms, coalesces, and POSTs id-keyed ops of the latest snapshot to the captured project", async () => {
    addYoloTagToCache(qc, "project-A", false, tag("one"));
    await vi.advanceTimersByTimeAsync(300);
    addYoloTagToCache(qc, "project-A", false, tag("two"));
    setViewerStoreStateForTest({ publicId: "project-B" });

    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(OPS, expect.objectContaining({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ops: [{ op: "upsert", tag: tag("one") }, { op: "upsert", tag: tag("two") }],
      }),
      signal: expect.any(AbortSignal),
    }));
  });

  it("sends only what changed since bootstrap: an edit is one upsert, a delete one remove (K19)", async () => {
    seedYoloTagsFromBootstrap(qc, "project-A", { yoloTags: [tag("a"), tag("b"), tag("c")] });

    updateYoloTagInCache(qc, "project-A", false, "b", { name: "renamed" });
    removeYoloTagFromCache(qc, "project-A", false, "c");
    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodyOf(fetchMock.mock.calls[0])).toEqual({
      ops: [{ op: "upsert", tag: { ...tag("b"), name: "renamed" } }, { op: "remove", id: "c" }],
    });
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
      OPS,
      OPS,
      "/api/projects/project-B/tags/ops",
    ]);

    clearYoloTagsProject(otherClient, "project-A");
    otherClient.clear();
  });

  it("serializes overlapping saves and diffs the newest snapshot against what the server acknowledged", async () => {
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
    // v1 was acknowledged by the first request, so only the newest change goes out.
    expect(bodyOf(fetchMock.mock.calls[1])).toEqual({
      ops: [{ op: "upsert", tag: { ...tag("v2"), name: "latest" } }],
    });
  });

  it("demo and empty-publicId actions remain local without allocating a request", async () => {
    addYoloTagToCache(qc, "project-A", true, tag("demo-local"));
    addYoloTagToCache(qc, "", false, tag("pre-bootstrap"));
    replaceRegionYoloTagsInCache(qc, "project-A", true, "pr-1", [tag("demo-region", { instances: [hit(1)] })]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(readYoloTags(qc, "project-A").map((row) => row.id)).toEqual(["demo-local", "demo-region"]);
    expect(readYoloTags(qc, "")).toEqual([tag("pre-bootstrap")]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps local rows on HTTP failure, logs it, and the next edit re-sends the unacknowledged change", async () => {
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
    expect(fetchMock).toHaveBeenCalledTimes(1); // no automatic retry (legacy failure-keep)

    addYoloTagToCache(qc, "project-A", false, tag("newer"));
    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchMock.mock.calls[1])).toEqual({
      ops: [{ op: "upsert", tag: tag("local-survivor") }, { op: "upsert", tag: tag("newer") }],
    });
  });

  it("falls back to one whole-array PUT when the ops route refuses the body as malformed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchMock.mockResolvedValueOnce(response({ error: { message: "bad op" } }, false, 400));
    seedYoloTagsFromBootstrap(qc, "project-A", { yoloTags: [tag("kept")] });

    addYoloTagToCache(qc, "project-A", false, tag("x".repeat(400)));
    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/projects/project-A");
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe("PUT");
    expect(bodyOf(fetchMock.mock.calls[1])).toEqual({ yoloTags: [tag("kept"), tag("x".repeat(400))] });
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

  it("times a stalled request out at 30 s, releases the lane, and re-sends its change with the next edit", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      (init.signal as AbortSignal).addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));

    addYoloTagToCache(qc, "project-A", false, tag("stalled"));
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);

    addYoloTagToCache(qc, "project-A", false, tag("after"));
    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchMock.mock.calls[1])).toEqual({
      ops: [{ op: "upsert", tag: tag("stalled") }, { op: "upsert", tag: tag("after") }],
    });
  });
});

describe("yoloTags tag-ops transport (K05, K19, K40)", () => {
  /** A fake project row running the real server op algebra (server/services/tag-ops.ts). */
  function fakeServer(initial: YoloTag[]) {
    let rows: StoredYoloTag[] = [...initial];
    const puts: unknown[] = [];
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (url.endsWith("/tags/ops")) {
        const { rows: next, ...result } = applyTagOpsToRows(rows, parseTagOps(body));
        rows = next;
        return response(result);
      }
      puts.push(body);
      rows = body.yoloTags as StoredYoloTag[];
      return response();
    });
    return { rows: () => rows, puts };
  }

  it("two tabs editing different tags both persist", async () => {
    const server = fakeServer([tag("a"), tag("b")]);
    const tabB = new QueryClient();
    seedYoloTagsFromBootstrap(qc, "project-A", { yoloTags: server.rows() });
    seedYoloTagsFromBootstrap(tabB, "project-A", { yoloTags: server.rows() });

    updateYoloTagInCache(qc, "project-A", false, "a", { name: "edited in tab A" });
    addYoloTagToCache(tabB, "project-A", false, tag("c"));
    removeYoloTagFromCache(tabB, "project-A", false, "b");
    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(server.rows()).toEqual([{ ...tag("a"), name: "edited in tab A" }, tag("c")]);
    expect(server.puts).toEqual([]);
    clearYoloTagsProject(tabB, "project-A");
    tabB.clear();
  });

  it("the same tag text on two sheets stays two tags, in the cache and on the server (K05)", async () => {
    const server = fakeServer([]);
    seedYoloTagsFromBootstrap(qc, "project-A", { yoloTags: [] });
    const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
    const sheet = (page: number) => keys.map((k) => tag(`kn-${page}-${k}`, {
      source: "keynote", scope: "page", pageNumber: page, tagText: k, instances: [hit(page)],
    }));

    addYoloTagsBulkToCache(qc, "project-A", false, sheet(3));
    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();
    addYoloTagsBulkToCache(qc, "project-A", false, sheet(7));
    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();

    expect(readYoloTags(qc, "project-A")).toHaveLength(18);
    expect(server.rows()).toHaveLength(18);
    expect(server.rows().filter((row) => row.tagText === "3").map((row) => row.pageNumber)).toEqual([3, 7]);
  });

  it("a region re-map clears that region's 0-hit tags only, retires its legacy row, and adopts server ids (K40)", async () => {
    const prior = { ...tag("server-id", { tagText: "D1", instances: [hit(1)] }), links: { regionId: "pr-1" } };
    const stale = { ...tag("stale", { tagText: "D9", instances: [hit(1)] }), links: { regionId: "pr-1" } };
    const otherRegion = { ...tag("other", { tagText: "D9", instances: [hit(2)] }), links: { regionId: "pr-2" } };
    const legacy = tag("legacy-D2", { tagText: "D2", instances: [hit(3)] });
    const unrelated = tag("unrelated", { tagText: "Z" });
    const server = fakeServer([prior, stale, otherRegion, legacy, unrelated]);
    // This tab never saw the prior pr-1 row (another tab created it), so its D1 has a client id.
    seedYoloTagsFromBootstrap(qc, "project-A", { yoloTags: [stale, otherRegion, legacy, unrelated] });

    replaceRegionYoloTagsInCache(qc, "project-A", false, "pr-1", [
      tag("client-D1", { tagText: "D1", instances: [hit(5)] }),
      tag("client-D2", { tagText: "D2", instances: [hit(6)] }),
      tag("client-D9", { tagText: "D9", instances: [] }), // 0 hits now
    ], { source: "schedule", scope: "project", yoloClass: "door", texts: ["D1", "D2", "D9"] });

    // Local view at once: pr-1 holds D1 + D2, the legacy D2 row is retired, pr-2 is untouched.
    expect(readYoloTags(qc, "project-A").map((row) => row.id)).toEqual(["other", "unrelated", "client-D1", "client-D2"]);

    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(sent.ops).toHaveLength(1);
    expect(sent.ops[0]).toMatchObject({ op: "replace-for-region", regionId: "pr-1", retireIds: ["legacy-D2"] });

    const byText = (rows: readonly YoloTag[]) => rows.map((row) => [row.id, row.tagText, (row as YoloTagRow).links?.regionId ?? null]);
    expect(byText(server.rows())).toEqual([
      ["server-id", "D1", "pr-1"], // the server kept its prior id
      ["other", "D9", "pr-2"],
      ["unrelated", "Z", null],
      ["client-D2", "D2", "pr-1"],
    ]);
    // The cache adopted the server's rows: the client id of D1 is gone, nothing else moved.
    expect(byText(readYoloTags(qc, "project-A"))).toEqual([
      ["other", "D9", "pr-2"],
      ["unrelated", "Z", null],
      ["client-D2", "D2", "pr-1"],
      ["server-id", "D1", "pr-1"],
    ]);

    // Adoption moved the acknowledged baseline: the next edit sends only itself.
    updateYoloTagInCache(qc, "project-A", false, "unrelated", { name: "edited" });
    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();
    expect(JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body))).toEqual({
      ops: [{ op: "upsert", tag: { ...unrelated, name: "edited" } }],
    });
  });

  it("an import still sends ONE whole-array PUT", async () => {
    const server = fakeServer([tag("old")]);
    seedYoloTagsFromBootstrap(qc, "project-A", { yoloTags: [tag("old")] });

    importYoloTagsToCache(qc, "project-A", false, [tag("i1"), tag("i2")]);
    addYoloTagToCache(qc, "project-A", false, tag("edit-before-send"));
    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/projects/project-A");
    expect(server.puts).toEqual([{ yoloTags: [tag("i1"), tag("i2"), tag("edit-before-send")] }]);

    // After the import the lane is back on ops, diffed against the imported array.
    removeYoloTagFromCache(qc, "project-A", false, "i1");
    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();
    expect(fetchMock.mock.calls[1][0]).toBe(OPS);
    expect(server.rows().map((row) => row.id)).toEqual(["i2", "edit-before-send"]);
  });

  it("adoptServerYoloTags shows server rows without a save, and the next edit does not echo them", async () => {
    seedYoloTagsFromBootstrap(qc, "project-A", {
      yoloTags: [{ ...tag("r-old", { instances: [hit(1)] }), links: { regionId: "pr-1" } }, tag("keep")],
    });
    const serverRow = { ...tag("r-new", { tagText: "N", instances: [hit(2)] }), links: { regionId: "pr-1" } };

    adoptServerYoloTags(qc, "project-A", [serverRow], ["pr-1"]);
    expect(readYoloTags(qc, "project-A").map((row) => row.id)).toEqual(["keep", "r-new"]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).not.toHaveBeenCalled();

    addYoloTagToCache(qc, "project-A", false, tag("mine"));
    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({
      ops: [{ op: "upsert", tag: tag("mine") }],
    });

    // A closed project's cache entry is never resurrected by a late adoption.
    clearYoloTagsProject(qc, "project-B");
    adoptServerYoloTags(qc, "project-B", [serverRow], ["pr-1"]);
    expect(qc.getQueryData(queryKeys.yoloTags.all("project-B"))).toBeUndefined();
  });
});

describe("yoloTags observer/action topology and navigation", () => {
  it("bulk action reports whether its captured project/demo/epoch identity accepted the write", () => {
    seedYoloTagsFromBootstrap(qc, "project-A", { yoloTags: [] });
    const actions = renderHook(() => useYoloTagActions(), { wrapper });

    // Empty input is still a successfully handled current-project mapping (zero matches).
    expect(actions.result.current.addYoloTagsBulk([])).toBe(true);

    const staleAcrossProject = actions.result.current.addYoloTagsBulk;
    act(() => setViewerStoreStateForTest({ publicId: "project-B" }));
    expect(staleAcrossProject([])).toBe(false);

    act(() => setViewerStoreStateForTest({ publicId: "project-A" }));
    const staleAcrossReopen = actions.result.current.addYoloTagsBulk;
    seedYoloTagsFromBootstrap(qc, "project-A", { yoloTags: [] });
    expect(staleAcrossReopen([])).toBe(false);
  });

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
    seedYoloTagsFromBootstrap(qc, "project-A", { yoloTags: [] }); // same-id lifecycle epoch
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
