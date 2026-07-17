// @vitest-environment node
//
// [refactor jul17 P3.2] Direct behavioral contract for takeoffLinearController, landed IN the
// registration commit (S143 canon: the post-extraction overlay tail is inert, so overlay
// witnesses are structurally blind to claim-value regressions — only this net can see a
// partial-claim fallthrough). Pins:
//   1. eligibility is EXACTLY activeTool?.kind === "takeoffPlacement" (kind-only: takeoffItems
//      is component data, so activeItem resolution CANNOT happen in matches);
//   2. the SPLIT capability guard (SPEC §2.1): takeoffItems fails loudly on every eligible
//      press, but takeoffDrawing is demanded ONLY on a claimed linear press — a declined press
//      must run to its FALSE even when the claim-path capability is absent, because registry
//      integration dispatches other controllers' synthetic contexts through this slot;
//   3. the ELIGIBLE-DECLINE contract — !activeItem / polygon / count shapes return FALSE with
//      ZERO side effects (no stopPropagation, no tail invalidation, no capability call);
//   4. the idle arm: mode write BEFORE the lifecycle fence BEFORE the vertex append (exact
//      publication order — LifecyclePublicationsFreeze pins it through the real overlay, this
//      net pins it at the unit level via a call journal), props-normalized vertex;
//   5. the fence: canAdopt false still CLAIMS (legacy's bare return consumed the press) with the
//      mode written and NO vertex;
//   6. the drawing arm: strict-<10 finish snap to the LAST vertex's anisotropic pixel position
//      gated on >= 2 vertices — fixtures sit in the (9,10) band so widening AND narrowing bite;
//      the finish calls saveLinearPolyline exactly once and never appends;
//   7. the e.detail >= 2 silent consume (no save, no append, still TRUE + prelude);
//   8. claim === true on EVERY arm with stopPropagation exactly once and tail invalidation;
//   9. wantsEvents (P3.4 render-gate scaffolding): kind gate both directions;
//  10. registry integration through the real TOOLS tuple: a linear press claims AT takeoffLinear
//      (takeoffCount's mutations stay untouched — interior-order witness); a count press falls
//      THROUGH takeoffLinear to takeoffCount; a polygon press propagates FALSE end-to-end.

