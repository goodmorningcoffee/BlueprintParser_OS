// @vitest-environment jsdom
//
// [refactor jul16 P3.2] EXECUTABLE behavior freeze for the calibration mousedown gesture,
// landed test-only at parent 4fae226 BEFORE the calibration-controller extraction.
//
// Why this file exists (DR010 / P3.2 cross-check): the calibration overlay branch previously had
// NO executable oracle — parseToolAuthorityFreeze pins source TEXT, toolStoreActiveToolFreeze pins
// the store CAS, but nothing executed the branch. Its three load-bearing behaviors are frozen here
// through the PRODUCTION mousedown handler:
//   (1) per-phase-only stopPropagation — point1/point2 stop; input phase does NOT;
//   (2) unconditional consume — ANY calibration activation swallows the press (input phase
//       included), so the legacy selection cascade never runs while calibration is active.
//       NOTE (bite-proof finding): the branch's own trailing `return` is REDUNDANT with the
//       generic unhandled-activeTool guard (`if (activeTool !== null) return;`) that precedes the
//       pointer block — removing just the branch return is behavior-EQUIVALENT and correctly does
//       not fail this freeze. The witness pins the SWALLOW itself, which survives extraction via
//       dispatcher-claim and that guard;
//   (3) width/height normalization — pos.x/width, pos.y/height (anisotropic; NO cssScale).
// The store CAS (advanceCalibrationGesture guards) stays frozen in toolStoreActiveToolFreeze —
// not duplicated here.
//
// The final describe pins the PRE-move seam topology; the extraction commit rewrites ONLY that
// describe to the post-move topology (4-arg seam, branch absent, gesture calls in the controller).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { resetProjectData } from "@/stores/viewerCommands";
import { useToolStore } from "@/stores/toolStore";
import { useUiStore } from "@/stores/uiStore";
import { seedAnnotations } from "@/test/seed-annotations";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";
import type { ClientAnnotation } from "@/types";

vi.mock("../DrawingPreviewLayer", () => ({ default: () => null }));
vi.mock("../MarkupDialog", () => ({ default: () => null }));

import AnnotationOverlay from "../AnnotationOverlay";

const PUBLIC_ID = "calibration-fixture";

let queryClient: QueryClient;
const parentMouseDown = vi.fn();

// Parent div carries a React onMouseDown: e.stopPropagation() inside the overlay's synthetic
// handler must stop it; the input-phase swallow (no stopPropagation) must NOT.
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

function canvasRect(width = 100, height = 100): DOMRect {
  return {
    x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height,
    toJSON: () => ({}),
  } as DOMRect;
}

// Full-page takeoff bbox row: the unconditional-consume witness clicks directly over it.
const FULL_PAGE_BADGE = {
  id: 9,
  pageNumber: 1,
  name: "Fixture Consume",
  bbox: [0, 0, 1, 1],
  note: null,
  source: "takeoff",
  data: { type: "count-marker", takeoffItemId: 5, color: "#a855f7" },
} as unknown as ClientAnnotation;

function seedOverlayState(rows: ClientAnnotation[]): void {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  parentMouseDown.mockClear();
  resetProjectData();
  setViewerStoreStateForTest({
    projectId: 41,
    publicId: PUBLIC_ID,
    isDemo: true,
    pageNumber: 1,
    numPages: 1,
    pageNames: { 1: "A-101" },
    mode: "pointer",
    activeTool: null,
    _drawing: false,
    _drawStart: { x: 0, y: 0 },
    _drawEnd: { x: 0, y: 0 },
  });
  seedAnnotations(queryClient, rows);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(noopContext());
}

