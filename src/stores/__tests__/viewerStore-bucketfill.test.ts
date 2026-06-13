// @vitest-environment node
// [refactor jun13 P0.5-G6] commitBucketFillToItem persistence gate. Before:
// gated on !isDemo only (publicId can be "" pre-bootstrap → request shipped
// projectId:"" and 404'd) and .catch(console.error) swallowed failures — the
// user saw the fill, the server never had it. Freezes: canPersist gate (no
// request without a publicId), failures surface via bucketFillError, demo
// stays local-only, and the optimistic temp id is swapped on success.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useViewerStore } from "@/stores/viewerStore";
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

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  useViewerStore.setState({
    annotations: [],
    bucketFillError: null,
    bucketFillPendingPolygon: pending,
    pageNumber: 3,
    isDemo: false,
    publicId: "pub-123",
  } as never);
});
afterEach(() => vi.unstubAllGlobals());

describe("commitBucketFillToItem — G6 persistence gate", () => {
  it("no publicId → no request, bucketFillError surfaced, local annotation kept", () => {
    useViewerStore.setState({ publicId: "" } as never);
    useViewerStore.getState().commitBucketFillToItem(item);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useViewerStore.getState().bucketFillError).toMatch(/NOT saved/);
    expect(useViewerStore.getState().annotations).toHaveLength(1);
  });

  it("demo stays local-only: no request, no error", () => {
    useViewerStore.setState({ isDemo: true } as never);
    useViewerStore.getState().commitBucketFillToItem(item);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useViewerStore.getState().bucketFillError).toBeNull();
    expect(useViewerStore.getState().annotations).toHaveLength(1);
  });

  it("server failure surfaces via bucketFillError instead of console-only", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }),
    );
    useViewerStore.getState().commitBucketFillToItem(item);
    await flush();
    expect(useViewerStore.getState().bucketFillError).toMatch(/NOT saved.*Forbidden/);
  });

  it("success posts publicId as projectId and swaps the temp id", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: 4242 }), { status: 200 }),
    );
    useViewerStore.getState().commitBucketFillToItem(item);
    await flush();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.projectId).toBe("pub-123"); // publicId, never "" or numeric 0
    expect(body.pageNumber).toBe(3);
    const anns = useViewerStore.getState().annotations;
    expect(anns).toHaveLength(1);
    expect(anns[0].id).toBe(4242);
    expect(useViewerStore.getState().bucketFillError).toBeNull();
  });
});
