// [refactor jul11 P2.2⑦ C1] Navigation state-machine freeze (SPEC N1-N10).
//
// These tests intentionally exercise the pre-backing Zustand maps. C1 fixes request ownership and
// response-time merging before C3 moves the same behavior behind the pagesWindow cache facade.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useChunkLoader } from "@/hooks/useChunkLoader";
import { readAnnotations } from "@/queries/useAnnotations";
import { useViewerStore } from "@/stores/viewerStore";
import { seedAnnotations } from "@/test/seed-annotations";
import type { ClientAnnotation, CsiCode, KeynoteShapeData, TextAnnotation } from "@/types";

interface TestChunk {
  from: number;
  to: number;
  pages: Array<{
    pageNumber: number;
    keynotes: KeynoteShapeData[] | null;
    csiCodes: CsiCode[] | null;
    textAnnotations: { annotations?: TextAnnotation[]; summary?: unknown } | null;
    pageIntelligence: Record<string, unknown> | null;
  }>;
  annotations: ClientAnnotation[];
}

let qc: QueryClient;
const fetchMock = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function LoaderOnly() {
  useChunkLoader();
  return null;
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

function keynote(text: string): KeynoteShapeData {
  return {
    shape: "circle",
    text,
    bbox: [0, 0, 0.1, 0.1],
  };
}

function csi(code: string): CsiCode {
  return { code, description: code, trade: "Test", division: "00" };
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

function annotation(
  id: number,
  name: string,
  pageNumber = 20,
  overrides: Partial<ClientAnnotation> = {},
): ClientAnnotation {
  return {
    id,
    pageNumber,
    name,
    bbox: [0, 0, 0.1, 0.1],
    note: null,
    source: "user",
    data: null,
    ...overrides,
  };
}

function emptyChunk(overrides: Partial<TestChunk> = {}): TestChunk {
  return {
    from: 13,
    to: 27,
    pages: [],
    annotations: [],
    ...overrides,
  };
}

function okResponse(chunk: TestChunk): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(chunk),
  } as unknown as Response;
}

function signalForCall(index: number): AbortSignal {
  const init = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined;
  const signal = init?.signal;
  if (!signal) throw new Error(`fetch call ${index} had no AbortSignal`);
  return signal;
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

async function flushPromises(turns = 6): Promise<void> {
  await act(async () => {
    for (let i = 0; i < turns; i += 1) await Promise.resolve();
  });
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  qc = new QueryClient();
  useViewerStore.getState().resetProjectData();
  useViewerStore.setState({
    publicId: "pid",
    isDemo: false,
    pageNumber: 20,
    numPages: 100,
    loadedPageRange: null,
    chunkLoading: false,
    keynotes: {},
    csiCodes: {},
    textAnnotations: {},
    pageIntelligence: {},
    scaleCalibrations: {},
  });
  seedAnnotations(qc, [annotation(1, "old-window")]);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  qc.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useChunkLoader navigation freeze — N1/N2 cadence and range", () => {
  it.each([
    { page: 1, url: "/api/projects/pid/pages?from=1&to=8" },
    { page: 20, url: "/api/projects/pid/pages?from=13&to=27" },
    { page: 100, url: "/api/projects/pid/pages?from=93&to=100" },
  ])("uses radius seven with clipping at page $page", ({ page, url }) => {
    fetchMock.mockReturnValue(new Promise<Response>(() => {}));
    act(() => useViewerStore.setState({ pageNumber: page }));
    render(<LoaderOnly />, { wrapper });

    advance(100);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      url,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it.each([13, 27])("treats loaded-range endpoint %s as inclusive", (pageNumber) => {
    act(() =>
      useViewerStore.setState({
        pageNumber,
        loadedPageRange: { from: 13, to: 27 },
      }),
    );
    render(<LoaderOnly />, { wrapper });

    advance(1_000);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches a retained-map page that is outside the exact loaded range", () => {
    fetchMock.mockReturnValue(new Promise<Response>(() => {}));
    act(() =>
      useViewerStore.setState({
        pageNumber: 8,
        loadedPageRange: { from: 13, to: 27 },
        keynotes: { 8: [keynote("retained-only")] },
      }),
    );
    render(<LoaderOnly />, { wrapper });

    advance(100);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/pid/pages?from=1&to=15",
      expect.any(Object),
    );
  });

  it("is a real trailing 100ms debounce and dispatches only the latest page", () => {
    fetchMock.mockReturnValue(new Promise<Response>(() => {}));
    render(<LoaderOnly />, { wrapper });

    advance(99);
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => useViewerStore.setState({ pageNumber: 40 }));
    advance(99);
    expect(fetchMock).not.toHaveBeenCalled();

    advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/pid/pages?from=33&to=47",
      expect.any(Object),
    );
  });
});

