// [refactor jul11 P2.2⑧ C3] Production-driving freeze for the Query-backed Textract controller.
// The controller/hook and bounded coordinator are real; only transport responses and the sanctioned
// seed seam are faked. This pins cadence, publicId provenance, exact cancellation, and retention.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TextractLoaderController from "@/components/viewer/TextractLoaderController";
import { queryKeys } from "@/queries/queryKeys";
import {
  MAX_RETAINED_TEXTRACT_PAGES,
  getTextractRetentionStats,
} from "@/queries/textractCache";
import { useViewerCoreStore as useViewerStore } from "@/stores/viewerCoreStore";
import { seedTextract } from "@/test/seed-textract";
import type { TextractPageData } from "@/types";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

let queryClient: QueryClient;
const fetchMock = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
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

function textract(label: string): TextractPageData {
  return {
    lines: [],
    words: [
      {
        text: label,
        confidence: 99,
        bbox: [0.1, 0.2, 0.3, 0.4],
      },
    ],
    tables: [],
  };
}

function okBody(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function okTextract(data: TextractPageData): Response {
  return okBody({ textractData: data });
}

function pendingResponse(): Promise<Response> {
  return new Promise<Response>(() => {});
}

function urls(): string[] {
  return fetchMock.mock.calls.map(([url]) => String(url));
}

function signalForCall(index: number): AbortSignal {
  const init = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined;
  if (!init?.signal) throw new Error(`fetch call ${index} had no AbortSignal`);
  return init.signal;
}

function cached(
  pageNumber: number,
  publicId = "public-project-A",
): TextractPageData | null | undefined {
  return queryClient.getQueryData<TextractPageData | null>(
    queryKeys.textract.page(publicId, pageNumber),
  );
}

function queryFor(pageNumber: number, publicId = "public-project-A") {
  return queryClient.getQueryCache().find({
    queryKey: queryKeys.textract.page(publicId, pageNumber),
    exact: true,
  });
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

async function flushPromises(turns = 12): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
  });
}

function abortError(): Error {
  return Object.assign(new Error("Aborted"), { name: "AbortError" });
}

function rejectWhenAborted(signal: AbortSignal): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  resetProjectData();
  setViewerStoreStateForTest({
    projectId: 17, // deliberately irrelevant after the publicId flip
    publicId: "public-project-A",
    pageNumber: 20,
    numPages: 100,
  });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  cleanup();
  await flushPromises();
  queryClient.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useTextractLoader C3 — guard, debounce, order, and bounds", () => {
  it.each([
    { label: "missing public identity", state: { publicId: "", numPages: 100 } },
    { label: "empty project page range", state: { publicId: "public-project-A", numPages: 0 } },
  ])("is inert for $label", ({ state }) => {
    act(() => setViewerStoreStateForTest(state));
    const view = render(<TextractLoaderController />, { wrapper });

    advance(1_000);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(view.container.childElementCount).toBe(0);
  });

  it.each([
    { label: "middle", pageNumber: 20, numPages: 100, pages: [20, 21, 19] },
    { label: "first", pageNumber: 1, numPages: 100, pages: [1, 2] },
    { label: "last", pageNumber: 100, numPages: 100, pages: [100, 99] },
    { label: "single-page project", pageNumber: 1, numPages: 1, pages: [1] },
  ])(
    "dispatches publicId current,+1,-1 in exact bounded order at the $label",
    ({ pageNumber, numPages, pages }) => {
      fetchMock.mockReturnValue(pendingResponse());
      act(() => useViewerStore.setState({ pageNumber, numPages }));
      render(<TextractLoaderController />, { wrapper });

      advance(199);
      expect(fetchMock).not.toHaveBeenCalled();
      advance(1);

      expect(urls()).toEqual(
        pages.map(
          (page) =>
            `/api/pages/textract?publicId=public-project-A&pageNumber=${page}`,
        ),
      );
      const signals = pages.map((_, index) => signalForCall(index));
      expect(new Set(signals).size).toBe(pages.length);
      for (let index = 0; index < pages.length; index += 1) {
        expect(fetchMock.mock.calls[index]?.[1]).toEqual({
          signal: signals[index],
          cache: "no-store",
        });
      }
      expect(getTextractRetentionStats(queryClient, "public-project-A").protectedPageNumbers)
        .toEqual(pages.slice().sort((a, b) => a - b));
    },
  );

  it("is a true trailing 200 ms debounce and dispatches only the latest live page", () => {
    fetchMock.mockReturnValue(pendingResponse());
    render(<TextractLoaderController />, { wrapper });

    advance(199);
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => useViewerStore.setState({ pageNumber: 40 }));
    advance(199);
    expect(fetchMock).not.toHaveBeenCalled();
    advance(1);

    expect(urls()).toEqual([
      "/api/pages/textract?publicId=public-project-A&pageNumber=40",
      "/api/pages/textract?publicId=public-project-A&pageNumber=41",
      "/api/pages/textract?publicId=public-project-A&pageNumber=39",
    ]);
  });

  it("re-reads live Query hits during dispatch, including a truthy empty object", () => {
    const currentHit = textract("already-current");
    fetchMock.mockImplementation(() => {
      // The first request is page 21. Mutating page 19 while the production loop is running proves
      // the next ensure consults the live Query cache rather than a captured aggregate snapshot.
      seedTextract(queryClient, { 19: {} as TextractPageData });
      return pendingResponse();
    });
    render(<TextractLoaderController />, { wrapper });

    advance(199);
    act(() => seedTextract(queryClient, { 20: currentHit }));
    advance(1);

    expect(urls()).toEqual([
      "/api/pages/textract?publicId=public-project-A&pageNumber=21",
    ]);
    expect(cached(20)).toBe(currentHit);
    expect(cached(19)).toEqual({});
  });

  it("rechecks live publicId before later siblings if identity changes synchronously", () => {
    fetchMock.mockImplementation(() => {
      setViewerStoreStateForTest({ publicId: "public-project-B" });
      return pendingResponse();
    });
    render(<TextractLoaderController />, { wrapper });

    advance(200);

    expect(urls()).toEqual([
      "/api/pages/textract?publicId=public-project-A&pageNumber=20",
    ]);
  });
});

