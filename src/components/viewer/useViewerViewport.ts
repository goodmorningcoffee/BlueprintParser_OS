"use client";

// [uifix 2026-10-28] PDFViewer's two viewport hooks, kept out of PDFViewer.tsx (topology-pinned, near its
// line ceiling):
//   useZoomAnchorReapply      re-applies a wheel-zoom anchor once the page element has actually resized
//                             (a layout effect on the scale commit, plus a ResizeObserver for a late resize);
//   useHighlightViewportFocus runs the viewportFocus sequence for each llmHighlight request (fit: true zooms).

import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { LlmHighlight } from "@/stores/uiStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { anchorCorrection, reachedExpectedWidth, type ZoomAnchor } from "./viewerZoomAnchor";
import { runViewportFocus, type ViewportFocusEnv } from "./viewportFocus";

/** An armed anchor expires after this long, so an unrelated later resize can never apply it. */
export const ANCHOR_TTL_MS = 1000;

interface ArmedAnchor {
  anchor: ZoomAnchor;
  expectedWidth: number;
  armedAt: number;
}

export function useZoomAnchorReapply(
  containerRef: RefObject<HTMLDivElement | null>,
  pageRef: RefObject<HTMLDivElement | null>,
  scale: number,
): (anchor: ZoomAnchor | null, expectedWidth: number) => void {
  const armedRef = useRef<ArmedAnchor | null>(null);

  const apply = useCallback(() => {
    const armed = armedRef.current;
    const container = containerRef.current;
    const page = pageRef.current;
    if (!armed || !container || !page) return;
    if (performance.now() - armed.armedAt > ANCHOR_TTL_MS) {
      armedRef.current = null;
      return;
    }
    const pageRect = page.getBoundingClientRect();
    if (!reachedExpectedWidth(pageRect.width, armed.expectedWidth)) return;
    armedRef.current = null;
    const { dx, dy } = anchorCorrection(armed.anchor, pageRect, container.getBoundingClientRect());
    if (dx !== 0) container.scrollLeft += dx;
    if (dy !== 0) container.scrollTop += dy;
  }, [containerRef, pageRef]);

  // The page's displayed size follows `scale` in the same commit (PDFPage derives it from the prop), so this
  // normally lands before paint.
  useLayoutEffect(() => {
    apply();
  }, [scale, apply]);

  useEffect(() => {
    const page = pageRef.current;
    if (!page || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => apply());
    observer.observe(page);
    return () => observer.disconnect();
  }, [pageRef, apply]);

  return useCallback((anchor, expectedWidth) => {
    armedRef.current = anchor ? { anchor, expectedWidth, armedAt: performance.now() } : null;
  }, []);
}

/** User input inside the viewer that ends a running focus (the user has taken over the viewport). */
const INTERACTION_EVENTS = ["wheel", "pointerdown", "touchstart"] as const;

export function useHighlightViewportFocus(
  containerRef: RefObject<HTMLDivElement | null>,
  pageRef: RefObject<HTMLDivElement | null>,
  highlight: LlmHighlight | null,
): void {
  // Keyed on the request object: every setLlmHighlight call is a new object, so a re-click re-fires, while
  // zooming or a pageDimensions update no longer re-scrolls an old highlight.
  useEffect(() => {
    if (!highlight) return;
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let interacted = false;
    const onInteract = (e: Event) => {
      if (e.target instanceof Node && container.contains(e.target)) interacted = true;
    };
    for (const type of INTERACTION_EVENTS) document.addEventListener(type, onInteract, { capture: true, passive: true });
    const env: ViewportFocusEnv = {
      nextFrame: () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      now: () => performance.now(),
      cancelled: () => cancelled,
      userInteracted: () => interacted,
      currentPage: () => useViewerCoreStore.getState().pageNumber,
      pageDimensions: (page) => useViewerCoreStore.getState().pageDimensions[page] ?? null,
      pageRect: () => pageRef.current?.getBoundingClientRect() ?? null,
      canvasHidden: () =>
        pageRef.current?.querySelector<HTMLCanvasElement>("canvas[data-page-canvas]")?.style.opacity === "0",
      viewportRect: () => container.getBoundingClientRect(),
      viewportSize: () => ({ width: container.clientWidth, height: container.clientHeight }),
      getScale: () => useViewerCoreStore.getState().scale,
      setScale: (scale) => useViewerCoreStore.getState().setScale(scale),
      scrollBy: (dx, dy) => {
        container.scrollLeft += dx;
        container.scrollTop += dy;
      },
    };
    const request = { pageNumber: highlight.pageNumber, bbox: highlight.bbox, fit: highlight.fit === true };
    void runViewportFocus(env, request).finally(() => {
      for (const type of INTERACTION_EVENTS) document.removeEventListener(type, onInteract, { capture: true });
    });
    return () => {
      cancelled = true;
      for (const type of INTERACTION_EVENTS) document.removeEventListener(type, onInteract, { capture: true });
    };
  }, [highlight, containerRef, pageRef]);
}
