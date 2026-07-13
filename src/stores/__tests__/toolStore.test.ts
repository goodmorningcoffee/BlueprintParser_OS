// @vitest-environment node
// [refactor jul13 P2.3 AT2] Isolated runtime contract for the atomic flat tool owner.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  useToolStore,
  type ToolStoreData,
  type ToolStoreState,
} from "@/stores/toolStore";
import type { ClientAnnotation, ScaleCalibrationData } from "@/types";

const DATA_KEYS = [
  "mode", "tempPanMode", "activeTool", "_drawing", "_drawStart", "_drawEnd", "_mousePos",
  "activeTakeoffItemId", "scaleCalibrations", "calibrationMode",
  "calibrationPoints", "polygonDrawingMode", "polygonVertices",
  "bucketFillPreview", "bucketFillLoading", "bucketFillError", "bucketFillTolerance",
  "bucketFillDilatePx", "bucketFillResolution", "bucketFillPendingPolygon",
  "splitLineA", "splitLineB", "splitPreview", "splitError", "bucketFillBarriers",
  "bucketFillBarrierMode", "barrierPendingPoint", "takeoffUndoStack", "takeoffRedoStack",
  "tagScanResults",
  "symbolSearchLoading", "symbolSearchProgress", "symbolSearchResults",
  "symbolSearchConfidence", "dismissedSymbolMatches", "symbolSearchError",
  "symbolSearchTemplateBbox", "symbolSearchSourcePage", "symbolSearchConfig",
  "symbolSearchPreset",
] as const satisfies readonly (keyof ToolStoreData)[];

const LEGACY_ACTION_KEYS = [
  "setMode", "setTempPanMode", "_setDrawing", "_setDrawStart", "_setDrawEnd", "_setMousePos",
  "setActiveTakeoffItemId", "setScaleCalibration",
  "setCalibrationMode", "setCalibrationPoint", "resetCalibration", "setPolygonDrawingMode",
  "addPolygonVertex", "undoLastVertex", "resetPolygonDrawing", "setBucketFillActive",
  "setBucketFillPreview", "setBucketFillLoading", "setBucketFillError",
  "setBucketFillTolerance", "setBucketFillDilatePx", "setBucketFillResolution",
  "setBucketFillPendingPolygon", "setSplitAreaActive", "setSplitLineEndpoint",
  "setSplitPreview", "setSplitError", "addBucketFillBarrier", "undoLastBarrier",
  "clearBucketFillBarriers", "setBucketFillBarrierMode", "setBarrierPendingPoint",
  "setYoloTagPickingMode", "setTagScanResults", "setTagAddingMode", "setSymbolSearchActive",
  "setSymbolSearchLoading", "setSymbolSearchProgress", "setSymbolSearchResults",
  "setSymbolSearchConfidence", "dismissSymbolMatch", "setSymbolSearchError",
  "setSymbolSearchTemplateBbox", "setSymbolSearchSourcePage", "setSymbolSearchConfig",
  "setSymbolSearchPreset", "clearSymbolSearch",
] as const satisfies readonly (keyof ToolStoreState)[];

const RESET_TOUCHED_KEYS = [
  "tempPanMode", "activeTool", "activeTakeoffItemId", "scaleCalibrations", "calibrationMode",
  "calibrationPoints", "polygonDrawingMode", "polygonVertices", "bucketFillResolution",
  "tagScanResults", "symbolSearchLoading", "symbolSearchProgress", "symbolSearchResults",
  "symbolSearchConfidence", "dismissedSymbolMatches", "symbolSearchError",
  "symbolSearchTemplateBbox", "symbolSearchSourcePage", "symbolSearchConfig",
  "symbolSearchPreset",
] as const satisfies readonly (keyof ToolStoreData)[];

const RESET_RETAINED_KEYS = [
  "mode", "_drawing", "_drawStart", "_drawEnd", "_mousePos",
  "takeoffUndoStack", "takeoffRedoStack",
  "bucketFillPreview", "bucketFillLoading", "bucketFillError", "bucketFillTolerance",
  "bucketFillDilatePx", "bucketFillPendingPolygon", "bucketFillBarriers",
  "bucketFillBarrierMode", "barrierPendingPoint", "splitLineA",
  "splitLineB", "splitPreview", "splitError",
] as const satisfies readonly (keyof ToolStoreData)[];

