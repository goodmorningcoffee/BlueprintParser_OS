// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  focusManager,
  notifyManager,
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  EMPTY_ACTIVE_PAGE_WINDOW,
  type ActivePageWindow,
  type PageWindowResponse,
  type PageWindowResponsePage,
} from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import {
  appendKeynotesForPage,
  EMPTY_CSI_CODES_FOR_PAGE,
  EMPTY_KEYNOTES_FOR_PAGE,
  EMPTY_TEXT_ANNOTATIONS_FOR_PAGE,
  mergeKeynotesByPage,
  publishBootstrapPageWindow,
  publishNavigationPageWindow,
  readActivePageWindow,
  readCsiCodesForPage,
  readKeynotesForPage,
  readPageIntelligence,
  readTextAnnotationsForPage,
  setCsiCodesForPage,
  setKeynotesForPage,
  setPageIntelligenceForPage,
  updateKeynotesForPage,
  updatePageIntelligenceForPage,
  useCsiCodesByPage,
  useCsiCodesForPage,
  useKeynotesByPage,
  useKeynotesForPage,
  useLoadedPageRange,
  usePageIntelligenceByPage,
  usePageIntelligenceForPage,
  useTextAnnotationsByPage,
  useTextAnnotationsForPage,
} from "@/queries/usePageWindow";
import { useAnnotations } from "@/queries/useAnnotations";
import { useViewerStore } from "@/stores/viewerStore";
import type {
  ClientAnnotation,
  CsiCode,
  KeynoteShapeData,
  PageIntelligence,
  TextAnnotation,
} from "@/types";

const clients = new Set<QueryClient>();
const unexpectedFetch = vi.fn();

function freshClient(): QueryClient {
  const client = new QueryClient();
  clients.add(client);
  return client;
}

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function keynote(text: string): KeynoteShapeData {
  return { shape: "circle", text, bbox: [0, 0, 0.1, 0.1] };
}

function csi(code: string): CsiCode {
  return { code, description: code, trade: "Trade", division: "01" };
}

function textAnnotation(text: string): TextAnnotation {
  return {
    type: "general-note",
    category: "notes",
    text,
    bbox: [0, 0, 0.1, 0.1],
    confidence: 1,
    wordIndices: [],
  };
}

function annotation(id: number): ClientAnnotation {
  return {
    id,
    pageNumber: 20,
    name: `annotation-${id}`,
    bbox: [0, 0, 0.1, 0.1],
    note: null,
    source: "user",
    data: null,
  };
}

function page(
  pageNumber: number,
  overrides: Partial<PageWindowResponsePage> = {},
): PageWindowResponsePage {
  return {
    pageNumber,
    name: `Page ${pageNumber}`,
    drawingNumber: null,
    ...overrides,
  };
}

function response(
  pages: PageWindowResponsePage[],
  annotations: ClientAnnotation[] = [],
  from = 999,
  to = 1000,
): PageWindowResponse {
  return { from, to, pages, annotations };
}

function active(overrides: Partial<ActivePageWindow> = {}): ActivePageWindow {
  return {
    loadedRange: { from: 13, to: 27 },
    keynotes: {},
    csiCodes: {},
    textAnnotations: {},
    pageIntelligence: {},
    ...overrides,
  };
}

function seed(client: QueryClient, publicId: string, value: ActivePageWindow): void {
  client.setQueryData(queryKeys.pagesWindow.active(publicId), value);
}

