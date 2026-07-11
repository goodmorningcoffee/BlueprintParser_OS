// [refactor jul11 P2.2⑥] RACE-2 freeze for the annotation/window seed boundary.
//
// Before C3, useChunkLoader published page-window maps, loaded range, and annotations through one
// zustand setState. C3 split only the annotations write into TanStack Query while keeping both
// writes in the same synchronous block. This probe freezes the user-visible contract:
// one coherent render observes the new range + new annotations, and neither tear direction is
// allowed: new range + old annotations OR old range + new annotations. The raw zustand subscriber
// is the stricter ordering witness from SPEC §9: at the instant the new range publishes it reads
// through the shared annotation seam, so a future `setState` followed by `setQueryData` fails even
// if React batches the two notifications into a deceptively coherent commit. The Probe now uses a
// real useAnnotations subscription and `readSeededAnnotations` owns imperative cache assertions.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useChunkLoader } from "@/hooks/useChunkLoader";
import { readAnnotations, useAnnotations } from "@/queries/useAnnotations";
import { useViewerStore } from "@/stores/viewerStore";
import { readSeededAnnotations, seedAnnotations } from "@/test/seed-annotations";
import type { ClientAnnotation } from "@/types";

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

beforeEach(() => {
  qc = new QueryClient();
  useViewerStore.getState().resetProjectData();
  useViewerStore.setState({
    publicId: "pid",
    isDemo: false,
    pageNumber: 20,
    numPages: 100,
    loadedPageRange: null,
    chunkLoading: false,
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

    // [refactor jul11 P2.2⑥] React can batch cross-store notifications, so render snapshots
    // alone cannot prove write ordering. Subscribe to the zustand half directly and, precisely
    // when it publishes the new range, synchronously read annotations through the shared C3 seam.
    // After the flip this helper reads TanStack Query; the callback/assertion remains unchanged.
    const unsubscribeRaw = useViewerStore.subscribe((state, previousState) => {
      const range = state.loadedPageRange;
      const previousRange = previousState.loadedPageRange;
      if (
        range?.from === 13 &&
        range.to === 27 &&
        (previousRange?.from !== 13 || previousRange.to !== 27)
      ) {
        rawRangePublications.push({
          range,
          annotationIds: readSeededAnnotations(qc).map((row) => row.id),
          keynoteTexts: (state.keynotes[20] ?? []).map((row) => row.text),
        });
      }
    });

    function Probe() {
      useChunkLoader();
      const range = useViewerStore((s) => s.loadedPageRange);
      // [refactor jul11 P2.2⑥] Production subscription after the backing-store flip. Keeping this
      // a real observer (not an imperative cache read) preserves the render-count half of RACE-2.
      const { annotations } = useAnnotations();
      const keynotes = useViewerStore((s) => s.keynotes);
      snapshots.push({
        range,
        annotationIds: annotations.map((row) => row.id),
        keynoteTexts: (keynotes[20] ?? []).map((row) => row.text),
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
        expect(useViewerStore.getState().loadedPageRange).toEqual({ from: 13, to: 27 }),
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

    // SPEC §9 raw-subscriber interleave pin: when the zustand range/map half notifies,
    // the shared annotation seam must ALREADY expose that same fetched window. This is exactly
    // one publication; an await or reversed write order in C3 exposes [1] here and fails loudly.
    expect(rawRangePublications).toEqual([
      {
        range: { from: 13, to: 27 },
        annotationIds: [2],
        keynoteTexts: ["new-keynote"],
      },
    ]);
  });

  it("keeps an in-flight response on its captured project key after a project switch", async () => {
    const response = deferred<Response>();
    fetchMock.mockReturnValueOnce(response.promise);

    function LoaderOnly() {
      useChunkLoader();
      return null;
    }

    render(<LoaderOnly />, { wrapper });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // Stop the new project from dispatching its own chunk request; this test isolates the old
    // request's late response. The broader pages-window global-state behavior belongs to domain ⑦.
    const projectB = [annotation(99, "project-B-sentinel")];
    act(() => {
      useViewerStore.setState({ publicId: "project-B", numPages: 0 });
      seedAnnotations(qc, projectB);
    });

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

    await waitFor(() =>
      expect(readAnnotations(qc, "pid").map((row) => row.id)).toEqual([2]),
    );
    expect(readAnnotations(qc, "project-B")).toEqual(projectB);
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
    expect(useViewerStore.getState().loadedPageRange).toBeNull();
    expect(useViewerStore.getState().chunkLoading).toBe(false);
  });
});
