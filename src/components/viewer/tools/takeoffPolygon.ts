// [refactor jul17 P3.2] Takeoff polygon tool controller — the FIFTH registered controller and
// the THIRD eligible-decline controller. Byte-for-semantics lift of the POLYGON identity of the
// legacy takeoffPlacement mousedown branch (pre-move AO:1762-1790 at parent 7413d9e) — the LAST
// identity extracted from that branch. After registration 13, the separately proven residual
// skeleton was removed; null/stale ownership now converges on the common non-null-owner guard.
//
// matches() is kind-only eligibility (takeoffItems is COMPONENT data, so the resolution cannot
// happen in matches), and onMouseDown resolves activeItem and DECLINES — return false with ZERO
// side effects — for !activeItem and every non-polygon shape (linear claims at takeoffLinear and
// count shapes at takeoffCount, both BEHIND this slot in the registry), mirroring legacy's
// positive `shape === "polygon"` check with its complement. This insert makes takeoffLinear's
// and takeoffCount's polygon-declines dead for real presses — both STAY (honest partition; the
// five-way claim set is pairwise disjoint, so registry order remains unobservable).
//
// SPLIT CAPABILITY GUARD (S145 canon, SPEC §2): the decline paths need only takeoffItems;
// takeoffDrawing is demanded AFTER the shape match, immediately before the first side effect.
// Registry-integration tests dispatch real takeoffPlacement presses through the live TOOLS tuple
// with synthetic contexts wired only for THEIR controller — an up-front guard on claim-path
// capabilities would turn this controller's eligible-decline into a throw.
//
// Reordering note (same argument three reviewers verified for count and linear): legacy ran the
// branch prelude (invalidate + stopPropagation) BEFORE the shape check; this controller checks
// shape BEFORE the prelude. The reordered steps are pure property reads on a plain data object —
// moving them across the two side effects is unobservable, and the claimed polygon path is
// byte-identical after the prelude.
//
// ⚠️ The drawing arm has NO lifecycle fence between the prelude and savePolygon() (census §1):
// savePolygon's own canAdopt gate is the only barrier, and adding one here would be a behavior
// change. The idle arm's fence sits between the mode write and the vertex append, exactly as
// LifecyclePublicationsFreeze pins it.
import { invalidateToolTailAuthority } from "@/lib/parse-tool-authority";

import type { ToolController } from "./types";

export const takeoffPolygonController: ToolController = Object.freeze({
  kind: "takeoffPolygon",
  // Render gate CANNOT discriminate shape (takeoffItems is component data, not ToolStoreState):
  // the canvas needs events for every takeoffPlacement activation regardless of which controller
  // ultimately claims the press. P3.4 wires this overlap into the production registry gate.
  wantsEvents: (state) => state.activeTool?.kind === "takeoffPlacement",
  matches: (press) => press.toolAtDown.activeTool?.kind === "takeoffPlacement",
  onMouseDown(event, context) {
    const { takeoffItems, takeoffDrawing } = context;
    if (!takeoffItems) {
      // Same fail-loud posture as the dispatcher's missing press/factory guard: a wired overlay
      // can never hit this; only a mis-built synthetic context can.
      throw new Error("takeoffPolygon controller requires the takeoffItems capability");
    }
    const { toolAtDown, position } = context.press;
    const { width, height } = context.page;
    // Mirrors pre-move AO:1757. Same render-closure staleness as legacy: the capability carries
    // the component array (D1-class one-macrotask refresh lag, sanctioned).
    const activeItem = takeoffItems.find((t) => t.id === toolAtDown.activeTakeoffItemId);
    // ELIGIBLE-DECLINE, zero side effects: null/stale items flow through the trio to the common
    // non-null-owner guard; linear and count claim behind this slot.
    if (!activeItem) return false;
    if (activeItem.shape !== "polygon") return false;
    if (!takeoffDrawing) {
      // Claim-path capability, demanded only once the press is provably ours (split guard).
      throw new Error("takeoffPolygon controller requires the takeoffDrawing capability");
    }

    // Claimed polygon press: the branch prelude (pre-move AO:1759-1760) now runs exactly once, here.
    invalidateToolTailAuthority();
    event.stopPropagation();

    const normX = position.x / width;
    const normY = position.y / height;

    if (toolAtDown.polygonDrawingMode === "idle") {
      // Start new polygon. Publication order is pinned by LifecyclePublicationsFreeze: the mode
      // write is observable BEFORE the lifecycle fence, which fences out the vertex append.
      takeoffDrawing.setPolygonDrawingMode("drawing");
      // Legacy's bare `return` consumed the press (calibration precedent: claim mirrors it).
      if (!context.canAdoptProjectLifecycle()) return true;
      takeoffDrawing.addPolygonVertex({ x: normX, y: normY });
    } else if (toolAtDown.polygonDrawingMode === "drawing") {
      // Check snap-to-first-point to close (>= 3 vertices required)
      if (toolAtDown.polygonVertices.length >= 3) {
        const firstV = toolAtDown.polygonVertices[0];
        const firstX = firstV.x * width;
        const firstY = firstV.y * height;
        const dist = Math.sqrt((position.x - firstX) ** 2 + (position.y - firstY) ** 2);
        if (dist < 15) {
          takeoffDrawing.savePolygon();
          return true;
        }
      }
      // Add vertex (skip on double-click second click)
      if (event.detail < 2) {
        takeoffDrawing.addPolygonVertex({ x: normX, y: normY });
      }
    }
    // Unconditional claim on every arm: the controller is the sole resolved-polygon owner and must
    // terminate registry traversal after its prelude/work, before the common owner guard.
    return true;
  },
} satisfies ToolController);
