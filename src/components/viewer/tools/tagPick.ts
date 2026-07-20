// [refactor jul18 P3.2] YOLO class picker + project-scoped scan request (pre-move AO:1779-1831
// at parent 0a07548). Both hit and miss are terminal claims. The mounted overlay retains the raw
// AbortController ref so request identity cannot leak across instances; the named helper keeps
// typed transport ownership visible to the I/O topology oracle.
import { requestMapTagsBatch } from "@/lib/client-map-tags";
import type { ClientAnnotation } from "@/types";

import type { ToolContext, ToolController } from "./types";

type TagPickCapabilities = NonNullable<ToolContext["tagPick"]>;

function startTagScan(
  annotation: ClientAnnotation,
  yoloModel: string,
  context: ToolContext,
  capability: TagPickCapabilities,
): void {
  const store = context.stores.tool.getState();
  const session = context.stores.session.getState();
  store.setYoloTagPickingMode(false);

  // Trigger class scan — request all unique texts inside this class.
  const pid = session.publicId;
  const yoloClass = annotation.name;
  if (!pid) return;
  capability.scanControllerRef.current?.abort();
  const controller = new AbortController();
  capability.scanControllerRef.current = controller;
  requestMapTagsBatch(
    pid,
    { action: "scanClass", yoloClass, yoloModel },
    { signal: controller.signal },
  )
    .then((result) => {
      if (!result.ok) throw new Error(`HTTP ${result.status}`);
      return result.data;
    })
    .then(({ texts }) => {
      if (
        capability.scanControllerRef.current !== controller ||
        controller.signal.aborted
      ) return;
      if (context.stores.session.getState().publicId !== pid) return;
      if (!context.canAdoptProjectLifecycle()) return;
      context.stores.tool.getState().setTagScanResults({
        yoloClass,
        yoloModel,
        texts: texts || [],
      });
    })
    .catch((err) => {
      if ((err as Error).name === "AbortError") return;
      if (capability.scanControllerRef.current !== controller) return;
      if (!context.canAdoptProjectLifecycle()) return;
      console.error("[YOLO_TAG] Class scan failed:", err);
    });
}

export const tagPickController: ToolController = Object.freeze({
  kind: "tagPick",
  // P3.4 registry gate: the controller now owns this production event eligibility predicate.
  wantsEvents: (state) => state.activeTool?.kind === "tagPick",
  matches: (press) => press.toolAtDown.activeTool?.kind === "tagPick",
  onMouseDown(event, context) {
    const { pageAnnotations, tagPick } = context;
    if (!pageAnnotations) {
      throw new Error("tagPick controller requires pageAnnotations");
    }
    if (!tagPick) {
      throw new Error("tagPick controller requires its request capability");
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
        event.stopPropagation();
        const yoloModel = (annotation as any).data?.modelName as string || "unknown";
        startTagScan(annotation, yoloModel, context, tagPick);
        return true;
      }
    }

    tagPick.setPickingMode(false);
    return true;
  },
} satisfies ToolController);
