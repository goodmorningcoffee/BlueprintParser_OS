// @vitest-environment node
// [refactor jul13 P2.3 AT2] The characterized flat tool owner now has one atomic discriminator.
// This owner-local suite freezes dormant-session behavior independently of cross-store commands.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  claimToolTailAuthority,
  invalidateToolTailAuthority,
  ownsToolTailAuthority,
} from "@/lib/parse-tool-authority";
import { useToolStore } from "@/stores/toolStore";
import type { ClientAnnotation, ScaleCalibrationData } from "@/types";

type ToolState = ReturnType<typeof useToolStore.getState>;

/** Exact mechanically-flat Tool boundary after drawing-last. Parse/server/UI/core stay excluded. */
export const TOOL_DATA_KEYS = [
  "mode",
  "tempPanMode",
  "activeTool",
  "_drawing",
  "_drawStart",
  "_drawEnd",
  "_mousePos",
  "activeTakeoffItemId",
  "scaleCalibrations",
  "calibrationMode",
  "calibrationPoints",
  "polygonDrawingMode",
  "polygonVertices",
  "bucketFillPreview",
  "bucketFillLoading",
  "bucketFillError",
  "bucketFillTolerance",
  "bucketFillDilatePx",
  "bucketFillResolution",
  "bucketFillPendingPolygon",
  "splitLineA",
  "splitLineB",
  "splitPreview",
  "splitError",
  "bucketFillBarriers",
  "bucketFillBarrierMode",
  "barrierPendingPoint",
  "takeoffUndoStack",
  "takeoffRedoStack",
  "tagScanResults",
  "symbolSearchLoading",
  "symbolSearchProgress",
  "symbolSearchResults",
  "symbolSearchConfidence",
  "dismissedSymbolMatches",
  "symbolSearchError",
  "symbolSearchTemplateBbox",
  "symbolSearchSourcePage",
  "symbolSearchConfig",
  "symbolSearchPreset",
] as const satisfies readonly (keyof ToolState)[];

/** Existing named compatibility actions; resetProjectToolState remains the additional boundary. */
export const TOOL_ACTION_KEYS = [
  "setMode",
  "setTempPanMode",
  "_setDrawing",
  "_setDrawStart",
  "_setDrawEnd",
  "_setMousePos",
  "setActiveTakeoffItemId",
  "setScaleCalibration",
  "setCalibrationMode",
  "setCalibrationPoint",
  "resetCalibration",
  "setPolygonDrawingMode",
  "addPolygonVertex",
  "undoLastVertex",
  "resetPolygonDrawing",
  "setBucketFillActive",
  "setBucketFillPreview",
  "setBucketFillLoading",
  "setBucketFillError",
  "setBucketFillTolerance",
  "setBucketFillDilatePx",
  "setBucketFillResolution",
  "setBucketFillPendingPolygon",
  "setSplitAreaActive",
  "setSplitLineEndpoint",
  "setSplitPreview",
  "setSplitError",
  "addBucketFillBarrier",
  "undoLastBarrier",
  "clearBucketFillBarriers",
  "setBucketFillBarrierMode",
  "setBarrierPendingPoint",
  "setYoloTagPickingMode",
  "setTagScanResults",
  "setTagAddingMode",
  "setSymbolSearchActive",
  "setSymbolSearchLoading",
  "setSymbolSearchProgress",
  "setSymbolSearchResults",
  "setSymbolSearchConfidence",
  "dismissSymbolMatch",
  "setSymbolSearchError",
  "setSymbolSearchTemplateBbox",
  "setSymbolSearchSourcePage",
  "setSymbolSearchConfig",
  "setSymbolSearchPreset",
  "clearSymbolSearch",
] as const satisfies readonly (keyof ToolState)[];

/** Every Tool field is project-owned and returns to its construction default at activation reset. */
export const TOOL_PROJECT_RESET_KEYS = TOOL_DATA_KEYS;

/** Reset must allocate these mutable construction defaults afresh. */
export const TOOL_PROJECT_RESET_MUTABLE_KEYS = [
  "_drawStart",
  "_drawEnd",
  "scaleCalibrations",
  "calibrationPoints",
  "polygonVertices",
  "bucketFillBarriers",
  "takeoffUndoStack",
  "takeoffRedoStack",
  "dismissedSymbolMatches",
  "symbolSearchConfig",
] as const satisfies readonly (typeof TOOL_DATA_KEYS)[number][];

type ToolDataKey = (typeof TOOL_DATA_KEYS)[number];
type ToolActionKey = (typeof TOOL_ACTION_KEYS)[number];

const CALIBRATION: ScaleCalibrationData = {
  type: "scale-calibration",
  point1: { x: 0.1, y: 0.2 },
  point2: { x: 0.8, y: 0.7 },
  realDistance: 24,
  unit: "ft",
};

const SECOND_CALIBRATION: ScaleCalibrationData = {
  type: "scale-calibration",
  point1: { x: 0.2, y: 0.3 },
  point2: { x: 0.7, y: 0.6 },
  realDistance: 10,
  unit: "m",
};

const ANNOTATION: ClientAnnotation = {
  id: 91,
  pageNumber: 3,
  name: "fixture",
  bbox: [0.1, 0.2, 0.3, 0.4],
  note: null,
  source: "takeoff",
};

const SECOND_ANNOTATION: ClientAnnotation = {
  ...ANNOTATION,
  id: 92,
};

const BUCKET_PREVIEW: NonNullable<ToolState["bucketFillPreview"]> = {
  vertices: [{ x: 0.1, y: 0.2 }, { x: 0.7, y: 0.2 }, { x: 0.4, y: 0.8 }],
  holes: [{ vertices: [{ x: 0.3, y: 0.3 }, { x: 0.4, y: 0.3 }, { x: 0.35, y: 0.4 }] }],
  method: "fixture",
};

const PENDING_POLYGON: NonNullable<ToolState["bucketFillPendingPolygon"]> = {
  vertices: BUCKET_PREVIEW.vertices,
  holes: BUCKET_PREVIEW.holes,
  method: "fixture",
  bbox: [0.1, 0.2, 0.6, 0.6],
  areaSqUnits: 144,
  unit: "sq ft",
};

