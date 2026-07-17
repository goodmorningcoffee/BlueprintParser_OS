// [refactor jul17 P3.2] Takeoff linear tool controller — the FOURTH registered controller and
// the SECOND eligible-decline controller. Byte-for-semantics lift of the LINEAR identity of the
// legacy takeoffPlacement mousedown branch (pre-move AO:1789-1817 at parent 4ab0c6f).
//
// After the count extraction the legacy branch (AO:1753-1826) still served TWO controller
// identities discriminated by activeItem.shape — polygon and linear. Only the linear identity
// moves here; matches() is kind-only eligibility (takeoffItems is COMPONENT data, so the
// resolution cannot happen in matches), and onMouseDown resolves activeItem and DECLINES —
// return false with ZERO side effects — for !activeItem and every non-linear shape (count
// shapes fall through to the takeoffCount controller BEHIND this one in the registry),
// mirroring legacy's positive `shape === "linear"` check with its complement
// (TAKEOFF_LINEAR_IMPL/RECON_CENSUS.md §2). Decline-then-consumer stays single-execution:
// legacy WAS the prelude for polygon until its extraction, and takeoffCount re-runs the same
// prelude for count claims, so no press can double-invalidate or double-stop.
// [refactor jul17 P3.2 takeoffPolygon] Polygon presses now claim at takeoffPolygon AHEAD of
// this slot — this controller's polygon-decline is dead-but-honest and stays (the pairwise-
// disjoint claim partition keeps registry order unobservable).
//
// SPLIT CAPABILITY GUARD (SPEC §2.1, registry-integration constraint): the decline paths need
// only takeoffItems; takeoffDrawing is demanded AFTER the shape match, immediately before the
// first side effect. Registry-integration tests dispatch real takeoffPlacement presses through
// the live TOOLS tuple with synthetic contexts wired only for THEIR controller — an up-front
// guard on claim-path capabilities would turn this controller's eligible-decline into a throw.
// Canon for future interior inserts: decline paths must not demand claim-path capabilities.
//
// Reordering note (census §2, decline-before-side-effects proof): legacy ran the branch prelude
// (invalidate + stopPropagation) BEFORE the shape check; this controller checks shape BEFORE
// the prelude. The reordered steps are pure property reads on a plain data object — moving them
// across the two side effects is unobservable, and the claimed linear path is byte-identical
// after the prelude (same argument three reviewers verified for takeoffCount).
import { invalidateToolTailAuthority } from "@/lib/parse-tool-authority";

import type { ToolController } from "./types";

export const takeoffLinearController: ToolController = Object.freeze({
  kind: "takeoffLinear",
  // Render gate CANNOT discriminate shape (takeoffItems is component data, not ToolStoreState):
  // the canvas needs events for every takeoffPlacement activation regardless of which controller
  // ultimately claims the press. P3.4 scaffolding, production-unwired.
  wantsEvents: (state) => state.activeTool?.kind === "takeoffPlacement",
  matches: (press) => press.toolAtDown.activeTool?.kind === "takeoffPlacement",
  onMouseDown(event, context) {
    const { takeoffItems, takeoffDrawing } = context;
    if (!takeoffItems) {
      // Same fail-loud posture as the dispatcher's missing press/factory guard: a wired overlay
      // can never hit this; only a mis-built synthetic context can.
      throw new Error("takeoffLinear controller requires the takeoffItems capability");
    }
    const { toolAtDown, position } = context.press;
    const { width, height } = context.page;
    // Mirrors pre-move AO:1754. Same render-closure staleness as legacy: the capability carries
    // the component array (D1-class one-macrotask refresh lag, sanctioned — census §4).
    const activeItem = takeoffItems.find((t) => t.id === toolAtDown.activeTakeoffItemId);
    // ELIGIBLE-DECLINE, zero side effects (contract §4.2): the surviving legacy branch owns the
    // silent !activeItem return and the polygon identity; count shapes claim at the takeoffCount
    // controller behind this slot.
    if (!activeItem) return false;
    if (activeItem.shape !== "linear") return false;
    if (!takeoffDrawing) {
      // Claim-path capability, demanded only once the press is provably ours (split guard).
      throw new Error("takeoffLinear controller requires the takeoffDrawing capability");
    }

    // Claimed linear press: the branch prelude (pre-move AO:1756-1757) now runs exactly once, here.
    invalidateToolTailAuthority();
    event.stopPropagation();

    const normX = position.x / width;
    const normY = position.y / height;

    if (toolAtDown.polygonDrawingMode === "idle") {
      // Start new polyline. Publication order is pinned by LifecyclePublicationsFreeze: the mode
      // write is observable BEFORE the lifecycle fence, which fences out the vertex append.
      takeoffDrawing.setPolygonDrawingMode("drawing");
      // Legacy's bare `return` consumed the press (calibration precedent: claim mirrors it).
      if (!context.canAdoptProjectLifecycle()) return true;
      takeoffDrawing.addPolygonVertex({ x: normX, y: normY });
    } else if (toolAtDown.polygonDrawingMode === "drawing") {
      // Finish line: click within 10px of last vertex
      if (toolAtDown.polygonVertices.length >= 2) {
        const lastV = toolAtDown.polygonVertices[toolAtDown.polygonVertices.length - 1];
        const lastX = lastV.x * width;
        const lastY = lastV.y * height;
        const dist = Math.sqrt((position.x - lastX) ** 2 + (position.y - lastY) ** 2);
        if (dist < 10) {
          takeoffDrawing.saveLinearPolyline();
          return true;
        }
      }
      // Add vertex (skip on double-click second click)
      if (event.detail < 2) {
        takeoffDrawing.addPolygonVertex({ x: normX, y: normY });
      }
    }
    // Unconditional claim on every arm: a linear press must NEVER fall through to legacy — the
    // surviving branch would re-run the prelude (double-invalidate/double-stop).
    return true;
  },
} satisfies ToolController);
