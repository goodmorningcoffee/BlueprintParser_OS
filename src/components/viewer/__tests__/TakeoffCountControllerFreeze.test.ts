// @vitest-environment node
//
// [refactor jul17 P3.2] Direct behavioral contract for takeoffCountController, landed IN the
// registration commit (S143 canon: the post-extraction overlay tail is inert, so overlay
// witnesses are structurally blind to claim-value regressions — only this net can see a
// partial-claim fallthrough). Pins:
//   1. eligibility is EXACTLY activeTool?.kind === "takeoffPlacement" (kind-only: takeoffItems
//      is component data, so activeItem resolution CANNOT happen in matches);
//   2. the capability fail-loud guards (takeoffItems for every eligible press; the remaining
//      four capabilities only after the count identity claims the press);
//   3. the ELIGIBLE-DECLINE contract — the registry's first: !activeItem / polygon / linear
//      return FALSE with ZERO side effects (no stopPropagation, no tail invalidation, no
//      capability call); polygon/linear normally claim upstream, while only !activeItem reaches
//      the inert legacy skeleton and returns before its prelude;
//   4. select-before-place: strict <14 anisotropic center distance, takeoff-source-only
//      transparency, pageAnnotations array order; the select path claims TRUE without
//      persistCreate;
//   5. placement: persistCreate called exactly once with the EXACT draft (clamped half-size
//      bbox, CountMarkerData literal, item name, source "takeoff", context.page.number) and the
//      context's canAdoptProjectLifecycle by REFERENCE;
//   6. the onError ternary BOTH ways — the bare "Failed to save marker" branch is unreachable
//      through the production seam (persistCreate wraps non-Errors first), so it is pinned here;
//   7. claim === true with stopPropagation exactly once and tail invalidation on both claimed
//      paths;
//   8. wantsEvents (P3.4 render-gate scaffolding): kind gate both directions;
//   9. registry integration: a declined press propagates FALSE through the real TOOLS tuple.

import type { MouseEvent as ReactMouseEvent } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  claimToolTailAuthority,
  ownsToolTailAuthority,
} from "@/lib/parse-tool-authority";
import type { NewAnnotationDraft, PersistCreateOptions } from "@/queries/useAnnotations";
import type { ToolStoreState } from "@/stores/toolStore";
import type { ClientAnnotation, ClientTakeoffItem } from "@/types";
import { takeoffCountController } from "../tools/takeoffCount";
import { TOOLS, dispatchToolMouseDown } from "../tools/registry";
import { TOOL_STORE_CAPABILITIES } from "../tools/capabilities";
import type { ToolContext, ToolPressSnapshot } from "../tools/types";

const HS = 0.005; // mirrors the production half-size so expected bboxes share the exact doubles
const CAPABILITY_ERROR =
  "takeoffCount controller requires the takeoffItems/selection/pageAnnotations/mutations/transientError capabilities";

function mockEvent() {
  return { stopPropagation: vi.fn() } as unknown as ReactMouseEvent & {
    stopPropagation: ReturnType<typeof vi.fn>;
  };
}

function toolState(
  overrides: Partial<{ activeTool: unknown; activeTakeoffItemId: number | null }> = {},
): Readonly<ToolStoreState> {
  return {
    activeTool: { kind: "takeoffPlacement" },
    activeTakeoffItemId: 5,
    mode: "pointer",
    ...overrides,
  } as unknown as Readonly<ToolStoreState>;
}

function item(over: Partial<ClientTakeoffItem> & { id: number }): ClientTakeoffItem {
  return { name: "Door", shape: "circle", color: "#ef4444", size: 10, sortOrder: 0, groupId: null, ...over };
}

function marker(id: number, bbox: [number, number, number, number]): ClientAnnotation {
  return {
    id,
    pageNumber: 1,
    name: `marker-${id}`,
    bbox,
    note: null,
    source: "takeoff",
    data: { type: "count-marker", shape: "circle", color: "#ef4444", takeoffItemId: 5 },
  } as unknown as ClientAnnotation;
}