const SPLIT_PREVIEW: NonNullable<ToolState["splitPreview"]> = {
  targetAnnotationId: 91,
  original: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.5, y: 0.9 }],
  left: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.9 }],
  right: [{ x: 0.5, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.5, y: 0.9 }],
  lineA: { x: 0.5, y: 0 },
  lineB: { x: 0.5, y: 1 },
};

const TAG_SCAN_RESULTS: NonNullable<ToolState["tagScanResults"]> = {
  yoloClass: "door",
  yoloModel: "fixture-model",
  texts: [],
};

const SYMBOL_RESULTS: NonNullable<ToolState["symbolSearchResults"]> = {
  templateBbox: [0.1, 0.2, 0.3, 0.4],
  sourcePageNumber: 3,
  matches: [],
  totalMatches: 0,
  pagesWithMatches: [],
  searchedAt: "2026-07-11T00:00:00.000Z",
};

const BARRIER = { x1: 0.1, y1: 0.2, x2: 0.7, y2: 0.8 };

function restoreToolOwner(): void {
  useToolStore.setState(useToolStore.getInitialState(), true);
}

function pickToolData(state: ToolState): Pick<ToolState, ToolDataKey> {
  return Object.fromEntries(TOOL_DATA_KEYS.map((key) => [key, state[key]])) as Pick<
    ToolState,
    ToolDataKey
  >;
}

function pickToolActions(state: ToolState): Pick<ToolState, ToolActionKey> {
  return Object.fromEntries(TOOL_ACTION_KEYS.map((key) => [key, state[key]])) as Pick<
    ToolState,
    ToolActionKey
  >;
}

function changedToolKeys(before: ToolState, after: ToolState): ToolDataKey[] {
  return TOOL_DATA_KEYS
    .filter((key) => !Object.is(before[key], after[key]))
    .sort();
}

function sorted(keys: readonly ToolDataKey[]): ToolDataKey[] {
  return [...keys].sort();
}

function defaultSymbolConfig(): ToolState["symbolSearchConfig"] {
  return {
    multiScale: true,
    useSiftFallback: true,
    searchPages: null,
    scaleMin: 0.8,
    scaleMax: 1.5,
    nmsThreshold: 0.3,
    maxMatchesPerPage: 50,
  };
}

beforeEach(() => {
  invalidateToolTailAuthority();
  restoreToolOwner();
});

describe("flat toolStore drawing-last — exact boundary and defaults", () => {
  it("exports a unique 40-data / 47-action / 40-field project-reset ledger", () => {
    expect(TOOL_DATA_KEYS).toHaveLength(40);
    expect(new Set(TOOL_DATA_KEYS).size).toBe(40);
    expect(TOOL_ACTION_KEYS).toHaveLength(47);
    expect(new Set(TOOL_ACTION_KEYS).size).toBe(47);
    expect(TOOL_PROJECT_RESET_KEYS).toHaveLength(40);
    expect(new Set(TOOL_PROJECT_RESET_KEYS).size).toBe(40);
    expect(TOOL_PROJECT_RESET_KEYS).toEqual(TOOL_DATA_KEYS);
    expect(TOOL_PROJECT_RESET_MUTABLE_KEYS).toHaveLength(10);
    expect(new Set(TOOL_PROJECT_RESET_MUTABLE_KEYS).size).toBe(10);

    const state = useToolStore.getState();
    for (const action of TOOL_ACTION_KEYS) expect(state[action]).toBeTypeOf("function");
  });

  it("freezes all 40 construction defaults", () => {
    expect(pickToolData(useToolStore.getInitialState())).toEqual({
      mode: "move",
      tempPanMode: false,
      activeTool: null,
      _drawing: false,
      _drawStart: { x: 0, y: 0 },
      _drawEnd: { x: 0, y: 0 },
      _mousePos: null,
      activeTakeoffItemId: null,
      scaleCalibrations: {},
      calibrationMode: "idle",
      calibrationPoints: {},
      polygonDrawingMode: "idle",
      polygonVertices: [],
      bucketFillPreview: null,
      bucketFillLoading: false,
      bucketFillError: null,
      bucketFillTolerance: 30,
      bucketFillDilatePx: 3,
      bucketFillResolution: 1000,
      bucketFillPendingPolygon: null,
      splitLineA: null,
      splitLineB: null,
      splitPreview: null,
      splitError: null,
      bucketFillBarriers: [],
      bucketFillBarrierMode: false,
      barrierPendingPoint: null,
      takeoffUndoStack: [],
      takeoffRedoStack: [],
      tagScanResults: null,
      symbolSearchLoading: false,
      symbolSearchProgress: null,
      symbolSearchResults: null,
      symbolSearchConfidence: 0.75,
      dismissedSymbolMatches: new Set<string>(),
      symbolSearchError: null,
      symbolSearchTemplateBbox: null,
      symbolSearchSourcePage: null,
      symbolSearchConfig: defaultSymbolConfig(),
      symbolSearchPreset: "lite",
    });
    expect(useToolStore.getInitialState()._drawStart)
      .not.toBe(useToolStore.getInitialState()._drawEnd);
  });
});

interface PublicationCase {
  name: ToolActionKey;
  invoke: () => void;
}

