// @vitest-environment node
//
// [refactor jul17 P3.2] Direct behavioral contract for takeoffPolygonController, landed IN the
// registration commit (S143 canon: the post-extraction overlay tail is inert, so overlay
// witnesses are structurally blind to claim-value regressions — only this net can see a
// partial-claim fallthrough). Pins:
//   1. eligibility is EXACTLY activeTool?.kind === "takeoffPlacement" (kind-only: takeoffItems
//      is component data, so activeItem resolution CANNOT happen in matches);
//   2. the SPLIT capability guard (S145 canon): takeoffItems fails loudly on every eligible
//      press, but takeoffDrawing is demanded ONLY on a claimed polygon press — a declined press
//      must run to its FALSE even when the claim-path capability is absent, because registry
//      integration dispatches other controllers' synthetic contexts through this slot (this
//      controller sits AHEAD of takeoffLinear AND takeoffCount);
//   3. the ELIGIBLE-DECLINE contract — !activeItem / linear / count shapes return FALSE with
//      ZERO side effects (no stopPropagation, no tail invalidation, no capability call);
//   4. the idle arm: mode write BEFORE the lifecycle fence BEFORE the vertex append (exact
//      publication order — LifecyclePublicationsFreeze pins it through the real overlay, this
//      net pins it at the unit level via a call journal), props-normalized vertex;
//   5. the fence: canAdopt false still CLAIMS (legacy's bare return consumed the press) with the
//      mode written and NO vertex;
//   6. the drawing arm: strict-<15 close snap to the FIRST vertex's anisotropic pixel position
//      gated on >= 3 vertices — fixtures sit in the (14,15) band plus the DIAGONAL 9-12-15
//      boundary pair (S145 metric canon) so widening, narrowing, AND metric drifts bite; the
//      close calls savePolygon exactly once and never appends; a press beside the LAST vertex
//      far from the FIRST appends (the polygon/linear anchor discriminator);
//   7. the e.detail >= 2 silent consume (no save, no append, still TRUE + prelude);
//   8. claim === true on EVERY arm with stopPropagation exactly once and tail invalidation;
//   9. wantsEvents (P3.4 production registry gate): kind gate both directions;
//  10. registry integration through the real TOOLS tuple: a polygon press claims AT
//      takeoffPolygon; a linear press falls THROUGH this slot to takeoffLinear (witnessed at the
//      linear FINISH, which this controller's >= 3 gate could never produce); a count press
//      falls through BOTH declines to takeoffCount. The all-decline FALSE witness lives in
//      TakeoffCountControllerFreeze (retargeted to !activeItem at this registration).

import type { MouseEvent as ReactMouseEvent } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  claimToolTailAuthority,
  ownsToolTailAuthority,
} from "@/lib/parse-tool-authority";
import type { NewAnnotationDraft, PersistCreateOptions } from "@/queries/useAnnotations";
import type { ToolStoreState } from "@/stores/toolStore";
import type { ClientTakeoffItem } from "@/types";
import { takeoffPolygonController } from "../tools/takeoffPolygon";
import { TOOLS, dispatchToolMouseDown } from "../tools/registry";
import { TOOL_STORE_CAPABILITIES } from "../tools/capabilities";
import type { ToolContext, ToolPressSnapshot } from "../tools/types";

function mockEvent(detail = 1) {
  return { stopPropagation: vi.fn(), detail } as unknown as ReactMouseEvent & {
    stopPropagation: ReturnType<typeof vi.fn>;
  };
}

function toolState(
  overrides: Partial<{
    activeTool: unknown;
    activeTakeoffItemId: number | null;
    polygonDrawingMode: "idle" | "drawing";
    polygonVertices: { x: number; y: number }[];
  }> = {},
): Readonly<ToolStoreState> {
  return {
    activeTool: { kind: "takeoffPlacement" },
    activeTakeoffItemId: 6,
    mode: "pointer",
    polygonDrawingMode: "idle",
    polygonVertices: [],
    ...overrides,
  } as unknown as Readonly<ToolStoreState>;
}

function item(over: Partial<ClientTakeoffItem> & { id: number }): ClientTakeoffItem {
  return { name: "Flooring", shape: "polygon", color: "#3b82f6", size: 10, sortOrder: 0, groupId: null, ...over };
}