async function flushNotifications(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function watchExplicitOuterBatch(): () => { rootCalls: number; maxDepth: number } {
  const originalBatch = notifyManager.batch.bind(notifyManager);
  let depth = 0;
  let rootCalls = 0;
  let maxDepth = 0;
  vi.spyOn(notifyManager, "batch").mockImplementation(((callback: () => unknown) => {
    if (depth === 0) rootCalls++;
    depth++;
    maxDepth = Math.max(maxDepth, depth);
    try {
      return originalBatch(callback);
    } finally {
      depth--;
    }
  }) as typeof notifyManager.batch);
  return () => ({ rootCalls, maxDepth });
}

beforeEach(() => {
  useViewerStore.getState().resetProjectData();
  useViewerStore.setState({ publicId: "A", isDemo: false, pageNumber: 20 });
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
  unexpectedFetch.mockReset();
  unexpectedFetch.mockImplementation((url: unknown) => {
    throw new Error(`unexpected fetch from dormant pagesWindow query: ${String(url)}`);
  });
  vi.stubGlobal("fetch", unexpectedFetch);
});

afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.clear();
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("pagesWindow key and dormant query contract", () => {
  it("uses one exact active key and removes the raw center-window identity", () => {
    expect(queryKeys.pagesWindow.all("A")).toEqual(["project", "A", "pagesWindow"]);
    expect(queryKeys.pagesWindow.active("A")).toEqual([
      "project",
      "A",
      "pagesWindow",
      "active",
    ]);
    expect("window" in queryKeys.pagesWindow).toBe(false);
  });

  it("starts from stable frozen sentinels with success/idle/stale∞/gc∞ and default sharing", () => {
    const client = freshClient();
    const hook = renderHook(
      () => ({
        range: useLoadedPageRange(),
        keynotes: useKeynotesForPage(20),
        csiCodes: useCsiCodesForPage(20),
        text: useTextAnnotationsForPage(20),
        intelligence: usePageIntelligenceForPage(20),
      }),
      { wrapper: wrapper(client) },
    );
    const first = hook.result.current;

    expect(first.range).toBeNull();
    expect(first.keynotes).toBe(EMPTY_KEYNOTES_FOR_PAGE);
    expect(first.csiCodes).toBe(EMPTY_CSI_CODES_FOR_PAGE);
    expect(first.text).toBe(EMPTY_TEXT_ANNOTATIONS_FOR_PAGE);
    expect(first.intelligence).toBeUndefined();
    expect(Object.isFrozen(first.keynotes)).toBe(true);
    expect(Object.isFrozen(first.csiCodes)).toBe(true);
    expect(Object.isFrozen(first.text)).toBe(true);
    hook.rerender();
    expect(hook.result.current.keynotes).toBe(first.keynotes);

    const query = client.getQueryCache().find({ queryKey: queryKeys.pagesWindow.active("A") });
    expect(query?.state.status).toBe("success");
    expect(query?.state.fetchStatus).toBe("idle");
    expect(query?.isStale()).toBe(false);
    const options = query?.options as
      | {
          enabled?: boolean;
          staleTime?: number;
          gcTime?: number;
          structuralSharing?: unknown;
          queryFn?: unknown;
        }
      | undefined;
    expect(options?.enabled).toBe(false);
    expect(options?.staleTime).toBe(Infinity);
    expect(options?.gcTime).toBe(Infinity);
    expect(options?.structuralSharing).toBeUndefined();
    expect(() => (options?.queryFn as () => unknown)()).toThrow(
      "pagesWindow is bootstrap/navigation seeded; queryFn must never run",
    );
  });

  it("never runs transport on mount, invalidation, focus, reconnect, or a second observer", async () => {
    const client = freshClient();
    seed(client, "A", active({ keynotes: { 20: [keynote("seeded")] } }));
    const first = renderHook(() => useKeynotesForPage(20), { wrapper: wrapper(client) });
    const second = renderHook(() => useLoadedPageRange(), { wrapper: wrapper(client) });

    expect(first.result.current[0].text).toBe("seeded");
    expect(second.result.current).toEqual({ from: 13, to: 27 });
    await act(async () => {
      await client.invalidateQueries({ queryKey: queryKeys.pagesWindow.all("A") });
    });
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });
    await flushNotifications();

    const query = client.getQueryCache().find({ queryKey: queryKeys.pagesWindow.active("A") });
    expect(query?.state.status).toBe("success");
    expect(query?.state.fetchStatus).toBe("idle");
    expect(unexpectedFetch).not.toHaveBeenCalled();
  });

  it("keeps an unsaved active entry through an observer-less day", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const client = freshClient();
    const pending = active({ keynotes: { 20: [keynote("unsaved") ] } });
    seed(client, "A", pending);
    const first = renderHook(() => useKeynotesForPage(20), { wrapper: wrapper(client) });
    expect(first.result.current[0].text).toBe("unsaved");
    first.unmount();

    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(readActivePageWindow(client, "A").keynotes[20]).toEqual([keynote("unsaved")]);
  });
});