describe("useTextractLoader C3 — response adoption and silent failure policy", () => {
  it("adopts independent out-of-order truthy responses into exact page Queries", async () => {
    const page20 = deferred<Response>();
    const page21 = deferred<Response>();
    const page19 = deferred<Response>();
    const sentinel = textract("sentinel");
    const data20 = textract("page-20");
    const data21 = textract("page-21");
    const data19 = textract("page-19");
    seedTextract(queryClient, { 99: sentinel });
    fetchMock
      .mockReturnValueOnce(page20.promise)
      .mockReturnValueOnce(page21.promise)
      .mockReturnValueOnce(page19.promise);
    render(<TextractLoaderController />, { wrapper });
    advance(200);

    page21.resolve(okTextract(data21));
    await flushPromises();
    expect(cached(21)).toBe(data21);
    expect(cached(20)).toBeUndefined();
    expect(cached(99)).toBe(sentinel);

    page19.resolve(okTextract(data19));
    await flushPromises();
    expect(cached(19)).toBe(data19);
    expect(cached(21)).toBe(data21);

    page20.resolve(okTextract(data20));
    await flushPromises();
    expect(cached(20)).toBe(data20);
    expect(cached(19)).toBe(data19);
    expect(cached(21)).toBe(data21);
    expect(cached(99)).toBe(sentinel);
  });

  it("adopts an OK truthy empty payload and does not refetch it on a later revisit", async () => {
    fetchMock
      .mockResolvedValueOnce(okBody({ textractData: {} }))
      .mockReturnValue(pendingResponse());
    act(() => useViewerStore.setState({ pageNumber: 1, numPages: 1 }));
    render(<TextractLoaderController />, { wrapper });

    advance(200);
    await flushPromises();
    expect(cached(1)).toEqual({});
    expect(urls()).toEqual([
      "/api/pages/textract?publicId=public-project-A&pageNumber=1",
    ]);

    // Leave the valid range, then revisit the same page. The truthy empty object remains a hit.
    act(() => useViewerStore.setState({ numPages: 0 }));
    await flushPromises();
    act(() => useViewerStore.setState({ numPages: 1 }));
    advance(200);
    await flushPromises();

    expect(cached(1)).toEqual({});
    expect(urls()).toEqual([
      "/api/pages/textract?publicId=public-project-A&pageNumber=1",
    ]);
  });

  it.each([
    { label: "null", body: { textractData: null } },
    { label: "omitted", body: {} },
  ])("removes a $label result shell and stays silent", async ({ body }) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const sentinel = textract("sentinel");
    act(() => {
      useViewerStore.setState({ pageNumber: 1, numPages: 1 });
      seedTextract(queryClient, { 77: sentinel });
    });
    fetchMock.mockResolvedValueOnce(okBody(body));
    render(<TextractLoaderController />, { wrapper });

    advance(200);
    await flushPromises();

    expect(cached(1)).toBeUndefined();
    expect(queryFor(1)).toBeUndefined();
    expect(cached(77)).toBe(sentinel);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("does not parse or retain a non-OK result", async () => {
    const json = vi.fn();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json } as unknown as Response);
    act(() => useViewerStore.setState({ pageNumber: 1, numPages: 1 }));
    render(<TextractLoaderController />, { wrapper });

    advance(200);
    await flushPromises();

    expect(json).not.toHaveBeenCalled();
    expect(cached(1)).toBeUndefined();
    expect(queryFor(1)).toBeUndefined();
  });

  it.each([
    {
      label: "network rejection",
      install: () => fetchMock.mockRejectedValueOnce(new Error("offline")),
    },
    {
      label: "JSON rejection",
      install: () =>
        fetchMock.mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockRejectedValue(new Error("bad-json")),
        } as unknown as Response),
    },
  ])("swallows a $label and removes the data-less shell", async ({ install }) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    act(() => useViewerStore.setState({ pageNumber: 1, numPages: 1 }));
    install();
    render(<TextractLoaderController />, { wrapper });

    advance(200);
    await flushPromises();

    expect(cached(1)).toBeUndefined();
    expect(queryFor(1)).toBeUndefined();
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("does not negative-cache null, so a later intent retries the page", async () => {
    fetchMock
      .mockResolvedValueOnce(okBody({ textractData: null }))
      .mockReturnValue(pendingResponse());
    act(() => useViewerStore.setState({ pageNumber: 1, numPages: 1 }));
    render(<TextractLoaderController />, { wrapper });

    advance(200);
    await flushPromises();
    expect(urls()).toEqual([
      "/api/pages/textract?publicId=public-project-A&pageNumber=1",
    ]);

    act(() => useViewerStore.setState({ numPages: 2 }));
    advance(200);

    expect(urls()).toEqual([
      "/api/pages/textract?publicId=public-project-A&pageNumber=1",
      "/api/pages/textract?publicId=public-project-A&pageNumber=1",
      "/api/pages/textract?publicId=public-project-A&pageNumber=2",
    ]);
  });
});

