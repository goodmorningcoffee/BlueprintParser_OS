import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/queries/queryKeys";
import { useViewerStore } from "@/stores/viewerStore";
import type { KeynoteShapeData, CsiCode, ClientAnnotation, ScaleCalibrationData } from "@/types";

const CHUNK_RADIUS = 7; // current page ± 7 = 15-page window (covers 11-13 visible thumbnails + buffer)
const EVICTION_BUFFER = 5; // keep extra pages beyond chunk before evicting
const DEBOUNCE_MS = 100; // debounce rapid page changes (arrow keys)

interface ChunkResponse {
  from: number;
  to: number;
  pages: Array<{
    pageNumber: number;
    keynotes: KeynoteShapeData[] | null;
    csiCodes: CsiCode[] | null;
    textAnnotations: { annotations?: any[]; summary?: any } | null;
    pageIntelligence: Record<string, any> | null;
  }>;
  annotations: ClientAnnotation[];
}

type ChunkRouteVariant = "auth" | "demo";

interface ActiveChunkRequest {
  generation: number;
  publicId: string;
  routeVariant: ChunkRouteVariant;
  from: number;
  to: number;
  identityKey: string;
  controller: AbortController;
}

function chunkRequestIdentity(
  publicId: string,
  routeVariant: ChunkRouteVariant,
  from: number,
  to: number,
): string {
  // Project + route variant are load-bearing. A plain "from-to" key caused a same-range request
  // in a newly-opened project (or after auth/demo mode changed) to be incorrectly deduplicated.
  return `${routeVariant}:${publicId}:${from}-${to}`;
}

/**
 * Sliding-window chunk loader. On page change, fetches new page data
 * if the current page is outside the loaded range.
 * Debounced to batch rapid navigation (arrow keys).
 */
