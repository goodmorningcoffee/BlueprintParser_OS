// [refactor jul11 P2.2⑦ C3] RACE-2 freeze for the paired annotation/window cache boundary.
// This probe freezes the user-visible contract:
// one coherent render observes the new range + new annotations, and neither tear direction is
// allowed: new range + old annotations OR old range + new annotations. A raw Query-cache subscriber
// witnesses physical annotation-first order even if React coalesces both cache notifications.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useChunkLoader } from "@/hooks/useChunkLoader";
import type { ActivePageWindow } from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import { readAnnotations, useAnnotations } from "@/queries/useAnnotations";
import {
  readActivePageWindow,
  useKeynotesForPage,
  useLoadedPageRange,
} from "@/queries/usePageWindow";
import { readSeededAnnotations, seedAnnotations } from "@/test/seed-annotations";
import type { ClientAnnotation } from "@/types";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

let qc: QueryClient;
const fetchMock = vi.fn();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function annotation(id: number, name: string): ClientAnnotation {
  return {
    id,
    pageNumber: 20,
    name,
    bbox: [0, 0, 0.1, 0.1],
    note: null,
    source: "user",
    data: null,
  };
}

function active(overrides: Partial<ActivePageWindow> = {}): ActivePageWindow {
  return {
    loadedRange: null,
    keynotes: {},
    csiCodes: {},
    textAnnotations: {},
    pageIntelligence: {},
    ...overrides,
  };
}

function seedWindow(
  overrides: Partial<ActivePageWindow> = {},
  publicId = "pid",
): ActivePageWindow {
  const value = active(overrides);
  qc.setQueryData(queryKeys.pagesWindow.active(publicId), value);
  return value;
}

beforeEach(() => {
  qc = new QueryClient();
  resetProjectData();
  setViewerStoreStateForTest({
    publicId: "pid",
    isDemo: false,
    pageNumber: 20,
    numPages: 100,
  });
  seedWindow({
    keynotes: {
      1: [
        {
          shape: "circle",
          text: "old-keynote",
          bbox: [0, 0, 0.1, 0.1] as [number, number, number, number],
        },
      ],
    },
    csiCodes: {},
    textAnnotations: {},
    pageIntelligence: {},
  });
  seedAnnotations(qc, [annotation(1, "old-window")]);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  qc.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useChunkLoader — annotation/window publication (RACE-2)", () => {
  it("publishes a fetched range and its annotation window in one coherent render", async () => {
    const nextAnnotation = annotation(2, "new-window");
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        from: 13,
        to: 27,
        pages: [
          {
            pageNumber: 20,
            keynotes: [
              {
                shape: "circle",
                text: "new-keynote",
                bbox: [0, 0, 0.1, 0.1] as [number, number, number, number],
              },
            ],
            csiCodes: null,
            textAnnotations: null,
            pageIntelligence: null,
          },
        ],
        annotations: [nextAnnotation],
      }),
    } as Response);

    const snapshots: Array<{
      range: { from: number; to: number } | null;
      annotationIds: number[];
      keynoteTexts: string[];
    }> = [];
    const rawRangePublications: Array<{
      range: { from: number; to: number };
      annotationIds: number[];
      keynoteTexts: string[];
    }> = [];

    // React can coalesce query notifications, so render snapshots alone cannot prove physical write
    // order. At the active-key event, synchronously read the already-published annotations key.
    const activeKey = JSON.stringify(queryKeys.pagesWindow.active("pid"));
    const unsubscribeRaw = qc.getQueryCache().subscribe((event) => {
      if (event.type !== "updated") return;
      if (JSON.stringify(event.query.queryKey) !== activeKey) return;
      const window = readActivePageWindow(qc, "pid");
      const range = window.loadedRange;
      if (range?.from !== 13 || range.to !== 27) return;
      rawRangePublications.push({
        range,
        annotationIds: readSeededAnnotations(qc).map((row) => row.id),
        keynoteTexts: (window.keynotes[20] ?? []).map((row) => row.text),
      });
    });

    function Probe() {
      useChunkLoader();
      const range = useLoadedPageRange();
      const { annotations } = useAnnotations();
      const keynotes = useKeynotesForPage(20);
      snapshots.push({
        range,
        annotationIds: annotations.map((row) => row.id),
        keynoteTexts: keynotes.map((row) => row.text),
      });
      return null;
    }

    try {
      render(<Probe />, { wrapper });

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/projects/pid/pages?from=13&to=27",
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        ),
      );
      await waitFor(() =>
        expect(readActivePageWindow(qc, "pid").loadedRange).toEqual({ from: 13, to: 27 }),
      );
    } finally {
      unsubscribeRaw();
    }

    const published = snapshots.filter(
      (snapshot) => snapshot.range?.from === 13 && snapshot.range.to === 27,
    );
    expect(published).toEqual([
      {
        range: { from: 13, to: 27 },
        annotationIds: [2],
        keynoteTexts: ["new-keynote"],
      },
    ]);
    expect(
      snapshots.some(
        (snapshot) => snapshot.range?.from === 13 && snapshot.annotationIds.includes(1),
      ),
    ).toBe(false);
    expect(
      snapshots.some(
        (snapshot) => snapshot.range === null && snapshot.annotationIds.includes(2),
      ),
    ).toBe(false);

    // At the active-cache event, annotations must already expose the same fetched window.
    expect(rawRangePublications).toEqual([
      {
        range: { from: 13, to: 27 },
        annotationIds: [2],
        keynoteTexts: ["new-keynote"],
      },
    ]);
  });

  it("drops an obsolete in-flight response after a project switch", async () => {
    const response = deferred<Response>();
    fetchMock.mockReturnValueOnce(response.promise);

    function LoaderOnly() {
      useChunkLoader();
      return null;
    }

    render(<LoaderOnly />, { wrapper });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const firstSignal = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.signal;

    // Stop the new project from dispatching its own chunk request; this test isolates A's ignored-
    // signal late response. C1 reverses the old expectation: identity cleanup invalidates and aborts
    // A, and generation ownership makes its eventual settlement a total no-op.
    const projectB = [annotation(99, "project-B-sentinel")];
    act(() => {
      setViewerStoreStateForTest({ publicId: "project-B", numPages: 0 });
      seedAnnotations(qc, projectB);
    });
    expect(firstSignal?.aborted).toBe(true);

    await act(async () => {
      response.resolve({
        ok: true,
        json: async () => ({
          from: 13,
          to: 27,
          pages: [],
          annotations: [annotation(2, "late-project-A-window")],
        }),
      } as Response);
      await Promise.resolve();
    });

    expect(readAnnotations(qc, "pid").map((row) => row.id)).toEqual([1]);
    expect(readAnnotations(qc, "project-B")).toEqual(projectB);
    expect(readActivePageWindow(qc, "pid").loadedRange).toBeNull();
    expect(readActivePageWindow(qc, "pid").keynotes[20]).toBeUndefined();
    expect(readActivePageWindow(qc, "project-B").loadedRange).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retains the current annotation window when a navigation chunk fetch fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 } as Response);
    const before = readAnnotations(qc, "pid");

    function LoaderOnly() {
      useChunkLoader();
      return null;
    }

    render(<LoaderOnly />, { wrapper });

    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        "[useChunkLoader] Failed to load chunk:",
        expect.objectContaining({ message: "Chunk fetch failed: 503" }),
      ),
    );
    expect(readAnnotations(qc, "pid")).toBe(before);
    expect(readActivePageWindow(qc, "pid").loadedRange).toBeNull();
  });
});