describe("narrow and whole-map observers", () => {
  it("returns all four seeded current-page values and switches cleanly between publicIds", async () => {
    const client = freshClient();
    const intelA: PageIntelligence = { rejectedTextRegionIds: ["A"] };
    const intelB: PageIntelligence = { rejectedTextRegionIds: ["B"] };
    seed(client, "A", active({
      keynotes: { 20: [keynote("A")] },
      csiCodes: { 20: [csi("A")] },
      textAnnotations: { 20: [textAnnotation("A")] },
      pageIntelligence: { 20: intelA },
    }));
    seed(client, "B", active({
      keynotes: { 20: [keynote("B")] },
      csiCodes: { 20: [csi("B")] },
      textAnnotations: { 20: [textAnnotation("B")] },
      pageIntelligence: { 20: intelB },
    }));

    const hook = renderHook(
      () => ({
        keynotes: useKeynotesForPage(20),
        csiCodes: useCsiCodesForPage(20),
        text: useTextAnnotationsForPage(20),
        intelligence: usePageIntelligenceForPage(20),
      }),
      { wrapper: wrapper(client) },
    );
    expect(hook.result.current.keynotes[0].text).toBe("A");
    expect(hook.result.current.csiCodes[0].code).toBe("A");
    expect(hook.result.current.text[0].text).toBe("A");
    expect(hook.result.current.intelligence).toBe(intelA);

    act(() => useViewerStore.setState({ publicId: "B" }));
    await waitFor(() => expect(hook.result.current.keynotes[0].text).toBe("B"));
    expect(hook.result.current.csiCodes[0].code).toBe("B");
    expect(hook.result.current.text[0].text).toBe("B");
    // QueryObserver applies structural sharing across its A→B selected result transition. The value
    // is B's data; cross-key object identity itself is not part of the facade contract.
    expect(hook.result.current.intelligence).toEqual(intelB);
  });

  it("does not rerender a current-page keynote observer for other pages or maps", async () => {
    const client = freshClient();
    const page20 = [keynote("page-20")];
    seed(client, "A", active({ keynotes: { 20: page20 } }));
    let renders = 0;
    const hook = renderHook(
      () => {
        renders++;
        return useKeynotesForPage(20);
      },
      { wrapper: wrapper(client) },
    );
    const baseline = renders;

    act(() => {
      setKeynotesForPage(client, "A", 21, [keynote("other-page")]);
      setCsiCodesForPage(client, "A", 20, [csi("other-map")]);
      setPageIntelligenceForPage(client, "A", 20, { rejectedTextRegionIds: ["other-map"] });
    });
    await flushNotifications();
    expect(renders).toBe(baseline);
    expect(hook.result.current).toBe(page20);

    act(() => setKeynotesForPage(client, "A", 20, [keynote("changed") ]));
    await waitFor(() => expect(hook.result.current[0].text).toBe("changed"));
    expect(renders).toBe(baseline + 1);
  });

  it("whole-map hooks observe only their named collection", async () => {
    const client = freshClient();
    seed(client, "A", active());
    let keynoteRenders = 0;
    let csiRenders = 0;
    const keynotes = renderHook(() => {
      keynoteRenders++;
      return useKeynotesByPage();
    }, { wrapper: wrapper(client) });
    const codes = renderHook(() => {
      csiRenders++;
      return useCsiCodesByPage();
    }, { wrapper: wrapper(client) });
    const keynoteBaseline = keynoteRenders;
    const csiBaseline = csiRenders;

    act(() => setKeynotesForPage(client, "A", 20, [keynote("K") ]));
    await waitFor(() => expect(keynotes.result.current[20]?.[0].text).toBe("K"));
    expect(keynoteRenders).toBe(keynoteBaseline + 1);
    expect(csiRenders).toBe(csiBaseline);

    act(() => setCsiCodesForPage(client, "A", 20, [csi("C") ]));
    await waitFor(() => expect(codes.result.current[20]?.[0].code).toBe("C"));
    expect(keynoteRenders).toBe(keynoteBaseline + 1);
    expect(csiRenders).toBe(csiBaseline + 1);
  });

  it("exposes stable whole-map selectors for text annotations and page intelligence", () => {
    const client = freshClient();
    const textMap = { 20: [textAnnotation("T")] };
    const piMap = { 20: { rejectedTextRegionIds: ["P"] } };
    seed(client, "A", active({ textAnnotations: textMap, pageIntelligence: piMap }));

    const hook = renderHook(
      () => ({ text: useTextAnnotationsByPage(), pi: usePageIntelligenceByPage() }),
      { wrapper: wrapper(client) },
    );
    expect(hook.result.current.text).toBe(textMap);
    expect(hook.result.current.pi).toBe(piMap);
  });
});