describe("useTextractLoader C3 — exact cancellation, identity, and lifetime", () => {
  it.each([
    {
      label: "page change",
      update: { pageNumber: 40 },
      nextFirstUrl: "/api/pages/textract?publicId=public-project-A&pageNumber=40",
    },
    {
      label: "project change",
      update: { publicId: "public-project-B" },
      nextFirstUrl: "/api/pages/textract?publicId=public-project-B&pageNumber=20",
    },
    {
      label: "page-count change",
      update: { numPages: 21 },
      nextFirstUrl: "/api/pages/textract?publicId=public-project-A&pageNumber=20",
    },
  ])("cancels every old exact Query immediately on $label", async ({ update, nextFirstUrl }) => {
    fetchMock.mockReturnValue(pendingResponse());
    render(<TextractLoaderController />, { wrapper });
    advance(200);

    const oldSignals = [signalForCall(0), signalForCall(1), signalForCall(2)];
    expect(new Set(oldSignals).size).toBe(3);

    act(() => setViewerStoreStateForTest(update));
    await flushPromises();
    for (const signal of oldSignals) expect(signal.aborted).toBe(true);

    advance(199);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    advance(1);
    expect(fetchMock.mock.calls[3]?.[0]).toBe(nextFirstUrl);
  });

  it("silently absorbs abort-aware exact Query rejections", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      rejectWhenAborted(init?.signal as AbortSignal),
    );
    render(<TextractLoaderController />, { wrapper });
    advance(200);

    act(() => useViewerStore.setState({ pageNumber: 40 }));
    await flushPromises();

    expect(queryFor(19)).toBeUndefined();
    expect(queryFor(20)).toBeUndefined();
    expect(queryFor(21)).toBeUndefined();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("an abort-ignoring late old-project batch cannot publish or recreate its cleared prefix", async () => {
    const page20 = deferred<Response>();
    const page21 = deferred<Response>();
    const page19 = deferred<Response>();
    fetchMock
      .mockReturnValueOnce(page20.promise)
      .mockReturnValueOnce(page21.promise)
      .mockReturnValueOnce(page19.promise)
      .mockReturnValue(pendingResponse());
    render(<TextractLoaderController />, { wrapper });
    advance(200);
    const oldSignals = [signalForCall(0), signalForCall(1), signalForCall(2)];

    act(() => setViewerStoreStateForTest({ publicId: "public-project-B" }));
    await flushPromises();
    for (const signal of oldSignals) expect(signal.aborted).toBe(true);

    page21.resolve(okTextract(textract("late-A-21")));
    page19.resolve(okTextract(textract("late-A-19")));
    page20.resolve(okTextract(textract("late-A-20")));
    await flushPromises();

    expect(
      queryClient.getQueriesData({
        queryKey: queryKeys.textract.all("public-project-A"),
      }),
    ).toEqual([]);
    expect(cached(20, "public-project-B")).toBeUndefined();

    advance(200);
    expect(fetchMock.mock.calls[3]?.[0]).toBe(
      "/api/pages/textract?publicId=public-project-B&pageNumber=20",
    );
  });

  it("clears a pending timer on unmount", () => {
    fetchMock.mockReturnValue(pendingResponse());
    const view = render(<TextractLoaderController />, { wrapper });

    advance(199);
    view.unmount();
    advance(1_000);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("unmount aborts exact siblings and clears only the captured Textract prefix", async () => {
    const aSentinel = textract("A-sentinel");
    const bSentinel = textract("B-sentinel");
    seedTextract(queryClient, { 99: aSentinel }, "public-project-A");
    seedTextract(queryClient, { 99: bSentinel }, "public-project-B");
    queryClient.setQueryData(queryKeys.chatMessages.all("public-project-A"), ["chat"]);
    fetchMock.mockReturnValue(pendingResponse());
    const view = render(<TextractLoaderController />, { wrapper });
    advance(200);
    const signals = [signalForCall(0), signalForCall(1), signalForCall(2)];

    view.unmount();
    await flushPromises();

    for (const signal of signals) expect(signal.aborted).toBe(true);
    expect(
      queryClient.getQueriesData({
        queryKey: queryKeys.textract.all("public-project-A"),
      }),
    ).toEqual([]);
    expect(cached(99, "public-project-B")).toBe(bSentinel);
    expect(queryClient.getQueryData(queryKeys.chatMessages.all("public-project-A")))
      .toEqual(["chat"]);
  });

  it("mounts the null controller before PDFViewer's error branch", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/viewer/PDFViewer.tsx"),
      "utf8",
    );
    const pageWindowController = source.indexOf("<PageWindowLoaderController />");
    const textractController = source.indexOf("<TextractLoaderController />");
    const errorBranch = source.indexOf("{error ? (");

    expect(pageWindowController).toBeGreaterThan(-1);
    expect(textractController).toBeGreaterThan(-1);
    expect(errorBranch).toBeGreaterThan(-1);
    expect(pageWindowController).toBeLessThan(errorBranch);
    expect(textractController).toBeLessThan(errorBranch);
    expect(source).not.toContain("/api/pages/textract?");
  });
});

