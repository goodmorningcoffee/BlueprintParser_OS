// @vitest-environment node
// [uifix 2026-10-28] The "focus the viewport on a box" sequence, driven with fake frames and rects: it waits out
// the page swap (old page, then the PNG stand-in) before measuring, fits the scale from the FINAL page size,
// centres the box, re-centres when the page resizes late, and stops on user input, cancellation or a page change.
import { describe, expect, it } from "vitest";
import type { BboxMinMax } from "@/types";
import {
  READY_TIMEOUT_MS,
  pageLooksReady,
  runViewportFocus,
  type ViewportFocusEnv,
} from "../viewportFocus";
import type { ClientRect } from "../viewerZoomAnchor";

const VIEW: ClientRect = { left: 100, top: 60, width: 1000, height: 800 };
const PAD_X = 250;
const PAD_Y = 400;
const PAGE = 5;
const DIMS = { width: 1000, height: 750 };

/** What the page element shows on a given frame: its size at scale 1 and whether the canvas is hidden. */
type Phase = (frame: number) => { width: number; height: number; canvasHidden?: boolean };

function world(phase: Phase, opts: { scale?: number; currentPage?: number } = {}) {
  const state = {
    frame: 0,
    time: 0,
    scale: opts.scale ?? 1,
    scrollLeft: PAD_X,
    scrollTop: PAD_Y,
    cancelled: false,
    interacted: false,
    currentPage: opts.currentPage ?? PAGE,
    setScaleCalls: [] as number[],
    scrolls: 0,
  };
  const pageRect = (): ClientRect => {
    const p = phase(state.frame);
    return {
      left: VIEW.left + PAD_X - state.scrollLeft,
      top: VIEW.top + PAD_Y - state.scrollTop,
      width: p.width * state.scale,
      height: p.height * state.scale,
    };
  };
  const env: ViewportFocusEnv = {
    nextFrame: async () => {
      state.frame += 1;
      state.time += 16;
      await Promise.resolve();
    },
    now: () => state.time,
    cancelled: () => state.cancelled,
    userInteracted: () => state.interacted,
    currentPage: () => state.currentPage,
    pageDimensions: (page) => (page === PAGE ? DIMS : null),
    pageRect,
    canvasHidden: () => phase(state.frame).canvasHidden === true,
    viewportRect: () => VIEW,
    viewportSize: () => ({ width: VIEW.width, height: VIEW.height }),
    getScale: () => state.scale,
    setScale: (s) => {
      state.setScaleCalls.push(s);
      state.scale = s;
    },
    scrollBy: (dx, dy) => {
      state.scrollLeft += dx;
      state.scrollTop += dy;
      state.scrolls += 1;
    },
  };
  return { state, env, pageRect };
}

const BBOX: BboxMinMax = [0.6, 0.6, 0.8, 0.7];

function boxCentreOffset(rect: ClientRect, bbox: BboxMinMax) {
  const cx = rect.left + ((bbox[0] + bbox[2]) / 2) * rect.width;
  const cy = rect.top + ((bbox[1] + bbox[3]) / 2) * rect.height;
  return { x: cx - (VIEW.left + VIEW.width / 2), y: cy - (VIEW.top + VIEW.height / 2) };
}

const steady: Phase = () => ({ width: DIMS.width, height: DIMS.height });