describe("imperative readers and semantic writers", () => {
  it("returns stable absent sentinels without creating an observer", () => {
    const client = freshClient();
    expect(readActivePageWindow(client, "missing")).toBe(EMPTY_ACTIVE_PAGE_WINDOW);
    expect(readKeynotesForPage(client, "missing", 1)).toBe(EMPTY_KEYNOTES_FOR_PAGE);
    expect(readCsiCodesForPage(client, "missing", 1)).toBe(EMPTY_CSI_CODES_FOR_PAGE);
    expect(readTextAnnotationsForPage(client, "missing", 1)).toBe(
      EMPTY_TEXT_ANNOTATIONS_FOR_PAGE,
    );
    expect(readPageIntelligence(client, "missing", 1)).toBeUndefined();
    expect(client.getQueryCache().find({ queryKey: queryKeys.pagesWindow.active("missing") }))
      .toBeUndefined();
  });

  it("keynote replace/live-update/append compose against the latest page value", () => {
    const client = freshClient();
    seed(client, "A", active({ keynotes: { 20: [keynote("first")] } }));

    const replacement = [keynote("replacement")];
    setKeynotesForPage(client, "A", 20, replacement);
    updateKeynotesForPage(client, "A", 20, (current) => [...current, keynote("updated")]);
    appendKeynotesForPage(client, "A", 20, [keynote("appended")]);

    expect(readKeynotesForPage(client, "A", 20).map((row) => row.text)).toEqual([
      "replacement",
      "updated",
      "appended",
    ]);
  });

  it("batch-merges keynotes without trimming scan-all pages and preserves other maps", () => {
    const client = freshClient();
    const codes = { 20: [csi("stable")] };
    const text = { 20: [textAnnotation("stable")] };
    const intelligence = { 20: { rejectedTextRegionIds: ["stable"] } };
    const priorPage = [keynote("prior-page")];
    const before = active({
      keynotes: { 99: priorPage },
      csiCodes: codes,
      textAnnotations: text,
      pageIntelligence: intelligence,
    });
    seed(client, "A", before);
    const updates = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [index + 1, [keynote(`K${index + 1}`)]]),
    );

    mergeKeynotesByPage(client, "A", updates);
    const after = readActivePageWindow(client, "A");

    expect(Object.keys(after.keynotes)).toHaveLength(31);
    expect(after.keynotes[99]).toBe(priorPage);
    expect(after.csiCodes).toBe(codes);
    expect(after.textAnnotations).toBe(text);
    expect(after.pageIntelligence).toBe(intelligence);
    expect(after.loadedRange).toBe(before.loadedRange);
  });

  it("CSI replacement and PI replacement/updater preserve unrelated collection references", () => {
    const client = freshClient();
    const keynotes = { 20: [keynote("stable")] };
    const text = { 20: [textAnnotation("stable")] };
    seed(client, "A", active({
      keynotes,
      textAnnotations: text,
      pageIntelligence: { 20: { csiSpatialMap: null } },
    }));

    const codes = [csi("new")];
    setCsiCodesForPage(client, "A", 20, codes);
    const pi: PageIntelligence = { rejectedTextRegionIds: ["one"] };
    setPageIntelligenceForPage(client, "A", 20, pi);
    updatePageIntelligenceForPage(client, "A", 20, (current) => ({
      ...current,
      rejectedTextRegionIds: [...(current?.rejectedTextRegionIds ?? []), "two"],
    }));

    const after = readActivePageWindow(client, "A");
    expect(after.csiCodes[20]).toBe(codes);
    expect(after.pageIntelligence[20]?.rejectedTextRegionIds).toEqual(["one", "two"]);
    // Whole-page replacement is intentional. A deep-merge mutant would retain this old field.
    expect(Object.hasOwn(after.pageIntelligence[20], "csiSpatialMap")).toBe(false);
    expect(after.keynotes).toBe(keynotes);
    expect(after.textAnnotations).toBe(text);
  });

  it("writes only the explicitly passed publicId", () => {
    const client = freshClient();
    seed(client, "A", active({ keynotes: { 20: [keynote("A")] } }));
    seed(client, "B", active({ keynotes: { 20: [keynote("B")] } }));
    useViewerStore.setState({ publicId: "B" });

    setKeynotesForPage(client, "A", 20, [keynote("A-new")]);

    expect(readKeynotesForPage(client, "A", 20)[0].text).toBe("A-new");
    expect(readKeynotesForPage(client, "B", 20)[0].text).toBe("B");
  });
});

