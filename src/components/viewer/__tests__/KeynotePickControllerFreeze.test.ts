// @vitest-environment node
//
// [refactor jul18 P3.2] Direct contract for keynotePickController, landed with its registration.
// The real-overlay net proves the legacy end-to-end seam; this net makes decline/claim values,
// split capability guards, exact effect order, and real-registry miss delegation observable.

import type { MouseEvent as ReactMouseEvent } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  claimToolTailAuthority,
  ownsToolTailAuthority,
} from "@/lib/parse-tool-authority";
import { useParseFlowStore } from "@/stores/parseFlowStore";
import type { ToolStoreState } from "@/stores/toolStore";
import type { ClientAnnotation } from "@/types";
import { keynotePickController } from "../tools/keynotePick";
import { dispatchToolMouseDown, TOOLS } from "../tools/registry";
import { TOOL_STORE_CAPABILITIES } from "../tools/capabilities";
import type { ToolContext, ToolPressSnapshot } from "../tools/types";

function toolState(activeTool: unknown = { kind: "parseRect", flow: "keynote" }) {
  return { activeTool, mode: "move" } as unknown as Readonly<ToolStoreState>;
}

function annotation(
  id: number,
  name: string,
  bbox: [number, number, number, number] = [0.3, 0.2, 0.6, 0.7],
  over: Partial<ClientAnnotation> = {},
): ClientAnnotation {
  return {
    id,
    pageNumber: 1,
    name,
    bbox,
    note: null,
    source: "yolo",
    data: { modelName: "fixture" },
    ...over,
  };
}

function eventWith(stopPropagation = vi.fn()) {
  return { stopPropagation } as unknown as ReactMouseEvent & {
    stopPropagation: ReturnType<typeof vi.fn>;
  };
}

function contextFor(options: {
  position?: { x: number; y: number };
  state?: Readonly<ToolStoreState>;
  active?: boolean;
  annotations?: readonly ClientAnnotation[];
  includeAnnotations?: boolean;
  deferredResult?: boolean;
} = {}) {
  const state = options.state ?? toolState();
  const position = options.position ?? { x: 80, y: 30 };
  const press: ToolPressSnapshot = {
    toolAtDown: state,
    position,
    publicId: "keynote-controller",
    pageNumber: 1,
  };
  const deferredDrawing = { start: vi.fn(() => options.deferredResult ?? true) };
  const context: ToolContext = {
    press,
    page: { publicId: press.publicId, number: 1, width: 200, height: 100 },
    stores: TOOL_STORE_CAPABILITIES,
    canAdoptProjectLifecycle: () => true,
    keynotePick: { active: options.active ?? true },
    ...(options.includeAnnotations === false
      ? {}
      : { pageAnnotations: options.annotations ?? [] }),
    deferredDrawing,
  };
  return { context, deferredDrawing };
}

describe("keynotePickController eligibility and split guards", () => {
  beforeEach(() => {
    useParseFlowStore.setState({ keynoteYoloClass: null });
  });

  it("matches and wants events only for the parseRect keynote activation", () => {
    const press = (state: Readonly<ToolStoreState>) => contextFor({ state }).context.press;
    const cases = [
      { state: toolState(), expected: true },
      { state: toolState({ kind: "parseRect", flow: "table" }), expected: false },
      { state: toolState({ kind: "calibration" }), expected: false },
      { state: toolState(null), expected: false },
    ];
    for (const { state, expected } of cases) {
      expect(keynotePickController.matches(press(state))).toBe(expected);
      expect(keynotePickController.wantsEvents(state)).toBe(expected);
    }
  });

  it("an inactive or absent render projection declines before requiring annotations", () => {
    for (const projection of [false, undefined]) {
      const token = claimToolTailAuthority({});
      const { context, deferredDrawing } = contextFor({
        active: projection,
        includeAnnotations: false,
      });
      const bare = projection === undefined ? { ...context, keynotePick: undefined } : context;
      const event = eventWith();
      expect(keynotePickController.onMouseDown(event, bare as ToolContext)).toBe(false);
      expect(event.stopPropagation).not.toHaveBeenCalled();
      expect(deferredDrawing.start).not.toHaveBeenCalled();
      expect(ownsToolTailAuthority(token)).toBe(true);
      expect(useParseFlowStore.getState().keynoteYoloClass).toBeNull();
    }
  });

  it("fails loudly for missing pageAnnotations only in the active projection", () => {
    const { context } = contextFor({ active: true, includeAnnotations: false });
    expect(() => keynotePickController.onMouseDown(eventWith(), context)).toThrow(
      "keynotePick controller requires pageAnnotations while its render projection is active",
    );
  });

  it("an active miss returns false with zero picker-owned effects", () => {
    const token = claimToolTailAuthority({});
    const { context, deferredDrawing } = contextFor({ annotations: [] });
    const event = eventWith();
    expect(keynotePickController.onMouseDown(event, context)).toBe(false);
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(deferredDrawing.start).not.toHaveBeenCalled();
    expect(ownsToolTailAuthority(token)).toBe(true);
    expect(useParseFlowStore.getState().keynoteYoloClass).toBeNull();
  });
});

