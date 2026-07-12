// @vitest-environment jsdom
// [refactor jul12 P2.4 A2d freeze-first] Shared Guided gesture-lease boundary witnesses.

import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import GuidedParseOverlay from "@/components/viewer/GuidedParseOverlay";

type GuidedGestureLease = Readonly<{
  workspace: "shared-guided";
  revision: number;
}>;

type PlannedGuidedProps = Omit<
  ComponentProps<typeof GuidedParseOverlay>,
  "setRows" | "setCols" | "onGridEditStart"
> & {
  setRows: (rows: number[], lease: GuidedGestureLease) => void;
  setCols: (cols: number[], lease: GuidedGestureLease) => void;
  onGridEditStart: () => GuidedGestureLease;
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

function renderOverlay(
  overrides: Partial<PlannedGuidedProps> = {},
): {
  canvas: HTMLCanvasElement;
  props: PlannedGuidedProps;
  rerender: (next: Partial<PlannedGuidedProps>) => void;
} {
  const defaultLease: GuidedGestureLease = {
    workspace: "shared-guided",
    revision: 1,
  };
  const props: PlannedGuidedProps = {
    active: true,
    region: [0.1, 0.1, 0.9, 0.9],
    rows: [0.5],
    cols: [0.3],
    setRows: vi.fn(),
    setCols: vi.fn(),
    onGridEditStart: vi.fn(() => defaultLease),
    width: 100,
    height: 100,
    cssScale: 1,
    ...overrides,
  };
  const view = render(
    <GuidedParseOverlay
      {...(props as unknown as ComponentProps<typeof GuidedParseOverlay>)}
    />,
  );
  const canvas = view.container.querySelector("canvas");
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error("Expected GuidedParseOverlay canvas");
  }
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(canvasRect());
  return {
    canvas,
    props,
    rerender: (next) => {
      view.rerender(
        <GuidedParseOverlay
          {...({ ...props, ...next } as unknown as ComponentProps<typeof GuidedParseOverlay>)}
        />,
      );
    },
  };
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(noopContext());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("A2d GuidedParseOverlay shared operation boundary", () => {
  it("forwards one column-drag lease across every move and retires it on deactivation", () => {
    const dragLease: GuidedGestureLease = {
      workspace: "shared-guided",
      revision: 41,
    };
    const { canvas, props, rerender } = renderOverlay({
      onGridEditStart: vi.fn(() => dragLease),
    });

    // The existing column boundary is x=30 in the 100px canvas. One mousedown owns the entire
    // gesture; its mousemoves must never begin new authority or lose the exact returned lease.
    fireEvent.mouseDown(canvas, { clientX: 30, clientY: 40 });
    expect(props.onGridEditStart).toHaveBeenCalledTimes(1);

    fireEvent.mouseMove(window, { clientX: 35, clientY: 40 });
    fireEvent.mouseMove(window, { clientX: 40, clientY: 40 });

    expect(props.setCols).toHaveBeenCalledTimes(2);
    expect.soft(props.setCols).toHaveBeenNthCalledWith(1, [0.35], dragLease);
    expect.soft(props.setCols).toHaveBeenNthCalledWith(2, [0.4], dragLease);
    expect(props.setRows).not.toHaveBeenCalled();
    expect(props.onGridEditStart).toHaveBeenCalledTimes(1);

    // Losing the active gate is a synchronous cancellation boundary even without mouseup. The
    // global listener and its retained lease must be gone before a later move is delivered.
    rerender({ active: false });
    fireEvent.mouseMove(window, { clientX: 45, clientY: 40 });
    expect(props.setCols).toHaveBeenCalledTimes(2);
    expect(props.onGridEditStart).toHaveBeenCalledTimes(1);
  });

  it("forwards one row-drag lease across every move and begins only once", () => {
    const dragLease: GuidedGestureLease = {
      workspace: "shared-guided",
      revision: 42,
    };
    const { canvas, props } = renderOverlay({
      onGridEditStart: vi.fn(() => dragLease),
    });

    // x=70 avoids the column hit; the existing row boundary is y=50.
    fireEvent.mouseDown(canvas, { clientX: 70, clientY: 50 });
    fireEvent.mouseMove(window, { clientX: 70, clientY: 55 });
    fireEvent.mouseMove(window, { clientX: 70, clientY: 60 });

    expect(props.onGridEditStart).toHaveBeenCalledTimes(1);
    expect(props.setRows).toHaveBeenCalledTimes(2);
    expect.soft(props.setRows).toHaveBeenNthCalledWith(1, [0.55], dragLease);
    expect.soft(props.setRows).toHaveBeenNthCalledWith(2, [0.6], dragLease);
    expect(props.setCols).not.toHaveBeenCalled();

    fireEvent.mouseUp(window);
    fireEvent.mouseMove(window, { clientX: 70, clientY: 65 });
    expect(props.setRows).toHaveBeenCalledTimes(2);
    expect(props.onGridEditStart).toHaveBeenCalledTimes(1);
  });

  it("forwards each double-click's exact row or column lease to its single mutation", () => {
    const rowLease: GuidedGestureLease = {
      workspace: "shared-guided",
      revision: 51,
    };
    const colLease: GuidedGestureLease = {
      workspace: "shared-guided",
      revision: 52,
    };
    const leases = [rowLease, colLease];
    const { canvas, props } = renderOverlay({
      onGridEditStart: vi.fn(() => {
        const lease = leases.shift();
        if (!lease) throw new Error("unexpected Guided mutation lease request");
        return lease;
      }),
    });

    // Near the top edge adds a row; near the left edge adds a column. Each edit is its own gesture
    // and must pass the exact lease returned immediately before that one setter call.
    fireEvent.doubleClick(canvas, { clientX: 50, clientY: 20 });
    expect(props.onGridEditStart).toHaveBeenCalledTimes(1);
    expect.soft(props.setRows).toHaveBeenCalledWith([0.5, 0.2], rowLease);
    expect(props.setCols).not.toHaveBeenCalled();

    fireEvent.doubleClick(canvas, { clientX: 20, clientY: 70 });
    expect(props.onGridEditStart).toHaveBeenCalledTimes(2);
    expect.soft(props.setCols).toHaveBeenCalledWith([0.3, 0.2], colLease);
    expect(props.setRows).toHaveBeenCalledTimes(1);
  });
});
