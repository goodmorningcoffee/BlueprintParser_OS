// @vitest-environment jsdom
// [refactor jul12 P2.4 A2c/A2d] Shared Guided grid edit invalidation + lease cadence witness.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import GuidedParseOverlay from "@/components/viewer/GuidedParseOverlay";
import type { ParseWorkspaceLease } from "@/stores/viewerCommands";

const LEASE: ParseWorkspaceLease = {
  tableRevision: 11,
  keynoteRevision: 12,
  notesRevision: 13,
  specRevision: 14,
  guidedOwner: "keynote",
};

function noopContext(): CanvasRenderingContext2D {
  return {
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    lineTo: vi.fn(),
    moveTo: vi.fn(),
    restore: vi.fn(),
    save: vi.fn(),
    setLineDash: vi.fn(),
    setTransform: vi.fn(),
    stroke: vi.fn(),
    strokeRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
}

function canvasRect(): DOMRect {
  return {
    bottom: 100,
    height: 100,
    left: 0,
    right: 100,
    top: 0,
    width: 100,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  };
}

function renderOverlay(overrides: Partial<React.ComponentProps<typeof GuidedParseOverlay>> = {}) {
  const props: React.ComponentProps<typeof GuidedParseOverlay> = {
    active: true,
    region: [0.1, 0.1, 0.9, 0.9],
    rows: [0.5],
    cols: [0.3],
    setRows: vi.fn(),
    setCols: vi.fn(),
    onGridEditStart: vi.fn(() => LEASE),
    width: 100,
    height: 100,
    cssScale: 1,
    ...overrides,
  };
  const view = render(<GuidedParseOverlay {...props} />);
  const canvas = view.container.querySelector("canvas");
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Expected GuidedParseOverlay canvas");
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(canvasRect());
  return { canvas, props };
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(noopContext());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("A2c GuidedParseOverlay grid edit authority", () => {
  it("starts authority exactly once for a successful drag, not once per mousemove", () => {
    const { canvas, props } = renderOverlay();

    // The existing column boundary is at x=30 in the 100px canvas.
    fireEvent.mouseDown(canvas, { clientX: 30, clientY: 50 });
    expect(props.onGridEditStart).toHaveBeenCalledTimes(1);

    fireEvent.mouseMove(window, { clientX: 35, clientY: 50 });
    fireEvent.mouseMove(window, { clientX: 40, clientY: 50 });

    expect(props.setCols).toHaveBeenCalledTimes(2);
    expect(props.setCols).toHaveBeenNthCalledWith(1, [0.35], LEASE);
    expect(props.setCols).toHaveBeenNthCalledWith(2, [0.4], LEASE);
    expect(props.onGridEditStart).toHaveBeenCalledTimes(1);

    fireEvent.mouseUp(window);
    fireEvent.mouseMove(window, { clientX: 45, clientY: 50 });
    expect(props.setCols).toHaveBeenCalledTimes(2);
    expect(props.onGridEditStart).toHaveBeenCalledTimes(1);
  });

  it("starts authority once before each row or column double-click edit", () => {
    const { canvas, props } = renderOverlay();

    // Near the top edge, the overlay adds a horizontal row boundary.
    fireEvent.doubleClick(canvas, { clientX: 50, clientY: 20 });
    expect(props.onGridEditStart).toHaveBeenCalledTimes(1);
    expect(props.setRows).toHaveBeenCalledWith([0.5, 0.2], LEASE);
    expect(props.setCols).not.toHaveBeenCalled();

    // Near the left edge, it adds a vertical column boundary.
    fireEvent.doubleClick(canvas, { clientX: 20, clientY: 70 });
    expect(props.onGridEditStart).toHaveBeenCalledTimes(2);
    expect(props.setCols).toHaveBeenCalledWith([0.3, 0.2], LEASE);
    expect(props.setRows).toHaveBeenCalledTimes(1);
  });

  it("does not start a drag or publish stale geometry when the rendered owner loses authority", () => {
    const { canvas, props } = renderOverlay({ onGridEditStart: vi.fn(() => null) });

    fireEvent.mouseDown(canvas, { clientX: 30, clientY: 50 });
    fireEvent.mouseMove(window, { clientX: 40, clientY: 50 });
    fireEvent.doubleClick(canvas, { clientX: 50, clientY: 20 });

    expect(props.onGridEditStart).toHaveBeenCalledTimes(2);
    expect(props.setRows).not.toHaveBeenCalled();
    expect(props.setCols).not.toHaveBeenCalled();
  });
});
