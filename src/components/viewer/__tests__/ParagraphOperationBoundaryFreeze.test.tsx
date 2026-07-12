// @vitest-environment jsdom
// [refactor jul12 P2.4 A2d freeze-first] Hot paragraph/fast-manual gesture authority cadence.

import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import FastManualParseOverlay from "@/components/viewer/FastManualParseOverlay";
import ParagraphOverlay from "@/components/viewer/ParagraphOverlay";
import type {
  PendingParagraph,
  ParagraphTemplate,
} from "@/stores/parseFlowStore";
import type { TextractLine } from "@/types";

function noopContext(): CanvasRenderingContext2D {
  const target = {
    measureText: () => ({ width: 20 }),
  };
  return new Proxy(target, {
    get(object, property) {
      if (property in object) return object[property as keyof typeof object];
      return () => undefined;
    },
    set(object, property, value) {
      Reflect.set(object, property, value);
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
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

const PARAGRAPH_LINE: TextractLine = {
  text: "1. Gypsum board note",
  confidence: 99,
  bbox: [0.2, 0.5, 0.4, 0.06],
  words: [
    { text: "1.", confidence: 99, bbox: [0.2, 0.5, 0.04, 0.06] },
    { text: "Gypsum", confidence: 99, bbox: [0.3, 0.5, 0.1, 0.06] },
    { text: "board", confidence: 99, bbox: [0.42, 0.5, 0.08, 0.06] },
    { text: "note", confidence: 99, bbox: [0.52, 0.5, 0.08, 0.06] },
  ],
};

function pendingParagraph(id = "paragraph-A"): PendingParagraph {
  return {
    id,
    bbox: [0.2, 0.2, 0.6, 0.4],
    lines: [PARAGRAPH_LINE],
    rowText: { Key: "1", Note: "Gypsum board note" },
    colBoundaries: [0.2, 0.35, 0.6],
  };
}

type GestureLease = Readonly<{ gesture: string }>;

type PlannedParagraphProps = Omit<
  ComponentProps<typeof ParagraphOverlay>,
  "onParagraphUpsert" | "onParagraphRemove" | "onWorkspaceEditStart"
> & {
  onParagraphUpsert: (paragraph: PendingParagraph, lease: GestureLease) => void;
  onParagraphRemove: (paragraphId: string, lease: GestureLease) => void;
  onWorkspaceEditStart: () => GestureLease;
};

function renderParagraph(
  overrides: Partial<PlannedParagraphProps> = {},
): {
  canvas: HTMLCanvasElement;
  props: PlannedParagraphProps;
  rerender: (next: Partial<PlannedParagraphProps>) => void;
} {
  const defaultLease: GestureLease = { gesture: "default-paragraph" };
  const props: PlannedParagraphProps = {
    active: true,
    outerBbox: [0.1, 0.1, 0.9, 0.9],
    textRegions: [],
    allLines: [PARAGRAPH_LINE],
    yGapTolerance: 0.02,
    regionKind: "notes-numbered",
    paragraphBatch: [],
    paragraphClipboard: null,
    onParagraphUpsert: vi.fn(),
    onParagraphRemove: vi.fn(),
    onClipboardCapture: vi.fn(),
    onWorkspaceEditStart: vi.fn(() => defaultLease),
    onExit: vi.fn(),
    width: 100,
    height: 100,
    cssScale: 1,
    ...overrides,
  };
  const view = render(
    <ParagraphOverlay
      {...(props as unknown as ComponentProps<typeof ParagraphOverlay>)}
    />,
  );
  const canvas = view.container.querySelector("canvas");
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Expected ParagraphOverlay canvas");
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(canvasRect());
  return {
    canvas,
    props,
    rerender: (next) => {
      view.rerender(
        <ParagraphOverlay
          {...({ ...props, ...next } as unknown as ComponentProps<typeof ParagraphOverlay>)}
        />,
      );
    },
  };
}

type FastManualGridValue = Parameters<
  ComponentProps<typeof FastManualParseOverlay>["onGridChange"]
>[0];

type PlannedFastManualProps = Omit<
  ComponentProps<typeof FastManualParseOverlay>,
  "onGridChange" | "onGridEditStart"
> & {
  onGridChange: (grid: FastManualGridValue, lease: GestureLease) => void;
  onGridEditStart: () => GestureLease;
};

function renderFastManual(
  overrides: Partial<PlannedFastManualProps> = {},
): { canvas: HTMLCanvasElement; props: PlannedFastManualProps } {
  const defaultLease: GestureLease = { gesture: "default-fast-manual" };
  const props: PlannedFastManualProps = {
    active: true,
    textractLines: [PARAGRAPH_LINE],
    regionBbox: [0.1, 0.1, 0.9, 0.9],
    onGridChange: vi.fn(),
    onGridEditStart: vi.fn(() => defaultLease),
    width: 100,
    height: 100,
    cssScale: 1,
    ...overrides,
  };
  const view = render(
    <FastManualParseOverlay
      {...(props as unknown as ComponentProps<typeof FastManualParseOverlay>)}
    />,
  );
  const canvas = view.container.querySelector("canvas");
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error("Expected FastManualParseOverlay canvas");
  }
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

describe("A2d ParagraphOverlay operation boundaries", () => {
  it("forwards one authority lease across a drag and stops writes when deactivated", () => {
    const item = pendingParagraph();
    const dragLease: GestureLease = { gesture: "paragraph-drag" };
    const { canvas, props, rerender } = renderParagraph({
      paragraphBatch: [item],
      onWorkspaceEditStart: vi.fn(() => dragLease),
    });

    // Outside the outer region and away from any handle: no workspace mutation begins.
    fireEvent.mouseDown(canvas, { clientX: 5, clientY: 5 });
    expect(props.onWorkspaceEditStart).not.toHaveBeenCalled();

    // Top handle is the midpoint of [20,20]..[60,40] => [40,20].
    fireEvent.mouseDown(canvas, { clientX: 40, clientY: 20 });
    expect(props.onWorkspaceEditStart).toHaveBeenCalledTimes(1);

    fireEvent.mouseMove(window, { clientX: 40, clientY: 18 });
    fireEvent.mouseMove(window, { clientX: 40, clientY: 16 });
    fireEvent.mouseMove(window, { clientX: 40, clientY: 14 });

    expect(props.onParagraphUpsert).toHaveBeenCalledTimes(3);
    expect(props.onWorkspaceEditStart).toHaveBeenCalledTimes(1);
    for (let call = 1; call <= 3; call += 1) {
      expect.soft(props.onParagraphUpsert).toHaveBeenNthCalledWith(
        call,
        expect.objectContaining({ id: item.id }),
        dragLease,
      );
    }

    // Deactivation must synchronously retire the drag listener and its lease. A later global move
    // cannot mutate the old paragraph even if no mouseup was observed.
    rerender({ active: false });
    fireEvent.mouseMove(window, { clientX: 40, clientY: 12 });
    expect(props.onParagraphUpsert).toHaveBeenCalledTimes(3);
    expect(props.onWorkspaceEditStart).toHaveBeenCalledTimes(1);
  });

  it("forwards the valid double-click lease to its one paragraph mutation", () => {
    const addLease: GestureLease = { gesture: "paragraph-double-click" };
    const { canvas, props } = renderParagraph({
      onWorkspaceEditStart: vi.fn(() => addLease),
    });

    fireEvent.doubleClick(canvas, { clientX: 5, clientY: 5 });
    expect(props.onWorkspaceEditStart).not.toHaveBeenCalled();
    expect(props.onParagraphUpsert).not.toHaveBeenCalled();

    // The fallback paragraph cluster occupies normalized y=0.50..0.56.
    fireEvent.doubleClick(canvas, { clientX: 30, clientY: 53 });
    expect(props.onWorkspaceEditStart).toHaveBeenCalledTimes(1);
    expect(props.onParagraphUpsert).toHaveBeenCalledTimes(1);
    expect.soft(props.onParagraphUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ rowText: { Key: "1", Note: "Gypsum board note" } }),
      addLease,
    );
  });

  it("does not lease copy, then forwards distinct valid paste and delete leases", () => {
    const item = pendingParagraph();
    const pasteLease: GestureLease = { gesture: "paragraph-paste" };
    const deleteLease: GestureLease = { gesture: "paragraph-delete" };
    const leases = [pasteLease, deleteLease];
    const clipboard: ParagraphTemplate = {
      colBoundaries: [0.2, 0.35, 0.6],
      headers: ["Key", "Note"],
    };
    const { canvas, props } = renderParagraph({
      paragraphBatch: [item],
      paragraphClipboard: clipboard,
      onWorkspaceEditStart: vi.fn(() => {
        const lease = leases.shift();
        if (!lease) throw new Error("unexpected paragraph mutation lease request");
        return lease;
      }),
    });

    // Focus the paragraph body without hitting any of its four edge handles.
    fireEvent.mouseDown(canvas, { clientX: 40, clientY: 30 });
    expect(props.onWorkspaceEditStart).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "c", metaKey: true });
    expect(props.onClipboardCapture).toHaveBeenCalledTimes(1);
    expect(props.onWorkspaceEditStart).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "v", metaKey: true });
    expect(props.onParagraphUpsert).toHaveBeenCalledTimes(1);
    expect(props.onWorkspaceEditStart).toHaveBeenCalledTimes(1);
    expect.soft(props.onParagraphUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ id: item.id }),
      pasteLease,
    );

    fireEvent.keyDown(window, { key: "Delete" });
    expect.soft(props.onParagraphRemove).toHaveBeenCalledWith(item.id, deleteLease);
    expect(props.onWorkspaceEditStart).toHaveBeenCalledTimes(2);

    // Focus was cleared by Delete, so another Delete is a miss and publishes no boundary.
    fireEvent.keyDown(window, { key: "Delete" });
    expect(props.onParagraphRemove).toHaveBeenCalledTimes(1);
    expect(props.onWorkspaceEditStart).toHaveBeenCalledTimes(2);
  });
});