// Non-square 200×100 default page — every geometry pin is transposition-discriminating. The
// journal records capability/fence call order so the idle arm's publication sequence is pinned.
function contextFor(options: {
  position: { x: number; y: number };
  items?: readonly ClientTakeoffItem[];
  toolAtDown?: Readonly<ToolStoreState>;
  page?: { publicId: string; number: number; width: number; height: number };
  canAdopt?: () => boolean;
}) {
  const page = options.page ?? { publicId: "polygon-ctl", number: 3, width: 200, height: 100 };
  const toolAtDown = options.toolAtDown ?? toolState();
  const press: ToolPressSnapshot = {
    toolAtDown,
    position: options.position,
    publicId: page.publicId,
    pageNumber: page.number,
  };
  const journal: string[] = [];
  const takeoffDrawing = {
    setPolygonDrawingMode: vi.fn(() => {
      journal.push("mode");
    }),
    addPolygonVertex: vi.fn(() => {
      journal.push("append");
    }),
    saveLinearPolyline: vi.fn(() => {
      journal.push("saveLinear");
    }),
    savePolygon: vi.fn(() => {
      journal.push("save");
    }),
  };
  const inner = options.canAdopt ?? (() => true);
  const canAdoptProjectLifecycle = () => {
    journal.push("canAdopt");
    return inner();
  };
  // The count-controller capabilities ride along so registry-integration presses that fall
  // through to takeoffCount meet ITS fail-loud guard.
  const persistCreate = vi.fn(
    (_draft: NewAnnotationDraft, _options?: PersistCreateOptions) => Promise.resolve(-1),
  );
  const context: ToolContext = {
    press,
    page,
    stores: TOOL_STORE_CAPABILITIES,
    canAdoptProjectLifecycle,
    selection: {
      selectedId: null,
      setSelectedId: vi.fn(),
      setResizeCorner: vi.fn(),
      setDragging: vi.fn(),
      deleteSelected: vi.fn(),
    },
    pageAnnotations: [],
    deferredDrawing: { start: vi.fn(() => true) },
    mutations: { annotations: { persistCreate } },
    transientError: { publish: vi.fn() },
    takeoffItems: options.items ?? [item({ id: 6 })],
    takeoffDrawing,
  };
  return { context, takeoffDrawing, journal, persistCreate, canAdoptProjectLifecycle };
}

// Three-vertex drawing snapshot whose FIRST vertex sits at norm (0.5, 0.5) → pixel (100, 50) on
// 200×100 (the close snap anchors to polygonVertices[0] — the polygon/linear discriminator; the
// LAST vertex sits at px (180, 80) for the anchor witness). Snap fixtures press at 14px and
// exactly 15px so both boundary drifts bite.
const THREE_VERTS = [
  { x: 0.5, y: 0.5 },
  { x: 0.8, y: 0.2 },
  { x: 0.9, y: 0.8 },
];

function drawingState(vertices = THREE_VERTS) {
  return toolState({ polygonDrawingMode: "drawing", polygonVertices: vertices });
}

describe("takeoffPolygonController eligibility", () => {
  it("matches EXACTLY activeTool?.kind === 'takeoffPlacement'", () => {
    const press = (state: Readonly<ToolStoreState>): ToolPressSnapshot =>
      contextFor({ position: { x: 1, y: 1 }, toolAtDown: state }).context.press;
    expect(takeoffPolygonController.matches(press(toolState()))).toBe(true);
    expect(takeoffPolygonController.matches(press(toolState({ activeTool: { kind: "calibration" } })))).toBe(false);
    expect(takeoffPolygonController.matches(press(toolState({ activeTool: null })))).toBe(false);
    // Kind-only: a null active item id is STILL eligible — the decline happens in onMouseDown,
    // where takeoffItems is available.
    expect(takeoffPolygonController.matches(press(toolState({ activeTakeoffItemId: null })))).toBe(true);
  });

  it("fails loudly when takeoffItems is missing (every eligible press needs it)", () => {
    const { context } = contextFor({ position: { x: 1, y: 1 } });
    const bare = { ...context, takeoffItems: undefined };
    expect(() => takeoffPolygonController.onMouseDown(mockEvent(), bare as ToolContext)).toThrow(
      "takeoffPolygon controller requires the takeoffItems capability",
    );
  });

  it("fails loudly when takeoffDrawing is missing on a CLAIMED polygon press", () => {
    const { context } = contextFor({ position: { x: 1, y: 1 } });
    const bare = { ...context, takeoffDrawing: undefined };
    expect(() => takeoffPolygonController.onMouseDown(mockEvent(), bare as ToolContext)).toThrow(
      "takeoffPolygon controller requires the takeoffDrawing capability",
    );
  });

  it("SPLIT GUARD: a declined press runs to FALSE even without takeoffDrawing", () => {
    // Registry integration dispatches other controllers' synthetic contexts through this slot
    // (takeoffPolygon sits AHEAD of takeoffLinear and takeoffCount) — the decline must not
    // demand claim-path capabilities (S145 canon for interior inserts).
    const { context } = contextFor({
      position: { x: 1, y: 1 },
      toolAtDown: toolState({ activeTakeoffItemId: 5 }),
      items: [item({ id: 5, shape: "circle", name: "Door", color: "#ef4444" })],
    });
    const bare = { ...context, takeoffDrawing: undefined };
    const event = mockEvent();
    expect(takeoffPolygonController.onMouseDown(event, bare as ToolContext)).toBe(false);
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });
});

