// @vitest-environment jsdom
//
// [refactor jul16 P3.2] EXECUTABLE behavior freeze for the markup mousedown region, landed
// test-only at parent 449a53e BEFORE the markup-controller extraction.
//
// Why this file exists (MARKUP_IMPL/RECON_CENSUS.md): the three markup mousedown blocks —
// selected corner-resize + label-bar delete, annotation select, empty-canvas deferred-draw start —
// plus the pre-dispatch invalidateToolTailAuthority() have NO executable oracle. Existing
// markup-mode tests (ActiveToolCanvasRaceFreeze, AnnotationOverlayLifecyclePublicationsFreeze)
// pin lifecycle/ABA races through the drawing path, not geometry, propagation, selection order,
// or the tail invalidation. The load-bearing behaviors frozen here through the PRODUCTION
// mousedown handler:
//   (1) markup runs IFF activeTool === null && mode === "markup" — a live specialized owner
//       (calibration input phase) suppresses it; mode "move" falls through inert;
//   (2) block order: corner handles (tl→tr→bl→br, HANDLE=8, PROPS width/height — anisotropic)
//       before the label bar (y ∈ [ay−18, ay] inclusive, x ≥ ax) before annotation select
//       (pageAnnotations array order) before empty-canvas deferred-draw;
//   (3) every markup-mode press stops propagation exactly once; mode "move" stops nothing;
//   (4) invalidateToolTailAuthority() runs for activeTool===null presses BEFORE mode dispatch —
//       observable even on the non-drawing select path;
//   (5) the mousedown→mouseup interface: a mousedown-started gesture completes through the
//       UNTOUCHED legacy mouseup into pendingMarkup → MarkupDialog → saveMarkup's optimistic
//       cache row carrying the exact anisotropically-normalized bbox; sub-1% gestures abandon.
// NOTE: the markup label bar is the SIMPLE variant (no pencil zone, no text measurement) —
// deliberately distinct from the pointer block's rich label logic, which stays in the overlay.
//
// The final describe pins the PRE-move source topology; the extraction commit rewrites ONLY that
// describe to the post-move topology (blocks absent, controller file is the sole home, factory
// carries the selection/pageAnnotations/deferredDrawing capabilities).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  claimToolTailAuthority,
  ownsToolTailAuthority,
  registerToolTailCancellation,
} from "@/lib/parse-tool-authority";
import { resetProjectData } from "@/stores/viewerCommands";
import { useToolStore } from "@/stores/toolStore";
import { useUiStore } from "@/stores/uiStore";
import { seedAnnotations, readSeededAnnotations } from "@/test/seed-annotations";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";
import type { ClientAnnotation } from "@/types";

vi.mock("../DrawingPreviewLayer", () => ({ default: () => null }));

// Prop-capturing MarkupDialog spy: witness 5 drives the production onNameChange/onSave through it.
type DialogProps = {
  name: string;
  onNameChange: (value: string) => void;
  onSave: () => void;
};
let dialogProps: DialogProps | null = null;
vi.mock("../MarkupDialog", () => ({
  default: (props: DialogProps) => {
    dialogProps = props;
    return <div data-testid="markup-freeze-dialog" />;
  },
}));

import AnnotationOverlay from "../AnnotationOverlay";

const PUBLIC_ID = "markup-fixture";

let queryClient: QueryClient;
const parentMouseDown = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <div onMouseDown={parentMouseDown}>{children}</div>
    </QueryClientProvider>
  );
}

