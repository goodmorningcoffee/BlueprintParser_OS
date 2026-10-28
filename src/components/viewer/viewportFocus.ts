// [uifix 2026-10-28] "Focus the viewport on a box" sequence, shared by every llmHighlight caller (View All rows,
// annotation rows, tag browse, chat highlights). The old PDFViewer effect scrolled to bbox * dimension * scale
// after a fixed 100 ms: it ignored the scroll content's padding, fired before a new page had laid out (so the
// browser clamped the scroll to the OLD size and left it at 0,0) and never zoomed. This measures the page from
// the DOM instead, like ProposalFocusLayer, and reuses its arithmetic (proposals/proposalViewport.ts).
//
//   1. wait (frame by frame, up to READY_TIMEOUT_MS) until the target page has laid out: it is the current page,
//      has a size whose aspect matches pageDimensions[page] within 2%, is not mid PNG-to-canvas swap, and held
//      the same size for two frames;
//   2. optionally fit the scale so the box fills the viewport (padding 0.12), then wait two frames;
//   3. scroll by the centre delta;
//   4. for SETTLE_MS keep the box centred if the page resizes again (a raster swap landing late), unless the
//      user scrolls, zooms, clicks or types meanwhile.

import type { BboxMinMax } from "@/types";
import { centerDelta, fitScaleForBox } from "./proposals/proposalViewport";
import type { ClientRect } from "./viewerZoomAnchor";

export const READY_TIMEOUT_MS = 1500;
export const SETTLE_MS = 1500;
export const ASPECT_TOLERANCE = 0.02;
export const FIT_PADDING = 0.12;

export interface ViewportFocusRequest {
  pageNumber: number;
  bbox: BboxMinMax;
  fit: boolean;
}

/** Everything the sequence reads or writes, so tests can drive it with fake rects and frames. */
export interface ViewportFocusEnv {
  nextFrame(): Promise<void>;
  now(): number;
  cancelled(): boolean;
  userInteracted(): boolean;
  currentPage(): number;
  /** pageDimensions[page] from the viewer store, or null when that page has not reported a size. */
  pageDimensions(page: number): { width: number; height: number } | null;
  pageRect(): ClientRect | null;
  /** True while the page canvas is hidden behind the PNG fallback (its size is not final yet). */
  canvasHidden(): boolean;
  viewportRect(): ClientRect;
  viewportSize(): { width: number; height: number };
  getScale(): number;
  setScale(scale: number): void;
  scrollBy(dx: number, dy: number): void;
}

export type ViewportFocusOutcome = "focused" | "cancelled" | "not-ready" | "wrong-page";

const sameSize = (a: ClientRect, b: ClientRect) =>
  Math.abs(a.width - b.width) <= 0.5 && Math.abs(a.height - b.height) <= 0.5;

/** The page element shows the target page at a settled size. */
export function pageLooksReady(
  rect: ClientRect | null,
  dims: { width: number; height: number } | null,
  canvasHidden: boolean,
): rect is ClientRect {
  if (!rect || !(rect.width > 0 && rect.height > 0) || !dims || !(dims.width > 0 && dims.height > 0)) return false;
  if (canvasHidden) return false;
  const want = dims.width / dims.height;
  return Math.abs(rect.width / rect.height - want) <= want * ASPECT_TOLERANCE;
}

export async function runViewportFocus(env: ViewportFocusEnv, req: ViewportFocusRequest): Promise<ViewportFocusOutcome> {
  const stop = () => env.cancelled() || env.userInteracted();
  const start = env.now();
  // 1. Wait for the target page's layout (always at least two frames, so the navigation commit lands).
  await env.nextFrame();
  await env.nextFrame();
  let previous: ClientRect | null = null;
  let rect: ClientRect | null = null;
  for (;;) {
    if (stop()) return "cancelled";
    if (env.currentPage() !== req.pageNumber) return "wrong-page";
    const now = env.pageRect();
    const ready = pageLooksReady(now, env.pageDimensions(req.pageNumber), env.canvasHidden());
    if (ready && previous && sameSize(now, previous)) {
      rect = now;
      break;
    }
    if (env.now() - start >= READY_TIMEOUT_MS) {
      // Best effort after the timeout: any laid-out size beats not moving at all.
      if (now && now.width > 0 && now.height > 0) rect = now;
      break;
    }
    previous = ready ? now : null;
    await env.nextFrame();
  }
  if (!rect) return "not-ready";

  // 2. Fit.
  if (req.fit) {
    const scale = env.getScale();
    const next = fitScaleForBox(rect, req.bbox, env.viewportSize(), scale, FIT_PADDING);
    if (Math.abs(next - scale) > 1e-3) {
      env.setScale(next);
      await env.nextFrame();
      await env.nextFrame();
      if (stop()) return "cancelled";
    }
  }

  // 3. Centre.
  const centre = (): ClientRect | null => {
    const page = env.pageRect();
    if (!page || !(page.width > 0 && page.height > 0)) return null;
    const { dx, dy } = centerDelta(page, env.viewportRect(), req.bbox);
    if (dx !== 0 || dy !== 0) env.scrollBy(dx, dy);
    return page;
  };
  let centred = centre();
  if (!centred) return "not-ready";

  // 4. Settle: re-centre when the page resizes again within the window.
  const settleUntil = env.now() + SETTLE_MS;
  while (env.now() < settleUntil) {
    await env.nextFrame();
    if (stop() || env.currentPage() !== req.pageNumber) break;
    const now = env.pageRect();
    if (now && now.width > 0 && !sameSize(now, centred)) centred = centre() ?? centred;
  }
  return "focused";
}
