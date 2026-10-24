// [classifier-builder 2026-10-24] Zoom/pan arithmetic for proposal focus. Measured from the DOM (the page's
// displayed rect and its scroll container) rather than from the viewer's padding constants, so it stays
// right whatever padding, transform or side panel the viewer has.

import type { BboxMinMax } from "@/types";

export const MIN_SCALE = 0.2;
export const MAX_SCALE = 10;

/** Nearest ancestor that scrolls (overflow auto/scroll), or null. */
export function findScrollContainer(el: HTMLElement | null): HTMLElement | null {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (/(auto|scroll)/.test(`${style.overflowX} ${style.overflowY} ${style.overflow}`)) return node;
  }
  return null;
}

/** Scale at which the box fills the viewport minus `padding` (fraction per side), clamped to the zoom range. */
export function fitScaleForBox(
  pageSize: { width: number; height: number },
  bbox: BboxMinMax,
  viewport: { width: number; height: number },
  scale: number,
  padding = 0.12,
): number {
  const boxW = (bbox[2] - bbox[0]) * pageSize.width;
  const boxH = (bbox[3] - bbox[1]) * pageSize.height;
  if (!(boxW > 0 && boxH > 0 && viewport.width > 0 && viewport.height > 0 && scale > 0)) return scale;
  const k = Math.min((viewport.width * (1 - 2 * padding)) / boxW, (viewport.height * (1 - 2 * padding)) / boxH);
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * k));
}

/** Scroll delta that puts the box centre on the viewport centre. Rects are client (screen) rects. */
export function centerDelta(
  pageRect: { left: number; top: number; width: number; height: number },
  viewportRect: { left: number; top: number; width: number; height: number },
  bbox: BboxMinMax,
): { dx: number; dy: number } {
  const cx = pageRect.left + ((bbox[0] + bbox[2]) / 2) * pageRect.width;
  const cy = pageRect.top + ((bbox[1] + bbox[3]) / 2) * pageRect.height;
  return {
    dx: cx - (viewportRect.left + viewportRect.width / 2),
    dy: cy - (viewportRect.top + viewportRect.height / 2),
  };
}
