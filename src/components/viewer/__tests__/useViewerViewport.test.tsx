// @vitest-environment jsdom
// [uifix 2026-10-28] PDFViewer's viewport hooks against fake DOM rects: a highlight request with fit zooms and
// centres; a re-click (a new request object with the same box) re-fires after the user scrolled away; a
// scroll-only request never changes the scale; a wheel anchor is re-applied on the scale commit once the page
// has its new width, and jsdom's missing ResizeObserver is tolerated.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { useEffect, useRef } from "react";
import type { LlmHighlight } from "@/stores/uiStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { useHighlightViewportFocus, useZoomAnchorReapply } from "../useViewerViewport";
import type { ZoomAnchor } from "../viewerZoomAnchor";

const VIEW = { left: 100, top: 60, width: 1000, height: 800 };
const PAD_X = 250;
const PAD_Y = 400;
const DIMS = { width: 1000, height: 750 };
const BBOX: [number, number, number, number] = [0.6, 0.6, 0.8, 0.7];

let arm: ((anchor: ZoomAnchor | null, expectedWidth: number) => void) | null = null;

function Harness({ highlight, scale }: { highlight: LlmHighlight | null; scale: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  useHighlightViewportFocus(containerRef, pageRef, highlight);
  const armFn = useZoomAnchorReapply(containerRef, pageRef, scale);
  useEffect(() => {
    arm = armFn;
  }, [armFn]);
  return (
    <div ref={containerRef} data-testid="container">
      <div ref={pageRef} data-testid="page">
        <canvas data-page-canvas="true" style={{ opacity: 1 }} />
      </div>
    </div>
  );
}

/** Give the rendered container/page a scroll position and rects that follow the store's scale. */
function wire(container: HTMLElement, page: HTMLElement) {
  const scroll = { left: PAD_X, top: PAD_Y };
  Object.defineProperty(container, "scrollLeft", { get: () => scroll.left, set: (v: number) => (scroll.left = v), configurable: true });
  Object.defineProperty(container, "scrollTop", { get: () => scroll.top, set: (v: number) => (scroll.top = v), configurable: true });
  Object.defineProperty(container, "clientWidth", { value: VIEW.width, configurable: true });
  Object.defineProperty(container, "clientHeight", { value: VIEW.height, configurable: true });
  container.getBoundingClientRect = () => ({ ...VIEW, right: VIEW.left + VIEW.width, bottom: VIEW.top + VIEW.height, x: VIEW.left, y: VIEW.top, toJSON: () => ({}) });
  const pageRect = () => {
    const s = useViewerCoreStore.getState().scale;
    const left = VIEW.left + PAD_X - scroll.left;
    const top = VIEW.top + PAD_Y - scroll.top;
    const width = DIMS.width * s;
    const height = DIMS.height * s;
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) };
  };
  page.getBoundingClientRect = pageRect;
  return { scroll, pageRect };
}

function boxOffset(rect: { left: number; top: number; width: number; height: number }) {
  const cx = rect.left + ((BBOX[0] + BBOX[2]) / 2) * rect.width;
  const cy = rect.top + ((BBOX[1] + BBOX[3]) / 2) * rect.height;
  return { x: cx - (VIEW.left + VIEW.width / 2), y: cy - (VIEW.top + VIEW.height / 2) };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "setTimeout", "clearTimeout"] });
  useViewerCoreStore.setState({ pageNumber: 5, scale: 1, pageDimensions: { 5: DIMS } });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  arm = null;
});

