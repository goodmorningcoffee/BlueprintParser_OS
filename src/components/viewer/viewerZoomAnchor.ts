// [uifix 2026-10-28] Wheel-zoom anchor arithmetic (pure). The viewer's scroll content is the page plus a
// CONSTANT padding (25vw sides, 50vh top/bottom), so the point under the cursor must be anchored to the PAGE,
// not to the scroll content: scaling the content offset also scaled the padding and the point drifted by
// (ratio - 1) * padding (measured 133/170 px after ten ticks at 1500x950). Rects are client (screen) rects.

import { MAX_SCALE, MIN_SCALE } from "./proposals/proposalViewport";

export interface ClientRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The page point under the cursor (u, v as fractions of the page) and where the cursor sits in the viewport. */
export interface ZoomAnchor {
  u: number;
  v: number;
  cx: number;
  cy: number;
}

/** Next scale for one wheel event: 0.5% per step for fine (trackpad) scrolls, 3% for mouse wheels. */
export function nextWheelScale(oldScale: number, deltaY: number, deltaMode: number): number {
  const isFineScroll = deltaMode === 0 && Math.abs(deltaY) < 50;
  const step = isFineScroll ? 0.995 : 0.97;
  const factor = deltaY < 0 ? 1 / step : step;
  return Math.max(MIN_SCALE, Math.min(oldScale * factor, MAX_SCALE));
}

/** Anchor for a cursor position, or null when the page has no laid-out size yet. */
export function zoomAnchorAt(
  clientX: number,
  clientY: number,
  pageRect: ClientRect | null,
  viewportRect: ClientRect,
): ZoomAnchor | null {
  if (!pageRect || !(pageRect.width > 0 && pageRect.height > 0)) return null;
  return {
    u: (clientX - pageRect.left) / pageRect.width,
    v: (clientY - pageRect.top) / pageRect.height,
    cx: clientX - viewportRect.left,
    cy: clientY - viewportRect.top,
  };
}

/**
 * Scroll position that keeps the anchor under the cursor once the page is `ratio` times its current size.
 * The page's offset inside the scroll content (pageRect.left - viewportRect.left + scrollLeft) is the padding,
 * which does not scale. Without an anchor it falls back to the content-relative formula.
 */
export function anchoredScroll(
  anchor: ZoomAnchor | null,
  pageRect: ClientRect | null,
  viewportRect: ClientRect,
  scroll: { left: number; top: number },
  ratio: number,
  cursor: { clientX: number; clientY: number },
): { left: number; top: number } {
  if (!anchor || !pageRect) {
    const cx = cursor.clientX - viewportRect.left;
    const cy = cursor.clientY - viewportRect.top;
    return { left: (cx + scroll.left) * ratio - cx, top: (cy + scroll.top) * ratio - cy };
  }
  const pageOffsetLeft = pageRect.left - viewportRect.left + scroll.left;
  const pageOffsetTop = pageRect.top - viewportRect.top + scroll.top;
  return {
    left: pageOffsetLeft + anchor.u * pageRect.width * ratio - anchor.cx,
    top: pageOffsetTop + anchor.v * pageRect.height * ratio - anchor.cy,
  };
}

/**
 * Scroll delta that puts the anchor back under the cursor, measured from the laid-out page. Used after the page
 * has actually resized, because a scroll assigned before the resize is clamped to the OLD scroll size.
 */
export function anchorCorrection(
  anchor: ZoomAnchor,
  pageRect: ClientRect,
  viewportRect: ClientRect,
): { dx: number; dy: number } {
  return {
    dx: pageRect.left + anchor.u * pageRect.width - (viewportRect.left + anchor.cx),
    dy: pageRect.top + anchor.v * pageRect.height - (viewportRect.top + anchor.cy),
  };
}

/** True when a measured page width is the width a pending zoom expects (within 1%). */
export function reachedExpectedWidth(width: number, expectedWidth: number): boolean {
  return expectedWidth > 0 && Math.abs(width - expectedWidth) <= expectedWidth * 0.01;
}