type DataKey = (typeof DATA_KEYS)[number];
type LegacyActionKey = (typeof LEGACY_ACTION_KEYS)[number];

const CALIBRATION: ScaleCalibrationData = {
  type: "scale-calibration",
  point1: { x: 0.1, y: 0.2 },
  point2: { x: 0.8, y: 0.7 },
  realDistance: 24,
  unit: "ft",
};

const ANNOTATION: ClientAnnotation = {
  id: 91,
  pageNumber: 3,
  name: "fixture",
  bbox: [0.1, 0.2, 0.3, 0.4],
  note: null,
  source: "takeoff",
};

const SECOND_ANNOTATION: ClientAnnotation = { ...ANNOTATION, id: 92 };
const BARRIER = { x1: 0.1, y1: 0.2, x2: 0.7, y2: 0.8 };
const PREVIEW: NonNullable<ToolStoreData["bucketFillPreview"]> = {
  vertices: [{ x: 0.1, y: 0.2 }, { x: 0.7, y: 0.2 }, { x: 0.4, y: 0.8 }],
  method: "fixture",
};
const PENDING: NonNullable<ToolStoreData["bucketFillPendingPolygon"]> = {
  vertices: PREVIEW.vertices,
  method: "fixture",
  bbox: [0.1, 0.2, 0.6, 0.6],
  areaSqUnits: 144,
  unit: "sq ft",
};
const SPLIT: NonNullable<ToolStoreData["splitPreview"]> = {
  targetAnnotationId: 91,
  original: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.5, y: 0.9 }],
  left: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.9 }],
  right: [{ x: 0.5, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.5, y: 0.9 }],
  lineA: { x: 0.5, y: 0 },
  lineB: { x: 0.5, y: 1 },
};
const SYMBOL_RESULTS: NonNullable<ToolStoreData["symbolSearchResults"]> = {
  templateBbox: [0.1, 0.2, 0.3, 0.4],
  sourcePageNumber: 3,
  matches: [],
  totalMatches: 0,
  pagesWithMatches: [],
  searchedAt: "2026-07-11T00:00:00.000Z",
};

