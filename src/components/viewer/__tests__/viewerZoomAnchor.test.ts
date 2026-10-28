// @vitest-environment node
// [uifix 2026-10-28] Wheel-zoom anchor: the page point under the cursor stays put (drift 0) for any padding,
// cursor and ratio, including the case where the immediate scroll is clamped to the OLD scroll size and is
// corrected once the page has resized. The model mirrors PDFViewer's layout: a scroll container whose content is
// the page plus a constant padding on each side.
import { describe, expect, it } from "vitest";
import {
  anchorCorrection,
  anchoredScroll,
  nextWheelScale,
  reachedExpectedWidth,
  zoomAnchorAt,
  type ClientRect,
} from "../viewerZoomAnchor";

interface Layout {
  view: ClientRect; // the scroll container's client rect
  padX: number;
  padY: number;
  pageW: number;
  pageH: number;
  scrollLeft: number;
  scrollTop: number;
}

const maxScroll = (l: Layout) => ({
  left: Math.max(0, 2 * l.padX + l.pageW - l.view.width),
  top: Math.max(0, 2 * l.padY + l.pageH - l.view.height),
});
const clampScroll = (l: Layout, left: number, top: number) => {
  const max = maxScroll(l);
  l.scrollLeft = Math.min(Math.max(0, left), max.left);
  l.scrollTop = Math.min(Math.max(0, top), max.top);
};
const pageRectOf = (l: Layout): ClientRect => ({
  left: l.view.left + l.padX - l.scrollLeft,
  top: l.view.top + l.padY - l.scrollTop,
  width: l.pageW,
  height: l.pageH,
});

/** One wheel zoom as PDFViewer does it: scroll now (clamped to the old size), resize, then re-apply. */
function zoom(l: Layout, clientX: number, clientY: number, ratio: number, reapply: boolean) {
  const before = pageRectOf(l);
  const u = (clientX - before.left) / before.width;
  const v = (clientY - before.top) / before.height;
  const anchor = zoomAnchorAt(clientX, clientY, before, l.view);
  const next = anchoredScroll(anchor, before, l.view, { left: l.scrollLeft, top: l.scrollTop }, ratio, { clientX, clientY });
  clampScroll(l, next.left, next.top); // the content has not resized yet
  l.pageW *= ratio;
  l.pageH *= ratio;
  if (reapply && anchor) {
    const { dx, dy } = anchorCorrection(anchor, pageRectOf(l), l.view);
    clampScroll(l, l.scrollLeft + dx, l.scrollTop + dy);
  }
  const after = pageRectOf(l);
  return { driftX: after.left + u * after.width - clientX, driftY: after.top + v * after.height - clientY };
}

const layout = (over: Partial<Layout> = {}): Layout => ({
  view: { left: 200, top: 90, width: 1200, height: 860 },
  padX: 375,
  padY: 491,
  pageW: 1168,
  pageH: 756,
  scrollLeft: 375,
  scrollTop: 491,
  ...over,
});

