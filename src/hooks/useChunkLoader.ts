import { useEffect, useRef } from "react";
import { useViewerStore } from "@/stores/viewerStore";
import type { KeynoteData, CsiCode, ClientAnnotation, ScaleCalibrationData } from "@/types";

const CHUNK_RADIUS = 7; // current page ± 7 = 15-page window (covers 11-13 visible thumbnails + buffer)
const EVICTION_BUFFER = 5; // keep extra pages beyond chunk before evicting
const DEBOUNCE_MS = 100; // debounce rapid page changes (arrow keys)

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
 * Debounced to batch rapid navigation (arrow keys).
 */
export function useChunkLoader() {
  const pageNumber = useViewerStore((s) => s.pageNumber);
  const numPages = useViewerStore((s) => s.numPages);
  const publicId = useViewerStore((s) => s.publicId);
  const isDemo = useViewerStore((s) => s.isDemo);
  const loadedPageRange = useViewerStore((s) => s.loadedPageRange);

  const abortRef = useRef<AbortController | null>(null);
  const lastRequestedRef = useRef<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!publicId || numPages === 0) return;

    // Check if current page is within loaded range
    if (loadedPageRange && pageNumber >= loadedPageRange.from && pageNumber <= loadedPageRange.to) {
      return; // Already loaded
    }

    // Compute target chunk range
    const from = Math.max(1, pageNumber - CHUNK_RADIUS);
    const to = Math.min(numPages, pageNumber + CHUNK_RADIUS);
    const rangeKey = `${from}-${to}`;

    // Skip if already requested this exact range
    if (lastRequestedRef.current === rangeKey) return;

    // Clear any pending debounce
    if (debounceRef.current) clearTimeout(debounceRef.current);

    // Debounce: wait for rapid page changes to settle
    debounceRef.current = setTimeout(() => {
      // Re-check after debounce (page may have changed again)
      const currentPage = useViewerStore.getState().pageNumber;
      const currentRange = useViewerStore.getState().loadedPageRange;
      if (currentRange && currentPage >= currentRange.from && currentPage <= currentRange.to) return;

      const actualFrom = Math.max(1, currentPage - CHUNK_RADIUS);
      const actualTo = Math.min(numPages, currentPage + CHUNK_RADIUS);
      const actualKey = `${actualFrom}-${actualTo}`;

      if (lastRequestedRef.current === actualKey) return;
      lastRequestedRef.current = actualKey;

      // Abort any in-flight request
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      useViewerStore.getState().setChunkLoading(true);

      const endpoint = isDemo
        ? `/api/demo/projects/${publicId}/pages?from=${actualFrom}&to=${actualTo}`
        : `/api/projects/${publicId}/pages?from=${actualFrom}&to=${actualTo}`;

      // Capture current store state for eviction (before async gap)
      const stateSnapshot = {
        keynotes: useViewerStore.getState().keynotes,
        csiCodes: useViewerStore.getState().csiCodes,
        textAnnotations: useViewerStore.getState().textAnnotations,
        pageIntelligence: useViewerStore.getState().pageIntelligence,
      };

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
          const evictFrom = actualFrom - EVICTION_BUFFER;
          const evictTo = actualTo + EVICTION_BUFFER;

          const evict = <T>(record: Record<number, T>): Record<number, T> => {
            const result: Record<number, T> = {};
            for (const [key, val] of Object.entries(record)) {
              const pn = Number(key);
              if (pn >= evictFrom && pn <= evictTo) result[pn] = val;
            }
            return result;
          };

          // Merge new chunk data with retained pages (using snapshot, not stale getState)
          useViewerStore.setState(() => ({
            keynotes: { ...evict(stateSnapshot.keynotes), ...keynoteMap },
            csiCodes: { ...evict(stateSnapshot.csiCodes), ...csiMap },
            textAnnotations: { ...evict(stateSnapshot.textAnnotations), ...textAnnMap },
            pageIntelligence: { ...evict(stateSnapshot.pageIntelligence), ...intelMap },
            annotations: chunk.annotations,
            loadedPageRange: { from: actualFrom, to: actualTo },
            chunkLoading: false,
          }));

          // Hydrate scale calibrations from new chunk
          for (const ann of chunk.annotations) {
            if (ann.source === "takeoff-scale" && (ann.data as any)?.type === "scale-calibration") {
              useViewerStore.getState().setScaleCalibration(
                ann.pageNumber,
                ann.data as unknown as ScaleCalibrationData
              );
            }
          }
        })
        .catch((err) => {
          if (err.name !== "AbortError") {
            console.error("[useChunkLoader] Failed to load chunk:", err);
          }
          // Reset so it can be retried
          lastRequestedRef.current = null;
          useViewerStore.getState().setChunkLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [pageNumber, numPages, publicId, isDemo, loadedPageRange]);
}
