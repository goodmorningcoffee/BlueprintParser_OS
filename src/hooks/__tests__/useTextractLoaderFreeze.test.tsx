// [refactor jul11 P2.2⑧ C1] Production-driving freeze for the legacy Textract navigation loader.
// The controller/hook are real; only transport responses and the sanctioned backing seed seam are
// faked. C3 may flip seedTextract + the hook internals, but this cadence/lifetime contract remains.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TextractLoaderController from "@/components/viewer/TextractLoaderController";
import { useViewerStore } from "@/stores/viewerStore";
import { seedTextract } from "@/test/seed-textract";
import type { TextractPageData } from "@/types";

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

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

async function flushPromises(turns = 8): Promise<void> {
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
  useViewerStore.getState().resetProjectData();
  useViewerStore.setState({
    projectId: 17,
    publicId: "public-project-A",
    pageNumber: 20,
    numPages: 100,
  });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useTextractLoader C1 freeze — guard, debounce, order, and bounds", () => {
  it.each([
    { label: "missing numeric project identity", state: { projectId: 0, numPages: 100 } },
    { label: "empty project page range", state: { projectId: 17, numPages: 0 } },
  ])("is inert for $label", ({ state }) => {
    act(() => useViewerStore.setState(state));
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
    "dispatches current,+1,-1 in exact bounded order at the $label",
    ({ pageNumber, numPages, pages }) => {
      fetchMock.mockReturnValue(pendingResponse());
      act(() => useViewerStore.setState({ pageNumber, numPages }));
      render(<TextractLoaderController />, { wrapper });

      advance(199);
      expect(fetchMock).not.toHaveBeenCalled();
      advance(1);

      expect(urls()).toEqual(
        pages.map(
          (page) => `/api/pages/textract?projectId=17&pageNumber=${page}`,
        ),
      );
      const firstSignal = signalForCall(0);
      for (let index = 0; index < pages.length; index += 1) {
        expect(signalForCall(index)).toBe(firstSignal);
        expect(Object.keys(fetchMock.mock.calls[index]?.[1] as RequestInit)).toEqual([
          "signal",
        ]);
      }
    },
  );

  it("is a true trailing 200 ms debounce and dispatches only the latest page", () => {
    fetchMock.mockReturnValue(pendingResponse());
    render(<TextractLoaderController />, { wrapper });

    advance(199);
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => useViewerStore.setState({ pageNumber: 40 }));
    advance(199);
    expect(fetchMock).not.toHaveBeenCalled();
    advance(1);

    expect(urls()).toEqual([
      "/api/pages/textract?projectId=17&pageNumber=40",
      "/api/pages/textract?projectId=17&pageNumber=41",
      "/api/pages/textract?projectId=17&pageNumber=39",
    ]);
  });

  it("re-reads live store hits during dispatch, including a truthy empty object", () => {
    const currentHit = textract("already-current");
    fetchMock.mockImplementation(() => {
      // The first real request is page 21. Mutate page 19 synchronously while the production loop is
      // running; a captured map snapshot would incorrectly issue a second request for page 19.
      seedTextract(queryClient, { 19: {} as TextractPageData });
      return pendingResponse();
    });
    render(<TextractLoaderController />, { wrapper });

    advance(199);
    act(() => seedTextract(queryClient, { 20: currentHit }));
    advance(1);

    expect(urls()).toEqual([
      "/api/pages/textract?projectId=17&pageNumber=21",
    ]);
    expect(useViewerStore.getState().textractData[20]).toBe(currentHit);
    expect(useViewerStore.getState().textractData[19]).toEqual({});
  });
});

