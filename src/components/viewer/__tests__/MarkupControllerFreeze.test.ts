// @vitest-environment node
//
// [refactor jul16 P3.2] Direct behavioral contract for markupController, landed IN the
// registration commit (the S142 lesson institutionalized: overlay witnesses cannot pin a
// controller — the injectable selection/pageAnnotations/deferredDrawing capabilities give this
// net full observability of every path). Pins:
//   1. eligibility is EXACTLY activeTool === null && mode === "markup";
//   2. the capability fail-loud guard;
//   3. block order and geometry: corner handles (tl→tr→bl→br first-hit, HANDLE=8, anisotropic
//      PROPS width/height) BEFORE the label bar (y ∈ [ay−18, ay] inclusive, x ≥ ax) BEFORE
//      annotation select (pageAnnotations array order) BEFORE empty-canvas deferred-draw;
//   4. selAnn-missing fallthrough (stale selectedId falls to the select loop);
//   5. claim === true with stopPropagation exactly once on EVERY path;
//   6. invalidateToolTailAuthority on every path, the non-drawing select path included;
//   7. deferredDrawing.start receives the press position and NO explicit clearSelection;
//   8. wantsEvents (P3.4 production registry gate): activeTool===null && mode==="markup".

import type { MouseEvent as ReactMouseEvent } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  claimToolTailAuthority,
  ownsToolTailAuthority,
} from "@/lib/parse-tool-authority";
import type { ToolStoreState } from "@/stores/toolStore";
import type { ClientAnnotation } from "@/types";
import { markupController } from "../tools/markup";
import { TOOL_STORE_CAPABILITIES } from "../tools/capabilities";
import type { ToolContext, ToolPressSnapshot } from "../tools/types";

function mockEvent() {
  return { stopPropagation: vi.fn() } as unknown as ReactMouseEvent & {
    stopPropagation: ReturnType<typeof vi.fn>;
  };
}

function toolState(
  overrides: Partial<{ activeTool: unknown; mode: string }> = {},
): Readonly<ToolStoreState> {
  return {
    activeTool: null,
    mode: "markup",
    ...overrides,
  } as unknown as Readonly<ToolStoreState>;
}

function annotation(id: number, bbox: [number, number, number, number]): ClientAnnotation {
  return { id, pageNumber: 1, name: `ann-${id}`, bbox, note: null, source: "user", data: null } as unknown as ClientAnnotation;
}

// Non-square 200×100 default page — every geometry pin is transposition-discriminating.
function contextFor(options: {
  position: { x: number; y: number };
  annotations?: readonly ClientAnnotation[];
  selectedId?: number | null;
  toolAtDown?: Readonly<ToolStoreState>;
  page?: { publicId: string; number: number; width: number; height: number };
}) {
  const page = options.page ?? { publicId: "markup-ctl", number: 1, width: 200, height: 100 };
  const toolAtDown = options.toolAtDown ?? toolState();
  const press: ToolPressSnapshot = {
    toolAtDown,
    position: options.position,
    publicId: page.publicId,
    pageNumber: page.number,
  };
  const selection = {
    selectedId: options.selectedId ?? null,
    setSelectedId: vi.fn(),
    setResizeCorner: vi.fn(),
    setDragging: vi.fn(),
    deleteSelected: vi.fn(),
  };
  const deferredDrawing = { start: vi.fn(() => true) };
  const annotationDrag = {
    begin: vi.fn(() => true),
    beginBBox: vi.fn(() => true),
  };
  const context: ToolContext = {
    press,
    page,
    stores: TOOL_STORE_CAPABILITIES,
    canAdoptProjectLifecycle: () => true,
    selection,
    annotationDrag,
    pageAnnotations: options.annotations ?? [],
    deferredDrawing,
  };
  return { context, selection, annotationDrag, deferredDrawing };
}

// bbox [0.2,0.2,0.6,0.8] on 200×100: pixel box (40,20)–(120,80); label bar y ∈ [2,20] at x ≥ 40.
const BOX = annotation(7, [0.2, 0.2, 0.6, 0.8]);

describe("markupController eligibility", () => {
  it("matches EXACTLY activeTool === null && mode === 'markup'", () => {
    const press = (state: Readonly<ToolStoreState>): ToolPressSnapshot =>
      contextFor({ position: { x: 1, y: 1 }, toolAtDown: state }).context.press;
    expect(markupController.matches(press(toolState()))).toBe(true);
    expect(markupController.matches(press(toolState({ activeTool: { kind: "calibration" } })))).toBe(false);
    expect(markupController.matches(press(toolState({ mode: "pointer" })))).toBe(false);
    expect(markupController.matches(press(toolState({ mode: "group" })))).toBe(false);
    expect(markupController.matches(press(toolState({ mode: "move" })))).toBe(false);
  });

  it("fails loudly when a capability is missing from the context", () => {
    const { context } = contextFor({ position: { x: 1, y: 1 } });
    const bare = { ...context, selection: undefined };
    expect(() => markupController.onMouseDown(mockEvent(), bare as ToolContext)).toThrow(
      "markup controller requires the selection/pageAnnotations/deferredDrawing capabilities",
    );
  });
});

