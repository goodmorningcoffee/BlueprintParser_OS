// @vitest-environment node
// [refactor jul11 P2.3 T2] The characterized flat tool candidate now lives in its dedicated owner.
// Keeping this suite owner-local proves the atomic move retained the frozen behavior contract.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetProjectData } from "@/stores/viewerCommands";
import { useToolStore } from "@/stores/toolStore";
import type { ClientAnnotation, ScaleCalibrationData } from "@/types";

type ToolState = ReturnType<typeof useToolStore.getState>;

/** Exact mechanically-flat data boundary. Parse/server/UI/core/drawing state is excluded. */
export const TOOL_DATA_KEYS = [
  "mode",
  "tempPanMode",
  "activeTakeoffItemId",
  "scaleCalibrations",
  "calibrationMode",
  "calibrationPoints",
  "polygonDrawingMode",
  "polygonVertices",
  "bucketFillActive",
  "bucketFillPreview",
  "bucketFillLoading",
  "bucketFillError",
  "bucketFillTolerance",
  "bucketFillDilatePx",
  "bucketFillResolution",
  "bucketFillPendingPolygon",
  "splitAreaActive",
  "splitLineA",
  "splitLineB",
  "splitPreview",
  "splitError",
  "bucketFillBarriers",
  "bucketFillBarrierMode",
  "barrierPendingPoint",
  "takeoffUndoStack",
  "takeoffRedoStack",
  "yoloTagPickingMode",
  "tagScanResults",
  "tagAddingMode",
  "symbolSearchActive",
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

/** Existing leaf actions that move byte-for-behavior. New resetProjectToolState is not legacy. */
export const TOOL_ACTION_KEYS = [
  "setMode",
  "setTempPanMode",
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

/** Exact project-reset subset; survival-policy changes belong to P2.5, not this carve. */
export const TOOL_PROJECT_RESET_TOUCHED_KEYS = [
  "tempPanMode",
  "activeTakeoffItemId",
  "scaleCalibrations",
  "calibrationMode",
  "calibrationPoints",
  "polygonDrawingMode",
  "polygonVertices",
  "bucketFillResolution",
  "yoloTagPickingMode",
  "tagScanResults",
  "tagAddingMode",
  "symbolSearchActive",
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
] as const satisfies readonly (typeof TOOL_DATA_KEYS)[number][];

/** Exact project-reset omissions, including live tools/history that currently leak by policy. */
export const TOOL_PROJECT_RESET_RETAINED_KEYS = [
  "mode",
  "bucketFillActive",
  "bucketFillPreview",
  "bucketFillLoading",
  "bucketFillError",
  "bucketFillTolerance",
  "bucketFillDilatePx",
  "bucketFillPendingPolygon",
  "splitAreaActive",
  "splitLineA",
  "splitLineB",
  "splitPreview",
  "splitError",
  "bucketFillBarriers",
  "bucketFillBarrierMode",
  "barrierPendingPoint",
  "takeoffUndoStack",
  "takeoffRedoStack",
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
  restoreToolOwner();
});

describe("flat toolStore V0 — exact boundary and defaults", () => {
  it("exports a unique 40-data / 43-action / 22-touched / 18-retained ledger", () => {
    expect(TOOL_DATA_KEYS).toHaveLength(40);
    expect(new Set(TOOL_DATA_KEYS).size).toBe(40);
    expect(TOOL_ACTION_KEYS).toHaveLength(43);
    expect(new Set(TOOL_ACTION_KEYS).size).toBe(43);
    expect(TOOL_PROJECT_RESET_TOUCHED_KEYS).toHaveLength(22);
    expect(new Set(TOOL_PROJECT_RESET_TOUCHED_KEYS).size).toBe(22);
    expect(TOOL_PROJECT_RESET_RETAINED_KEYS).toHaveLength(18);
    expect(new Set(TOOL_PROJECT_RESET_RETAINED_KEYS).size).toBe(18);
    expect(sorted([
      ...TOOL_PROJECT_RESET_TOUCHED_KEYS,
      ...TOOL_PROJECT_RESET_RETAINED_KEYS,
    ])).toEqual(sorted(TOOL_DATA_KEYS));

    const state = useToolStore.getState();
    for (const action of TOOL_ACTION_KEYS) expect(state[action]).toBeTypeOf("function");
  });

  it("freezes all 40 construction defaults", () => {
    expect(pickToolData(useToolStore.getInitialState())).toEqual({
      mode: "move",
      tempPanMode: false,
      activeTakeoffItemId: null,
      scaleCalibrations: {},
      calibrationMode: "idle",
      calibrationPoints: {},
      polygonDrawingMode: "idle",
      polygonVertices: [],
      bucketFillActive: false,
      bucketFillPreview: null,
      bucketFillLoading: false,
      bucketFillError: null,
      bucketFillTolerance: 30,
      bucketFillDilatePx: 3,
      bucketFillResolution: 1000,
      bucketFillPendingPolygon: null,
      splitAreaActive: false,
      splitLineA: null,
      splitLineB: null,
      splitPreview: null,
      splitError: null,
      bucketFillBarriers: [],
      bucketFillBarrierMode: false,
      barrierPendingPoint: null,
      takeoffUndoStack: [],
      takeoffRedoStack: [],
      yoloTagPickingMode: false,
      tagScanResults: null,
      tagAddingMode: null,
      symbolSearchActive: false,
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
  });
});

interface PublicationCase {
  name: ToolActionKey;
  invoke: () => void;
}

const PUBLICATION_CASES: readonly PublicationCase[] = [
  { name: "setMode", invoke: () => useToolStore.getState().setMode("move") },
  { name: "setTempPanMode", invoke: () => useToolStore.getState().setTempPanMode(false) },
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

describe("flat toolStore V0 — legacy action publications", () => {
  it("covers every legacy action once and in ledger order", () => {
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

describe("flat toolStore V0 — compound destinations and exclusions", () => {
  it("setMode writes exactly its 16-field tear-down and allocates both empty arrays", () => {
    const polygonVertices = [{ x: 0.2, y: 0.3 }];
    const barriers = [BARRIER];
    const pending = PENDING_POLYGON;
    const undo = [ANNOTATION];
    const redo = [SECOND_ANNOTATION];
    useToolStore.setState({
      mode: "markup",
      tempPanMode: true,
      activeTakeoffItemId: 91,
      calibrationMode: "input",
      polygonDrawingMode: "drawing",
      polygonVertices,
      bucketFillActive: true,
      bucketFillPreview: BUCKET_PREVIEW,
      bucketFillLoading: true,
      bucketFillError: "retain",
      bucketFillPendingPolygon: pending,
      bucketFillBarriers: barriers,
      bucketFillBarrierMode: true,
      barrierPendingPoint: { x: 0.4, y: 0.5 },
      splitAreaActive: true,
      splitLineA: { x: 0.1, y: 0.2 },
      splitLineB: { x: 0.7, y: 0.8 },
      splitPreview: SPLIT_PREVIEW,
      splitError: "split",
      symbolSearchActive: true,
      takeoffUndoStack: undo,
      takeoffRedoStack: redo,
    });
    const before = useToolStore.getState();

    before.setMode("pointer");
    const after = useToolStore.getState();

    expect(changedToolKeys(before, after)).toEqual(sorted([
      "mode",
      "tempPanMode",
      "activeTakeoffItemId",
      "polygonDrawingMode",
      "polygonVertices",
      "bucketFillActive",
      "bucketFillPreview",
      "bucketFillLoading",
      "bucketFillBarriers",
      "bucketFillBarrierMode",
      "splitAreaActive",
      "splitLineA",
      "splitLineB",
      "splitPreview",
      "splitError",
      "symbolSearchActive",
    ]));
    expect(after).toMatchObject({
      mode: "pointer",
      tempPanMode: false,
      activeTakeoffItemId: null,
      polygonDrawingMode: "idle",
      bucketFillActive: false,
      bucketFillPreview: null,
      bucketFillLoading: false,
      bucketFillBarrierMode: false,
      splitAreaActive: false,
      splitLineA: null,
      splitLineB: null,
      splitPreview: null,
      splitError: null,
      symbolSearchActive: false,
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
    const undo = [ANNOTATION];
    useToolStore.setState({
      mode: "markup",
      tempPanMode: true,
      activeTakeoffItemId: 91,
      bucketFillActive: false,
      bucketFillPreview: BUCKET_PREVIEW,
      bucketFillLoading: true,
      bucketFillError: "bucket",
      bucketFillPendingPolygon: PENDING_POLYGON,
      bucketFillBarriers: barriers,
      bucketFillBarrierMode: true,
      splitAreaActive: true,
      splitLineA: { x: 0.1, y: 0.2 },
      splitLineB: { x: 0.7, y: 0.8 },
      splitPreview: SPLIT_PREVIEW,
      splitError: "split",
      symbolSearchActive: true,
      takeoffUndoStack: undo,
    });
    const beforeTrue = useToolStore.getState();
    beforeTrue.setBucketFillActive(true);
    const afterTrue = useToolStore.getState();

    expect(changedToolKeys(beforeTrue, afterTrue)).toEqual(sorted([
      "mode",
      "tempPanMode",
      "bucketFillActive",
      "bucketFillPreview",
      "bucketFillLoading",
      "bucketFillError",
      "bucketFillBarrierMode",
      "bucketFillPendingPolygon",
      "splitAreaActive",
      "splitLineA",
      "splitLineB",
      "splitPreview",
      "splitError",
      "symbolSearchActive",
    ]));
    expect(afterTrue.bucketFillBarriers).toBe(barriers);
    expect(afterTrue.activeTakeoffItemId).toBe(91);
    expect(afterTrue.takeoffUndoStack).toBe(undo);

    restoreToolOwner();
    useToolStore.setState({
      mode: "markup",
      bucketFillActive: true,
      bucketFillPreview: BUCKET_PREVIEW,
      bucketFillLoading: true,
      bucketFillError: "bucket",
      bucketFillPendingPolygon: PENDING_POLYGON,
      bucketFillBarriers: barriers,
      bucketFillBarrierMode: true,
      splitAreaActive: true,
      symbolSearchActive: true,
    });
    const beforeFalse = useToolStore.getState();
    beforeFalse.setBucketFillActive(false);
    const afterFalse = useToolStore.getState();

    expect(changedToolKeys(beforeFalse, afterFalse)).toEqual(sorted([
      "bucketFillActive",
      "bucketFillPreview",
      "bucketFillLoading",
      "bucketFillError",
      "bucketFillPendingPolygon",
      "bucketFillBarriers",
      "bucketFillBarrierMode",
    ]));
    expect(afterFalse.mode).toBe("markup");
    expect(afterFalse.splitAreaActive).toBe(true);
    expect(afterFalse.symbolSearchActive).toBe(true);
    expect(afterFalse.bucketFillBarriers).toEqual([]);
    expect(afterFalse.bucketFillBarriers).not.toBe(barriers);
  });

  it("setSplitAreaActive preserves its asymmetric true/false write sets", () => {
    const pending = PENDING_POLYGON;
    const undo = [ANNOTATION];
    useToolStore.setState({
      mode: "markup",
      tempPanMode: true,
      activeTakeoffItemId: 91,
      bucketFillActive: true,
      bucketFillPreview: BUCKET_PREVIEW,
      bucketFillLoading: true,
      bucketFillError: "bucket",
      bucketFillPendingPolygon: pending,
      bucketFillBarriers: [BARRIER],
      bucketFillBarrierMode: true,
      splitAreaActive: false,
      splitLineA: { x: 0.1, y: 0.2 },
      splitLineB: { x: 0.7, y: 0.8 },
      splitPreview: SPLIT_PREVIEW,
      splitError: "split",
      symbolSearchActive: true,
      takeoffUndoStack: undo,
    });
    const beforeTrue = useToolStore.getState();
    beforeTrue.setSplitAreaActive(true);
    const afterTrue = useToolStore.getState();

    expect(changedToolKeys(beforeTrue, afterTrue)).toEqual(sorted([
      "mode",
      "activeTakeoffItemId",
      "bucketFillActive",
      "bucketFillPreview",
      "bucketFillLoading",
      "bucketFillError",
      "splitAreaActive",
      "splitLineA",
      "splitLineB",
      "splitPreview",
      "splitError",
      "bucketFillBarriers",
      "bucketFillBarrierMode",
      "symbolSearchActive",
    ]));
    expect(afterTrue.tempPanMode).toBe(true);
    expect(afterTrue.bucketFillPendingPolygon).toBe(pending);
    expect(afterTrue.takeoffUndoStack).toBe(undo);

    restoreToolOwner();
    useToolStore.setState({
      splitAreaActive: true,
      splitLineA: { x: 0.1, y: 0.2 },
      splitLineB: { x: 0.7, y: 0.8 },
      splitPreview: SPLIT_PREVIEW,
      splitError: "split",
      mode: "markup",
      bucketFillActive: true,
      symbolSearchActive: true,
    });
    const beforeFalse = useToolStore.getState();
    beforeFalse.setSplitAreaActive(false);
    const afterFalse = useToolStore.getState();
    expect(changedToolKeys(beforeFalse, afterFalse)).toEqual(sorted([
      "splitAreaActive",
      "splitLineA",
      "splitLineB",
      "splitPreview",
      "splitError",
    ]));
    expect(afterFalse).toMatchObject({
      mode: "markup",
      bucketFillActive: true,
      symbolSearchActive: true,
    });
  });

  it("setSymbolSearchActive(true) clears exactly ten competing fields; false preserves the session", () => {
    const barriers = [BARRIER];
    const pending = PENDING_POLYGON;
    const results = SYMBOL_RESULTS;
    useToolStore.setState({
      mode: "markup",
      tempPanMode: true,
      activeTakeoffItemId: 91,
      bucketFillActive: true,
      bucketFillPreview: BUCKET_PREVIEW,
      bucketFillLoading: true,
      bucketFillError: "bucket",
      bucketFillPendingPolygon: pending,
      bucketFillBarriers: barriers,
      bucketFillBarrierMode: true,
      splitAreaActive: true,
      splitLineA: { x: 0.1, y: 0.2 },
      splitLineB: { x: 0.7, y: 0.8 },
      splitPreview: SPLIT_PREVIEW,
      splitError: "split",
      symbolSearchActive: false,
      symbolSearchLoading: true,
      symbolSearchResults: results,
      symbolSearchError: "symbol",
    });
    const beforeTrue = useToolStore.getState();
    beforeTrue.setSymbolSearchActive(true);
    const afterTrue = useToolStore.getState();

    expect(changedToolKeys(beforeTrue, afterTrue)).toEqual(sorted([
      "mode",
      "bucketFillActive",
      "bucketFillPreview",
      "bucketFillLoading",
      "bucketFillBarrierMode",
      "splitAreaActive",
      "splitLineA",
      "splitLineB",
      "splitPreview",
      "splitError",
      "symbolSearchActive",
    ]));
    expect(afterTrue).toMatchObject({
      tempPanMode: true,
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
    expect(changedToolKeys(beforeFalse, afterFalse)).toEqual(["symbolSearchActive"]);
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
      "activeTakeoffItemId",
      "takeoffUndoStack",
      "takeoffRedoStack",
    ]));
    expect(after.takeoffUndoStack).toEqual([]);
    expect(after.takeoffRedoStack).toEqual([]);

    restoreToolOwner();
    useToolStore.setState({ calibrationMode: "input", calibrationPoints: { p1: { x: 0.1, y: 0.2 } } });
    before = useToolStore.getState();
    before.resetCalibration();
    after = useToolStore.getState();
    expect(changedToolKeys(before, after)).toEqual(sorted(["calibrationMode", "calibrationPoints"]));

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
});

describe("flat toolStore V0 — container and argument identity", () => {
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
      symbolSearchActive: true,
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
      "symbolSearchActive",
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
      symbolSearchActive: false,
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

describe("flat toolStore V0 — project reset policy", () => {
  it("touches exactly 22 fields, retains exactly 18, allocates five containers, and keeps actions", () => {
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

    useToolStore.setState({
      mode: "markup",
      tempPanMode: true,
      activeTakeoffItemId: 91,
      scaleCalibrations,
      calibrationMode: "input",
      calibrationPoints,
      polygonDrawingMode: "drawing",
      polygonVertices,
      bucketFillActive: true,
      bucketFillPreview: bucketPreview,
      bucketFillLoading: true,
      bucketFillError: "bucket",
      bucketFillTolerance: 44,
      bucketFillDilatePx: 7,
      bucketFillResolution: 4000,
      bucketFillPendingPolygon: pendingPolygon,
      splitAreaActive: true,
      splitLineA,
      splitLineB,
      splitPreview,
      splitError: "split",
      bucketFillBarriers: barriers,
      bucketFillBarrierMode: true,
      barrierPendingPoint,
      takeoffUndoStack: undo,
      takeoffRedoStack: redo,
      yoloTagPickingMode: true,
      tagScanResults: TAG_SCAN_RESULTS,
      tagAddingMode: "tag-91",
      symbolSearchActive: true,
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

    resetProjectData();

    const after = useToolStore.getState();
    expect(changedToolKeys(before, after)).toEqual(sorted(TOOL_PROJECT_RESET_TOUCHED_KEYS));
    for (const key of TOOL_PROJECT_RESET_RETAINED_KEYS) {
      expect(after[key], `reset must retain ${key}`).toBe(before[key]);
    }
    for (const key of TOOL_ACTION_KEYS) {
      expect(after[key], `reset must retain action ${key}`).toBe(actionsBefore[key]);
    }

    expect(after).toMatchObject({
      tempPanMode: false,
      activeTakeoffItemId: null,
      scaleCalibrations: {},
      calibrationMode: "idle",
      calibrationPoints: {},
      polygonDrawingMode: "idle",
      polygonVertices: [],
      bucketFillResolution: 1000,
      yoloTagPickingMode: false,
      tagScanResults: null,
      tagAddingMode: null,
      symbolSearchActive: false,
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
    expect(after.dismissedSymbolMatches).not.toBe(dismissed);
    expect(after.symbolSearchConfig).not.toBe(symbolConfig);

    expect(after.mode).toBe("markup");
    expect(after.bucketFillPreview).toBe(bucketPreview);
    expect(after.bucketFillPendingPolygon).toBe(pendingPolygon);
    expect(after.splitLineA).toBe(splitLineA);
    expect(after.splitLineB).toBe(splitLineB);
    expect(after.splitPreview).toBe(splitPreview);
    expect(after.bucketFillBarriers).toBe(barriers);
    expect(after.barrierPendingPoint).toBe(barrierPendingPoint);
    expect(after.takeoffUndoStack).toBe(undo);
    expect(after.takeoffRedoStack).toBe(redo);
  });
});
