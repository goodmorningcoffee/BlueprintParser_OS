// [refactor jul11 P2.2⑥] RACE-2 freeze for the annotation/window seed boundary.
//
// Today useChunkLoader publishes the page-window maps, loaded range, and annotations through one
// zustand setState. C3 deliberately splits only the annotations write into TanStack Query while
// keeping both writes in the same synchronous block. This probe freezes the user-visible contract:
// one coherent render observes the new range + new annotations, and neither tear direction is
// allowed: new range + old annotations OR old range + new annotations. The raw zustand subscriber
// is the stricter ordering witness from SPEC §9: at the instant the new range publishes it reads
// through the shared annotation seam, so a future `setState` followed by `setQueryData` fails even
// if React batches the two notifications into a deceptively coherent commit. C3 changes only the
// Probe's annotation subscription to useAnnotations(); `readSeededAnnotations` flips centrally.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useChunkLoader } from "@/hooks/useChunkLoader";
import { useViewerStore } from "@/stores/viewerStore";
import { readSeededAnnotations, seedAnnotations } from "@/test/seed-annotations";
import type { ClientAnnotation } from "@/types";

let qc: QueryClient;
const fetchMock = vi.fn();

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
      const annotations = useViewerStore((s) => s.annotations);
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
});
