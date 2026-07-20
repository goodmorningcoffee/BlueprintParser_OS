// [refactor jul18 P3.2] Generic parse rectangle starter — the terminal-claim half of the atomic
// keynotePick + parseRect extraction (pre-move AO:1864-1869 at parent 5fdf1c5). The retained
// AnnotationOverlay deferredDrawing composite owns the fresh semantic lease, selection clear,
// exact tail authority, and drawing publications. Its boolean was ignored by legacy code and is
// deliberately ignored here: even a rejected lease is a consumed parseRect press.
import type { ToolController } from "./types";

export const parseRectController: ToolController = Object.freeze({
  kind: "parseRect",
  // P3.4 registry gate: the controller now owns this production event eligibility predicate.
  wantsEvents: (state) => state.activeTool?.kind === "parseRect",
  matches: (press) => press.toolAtDown.activeTool?.kind === "parseRect",
  onMouseDown(event, context) {
    const { deferredDrawing } = context;
    if (!deferredDrawing) {
      throw new Error("parseRect controller requires the deferredDrawing capability");
    }
    event.stopPropagation();
    deferredDrawing.start(context.press.position);
    return true;
  },
} satisfies ToolController);
