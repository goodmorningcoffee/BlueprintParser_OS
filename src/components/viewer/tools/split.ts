// [refactor jul19 P3.2] Split Area mousedown controller. The two-click gesture landed first as a
// byte-for-semantics lift; a separately frozen guard now rejects holed winning targets before the
// preview. Acceptance, persistence, Enter/Escape, page cleanup, and rendering remain shared
// AnnotationOverlay/DrawingPreviewLayer surfaces under ACCEPT-PARTIAL.
//
// Every matched press claims. In particular, preview-open and a lifecycle rejected after B are
// terminal true; returning false would be masked by the overlay's generic active-tool tail while
// still violating registry ownership. The admitted press snapshot supplies both line A and the
// render-projected annotation candidates—fresh store/cache reads would change legacy timing.
import { invalidateToolTailAuthority } from "@/lib/parse-tool-authority";
import { findSplittablePolygons } from "@/lib/polygon-split";
import type { AreaPolygonData } from "@/types";

import type { ToolController } from "./types";

const NO_CANDIDATE_MESSAGE =
  "Line does not cross any area polygon in exactly 2 places";
export const SPLIT_HOLED_TARGET_MESSAGE =
  "Area polygons with holes cannot be split yet";

export const splitController: ToolController = Object.freeze({
  kind: "split",
  wantsEvents: (state) => state.activeTool?.kind === "split",
  matches: (press) => press.toolAtDown.activeTool?.kind === "split",
  onMouseDown(event, context) {
    event.stopPropagation();

    const { toolAtDown, position } = context.press;
    const normX = position.x / context.page.width;
    const normY = position.y / context.page.height;

    // An existing preview is settled only through Accept/Cancel. This terminal partition must
    // remain before the capability guard and tail invalidation.
    if (toolAtDown.splitPreview) return true;

    const { split } = context;
    if (!split) {
      throw new Error("split controller requires the split capability");
    }

    if (!toolAtDown.splitLineA) {
      invalidateToolTailAuthority();
      split.setLineEndpoint("a", { x: normX, y: normY });
      return true;
    }

    // Second click: B publishes before the reentrant lifecycle fence, exactly as the parent did.
    invalidateToolTailAuthority();
    const pointB = { x: normX, y: normY };
    split.setLineEndpoint("b", pointB);
    if (!context.canAdoptProjectLifecycle()) return true;

    const { pageAnnotations } = context;
    if (!pageAnnotations) {
      throw new Error(
        "split controller requires pageAnnotations after its second-click lifecycle fence",
      );
    }

    const polyAnnotations = pageAnnotations.filter(
      (annotation) =>
        annotation.source === "takeoff" &&
        (annotation.data as AreaPolygonData)?.type === "area-polygon",
    );
    const candidates = findSplittablePolygons(
      toolAtDown.splitLineA,
      pointB,
      polyAnnotations.map((annotation) => ({
        id: annotation.id,
        vertices: (annotation.data as AreaPolygonData).vertices,
      })),
    );

    if (candidates.length === 0) {
      split.publishError(NO_CANDIDATE_MESSAGE, 3500);
      return true;
    }

    // The helper sorts descending: the longest chord is the intended target.
    const best = candidates[0];
    const hitAnnotation = polyAnnotations.find(
      (annotation) => annotation.id === best.id,
    )!;
    const hitData = hitAnnotation.data as AreaPolygonData;
    if ((hitData.holes?.length ?? 0) > 0) {
      split.publishError(SPLIT_HOLED_TARGET_MESSAGE, 5000);
      return true;
    }
    split.setPreview({
      targetAnnotationId: best.id,
      original: hitData.vertices,
      left: best.left,
      right: best.right,
      lineA: toolAtDown.splitLineA,
      lineB: pointB,
    });
    return true;
  },
} satisfies ToolController);
