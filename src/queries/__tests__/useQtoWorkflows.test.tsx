// [refactor jul10 P2.2②] Tests for the qto query facade (variant b, independent-fetch).
// Added at the MIGRATION commit (RECIPE step 10) — they define the target backing.
// Timing rule (RECIPE gotcha): read post-setQueryData state via `await waitFor`, never
// synchronously after `act` (RQ notifies observers asynchronously).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, focusManager, onlineManager } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useQtoWorkflows } from "@/queries/useQtoWorkflows";
import { useViewerStore } from "@/stores/viewerStore";
import { queryKeys } from "@/queries/queryKeys";
import type { QtoWorkflow } from "@/types";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}
function freshClient() {
  return new QueryClient(); // hook pins its own retry:false — no test-level default needed
}

function row(id: number, over: Partial<QtoWorkflow> = {}): QtoWorkflow {
  return {
    id,
    projectId: 1,
    materialType: "doors",
    materialLabel: `WF-${id}`,
    step: "select-schedule",
    schedulePageNumber: null,
    yoloClassFilter: null,
    itemType: "yolo-with-inner-text",
    tagShapeClass: null,
    parsedSchedule: null,
    lineItems: null,
    userEdits: null,
    exportedAt: null,
    ...over,
  } as QtoWorkflow;
}

const fetchMock = vi.fn();
function mockGet(rowsByPublicId: Record<string, QtoWorkflow[] | { status: number }>) {
  fetchMock.mockImplementation((url: string) => {
    const m = /\/api\/qto-workflows\?projectId=([^&]+)/.exec(String(url));
    if (!m) throw new Error(`unexpected fetch: ${url}`);
    const entry = rowsByPublicId[m[1]];
    if (entry && !Array.isArray(entry)) {
      return Promise.resolve({ ok: false, status: entry.status, json: async () => ({}) });
    }
    return Promise.resolve({ ok: true, json: async () => entry ?? [] });
  });
}