function noopContext(): CanvasRenderingContext2D {
  const target = { measureText: () => ({ width: 0 }) };
  return new Proxy(target, {
    get(object, property) {
      if (property in object) return object[property as keyof typeof object];
      return () => {};
    },
    set(object, property, value) {
      Reflect.set(object, property, value);
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function canvasRect(width: number, height: number): DOMRect {
  return {
    x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height,
    toJSON: () => ({}),
  } as DOMRect;
}

// User markup on the NON-SQUARE 200×100 canvas: pixel box (40,20)–(120,80); label bar
// y ∈ [2,20] at x ≥ 40; corners tl(40,20) tr(120,20) bl(40,80) br(120,80).
// Transposed corner scaling would put br at (60,160) — witness 1 discriminates.
const BOX = {
  id: 7,
  pageNumber: 1,
  name: "Freeze Box",
  bbox: [0.2, 0.2, 0.6, 0.8],
  note: null,
  source: "user",
  data: null,
} as unknown as ClientAnnotation;

function seedOverlayState(rows: ClientAnnotation[], mode: "markup" | "move" = "markup"): void {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  parentMouseDown.mockClear();
  dialogProps = null;
  resetProjectData();
  setViewerStoreStateForTest({
    projectId: 41,
    publicId: PUBLIC_ID,
    isDemo: true,
    pageNumber: 1,
    numPages: 1,
    pageNames: { 1: "A-101" },
    mode,
    activeTool: null,
    _drawing: false,
    _drawStart: { x: 0, y: 0 },
    _drawEnd: { x: 0, y: 0 },
  });
  seedAnnotations(queryClient, rows);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(noopContext());
}

async function mountCanvas(width = 200, height = 100) {
  const { container } = render(
    <AnnotationOverlay width={width} height={height} cssScale={1} />,
    { wrapper },
  );
  const canvas = await waitFor(() => {
    const candidate = container.querySelector("canvas");
    if (!(candidate instanceof HTMLCanvasElement)) {
      throw new Error("Expected AnnotationOverlay canvas");
    }
    return candidate;
  });
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(canvasRect(width, height));
  return canvas;
}

function press(canvas: HTMLCanvasElement, clientX: number, clientY: number): void {
  act(() => {
    fireEvent.mouseDown(canvas, { clientX, clientY, button: 0, detail: 1 });
  });
}

function moveTo(canvas: HTMLCanvasElement, clientX: number, clientY: number): void {
  act(() => {
    fireEvent.mouseMove(canvas, { clientX, clientY });
  });
}

function release(canvas: HTMLCanvasElement): void {
  act(() => {
    fireEvent.mouseUp(canvas);
  });
}

function drawingState() {
  const { _drawing, _drawStart, _drawEnd } = useToolStore.getState();
  return { _drawing, _drawStart, _drawEnd };
}

describe("markup gesture freeze (real overlay, production mousedown)", () => {
  afterEach(() => {
    cleanup();
    queryClient?.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("select press then br-corner press engages resize with anisotropic corner geometry", async () => {
    seedOverlayState([BOX]);
    const canvas = await mountCanvas(); // 200×100: br corner at (120,80); transposed would be (60,160)
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", vi.fn((cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    press(canvas, 80, 50); // interior → block-2 select
    press(canvas, 120, 80); // br corner handle → block-1 resize claim
    expect(parentMouseDown).not.toHaveBeenCalled(); // both presses stopPropagation

    moveTo(canvas, 140, 60); // resize drag: rAF-throttled updateAnnotation
    act(() => {
      frames.splice(0).forEach((frame) => frame(0));
    });
    const resized = readSeededAnnotations(queryClient).find((a) => a.id === BOX.id);
    // br resize: newBbox = [minX, minY, 140/200, 60/100] — anisotropic normalization
    expect(resized?.bbox).toEqual([0.2, 0.2, 0.7, 0.6]);
    // A drawing gesture never started anywhere in the chain.
    expect(drawingState()._drawing).toBe(false);
  });

  it("label-bar press deletes the selected markup, inclusive of the exact y = ay−18 edge", async () => {
    seedOverlayState([BOX]);
    const canvas = await mountCanvas();

    press(canvas, 80, 50); // select
    press(canvas, 60, 2); // label bar EXACT top edge: ay−18 = 20−18 = 2 (>= is load-bearing)
    expect(readSeededAnnotations(queryClient)).toHaveLength(0); // deleteSelected removed the row
    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(drawingState()._drawing).toBe(false);
  });

  it("label-bar press at the bottom edge y = ay deletes; selection itself is propagation-stopped and inert", async () => {
    seedOverlayState([BOX]);
    const canvas = await mountCanvas();

    press(canvas, 80, 50); // select: no removal, no drawing, no propagation
    expect(readSeededAnnotations(queryClient)).toHaveLength(1);
    expect(drawingState()._drawing).toBe(false);
    expect(parentMouseDown).not.toHaveBeenCalled();

    press(canvas, 60, 20); // label bar bottom edge y = ay (<= inclusive)
    expect(readSeededAnnotations(queryClient)).toHaveLength(0); // proves the select press took
  });

  it("one pixel above the label bar (y = ay−19) misses: no delete, deferred drawing starts instead", async () => {
    seedOverlayState([BOX]);
    const canvas = await mountCanvas();

    press(canvas, 80, 50); // select
    press(canvas, 60, 1); // outside label bar AND outside bbox (y/height = 0.01 < 0.2)
    expect(readSeededAnnotations(queryClient)).toHaveLength(1); // NOT deleted
    const drawing = drawingState();
    expect(drawing._drawing).toBe(true); // fell through to the empty-canvas block
    expect(drawing._drawStart).toEqual({ x: 60, y: 1 });
    expect(parentMouseDown).not.toHaveBeenCalled(); // block 3 also stops propagation
  });

  it("left of the label bar (x < ax) misses: no delete, deferred drawing starts instead", async () => {
    seedOverlayState([BOX]);
    const canvas = await mountCanvas();

    press(canvas, 80, 50); // select
    press(canvas, 39, 10); // x = 39 < ax = 40; also outside bbox (x/width = 0.195 < 0.2)
    expect(readSeededAnnotations(queryClient)).toHaveLength(1);
    expect(drawingState()._drawing).toBe(true);
  });

  it("empty-canvas gesture completes through legacy mouseup into the dialog and saves the exact anisotropic bbox", async () => {
    seedOverlayState([BOX]);
    const canvas = await mountCanvas();

    press(canvas, 150, 30); // outside bbox (x/width = 0.75 > 0.6)
    let drawing = drawingState();
    expect(drawing._drawing).toBe(true);
    expect(drawing._drawStart).toEqual({ x: 150, y: 30 });
    expect(drawing._drawEnd).toEqual({ x: 150, y: 30 });
    expect(parentMouseDown).not.toHaveBeenCalled();

    moveTo(canvas, 190, 90); // rubber-band: mousemove writes _drawEnd directly (no rAF)
    drawing = drawingState();
    expect(drawing._drawEnd).toEqual({ x: 190, y: 90 });

    release(canvas);
    expect(drawingState()._drawing).toBe(false);
    expect(screen.getByTestId("markup-freeze-dialog")).toBeInTheDocument();

    act(() => {
      dialogProps!.onNameChange("Freeze Markup");
    });
    act(() => {
      dialogProps!.onSave();
    });
    await waitFor(() => {
      const saved = readSeededAnnotations(queryClient).find((a) => a.name === "Freeze Markup");
      // pendingMarkup = [150/200, 30/100, 190/200, 90/100] — anisotropic min/max normalization
      expect(saved?.bbox).toEqual([0.75, 0.3, 0.95, 0.9]);
    });
    expect(screen.queryByTestId("markup-freeze-dialog")).not.toBeInTheDocument();
  });

  it("sub-1% gesture abandons silently: no dialog, drawing settled", async () => {
    seedOverlayState([]);
    const canvas = await mountCanvas();

    press(canvas, 150, 30);
    moveTo(canvas, 151, 30); // Δx = 0.005 < 0.01 min size (Δy = 0)
    release(canvas);
    expect(drawingState()._drawing).toBe(false);
    expect(screen.queryByTestId("markup-freeze-dialog")).not.toBeInTheDocument();
  });

  it("mode 'move' contrast: the same press is inert and does NOT stop propagation", async () => {
    seedOverlayState([BOX], "move");
    const canvas = await mountCanvas();

    press(canvas, 80, 50);
    expect(parentMouseDown).toHaveBeenCalledTimes(1); // nothing in the tail stops it
    expect(drawingState()._drawing).toBe(false);
    expect(readSeededAnnotations(queryClient)).toHaveLength(1);
    expect(useUiStore.getState().searchQuery).toBe(""); // pointer selection cascade never ran
  });

  it("a live specialized owner (calibration input phase) suppresses every markup block", async () => {
    seedOverlayState([BOX]);
    const canvas = await mountCanvas();
    act(() => {
      useToolStore.getState().setCalibrationMode("input"); // live calibration activation…
      // …which force-writes mode:"move" (toolStore modeDestination); restore the discriminating
      // markup mode so this witness pins the activeTool gate, not the mode gate.
      useToolStore.setState({ mode: "markup" });
    });

    press(canvas, 80, 50); // would be a markup select; calibration's input phase swallows instead
    expect(drawingState()._drawing).toBe(false);
    expect(readSeededAnnotations(queryClient)).toHaveLength(1);
    expect(parentMouseDown).toHaveBeenCalledTimes(1); // input phase swallow does NOT stopPropagation
    // No selection took: a label-bar press now (after clearing calibration) must NOT delete,
    // because selectedId was never set by the suppressed press.
    act(() => {
      useToolStore.setState({ activeTool: null, calibrationMode: "idle" });
    });
    press(canvas, 60, 11);
    expect(readSeededAnnotations(queryClient)).toHaveLength(1); // fell through to drawing, not delete
    expect(drawingState()._drawing).toBe(true);
  });

  it("invalidateToolTailAuthority runs for the activeTool===null press even on the non-drawing select path", async () => {
    seedOverlayState([BOX]);
    const canvas = await mountCanvas();
    const token = claimToolTailAuthority({});
    const cancelled = vi.fn();
    registerToolTailCancellation(token, cancelled);
    expect(ownsToolTailAuthority(token)).toBe(true);

    press(canvas, 80, 50); // block-2 select: touches NO tail authority itself
    expect(ownsToolTailAuthority(token)).toBe(false); // the pre-dispatch invalidation displaced it
    await act(async () => {
      await Promise.resolve(); // flush the queued microtask cancellation
    });
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
});

describe("markup seam topology pins (pre-move: three legacy blocks live in the overlay)", () => {
  const AO = readFileSync(
    join(process.cwd(), "src/components/viewer/AnnotationOverlay.tsx"),
    "utf8",
  );
  const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

  it("pins the three markup mousedown blocks present in the overlay", () => {
    expect(count(AO, "// Markup mode: check corners for resize or label for delete on selected")).toBe(1);
    expect(count(AO, "// Markup mode: check if clicking annotation to select")).toBe(1);
    expect(count(AO, "// Empty Markup canvas: capture the exact base-mode generation for mouseup.")).toBe(1);
    expect(count(AO, 'if (toolAtDown.mode !== "markup") return;')).toBe(1);
  });

  it("pins the context factory not yet carrying the markup capabilities", () => {
    expect(count(AO, "selection: {")).toBe(0);
    expect(count(AO, "deferredDrawing: {")).toBe(0);
  });
});
