// @vitest-environment node
// [refactor jun13 P0.5-G6] commitBucketFillToItem persistence gate. Before:
// gated on !isDemo only (publicId can be "" pre-bootstrap → request shipped
// projectId:"" and 404'd) and .catch(console.error) swallowed failures — the
// user saw the fill, the server never had it. Freezes: canPersist gate (no
// request without a publicId), failures surface via bucketFillError, demo
// stays local-only, and the optimistic temp id is swapped on success.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { useViewerStore } from "@/stores/viewerStore";
import { readSeededAnnotations, seedAnnotations } from "@/test/seed-annotations";
import type { ClientTakeoffItem } from "@/types";

const item: ClientTakeoffItem = {
  id: 7,
  name: "Carpet",
  shape: "circle",
  color: "#00ff00",
  size: 10,
  sortOrder: 0,
} as ClientTakeoffItem;

const pending = {
  vertices: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.1 }, { x: 0.2, y: 0.2 }],
  method: "bucket",
  bbox: [0.1, 0.1, 0.2, 0.2] as [number, number, number, number],
  areaSqUnits: 120,
  unit: "sqft",
};

const fetchMock = vi.fn();
const flush = () => new Promise((r) => setTimeout(r, 0));
let qc: QueryClient;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  // [refactor jul11 P2.2⑥] The action is still store-owned in C1, but its data assertions
  // already use the shared annotation seam so the characterization survives the cache flip.
  qc = new QueryClient();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  useViewerStore.setState({
    bucketFillError: null,
    bucketFillPendingPolygon: pending,
    pageNumber: 3,
    isDemo: false,
    publicId: "pub-123",
  } as never);
  seedAnnotations(qc, []);
});
afterEach(() => {
  qc.clear();
  vi.unstubAllGlobals();
});

describe("commitBucketFillToItem — G6 persistence gate", () => {
  it("no publicId → no request, bucketFillError surfaced, local annotation kept", () => {
    useViewerStore.setState({ publicId: "" } as never);
    // [refactor jul11 P2.2⑥] Seed AFTER changing publicId. Post-C3 the empty-string
    // pre-bootstrap state is its own query key; seeding the old "pub-123" key would make
    // this direct action test pass PRE but read the wrong cache entry after the flip.
    seedAnnotations(qc, []);
    useViewerStore.getState().commitBucketFillToItem(item);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useViewerStore.getState().bucketFillError).toMatch(/NOT saved/);
    const anns = readSeededAnnotations(qc);
    expect(anns).toHaveLength(1);
    expect(anns[0].id).toBeLessThan(0);
    expect(useViewerStore.getState().bucketFillPendingPolygon).toBeNull();
  });

  it("demo stays local-only: no request, no error", () => {
    useViewerStore.setState({ isDemo: true } as never);
    useViewerStore.getState().commitBucketFillToItem(item);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useViewerStore.getState().bucketFillError).toBeNull();
    const anns = readSeededAnnotations(qc);
    expect(anns).toHaveLength(1);
    expect(anns[0].id).toBeLessThan(0);
    expect(useViewerStore.getState().bucketFillPendingPolygon).toBeNull();
  });

  it("server failure surfaces via bucketFillError and keeps the optimistic annotation", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }),
    );
    useViewerStore.getState().commitBucketFillToItem(item);

    // [refactor jul11 P2.2⑥] Existing writes intentionally KEEP optimistic state on
    // persistence failure. C3 may move the row to Query, but must not add rollback while
    // hoisting this cross-backend action; pending is consumed in the same user gesture.
    const optimisticId = readSeededAnnotations(qc)[0]?.id;
    expect(optimisticId).toBeLessThan(0);
    expect(useViewerStore.getState().bucketFillPendingPolygon).toBeNull();

    await flush();
    expect(useViewerStore.getState().bucketFillError).toMatch(/NOT saved.*Forbidden/);
    expect(readSeededAnnotations(qc).map((ann) => ann.id)).toEqual([optimisticId]);
  });

  it("success adds+consumes pending optimistically, then posts publicId and swaps the temp id", async () => {
    const save = deferred<Response>();
    fetchMock.mockReturnValueOnce(save.promise);
    useViewerStore.getState().commitBucketFillToItem(item);

    // Mock-call-anchored optimistic pin: the local row and pending clear happen before the
    // server response. A server-first rewrite would otherwise pass on the final 4242 state.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const optimistic = readSeededAnnotations(qc);
    expect(optimistic).toHaveLength(1);
    expect(optimistic[0].id).toBeLessThan(0);
    expect(useViewerStore.getState().bucketFillPendingPolygon).toBeNull();

    save.resolve(new Response(JSON.stringify({ id: 4242 }), { status: 200 }));
    await flush();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.projectId).toBe("pub-123"); // publicId, never "" or numeric 0
    expect(body.pageNumber).toBe(3);
    const anns = readSeededAnnotations(qc);
    expect(anns).toHaveLength(1);
    expect(anns[0].id).toBe(4242);
    expect(useViewerStore.getState().bucketFillError).toBeNull();
  });
});
