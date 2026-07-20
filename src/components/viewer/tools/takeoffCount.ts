// [refactor jul17 P3.2] Takeoff count tool controller — the THIRD registered controller, the
// first RAW-MUTATION prover (persistCreate via the narrowed mutations capability), and the
// registry's first ELIGIBLE-DECLINE controller. Byte-for-semantics lift of the COUNT identity of
// the legacy takeoffPlacement mousedown branch (pre-move AO:1813-1862 at parent 967116c).
//
// The original legacy branch (AO:1746-1863) served THREE controller identities discriminated by
// activeItem.shape — polygon / linear / count-as-residual-else. All three identities are now
// extracted. This controller owns count; matches() remains kind-only eligibility
// (activeTakeoffItemId lives in the press, but takeoffItems is COMPONENT data, so resolution
// cannot happen in matches), and onMouseDown retains honest zero-side-effect declines for
// !activeItem / polygon / linear. The polygon/linear controllers normally claim those identities
// earlier in registry order; an unresolved item remains effect-cold through the trio and reaches
// AnnotationOverlay's common non-null-owner guard.
//
// Reordering note (census, decline-before-side-effects proof): legacy ran the prelude BEFORE the
// shape checks; this controller checks shape BEFORE the prelude. The reordered steps are two pure
// property reads on a plain data object — moving them across the two side effects is
// unobservable, and the claimed count path is byte-identical after the prelude.
import { invalidateToolTailAuthority } from "@/lib/parse-tool-authority";
import type { CountMarkerData } from "@/types";

import type { ToolController } from "./types";

export const takeoffCountController: ToolController = Object.freeze({
  kind: "takeoffCount",
  // Render gate CANNOT discriminate shape (takeoffItems is component data, not ToolStoreState):
  // the canvas needs events for every takeoffPlacement activation regardless of which controller
  // ultimately claims the press. P3.4 wires this overlap into the production registry gate.
  wantsEvents: (state) => state.activeTool?.kind === "takeoffPlacement",
  matches: (press) => press.toolAtDown.activeTool?.kind === "takeoffPlacement",
  onMouseDown(event, context) {
    const { takeoffItems, selection, pageAnnotations, mutations, transientError } = context;
    if (!takeoffItems) {
      // Same fail-loud posture as the dispatcher's missing press/factory guard: a wired overlay
      // can never hit this; only a mis-built synthetic context can. The remaining capabilities
      // are claim-only and are deliberately guarded after the identity partition below.
      throw new Error(
        "takeoffCount controller requires the takeoffItems/selection/pageAnnotations/mutations/transientError capabilities",
      );
    }
    const { toolAtDown, position } = context.press;
    const { width, height } = context.page;
    // Mirrors pre-move AO:1748. Same render-closure staleness as legacy: the capability carries
    // the component array (D1-class one-macrotask refresh lag, sanctioned — census), NOT a fresh
    // cache read.
    const activeItem = takeoffItems.find((t) => t.id === toolAtDown.activeTakeoffItemId);
    // ELIGIBLE-DECLINE, zero side effects (contract §4.2): polygon/linear are normally claimed by
    // earlier controllers, but these direct partition checks remain ordering-robust. A silent
    // !activeItem decline flows to the common non-null-owner guard with no fallback effects.
    if (!activeItem) return false;
    if (activeItem.shape === "polygon" || activeItem.shape === "linear") return false;

    if (!selection || !pageAnnotations || !mutations || !transientError) {
      throw new Error(
        "takeoffCount controller requires the takeoffItems/selection/pageAnnotations/mutations/transientError capabilities",
      );
    }

    // Claimed count press: the branch prelude (pre-move AO:1750-1751) now runs exactly once, here.
    invalidateToolTailAuthority();
    event.stopPropagation();

    // Check if clicking existing count marker → select it
    for (const ann of pageAnnotations) {
      if (ann.source !== "takeoff") continue;
      const [minX, minY, maxX, maxY] = ann.bbox;
      const cx = ((minX + maxX) / 2) * width;
      const cy = ((minY + maxY) / 2) * height;
      const dist = Math.sqrt((position.x - cx) ** 2 + (position.y - cy) ** 2);
      if (dist < 14) {
        selection.setSelectedId(ann.id);
        return true;
      }
    }

    // Place new marker
    const normX = position.x / width;
    const normY = position.y / height;
    const hs = 0.005;
    const bbox: [number, number, number, number] = [
      Math.max(0, normX - hs),
      Math.max(0, normY - hs),
      Math.min(1, normX + hs),
      Math.min(1, normY + hs),
    ];

    const markerData: CountMarkerData = {
      type: "count-marker",
      shape: activeItem.shape,
      color: activeItem.color,
      takeoffItemId: activeItem.id,
    };

    // [refactor jul11 P2.2⑥ C4] Count markers use the same optimistic-create seam as
    // polygons and lines; tool-specific failure text/timing remains local to this caller.
    void mutations.annotations.persistCreate({
      pageNumber: context.page.number,
      name: activeItem.name,
      bbox,
      source: "takeoff",
      data: markerData as unknown as Record<string, unknown>,
    }, {
      canAdopt: context.canAdoptProjectLifecycle,
      onError: (err) => {
        transientError.publish(
          err instanceof Error ? `Failed to save marker: ${err.message}` : "Failed to save marker",
        );
      },
    });

    return true;
  },
} satisfies ToolController);