describe("A2d FastManualParseOverlay operation boundaries", () => {
  it("forwards distinct valid grid-add and Escape leases, never leasing a miss", () => {
    const addLease: GestureLease = { gesture: "fast-manual-add" };
    const clearLease: GestureLease = { gesture: "fast-manual-clear" };
    const leases = [addLease, clearLease];
    const { canvas, props } = renderFastManual({
      onGridEditStart: vi.fn(() => {
        const lease = leases.shift();
        if (!lease) throw new Error("unexpected Fast Manual mutation lease request");
        return lease;
      }),
    });
    (props.onGridChange as ReturnType<typeof vi.fn>).mockClear();

    fireEvent.doubleClick(canvas, { clientX: 5, clientY: 5 });
    expect(props.onGridEditStart).not.toHaveBeenCalled();
    expect(props.onGridChange).not.toHaveBeenCalled();

    fireEvent.doubleClick(canvas, { clientX: 30, clientY: 53 });
    expect(props.onGridEditStart).toHaveBeenCalledTimes(1);
    expect(props.onGridChange).toHaveBeenCalledTimes(1);
    expect.soft(props.onGridChange).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: ["Key", "Note"],
        rows: [{ Key: "1.", Note: "Gypsum board note" }],
      }),
      addLease,
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onGridEditStart).toHaveBeenCalledTimes(2);
    expect.soft(props.onGridChange).toHaveBeenLastCalledWith(null, clearLease);
  });
});