function defaultConfig(): ToolStoreData["symbolSearchConfig"] {
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

function restore(): void {
  useToolStore.setState(useToolStore.getInitialState(), true);
}

function changedKeys(before: ToolStoreState, after: ToolStoreState): DataKey[] {
  return DATA_KEYS.filter((key) => !Object.is(before[key], after[key])).sort();
}

function sorted(keys: readonly DataKey[]): DataKey[] {
  return [...keys].sort();
}

function pickActions(state: ToolStoreState): Pick<ToolStoreState, LegacyActionKey> {
  return Object.fromEntries(LEGACY_ACTION_KEYS.map((key) => [key, state[key]])) as Pick<
    ToolStoreState,
    LegacyActionKey
  >;
}

beforeEach(restore);

describe("toolStore drawing-last — exact isolated contract", () => {
  it("owns exactly 40 data fields, 47 compatibility actions, and one project-reset action", () => {
    const state = useToolStore.getState();
    const data = Object.entries(state)
      .filter(([, value]) => typeof value !== "function")
      .map(([key]) => key)
      .sort();
    const actions = Object.entries(state)
      .filter(([, value]) => typeof value === "function")
      .map(([key]) => key)
      .sort();

    expect(DATA_KEYS).toHaveLength(40);
    expect(new Set(DATA_KEYS).size).toBe(40);
    expect(LEGACY_ACTION_KEYS).toHaveLength(47);
    expect(new Set(LEGACY_ACTION_KEYS).size).toBe(47);
    expect(data).toEqual([...DATA_KEYS].sort());
    expect(actions).toEqual([...LEGACY_ACTION_KEYS, "resetProjectToolState"].sort());
    expect(RESET_TOUCHED_KEYS).toHaveLength(20);
    expect(RESET_RETAINED_KEYS).toHaveLength(20);
    expect(sorted([...RESET_TOUCHED_KEYS, ...RESET_RETAINED_KEYS])).toEqual(sorted(DATA_KEYS));
  });

  it("freezes all construction defaults", () => {
    expect(useToolStore.getState()).toMatchObject({
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
      symbolSearchConfig: defaultConfig(),
      symbolSearchPreset: "lite",
    });
  });
});

interface PublicationCase {
  name: LegacyActionKey;
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

describe("toolStore AT2 — all compatibility actions", () => {
  it("covers the exact action ledger in order", () => {
    expect(PUBLICATION_CASES.map(({ name }) => name)).toEqual(LEGACY_ACTION_KEYS);
  });

  it.each(PUBLICATION_CASES)("$name publishes exactly once", ({ invoke }) => {
    const listener = vi.fn();
    const unsubscribe = useToolStore.subscribe(listener);
    invoke();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});

describe("toolStore drawing-last — exact writer behavior", () => {
  it("publishes only each drawing field and preserves supplied references", () => {
    const start = { x: 1, y: 2 };
    const end = { x: 3, y: 4 };
    const mouse = { x: 5, y: 6 };
    const before = useToolStore.getState();

    before._setDrawing(true);
    const afterDrawing = useToolStore.getState();
    expect(changedKeys(before, afterDrawing)).toEqual(["_drawing"]);
    afterDrawing._setDrawStart(start);
    const afterStart = useToolStore.getState();
    expect(changedKeys(afterDrawing, afterStart)).toEqual(["_drawStart"]);
    expect(afterStart._drawStart).toBe(start);
    afterStart._setDrawEnd(end);
    const afterEnd = useToolStore.getState();
    expect(changedKeys(afterStart, afterEnd)).toEqual(["_drawEnd"]);
    expect(afterEnd._drawEnd).toBe(end);
    afterEnd._setMousePos(mouse);
    const afterMouse = useToolStore.getState();
    expect(changedKeys(afterEnd, afterMouse)).toEqual(["_mousePos"]);
    expect(afterMouse._mousePos).toBe(mouse);
  });
});

describe("toolStore AT2 — compound action semantics", () => {
  it("setMode writes its exact 14-field teardown and preserves excluded sessions", () => {
    const undo = [ANNOTATION];
    const pending = PENDING;
    useToolStore.setState({
      mode: "markup", tempPanMode: true, activeTool: { kind: "symbolTemplate" },
      activeTakeoffItemId: 91, calibrationMode: "input", polygonDrawingMode: "drawing",
      polygonVertices: [{ x: 0.1, y: 0.2 }], bucketFillPreview: PREVIEW,
      bucketFillLoading: true, bucketFillError: "keep", bucketFillPendingPolygon: pending,
      bucketFillBarriers: [BARRIER], bucketFillBarrierMode: true,
      splitLineA: { x: 0.1, y: 0.2 }, splitLineB: { x: 0.7, y: 0.8 },
      splitPreview: SPLIT, splitError: "split", takeoffUndoStack: undo,
    });
    const before = useToolStore.getState();
    before.setMode("pointer");
    const after = useToolStore.getState();

    expect(changedKeys(before, after)).toEqual(sorted([
      "mode", "tempPanMode", "activeTool", "activeTakeoffItemId", "polygonDrawingMode",
      "polygonVertices", "bucketFillPreview", "bucketFillLoading", "bucketFillBarriers",
      "bucketFillBarrierMode", "splitLineA", "splitLineB", "splitPreview", "splitError",
    ]));
    expect(after.activeTool).toBeNull();
    expect(after.bucketFillError).toBe("keep");
    expect(after.bucketFillPendingPolygon).toBe(pending);
    expect(after.takeoffUndoStack).toBe(undo);
    expect(after.calibrationMode).toBe("input");
  });

  it("keeps bucket activation's session asymmetry and matching fallback", () => {
    const barriers = [BARRIER];
    useToolStore.setState({
      mode: "markup", tempPanMode: true, activeTool: { kind: "symbolTemplate" },
      activeTakeoffItemId: 91, bucketFillPreview: PREVIEW, bucketFillLoading: true,
      bucketFillError: "bucket", bucketFillPendingPolygon: PENDING,
      bucketFillBarriers: barriers, bucketFillBarrierMode: true,
      splitLineA: { x: 0.1, y: 0.2 }, splitLineB: { x: 0.7, y: 0.8 },
      splitPreview: SPLIT, splitError: "split",
    });
    const beforeTrue = useToolStore.getState();
    beforeTrue.setBucketFillActive(true);
    const afterTrue = useToolStore.getState();
    expect(changedKeys(beforeTrue, afterTrue)).toEqual(sorted([
      "mode", "tempPanMode", "activeTool", "bucketFillPreview", "bucketFillLoading",
      "bucketFillError", "bucketFillBarrierMode", "bucketFillPendingPolygon", "splitLineA",
      "splitLineB", "splitPreview", "splitError",
    ]));
    expect(afterTrue.activeTool).toEqual({ kind: "bucketFill" });
    expect(afterTrue.bucketFillBarriers).toBe(barriers);
    expect(afterTrue.activeTakeoffItemId).toBe(91);

    const bucketActivation = afterTrue.activeTool;
    afterTrue.setBucketFillActive(false);
    const afterFalse = useToolStore.getState();
    expect(changedKeys(afterTrue, afterFalse)).toEqual(sorted([
      "activeTool", "bucketFillBarriers",
    ]));
    expect(afterFalse.activeTool).toEqual({ kind: "takeoffPlacement" });
    expect(afterFalse.activeTool).not.toBe(bucketActivation);
    expect(afterFalse.mode).toBe("move");

    const unrelated = { kind: "tagPick" } as const;
    useToolStore.setState({ activeTool: unrelated });
    useToolStore.getState().setBucketFillActive(false);
    expect(useToolStore.getState().activeTool).toBe(unrelated);
  });

  it("keeps split activation's session asymmetry and matching-only release", () => {
    const pending = PENDING;
    const undo = [ANNOTATION];
    useToolStore.setState({
      mode: "markup", tempPanMode: true, activeTool: { kind: "bucketFill" },
      activeTakeoffItemId: 91, bucketFillPreview: PREVIEW, bucketFillLoading: true,
      bucketFillError: "bucket", bucketFillPendingPolygon: pending,
      bucketFillBarriers: [BARRIER], bucketFillBarrierMode: true,
      splitLineA: { x: 0.1, y: 0.2 }, splitLineB: { x: 0.7, y: 0.8 },
      splitPreview: SPLIT, splitError: "split", takeoffUndoStack: undo,
    });
    const beforeTrue = useToolStore.getState();
    beforeTrue.setSplitAreaActive(true);
    const afterTrue = useToolStore.getState();
    expect(changedKeys(beforeTrue, afterTrue)).toEqual(sorted([
      "mode", "activeTool", "activeTakeoffItemId", "bucketFillPreview", "bucketFillLoading",
      "bucketFillError", "splitLineA", "splitLineB", "splitPreview", "splitError",
      "bucketFillBarriers", "bucketFillBarrierMode",
    ]));
    expect(afterTrue.activeTool).toEqual({ kind: "split" });
    expect(afterTrue.tempPanMode).toBe(true);
    expect(afterTrue.bucketFillPendingPolygon).toBe(pending);
    expect(afterTrue.takeoffUndoStack).toBe(undo);

    afterTrue.setSplitAreaActive(false);
    expect(useToolStore.getState().activeTool).toBeNull();

    const unrelated = { kind: "tagAdd", tagId: "fixture" } as const;
    useToolStore.setState({ activeTool: unrelated, splitLineA: { x: 0.1, y: 0.2 } });
    useToolStore.getState().setSplitAreaActive(false);
    expect(useToolStore.getState().activeTool).toBe(unrelated);
  });

  it("keeps symbol activation pointer-atomic, takeoff-preserving, and session-dormant", () => {
    const barriers = [BARRIER];
    const vertices = [{ x: 0.2, y: 0.3 }];
    const config = { ...defaultConfig(), multiScale: false, searchPages: [2, 4] };
    useToolStore.setState({
      mode: "markup", tempPanMode: true, activeTool: { kind: "bucketFill" },
      activeTakeoffItemId: 91, polygonDrawingMode: "drawing", polygonVertices: vertices,
      bucketFillPreview: PREVIEW, bucketFillLoading: true, bucketFillError: "bucket",
      bucketFillPendingPolygon: PENDING, bucketFillBarriers: barriers,
      bucketFillBarrierMode: true, splitLineA: { x: 0.1, y: 0.2 },
      splitLineB: { x: 0.7, y: 0.8 }, splitPreview: SPLIT, splitError: "split",
      symbolSearchLoading: true, symbolSearchProgress: {
        page: 3, pageIndex: 1, totalPages: 4, matches: 2,
      },
      symbolSearchResults: SYMBOL_RESULTS, symbolSearchConfidence: 0.42,
      dismissedSymbolMatches: new Set(["one"]), symbolSearchError: "symbol",
      symbolSearchTemplateBbox: [0.1, 0.2, 0.3, 0.4], symbolSearchSourcePage: 3,
      symbolSearchConfig: config, symbolSearchPreset: "power",
    });
    const beforeTrue = useToolStore.getState();
    beforeTrue.setSymbolSearchActive(true);
    const afterTrue = useToolStore.getState();
    expect(changedKeys(beforeTrue, afterTrue)).toEqual(sorted([
      "mode", "activeTool", "bucketFillPreview", "bucketFillLoading",
      "bucketFillBarrierMode", "splitLineA", "splitLineB", "splitPreview", "splitError",
      "tempPanMode",
    ]));
    expect(afterTrue).toMatchObject({
      mode: "pointer", activeTool: { kind: "symbolTemplate" }, tempPanMode: false,
      activeTakeoffItemId: 91, polygonDrawingMode: "drawing", bucketFillError: "bucket",
      symbolSearchLoading: true, symbolSearchError: "symbol",
    });
    expect(afterTrue.polygonVertices).toBe(vertices);
    expect(afterTrue.bucketFillBarriers).toBe(barriers);
    expect(afterTrue.symbolSearchConfig).toBe(config);

    const symbolActivation = afterTrue.activeTool;
    afterTrue.setSymbolSearchActive(false);
    const afterFalse = useToolStore.getState();
    expect(changedKeys(afterTrue, afterFalse)).toEqual(["activeTool"]);
    expect(afterFalse.activeTool).toEqual({ kind: "takeoffPlacement" });
    expect(afterFalse.activeTool).not.toBe(symbolActivation);
    expect(afterFalse.symbolSearchResults).toBe(SYMBOL_RESULTS);

    const beforeClear = afterFalse;
    beforeClear.clearSymbolSearch();
    const afterClear = useToolStore.getState();
    expect(changedKeys(beforeClear, afterClear)).toEqual(sorted([
      "symbolSearchLoading", "symbolSearchProgress", "symbolSearchResults",
      "symbolSearchConfidence", "dismissedSymbolMatches", "symbolSearchError",
      "symbolSearchTemplateBbox", "symbolSearchSourcePage", "symbolSearchConfig",
    ]));
    expect(afterClear.activeTool).toBe(afterFalse.activeTool);
    expect(afterClear.symbolSearchPreset).toBe("power");
    expect(afterClear.symbolSearchConfig).toEqual(defaultConfig());
  });

  it("allocates fresh activations and gives tag entry the full destructive destination", () => {
    useToolStore.getState().setActiveTakeoffItemId(92);
    const takeoffA = useToolStore.getState().activeTool;
    useToolStore.getState().setActiveTakeoffItemId(92);
    expect(useToolStore.getState().activeTool).not.toBe(takeoffA);

    useToolStore.getState().setCalibrationMode("input");
    const calibrationA = useToolStore.getState().activeTool;
    useToolStore.getState().setCalibrationMode("input");
    expect(useToolStore.getState().activeTool).not.toBe(calibrationA);
    useToolStore.getState().resetCalibration();
    expect(useToolStore.getState().activeTool).toEqual({ kind: "takeoffPlacement" });

    useToolStore.setState({
      mode: "markup", tempPanMode: true, activeTakeoffItemId: 92,
      polygonDrawingMode: "drawing", polygonVertices: [{ x: 0.1, y: 0.2 }],
      bucketFillPreview: PREVIEW, bucketFillLoading: true,
    });
    useToolStore.getState().setTagAddingMode("tag-92");
    expect(useToolStore.getState()).toMatchObject({
      mode: "pointer", activeTool: { kind: "tagAdd", tagId: "tag-92" },
      tempPanMode: false, activeTakeoffItemId: null, polygonDrawingMode: "idle",
      polygonVertices: [], bucketFillPreview: null, bucketFillLoading: false,
    });
  });
});

describe("toolStore AT2 — allocation and reset policy", () => {
  it("retains caller values, copies owned containers, and allocates on semantic no-ops", () => {
    const point = { x: 0.1, y: 0.2 };
    const added = { x: 0.7, y: 0.8 };
    useToolStore.setState({
      calibrationPoints: { p1: point },
      polygonVertices: [point],
      dismissedSymbolMatches: new Set(["same"]),
      symbolSearchConfig: { ...defaultConfig(), searchPages: [2, 4] },
    });

    const pointsBefore = useToolStore.getState().calibrationPoints;
    useToolStore.getState().setCalibrationPoint("p2", added);
    expect(useToolStore.getState().calibrationPoints).not.toBe(pointsBefore);
    expect(useToolStore.getState().calibrationPoints.p1).toBe(point);
    expect(useToolStore.getState().calibrationPoints.p2).toBe(added);

    const verticesBefore = useToolStore.getState().polygonVertices;
    useToolStore.getState().addPolygonVertex(added);
    expect(useToolStore.getState().polygonVertices).not.toBe(verticesBefore);
    expect(useToolStore.getState().polygonVertices[0]).toBe(point);
    expect(useToolStore.getState().polygonVertices[1]).toBe(added);

    useToolStore.setState({ polygonVertices: [] });
    const empty = useToolStore.getState().polygonVertices;
    useToolStore.getState().undoLastVertex();
    expect(useToolStore.getState().polygonVertices).toEqual([]);
    expect(useToolStore.getState().polygonVertices).not.toBe(empty);

    const dismissed = useToolStore.getState().dismissedSymbolMatches;
    useToolStore.getState().dismissSymbolMatch("same");
    expect(useToolStore.getState().dismissedSymbolMatches).toEqual(dismissed);
    expect(useToolStore.getState().dismissedSymbolMatches).not.toBe(dismissed);

    const config = useToolStore.getState().symbolSearchConfig;
    useToolStore.getState().setSymbolSearchConfig({});
    expect(useToolStore.getState().symbolSearchConfig).toEqual(config);
    expect(useToolStore.getState().symbolSearchConfig).not.toBe(config);
    expect(useToolStore.getState().symbolSearchConfig.searchPages).toBe(config.searchPages);

    useToolStore.getState().setBucketFillPreview(PREVIEW);
    expect(useToolStore.getState().bucketFillPreview).toBe(PREVIEW);
    useToolStore.getState().setBucketFillPendingPolygon(PENDING);
    expect(useToolStore.getState().bucketFillPendingPolygon).toBe(PENDING);
    useToolStore.getState().setSplitPreview(SPLIT);
    expect(useToolStore.getState().splitPreview).toBe(SPLIT);
  });

  it("resetProjectToolState publishes once from defaults and allocates its five containers", () => {
    const before = useToolStore.getState();
    const listener = vi.fn();
    const unsubscribe = useToolStore.subscribe(listener);
    before.resetProjectToolState();
    const after = useToolStore.getState();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(changedKeys(before, after)).toEqual(sorted([
      "scaleCalibrations", "calibrationPoints", "polygonVertices",
      "dismissedSymbolMatches", "symbolSearchConfig",
    ]));
    expect(after.scaleCalibrations).not.toBe(before.scaleCalibrations);
    expect(after.calibrationPoints).not.toBe(before.calibrationPoints);
    expect(after.polygonVertices).not.toBe(before.polygonVertices);
    expect(after.dismissedSymbolMatches).not.toBe(before.dismissedSymbolMatches);
    expect(after.symbolSearchConfig).not.toBe(before.symbolSearchConfig);
    unsubscribe();
  });

  it("resetProjectToolState publishes once dirty, touches 20, retains 20, and keeps actions", () => {
    const scaleCalibrations = { 3: CALIBRATION };
    const calibrationPoints = { p1: { x: 0.1, y: 0.2 } };
    const vertices = [{ x: 0.1, y: 0.2 }];
    const barriers = [BARRIER];
    const undo = [ANNOTATION];
    const redo = [SECOND_ANNOTATION];
    const dismissed = new Set(["one"]);
    const config = { ...defaultConfig(), multiScale: false, searchPages: [2, 4] };
    const drawStart = { x: 11, y: 12 };
    const drawEnd = { x: 13, y: 14 };
    const mousePos = { x: 15, y: 16 };
    useToolStore.setState({
      mode: "markup", tempPanMode: true,
      _drawing: true, _drawStart: drawStart, _drawEnd: drawEnd, _mousePos: mousePos,
      activeTool: { kind: "tagAdd", tagId: "tag-91" }, activeTakeoffItemId: 91,
      scaleCalibrations, calibrationMode: "input", calibrationPoints,
      polygonDrawingMode: "drawing", polygonVertices: vertices,
      bucketFillPreview: PREVIEW, bucketFillLoading: true,
      bucketFillError: "bucket", bucketFillTolerance: 44, bucketFillDilatePx: 7,
      bucketFillResolution: 4000, bucketFillPendingPolygon: PENDING,
      bucketFillBarriers: barriers, bucketFillBarrierMode: true,
      barrierPendingPoint: { x: 0.4, y: 0.5 }, takeoffUndoStack: undo,
      takeoffRedoStack: redo,
      splitLineA: { x: 0.1, y: 0.2 }, splitLineB: { x: 0.7, y: 0.8 },
      splitPreview: SPLIT, splitError: "split",
      tagScanResults: { yoloClass: "door", yoloModel: "fixture", texts: [] },
      symbolSearchLoading: true,
      symbolSearchProgress: { page: 3, pageIndex: 1, totalPages: 4, matches: 2 },
      symbolSearchResults: SYMBOL_RESULTS,
      symbolSearchConfidence: 0.42, dismissedSymbolMatches: dismissed,
      symbolSearchError: "symbol", symbolSearchTemplateBbox: [0.1, 0.2, 0.3, 0.4],
      symbolSearchSourcePage: 3, symbolSearchConfig: config, symbolSearchPreset: "power",
    });
    const before = useToolStore.getState();
    const actions = pickActions(before);
    const listener = vi.fn();
    const unsubscribe = useToolStore.subscribe(listener);
    before.resetProjectToolState();
    const after = useToolStore.getState();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(changedKeys(before, after)).toEqual(sorted(RESET_TOUCHED_KEYS));
    for (const key of RESET_RETAINED_KEYS) {
      expect(after[key], `retained ${key}`).toBe(before[key]);
    }
    for (const key of LEGACY_ACTION_KEYS) {
      expect(after[key], `stable action ${key}`).toBe(actions[key]);
    }
    expect(after.resetProjectToolState).toBe(before.resetProjectToolState);
    expect(after).toMatchObject({
      tempPanMode: false, activeTool: null, activeTakeoffItemId: null, scaleCalibrations: {},
      calibrationMode: "idle", calibrationPoints: {}, polygonDrawingMode: "idle",
      polygonVertices: [], bucketFillResolution: 1000, tagScanResults: null,
      symbolSearchLoading: false, symbolSearchProgress: null, symbolSearchResults: null,
      symbolSearchConfidence: 0.75, symbolSearchError: null,
      symbolSearchTemplateBbox: null, symbolSearchSourcePage: null,
      symbolSearchConfig: defaultConfig(), symbolSearchPreset: "lite",
    });
    expect(after.dismissedSymbolMatches).toEqual(new Set<string>());
    expect(after.scaleCalibrations).not.toBe(scaleCalibrations);
    expect(after.calibrationPoints).not.toBe(calibrationPoints);
    expect(after.polygonVertices).not.toBe(vertices);
    expect(after.dismissedSymbolMatches).not.toBe(dismissed);
    expect(after.symbolSearchConfig).not.toBe(config);
    expect(after._drawing).toBe(true);
    expect(after._drawStart).toBe(drawStart);
    expect(after._drawEnd).toBe(drawEnd);
    expect(after._mousePos).toBe(mousePos);
    unsubscribe();
  });

  it("preserves exact bucket/split owner identity but clears every other owner on project reset", () => {
    const bucket = { kind: "bucketFill" } as const;
    useToolStore.setState({ activeTool: bucket });
    useToolStore.getState().resetProjectToolState();
    expect(useToolStore.getState().activeTool).toBe(bucket);

    const split = { kind: "split" } as const;
    useToolStore.setState({ activeTool: split });
    useToolStore.getState().resetProjectToolState();
    expect(useToolStore.getState().activeTool).toBe(split);

    useToolStore.setState({ activeTool: { kind: "takeoffPlacement" } });
    useToolStore.getState().resetProjectToolState();
    expect(useToolStore.getState().activeTool).toBeNull();
  });
});