describe("takeoffPolygonController eligible-decline (zero side effects)", () => {
  it.each([
    { label: "null active id", state: toolState({ activeTakeoffItemId: null }), items: [item({ id: 6 })] },
    { label: "id not in items", state: toolState({ activeTakeoffItemId: 999 }), items: [item({ id: 6 })] },
    { label: "linear item", state: toolState({ activeTakeoffItemId: 7 }), items: [item({ id: 7, shape: "linear", name: "Conduit" })] },
    { label: "count item", state: toolState({ activeTakeoffItemId: 5 }), items: [item({ id: 5, shape: "circle", name: "Door" })] },
  ])("$label: returns FALSE, touches nothing", ({ state, items }) => {
    const token = claimToolTailAuthority({});
    const { context, takeoffDrawing, journal } = contextFor({
      position: { x: 50, y: 50 },
      toolAtDown: state,
      items,
    });
    const event = mockEvent();
    expect(takeoffPolygonController.onMouseDown(event, context)).toBe(false);
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(ownsToolTailAuthority(token)).toBe(true); // no tail invalidation on decline
    expect(takeoffDrawing.setPolygonDrawingMode).not.toHaveBeenCalled();
    expect(takeoffDrawing.addPolygonVertex).not.toHaveBeenCalled();
    expect(takeoffDrawing.savePolygon).not.toHaveBeenCalled();
    expect(journal).toEqual([]); // not even the lifecycle fence was consulted
  });
});

describe("takeoffPolygonController idle arm", () => {
  it("claims with mode write -> lifecycle fence -> props-normalized vertex, prelude exactly once", () => {
    const token = claimToolTailAuthority({});
    const { context, takeoffDrawing, journal } = contextFor({ position: { x: 50, y: 50 } });
    const event = mockEvent();
    expect(takeoffPolygonController.onMouseDown(event, context)).toBe(true);
    expect(takeoffDrawing.setPolygonDrawingMode).toHaveBeenCalledExactlyOnceWith("drawing");
    expect(takeoffDrawing.addPolygonVertex).toHaveBeenCalledExactlyOnceWith({
      x: 50 / 200,
      y: 50 / 100,
    });
    expect(takeoffDrawing.savePolygon).not.toHaveBeenCalled();
    // The exact publication order the lifecycle freeze pins through the real overlay.
    expect(journal).toEqual(["mode", "canAdopt", "append"]);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(ownsToolTailAuthority(token)).toBe(false); // prelude invalidation ran
  });

  it("a refused lifecycle STILL claims — mode written, vertex fenced out", () => {
    const { context, takeoffDrawing, journal } = contextFor({
      position: { x: 50, y: 50 },
      canAdopt: () => false,
    });
    const event = mockEvent();
    // Legacy's bare `return` consumed the press: the claim must survive the fence.
    expect(takeoffPolygonController.onMouseDown(event, context)).toBe(true);
    expect(takeoffDrawing.setPolygonDrawingMode).toHaveBeenCalledExactlyOnceWith("drawing");
    expect(takeoffDrawing.addPolygonVertex).not.toHaveBeenCalled();
    expect(journal).toEqual(["mode", "canAdopt"]);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
  });
});

