// [refactor jul10 P2.2③] Tests for the summaries query facade (chat-suite clone — SPEC §6).
// Green only from the MIGRATION commit (they define the target backing). The DOM freeze net
// (SummariesFreeze.test.tsx + AutoQtoTab.test.tsx AQT-R) was landed green PRE-migration and must
// stay green byte-for-byte across the flip; this file pins the hook/helper semantics themselves:
// null default, seed→read, the v5 setQueryData(undefined)-no-op trap, value-replace, per-request
// publicId provenance (S3), key isolation, and the staleTime/gcTime config.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { seedSummariesCache, useSummariesData, useSummaries } from "@/queries/useSummaries";
import { useViewerStore } from "@/stores/viewerStore";
import { queryKeys } from "@/queries/queryKeys";
import type { ProjectSummaries } from "@/types";

// Full-shape fixture (same discipline as SummariesFreeze.test.tsx): honest against the real type
// so a field rename breaks HERE, not silently in a consumer.
function summariesFixture(over: Partial<ProjectSummaries> = {}): ProjectSummaries {
  return {
    schedules: [],
    parsedTables: [],
    keynoteTablePages: [],
    csiPageIndex: {},
    tradePageIndex: {},
    keynotePageIndex: {},
    textAnnotationPageIndex: {},
    pageClassifications: {},
    annotationSummary: { modelNames: [], categoryCounts: {}, pageAnnotationCounts: {} },
    takeoffTotals: {},
    allTrades: [],
    allCsiCodes: [],
    ...over,
  };
}

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}
function freshClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

// ── seedSummariesCache — the ONE production write helper (8 call sites) ───────────────────────
describe("seedSummariesCache (loader/refresher seed)", () => {
  it("undefined summaries seed NULL — the v5 setQueryData(undefined) silent-no-op trap", () => {
    const qc = new QueryClient();
    // pre-populate a "previous visit" entry: without the `?? null` coercion this would be
    // silently RETAINED (v5 query-core: `if (data === void 0) return`) = the stale-summaries bug
    // the old reset-then-conditional-set flow prevented.
    qc.setQueryData(queryKeys.summaries.all("p"), summariesFixture({ allTrades: ["Stale"] }));
    seedSummariesCache(qc, "p", undefined);
    expect(qc.getQueryData(queryKeys.summaries.all("p"))).toBeNull();
  });

  it("null summaries seed null (loader parity: response with summaries: null)", () => {
    const qc = new QueryClient();
    seedSummariesCache(qc, "p", null);
    expect(qc.getQueryData(queryKeys.summaries.all("p"))).toBeNull();
  });

  it("present summaries land verbatim under the exact publicId key; other keys untouched", () => {
    const qc = new QueryClient();
    const s = summariesFixture({ allTrades: ["Plumbing"] });
    seedSummariesCache(qc, "p-A", s);
    // key shape is exactly the documented tuple
    expect(queryKeys.summaries.all("p-A")).toEqual(["project", "p-A", "summaries"]);
    expect(qc.getQueryData(queryKeys.summaries.all("p-A"))).toEqual(s);
    expect(qc.getQueryData(queryKeys.summaries.all("p-B"))).toBeUndefined();
  });

  it("re-seeding the same key REPLACES (loader overwrites a stale same-key entry on re-open)", () => {
    const qc = new QueryClient();
    seedSummariesCache(qc, "p", summariesFixture({ allTrades: ["Old"] }));
    const next = summariesFixture({ allTrades: ["New"] });
    seedSummariesCache(qc, "p", next);
    expect(qc.getQueryData(queryKeys.summaries.all("p"))).toEqual(next);
  });
});

