// [refactor jul18 P3.2] Keynote YOLO picker — the eligible-decline half of the atomic
// keynotePick + parseRect extraction (pre-move AO:1777-1794 at parent 5fdf1c5).
//
// Eligibility comes from the admitted press snapshot, while `keynotePick.active` is the exact
// AnnotationOverlay render projection built from its conditional keynote subscriptions. Do not
// replace that projection with a fresh parse-store read: its render-captured timing is legacy
// behavior. An active miss has zero picker-owned effects and delegates to parseRect in the same
// registry dispatch.
import { invalidateToolTailAuthority } from "@/lib/parse-tool-authority";
import { setKeynoteManualInputsForUser } from "@/stores/viewerCommands";

import type { ToolController } from "./types";

export const keynotePickController: ToolController = Object.freeze({
  kind: "keynotePick",
  // P3.4 registry gate. This deliberate overlap with parseRect is boolean-idempotent.
  wantsEvents: (state) =>
    state.activeTool?.kind === "parseRect" && state.activeTool.flow === "keynote",
  matches: (press) =>
    press.toolAtDown.activeTool?.kind === "parseRect" &&
    press.toolAtDown.activeTool.flow === "keynote",
  onMouseDown(event, context) {
    // Split guard: inactive picking declines before requiring the candidate projection. This is
    // what lets every ordinary keynote rectangle reach parseRect without over-wiring context.
    if (!context.keynotePick?.active) return false;
    const { pageAnnotations } = context;
    if (!pageAnnotations) {
      throw new Error(
        "keynotePick controller requires pageAnnotations while its render projection is active",
      );
    }

    const clickNormX = context.press.position.x / context.page.width;
    const clickNormY = context.press.position.y / context.page.height;
    for (const annotation of pageAnnotations) {
      if (annotation.source !== "yolo") continue;
      const [minX, minY, maxX, maxY] = annotation.bbox;
      if (
        clickNormX >= minX && clickNormX <= maxX &&
        clickNormY >= minY && clickNormY <= maxY
      ) {
        invalidateToolTailAuthority();
        event.stopPropagation();
        const model = annotation.data?.modelName || "unknown";
        setKeynoteManualInputsForUser({
          keynoteYoloClass: { model, className: annotation.name },
        });
        return true;
      }
    }

    return false;
  },
} satisfies ToolController);