describe("useChunkLoader navigation freeze — N3/N4 overlapping ownership", () => {
  it("leaves A live during B intent and aborts A only when B dispatches", () => {
    const a = deferred<Response>();
    const b = deferred<Response>();
    fetchMock.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    render(<LoaderOnly />, { wrapper });

    advance(100);
    const aSignal = signalForCall(0);
    expect(aSignal.aborted).toBe(false);

    act(() => useViewerStore.setState({ pageNumber: 60 }));
    advance(99);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(aSignal.aborted).toBe(false);

    advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(aSignal.aborted).toBe(true);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/projects/pid/pages?from=53&to=67",
    );
  });

  it("prevents abort-aware A catch from clearing B loading or exact-range dedupe", async () => {
    const b = deferred<Response>();
    fetchMock
      .mockImplementationOnce((_url: string, init?: RequestInit) =>
        rejectWhenAborted(init?.signal as AbortSignal),
      )
      .mockReturnValueOnce(b.promise);
    render(<LoaderOnly />, { wrapper });

    advance(100);
    act(() => useViewerStore.setState({ pageNumber: 60 }));
    advance(100);
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(useViewerStore.getState().chunkLoading).toBe(true);
    expect(signalForCall(1).aborted).toBe(false);

    // A range notification re-evaluates the same B identity. If A's catch cleared B's dedupe,
    // this schedules a third request and aborts the still-live B.
    act(() => useViewerStore.setState({ loadedPageRange: { from: 1, to: 1 } }));
    advance(100);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(signalForCall(1).aborted).toBe(false);
    expect(useViewerStore.getState().chunkLoading).toBe(true);
  });
});

describe("useChunkLoader navigation freeze — N5/N6 stale settlement", () => {
  it("gives ignored-signal late A zero effects after B dispatch", async () => {
    const a = deferred<Response>();
    const b = deferred<Response>();
    fetchMock.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    useViewerStore.setState({ keynotes: { 20: [keynote("before")] } });
    render(<LoaderOnly />, { wrapper });

    advance(100);
    act(() => useViewerStore.setState({ pageNumber: 60 }));
    advance(100);
    expect(signalForCall(0).aborted).toBe(true);

    a.resolve(
      okResponse(
        emptyChunk({
          pages: [
            {
              pageNumber: 20,
              keynotes: [keynote("late-A")],
              csiCodes: [csi("late-A")],
              textAnnotations: { annotations: [textAnnotation("late-A")] },
              pageIntelligence: { marker: "late-A" },
            },
          ],
          annotations: [
            annotation(2, "late-A-scale", 20, {
              source: "takeoff-scale",
              data: {
                type: "scale-calibration",
                point1: { x: 0, y: 0 },
                point2: { x: 1, y: 0 },
                realDistance: 10,
                unit: "ft",
              },
            }),
          ],
        }),
      ),
    );
    await flushPromises();

    expect(readAnnotations(qc, "pid").map((row) => row.id)).toEqual([1]);
    expect(useViewerStore.getState().keynotes[20]?.[0]?.text).toBe("before");
    expect(useViewerStore.getState().csiCodes[20]).toBeUndefined();
    expect(useViewerStore.getState().textAnnotations[20]).toBeUndefined();
    expect(useViewerStore.getState().pageIntelligence[20]).toBeUndefined();
    expect(useViewerStore.getState().loadedPageRange).toBeNull();
    expect(useViewerStore.getState().scaleCalibrations[20]).toBeUndefined();
    expect(useViewerStore.getState().chunkLoading).toBe(true);
  });

  it("aborts and invalidates A on project identity switch", async () => {
    const a = deferred<Response>();
    fetchMock.mockReturnValueOnce(a.promise);
    render(<LoaderOnly />, { wrapper });

    advance(100);
    const aSignal = signalForCall(0);
    act(() => {
      useViewerStore.setState({ publicId: "project-B", numPages: 0 });
      seedAnnotations(qc, [annotation(99, "project-B")]);
    });
    expect(aSignal.aborted).toBe(true);

    a.resolve(
      okResponse(
        emptyChunk({
          pages: [
            {
              pageNumber: 20,
              keynotes: [keynote("late-project-A")],
              csiCodes: null,
              textAnnotations: null,
              pageIntelligence: { marker: "late-project-A" },
            },
          ],
          annotations: [annotation(2, "late-project-A")],
        }),
      ),
    );
    await flushPromises();

    expect(readAnnotations(qc, "pid").map((row) => row.id)).toEqual([1]);
    expect(readAnnotations(qc, "project-B").map((row) => row.id)).toEqual([99]);
    expect(useViewerStore.getState().loadedPageRange).toBeNull();
    expect(useViewerStore.getState().keynotes[20]).toBeUndefined();
    expect(useViewerStore.getState().pageIntelligence[20]).toBeUndefined();
    expect(useViewerStore.getState().chunkLoading).toBe(false);
  });

  it("aborts and invalidates A on unmount, with Abort remaining silent", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = deferred<Response>();
    fetchMock.mockReturnValueOnce(a.promise);
    const view = render(<LoaderOnly />, { wrapper });

    advance(100);
    const aSignal = signalForCall(0);
    view.unmount();
    expect(aSignal.aborted).toBe(true);

    a.resolve(
      okResponse(
        emptyChunk({
          pages: [
            {
              pageNumber: 20,
              keynotes: [keynote("late-unmount")],
              csiCodes: null,
              textAnnotations: null,
              pageIntelligence: null,
            },
          ],
          annotations: [annotation(2, "late-unmount")],
        }),
      ),
    );
    await flushPromises();

    expect(consoleError).not.toHaveBeenCalled();
    expect(readAnnotations(qc, "pid").map((row) => row.id)).toEqual([1]);
    expect(useViewerStore.getState().loadedPageRange).toBeNull();
    expect(useViewerStore.getState().keynotes[20]).toBeUndefined();
    expect(useViewerStore.getState().chunkLoading).toBe(false);
  });
});