// Non-square 200×100 default page — every geometry pin is transposition-discriminating.
function contextFor(options: {
  position: { x: number; y: number };
  items?: readonly ClientTakeoffItem[];
  annotations?: readonly ClientAnnotation[];
  toolAtDown?: Readonly<ToolStoreState>;
  page?: { publicId: string; number: number; width: number; height: number };
}) {
  const page = options.page ?? { publicId: "count-ctl", number: 3, width: 200, height: 100 };
  const toolAtDown = options.toolAtDown ?? toolState();
  const press: ToolPressSnapshot = {
    toolAtDown,
    position: options.position,
    publicId: page.publicId,
    pageNumber: page.number,
  };
  const selection = {
    selectedId: null,
    setSelectedId: vi.fn(),
    setResizeCorner: vi.fn(),
    setDragging: vi.fn(),
    deleteSelected: vi.fn(),
  };
  const persistCreate = vi.fn(
    (_draft: NewAnnotationDraft, _options?: PersistCreateOptions) => Promise.resolve(-1),
  );
  const transientError = { publish: vi.fn() };
  const canAdoptProjectLifecycle = () => true;
  const context: ToolContext = {
    press,
    page,
    stores: TOOL_STORE_CAPABILITIES,
    canAdoptProjectLifecycle,
    selection,
    pageAnnotations: options.annotations ?? [],
    deferredDrawing: { start: vi.fn(() => true) },
    mutations: { annotations: { persistCreate } },
    transientError,
    takeoffItems: options.items ?? [item({ id: 5 })],
  };
  return { context, selection, persistCreate, transientError, canAdoptProjectLifecycle };
}

// Marker centered at norm (0.4, 0.3) → pixel (80, 30) on 200×100; transposed center is (40, 60).
const MARKER = marker(100, [0.35, 0.25, 0.45, 0.35]);