import type { MouseEvent as ReactMouseEvent } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  claimToolTailAuthority,
  ownsToolTailAuthority,
} from "@/lib/parse-tool-authority";
import type { NewAnnotationDraft, PersistCreateOptions } from "@/queries/useAnnotations";
import type { ToolStoreState } from "@/stores/toolStore";
import type { ClientTakeoffItem } from "@/types";
import { takeoffLinearController } from "../tools/takeoffLinear";
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
  return { name: "Conduit", shape: "linear", color: "#3b82f6", size: 10, sortOrder: 0, groupId: null, ...over };
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
  const page = options.page ?? { publicId: "linear-ctl", number: 3, width: 200, height: 100 };
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
      journal.push("save");
    }),
    // [refactor jul17 P3.2 takeoffPolygon] Required group member since savePolygon joined the
    // capability; registry-integration presses that reach the takeoffPolygon slot meet ITS
    // split guard through this same context.
    savePolygon: vi.fn(() => {
      journal.push("savePolygon");
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

// Two-vertex drawing snapshot whose LAST vertex sits at norm (0.5, 0.5) → pixel (100, 50) on
// 200×100. Snap fixtures press at 9px and exactly 10px so both boundary drifts bite.
const TWO_VERTS = [
  { x: 0.1, y: 0.2 },
  { x: 0.5, y: 0.5 },
];

function drawingState(vertices = TWO_VERTS) {
  return toolState({ polygonDrawingMode: "drawing", polygonVertices: vertices });
}

describe("takeoffLinearController eligibility", () => {
  it("matches EXACTLY activeTool?.kind === 'takeoffPlacement'", () => {
    const press = (state: Readonly<ToolStoreState>): ToolPressSnapshot =>
      contextFor({ position: { x: 1, y: 1 }, toolAtDown: state }).context.press;
    expect(takeoffLinearController.matches(press(toolState()))).toBe(true);
    expect(takeoffLinearController.matches(press(toolState({ activeTool: { kind: "calibration" } })))).toBe(false);
    expect(takeoffLinearController.matches(press(toolState({ activeTool: null })))).toBe(false);
    // Kind-only: a null active item id is STILL eligible — the decline happens in onMouseDown,
    // where takeoffItems is available.
    expect(takeoffLinearController.matches(press(toolState({ activeTakeoffItemId: null })))).toBe(true);
  });

  it("fails loudly when takeoffItems is missing (every eligible press needs it)", () => {
    const { context } = contextFor({ position: { x: 1, y: 1 } });
    const bare = { ...context, takeoffItems: undefined };
    expect(() => takeoffLinearController.onMouseDown(mockEvent(), bare as ToolContext)).toThrow(
      "takeoffLinear controller requires the takeoffItems capability",
    );
  });

  it("fails loudly when takeoffDrawing is missing on a CLAIMED linear press", () => {
    const { context } = contextFor({ position: { x: 1, y: 1 } });
    const bare = { ...context, takeoffDrawing: undefined };
    expect(() => takeoffLinearController.onMouseDown(mockEvent(), bare as ToolContext)).toThrow(
      "takeoffLinear controller requires the takeoffDrawing capability",
    );
  });

  it("SPLIT GUARD: a declined press runs to FALSE even without takeoffDrawing", () => {
    // Registry integration dispatches other controllers' synthetic contexts through this slot
    // (takeoffLinear sits AHEAD of takeoffCount) — the decline must not demand claim-path
    // capabilities (SPEC §2.1 canon for interior inserts).
    const { context } = contextFor({
      position: { x: 1, y: 1 },
      toolAtDown: toolState({ activeTakeoffItemId: 5 }),
      items: [item({ id: 5, shape: "circle", name: "Door", color: "#ef4444" })],
    });
    const bare = { ...context, takeoffDrawing: undefined };
    const event = mockEvent();
    expect(takeoffLinearController.onMouseDown(event, bare as ToolContext)).toBe(false);
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });
});

describe("takeoffLinearController eligible-decline (zero side effects)", () => {
  it.each([
    { label: "null active id", state: toolState({ activeTakeoffItemId: null }), items: [item({ id: 6 })] },
    { label: "id not in items", state: toolState({ activeTakeoffItemId: 999 }), items: [item({ id: 6 })] },
    { label: "polygon item", state: toolState({ activeTakeoffItemId: 7 }), items: [item({ id: 7, shape: "polygon" })] },
    { label: "count item", state: toolState({ activeTakeoffItemId: 5 }), items: [item({ id: 5, shape: "circle" })] },
  ])("$label: returns FALSE, touches nothing", ({ state, items }) => {
    const token = claimToolTailAuthority({});
    const { context, takeoffDrawing, journal } = contextFor({
      position: { x: 50, y: 50 },
      toolAtDown: state,
      items,
    });
    const event = mockEvent();
    expect(takeoffLinearController.onMouseDown(event, context)).toBe(false);
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(ownsToolTailAuthority(token)).toBe(true); // no tail invalidation on decline
    expect(takeoffDrawing.setPolygonDrawingMode).not.toHaveBeenCalled();
    expect(takeoffDrawing.addPolygonVertex).not.toHaveBeenCalled();
    expect(takeoffDrawing.saveLinearPolyline).not.toHaveBeenCalled();
    expect(journal).toEqual([]); // not even the lifecycle fence was consulted
  });
});

describe("takeoffLinearController idle arm", () => {
  it("claims with mode write -> lifecycle fence -> props-normalized vertex, prelude exactly once", () => {
    const token = claimToolTailAuthority({});
    const { context, takeoffDrawing, journal } = contextFor({ position: { x: 50, y: 50 } });
    const event = mockEvent();
    expect(takeoffLinearController.onMouseDown(event, context)).toBe(true);
    expect(takeoffDrawing.setPolygonDrawingMode).toHaveBeenCalledExactlyOnceWith("drawing");
    expect(takeoffDrawing.addPolygonVertex).toHaveBeenCalledExactlyOnceWith({
      x: 50 / 200,
      y: 50 / 100,
    });
    expect(takeoffDrawing.saveLinearPolyline).not.toHaveBeenCalled();
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
    expect(takeoffLinearController.onMouseDown(event, context)).toBe(true);
    expect(takeoffDrawing.setPolygonDrawingMode).toHaveBeenCalledExactlyOnceWith("drawing");
    expect(takeoffDrawing.addPolygonVertex).not.toHaveBeenCalled();
    expect(journal).toEqual(["mode", "canAdopt"]);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
  });
});

describe("takeoffLinearController drawing arm", () => {
  it("a press strictly inside 10px of the last vertex finishes: save exactly once, no append", () => {
    const token = claimToolTailAuthority({});
    const { context, takeoffDrawing } = contextFor({
      position: { x: 109, y: 50 }, // dist from (100,50) = 9
      toolAtDown: drawingState(),
    });
    const event = mockEvent();
    expect(takeoffLinearController.onMouseDown(event, context)).toBe(true);
    expect(takeoffDrawing.saveLinearPolyline).toHaveBeenCalledTimes(1);
    expect(takeoffDrawing.addPolygonVertex).not.toHaveBeenCalled();
    expect(takeoffDrawing.setPolygonDrawingMode).not.toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(ownsToolTailAuthority(token)).toBe(false);
  });

  it("exactly 10px away is NOT a finish (strict <) — the press appends instead", () => {
    const { context, takeoffDrawing } = contextFor({
      position: { x: 110, y: 50 }, // dist from (100,50) is exactly 10
      toolAtDown: drawingState(),
    });
    expect(takeoffLinearController.onMouseDown(mockEvent(), context)).toBe(true);
    expect(takeoffDrawing.saveLinearPolyline).not.toHaveBeenCalled();
    expect(takeoffDrawing.addPolygonVertex).toHaveBeenCalledExactlyOnceWith({
      x: 110 / 200,
      y: 50 / 100,
    });
  });

  it("the snap metric is EUCLIDEAN off-axis (diagonal boundary pair — review-probe repair)", () => {
    // (105,57) from (100,50): Euclidean sqrt(74) ≈ 8.60 finishes; Manhattan 12 would append.
    const inside = contextFor({
      position: { x: 105, y: 57 },
      toolAtDown: drawingState(),
    });
    expect(takeoffLinearController.onMouseDown(mockEvent(), inside.context)).toBe(true);
    expect(inside.takeoffDrawing.saveLinearPolyline).toHaveBeenCalledTimes(1);
    expect(inside.takeoffDrawing.addPolygonVertex).not.toHaveBeenCalled();

    // (106,58): Euclidean EXACTLY 10 (doubled 3-4-5, exact in doubles) appends; Chebyshev 8
    // would finish.
    const boundary = contextFor({
      position: { x: 106, y: 58 },
      toolAtDown: drawingState(),
    });
    expect(takeoffLinearController.onMouseDown(mockEvent(), boundary.context)).toBe(true);
    expect(boundary.takeoffDrawing.saveLinearPolyline).not.toHaveBeenCalled();
    expect(boundary.takeoffDrawing.addPolygonVertex).toHaveBeenCalledTimes(1);
  });

  it("the detail gate is exactly `< 2` (operator pins — review-probe repair)", () => {
    // detail 3 (triple-click tail): `< 2` false → no append; a `!== 2` mutant would append.
    const triple = contextFor({
      position: { x: 180, y: 20 },
      toolAtDown: drawingState(),
    });
    expect(takeoffLinearController.onMouseDown(mockEvent(3), triple.context)).toBe(true);
    expect(triple.takeoffDrawing.addPolygonVertex).not.toHaveBeenCalled();

    // detail 0 (synthetic/keyboard-class press): `< 2` true → appends; an `=== 1` mutant would
    // silently drop it. Legacy semantics preserved byte-for-byte.
    const zero = contextFor({
      position: { x: 180, y: 20 },
      toolAtDown: drawingState(),
    });
    expect(takeoffLinearController.onMouseDown(mockEvent(0), zero.context)).toBe(true);
    expect(zero.takeoffDrawing.addPolygonVertex).toHaveBeenCalledTimes(1);
  });

  it("the last-vertex pixel position is anisotropic (x by width, y by height)", () => {
    // Last vertex norm (0.2, 0.4): true px (40, 40); transposed scaling would put it at (20, 80).
    const verts = [{ x: 0.8, y: 0.9 }, { x: 0.2, y: 0.4 }];
    const transposed = contextFor({
      position: { x: 20, y: 80 },
      toolAtDown: drawingState(verts),
    });
    expect(takeoffLinearController.onMouseDown(mockEvent(), transposed.context)).toBe(true);
    expect(transposed.takeoffDrawing.saveLinearPolyline).not.toHaveBeenCalled();
    expect(transposed.takeoffDrawing.addPolygonVertex).toHaveBeenCalledTimes(1);

    const truePoint = contextFor({
      position: { x: 40, y: 40 },
      toolAtDown: drawingState(verts),
    });
    expect(takeoffLinearController.onMouseDown(mockEvent(), truePoint.context)).toBe(true);
    expect(truePoint.takeoffDrawing.saveLinearPolyline).toHaveBeenCalledTimes(1);
    expect(truePoint.takeoffDrawing.addPolygonVertex).not.toHaveBeenCalled();
  });

  it("the snap check is gated on >= 2 vertices — a distance-zero press on the sole vertex appends", () => {
    const { context, takeoffDrawing } = contextFor({
      position: { x: 100, y: 50 }, // exactly on the only vertex
      toolAtDown: drawingState([{ x: 0.5, y: 0.5 }]),
    });
    expect(takeoffLinearController.onMouseDown(mockEvent(), context)).toBe(true);
    expect(takeoffDrawing.saveLinearPolyline).not.toHaveBeenCalled();
    expect(takeoffDrawing.addPolygonVertex).toHaveBeenCalledTimes(1);
  });

  it("the double-click second press (detail 2) neither saves nor appends yet still claims with one prelude", () => {
    const token = claimToolTailAuthority({});
    const { context, takeoffDrawing } = contextFor({
      position: { x: 180, y: 20 }, // far from the last vertex
      toolAtDown: drawingState(),
    });
    const event = mockEvent(2);
    expect(takeoffLinearController.onMouseDown(event, context)).toBe(true);
    expect(takeoffDrawing.saveLinearPolyline).not.toHaveBeenCalled();
    expect(takeoffDrawing.addPolygonVertex).not.toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(ownsToolTailAuthority(token)).toBe(false);
  });
});

describe("takeoffLinearController.wantsEvents (P3.4 render-gate scaffolding)", () => {
  it("requires exactly the takeoffPlacement activation", () => {
    expect(takeoffLinearController.wantsEvents(toolState())).toBe(true);
    expect(takeoffLinearController.wantsEvents(toolState({ activeTool: { kind: "calibration" } }))).toBe(false);
    expect(takeoffLinearController.wantsEvents(toolState({ activeTool: null }))).toBe(false);
  });
});

describe("registry integration (interior slot AHEAD of takeoffCount)", () => {
  it("a linear press claims AT takeoffLinear — takeoffCount's mutations stay untouched", () => {
    const { context, takeoffDrawing, persistCreate } = contextFor({ position: { x: 50, y: 50 } });
    const event = mockEvent();
    expect(dispatchToolMouseDown(TOOLS, event, context.press, () => context)).toBe(true);
    expect(takeoffDrawing.setPolygonDrawingMode).toHaveBeenCalledTimes(1); // linear idle arm ran
    expect(persistCreate).not.toHaveBeenCalled(); // count never consulted
  });

  it("a count press falls THROUGH takeoffLinear's decline to takeoffCount's claim", () => {
    const { context, takeoffDrawing, persistCreate } = contextFor({
      position: { x: 120, y: 70 },
      toolAtDown: toolState({ activeTakeoffItemId: 5 }),
      items: [item({ id: 5, shape: "circle", name: "Door", color: "#ef4444" })],
    });
    expect(dispatchToolMouseDown(TOOLS, mockEvent(), context.press, () => context)).toBe(true);
    expect(takeoffDrawing.setPolygonDrawingMode).not.toHaveBeenCalled(); // linear declined clean
    expect(takeoffDrawing.saveLinearPolyline).not.toHaveBeenCalled();
    expect(persistCreate).toHaveBeenCalledTimes(1); // count placed its marker
  });

  it("a polygon press claims AHEAD of this slot — takeoffLinear's polygon-decline is never consulted", () => {
    // [refactor jul17 P3.2 takeoffPolygon] Was the all-decline FALSE-propagation witness; the
    // fifth registration (takeoffPolygon, board §5 priority #4) claims polygon presses BEFORE
    // this controller runs, making its polygon-decline dead-but-honest (it stays — the direct
    // eligible-decline it.each above pins it forever). The claim's idle arm runs through the
    // SAME takeoffDrawing capability this context carries.
    const { context, takeoffDrawing, persistCreate } = contextFor({
      position: { x: 50, y: 50 },
      toolAtDown: toolState({ activeTakeoffItemId: 7 }),
      items: [item({ id: 7, shape: "polygon" })],
    });
    const event = mockEvent();
    expect(dispatchToolMouseDown(TOOLS, event, context.press, () => context)).toBe(true);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1); // claimed at takeoffPolygon
    expect(takeoffDrawing.setPolygonDrawingMode).toHaveBeenCalledTimes(1); // polygon idle arm ran
    expect(takeoffDrawing.saveLinearPolyline).not.toHaveBeenCalled();
    expect(persistCreate).not.toHaveBeenCalled(); // count never consulted
  });
});