describe("useChunkLoader navigation freeze — N7 identity-aware dedupe", () => {
  it("does not dedupe the same numeric range across project or auth/demo identity", () => {
    fetchMock.mockReturnValue(new Promise<Response>(() => {}));
    render(<LoaderOnly />, { wrapper });

    advance(100);
    const firstSignal = signalForCall(0);

    act(() => useViewerStore.setState({ publicId: "project-B" }));
    expect(firstSignal.aborted).toBe(true);
    advance(100);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/projects/project-B/pages?from=13&to=27",
    );
    const secondSignal = signalForCall(1);

    act(() => useViewerStore.setState({ isDemo: true }));
    expect(secondSignal.aborted).toBe(true);
    advance(100);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      "/api/demo/projects/project-B/pages?from=13&to=27",
    );
  });
});

describe("useChunkLoader navigation freeze — N8 failure policy", () => {
  it("makes one 503 attempt, ignores focus/time, then retries only after a later trigger", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const retry = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 503 } as Response)
      .mockReturnValueOnce(retry.promise);
    const beforeAnnotations = readAnnotations(qc, "pid");
    render(<LoaderOnly />, { wrapper });

    advance(100);
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      "[useChunkLoader] Failed to load chunk:",
      expect.objectContaining({ message: "Chunk fetch failed: 503" }),
    );
    expect(readAnnotations(qc, "pid")).toBe(beforeAnnotations);
    expect(useViewerStore.getState().loadedPageRange).toBeNull();
    expect(useViewerStore.getState().chunkLoading).toBe(false);

    act(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
      vi.advanceTimersByTime(10_000);
    });
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => useViewerStore.setState({ pageNumber: 21 }));
    advance(100);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/projects/pid/pages?from=14&to=28",
    );
  });

  it.each([
    {
      label: "network rejection",
      install: () => fetchMock.mockRejectedValueOnce(new Error("offline")),
      message: "offline",
    },
    {
      label: "JSON rejection",
      install: () =>
        fetchMock.mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockRejectedValue(new Error("bad-json")),
        } as unknown as Response),
      message: "bad-json",
    },
  ])("retains data and logs one $label", async ({ install, message }) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const beforeAnnotations = readAnnotations(qc, "pid");
    useViewerStore.setState({ keynotes: { 20: [keynote("before")] } });
    install();
    render(<LoaderOnly />, { wrapper });

    advance(100);
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      "[useChunkLoader] Failed to load chunk:",
      expect.objectContaining({ message }),
    );
    expect(readAnnotations(qc, "pid")).toBe(beforeAnnotations);
    expect(useViewerStore.getState().keynotes[20]?.[0]?.text).toBe("before");
    expect(useViewerStore.getState().loadedPageRange).toBeNull();
    expect(useViewerStore.getState().chunkLoading).toBe(false);
  });
});