describe("paired bootstrap/navigation publication", () => {
  it("bootstrap publishes annotations physically first, active second, inside an outer batch", () => {
    const client = freshClient();
    const events: string[] = [];
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (event.type === "updated") events.push(JSON.stringify(event.query.queryKey));
    });

    const batchProfile = watchExplicitOuterBatch();

    const annotations = [annotation(2)];
    try {
      publishBootstrapPageWindow(
        client,
        "SERVER-ID",
        response([page(3, { keynotes: [keynote("K")] }), page(9)], annotations),
        100,
      );
    } finally {
      unsubscribe();
    }

    expect(events).toEqual([
      JSON.stringify(queryKeys.annotations.all("SERVER-ID")),
      JSON.stringify(queryKeys.pagesWindow.active("SERVER-ID")),
    ]);
    // Exactly one root batch wraps both writes; each setQueryData's internal notification batch is
    // therefore nested. Removing the explicit outer batch yields multiple roots and depth 1.
    expect(batchProfile().rootCalls).toBe(1);
    expect(batchProfile().maxDepth).toBeGreaterThan(1);
    expect(client.getQueryData(queryKeys.annotations.all("SERVER-ID"))).toEqual(annotations);
    expect(readActivePageWindow(client, "SERVER-ID").loadedRange).toEqual({ from: 1, to: 9 });
    expect(readKeynotesForPage(client, "SERVER-ID", 3)[0].text).toBe("K");
  });

  it("bootstrap null clears both same-project entries and leaves another project untouched", () => {
    const client = freshClient();
    client.setQueryData(queryKeys.annotations.all("A"), [annotation(1)]);
    seed(client, "A", active({ keynotes: { 20: [keynote("stale")] } }));
    const bAnnotations = [annotation(99)];
    client.setQueryData(queryKeys.annotations.all("B"), bAnnotations);
    const bWindow = active({ keynotes: { 20: [keynote("B")] } });
    seed(client, "B", bWindow);

    publishBootstrapPageWindow(client, "A", null, 100);

    expect(client.getQueryData(queryKeys.annotations.all("A"))).toEqual([]);
    // TanStack structurally shares against A's previous non-empty entry, so an explicit clear is
    // value-equal to the stable sentinel but need not reuse the sentinel's top-level identity.
    expect(readActivePageWindow(client, "A")).toEqual(EMPTY_ACTIVE_PAGE_WINDOW);
    expect(client.getQueryData(queryKeys.annotations.all("B"))).toEqual(bAnnotations);
    expect(readActivePageWindow(client, "B")).toBe(bWindow);
  });

  it("navigation replaces exact annotations and functionally merges the response-time active value", () => {
    const client = freshClient();
    const dispatchSnapshot = active({ keynotes: { 10: [keynote("dispatch-old")] } });
    seed(client, "A", dispatchSnapshot);
    client.setQueryData(queryKeys.annotations.all("A"), [annotation(1)]);

    // Concurrent retained-page write after transport dispatch, before response publication.
    setKeynotesForPage(client, "A", 10, [keynote("live-interleave")]);
    const incomingAnnotations = [annotation(2)];
    const events: string[] = [];
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (event.type === "updated") events.push(JSON.stringify(event.query.queryKey));
    });
    const batchProfile = watchExplicitOuterBatch();
    const isCurrent = vi.fn(() => true);
    const published = publishNavigationPageWindow(
      client,
      "A",
      response([page(20, { keynotes: [keynote("server-covered")] })], incomingAnnotations, 1, 2),
      { actualFrom: 13, actualTo: 27, isCurrent },
    );
    unsubscribe();

    expect(published).toBe(true);
    expect(isCurrent).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      JSON.stringify(queryKeys.annotations.all("A")),
      JSON.stringify(queryKeys.pagesWindow.active("A")),
    ]);
    expect(batchProfile().rootCalls).toBe(1);
    expect(batchProfile().maxDepth).toBeGreaterThan(1);
    expect(client.getQueryData(queryKeys.annotations.all("A"))).toEqual(incomingAnnotations);
    const window = readActivePageWindow(client, "A");
    expect(window.loadedRange).toEqual({ from: 13, to: 27 });
    expect(window.keynotes[10]?.[0].text).toBe("live-interleave");
    expect(window.keynotes[20]?.[0].text).toBe("server-covered");
  });

  it("checks generation once before the first write and makes a stale publication a total no-op", () => {
    const client = freshClient();
    const oldAnnotations = [annotation(1)];
    const oldWindow = active({ keynotes: { 20: [keynote("old")] } });
    client.setQueryData(queryKeys.annotations.all("A"), oldAnnotations);
    seed(client, "A", oldWindow);
    const isCurrent = vi.fn(() => false);

    const published = publishNavigationPageWindow(
      client,
      "A",
      response([page(20, { keynotes: [keynote("stale")] })], [annotation(2)]),
      { actualFrom: 13, actualTo: 27, isCurrent },
    );

    expect(published).toBe(false);
    expect(isCurrent).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(queryKeys.annotations.all("A"))).toBe(oldAnnotations);
    expect(readActivePageWindow(client, "A")).toBe(oldWindow);
  });

  it("normalizes before the first write so mapper failure cannot split the paired caches", () => {
    const client = freshClient();
    const oldAnnotations = [annotation(1)];
    const oldWindow = active({ keynotes: { 20: [keynote("old")] } });
    client.setQueryData(queryKeys.annotations.all("A"), oldAnnotations);
    seed(client, "A", oldWindow);
    const malformedPage = page(20);
    Object.defineProperty(malformedPage, "keynotes", {
      enumerable: true,
      get() {
        throw new Error("malformed-row");
      },
    });

    expect(() =>
      publishNavigationPageWindow(
        client,
        "A",
        response([malformedPage], [annotation(2)]),
        { actualFrom: 13, actualTo: 27, isCurrent: () => true },
      ),
    ).toThrow("malformed-row");
    expect(client.getQueryData(queryKeys.annotations.all("A"))).toBe(oldAnnotations);
    expect(readActivePageWindow(client, "A")).toBe(oldWindow);
  });

  it("walks stateful wire getters exactly once before publishing either cache", () => {
    const client = freshClient();
    client.setQueryData(queryKeys.annotations.all("A"), [annotation(1)]);
    seed(client, "A", active());
    const statefulPage = page(20);
    const serverKeynotes = [keynote("single-walk")];
    let getterReads = 0;
    Object.defineProperty(statefulPage, "keynotes", {
      enumerable: true,
      get() {
        getterReads++;
        if (getterReads > 1) throw new Error("wire-walked-twice");
        return serverKeynotes;
      },
    });
    const isCurrent = vi.fn(() => true);

    expect(
      publishNavigationPageWindow(
        client,
        "A",
        response([statefulPage], [annotation(2)]),
        { actualFrom: 13, actualTo: 27, isCurrent },
      ),
    ).toBe(true);

    expect(isCurrent).toHaveBeenCalledTimes(1);
    expect(getterReads).toBe(1);
    expect(client.getQueryData(queryKeys.annotations.all("A"))).toEqual([annotation(2)]);
    expect(readKeynotesForPage(client, "A", 20)).toBe(serverKeynotes);
  });

  it("produces one coherent React observation of the paired navigation values", async () => {
    const client = freshClient();
    client.setQueryData(queryKeys.annotations.all("A"), [annotation(1)]);
    seed(client, "A", active({ loadedRange: { from: 1, to: 15 } }));
    const snapshots: Array<{ range: string; ids: number[] }> = [];
    const hook = renderHook(() => {
      const range = useLoadedPageRange();
      const { annotations } = useAnnotations();
      const snapshot = {
        range: range ? `${range.from}-${range.to}` : "null",
        ids: annotations.map((row) => row.id),
      };
      snapshots.push(snapshot);
      return snapshot;
    }, { wrapper: wrapper(client) });
    expect(hook.result.current).toEqual({ range: "1-15", ids: [1] });

    act(() => {
      publishNavigationPageWindow(client, "A", response([], [annotation(2)]), {
        actualFrom: 43,
        actualTo: 57,
        isCurrent: () => true,
      });
    });
    await waitFor(() => expect(hook.result.current).toEqual({ range: "43-57", ids: [2] }));

    expect(snapshots.some((snapshot) => snapshot.range === "43-57" && snapshot.ids[0] === 1))
      .toBe(false);
    expect(snapshots.some((snapshot) => snapshot.range === "1-15" && snapshot.ids[0] === 2))
      .toBe(false);
  });
});
