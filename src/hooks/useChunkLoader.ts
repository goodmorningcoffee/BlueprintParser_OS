import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  publishNavigationPageWindow,
  readActivePageWindow,
  useLoadedPageRange,
} from "@/queries/usePageWindow";
import { useSessionStore } from "@/stores/sessionStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { useToolStore } from "@/stores/toolStore";
import type { PageWindowResponse } from "@/queries/pageWindowCore";
import type { ScaleCalibrationData } from "@/types";

const CHUNK_RADIUS = 7; // current page ± 7 = 15-page window (covers 11-13 visible thumbnails + buffer)
const DEBOUNCE_MS = 100; // debounce rapid page changes (arrow keys)

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
  const pageNumber = useViewerCoreStore((s) => s.pageNumber);
  const numPages = useViewerCoreStore((s) => s.numPages);
  const publicId = useSessionStore((s) => s.publicId);
  const isDemo = useSessionStore((s) => s.isDemo);
  // This is intentionally the loader's one cache observer. Range publication must reschedule the
  // state machine when a completed far-away request evicts the page the user returned to.
  const loadedPageRange = useLoadedPageRange();

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
      // Project policy and navigation now have separate owners. Read both back-to-back at the
      // original dispatch boundary; do not move either capture across an await or timer.
      const liveSession = useSessionStore.getState();
      const liveCore = useViewerCoreStore.getState();
      // Effects normally clean up first, but this synchronous identity check closes the small window
      // between an external store identity change and React running that cleanup.
      if (liveSession.publicId !== publicId || liveSession.isDemo !== isDemo) return;

      const currentPage = liveCore.pageNumber;
      // Re-read the project-keyed cache at dispatch. The range may have changed during the real
      // 100 ms debounce, and the old state machine suppressed a now-redundant request here.
      const currentRange = readActivePageWindow(queryClient, publicId).loadedRange;
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
          return res.json() as Promise<PageWindowResponse>;
        })
        .then((chunk) => {
          // Fetch mocks/transports may ignore AbortSignal. The required predicate is evaluated by
          // the paired publisher immediately before its first write; a stale response is a total
          // no-op. Normalization, annotation-first order, response-time merge, and ±5 retention are
          // centralized in the facade rather than duplicated in this transport state machine.
          const published = publishNavigationPageWindow(
            queryClient,
            publicId,
            chunk,
            {
              actualFrom,
              actualTo,
              isCurrent: isCurrentRequest,
            },
          );
          if (!published) return;

          // Scale is a store/tool piggyback, not page-window cache data. It runs only after a current
          // paired publication; stale responses can never hydrate it.
          for (const ann of chunk.annotations) {
            if (ann.source === "takeoff-scale" && (ann.data as any)?.type === "scale-calibration") {
              useToolStore.getState().setScaleCalibration(
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