async function mountCanvas(width = 100, height = 100) {
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

describe("calibration gesture freeze (real overlay, production mousedown)", () => {
  afterEach(() => {
    cleanup();
    queryClient?.clear();
    vi.restoreAllMocks();
  });

  it("point1 -> point2 clicks advance the gesture with anisotropic width/height normalization and stopPropagation", async () => {
    seedOverlayState([]);
    const canvas = await mountCanvas(200, 100); // NON-SQUARE: transposition-discriminating
    act(() => {
      useToolStore.getState().setCalibrationMode("point1");
    });

    press(canvas, 60, 30); // p1 = {60/200, 30/100} = {0.3, 0.3}; transposed scaling would give {0.6, 0.15}
    let state = useToolStore.getState();
    expect(state.calibrationPoints.p1).toEqual({ x: 0.3, y: 0.3 });
    expect(state.calibrationMode).toBe("point2");
    expect(state.mode).toBe("move");
    expect(parentMouseDown).not.toHaveBeenCalled(); // point1 stopPropagation

    press(canvas, 180, 80); // p2 = {180/200, 80/100} = {0.9, 0.8}
    state = useToolStore.getState();
    expect(state.calibrationPoints.p2).toEqual({ x: 0.9, y: 0.8 });
    expect(state.calibrationMode).toBe("input");
    expect(parentMouseDown).not.toHaveBeenCalled(); // point2 stopPropagation
  });

  it("input phase swallows the press WITHOUT stopPropagation and WITHOUT running selection", async () => {
    seedOverlayState([FULL_PAGE_BADGE]);
    const canvas = await mountCanvas();
    act(() => {
      useToolStore.getState().setCalibrationMode("input");
      // Force the discriminating state: pointer mode WITH a live calibration activation. The
      // branch's unconditional return must swallow the press even here — without it, pointer
      // mode would let the press fall through to the selection cascade (which would setSearch).
      useToolStore.setState({ mode: "pointer" });
    });
    const pointsBefore = useToolStore.getState().calibrationPoints;

    press(canvas, 50, 50); // directly over the full-page annotation
    const state = useToolStore.getState();
    // No gesture advance in input phase.
    expect(state.calibrationPoints).toEqual(pointsBefore);
    expect(state.calibrationMode).toBe("input");
    // Unconditional consume: the selection cascade never ran (bbox loop would setSearch).
    expect(useUiStore.getState().searchQuery).toBe("");
    // NO stopPropagation in the input phase: the parent listener fires.
    expect(parentMouseDown).toHaveBeenCalledTimes(1);
  });

  it("contrast: with no calibration activation the same press falls through to selection", async () => {
    seedOverlayState([FULL_PAGE_BADGE]);
    const canvas = await mountCanvas();
    press(canvas, 50, 50);
    expect(useUiStore.getState().searchQuery).toBe("Fixture Consume");
  });
});

describe("calibration seam topology pins (pre-move; rewritten by the extraction commit)", () => {
  const AO = readFileSync(
    join(process.cwd(), "src/components/viewer/AnnotationOverlay.tsx"),
    "utf8",
  );
  const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

  it("pins the 2-arg empty-registry seam immediately followed by the legacy calibration branch", () => {
    expect(count(AO, "if (dispatchToolMouseDown(TOOLS, e)) return;")).toBe(1);
    expect(count(AO, "// Scale calibration mode")).toBe(1);
    // Two guards pre-move: the mousedown branch (leaves in the extraction) and the Escape
    // keydown branch (STAYS — out of P3.2 scope). Post-move this becomes 1.
    expect(count(AO, 'activeTool?.kind === "calibration"')).toBe(2);
  });

  it("pins the two gesture-advance call sites and per-phase stopPropagation in the overlay", () => {
    expect(count(AO, "advanceCalibrationGesture(")).toBe(2);
    // Each phase branch stops propagation before advancing; the trailing unconditional return
    // (outside both sub-branches) is the consume-without-stopPropagation seam for input/idle.
    expect(count(AO, 'toolAtDown.calibrationMode === "point1"')).toBe(1);
    expect(count(AO, 'toolAtDown.calibrationMode === "point2"')).toBe(1);
  });
});
