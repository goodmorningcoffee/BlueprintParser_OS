import { useEffect, useRef } from "react";
import { useViewerStore } from "@/stores/viewerStore";
import type { KeynoteData, CsiCode, ClientAnnotation, ScaleCalibrationData } from "@/types";

const CHUNK_RADIUS = 4; // current page ± 4 = 9-page window
const EVICTION_BUFFER = 4; // keep extra pages beyond chunk before evicting

interface ChunkResponse {
  from: number;
  to: number;
  pages: Array<{
    pageNumber: number;
    keynotes: KeynoteData[] | null;
    csiCodes: CsiCode[] | null;
    textAnnotations: unknown | null;
    pageIntelligence: unknown | null;
  }>;
  annotations: ClientAnnotation[];
}

/**
 * Sliding-window chunk loader. On page change, fetches new page data
 * if the current page is outside the loaded range.
 *
 * Wire this into PDFViewer or the project page component.
 */
export function useChunkLoader() {
  const pageNumber = useViewerStore((s) => s.pageNumber);
  const numPages = useViewerStore((s) => s.numPages);
  const publicId = useViewerStore((s) => s.publicId);
  const isDemo = useViewerStore((s) => s.isDemo);
  const loadedPageRange = useViewerStore((s) => s.loadedPageRange);
  const chunkLoading = useViewerStore((s) => s.chunkLoading);

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!publicId || numPages === 0 || chunkLoading) return;

    // Check if current page is within loaded range
    if (loadedPageRange && pageNumber >= loadedPageRange.from && pageNumber <= loadedPageRange.to) {
      return; // Already loaded
    }

    // Compute target chunk range
    const from = Math.max(1, pageNumber - CHUNK_RADIUS);
    const to = Math.min(numPages, pageNumber + CHUNK_RADIUS);

    // Abort any in-flight request
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const store = useViewerStore.getState();
    store.setChunkLoading(true);

    const endpoint = isDemo
      ? `/api/demo/projects/${publicId}/pages?from=${from}&to=${to}`
      : `/api/projects/${publicId}/pages?from=${from}&to=${to}`;

    fetch(endpoint, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`Chunk fetch failed: ${res.status}`);
        return res.json() as Promise<ChunkResponse>;
      })
      .then((chunk) => {
        const keynoteMap: Record<number, KeynoteData[]> = {};
        const csiMap: Record<number, CsiCode[]> = {};
        const textAnnMap: Record<number, any[]> = {};
        const intelMap: Record<number, any> = {};

        for (const page of chunk.pages) {
          if (page.keynotes) keynoteMap[page.pageNumber] = page.keynotes as KeynoteData[];
          if (page.csiCodes) csiMap[page.pageNumber] = page.csiCodes as CsiCode[];
          if (page.textAnnotations) {
            const result = page.textAnnotations as any;
            textAnnMap[page.pageNumber] = result.annotations || [];
          }
          if (page.pageIntelligence) intelMap[page.pageNumber] = page.pageIntelligence;
        }

        // Evict pages outside [from - buffer, to + buffer] to bound memory
        const evictFrom = from - EVICTION_BUFFER;
        const evictTo = to + EVICTION_BUFFER;
        const currentState = useViewerStore.getState();

        const evict = <T>(record: Record<number, T>): Record<number, T> => {
          const result: Record<number, T> = {};
          for (const [key, val] of Object.entries(record)) {
            const pn = Number(key);
            if (pn >= evictFrom && pn <= evictTo) result[pn] = val;
          }
          return result;
        };

        // Merge new chunk data with retained pages
        useViewerStore.setState(() => ({
          keynotes: { ...evict(currentState.keynotes), ...keynoteMap },
          csiCodes: { ...evict(currentState.csiCodes), ...csiMap },
          textAnnotations: { ...evict(currentState.textAnnotations), ...textAnnMap },
          pageIntelligence: { ...evict(currentState.pageIntelligence), ...intelMap },
          annotations: chunk.annotations,
          loadedPageRange: { from, to },
          chunkLoading: false,
        }));

        // Hydrate scale calibrations from new chunk
        for (const ann of chunk.annotations) {
          if (ann.source === "takeoff-scale" && (ann.data as any)?.type === "scale-calibration") {
            useViewerStore.getState().setScaleCalibration(ann.pageNumber, ann.data as unknown as ScaleCalibrationData);
          }
        }
      })
      .catch((err) => {
        if (err.name !== "AbortError") {
          console.error("[useChunkLoader] Failed to load chunk:", err);
        }
        useViewerStore.getState().setChunkLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [pageNumber, numPages, publicId, isDemo, loadedPageRange, chunkLoading]);
}
