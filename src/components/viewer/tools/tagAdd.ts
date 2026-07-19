// [refactor jul19 P3.2] TagAdd deferred-rectangle starter. The shared overlay composite retains
// rectangle admission and settlement; this controller owns only the terminal mousedown claim.
import type { ToolController } from "./types";

export const tagAddController: ToolController = Object.freeze({
  kind: "tagAdd",
  wantsEvents: (state) => state.activeTool?.kind === "tagAdd",
  matches: (press) => press.toolAtDown.activeTool?.kind === "tagAdd",
  onMouseDown(event, context) {
    const { deferredDrawing } = context;
    if (!deferredDrawing) {
      throw new Error("tagAdd controller requires the deferredDrawing capability");
    }
    event.stopPropagation();
    deferredDrawing.start(context.press.position);
    return true;
  },
} satisfies ToolController);