describe("useHighlightViewportFocus", () => {
  it("fit request zooms to the box and centres it; a re-click re-fires", async () => {
    const h1: LlmHighlight = { pageNumber: 5, bbox: BBOX, label: "Door schedule", fit: true };
    const view = render(<Harness highlight={h1} scale={1} />);
    const { scroll, pageRect } = wire(view.getByTestId("container"), view.getByTestId("page"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(useViewerCoreStore.getState().scale).toBeCloseTo(3.8, 6);
    expect(Math.abs(boxOffset(pageRect()).x)).toBeLessThan(1e-6);
    expect(Math.abs(boxOffset(pageRect()).y)).toBeLessThan(1e-6);

    // The user scrolls away, then clicks the same row again: a new request object.
    scroll.left = 0;
    scroll.top = 0;
    view.rerender(<Harness highlight={{ ...h1 }} scale={1} />);
    await vi.advanceTimersByTimeAsync(2000);
    expect(Math.abs(boxOffset(pageRect()).x)).toBeLessThan(1e-6);
    expect(Math.abs(boxOffset(pageRect()).y)).toBeLessThan(1e-6);
  });

  it("scroll-only request (annotation rows, tag browse, chat) centres without zooming", async () => {
    useViewerCoreStore.setState({ scale: 1.7 });
    const view = render(<Harness highlight={{ pageNumber: 5, bbox: BBOX, label: "Door" }} scale={1.7} />);
    const { pageRect } = wire(view.getByTestId("container"), view.getByTestId("page"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(useViewerCoreStore.getState().scale).toBe(1.7);
    expect(Math.abs(boxOffset(pageRect()).x)).toBeLessThan(1e-6);
    expect(Math.abs(boxOffset(pageRect()).y)).toBeLessThan(1e-6);
  });

  it("does nothing while the viewer shows another page", async () => {
    useViewerCoreStore.setState({ pageNumber: 4 });
    const view = render(<Harness highlight={{ pageNumber: 5, bbox: BBOX, fit: true }} scale={1} />);
    const { scroll } = wire(view.getByTestId("container"), view.getByTestId("page"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(useViewerCoreStore.getState().scale).toBe(1);
    expect(scroll).toEqual({ left: PAD_X, top: PAD_Y });
  });
});

describe("useZoomAnchorReapply", () => {
  it("re-applies the anchor on the scale commit once the page has its new width", () => {
    expect(typeof ResizeObserver).toBe("undefined"); // jsdom: the hook must tolerate its absence
    const view = render(<Harness highlight={null} scale={1} />);
    const { scroll, pageRect } = wire(view.getByTestId("container"), view.getByTestId("page"));
    const before = pageRect();
    const clientX = 900;
    const clientY = 700;
    const anchor: ZoomAnchor = {
      u: (clientX - before.left) / before.width,
      v: (clientY - before.top) / before.height,
      cx: clientX - VIEW.left,
      cy: clientY - VIEW.top,
    };
    // Suppose the immediate scroll was clamped and did not move at all.
    arm!(anchor, before.width * 1.25);
    useViewerCoreStore.setState({ scale: 1.25 });
    view.rerender(<Harness highlight={null} scale={1.25} />);
    const after = pageRect();
    expect(after.left + anchor.u * after.width).toBeCloseTo(clientX, 6);
    expect(after.top + anchor.v * after.height).toBeCloseTo(clientY, 6);
    expect(scroll.left).not.toBe(PAD_X);
  });

  it("ignores an anchor whose expected width was never reached, or that expired", () => {
    const view = render(<Harness highlight={null} scale={1} />);
    const { scroll } = wire(view.getByTestId("container"), view.getByTestId("page"));
    const anchor: ZoomAnchor = { u: 0.5, v: 0.5, cx: 10, cy: 10 };
    arm!(anchor, 5000);
    useViewerCoreStore.setState({ scale: 1.25 });
    view.rerender(<Harness highlight={null} scale={1.25} />);
    expect(scroll).toEqual({ left: PAD_X, top: PAD_Y });

    arm!(anchor, 1000 * 1.5);
    vi.advanceTimersByTime(1500);
    useViewerCoreStore.setState({ scale: 1.5 });
    view.rerender(<Harness highlight={null} scale={1.5} />);
    expect(scroll).toEqual({ left: PAD_X, top: PAD_Y });
  });
});