// ── useSummariesData / useSummaries — the cache-backed facade ─────────────────────────────────
describe("useSummaries hooks", () => {
  beforeEach(() => {
    useViewerStore.getState().resetProjectData();
  });

  it("null default: fresh client reads summaries === null without fetching or erroring", () => {
    useViewerStore.setState({ publicId: "p-A" });
    const client = freshClient();
    const { result } = renderHook(() => useSummariesData(), { wrapper: makeWrapper(client) });
    expect(result.current.summaries).toBeNull();
    // enabled:false + non-undefined initialData -> immediate success, idle, and the throwing
    // queryFn never ran (an error status here would mean it did).
    const q = client.getQueryCache().find({ queryKey: queryKeys.summaries.all("p-A") })!;
    expect(q.state.status).toBe("success");
    expect(q.state.fetchStatus).toBe("idle");
  });

  it("seed→read round-trip: a pre-mount loader-style seed is what the hook renders", async () => {
    useViewerStore.setState({ publicId: "p-A" });
    const client = freshClient();
    const s = summariesFixture({ allTrades: ["Electrical"] });
    seedSummariesCache(client, "p-A", s); // loader runs BEFORE consumers mount (seed-before-reveal)
    const { result } = renderHook(() => useSummariesData(), { wrapper: makeWrapper(client) });
    // pre-mount seed is read synchronously at construction (initialData never clobbers it),
    // but keep waitFor for uniformity with RQ's async notify elsewhere.
    await waitFor(() => expect(result.current.summaries).toEqual(s));
  });

  it("setSummaries value-replaces, including back to null (old store-action parity)", async () => {
    useViewerStore.setState({ publicId: "p-A" });
    const client = freshClient();
    const { result } = renderHook(() => useSummariesData(), { wrapper: makeWrapper(client) });
    const s1 = summariesFixture({ allTrades: ["One"] });
    const s2 = summariesFixture({ allTrades: ["Two"] });

    act(() => result.current.setSummaries(s1));
    await waitFor(() => expect(result.current.summaries).toEqual(s1));

    act(() => result.current.setSummaries(s2)); // replace, not merge
    await waitFor(() => expect(result.current.summaries).toEqual(s2));

    act(() => result.current.setSummaries(null)); // the signature must keep accepting null
    await waitFor(() => expect(result.current.summaries).toBeNull());
  });

  it("S3 pin: a refresher write lands under the REQUEST's publicId, not the store's current one", async () => {
    // Scenario: promote fired for project A, user switched to project B mid-await. The response
    // must seed A's entry (captured per-site publicId) and leave B's view untouched — the old
    // single global store field leaked A's recompute into B here.
    useViewerStore.setState({ publicId: "B" });
    const client = freshClient();
    const { result } = renderHook(() => useSummariesData(), { wrapper: makeWrapper(client) });
    expect(result.current.summaries).toBeNull(); // B's null-initialData entry

    const fromPromoteForA = summariesFixture({ allTrades: ["Project-A-recompute"] });
    act(() => seedSummariesCache(client, "A", fromPromoteForA));

    // A's entry received the write...
    expect(client.getQueryData(queryKeys.summaries.all("A"))).toEqual(fromPromoteForA);
    // ...and the mounted reader on B never sees it (B's entry stays null).
    expect(client.getQueryData(queryKeys.summaries.all("B"))).toBeNull();
    await waitFor(() => expect(result.current.summaries).toBeNull());
  });

  it("publicId-scoped isolation: switching publicId swaps the entry; a write to A never touches B", async () => {
    const client = freshClient();
    const sA = summariesFixture({ allTrades: ["A-trade"] });
    const sB = summariesFixture({ allTrades: ["B-trade"] });
    seedSummariesCache(client, "A", sA);
    seedSummariesCache(client, "B", sB);

    useViewerStore.setState({ publicId: "A" });
    const { result } = renderHook(() => useSummariesData(), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(result.current.summaries).toEqual(sA));

    act(() => useViewerStore.setState({ publicId: "B" }));
    await waitFor(() => expect(result.current.summaries).toEqual(sB));

    act(() => useViewerStore.setState({ publicId: "A" }));
    const sA2 = summariesFixture({ allTrades: ["A-trade-v2"] });
    act(() => result.current.setSummaries(sA2)); // render-captured setter now targets A again
    await waitFor(() => expect(result.current.summaries).toEqual(sA2));
    expect(client.getQueryData(queryKeys.summaries.all("B"))).toEqual(sB);
  });

  it("staleTime:Infinity — a seeded entry is never stale while observed (defensive pin)", () => {
    useViewerStore.setState({ publicId: "A" });
    const client = freshClient();
    seedSummariesCache(client, "A", summariesFixture());
    renderHook(() => useSummariesData(), { wrapper: makeWrapper(client) });
    // Under the v5 default staleTime:0 a data-bearing query is stale the moment it lands; under
    // the hook's Infinity it never goes stale (moot with enabled:false, but pinned so a future
    // app-wide defaultOptions or an enabled flip can't silently add refetch pressure).
    const q = client.getQueryCache().find({ queryKey: queryKeys.summaries.all("A") })!;
    expect(q.isStale()).toBe(false);
  });

  // gcTime:Infinity — same fake-timer mechanics as chat's T-A6 (a synchronous unmount/remount
  // would pass for ANY gcTime; only advancing timers past a plausible finite value discriminates).
  // Rationale differs from chat's, deliberately: summaries would be RECOVERABLE (loader re-seeds
  // on re-entry; refresher writes are server-persisted) — Infinity is pure faithfulness to the
  // always-resident zustand field, and this pin keeps that config from silently drifting.
  it("gcTime:Infinity keeps the entry alive across an observer gap even after an hour passes", () => {
    vi.useFakeTimers();
    try {
      const client = freshClient();
      const s = summariesFixture({ allTrades: ["Persist"] });
      seedSummariesCache(client, "A", s);
      useViewerStore.setState({ publicId: "A" });

      const first = renderHook(() => useSummariesData(), { wrapper: makeWrapper(client) });
      expect(first.result.current.summaries).toEqual(s);
      first.unmount(); // last observer gone -> GC timer armed at gcTime (Infinity = never fires)

      vi.advanceTimersByTime(60 * 60 * 1000); // an hour of "panel closed"
      expect(client.getQueryData(queryKeys.summaries.all("A"))).toEqual(s);

      const second = renderHook(() => useSummariesData(), { wrapper: makeWrapper(client) });
      expect(second.result.current.summaries).toEqual(s);
    } finally {
      vi.useRealTimers();
    }
  });

  // [refactor jul10 P2.2③ closers] Mechanical pin of the SpecIndex/NotesIndex hot-path property
  // (SPEC §2.3 / §7): the narrow hook exists PRECISELY so those two viewer-adjacent consumers
  // never gain chunk-field re-renders they lacked under their old raw `s.summaries` selector
  // (chunkLoading toggles on every chunk fetch; PDF-viewer perf is sacred). Before this case the
  // property was only prose — a future "simplify: reuse useSummaries() everywhere" edit would
  // have passed the whole suite. This probe counts renders: zustand chunk-field flips must cause
  // ZERO, a summaries cache write must cause EXACTLY ONE.
  it("narrow-hook topology: chunk-field store flips don't re-render; a cache write re-renders exactly once", async () => {
    useViewerStore.setState({ publicId: "p-A" });
    const client = freshClient();
    let renders = 0;
    let seen: ProjectSummaries | null = null;
    function Probe() {
      renders += 1;
      seen = useSummariesData().summaries;
      return null;
    }
    render(<Probe />, { wrapper: makeWrapper(client) });
    const base = renders; // absolute mount count is harness detail; deltas are the pin
    expect(seen).toBeNull();

    // Flip BOTH chunk-loader fields the old 6-field selector subscribed to. async act flushes
    // any scheduled work so a wrong-world re-render can't hide in a pending microtask.
    await act(async () => {
      useViewerStore.getState().setChunkLoading(true);
      useViewerStore.getState().setLoadedPageRange({ from: 1, to: 15 });
    });
    expect(useViewerStore.getState().chunkLoading).toBe(true); // the flips really landed
    expect(useViewerStore.getState().loadedPageRange).toEqual({ from: 1, to: 15 });
    expect(renders).toBe(base); // ZERO re-renders — the narrow hook never sees chunk state

    // Control flip: a summaries cache write MUST propagate — and as ONE batched render.
    const s = summariesFixture({ allTrades: ["Topology"] });
    act(() => seedSummariesCache(client, "p-A", s));
    await waitFor(() => expect(renders).toBe(base + 1));
    expect(seen).toEqual(s); // the extra render carried the new data (not an unrelated tick)
  });

  it("useSummaries facade returns the old 6-field selector shape; chunk pair stays zustand-wired", async () => {
    useViewerStore.setState({ publicId: "p-A" });
    const client = freshClient();
    const { result } = renderHook(() => useSummaries(), { wrapper: makeWrapper(client) });

    // exact old shape (viewerStore selector parity — consumers destructure these six)
    expect(result.current.summaries).toBeNull();
    expect(typeof result.current.setSummaries).toBe("function");
    expect(result.current.loadedPageRange).toBeNull();
    expect(typeof result.current.setLoadedPageRange).toBe("function");
    expect(result.current.chunkLoading).toBe(false);
    expect(typeof result.current.setChunkLoading).toBe("function");

    // chunk passthrough reads/writes the STORE (domain ⑦ — not migrated here)
    act(() => result.current.setChunkLoading(true));
    await waitFor(() => expect(result.current.chunkLoading).toBe(true));
    expect(useViewerStore.getState().chunkLoading).toBe(true);

    act(() => result.current.setLoadedPageRange({ from: 1, to: 15 }));
    await waitFor(() => expect(result.current.loadedPageRange).toEqual({ from: 1, to: 15 }));
    expect(useViewerStore.getState().loadedPageRange).toEqual({ from: 1, to: 15 });
  });
});