describe("wheel zoom anchor", () => {
  it.each([
    { name: "centre, zoom in", x: 800, y: 520, ratio: 1 / 0.97, padX: 375, padY: 491 },
    { name: "top-left of the page", x: 260, y: 120, ratio: 1 / 0.97, padX: 375, padY: 491 },
    { name: "bottom-right, zoom out", x: 1350, y: 900, ratio: 0.97, padX: 375, padY: 491 },
    { name: "small padding, big step", x: 700, y: 400, ratio: 1.5, padX: 16, padY: 16 },
    { name: "wide padding, fine step", x: 1000, y: 700, ratio: 1 / 0.995, padX: 960, padY: 540 },
  ])("keeps the page point under the cursor: $name", ({ x, y, ratio, padX, padY }) => {
    const l = layout({ padX, padY, scrollLeft: padX, scrollTop: padY });
    const { driftX, driftY } = zoom(l, x, y, ratio, true);
    expect(Math.abs(driftX)).toBeLessThan(1e-6);
    expect(Math.abs(driftY)).toBeLessThan(1e-6);
  });

  it("the immediate scroll alone is exact when the padding leaves slack (no clamp)", () => {
    const l = layout();
    const { driftX, driftY } = zoom(l, 800, 520, 1 / 0.97, false);
    expect(Math.abs(driftX)).toBeLessThan(1e-6);
    expect(Math.abs(driftY)).toBeLessThan(1e-6);
  });

  it("stays at zero drift over the measured sequence (ten ticks in, then three more)", () => {
    const l = layout();
    for (let i = 0; i < 13; i++) {
      const { driftX, driftY } = zoom(l, 900, 600, 1 / 0.97, true);
      expect(Math.abs(driftX)).toBeLessThan(1e-6);
      expect(Math.abs(driftY)).toBeLessThan(1e-6);
    }
  });

  it("documents the old content-relative formula's drift: (ratio - 1) * padding", () => {
    const l = layout();
    const ratio = 1.36;
    const before = pageRectOf(l);
    const x = 900;
    const u = (x - before.left) / before.width;
    const old = anchoredScroll(null, null, l.view, { left: l.scrollLeft, top: l.scrollTop }, ratio, { clientX: x, clientY: 0 });
    l.scrollLeft = old.left;
    l.pageW *= ratio;
    const after = pageRectOf(l);
    expect(after.left + u * after.width - x).toBeCloseTo(-(ratio - 1) * l.padX, 6);
  });

  it("re-applies the anchor after the resize when the immediate scroll was clamped", () => {
    // Scrolled to the far bottom-right corner with no slack: zooming in at the corner needs a scroll beyond
    // the OLD maximum, so the browser clamps it until the page has grown.
    const base = layout({ padX: 0, padY: 0, pageW: 2400, pageH: 1800 });
    base.scrollLeft = maxScroll(base).left;
    base.scrollTop = maxScroll(base).top;
    const cornerX = base.view.left + base.view.width - 10;
    const cornerY = base.view.top + base.view.height - 10;

    const clamped = { ...base, view: { ...base.view } };
    const withoutReapply = zoom(clamped, cornerX, cornerY, 1.25, false);
    expect(Math.abs(withoutReapply.driftX)).toBeGreaterThan(1);
    expect(Math.abs(withoutReapply.driftY)).toBeGreaterThan(1);

    const fixed = { ...base, view: { ...base.view } };
    const withReapply = zoom(fixed, cornerX, cornerY, 1.25, true);
    expect(Math.abs(withReapply.driftX)).toBeLessThan(1e-6);
    expect(Math.abs(withReapply.driftY)).toBeLessThan(1e-6);
  });

  it("has no anchor before the page has a size, and falls back to the content-relative scroll", () => {
    const view = { left: 0, top: 0, width: 100, height: 100 };
    expect(zoomAnchorAt(10, 10, null, view)).toBeNull();
    expect(zoomAnchorAt(10, 10, { left: 0, top: 0, width: 0, height: 0 }, view)).toBeNull();
    expect(anchoredScroll(null, null, view, { left: 10, top: 20 }, 2, { clientX: 30, clientY: 40 })).toEqual({
      left: 50,
      top: 80,
    });
  });

  it("keeps the wheel step sizes and the 0.2–10 zoom range", () => {
    expect(nextWheelScale(1, -10, 0)).toBeCloseTo(1 / 0.995, 10);
    expect(nextWheelScale(1, 10, 0)).toBeCloseTo(0.995, 10);
    expect(nextWheelScale(1, -100, 0)).toBeCloseTo(1 / 0.97, 10);
    expect(nextWheelScale(1, 3, 1)).toBeCloseTo(0.97, 10);
    expect(nextWheelScale(10, -100, 0)).toBe(10);
    expect(nextWheelScale(0.2, 100, 0)).toBe(0.2);
  });

  it("matches the expected width within 1%", () => {
    expect(reachedExpectedWidth(1000, 1005)).toBe(true);
    expect(reachedExpectedWidth(1000, 1100)).toBe(false);
    expect(reachedExpectedWidth(0, 0)).toBe(false);
  });
});