describe("markupController block order and geometry", () => {
  it("corner first-hit order is tl→tr→bl→br when handles overlap", () => {
    // Tiny box on a 100×100 page: all four handles within 8px of the press.
    const tiny = annotation(3, [0.1, 0.1, 0.14, 0.12]); // corners (10,10) (14,10) (10,12) (14,12)
    const { context, selection, annotationDrag } = contextFor({
      position: { x: 12, y: 11 },
      annotations: [tiny],
      selectedId: 3,
      page: { publicId: "markup-ctl", number: 1, width: 100, height: 100 },
    });
    const event = mockEvent();
    expect(markupController.onMouseDown(event, context)).toBe(true);
    expect(annotationDrag.beginBBox).toHaveBeenCalledExactlyOnceWith(tiny, "tl");
    expect(selection.setResizeCorner).toHaveBeenCalledExactlyOnceWith("tl");
    expect(selection.setDragging).toHaveBeenCalledExactlyOnceWith(true);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
  });

  it("fails loudly only when a corner path lacks its drag journal", () => {
    const { context } = contextFor({
      position: { x: 40, y: 20 },
      annotations: [BOX],
      selectedId: 7,
    });
    expect(() => markupController.onMouseDown(
      mockEvent(),
      { ...context, annotationDrag: undefined },
    )).toThrow("markup corner resize requires the annotationDrag capability");
  });

  it("does not publish resize state when exact drag admission is denied", () => {
    const { context, selection, annotationDrag } = contextFor({
      position: { x: 40, y: 20 },
      annotations: [BOX],
      selectedId: 7,
    });
    annotationDrag.beginBBox.mockReturnValue(false);
    const event = mockEvent();
    expect(markupController.onMouseDown(event, context)).toBe(true);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(selection.setResizeCorner).not.toHaveBeenCalled();
    expect(selection.setDragging).not.toHaveBeenCalled();
  });

  // [refactor jul16 P3.2 repair, prober hole A] Only "tl" (direct) and "br" (end-to-end resize)
  // had witnesses; a "tr"/"bl" key drift silently no-ops handleMouseMove's resize dispatch.
  it("reports the exact corner key for each of the four handles", () => {
    const cornerPresses = [
      { key: "tl", position: { x: 40, y: 20 } },
      { key: "tr", position: { x: 120, y: 20 } },
      { key: "bl", position: { x: 40, y: 80 } },
      { key: "br", position: { x: 120, y: 80 } },
    ] as const;
    for (const { key, position } of cornerPresses) {
      const { context, selection } = contextFor({
        position,
        annotations: [BOX],
        selectedId: 7,
      });
      expect(markupController.onMouseDown(mockEvent(), context)).toBe(true);
      expect(selection.setResizeCorner).toHaveBeenCalledExactlyOnceWith(key);
    }
  });

  // [refactor jul16 P3.2 repair, prober hole D] Pins HANDLE === 8 and pointInHandle's STRICT
  // inequality: dx=7 claims the corner, dx=8 falls through — here into the label bar, whose
  // zone contains both presses (y=20=ay, x>=40).
  it("corner tolerance is strictly less-than 8 CSS px", () => {
    const inside = contextFor({ position: { x: 47, y: 20 }, annotations: [BOX], selectedId: 7 });
    expect(markupController.onMouseDown(mockEvent(), inside.context)).toBe(true);
    expect(inside.selection.setResizeCorner).toHaveBeenCalledExactlyOnceWith("tl");
    expect(inside.selection.deleteSelected).not.toHaveBeenCalled();

    const outside = contextFor({ position: { x: 48, y: 20 }, annotations: [BOX], selectedId: 7 });
    expect(markupController.onMouseDown(mockEvent(), outside.context)).toBe(true);
    expect(outside.selection.setResizeCorner).not.toHaveBeenCalled();
    expect(outside.selection.deleteSelected).toHaveBeenCalledTimes(1);
  });

  it("a corner hit beats the label bar when the press lies in both", () => {
    // (44,16): within 8px of tl(40,20) AND inside the label zone y∈[2,20], x≥40.
    const { context, selection } = contextFor({
      position: { x: 44, y: 16 },
      annotations: [BOX],
      selectedId: 7,
    });
    expect(markupController.onMouseDown(mockEvent(), context)).toBe(true);
    expect(selection.setResizeCorner).toHaveBeenCalledExactlyOnceWith("tl");
    expect(selection.deleteSelected).not.toHaveBeenCalled();
  });

  // [refactor jul16 P3.2 repair, prober hole 4] (40,10) pins the INCLUSIVE left edge x === ax —
  // previously only x=60/44/39 were exercised, so `>= ax` → `> ax` survived every net.
  it("label bar hits inclusively at y = ay−18, y = ay, and x = ax (anisotropic ay = minY·height)", () => {
    for (const { x, y } of [{ x: 60, y: 2 }, { x: 60, y: 20 }, { x: 40, y: 10 }]) {
      const { context, selection, deferredDrawing } = contextFor({
        position: { x, y },
        annotations: [BOX],
        selectedId: 7,
      });
      const event = mockEvent();
      expect(markupController.onMouseDown(event, context)).toBe(true);
      expect(selection.deleteSelected).toHaveBeenCalledTimes(1);
      expect(selection.setResizeCorner).not.toHaveBeenCalled();
      expect(deferredDrawing.start).not.toHaveBeenCalled();
      expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    }
  });

  it("misses one pixel above the bar (y = ay−19) and left of it (x < ax), falling through to draw", () => {
    for (const position of [{ x: 60, y: 1 }, { x: 39, y: 10 }]) {
      const { context, selection, deferredDrawing } = contextFor({
        position,
        annotations: [BOX],
        selectedId: 7,
      });
      const event = mockEvent();
      expect(markupController.onMouseDown(event, context)).toBe(true);
      expect(selection.deleteSelected).not.toHaveBeenCalled();
      // Both presses also fall outside BOX, so the select loop misses too.
      expect(selection.setSelectedId).not.toHaveBeenCalled();
      expect(deferredDrawing.start).toHaveBeenCalledTimes(1);
      expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    }
  });

  it("a stale selectedId (annotation gone) falls through to the select loop", () => {
    const { context, selection } = contextFor({
      position: { x: 80, y: 50 }, // inside BOX
      annotations: [BOX],
      selectedId: 999,
    });
    const event = mockEvent();
    expect(markupController.onMouseDown(event, context)).toBe(true);
    expect(selection.setSelectedId).toHaveBeenCalledExactlyOnceWith(7);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
  });

  it("selects in pageAnnotations ARRAY order when annotations overlap", () => {
    const a = annotation(1, [0, 0, 1, 1]);
    const b = annotation(2, [0, 0, 1, 1]);
    const { context, selection } = contextFor({
      position: { x: 100, y: 50 },
      annotations: [a, b],
    });
    expect(markupController.onMouseDown(mockEvent(), context)).toBe(true);
    expect(selection.setSelectedId).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("empty canvas claims with exactly one stopPropagation and starts the deferred draw with the bare position", () => {
    const position = { x: 150, y: 30 };
    const { context, deferredDrawing } = contextFor({ position });
    const event = mockEvent();
    expect(markupController.onMouseDown(event, context)).toBe(true);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    // The legacy call was startDeferredDrawing(pos) — clearSelection stays the callee default.
    expect(deferredDrawing.start).toHaveBeenCalledTimes(1);
    expect(deferredDrawing.start.mock.calls[0]).toEqual([position]);
  });

  it("invalidates the global tool tail on every path, the non-drawing select path included", () => {
    for (const options of [
      { position: { x: 80, y: 50 }, annotations: [BOX] }, // select path (non-drawing)
      { position: { x: 150, y: 30 } }, // empty-canvas draw path
      { position: { x: 60, y: 11 }, annotations: [BOX], selectedId: 7 }, // label-delete path
      // [refactor jul16 P3.2 repair, prober hole 6b] corner-resize path: hoisting the invalidate
      // below the corner loop kept count(...)===1 pins green while skipping this path.
      { position: { x: 40, y: 20 }, annotations: [BOX], selectedId: 7 }, // corner-resize path
    ]) {
      const token = claimToolTailAuthority({});
      expect(ownsToolTailAuthority(token)).toBe(true);
      const { context } = contextFor(options);
      markupController.onMouseDown(mockEvent(), context);
      expect(ownsToolTailAuthority(token)).toBe(false);
    }
  });
});

describe("markupController.wantsEvents (P3.4 production registry gate)", () => {
  it("requires the base markup mode with NO specialized owner", () => {
    expect(markupController.wantsEvents(toolState())).toBe(true);
    expect(markupController.wantsEvents(toolState({ activeTool: { kind: "calibration" } }))).toBe(false);
    expect(markupController.wantsEvents(toolState({ mode: "pointer" }))).toBe(false);
    expect(markupController.wantsEvents(toolState({ mode: "move" }))).toBe(false);
    expect(markupController.wantsEvents(toolState({ mode: "group" }))).toBe(false);
  });
});