beforeEach(() => {
  resetProjectData();
  setViewerStoreStateForTest({ publicId: "P", isDemo: false });
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useQtoWorkflows hook", () => {
  it("T-Q1: initialData [] first, then the GET's raw rows land (no mapper — extra keys survive)", async () => {
    const serverRows = [
      { ...row(2), createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-02T00:00:00Z" },
      row(1),
    ] as QtoWorkflow[];
    mockGet({ P: serverRows });
    const { result } = renderHook(() => useQtoWorkflows(), { wrapper: makeWrapper(freshClient()) });

    expect(result.current.qtoWorkflows).toEqual([]); // initialData, never undefined
    await waitFor(() => expect(result.current.qtoWorkflows).toEqual(serverRows));
    // raw rows: server-only timestamp keys pass through untouched (frozen: NO client mapper)
    expect((result.current.qtoWorkflows[0] as never as { createdAt: string }).createdAt).toBe(
      "2026-07-01T00:00:00Z",
    );
    expect(fetchMock.mock.calls[0][0]).toBe("/api/qto-workflows?projectId=P");
  });

  it("T-Q2: demo never fetches (enabled:false) and reads [] — temp writes still land in the cache", async () => {
    setViewerStoreStateForTest({ isDemo: true });
    mockGet({ P: [row(1)] }); // present but must never be hit
    const { result } = renderHook(() => useQtoWorkflows(), { wrapper: makeWrapper(freshClient()) });

    expect(result.current.qtoWorkflows).toEqual([]);
    const temp = row(-1736500000000, { projectId: 0 });
    act(() => result.current.setQtoWorkflows([temp]));
    await waitFor(() => expect(result.current.qtoWorkflows).toEqual([temp]));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("T-Q3: non-ok GET resolves to [] (list-clear, not an error state)", async () => {
    const client = freshClient();
    client.setQueryData(queryKeys.qtoWorkflows.all("P"), [row(9)]); // stale prior entry
    mockGet({ P: { status: 500 } });
    const { result } = renderHook(() => useQtoWorkflows(), { wrapper: makeWrapper(client) });

    await waitFor(() => expect(result.current.qtoWorkflows).toEqual([]));
    expect(fetchMock).toHaveBeenCalledTimes(1); // and no retry on a resolved non-ok
  });

  it("T-Q4: network error → single attempt (retry:false), previous data kept", async () => {
    const client = freshClient();
    const kept = [row(5)];
    client.setQueryData(queryKeys.qtoWorkflows.all("P"), kept);
    fetchMock.mockRejectedValue(new Error("down"));
    const { result } = renderHook(() => useQtoWorkflows(), { wrapper: makeWrapper(client) });

    // the failed refetch leaves the cached rows rendered (== old console.error + list unchanged)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // [DETECTOR closer] retry pin must outlast query-core's DEFAULT first retry, which fires at
    // 1000ms (retryer delay = 1000 * 2^0) — the old 50ms window could never see it, so deleting
    // retry:false left every test green while production gained 4-attempt/~7s retry behavior.
    await new Promise((r) => setTimeout(r, 1250));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.qtoWorkflows).toEqual(kept);
  });

  it("T-Q5: setQtoWorkflows is a REPLACE facade scoped to the current publicId", async () => {
    const client = freshClient();
    mockGet({ P: [row(1)] });
    const { result } = renderHook(() => useQtoWorkflows(), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(result.current.qtoWorkflows).toHaveLength(1));

    act(() => result.current.setQtoWorkflows([row(3), row(2)]));
    await waitFor(() => expect(result.current.qtoWorkflows).toEqual([row(3), row(2)]));
    // replace, not merge — row(1) is gone; key shape is the documented tuple
    expect(client.getQueryData(["project", "P", "qtoWorkflows"])).toEqual([row(3), row(2)]);
  });

  it("T-Q6: two-publicId isolation — a write to A never touches B; return-to-A refetch reasserts server truth", async () => {
    const client = freshClient();
    mockGet({ A: [row(1)], B: [row(2)] });

    setViewerStoreStateForTest({ publicId: "A" });
    const { result } = renderHook(() => useQtoWorkflows(), { wrapper: makeWrapper(client) });
    // data flipping [] → rows proves the mount fetch SETTLED — only write after settle (a write
    // racing an in-flight GET is replaced by the response, same as the old mount-fetch overwrite)
    await waitFor(() => expect(result.current.qtoWorkflows).toEqual([row(1)]));

    act(() => result.current.setQtoWorkflows([row(1), row(7)]));
    await waitFor(() => expect(result.current.qtoWorkflows).toEqual([row(1), row(7)]));
    expect(client.getQueryData(queryKeys.qtoWorkflows.all("B"))).toBeUndefined(); // A-write, no B entry

    act(() => setViewerStoreStateForTest({ publicId: "B" }));
    await waitFor(() => expect(result.current.qtoWorkflows).toEqual([row(2)]));
    // A's entry (incl. the client write) retained per-key while B is active
    expect(client.getQueryData(queryKeys.qtoWorkflows.all("A"))).toEqual([row(1), row(7)]);

    act(() => setViewerStoreStateForTest({ publicId: "A" }));
    // staleTime:0 → return-to-A refetches and the SERVER list wins over the stale client write
    // (== old world: the mount fetch overwrote whatever was in zustand)
    await waitFor(() => expect(result.current.qtoWorkflows).toEqual([row(1)]));
    expect(client.getQueryData(queryKeys.qtoWorkflows.all("B"))).toEqual([row(2)]);
  });

  it("T-Q7: staleTime 0 — every remount refetches (== the old fetch-on-mount effect)", async () => {
    const client = freshClient();
    mockGet({ P: [row(1)] });
    const first = renderHook(() => useQtoWorkflows(), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    first.unmount();

    const second = renderHook(() => useQtoWorkflows(), { wrapper: makeWrapper(client) });
    // cached rows show instantly…
    expect(second.result.current.qtoWorkflows).toEqual([row(1)]);
    // …and a background refetch fires because the entry is immediately stale
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("T-Q8: no refetch on window focus (refetchOnWindowFocus:false, despite stale data)", async () => {
    mockGet({ P: [row(1)] });
    renderHook(() => useQtoWorkflows(), { wrapper: makeWrapper(freshClient()) });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    try {
      act(() => {
        focusManager.setFocused(false);
        focusManager.setFocused(true); // would refetch a stale query if the flag were default-true
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      focusManager.setFocused(undefined); // restore default focus detection even on assert failure
    }
  });

  it("T-Q10: empty publicId → disabled, fetch never fires, reads []", async () => {
    setViewerStoreStateForTest({ publicId: "" });
    mockGet({});
    const { result } = renderHook(() => useQtoWorkflows(), { wrapper: makeWrapper(freshClient()) });

    expect(result.current.qtoWorkflows).toEqual([]);
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("T-Q11: S6 pin — a captured setter targets the publicId it was rendered with, never the current one", async () => {
    // Models the old cross-project write-leak the migration FIXES (SPEC §5 S6): updateWorkflowStep's
    // post-await reconcile runs a setQtoWorkflows captured BEFORE a project switch. Old zustand wrote
    // the GLOBAL field (project A's list leaked into B's view); the keyed facade writes A's entry.
    const client = freshClient();
    mockGet({ A: [row(1)], B: [row(2)] });
    setViewerStoreStateForTest({ publicId: "A" });
    const { result } = renderHook(() => useQtoWorkflows(), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(result.current.qtoWorkflows).toEqual([row(1)]));
    const capturedWrite = result.current.setQtoWorkflows; // closed over publicId "A"

    act(() => setViewerStoreStateForTest({ publicId: "B" }));
    await waitFor(() => expect(result.current.qtoWorkflows).toEqual([row(2)]));

    act(() => capturedWrite([row(1), row(9)])); // the in-flight PUT reconcile lands "late"

    // B's VIEW is untouched (old code would now show A's reconciled list here)…
    expect(result.current.qtoWorkflows).toEqual([row(2)]);
    // …because the write landed under A's key.
    expect(client.getQueryData(queryKeys.qtoWorkflows.all("A"))).toEqual([row(1), row(9)]);
  });

  it("T-Q12: no refetch on reconnect (refetchOnReconnect:false)", async () => {
    mockGet({ P: [row(1)] });
    renderHook(() => useQtoWorkflows(), { wrapper: makeWrapper(freshClient()) });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    act(() => {
      onlineManager.setOnline(false);
      onlineManager.setOnline(true); // a stale query with the default flag would refetch here
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("T-Q13: networkMode 'always' — the mount fetch fires even while 'offline' (old fire-and-fail parity)", async () => {
    mockGet({ P: [row(1)] });
    onlineManager.setOnline(false); // v5 default 'online' would PAUSE: no fetch call at all
    try {
      const { result } = renderHook(() => useQtoWorkflows(), { wrapper: makeWrapper(freshClient()) });
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(result.current.qtoWorkflows).toEqual([row(1)]));
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it("T-Q14: activeQtoWorkflow passes through the facade to/from zustand unchanged", async () => {
    setViewerStoreStateForTest({ isDemo: true }); // no fetch noise
    const { result } = renderHook(() => useQtoWorkflows(), { wrapper: makeWrapper(freshClient()) });
    expect(result.current.activeQtoWorkflow).toBeNull();

    act(() => result.current.setActiveQtoWorkflow(row(3)));
    await waitFor(() => expect(result.current.activeQtoWorkflow).toEqual(row(3)));
    expect(useViewerStore.getState().activeQtoWorkflow).toEqual(row(3)); // still zustand-backed

    act(() => result.current.setActiveQtoWorkflow(null));
    await waitFor(() => expect(result.current.activeQtoWorkflow).toBeNull());
  });

  // gcTime:Infinity — the demo-temp survival pin (chat T-A6 pattern: an UN-advanced GC timer
  // proves nothing; advance fake timers a full hour past the last observer's unmount).
  it("T-Q9: gcTime:Infinity keeps the entry alive an hour after the last observer unmounts", () => {
    vi.useFakeTimers();
    try {
      const client = freshClient();
      setViewerStoreStateForTest({ isDemo: true }); // demo: no fetch to race the fake timers
      const temp = [row(-42, { projectId: 0 })];
      client.setQueryData(queryKeys.qtoWorkflows.all("P"), temp);

      const first = renderHook(() => useQtoWorkflows(), { wrapper: makeWrapper(client) });
      expect(first.result.current.qtoWorkflows).toEqual(temp);
      first.unmount(); // GC timer armed (Infinity = never fires)

      vi.advanceTimersByTime(24 * 60 * 60 * 1000); // a full observer-less DAY (tightens the ∞ bound)
      expect(client.getQueryData(queryKeys.qtoWorkflows.all("P"))).toEqual(temp);

      const second = renderHook(() => useQtoWorkflows(), { wrapper: makeWrapper(client) });
      expect(second.result.current.qtoWorkflows).toEqual(temp);
    } finally {
      vi.useRealTimers();
    }
  });
});