describe("runViewportFocus", () => {
  it("page change: waits for the new page's final size, fits from it, then centres the box", async () => {
    // Frames 0-3: the previous (landscape-wide) page is still shown; 4-6: the PNG stand-in at half size with the
    // canvas hidden; 7+: the rendered page.
    const phase: Phase = (f) =>
      f < 4 ? { width: 1000, height: 500 } : f < 7 ? { width: 500, height: 375, canvasHidden: true } : steady(f);
    const { state, env, pageRect } = world(phase);
    await expect(runViewportFocus(env, { pageNumber: PAGE, bbox: BBOX, fit: true })).resolves.toBe("focused");
    // Box is 200 x 75 at scale 1; 76% of 1000 x 800 → k = min(3.8, 8.1). Measured on the PNG stand-in it would
    // have been 7.6.
    expect(state.setScaleCalls).toHaveLength(1);
    expect(state.setScaleCalls[0]).toBeCloseTo(3.8, 6);
    const off = boxCentreOffset(pageRect(), BBOX);
    expect(Math.abs(off.x)).toBeLessThan(1e-6);
    expect(Math.abs(off.y)).toBeLessThan(1e-6);
  });

  it("same page, scroll-only: no zoom, the box ends centred", async () => {
    const { state, env, pageRect } = world(steady, { scale: 1.7 });
    await expect(runViewportFocus(env, { pageNumber: PAGE, bbox: BBOX, fit: false })).resolves.toBe("focused");
    expect(state.setScaleCalls).toEqual([]);
    expect(state.scale).toBe(1.7);
    const off = boxCentreOffset(pageRect(), BBOX);
    expect(Math.abs(off.x)).toBeLessThan(1e-6);
    expect(Math.abs(off.y)).toBeLessThan(1e-6);
  });

  it("does not rezoom when the box already fits", async () => {
    const { state, env } = world(steady, { scale: 3.8 });
    await runViewportFocus(env, { pageNumber: PAGE, bbox: BBOX, fit: true });
    expect(state.setScaleCalls).toEqual([]);
  });

  it("re-centres when the page resizes during the settle window", async () => {
    let grownAt = Number.POSITIVE_INFINITY;
    const phase: Phase = (f) => (f >= grownAt ? { width: 1100, height: 825 } : steady(f));
    const { state, env, pageRect } = world(phase);
    const run = runViewportFocus(env, { pageNumber: PAGE, bbox: BBOX, fit: false });
    // Let the sequence centre, then grow the page a few frames later.
    while (state.scrolls === 0) await Promise.resolve();
    grownAt = state.frame + 5;
    await run;
    expect(state.scrolls).toBe(2);
    const off = boxCentreOffset(pageRect(), BBOX);
    expect(Math.abs(off.x)).toBeLessThan(1e-6);
    expect(Math.abs(off.y)).toBeLessThan(1e-6);
  });

  it("leaves the viewport alone once the user takes over", async () => {
    let grownAt = Number.POSITIVE_INFINITY;
    const phase: Phase = (f) => (f >= grownAt ? { width: 1100, height: 825 } : steady(f));
    const { state, env } = world(phase);
    const run = runViewportFocus(env, { pageNumber: PAGE, bbox: BBOX, fit: false });
    while (state.scrolls === 0) await Promise.resolve();
    state.interacted = true;
    grownAt = state.frame + 2;
    await run;
    expect(state.scrolls).toBe(1);
  });

  it("stops when cancelled (a newer request) or when the viewer is on another page", async () => {
    const a = world(steady);
    a.state.cancelled = true;
    await expect(runViewportFocus(a.env, { pageNumber: PAGE, bbox: BBOX, fit: true })).resolves.toBe("cancelled");
    expect(a.state.scrolls).toBe(0);

    const b = world(steady, { currentPage: 4 });
    await expect(runViewportFocus(b.env, { pageNumber: PAGE, bbox: BBOX, fit: true })).resolves.toBe("wrong-page");
    expect(b.state.scrolls).toBe(0);
  });

  it("falls back to the laid-out size after the readiness timeout", async () => {
    const { state, env, pageRect } = world(() => ({ width: DIMS.width, height: DIMS.height, canvasHidden: true }));
    await expect(runViewportFocus(env, { pageNumber: PAGE, bbox: BBOX, fit: false })).resolves.toBe("focused");
    expect(state.time).toBeGreaterThanOrEqual(READY_TIMEOUT_MS);
    const off = boxCentreOffset(pageRect(), BBOX);
    expect(Math.abs(off.x)).toBeLessThan(1e-6);
  });
});

describe("pageLooksReady", () => {
  const rect = (w: number, h: number): ClientRect => ({ left: 0, top: 0, width: w, height: h });
  it("needs a size, known dimensions, a visible canvas and a matching aspect (2%)", () => {
    expect(pageLooksReady(rect(2000, 1500), DIMS, false)).toBe(true);
    expect(pageLooksReady(rect(2000, 1525), DIMS, false)).toBe(true);
    expect(pageLooksReady(rect(2000, 1600), DIMS, false)).toBe(false);
    expect(pageLooksReady(rect(2000, 1500), DIMS, true)).toBe(false);
    expect(pageLooksReady(rect(0, 0), DIMS, false)).toBe(false);
    expect(pageLooksReady(rect(2000, 1500), null, false)).toBe(false);
    expect(pageLooksReady(null, DIMS, false)).toBe(false);
  });
});
