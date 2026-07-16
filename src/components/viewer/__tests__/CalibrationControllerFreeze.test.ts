// @vitest-environment node
//
// [refactor jul16 P3.2] Direct behavioral contract for calibrationController — the review
// correction closing three probe-proven holes that the overlay-level witnesses cannot see
// (the generic unhandled-activeTool guard downstream masks controller-level regressions):
//   1. input-phase eligibility + terminal claim (matches true; onMouseDown returns true with NO
//      stopPropagation and NO gesture call) — previously only a brittle source-text pin;
//   2. the CAS activation SOURCE: the gesture must receive the CAPTURED press.toolAtDown
//      activation, never a fresh getState() — enforced by arranging live-store !== captured;
//   3. wantsEvents (P3.4 render-gate scaffolding, unwired at this HEAD): kind-only, any phase.

import type { MouseEvent as ReactMouseEvent } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useToolStore } from "@/stores/toolStore";
import type { ToolStoreState } from "@/stores/toolStore";
import { calibrationController } from "../tools/calibration";
import { TOOL_STORE_CAPABILITIES } from "../tools/capabilities";
import type { ToolContext, ToolPressSnapshot } from "../tools/types";

function mockEvent() {
  return { stopPropagation: vi.fn() } as unknown as ReactMouseEvent & {
    stopPropagation: ReturnType<typeof vi.fn>;
  };
}

function contextFor(
  toolAtDown: Readonly<ToolStoreState>,
  position: { x: number; y: number },
  page = { publicId: "ctl-fixture", number: 1, width: 200, height: 100 },
): ToolContext {
  const press: ToolPressSnapshot = {
    toolAtDown,
    position,
    publicId: page.publicId,
    pageNumber: page.number,
  };
  return {
    press,
    page,
    stores: TOOL_STORE_CAPABILITIES,
    canAdoptProjectLifecycle: () => true,
  };
}

beforeEach(() => {
  useToolStore.setState({
    activeTool: null,
    mode: "move",
    calibrationMode: "idle",
    calibrationPoints: {},
  });
});

describe("calibrationController mousedown contract", () => {
  it("point1 press advances the gesture: stopPropagation, anisotropic normalization, claim", () => {
    useToolStore.getState().setCalibrationMode("point1");
    const toolAtDown = useToolStore.getState();
    const event = mockEvent();

    const claimed = calibrationController.onMouseDown(
      event,
      contextFor(toolAtDown, { x: 60, y: 30 }), // 200x100 page: {0.3, 0.3}; transposed would be {0.6, 0.15}
    );

    expect(claimed).toBe(true);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    const state = useToolStore.getState();
    expect(state.calibrationPoints.p1).toEqual({ x: 0.3, y: 0.3 });
    expect(state.calibrationMode).toBe("point2");
  });

  it("input phase: eligible, claims WITHOUT stopPropagation and WITHOUT advancing the gesture", () => {
    useToolStore.getState().setCalibrationMode("input");
    const toolAtDown = useToolStore.getState();
    const event = mockEvent();
    const pointsBefore = toolAtDown.calibrationPoints;

    expect(calibrationController.matches(contextFor(toolAtDown, { x: 5, y: 5 }).press)).toBe(true);
    const claimed = calibrationController.onMouseDown(
      event,
      contextFor(toolAtDown, { x: 5, y: 5 }),
    );

    expect(claimed).toBe(true); // terminal claim, input phase included
    expect(event.stopPropagation).not.toHaveBeenCalled();
    const state = useToolStore.getState();
    expect(state.calibrationPoints).toEqual(pointsBefore);
    expect(state.calibrationMode).toBe("input");
  });

  it("passes the CAPTURED activation to the CAS, never a fresh getState()", () => {
    useToolStore.getState().setCalibrationMode("point1");
    const toolAtDown = useToolStore.getState(); // captured snapshot; activation C
    // Replace the LIVE activation with a different object of identical shape. A controller that
    // re-reads getState() would pass the live activation and the CAS would ADVANCE; the captured
    // activation must make the CAS no-op (state.activeTool !== expectedActivation).
    const captured = toolAtDown.activeTool;
    useToolStore.setState({
      activeTool: { ...(captured as object) } as typeof captured,
    });
    const event = mockEvent();

    const claimed = calibrationController.onMouseDown(
      event,
      contextFor(toolAtDown, { x: 60, y: 30 }),
    );

    expect(claimed).toBe(true); // the claim is unconditional either way
    const state = useToolStore.getState();
    expect(state.calibrationPoints.p1).toBeUndefined(); // CAS no-op proves the captured source
    expect(state.calibrationMode).toBe("point1");
  });

  it("is not eligible without a calibration activation", () => {
    const toolAtDown = useToolStore.getState(); // activeTool null
    expect(calibrationController.matches(contextFor(toolAtDown, { x: 1, y: 1 }).press)).toBe(false);
  });
});

describe("calibrationController.wantsEvents (P3.4 render-gate scaffolding)", () => {
  it("is kind-only across every phase and false without the activation", () => {
    for (const calibrationMode of ["point1", "point2", "input"] as const) {
      useToolStore.getState().setCalibrationMode(calibrationMode);
      expect(calibrationController.wantsEvents(useToolStore.getState())).toBe(true);
    }
    useToolStore.setState({ activeTool: null });
    expect(calibrationController.wantsEvents(useToolStore.getState())).toBe(false);
  });
});
