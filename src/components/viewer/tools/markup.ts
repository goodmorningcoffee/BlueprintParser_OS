// [refactor jul16 P3.2] Markup tool controller — the SECOND registered controller and the first
// prover of capabilities beyond press/page. Byte-for-semantics lift of the three legacy markup
// mousedown blocks (pre-move AO:2283–2328 at parent d122c3e) PLUS the pre-dispatch
// invalidateToolTailAuthority() (pre-move AO:1957) that every activeTool===null press executed
// before mode dispatch — the registry claim now happens before that line, so the call moves here.
//
// Eligibility is the exact reachability conjunction (MARKUP_IMPL/RECON_CENSUS.md): the
// pointer/group block always returns, so the legacy markup blocks ran IFF activeTool === null
// AND mode === "markup". Every markup-mode press terminates in this region with exactly one
// stopPropagation — hence the unconditional claim on every path.
//
// The label bar here is the SIMPLE markup variant (delete only — no pencil zone, no canvas text
// measurement). The pointer block's rich label logic deliberately stays in AnnotationOverlay;
// conflating the two variants is the #1 semantic trap of this extraction.
import { invalidateToolTailAuthority } from "@/lib/parse-tool-authority";

import { pointInHandle, pointInNormalizedBbox } from "../hitTest";
import type { ToolController } from "./types";

// Mirrors AnnotationOverlay's component-local HANDLE (corner handle size in CSS px), which stays
// in the overlay for the pointer block's handles. The value is part of this controller's frozen
// geometry contract (MarkupGestureFreeze + MarkupControllerFreeze).
const HANDLE = 8;

export const markupController: ToolController = Object.freeze({
  kind: "markup",
  // Render gate mirrors the live canvas-interactivity slice for markup: base markup interaction
  // requires NO specialized owner. P3.4 scaffolding, production-unwired.
  wantsEvents: (state) => state.activeTool === null && state.mode === "markup",
  matches: (press) =>
    press.toolAtDown.activeTool === null && press.toolAtDown.mode === "markup",
  onMouseDown(event, context) {
    const { selection, pageAnnotations, deferredDrawing } = context;
    if (!selection || !pageAnnotations || !deferredDrawing) {
      // Same fail-loud posture as the dispatcher's missing press/factory guard: a wired overlay
      // can never hit this; only a mis-built synthetic context can.
      throw new Error(
        "markup controller requires the selection/pageAnnotations/deferredDrawing capabilities",
      );
    }
    const { position } = context.press;
    const { width, height } = context.page;
    // Mirrors pre-move AO:1957 (see header). Must run on EVERY markup-mode press, the
    // non-drawing select path included — MarkupGestureFreeze witnesses it there.
    invalidateToolTailAuthority();

    // Markup mode: check corners for resize or label for delete on selected
    if (selection.selectedId !== null) {
      const selAnn = pageAnnotations.find((a) => a.id === selection.selectedId);
      if (selAnn) {
        const [minX, minY, maxX, maxY] = selAnn.bbox;
        const corners = {
          tl: { x: minX * width, y: minY * height },
          tr: { x: maxX * width, y: minY * height },
          bl: { x: minX * width, y: maxY * height },
          br: { x: maxX * width, y: maxY * height },
        };

        for (const [key, corner] of Object.entries(corners)) {
          if (pointInHandle(position, corner, HANDLE)) {
            if (!context.annotationDrag) {
              throw new Error("markup corner resize requires the annotationDrag capability");
            }
            event.stopPropagation();
            if (!context.annotationDrag.beginBBox(selAnn, key)) return true;
            selection.setResizeCorner(key);
            selection.setDragging(true);
            return true;
          }
        }

        const ax = minX * width;
        const ay = minY * height;
        if (position.y >= ay - 18 && position.y <= ay && position.x >= ax) {
          event.stopPropagation();
          selection.deleteSelected();
          return true;
        }
      }
    }

    // Markup mode: check if clicking annotation to select
    for (const ann of pageAnnotations) {
      if (pointInNormalizedBbox(position, ann.bbox, width, height)) {
        event.stopPropagation();
        selection.setSelectedId(ann.id);
        return true;
      }
    }

    // Empty Markup canvas: capture the exact base-mode generation for mouseup.
    event.stopPropagation();
    deferredDrawing.start(position);
    return true;
  },
} satisfies ToolController);
