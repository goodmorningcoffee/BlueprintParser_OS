// @vitest-environment node
//
// [refactor jul20 P3.4 parent freeze] AnnotationOverlay still owns the production canvas-event
// predicate at this HEAD. This pure net proves that the complete registered controller set already
// computes the same boolean, including its intentional overlapping claimants, before the gate moves.

import { describe, expect, it } from "vitest";

import {
  selectActiveToolKey,
  type ActiveTool,
  type BaseInteractionMode,
} from "@/lib/active-tool-state";
import { useToolStore, type ToolStoreState } from "@/stores/toolStore";

import { TOOLS } from "../tools/registry";

const MODES = Object.freeze([
  "move",
  "markup",
  "pointer",
  "group",
] as const satisfies readonly BaseInteractionMode[]);

const ACTIVE_VARIANTS = Object.freeze([
  { label: "calibration", activeTool: { kind: "calibration" } },
  { label: "takeoffPlacement", activeTool: { kind: "takeoffPlacement" } },
  { label: "bucketFill", activeTool: { kind: "bucketFill" } },
  { label: "split", activeTool: { kind: "split" } },
  { label: "symbolTemplate", activeTool: { kind: "symbolTemplate" } },
  { label: "tagPick", activeTool: { kind: "tagPick" } },
  { label: "tagAdd", activeTool: { kind: "tagAdd", tagId: "tag-7" } },
  { label: "parseRect:table", activeTool: { kind: "parseRect", flow: "table" } },
  { label: "parseRect:keynote", activeTool: { kind: "parseRect", flow: "keynote" } },
  { label: "parseRect:notes", activeTool: { kind: "parseRect", flow: "notes" } },
  { label: "parseRect:spec", activeTool: { kind: "parseRect", flow: "spec" } },
] as const satisfies readonly Readonly<{ label: string; activeTool: Exclude<ActiveTool, null> }>[]);

function toolState(
  activeTool: ActiveTool,
  mode: BaseInteractionMode,
  patch: Partial<ToolStoreState> = {},
): Readonly<ToolStoreState> {
  return {
    ...useToolStore.getInitialState(),
    ...patch,
    activeTool,
    mode,
  };
}

/** Exact AO:1637-1638 parent predicate, kept here as the pre-move behavior oracle. */
function manualCanvasWantsEvents(state: Readonly<ToolStoreState>): boolean {
  const activeToolKey = selectActiveToolKey(state);
  return activeToolKey !== null ||
    (activeToolKey === null &&
      (state.mode === "markup" || state.mode === "pointer" || state.mode === "group"));
}

function registryWantsEvents(state: Readonly<ToolStoreState>): boolean {
  return TOOLS.some((controller) => controller.wantsEvents(state));
}

function claimantKinds(state: Readonly<ToolStoreState>): string[] {
  return TOOLS
    .filter((controller) => controller.wantsEvents(state))
    .map((controller) => controller.kind);
}

function manualCanvasShouldRender(
  state: Readonly<ToolStoreState>,
  inputs: Readonly<{
    pageAnnotationCount?: number;
    pendingMarkup?: boolean;
    showTableCellStructure?: boolean;
    tableCellStructurePage?: number | null;
    pageNumber?: number;
  }> = {},
): boolean {
  const pageNumber = inputs.pageNumber ?? 1;
  return (inputs.pageAnnotationCount ?? 0) > 0 ||
    state.polygonDrawingMode !== "idle" ||
    (inputs.pendingMarkup ?? false) ||
    manualCanvasWantsEvents(state) ||
    (
      inputs.showTableCellStructure === true &&
      inputs.tableCellStructurePage === pageNumber
    );
}

