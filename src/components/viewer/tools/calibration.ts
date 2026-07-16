// [refactor jul16 P3.2] Calibration tool controller — the FIRST registered controller.
// Byte-for-semantics lift of the legacy AnnotationOverlay mousedown branch (pre-move
// AO:1482-1508 at parent aee1644): kind-only eligibility, per-phase stopPropagation, page-space
// normalization by page width/height (NO cssScale — the legacy transient-zoom quirk is
// deliberately preserved), and an unconditional claim so any calibration activation swallows the
// press, input/idle phases included (which do NOT stop propagation). The store CAS
// (advanceCalibrationGesture) stays in toolStore; only the call site moved here.
import {
  advanceCalibrationGesture,
  type CalibrationActivation,
} from "@/stores/toolStore";

import type { ToolController } from "./types";

export const calibrationController: ToolController = Object.freeze({
  kind: "calibration",
  // Any phase: the input phase must keep receiving canvas events (it swallows presses), so the
  // render gate must never be narrower than the activation itself.
  wantsEvents: (state) => state.activeTool?.kind === "calibration",
  matches: (press) => press.toolAtDown.activeTool?.kind === "calibration",
  onMouseDown(event, context) {
    const { toolAtDown, position } = context.press;
    // Same pre-seam snapshot object the legacy branch used: the store CAS compares the
    // activation by REFERENCE, so it must come from press.toolAtDown, never a fresh getState().
    const activation = toolAtDown.activeTool as CalibrationActivation;
    const { width, height } = context.page;
    if (toolAtDown.calibrationMode === "point1") {
      event.stopPropagation();
      advanceCalibrationGesture(
        activation,
        "point1",
        "p1",
        { x: position.x / width, y: position.y / height },
        "point2",
      );
    } else if (toolAtDown.calibrationMode === "point2") {
      event.stopPropagation();
      advanceCalibrationGesture(
        activation,
        "point2",
        "p2",
        { x: position.x / width, y: position.y / height },
        "input",
      );
    }
    // Unconditional claim: input/idle phases swallow the press WITHOUT stopPropagation,
    // mirroring the legacy branch's terminal return.
    return true;
  },
} satisfies ToolController);