describe("keynotePickController hit contract", () => {
  beforeEach(() => {
    useParseFlowStore.setState({ keynoteYoloClass: null });
  });

  it.each([
    { label: "top-left", position: { x: 60, y: 20 } },
    { label: "bottom-right", position: { x: 120, y: 70 } },
  ])("uses inclusive anisotropic bbox geometry at $label", ({ position }) => {
    const { context } = contextFor({ position, annotations: [annotation(1, "Boundary")] });
    expect(keynotePickController.onMouseDown(eventWith(), context)).toBe(true);
    expect(useParseFlowStore.getState().keynoteYoloClass).toEqual({
      model: "fixture",
      className: "Boundary",
    });
  });

  it.each([
    { edge: "left", position: { x: 59.98, y: 30 } },
    { edge: "top", position: { x: 80, y: 19.99 } },
    { edge: "right", position: { x: 120.02, y: 30 } },
    { edge: "bottom", position: { x: 80, y: 70.01 } },
  ])("declines with zero effects when the click is just outside the $edge bbox edge", ({ position }) => {
    const token = claimToolTailAuthority({});
    const { context, deferredDrawing } = contextFor({
      position,
      annotations: [annotation(10, "Outside")],
    });
    const event = eventWith();

    expect(keynotePickController.onMouseDown(event, context)).toBe(false);

    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(deferredDrawing.start).not.toHaveBeenCalled();
    expect(ownsToolTailAuthority(token)).toBe(true);
    expect(useParseFlowStore.getState().keynoteYoloClass).toBeNull();
  });

  it("skips non-YOLO rows and selects the first overlapping YOLO in array order", () => {
    const bait = annotation(1, "Bait", undefined, {
      source: "user",
      data: { modelName: "bait" },
    });
    const first = annotation(2, "First", undefined, { data: { modelName: "first" } });
    const second = annotation(3, "Second", undefined, { data: { modelName: "second" } });
    const { context } = contextFor({ annotations: [bait, first, second] });
    expect(keynotePickController.onMouseDown(eventWith(), context)).toBe(true);
    expect(useParseFlowStore.getState().keynoteYoloClass).toEqual({
      model: "first",
      className: "First",
    });
  });

  it.each([
    { label: "absent", data: undefined },
    { label: "empty", data: { modelName: "" } },
  ])("uses model 'unknown' when modelName is $label", ({ data }) => {
    const { context } = contextFor({ annotations: [annotation(4, "Fallback", undefined, { data })] });
    expect(keynotePickController.onMouseDown(eventWith(), context)).toBe(true);
    expect(useParseFlowStore.getState().keynoteYoloClass).toEqual({
      model: "unknown",
      className: "Fallback",
    });
  });

  it("orders a hit as invalidate -> stop -> command and returns true", () => {
    const token = claimToolTailAuthority({});
    const journal: string[] = [];
    const event = eventWith(vi.fn(() => {
      journal.push(`stop:owns=${ownsToolTailAuthority(token)}`);
    }));
    const unsubscribe = useParseFlowStore.subscribe((state, previous) => {
      if (state.keynoteYoloClass !== previous.keynoteYoloClass) {
        journal.push(`command:stopped=${journal[0] === "stop:owns=false"}`);
      }
    });
    const { context } = contextFor({
      annotations: [annotation(5, "Ordered", undefined, { data: { modelName: "ordered" } })],
    });

    expect(keynotePickController.onMouseDown(event, context)).toBe(true);
    unsubscribe();

    expect(journal).toEqual(["stop:owns=false", "command:stopped=true"]);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(ownsToolTailAuthority(token)).toBe(false);
    expect(useParseFlowStore.getState().keynoteYoloClass).toEqual({
      model: "ordered",
      className: "Ordered",
    });
  });
});

describe("keynotePick + parseRect real registry integration", () => {
  beforeEach(() => {
    useParseFlowStore.setState({ keynoteYoloClass: null });
  });

  it("an active picker miss delegates through the same context and parseRect claims", () => {
    const { context, deferredDrawing } = contextFor({ annotations: [] });
    const event = eventWith();
    expect(dispatchToolMouseDown(TOOLS, event, context.press, () => context)).toBe(true);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(deferredDrawing.start).toHaveBeenCalledExactlyOnceWith(context.press.position);
    expect(useParseFlowStore.getState().keynoteYoloClass).toBeNull();
  });

  it("a picker hit claims before parseRect and never starts drawing", () => {
    const { context, deferredDrawing } = contextFor({ annotations: [annotation(6, "Hit")] });
    const event = eventWith();
    expect(dispatchToolMouseDown(TOOLS, event, context.press, () => context)).toBe(true);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(deferredDrawing.start).not.toHaveBeenCalled();
    expect(useParseFlowStore.getState().keynoteYoloClass?.className).toBe("Hit");
  });
});