describe("takeoffCountController eligibility", () => {
  it("matches EXACTLY activeTool?.kind === 'takeoffPlacement'", () => {
    const press = (state: Readonly<ToolStoreState>): ToolPressSnapshot =>
      contextFor({ position: { x: 1, y: 1 }, toolAtDown: state }).context.press;
    expect(takeoffCountController.matches(press(toolState()))).toBe(true);
    expect(takeoffCountController.matches(press(toolState({ activeTool: { kind: "calibration" } })))).toBe(false);
    expect(takeoffCountController.matches(press(toolState({ activeTool: null })))).toBe(false);
    // Kind-only: a null active item id is STILL eligible — the decline happens in onMouseDown,
    // where takeoffItems is available.
    expect(takeoffCountController.matches(press(toolState({ activeTakeoffItemId: null })))).toBe(true);
  });

  it.each([
    { label: "placement without takeoffItems", capability: "takeoffItems", position: { x: 1, y: 1 }, annotations: [] },
    { label: "placement without selection", capability: "selection", position: { x: 1, y: 1 }, annotations: [] },
    { label: "placement without pageAnnotations", capability: "pageAnnotations", position: { x: 1, y: 1 }, annotations: [] },
    { label: "placement without mutations", capability: "mutations", position: { x: 1, y: 1 }, annotations: [] },
    { label: "placement without transientError", capability: "transientError", position: { x: 1, y: 1 }, annotations: [] },
    { label: "selection without mutations", capability: "mutations", position: { x: 80, y: 30 }, annotations: [MARKER] },
    { label: "selection without transientError", capability: "transientError", position: { x: 80, y: 30 }, annotations: [MARKER] },
  ] as const)("$label: fails loudly before event/tail/controller side effects", ({
    capability,
    position,
    annotations,
  }) => {
    const token = claimToolTailAuthority({});
    const { context, selection, persistCreate, transientError } = contextFor({
      position,
      annotations,
    });
    const bare = { ...context, [capability]: undefined };
    const event = mockEvent();
    let thrown: unknown;
    try {
      takeoffCountController.onMouseDown(event, bare as ToolContext);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(CAPABILITY_ERROR);
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(ownsToolTailAuthority(token)).toBe(true);
    expect(selection.setSelectedId).not.toHaveBeenCalled();
    expect(persistCreate).not.toHaveBeenCalled();
    expect(transientError.publish).not.toHaveBeenCalled();
  });
});

describe("takeoffCountController eligible-decline (zero side effects)", () => {
  it.each([
    { label: "null active id", state: toolState({ activeTakeoffItemId: null }), items: [item({ id: 5 })] },
    { label: "id not in items", state: toolState({ activeTakeoffItemId: 999 }), items: [item({ id: 5 })] },
    { label: "polygon item", state: toolState({ activeTakeoffItemId: 6 }), items: [item({ id: 6, shape: "polygon" })] },
    { label: "linear item", state: toolState({ activeTakeoffItemId: 7 }), items: [item({ id: 7, shape: "linear" })] },
  ])("$label: returns FALSE with no count-claim capabilities and touches nothing", ({ state, items }) => {
    const token = claimToolTailAuthority({});
    const { context, selection, persistCreate, transientError } = contextFor({
      position: { x: 120, y: 70 },
      toolAtDown: state,
      items,
      annotations: [MARKER],
    });
    const leanContext = {
      ...context,
      selection: undefined,
      pageAnnotations: undefined,
      mutations: undefined,
      transientError: undefined,
    } as ToolContext;
    const event = mockEvent();
    expect(takeoffCountController.onMouseDown(event, leanContext)).toBe(false);
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(ownsToolTailAuthority(token)).toBe(true); // no tail invalidation on decline
    expect(selection.setSelectedId).not.toHaveBeenCalled();
    expect(persistCreate).not.toHaveBeenCalled();
    expect(transientError.publish).not.toHaveBeenCalled();
  });
});

describe("takeoffCountController select-before-place", () => {
  it("selects a takeoff marker strictly inside 14px of its anisotropic center and claims without persisting", () => {
    const token = claimToolTailAuthority({});
    const { context, selection, persistCreate } = contextFor({
      position: { x: 93, y: 30 }, // dist from (80,30) = 13
      annotations: [MARKER],
    });
    const event = mockEvent();
    expect(takeoffCountController.onMouseDown(event, context)).toBe(true);
    expect(selection.setSelectedId).toHaveBeenCalledExactlyOnceWith(100);
    expect(persistCreate).not.toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(ownsToolTailAuthority(token)).toBe(false); // prelude invalidation ran
  });

  it("exactly 14px away is NOT a select (strict <) — placement runs instead", () => {
    const { context, selection, persistCreate } = contextFor({
      position: { x: 94, y: 30 },
      annotations: [MARKER],
    });
    expect(takeoffCountController.onMouseDown(mockEvent(), context)).toBe(true);
    expect(selection.setSelectedId).not.toHaveBeenCalled();
    expect(persistCreate).toHaveBeenCalledTimes(1);
  });

  it("the center is anisotropic — a press at the transposed center places instead of selecting", () => {
    const { context, selection, persistCreate } = contextFor({
      position: { x: 40, y: 60 }, // transposed center; true center (80,30) is 50px away
      annotations: [MARKER],
    });
    expect(takeoffCountController.onMouseDown(mockEvent(), context)).toBe(true);
    expect(selection.setSelectedId).not.toHaveBeenCalled();
    expect(persistCreate).toHaveBeenCalledTimes(1);
  });

  it("non-takeoff sources are transparent even at distance zero", () => {
    const bait = {
      ...marker(101, [0.55, 0.65, 0.65, 0.75]), // center (0.6,0.7) → (120,70)
      source: "user",
    } as unknown as ClientAnnotation;
    const { context, selection, persistCreate } = contextFor({
      position: { x: 120, y: 70 },
      annotations: [bait, MARKER],
    });
    expect(takeoffCountController.onMouseDown(mockEvent(), context)).toBe(true);
    expect(selection.setSelectedId).not.toHaveBeenCalled();
    expect(persistCreate).toHaveBeenCalledTimes(1);
  });

  it("selects in pageAnnotations ARRAY order when marker centers overlap", () => {
    const first = marker(1, [0.35, 0.25, 0.45, 0.35]);
    const second = marker(2, [0.35, 0.25, 0.45, 0.35]);
    const { context, selection } = contextFor({
      position: { x: 80, y: 30 },
      annotations: [first, second],
    });
    expect(takeoffCountController.onMouseDown(mockEvent(), context)).toBe(true);
    expect(selection.setSelectedId).toHaveBeenCalledExactlyOnceWith(1);
  });
});

describe("takeoffCountController placement", () => {
  it("persists exactly one marker with the exact draft and the context's canAdopt by reference", () => {
    const token = claimToolTailAuthority({});
    const { context, persistCreate, canAdoptProjectLifecycle } = contextFor({
      position: { x: 120, y: 70 }, // norm (0.6, 0.7)
      items: [item({ id: 5, name: "Door", shape: "diamond", color: "#22c55e" })],
    });
    const event = mockEvent();
    expect(takeoffCountController.onMouseDown(event, context)).toBe(true);
    expect(persistCreate).toHaveBeenCalledTimes(1);
    const [draft, options] = persistCreate.mock.calls[0];
    expect(draft).toEqual({
      pageNumber: 3, // context.page.number, NOT the press page copy
      name: "Door",
      bbox: [
        Math.max(0, 120 / 200 - HS),
        Math.max(0, 70 / 100 - HS),
        Math.min(1, 120 / 200 + HS),
        Math.min(1, 70 / 100 + HS),
      ],
      source: "takeoff",
      data: {
        type: "count-marker",
        shape: "diamond",
        color: "#22c55e",
        takeoffItemId: 5,
      },
    });
    expect(options?.canAdopt).toBe(canAdoptProjectLifecycle); // reference, not a wrapper
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(ownsToolTailAuthority(token)).toBe(false);
  });

  it("clamps both bbox ends at the page corners", () => {
    const origin = contextFor({ position: { x: 0, y: 0 } });
    takeoffCountController.onMouseDown(mockEvent(), origin.context);
    expect(origin.persistCreate.mock.calls[0][0].bbox).toEqual([0, 0, 0 + HS, 0 + HS]);

    const extent = contextFor({ position: { x: 200, y: 100 } });
    takeoffCountController.onMouseDown(mockEvent(), extent.context);
    expect(extent.persistCreate.mock.calls[0][0].bbox).toEqual([1 - HS, 1 - HS, 1, 1]);
  });

  it("routes persistCreate failures through transientError.publish — BOTH ternary branches", () => {
    const { context, persistCreate, transientError } = contextFor({
      position: { x: 120, y: 70 },
    });
    takeoffCountController.onMouseDown(mockEvent(), context);
    const [, options] = persistCreate.mock.calls[0];
    const onError = options?.onError as (err: unknown) => void;
    onError(new Error("boom"));
    expect(transientError.publish).toHaveBeenCalledExactlyOnceWith("Failed to save marker: boom");

    transientError.publish.mockClear();
    // Unreachable through the production seam (persistCreate wraps non-Errors first) — pinned
    // here because only the direct net can reach the bare-fallback branch.
    onError("raw-rejection");
    expect(transientError.publish).toHaveBeenCalledExactlyOnceWith("Failed to save marker");
  });
});

describe("takeoffCountController.wantsEvents (P3.4 render-gate scaffolding)", () => {
  it("requires exactly the takeoffPlacement activation", () => {
    expect(takeoffCountController.wantsEvents(toolState())).toBe(true);
    expect(takeoffCountController.wantsEvents(toolState({ activeTool: { kind: "calibration" } }))).toBe(false);
    expect(takeoffCountController.wantsEvents(toolState({ activeTool: null }))).toBe(false);
  });
});

describe("registry integration (first eligible-decline controller)", () => {
  it("an unresolvable-item press propagates FALSE through the real TOOLS tuple", () => {
    // [refactor jul17 P3.2 takeoffPolygon] Was the declined-POLYGON witness; the fifth
    // registration claims polygon presses upstream (and this context deliberately carries no
    // takeoffDrawing — a polygon CLAIM here would hit takeoffPolygon's split-guard throw), so
    // the genuinely unclaimable press through the whole tuple is now !activeItem. All three
    // takeoff controllers decline it with zero side effects (split guard: their decline paths
    // demand only takeoffItems, which this context has).
    const { context } = contextFor({
      position: { x: 120, y: 70 },
      toolAtDown: toolState({ activeTakeoffItemId: 999 }),
      items: [item({ id: 6, shape: "polygon" })],
    });
    const event = mockEvent();
    expect(dispatchToolMouseDown(TOOLS, event, context.press, () => context)).toBe(false);
    expect(event.stopPropagation).not.toHaveBeenCalled(); // nothing downstream claimed either
  });

  it("a count press claims TRUE through the real TOOLS tuple", () => {
    const { context, persistCreate } = contextFor({ position: { x: 120, y: 70 } });
    expect(dispatchToolMouseDown(TOOLS, mockEvent(), context.press, () => context)).toBe(true);
    expect(persistCreate).toHaveBeenCalledTimes(1);
  });
});