describe("useChunkLoader navigation freeze — N9/N10 merge and sparse adoption", () => {
  it("merges from response-time live maps with inclusive ±5 retention", async () => {
    const response = deferred<Response>();
    fetchMock.mockReturnValueOnce(response.promise);
    render(<LoaderOnly />, { wrapper });
    advance(100);

    const retainedKeynotes8 = [keynote("retained-8")];
    const retainedKeynotes32 = [keynote("retained-32")];
    const retainedCsi8 = [csi("retained-8")];
    const retainedText8 = [textAnnotation("retained-8")];
    const retainedIntel8 = { marker: "retained-8" };
    act(() =>
      useViewerStore.setState({
        keynotes: {
          7: [keynote("evict-7")],
          8: retainedKeynotes8,
          20: [keynote("covered-local")],
          32: retainedKeynotes32,
          33: [keynote("evict-33")],
        },
        csiCodes: {
          8: retainedCsi8,
          20: [csi("covered-local")],
          33: [csi("evict-33")],
        },
        textAnnotations: {
          8: retainedText8,
          20: [textAnnotation("covered-local")],
          33: [textAnnotation("evict-33")],
        },
        pageIntelligence: {
          8: retainedIntel8,
          20: { marker: "covered-local" },
          33: { marker: "evict-33" },
        } as any,
      }),
    );

    response.resolve(
      okResponse(
        emptyChunk({
          pages: [
            {
              pageNumber: 20,
              keynotes: [keynote("server")],
              csiCodes: [csi("server")],
              textAnnotations: { annotations: [textAnnotation("server")] },
              pageIntelligence: { marker: "server" },
            },
          ],
        }),
      ),
    );
    await flushPromises();

    const state = useViewerStore.getState();
    expect(state.keynotes[7]).toBeUndefined();
    expect(state.keynotes[8]).toBe(retainedKeynotes8);
    expect(state.keynotes[20]?.[0]?.text).toBe("server");
    expect(state.keynotes[32]).toBe(retainedKeynotes32);
    expect(state.keynotes[33]).toBeUndefined();
    expect(state.csiCodes[8]).toBe(retainedCsi8);
    expect(state.csiCodes[20]?.[0]?.code).toBe("server");
    expect(state.csiCodes[33]).toBeUndefined();
    expect(state.textAnnotations[8]).toBe(retainedText8);
    expect(state.textAnnotations[20]?.[0]?.text).toBe("server");
    expect(state.textAnnotations[33]).toBeUndefined();
    expect(state.pageIntelligence[8]).toBe(retainedIntel8);
    expect(state.pageIntelligence[20]).toEqual({ marker: "server" });
    expect(state.pageIntelligence[33]).toBeUndefined();
    expect(state.loadedPageRange).toEqual({ from: 13, to: 27 });
  });

  it("preserves sparse/null fields and ignores echoed response range", async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse(
        emptyChunk({
          from: 1,
          to: 2,
          pages: [
            {
              pageNumber: 20,
              keynotes: [],
              csiCodes: null,
              textAnnotations: { annotations: [] },
              pageIntelligence: {},
            },
          ],
        }),
      ),
    );
    const retainedCsi = [csi("retained-null-omission")];
    useViewerStore.setState({
      keynotes: { 20: [keynote("replaced-by-empty")] },
      csiCodes: { 20: retainedCsi },
    });
    render(<LoaderOnly />, { wrapper });

    advance(100);
    await flushPromises();

    const state = useViewerStore.getState();
    expect(state.loadedPageRange).toEqual({ from: 13, to: 27 });
    expect(state.keynotes[20]).toEqual([]);
    expect(state.csiCodes[20]).toBe(retainedCsi);
    expect(state.textAnnotations[20]).toEqual([]);
    expect(state.pageIntelligence[20]).toEqual({});
  });

  it("adopts the locally computed range even for an empty response", async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse(emptyChunk({ from: 90, to: 99, pages: [] })),
    );
    render(<LoaderOnly />, { wrapper });

    advance(100);
    await flushPromises();

    expect(useViewerStore.getState().loadedPageRange).toEqual({ from: 13, to: 27 });
  });
});