describe("useTextractLoader C3 — bounded navigation witness", () => {
  it("plateaus at 12 retained pages, protects live N±1, and refetches an evicted revisit", async () => {
    fetchMock.mockImplementation((url: string) => {
      const pageNumber = Number(new URL(url, "http://test.local").searchParams.get("pageNumber"));
      return Promise.resolve(okTextract(textract(`page-${pageNumber}`)));
    });
    act(() => useViewerStore.setState({ pageNumber: 1, numPages: 100 }));
    render(<TextractLoaderController />, { wrapper });

    for (let pageNumber = 1; pageNumber <= 20; pageNumber += 1) {
      if (pageNumber > 1) {
        act(() => useViewerStore.setState({ pageNumber }));
      }
      advance(200);
      await flushPromises();
      expect(
        getTextractRetentionStats(queryClient, "public-project-A").retainedCount,
      ).toBeLessThanOrEqual(MAX_RETAINED_TEXTRACT_PAGES);
    }

    const plateau = getTextractRetentionStats(queryClient, "public-project-A");
    expect(plateau.retainedCount).toBe(MAX_RETAINED_TEXTRACT_PAGES);
    expect(plateau.protectedPageNumbers).toEqual([19, 20, 21]);
    expect(cached(19)).toBeDefined();
    expect(cached(20)).toBeDefined();
    expect(cached(21)).toBeDefined();
    expect(cached(1)).toBeUndefined();

    const pageOneFetchesBefore = urls().filter((url) => url.endsWith("pageNumber=1")).length;
    act(() => useViewerStore.setState({ pageNumber: 1 }));
    advance(199);
    expect(urls().filter((url) => url.endsWith("pageNumber=1"))).toHaveLength(
      pageOneFetchesBefore,
    );
    advance(1);
    await flushPromises();
    expect(urls().filter((url) => url.endsWith("pageNumber=1"))).toHaveLength(
      pageOneFetchesBefore + 1,
    );
    expect(getTextractRetentionStats(queryClient, "public-project-A").retainedCount)
      .toBeLessThanOrEqual(MAX_RETAINED_TEXTRACT_PAGES);
  });
});