describe("takeoffPolygonController drawing arm", () => {
  it("a press strictly inside 15px of the FIRST vertex closes: save exactly once, no append", () => {
    const token = claimToolTailAuthority({});
    const { context, takeoffDrawing } = contextFor({
      position: { x: 114, y: 50 }, // dist from (100,50) = 14
      toolAtDown: drawingState(),
    });
    const event = mockEvent();
    expect(takeoffPolygonController.onMouseDown(event, context)).toBe(true);
    expect(takeoffDrawing.savePolygon).toHaveBeenCalledTimes(1);
    expect(takeoffDrawing.addPolygonVertex).not.toHaveBeenCalled();
    expect(takeoffDrawing.setPolygonDrawingMode).not.toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(ownsToolTailAuthority(token)).toBe(false);
  });

  it("exactly 15px away is NOT a close (strict <) — the press appends instead", () => {
    const { context, takeoffDrawing } = contextFor({
      position: { x: 115, y: 50 }, // dist from (100,50) is exactly 15
      toolAtDown: drawingState(),
    });
    expect(takeoffPolygonController.onMouseDown(mockEvent(), context)).toBe(true);
    expect(takeoffDrawing.savePolygon).not.toHaveBeenCalled();
    expect(takeoffDrawing.addPolygonVertex).toHaveBeenCalledExactlyOnceWith({
      x: 115 / 200,
      y: 50 / 100,
    });
  });

  it("the snap metric is EUCLIDEAN off-axis (diagonal boundary pair — S145 metric canon)", () => {
    // (108,60) from (100,50): Euclidean sqrt(164) ≈ 12.81 closes; Manhattan 18 would append and
    // the dropped-sqrt mutant (164 < 15 false) would append.
    const inside = contextFor({
      position: { x: 108, y: 60 },
      toolAtDown: drawingState(),
    });
    expect(takeoffPolygonController.onMouseDown(mockEvent(), inside.context)).toBe(true);
    expect(inside.takeoffDrawing.savePolygon).toHaveBeenCalledTimes(1);
    expect(inside.takeoffDrawing.addPolygonVertex).not.toHaveBeenCalled();

    // (109,62): Euclidean EXACTLY 15 (9-12-15 triangle, exact in doubles: 81+144=225) appends;
    // Chebyshev 12 would close, and a <= widening would close.
    const boundary = contextFor({
      position: { x: 109, y: 62 },
      toolAtDown: drawingState(),
    });
    expect(takeoffPolygonController.onMouseDown(mockEvent(), boundary.context)).toBe(true);
    expect(boundary.takeoffDrawing.savePolygon).not.toHaveBeenCalled();
    expect(boundary.takeoffDrawing.addPolygonVertex).toHaveBeenCalledTimes(1);
  });

  it("the detail gate is exactly `< 2` (operator pins)", () => {
    // detail 3 (triple-click tail): `< 2` false → no append; a `!== 2` mutant would append.
    const triple = contextFor({
      position: { x: 40, y: 90 },
      toolAtDown: drawingState(),
    });
    expect(takeoffPolygonController.onMouseDown(mockEvent(3), triple.context)).toBe(true);
    expect(triple.takeoffDrawing.addPolygonVertex).not.toHaveBeenCalled();

    // detail 0 (synthetic/keyboard-class press): `< 2` true → appends; an `=== 1` mutant would
    // silently drop it. Legacy semantics preserved byte-for-byte.
    const zero = contextFor({
      position: { x: 40, y: 90 },
      toolAtDown: drawingState(),
    });
    expect(takeoffPolygonController.onMouseDown(mockEvent(0), zero.context)).toBe(true);
    expect(zero.takeoffDrawing.addPolygonVertex).toHaveBeenCalledTimes(1);
  });

  it("the first-vertex pixel position is anisotropic (x by width, y by height)", () => {
    // First vertex norm (0.3, 0.4): true px (60, 40); transposed scaling would put it at (30, 80).
    const verts = [{ x: 0.3, y: 0.4 }, { x: 0.8, y: 0.2 }, { x: 0.9, y: 0.8 }];
    const transposed = contextFor({
      position: { x: 30, y: 80 },
      toolAtDown: drawingState(verts),
    });
    expect(takeoffPolygonController.onMouseDown(mockEvent(), transposed.context)).toBe(true);
    expect(transposed.takeoffDrawing.savePolygon).not.toHaveBeenCalled();
    expect(transposed.takeoffDrawing.addPolygonVertex).toHaveBeenCalledTimes(1);

    const truePoint = contextFor({
      position: { x: 60, y: 40 },
      toolAtDown: drawingState(verts),
    });
    expect(takeoffPolygonController.onMouseDown(mockEvent(), truePoint.context)).toBe(true);
    expect(truePoint.takeoffDrawing.savePolygon).toHaveBeenCalledTimes(1);
    expect(truePoint.takeoffDrawing.addPolygonVertex).not.toHaveBeenCalled();
  });

  it("the snap anchors to the FIRST vertex, not the last — a press beside the last vertex appends", () => {
    const { context, takeoffDrawing } = contextFor({
      position: { x: 184, y: 83 }, // 5px from the LAST vertex px (180,80), ~90px from the FIRST
      toolAtDown: drawingState(),
    });
    expect(takeoffPolygonController.onMouseDown(mockEvent(), context)).toBe(true);
    expect(takeoffDrawing.savePolygon).not.toHaveBeenCalled();
    expect(takeoffDrawing.addPolygonVertex).toHaveBeenCalledExactlyOnceWith({
      x: 184 / 200,
      y: 83 / 100,
    });
  });

  it("the snap check is gated on >= 3 vertices — a distance-zero press on the first of two appends", () => {
    const { context, takeoffDrawing } = contextFor({
      position: { x: 100, y: 50 }, // exactly on the first vertex, but only 2 seeded
      toolAtDown: drawingState([THREE_VERTS[0], THREE_VERTS[1]]),
    });
    expect(takeoffPolygonController.onMouseDown(mockEvent(), context)).toBe(true);
    expect(takeoffDrawing.savePolygon).not.toHaveBeenCalled();
    expect(takeoffDrawing.addPolygonVertex).toHaveBeenCalledTimes(1);
  });

  it("the double-click second press (detail 2) neither saves nor appends yet still claims with one prelude", () => {
    const token = claimToolTailAuthority({});
    const { context, takeoffDrawing } = contextFor({
      position: { x: 40, y: 90 }, // far from the first vertex
      toolAtDown: drawingState(),
    });
    const event = mockEvent(2);
    expect(takeoffPolygonController.onMouseDown(event, context)).toBe(true);
    expect(takeoffDrawing.savePolygon).not.toHaveBeenCalled();
    expect(takeoffDrawing.addPolygonVertex).not.toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(ownsToolTailAuthority(token)).toBe(false);
  });
});