export function useChunkLoader() {
  const queryClient = useQueryClient();
  const pageNumber = useViewerStore((s) => s.pageNumber);
  const numPages = useViewerStore((s) => s.numPages);
  const publicId = useViewerStore((s) => s.publicId);
  const isDemo = useViewerStore((s) => s.isDemo);
  const loadedPageRange = useViewerStore((s) => s.loadedPageRange);

  const generationRef = useRef(0);
  const activeRequestRef = useRef<ActiveChunkRequest | null>(null);
  const lastRequestedRef = useRef<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // [refactor jul11 P2.2⑦ C1] Request lifetime is project/mode scoped, not page-effect scoped.
  // Ordinary page/range effect cleanup must NOT abort an in-flight A while B is only a debounced
  // intent: the existing cadence keeps A live until B actually dispatches. Identity cleanup is the
  // stronger boundary. Invalidate/install-null BEFORE abort so an abort-aware fetch cannot let A's
  // catch clear a newer request's bookkeeping.
  useEffect(() => {
    return () => {
      const active = activeRequestRef.current;
      generationRef.current += 1;
      activeRequestRef.current = null;
      lastRequestedRef.current = null;

      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }

      active?.controller.abort();
      useViewerStore.getState().setChunkLoading(false);
    };
  }, [queryClient, publicId, isDemo]);

  useEffect(() => {
    if (!publicId || numPages === 0) return;

    const routeVariant: ChunkRouteVariant = isDemo ? "demo" : "auth";

    // Check if current page is within loaded range
    if (loadedPageRange && pageNumber >= loadedPageRange.from && pageNumber <= loadedPageRange.to) {
      return; // Already loaded
    }

    // Compute target chunk range
    const from = Math.max(1, pageNumber - CHUNK_RADIUS);
    const to = Math.min(numPages, pageNumber + CHUNK_RADIUS);
    const rangeKey = chunkRequestIdentity(publicId, routeVariant, from, to);

    // Skip if already requested this exact range
    if (lastRequestedRef.current === rangeKey) return;

    // Clear any pending debounce
    if (debounceRef.current) clearTimeout(debounceRef.current);

    // Debounce: wait for rapid page changes to settle
    const timer = setTimeout(() => {
      if (debounceRef.current === timer) debounceRef.current = null;

      // Re-check after debounce (page may have changed again)
      const liveState = useViewerStore.getState();
      // Effects normally clean up first, but this synchronous identity check closes the small window
      // between an external store identity change and React running that cleanup.
      if (liveState.publicId !== publicId || liveState.isDemo !== isDemo) return;

      const currentPage = liveState.pageNumber;
      const currentRange = liveState.loadedPageRange;
      if (currentRange && currentPage >= currentRange.from && currentPage <= currentRange.to) return;

      const actualFrom = Math.max(1, currentPage - CHUNK_RADIUS);
      const actualTo = Math.min(numPages, currentPage + CHUNK_RADIUS);
      const actualKey = chunkRequestIdentity(
        publicId,
        routeVariant,
        actualFrom,
        actualTo,
      );

      if (lastRequestedRef.current === actualKey) return;

      // [refactor jul11 P2.2⑦ C1] Install B completely BEFORE aborting A. An abort-aware A can
      // reject immediately; its settlement must already be obsolete when its catch runs.
      const previousRequest = activeRequestRef.current;
      const controller = new AbortController();
      const request: ActiveChunkRequest = {
        generation: generationRef.current + 1,
        publicId,
        routeVariant,
        from: actualFrom,
        to: actualTo,
        identityKey: actualKey,
        controller,
      };
      generationRef.current = request.generation;
      activeRequestRef.current = request;
      lastRequestedRef.current = actualKey;
      previousRequest?.controller.abort();

      useViewerStore.getState().setChunkLoading(true);

      const endpoint = isDemo
        ? `/api/demo/projects/${publicId}/pages?from=${actualFrom}&to=${actualTo}`
        : `/api/projects/${publicId}/pages?from=${actualFrom}&to=${actualTo}`;

      const isCurrentRequest = (): boolean => {
        const active = activeRequestRef.current;
        return (
          active === request &&
          generationRef.current === request.generation &&
          active.publicId === request.publicId &&
          active.routeVariant === request.routeVariant &&
          active.from === request.from &&
          active.to === request.to &&
          active.identityKey === request.identityKey
        );
      };

      fetch(endpoint, { signal: controller.signal })
        .then((res) => {
          if (!res.ok) throw new Error(`Chunk fetch failed: ${res.status}`);
          return res.json() as Promise<ChunkResponse>;
        })
        .then((chunk) => {
          // Fetch mocks/transports are allowed to ignore AbortSignal. Generation + full identity are
          // therefore the authoritative gate, checked after JSON and before the first side effect.
          if (!isCurrentRequest()) return;

          const keynoteMap: Record<number, KeynoteShapeData[]> = {};
          const csiMap: Record<number, CsiCode[]> = {};
          const textAnnMap: Record<number, any[]> = {};
          const intelMap: Record<number, any> = {};

          for (const page of chunk.pages) {
            if (page.keynotes) keynoteMap[page.pageNumber] = page.keynotes as KeynoteShapeData[];
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

          // [refactor jul11 P2.2⑥] Publish the annotation window to its project-keyed cache FIRST,
          // then publish the related pages-window maps to zustand in the SAME synchronous block.
          // NO await may appear between these writes: a split tick reopens RACE-2 and lets a render
          // observe the new range with the old annotation window (or the inverse).
          queryClient.setQueryData(
            queryKeys.annotations.all(publicId),
            chunk.annotations,
          );

          // [refactor jul11 P2.2⑦ PW-D3] Merge from response-time LIVE state. A local write made
          // after dispatch survives when retained and not supplied by this response; response fields
          // still win on covered pages, and pages outside the ±5 buffer still evict.
          useViewerStore.setState((live) => ({
            keynotes: { ...evict(live.keynotes), ...keynoteMap },
            csiCodes: { ...evict(live.csiCodes), ...csiMap },
            textAnnotations: { ...evict(live.textAnnotations), ...textAnnMap },
            pageIntelligence: { ...evict(live.pageIntelligence), ...intelMap },
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

          // Keep the successful identity in lastRequestedRef for exact-range dedupe. Only release
          // the in-flight record; identity cleanup still invalidates the monotonically increasing
          // generation on project/mode switch or unmount.
          if (isCurrentRequest()) activeRequestRef.current = null;
        })
        .catch((err: unknown) => {
          // Obsolete A settlements are total no-ops: no logging, no loading flip, and—critically—no
          // dedupe reset that could duplicate/abort the still-active B request.
          if (!isCurrentRequest()) return;

          activeRequestRef.current = null;
          lastRequestedRef.current = null;
          if ((err as { name?: unknown })?.name !== "AbortError") {
            console.error("[useChunkLoader] Failed to load chunk:", err);
          }
          // Reset so it can be retried
          useViewerStore.getState().setChunkLoading(false);
        });
    }, DEBOUNCE_MS);
    debounceRef.current = timer;

    return () => {
      // Page/range changes cancel only the pending intent. They deliberately do not abort the active
      // transport; B dispatch or the separate identity cleanup owns abort semantics.
      clearTimeout(timer);
      if (debounceRef.current === timer) debounceRef.current = null;
    };
  }, [pageNumber, numPages, publicId, isDemo, loadedPageRange, queryClient]);
}
