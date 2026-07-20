// [refactor jul18 P3.2] Symbol template rectangle starter (pre-move AO:1833-1838 at parent
// 5dec6c3). The retained AnnotationOverlay deferredDrawing composite owns fresh gesture/activation
// lease capture, default selection clear, exact tail authority, and drawing publications. Its
// boolean was ignored by the legacy branch, so even a rejected lease remains a consumed press.
import type { ToolController } from "./types";

export const symbolSearchController: ToolController = Object.freeze({
  kind: "symbolSearch",
  // P3.4 registry gate: the controller now owns this production event eligibility predicate.
  wantsEvents: (state) => state.activeTool?.kind === "symbolTemplate",
  matches: (press) => press.toolAtDown.activeTool?.kind === "symbolTemplate",
  onMouseDown(event, context) {
    const { deferredDrawing } = context;
    if (!deferredDrawing) {
      throw new Error(
        "symbolSearch controller requires the deferredDrawing capability",
      );
    }
    event.stopPropagation();
    deferredDrawing.start(context.press.position);
    return true;
  },
} satisfies ToolController);