describe("takeoffPolygonController.wantsEvents (P3.4 production registry gate)", () => {
  it("requires exactly the takeoffPlacement activation", () => {
    expect(takeoffPolygonController.wantsEvents(toolState())).toBe(true);
    expect(takeoffPolygonController.wantsEvents(toolState({ activeTool: { kind: "calibration" } }))).toBe(false);
    expect(takeoffPolygonController.wantsEvents(toolState({ activeTool: null }))).toBe(false);
  });
});

describe("registry integration (interior slot AHEAD of takeoffLinear and takeoffCount)", () => {
  it("a polygon press claims AT takeoffPolygon — downstream mutations stay untouched", () => {
    const { context, takeoffDrawing, persistCreate } = contextFor({ position: { x: 50, y: 50 } });
    const event = mockEvent();
    expect(dispatchToolMouseDown(TOOLS, event, context.press, () => context)).toBe(true);
    expect(takeoffDrawing.setPolygonDrawingMode).toHaveBeenCalledTimes(1); // polygon idle arm ran
    // A decline here would ALSO decline at takeoffLinear (shape !== linear) and takeoffCount
    // (polygon-decline) — the TRUE claim proves this slot owned the press.
    expect(takeoffDrawing.saveLinearPolyline).not.toHaveBeenCalled();
    expect(persistCreate).not.toHaveBeenCalled(); // count never consulted
  });

  it("a linear press falls THROUGH takeoffPolygon's decline to takeoffLinear's claim", () => {
    // Witnessed at the linear FINISH: two vertices, press 9px from the LAST — this controller's
    // >= 3 gate could never produce saveLinearPolyline, so the save proves takeoffLinear claimed.
    const { context, takeoffDrawing, persistCreate } = contextFor({
      position: { x: 109, y: 50 },
      toolAtDown: toolState({
        activeTakeoffItemId: 7,
        polygonDrawingMode: "drawing",
        polygonVertices: [{ x: 0.1, y: 0.2 }, { x: 0.5, y: 0.5 }],
      }),
      items: [item({ id: 7, shape: "linear", name: "Conduit" })],
    });
    expect(dispatchToolMouseDown(TOOLS, mockEvent(), context.press, () => context)).toBe(true);
    expect(takeoffDrawing.saveLinearPolyline).toHaveBeenCalledTimes(1); // linear finish ran
    expect(takeoffDrawing.savePolygon).not.toHaveBeenCalled(); // polygon declined clean
    expect(persistCreate).not.toHaveBeenCalled();
  });

  it("a count press falls THROUGH both declines to takeoffCount's claim", () => {
    const { context, takeoffDrawing, persistCreate } = contextFor({
      position: { x: 120, y: 70 },
      toolAtDown: toolState({ activeTakeoffItemId: 5 }),
      items: [item({ id: 5, shape: "circle", name: "Door", color: "#ef4444" })],
    });
    expect(dispatchToolMouseDown(TOOLS, mockEvent(), context.press, () => context)).toBe(true);
    expect(takeoffDrawing.setPolygonDrawingMode).not.toHaveBeenCalled(); // both declined clean
    expect(takeoffDrawing.savePolygon).not.toHaveBeenCalled();
    expect(persistCreate).toHaveBeenCalledTimes(1); // count placed its marker
  });
});