describe("useTextractLoader C1 freeze — response adoption and failure policy", () => {
  it("adopts independent out-of-order truthy responses into their exact pages", async () => {
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
    expect(useViewerStore.getState().textractData[21]).toBe(data21);
    expect(useViewerStore.getState().textractData[20]).toBeUndefined();
    expect(useViewerStore.getState().textractData[99]).toBe(sentinel);

    page19.resolve(okTextract(data19));
    await flushPromises();
    expect(useViewerStore.getState().textractData[19]).toBe(data19);
    expect(useViewerStore.getState().textractData[21]).toBe(data21);

    page20.resolve(okTextract(data20));
    await flushPromises();
    expect(useViewerStore.getState().textractData[20]).toBe(data20);
    expect(useViewerStore.getState().textractData[19]).toBe(data19);
    expect(useViewerStore.getState().textractData[21]).toBe(data21);
    expect(useViewerStore.getState().textractData[99]).toBe(sentinel);
  });

  it.each([
    { label: "null", body: { textractData: null } },
    { label: "omitted", body: {} },
  ])("keeps a $label payload absent and silent", async ({ body }) => {
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

    expect(useViewerStore.getState().textractData[1]).toBeUndefined();
    expect(useViewerStore.getState().textractData[77]).toBe(sentinel);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("does not parse or retain a non-OK response", async () => {
    const json = vi.fn();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json } as unknown as Response);
    act(() => useViewerStore.setState({ pageNumber: 1, numPages: 1 }));
    render(<TextractLoaderController />, { wrapper });

    advance(200);
    await flushPromises();

    expect(json).not.toHaveBeenCalled();
    expect(useViewerStore.getState().textractData[1]).toBeUndefined();
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
  ])("swallows a $label and leaves the page absent", async ({ install }) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    act(() => useViewerStore.setState({ pageNumber: 1, numPages: 1 }));
    install();
    render(<TextractLoaderController />, { wrapper });

    advance(200);
    await flushPromises();

    expect(useViewerStore.getState().textractData[1]).toBeUndefined();
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("does not negative-cache null, so a later navigation intent retries the page", async () => {
    fetchMock
      .mockResolvedValueOnce(okBody({ textractData: null }))
      .mockReturnValue(pendingResponse());
    act(() => useViewerStore.setState({ pageNumber: 1, numPages: 1 }));
    render(<TextractLoaderController />, { wrapper });

    advance(200);
    await flushPromises();
    expect(urls()).toEqual(["/api/pages/textract?projectId=17&pageNumber=1"]);

    act(() => useViewerStore.setState({ numPages: 2 }));
    advance(200);

    expect(urls()).toEqual([
      "/api/pages/textract?projectId=17&pageNumber=1",
      "/api/pages/textract?projectId=17&pageNumber=1",
      "/api/pages/textract?projectId=17&pageNumber=2",
    ]);
  });
});

describe("useTextractLoader C1 freeze — cancellation and lifetime", () => {
  it.each([
    {
      label: "page change",
      update: { pageNumber: 40 },
      nextFirstUrl: "/api/pages/textract?projectId=17&pageNumber=40",
    },
    {
      label: "project change",
      update: { projectId: 23 },
      nextFirstUrl: "/api/pages/textract?projectId=23&pageNumber=20",
    },
    {
      label: "page-count change",
      update: { numPages: 21 },
      nextFirstUrl: "/api/pages/textract?projectId=17&pageNumber=20",
    },
  ])("aborts every old sibling immediately on $label", ({ update, nextFirstUrl }) => {
    fetchMock.mockReturnValue(pendingResponse());
    render(<TextractLoaderController />, { wrapper });
    advance(200);

    const oldSignals = [signalForCall(0), signalForCall(1), signalForCall(2)];
    expect(oldSignals[1]).toBe(oldSignals[0]);
    expect(oldSignals[2]).toBe(oldSignals[0]);

    act(() => useViewerStore.setState(update));
    for (const signal of oldSignals) expect(signal.aborted).toBe(true);

    advance(199);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    advance(1);
    expect(fetchMock.mock.calls[3]?.[0]).toBe(nextFirstUrl);
  });

  it("silently absorbs abort-aware sibling rejections", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      rejectWhenAborted(init?.signal as AbortSignal),
    );
    render(<TextractLoaderController />, { wrapper });
    advance(200);

    act(() => useViewerStore.setState({ pageNumber: 40 }));
    await flushPromises();

    expect(useViewerStore.getState().textractData[19]).toBeUndefined();
    expect(useViewerStore.getState().textractData[20]).toBeUndefined();
    expect(useViewerStore.getState().textractData[21]).toBeUndefined();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("clears a pending timer on unmount", () => {
    fetchMock.mockReturnValue(pendingResponse());
    const view = render(<TextractLoaderController />, { wrapper });

    advance(199);
    view.unmount();
    advance(1_000);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts every dispatched sibling on unmount", () => {
    fetchMock.mockReturnValue(pendingResponse());
    const view = render(<TextractLoaderController />, { wrapper });
    advance(200);
    const signals = [signalForCall(0), signalForCall(1), signalForCall(2)];

    view.unmount();

    for (const signal of signals) expect(signal.aborted).toBe(true);
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
    expect(source).not.toContain("/api/pages/textract?projectId=");
  });
});