const PUBLICATION_CASES: readonly PublicationCase[] = [
  { name: "setMode", invoke: () => useToolStore.getState().setMode("move") },
  { name: "setTempPanMode", invoke: () => useToolStore.getState().setTempPanMode(false) },
  { name: "_setDrawing", invoke: () => useToolStore.getState()._setDrawing(false) },
  { name: "_setDrawStart", invoke: () => useToolStore.getState()._setDrawStart({ x: 0, y: 0 }) },
  { name: "_setDrawEnd", invoke: () => useToolStore.getState()._setDrawEnd({ x: 0, y: 0 }) },
  { name: "_setMousePos", invoke: () => useToolStore.getState()._setMousePos(null) },
  { name: "setActiveTakeoffItemId", invoke: () => useToolStore.getState().setActiveTakeoffItemId(null) },
  { name: "setScaleCalibration", invoke: () => useToolStore.getState().setScaleCalibration(1, CALIBRATION) },
  { name: "setCalibrationMode", invoke: () => useToolStore.getState().setCalibrationMode("idle") },
  { name: "setCalibrationPoint", invoke: () => useToolStore.getState().setCalibrationPoint("p1", { x: 0.1, y: 0.2 }) },
  { name: "resetCalibration", invoke: () => useToolStore.getState().resetCalibration() },
  { name: "setPolygonDrawingMode", invoke: () => useToolStore.getState().setPolygonDrawingMode("idle") },
  { name: "addPolygonVertex", invoke: () => useToolStore.getState().addPolygonVertex({ x: 0.1, y: 0.2 }) },
  { name: "undoLastVertex", invoke: () => useToolStore.getState().undoLastVertex() },
  { name: "resetPolygonDrawing", invoke: () => useToolStore.getState().resetPolygonDrawing() },
  { name: "setBucketFillActive", invoke: () => useToolStore.getState().setBucketFillActive(false) },
  { name: "setBucketFillPreview", invoke: () => useToolStore.getState().setBucketFillPreview(null) },
  { name: "setBucketFillLoading", invoke: () => useToolStore.getState().setBucketFillLoading(false) },
  { name: "setBucketFillError", invoke: () => useToolStore.getState().setBucketFillError(null) },
  { name: "setBucketFillTolerance", invoke: () => useToolStore.getState().setBucketFillTolerance(30) },
  { name: "setBucketFillDilatePx", invoke: () => useToolStore.getState().setBucketFillDilatePx(3) },
  { name: "setBucketFillResolution", invoke: () => useToolStore.getState().setBucketFillResolution(1000) },
  { name: "setBucketFillPendingPolygon", invoke: () => useToolStore.getState().setBucketFillPendingPolygon(null) },
  { name: "setSplitAreaActive", invoke: () => useToolStore.getState().setSplitAreaActive(false) },
  { name: "setSplitLineEndpoint", invoke: () => useToolStore.getState().setSplitLineEndpoint("a", null) },
  { name: "setSplitPreview", invoke: () => useToolStore.getState().setSplitPreview(null) },
  { name: "setSplitError", invoke: () => useToolStore.getState().setSplitError(null) },
  { name: "addBucketFillBarrier", invoke: () => useToolStore.getState().addBucketFillBarrier(BARRIER) },
  { name: "undoLastBarrier", invoke: () => useToolStore.getState().undoLastBarrier() },
  { name: "clearBucketFillBarriers", invoke: () => useToolStore.getState().clearBucketFillBarriers() },
  { name: "setBucketFillBarrierMode", invoke: () => useToolStore.getState().setBucketFillBarrierMode(false) },
  { name: "setBarrierPendingPoint", invoke: () => useToolStore.getState().setBarrierPendingPoint(null) },
  { name: "setYoloTagPickingMode", invoke: () => useToolStore.getState().setYoloTagPickingMode(false) },
  { name: "setTagScanResults", invoke: () => useToolStore.getState().setTagScanResults(null) },
  { name: "setTagAddingMode", invoke: () => useToolStore.getState().setTagAddingMode(null) },
  { name: "setSymbolSearchActive", invoke: () => useToolStore.getState().setSymbolSearchActive(false) },
  { name: "setSymbolSearchLoading", invoke: () => useToolStore.getState().setSymbolSearchLoading(false) },
  { name: "setSymbolSearchProgress", invoke: () => useToolStore.getState().setSymbolSearchProgress(null) },
  { name: "setSymbolSearchResults", invoke: () => useToolStore.getState().setSymbolSearchResults(null) },
  { name: "setSymbolSearchConfidence", invoke: () => useToolStore.getState().setSymbolSearchConfidence(0.75) },
  { name: "dismissSymbolMatch", invoke: () => useToolStore.getState().dismissSymbolMatch("fixture") },
  { name: "setSymbolSearchError", invoke: () => useToolStore.getState().setSymbolSearchError(null) },
  { name: "setSymbolSearchTemplateBbox", invoke: () => useToolStore.getState().setSymbolSearchTemplateBbox(null) },
  { name: "setSymbolSearchSourcePage", invoke: () => useToolStore.getState().setSymbolSearchSourcePage(null) },
  { name: "setSymbolSearchConfig", invoke: () => useToolStore.getState().setSymbolSearchConfig({}) },
  { name: "setSymbolSearchPreset", invoke: () => useToolStore.getState().setSymbolSearchPreset("lite") },
  { name: "clearSymbolSearch", invoke: () => useToolStore.getState().clearSymbolSearch() },
];