describe("P3.4 registry wantsEvents parent gate", () => {
  it("pins the complete frozen registry order and required wantsEvents contract", () => {
    expect(Object.isFrozen(TOOLS)).toBe(true);
    expect(TOOLS.map((controller) => controller.kind)).toEqual([
      "calibration",
      "split",
      "bucketFill",
      "takeoffPolygon",
      "takeoffLinear",
      "takeoffCount",
      "keynotePick",
      "tagPick",
      "symbolSearch",
      "tagAdd",
      "parseRect",
      "pointerGroup",
      "markup",
    ]);
    for (const controller of TOOLS) {
      expect(typeof controller.wantsEvents, controller.kind).toBe("function");
    }
  });

  it("equals the manual gate for every activation variant crossed with every base mode", () => {
    for (const { label, activeTool } of ACTIVE_VARIANTS) {
      for (const mode of MODES) {
        const state = toolState(activeTool, mode);
        expect(registryWantsEvents(state), `${label}/${mode} registry`).toBe(true);
        expect(registryWantsEvents(state), `${label}/${mode} equivalence`).toBe(
          manualCanvasWantsEvents(state),
        );
      }
    }

    for (const mode of MODES) {
      const state = toolState(null, mode);
      const expected = mode !== "move";
      expect(registryWantsEvents(state), `base/${mode} registry`).toBe(expected);
      expect(registryWantsEvents(state), `base/${mode} equivalence`).toBe(
        manualCanvasWantsEvents(state),
      );
    }
  });

  it("keeps the deliberate takeoff and keynote overlaps boolean-equivalent", () => {
    expect(claimantKinds(toolState({ kind: "takeoffPlacement" }, "move"))).toEqual([
      "takeoffPolygon",
      "takeoffLinear",
      "takeoffCount",
    ]);
    expect(claimantKinds(toolState(
      { kind: "parseRect", flow: "keynote" },
      "move",
    ))).toEqual([
      "keynotePick",
      "parseRect",
    ]);
    for (const flow of ["table", "notes", "spec"] as const) {
      expect(claimantKinds(toolState({ kind: "parseRect", flow }, "move"))).toEqual([
        "parseRect",
      ]);
    }
  });

  it("ignores temp-pan and unrelated drawing/tool payload while preserving active/mode truth", () => {
    const unrelatedPatches: readonly Partial<ToolStoreState>[] = [
      { tempPanMode: true },
      {
        _drawing: true,
        polygonDrawingMode: "drawing",
        polygonVertices: [{ x: 0.2, y: 0.3 }],
      },
      {
        bucketFillLoading: true,
        bucketFillError: "unrelated",
        splitLineA: { x: 0.1, y: 0.2 },
      },
    ];

    for (const patch of unrelatedPatches) {
      const inert = toolState(null, "move", patch);
      expect(registryWantsEvents(inert)).toBe(false);
      expect(registryWantsEvents(inert)).toBe(manualCanvasWantsEvents(inert));

      const active = toolState({ kind: "split" }, "move", patch);
      expect(registryWantsEvents(active)).toBe(true);
      expect(registryWantsEvents(active)).toBe(manualCanvasWantsEvents(active));
    }
  });

  it("keeps annotations, markup, TATR, drawing, and temp-pan outside the registry-owned event predicate", () => {
    const move = toolState(null, "move", { tempPanMode: true });
    expect(registryWantsEvents(move)).toBe(false);
    expect(manualCanvasShouldRender(move)).toBe(false);
    expect(manualCanvasShouldRender(move, { pageAnnotationCount: 1 })).toBe(true);
    expect(manualCanvasShouldRender(move, { pendingMarkup: true })).toBe(true);
    expect(manualCanvasShouldRender(move, {
      showTableCellStructure: true,
      tableCellStructurePage: 4,
      pageNumber: 4,
    })).toBe(true);
    expect(manualCanvasShouldRender(move, {
      showTableCellStructure: true,
      tableCellStructurePage: 3,
      pageNumber: 4,
    })).toBe(false);

    const drawing = toolState(null, "move", {
      tempPanMode: true,
      polygonDrawingMode: "drawing",
    });
    expect(registryWantsEvents(drawing)).toBe(false);
    expect(manualCanvasShouldRender(drawing)).toBe(true);

    const activeWhilePanning = toolState(
      { kind: "bucketFill" },
      "move",
      { tempPanMode: true },
    );
    expect(registryWantsEvents(activeWhilePanning)).toBe(true);
    expect(manualCanvasShouldRender(activeWhilePanning)).toBe(true);
  });
});