describe("flat toolStore AT2 — compatibility action publications", () => {
  it("covers every compatibility action once and in ledger order", () => {
    expect(PUBLICATION_CASES.map(({ name }) => name)).toEqual(TOOL_ACTION_KEYS);
  });

  it.each(PUBLICATION_CASES)("$name publishes exactly once, including same-value calls", ({ invoke }) => {
    const listener = vi.fn();
    const unsubscribe = useToolStore.subscribe(listener);
    invoke();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});

describe("flat toolStore drawing-last — gesture-neutral writers", () => {
  it("keeps exact tail authority across all four same-value drawing publications", () => {
    const token = claimToolTailAuthority({});
    const state = useToolStore.getState();
    state._setDrawing(state._drawing);
    state._setDrawStart(state._drawStart);
    state._setDrawEnd(state._drawEnd);
    state._setMousePos(state._mousePos);
    expect(ownsToolTailAuthority(token)).toBe(true);
  });
});

describe("flat toolStore AT2 — compound destinations and exclusions", () => {
  it("setMode writes exactly its 14-field teardown and allocates both empty arrays", () => {
    const polygonVertices = [{ x: 0.2, y: 0.3 }];
    const barriers = [BARRIER];
    const pending = PENDING_POLYGON;
    const undo = [ANNOTATION];
    const redo = [SECOND_ANNOTATION];
    useToolStore.setState({
      mode: "markup",
      tempPanMode: true,
      activeTool: { kind: "symbolTemplate" },
      activeTakeoffItemId: 91,
      calibrationMode: "input",
      polygonDrawingMode: "drawing",
      polygonVertices,
      bucketFillPreview: BUCKET_PREVIEW,
      bucketFillLoading: true,
      bucketFillError: "retain",
      bucketFillPendingPolygon: pending,
      bucketFillBarriers: barriers,
      bucketFillBarrierMode: true,
      barrierPendingPoint: { x: 0.4, y: 0.5 },
      splitLineA: { x: 0.1, y: 0.2 },
      splitLineB: { x: 0.7, y: 0.8 },
      splitPreview: SPLIT_PREVIEW,
      splitError: "split",
      takeoffUndoStack: undo,
      takeoffRedoStack: redo,
    });
    const before = useToolStore.getState();

    before.setMode("pointer");
    const after = useToolStore.getState();

    expect(changedToolKeys(before, after)).toEqual(sorted([
      "mode",
      "tempPanMode",
      "activeTool",
      "activeTakeoffItemId",
      "polygonDrawingMode",
      "polygonVertices",
      "bucketFillPreview",
      "bucketFillLoading",
      "bucketFillBarriers",
      "bucketFillBarrierMode",
      "splitLineA",
      "splitLineB",
      "splitPreview",
      "splitError",
    ]));
    expect(after).toMatchObject({
      mode: "pointer",
      tempPanMode: false,
      activeTool: null,
      activeTakeoffItemId: null,
      polygonDrawingMode: "idle",
      bucketFillPreview: null,
      bucketFillLoading: false,
      bucketFillBarrierMode: false,
      splitLineA: null,
      splitLineB: null,
      splitPreview: null,
      splitError: null,
    });
    expect(after.polygonVertices).toEqual([]);
    expect(after.polygonVertices).not.toBe(polygonVertices);
    expect(after.bucketFillBarriers).toEqual([]);
    expect(after.bucketFillBarriers).not.toBe(barriers);
    expect(after.bucketFillError).toBe("retain");
    expect(after.bucketFillPendingPolygon).toBe(pending);
    expect(after.takeoffUndoStack).toBe(undo);
    expect(after.takeoffRedoStack).toBe(redo);
    expect(after.calibrationMode).toBe("input");
  });

  it("setBucketFillActive preserves its asymmetric true/false write sets", () => {
    const barriers = [BARRIER];
    const pendingPoint = { x: 0.23, y: 0.67 };
    const undo = [ANNOTATION];
    useToolStore.setState({
      mode: "markup",
      tempPanMode: true,
      activeTool: { kind: "symbolTemplate" },
      activeTakeoffItemId: 91,
      bucketFillPreview: BUCKET_PREVIEW,
      bucketFillLoading: true,
      bucketFillError: "bucket",
      bucketFillPendingPolygon: PENDING_POLYGON,
      bucketFillBarriers: barriers,
      bucketFillBarrierMode: true,
      barrierPendingPoint: pendingPoint,
      splitLineA: { x: 0.1, y: 0.2 },
      splitLineB: { x: 0.7, y: 0.8 },
      splitPreview: SPLIT_PREVIEW,
      splitError: "split",
      takeoffUndoStack: undo,
    });
    const beforeTrue = useToolStore.getState();
    const actionsBeforeTrue = pickToolActions(beforeTrue);
    let truePublications = 0;
    const unsubscribeTrue = useToolStore.subscribe(() => {
      truePublications += 1;
    });
    beforeTrue.setBucketFillActive(true);
    unsubscribeTrue();
    const afterTrue = useToolStore.getState();

    expect(changedToolKeys(beforeTrue, afterTrue)).toEqual(sorted([
      "mode",
      "tempPanMode",
      "activeTool",
      "bucketFillPreview",
      "bucketFillLoading",
      "bucketFillError",
      "bucketFillBarrierMode",
      "barrierPendingPoint",
      "bucketFillPendingPolygon",
      "splitLineA",
      "splitLineB",
      "splitPreview",
      "splitError",
    ]));
    expect(afterTrue.activeTool).toEqual({ kind: "bucketFill" });
    expect(afterTrue.activeTool).not.toBe(beforeTrue.activeTool);
    expect(afterTrue.barrierPendingPoint).toBeNull();
    expect(truePublications).toBe(1);
    expect(afterTrue.bucketFillBarriers).toBe(barriers);
    expect(afterTrue.activeTakeoffItemId).toBe(91);
    expect(afterTrue.takeoffUndoStack).toBe(undo);
    for (const key of TOOL_ACTION_KEYS) {
      expect(afterTrue[key], `true must retain action ${key}`).toBe(
        actionsBeforeTrue[key],
      );
    }

    restoreToolOwner();
    useToolStore.setState({
      mode: "markup",
      activeTool: { kind: "bucketFill" },
      activeTakeoffItemId: 91,
      bucketFillPreview: BUCKET_PREVIEW,
      bucketFillLoading: true,
      bucketFillError: "bucket",
      bucketFillPendingPolygon: PENDING_POLYGON,
      bucketFillBarriers: barriers,
      bucketFillBarrierMode: true,
      barrierPendingPoint: pendingPoint,
    });
    const beforeFalse = useToolStore.getState();
    const actionsBeforeFalse = pickToolActions(beforeFalse);
    let falsePublications = 0;
    const unsubscribeFalse = useToolStore.subscribe(() => {
      falsePublications += 1;
    });
    beforeFalse.setBucketFillActive(false);
    unsubscribeFalse();
    const afterFalse = useToolStore.getState();

    expect(changedToolKeys(beforeFalse, afterFalse)).toEqual(sorted([
      "activeTool",
      "bucketFillPreview",
      "bucketFillLoading",
      "bucketFillError",
      "bucketFillPendingPolygon",
      "bucketFillBarriers",
      "bucketFillBarrierMode",
      "barrierPendingPoint",
    ]));
    expect(afterFalse.mode).toBe("markup");
    expect(afterFalse.activeTool).toEqual({ kind: "takeoffPlacement" });
    expect(afterFalse.activeTool).not.toBe(beforeFalse.activeTool);
    expect(afterFalse.bucketFillBarriers).toEqual([]);
    expect(afterFalse.bucketFillBarriers).not.toBe(barriers);
    expect(afterFalse.barrierPendingPoint).toBeNull();
    expect(falsePublications).toBe(1);
    for (const key of TOOL_ACTION_KEYS) {
      expect(afterFalse[key], `false must retain action ${key}`).toBe(
        actionsBeforeFalse[key],
      );
    }

    const unrelated = { kind: "tagPick" } as const;
    useToolStore.setState({
      activeTool: unrelated,
      barrierPendingPoint: pendingPoint,
    });
    useToolStore.getState().setBucketFillActive(false);
    expect(useToolStore.getState().activeTool).toBe(unrelated);
    expect(useToolStore.getState().barrierPendingPoint).toBeNull();
  });

  it.each([true, false])(
    "setBucketFillActive(%s) cannot erase a reentrant successor barrier point",
    (active) => {
      const stalePoint = { x: 0.13, y: 0.24 };
      const successorPoint = { x: 0.76, y: 0.85 };
      useToolStore.setState({
        activeTool: active ? { kind: "symbolTemplate" } : { kind: "bucketFill" },
        activeTakeoffItemId: 91,
        barrierPendingPoint: stalePoint,
      });
      let installed = 0;
      const publications: Array<{
        activeTool: ToolState["activeTool"];
        point: ToolState["barrierPendingPoint"];
      }> = [];
      const unsubscribe = useToolStore.subscribe((state, previous) => {
        publications.push({
          activeTool: state.activeTool,
          point: state.barrierPendingPoint,
        });
        if (state.activeTool === previous.activeTool) return;
        expect(state.barrierPendingPoint).toBeNull();
        installed += 1;
        state.setBarrierPendingPoint(successorPoint);
      });

      useToolStore.getState().setBucketFillActive(active);
      unsubscribe();

      expect(installed).toBe(1);
      expect(publications).toHaveLength(2);
      expect(publications[0]?.point).toBeNull();
      expect(publications[1]?.point).toBe(successorPoint);
      expect(publications[1]?.activeTool).toBe(publications[0]?.activeTool);
      expect(useToolStore.getState().barrierPendingPoint).toBe(successorPoint);
    },
  );

  it("setSplitAreaActive preserves its asymmetric true/false write sets", () => {
    const pending = PENDING_POLYGON;
    const undo = [ANNOTATION];
    useToolStore.setState({
      mode: "markup",
      tempPanMode: true,
      activeTool: { kind: "bucketFill" },
      activeTakeoffItemId: 91,
      bucketFillPreview: BUCKET_PREVIEW,
      bucketFillLoading: true,
      bucketFillError: "bucket",
      bucketFillPendingPolygon: pending,
      bucketFillBarriers: [BARRIER],
      bucketFillBarrierMode: true,
      splitLineA: { x: 0.1, y: 0.2 },
      splitLineB: { x: 0.7, y: 0.8 },
      splitPreview: SPLIT_PREVIEW,
      splitError: "split",
      takeoffUndoStack: undo,
    });
    const beforeTrue = useToolStore.getState();
    beforeTrue.setSplitAreaActive(true);
    const afterTrue = useToolStore.getState();

    expect(changedToolKeys(beforeTrue, afterTrue)).toEqual(sorted([
      "mode",
      "activeTool",
      "activeTakeoffItemId",
      "bucketFillPreview",
      "bucketFillLoading",
      "bucketFillError",
      "splitLineA",
      "splitLineB",
      "splitPreview",
      "splitError",
      "bucketFillBarriers",
      "bucketFillBarrierMode",
    ]));
    expect(afterTrue.activeTool).toEqual({ kind: "split" });
    expect(afterTrue.tempPanMode).toBe(true);
    expect(afterTrue.bucketFillPendingPolygon).toBe(pending);
    expect(afterTrue.takeoffUndoStack).toBe(undo);

    restoreToolOwner();
    useToolStore.setState({
      activeTool: { kind: "split" },
      splitLineA: { x: 0.1, y: 0.2 },
      splitLineB: { x: 0.7, y: 0.8 },
      splitPreview: SPLIT_PREVIEW,
      splitError: "split",
      mode: "markup",
    });
    const beforeFalse = useToolStore.getState();
    beforeFalse.setSplitAreaActive(false);
    const afterFalse = useToolStore.getState();
    expect(changedToolKeys(beforeFalse, afterFalse)).toEqual(sorted([
      "activeTool",
      "splitLineA",
      "splitLineB",
      "splitPreview",
      "splitError",
    ]));
    expect(afterFalse).toMatchObject({
      mode: "markup",
      activeTool: null,
    });

    const unrelated = { kind: "tagAdd", tagId: "fixture" } as const;
    useToolStore.setState({ activeTool: unrelated });
    useToolStore.getState().setSplitAreaActive(false);
    expect(useToolStore.getState().activeTool).toBe(unrelated);
  });

  it("setSymbolSearchActive(true) writes pointer plus one owner; false preserves the session", () => {
    const barriers = [BARRIER];
    const pending = PENDING_POLYGON;
    const results = SYMBOL_RESULTS;
    useToolStore.setState({
      mode: "markup",
      tempPanMode: true,
      activeTool: { kind: "bucketFill" },
      activeTakeoffItemId: 91,
      bucketFillPreview: BUCKET_PREVIEW,
      bucketFillLoading: true,
      bucketFillError: "bucket",
      bucketFillPendingPolygon: pending,
      bucketFillBarriers: barriers,
      bucketFillBarrierMode: true,
      splitLineA: { x: 0.1, y: 0.2 },
      splitLineB: { x: 0.7, y: 0.8 },
      splitPreview: SPLIT_PREVIEW,
      splitError: "split",
      symbolSearchLoading: true,
      symbolSearchResults: results,
      symbolSearchError: "symbol",
    });
    const beforeTrue = useToolStore.getState();
    beforeTrue.setSymbolSearchActive(true);
    const afterTrue = useToolStore.getState();

    expect(changedToolKeys(beforeTrue, afterTrue)).toEqual(sorted([
      "mode",
      "tempPanMode",
      "activeTool",
      "bucketFillPreview",
      "bucketFillLoading",
      "bucketFillBarrierMode",
      "splitLineA",
      "splitLineB",
      "splitPreview",
      "splitError",
    ]));
    expect(afterTrue).toMatchObject({
      mode: "pointer",
      activeTool: { kind: "symbolTemplate" },
      tempPanMode: false,
      activeTakeoffItemId: 91,
      bucketFillError: "bucket",
      symbolSearchLoading: true,
      symbolSearchError: "symbol",
    });
    expect(afterTrue.bucketFillBarriers).toBe(barriers);
    expect(afterTrue.bucketFillPendingPolygon).toBe(pending);
    expect(afterTrue.symbolSearchResults).toBe(results);

    const beforeFalse = afterTrue;
    beforeFalse.setSymbolSearchActive(false);
    const afterFalse = useToolStore.getState();
    expect(changedToolKeys(beforeFalse, afterFalse)).toEqual(["activeTool"]);
    expect(afterFalse.activeTool).toEqual({ kind: "takeoffPlacement" });
    expect(afterFalse.symbolSearchResults).toBe(results);
    expect(afterFalse.symbolSearchLoading).toBe(true);
    expect(afterFalse.symbolSearchError).toBe("symbol");
  });

  it("pins the remaining multi-field leaf actions", () => {
    useToolStore.setState({
      activeTakeoffItemId: 91,
      takeoffUndoStack: [ANNOTATION],
      takeoffRedoStack: [SECOND_ANNOTATION],
    });
    let before = useToolStore.getState();
    before.setActiveTakeoffItemId(92);
    let after = useToolStore.getState();
    expect(changedToolKeys(before, after)).toEqual(sorted([
      "activeTool",
      "activeTakeoffItemId",
      "takeoffUndoStack",
      "takeoffRedoStack",
    ]));
    expect(after.takeoffUndoStack).toEqual([]);
    expect(after.takeoffRedoStack).toEqual([]);

    restoreToolOwner();
    useToolStore.setState({
      activeTool: { kind: "calibration" },
      activeTakeoffItemId: 91,
      calibrationMode: "input",
      calibrationPoints: { p1: { x: 0.1, y: 0.2 } },
    });
    before = useToolStore.getState();
    before.resetCalibration();
    after = useToolStore.getState();
    expect(changedToolKeys(before, after)).toEqual(sorted([
      "activeTool", "calibrationMode", "calibrationPoints",
    ]));
    expect(after.activeTool).toEqual({ kind: "takeoffPlacement" });

    restoreToolOwner();
    useToolStore.setState({ polygonDrawingMode: "drawing", polygonVertices: [{ x: 0.1, y: 0.2 }] });
    before = useToolStore.getState();
    before.resetPolygonDrawing();
    after = useToolStore.getState();
    expect(changedToolKeys(before, after)).toEqual(sorted(["polygonDrawingMode", "polygonVertices"]));

    restoreToolOwner();
    useToolStore.setState({ bucketFillBarrierMode: true, barrierPendingPoint: { x: 0.1, y: 0.2 } });
    before = useToolStore.getState();
    before.setBucketFillBarrierMode(false);
    after = useToolStore.getState();
    expect(changedToolKeys(before, after)).toEqual(sorted(["bucketFillBarrierMode", "barrierPendingPoint"]));
  });

  it("renews same-kind identities and makes tag entry a destructive pointer publication", () => {
    useToolStore.getState().setActiveTakeoffItemId(91);
    const takeoffA = useToolStore.getState().activeTool;
    useToolStore.getState().setActiveTakeoffItemId(91);
    expect(useToolStore.getState().activeTool).not.toBe(takeoffA);

    useToolStore.getState().setCalibrationMode("input");
    const calibrationA = useToolStore.getState().activeTool;
    useToolStore.getState().setCalibrationMode("input");
    expect(useToolStore.getState().activeTool).not.toBe(calibrationA);

    useToolStore.setState({
      mode: "markup",
      tempPanMode: true,
      activeTakeoffItemId: 91,
      polygonDrawingMode: "drawing",
      polygonVertices: [{ x: 0.1, y: 0.2 }],
      bucketFillPreview: BUCKET_PREVIEW,
      bucketFillLoading: true,
    });
    useToolStore.getState().setTagAddingMode("tag-91");
    expect(useToolStore.getState()).toMatchObject({
      mode: "pointer",
      activeTool: { kind: "tagAdd", tagId: "tag-91" },
      tempPanMode: false,
      activeTakeoffItemId: null,
      polygonDrawingMode: "idle",
      polygonVertices: [],
      bucketFillPreview: null,
      bucketFillLoading: false,
    });
  });
});

describe("flat toolStore AT2 — container and argument identity", () => {
  it("copies calibration maps but retains untouched entries and caller values", () => {
    const firstPoint = { x: 0.1, y: 0.2 };
    const secondPoint = { x: 0.7, y: 0.8 };
    useToolStore.setState({
      scaleCalibrations: { 1: CALIBRATION },
      calibrationPoints: { p1: firstPoint },
    });

    const calibrationsBefore = useToolStore.getState().scaleCalibrations;
    useToolStore.getState().setScaleCalibration(2, SECOND_CALIBRATION);
    const calibrationsAfter = useToolStore.getState().scaleCalibrations;
    expect(calibrationsAfter).not.toBe(calibrationsBefore);
    expect(calibrationsAfter[1]).toBe(CALIBRATION);
    expect(calibrationsAfter[2]).toBe(SECOND_CALIBRATION);

    const pointsBefore = useToolStore.getState().calibrationPoints;
    useToolStore.getState().setCalibrationPoint("p2", secondPoint);
    const pointsAfter = useToolStore.getState().calibrationPoints;
    expect(pointsAfter).not.toBe(pointsBefore);
    expect(pointsAfter.p1).toBe(firstPoint);
    expect(pointsAfter.p2).toBe(secondPoint);
  });

  it("allocates on append/undo/clear, including undo against an already-empty array", () => {
    const firstVertex = { x: 0.1, y: 0.2 };
    const secondVertex = { x: 0.7, y: 0.8 };
    useToolStore.setState({ polygonVertices: [firstVertex] });
    const verticesBefore = useToolStore.getState().polygonVertices;
    useToolStore.getState().addPolygonVertex(secondVertex);
    const verticesAfterAdd = useToolStore.getState().polygonVertices;
    expect(verticesAfterAdd).not.toBe(verticesBefore);
    expect(verticesAfterAdd[0]).toBe(firstVertex);
    expect(verticesAfterAdd[1]).toBe(secondVertex);
    useToolStore.getState().undoLastVertex();
    expect(useToolStore.getState().polygonVertices).not.toBe(verticesAfterAdd);
    expect(useToolStore.getState().polygonVertices[0]).toBe(firstVertex);

    const emptyVertices: ToolState["polygonVertices"] = [];
    useToolStore.setState({ polygonVertices: emptyVertices });
    useToolStore.getState().undoLastVertex();
    expect(useToolStore.getState().polygonVertices).toEqual([]);
    expect(useToolStore.getState().polygonVertices).not.toBe(emptyVertices);

    const firstBarriers = [BARRIER];
    const secondBarrier = { x1: 0.2, y1: 0.3, x2: 0.8, y2: 0.9 };
    useToolStore.setState({ bucketFillBarriers: firstBarriers });
    useToolStore.getState().addBucketFillBarrier(secondBarrier);
    const barriersAfterAdd = useToolStore.getState().bucketFillBarriers;
    expect(barriersAfterAdd).not.toBe(firstBarriers);
    expect(barriersAfterAdd[0]).toBe(BARRIER);
    expect(barriersAfterAdd[1]).toBe(secondBarrier);
    useToolStore.getState().undoLastBarrier();
    const barriersAfterUndo = useToolStore.getState().bucketFillBarriers;
    expect(barriersAfterUndo).not.toBe(barriersAfterAdd);
    expect(barriersAfterUndo[0]).toBe(BARRIER);
    useToolStore.getState().clearBucketFillBarriers();
    expect(useToolStore.getState().bucketFillBarriers).not.toBe(barriersAfterUndo);
    expect(useToolStore.getState().bucketFillBarriers).toEqual([]);
  });

  it("keeps simple object setters pass-through while split endpoint changes only its selected side", () => {
    const lineA = { x: 0.1, y: 0.2 };
    const lineB = { x: 0.7, y: 0.8 };
    useToolStore.setState({ splitLineA: lineA, splitLineB: lineB });
    const replacement = { x: 0.3, y: 0.4 };
    useToolStore.getState().setSplitLineEndpoint("a", replacement);
    expect(useToolStore.getState().splitLineA).toBe(replacement);
    expect(useToolStore.getState().splitLineB).toBe(lineB);

    useToolStore.getState().setBucketFillPreview(BUCKET_PREVIEW);
    expect(useToolStore.getState().bucketFillPreview).toBe(BUCKET_PREVIEW);
    useToolStore.getState().setBucketFillPendingPolygon(PENDING_POLYGON);
    expect(useToolStore.getState().bucketFillPendingPolygon).toBe(PENDING_POLYGON);
    useToolStore.getState().setSplitPreview(SPLIT_PREVIEW);
    expect(useToolStore.getState().splitPreview).toBe(SPLIT_PREVIEW);
    useToolStore.getState().setTagScanResults(TAG_SCAN_RESULTS);
    expect(useToolStore.getState().tagScanResults).toBe(TAG_SCAN_RESULTS);
    useToolStore.getState().setSymbolSearchResults(SYMBOL_RESULTS);
    expect(useToolStore.getState().symbolSearchResults).toBe(SYMBOL_RESULTS);
  });

  it("always clones dismissed matches and symbol config, even for semantic no-ops", () => {
    const dismissed = new Set(["same"]);
    const searchPages = [2, 4];
    useToolStore.setState({
      dismissedSymbolMatches: dismissed,
      symbolSearchConfig: {
        ...defaultSymbolConfig(),
        multiScale: false,
        searchPages,
        maxMatchesPerPage: 17,
      },
      symbolSearchPreset: "lite",
    });

    useToolStore.getState().dismissSymbolMatch("same");
    const dismissedAfter = useToolStore.getState().dismissedSymbolMatches;
    expect(dismissedAfter).not.toBe(dismissed);
    expect(dismissedAfter).toEqual(dismissed);

    const configBeforePatch = useToolStore.getState().symbolSearchConfig;
    useToolStore.getState().setSymbolSearchConfig({});
    const configAfterPatch = useToolStore.getState().symbolSearchConfig;
    expect(configAfterPatch).not.toBe(configBeforePatch);
    expect(configAfterPatch).toEqual(configBeforePatch);
    expect(configAfterPatch.searchPages).toBe(searchPages);

    useToolStore.getState().setSymbolSearchPreset("lite");
    const afterPreset = useToolStore.getState();
    expect(afterPreset.symbolSearchConfig).not.toBe(configAfterPatch);
    expect(afterPreset.symbolSearchConfig).toEqual({
      ...configAfterPatch,
      scaleMin: 0.8,
      scaleMax: 1.5,
      nmsThreshold: 0.3,
    });
    expect(afterPreset.symbolSearchConfig.searchPages).toBe(searchPages);
    expect(afterPreset.symbolSearchConfig.multiScale).toBe(false);
    expect(afterPreset.symbolSearchConfig.maxMatchesPerPage).toBe(17);
  });

  it("clearSymbolSearch replaces ten fields but deliberately retains the preset", () => {
    const dismissed = new Set(["one"]);
    const config = { ...defaultSymbolConfig(), scaleMin: 0.5, maxMatchesPerPage: 17 };
    useToolStore.setState({
      activeTool: { kind: "symbolTemplate" },
      symbolSearchLoading: true,
      symbolSearchProgress: { page: 3, pageIndex: 1, totalPages: 4, matches: 2 },
      symbolSearchResults: SYMBOL_RESULTS,
      symbolSearchConfidence: 0.42,
      dismissedSymbolMatches: dismissed,
      symbolSearchError: "failed",
      symbolSearchTemplateBbox: [0.1, 0.2, 0.3, 0.4],
      symbolSearchSourcePage: 3,
      symbolSearchConfig: config,
      symbolSearchPreset: "power",
    });
    const before = useToolStore.getState();
    before.clearSymbolSearch();
    const after = useToolStore.getState();

    expect(changedToolKeys(before, after)).toEqual(sorted([
      "activeTool",
      "symbolSearchLoading",
      "symbolSearchProgress",
      "symbolSearchResults",
      "symbolSearchConfidence",
      "dismissedSymbolMatches",
      "symbolSearchError",
      "symbolSearchTemplateBbox",
      "symbolSearchSourcePage",
      "symbolSearchConfig",
    ]));
    expect(after).toMatchObject({
      activeTool: null,
      symbolSearchLoading: false,
      symbolSearchProgress: null,
      symbolSearchResults: null,
      symbolSearchConfidence: 0.75,
      symbolSearchError: null,
      symbolSearchTemplateBbox: null,
      symbolSearchSourcePage: null,
      symbolSearchPreset: "power",
    });
    expect(after.dismissedSymbolMatches).toEqual(new Set<string>());
    expect(after.dismissedSymbolMatches).not.toBe(dismissed);
    expect(after.symbolSearchConfig).toEqual(defaultSymbolConfig());
    expect(after.symbolSearchConfig).not.toBe(config);
  });
});

describe("flat toolStore drawing-last — project reset policy", () => {
  it("clears all 40 fields, allocates fresh mutable defaults, and keeps actions", () => {
    const scaleCalibrations = { 3: CALIBRATION };
    const calibrationPoints = { p1: { x: 0.1, y: 0.2 }, p2: { x: 0.7, y: 0.8 } };
    const polygonVertices = [{ x: 0.1, y: 0.2 }];
    const bucketPreview = BUCKET_PREVIEW;
    const pendingPolygon = PENDING_POLYGON;
    const splitLineA = { x: 0.1, y: 0.2 };
    const splitLineB = { x: 0.7, y: 0.8 };
    const splitPreview = SPLIT_PREVIEW;
    const barriers = [BARRIER];
    const barrierPendingPoint = { x: 0.4, y: 0.5 };
    const undo = [ANNOTATION];
    const redo = [SECOND_ANNOTATION];
    const dismissed = new Set(["one"]);
    const searchPages = [2, 4];
    const symbolConfig: ToolState["symbolSearchConfig"] = {
      multiScale: false,
      useSiftFallback: false,
      searchPages,
      scaleMin: 0.5,
      scaleMax: 2,
      nmsThreshold: 0.2,
      maxMatchesPerPage: 17,
    };
    const drawStart = { x: 11, y: 12 };
    const drawEnd = { x: 13, y: 14 };
    const mousePos = { x: 15, y: 16 };

    useToolStore.setState({
      mode: "markup",
      tempPanMode: true,
      activeTool: { kind: "tagAdd", tagId: "tag-91" },
      _drawing: true,
      _drawStart: drawStart,
      _drawEnd: drawEnd,
      _mousePos: mousePos,
      activeTakeoffItemId: 91,
      scaleCalibrations,
      calibrationMode: "input",
      calibrationPoints,
      polygonDrawingMode: "drawing",
      polygonVertices,
      bucketFillPreview: bucketPreview,
      bucketFillLoading: true,
      bucketFillError: "bucket",
      bucketFillTolerance: 44,
      bucketFillDilatePx: 7,
      bucketFillResolution: 4000,
      bucketFillPendingPolygon: pendingPolygon,
      splitLineA,
      splitLineB,
      splitPreview,
      splitError: "split",
      bucketFillBarriers: barriers,
      bucketFillBarrierMode: true,
      barrierPendingPoint,
      takeoffUndoStack: undo,
      takeoffRedoStack: redo,
      tagScanResults: TAG_SCAN_RESULTS,
      symbolSearchLoading: true,
      symbolSearchProgress: { page: 3, pageIndex: 1, totalPages: 4, matches: 2 },
      symbolSearchResults: SYMBOL_RESULTS,
      symbolSearchConfidence: 0.42,
      dismissedSymbolMatches: dismissed,
      symbolSearchError: "symbol",
      symbolSearchTemplateBbox: [0.1, 0.2, 0.3, 0.4],
      symbolSearchSourcePage: 3,
      symbolSearchConfig: symbolConfig,
      symbolSearchPreset: "power",
    });
    const before = useToolStore.getState();
    const actionsBefore = pickToolActions(before);

    before.resetProjectToolState();

    const after = useToolStore.getState();
    expect(changedToolKeys(before, after)).toEqual(sorted(TOOL_PROJECT_RESET_KEYS));
    expect(pickToolData(after)).toEqual(pickToolData(useToolStore.getInitialState()));
    for (const key of TOOL_ACTION_KEYS) {
      expect(after[key], `reset must retain action ${key}`).toBe(actionsBefore[key]);
    }

    expect(after).toMatchObject({
      tempPanMode: false,
      activeTool: null,
      activeTakeoffItemId: null,
      scaleCalibrations: {},
      calibrationMode: "idle",
      calibrationPoints: {},
      polygonDrawingMode: "idle",
      polygonVertices: [],
      bucketFillResolution: 1000,
      tagScanResults: null,
      symbolSearchLoading: false,
      symbolSearchProgress: null,
      symbolSearchResults: null,
      symbolSearchConfidence: 0.75,
      symbolSearchError: null,
      symbolSearchTemplateBbox: null,
      symbolSearchSourcePage: null,
      symbolSearchPreset: "lite",
    });
    expect(after.dismissedSymbolMatches).toEqual(new Set<string>());
    expect(after.symbolSearchConfig).toEqual(defaultSymbolConfig());

    expect(after.scaleCalibrations).not.toBe(scaleCalibrations);
    expect(after.calibrationPoints).not.toBe(calibrationPoints);
    expect(after.polygonVertices).not.toBe(polygonVertices);
    expect(after._drawStart).not.toBe(drawStart);
    expect(after._drawEnd).not.toBe(drawEnd);
    expect(after.bucketFillBarriers).not.toBe(barriers);
    expect(after.takeoffUndoStack).not.toBe(undo);
    expect(after.takeoffRedoStack).not.toBe(redo);
    expect(after.dismissedSymbolMatches).not.toBe(dismissed);
    expect(after.symbolSearchConfig).not.toBe(symbolConfig);
  });

  it("clears every active owner, including temporary bucket and split owners", () => {
    const bucket = { kind: "bucketFill" } as const;
    useToolStore.setState({ activeTool: bucket });
    useToolStore.getState().resetProjectToolState();
    expect(useToolStore.getState().activeTool).toBeNull();

    const split = { kind: "split" } as const;
    useToolStore.setState({ activeTool: split });
    useToolStore.getState().resetProjectToolState();
    expect(useToolStore.getState().activeTool).toBeNull();

    useToolStore.setState({ activeTool: { kind: "calibration" } });
    useToolStore.getState().resetProjectToolState();
    expect(useToolStore.getState().activeTool).toBeNull();
  });
});
