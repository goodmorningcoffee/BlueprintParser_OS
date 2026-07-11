// @vitest-environment node
// [refactor jul11 P2.3 T1] Isolated parity for the additive, production-dead flat tool owner.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  useToolStore,
  type ToolStoreData,
  type ToolStoreState,
} from "@/stores/toolStore";
import type { ClientAnnotation, ScaleCalibrationData } from "@/types";

const DATA_KEYS = [
  "mode", "tempPanMode", "activeTakeoffItemId", "scaleCalibrations", "calibrationMode",
  "calibrationPoints", "polygonDrawingMode", "polygonVertices", "bucketFillActive",
  "bucketFillPreview", "bucketFillLoading", "bucketFillError", "bucketFillTolerance",
  "bucketFillDilatePx", "bucketFillResolution", "bucketFillPendingPolygon", "splitAreaActive",
  "splitLineA", "splitLineB", "splitPreview", "splitError", "bucketFillBarriers",
  "bucketFillBarrierMode", "barrierPendingPoint", "takeoffUndoStack", "takeoffRedoStack",
  "yoloTagPickingMode", "tagScanResults", "tagAddingMode", "symbolSearchActive",
  "symbolSearchLoading", "symbolSearchProgress", "symbolSearchResults",
  "symbolSearchConfidence", "dismissedSymbolMatches", "symbolSearchError",
  "symbolSearchTemplateBbox", "symbolSearchSourcePage", "symbolSearchConfig",
  "symbolSearchPreset",
] as const satisfies readonly (keyof ToolStoreData)[];

const LEGACY_ACTION_KEYS = [
  "setMode", "setTempPanMode", "setActiveTakeoffItemId", "setScaleCalibration",
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
  "tempPanMode", "activeTakeoffItemId", "scaleCalibrations", "calibrationMode",
  "calibrationPoints", "polygonDrawingMode", "polygonVertices", "bucketFillResolution",
  "yoloTagPickingMode", "tagScanResults", "tagAddingMode", "symbolSearchActive",
  "symbolSearchLoading", "symbolSearchProgress", "symbolSearchResults",
  "symbolSearchConfidence", "dismissedSymbolMatches", "symbolSearchError",
  "symbolSearchTemplateBbox", "symbolSearchSourcePage", "symbolSearchConfig",
  "symbolSearchPreset",
] as const satisfies readonly (keyof ToolStoreData)[];

const RESET_RETAINED_KEYS = [
  "mode", "takeoffUndoStack", "takeoffRedoStack", "bucketFillActive",
  "bucketFillPreview", "bucketFillLoading", "bucketFillError", "bucketFillTolerance",
  "bucketFillDilatePx", "bucketFillPendingPolygon", "bucketFillBarriers",
  "bucketFillBarrierMode", "barrierPendingPoint", "splitAreaActive", "splitLineA",
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

describe("toolStore T1 — exact isolated contract", () => {
  it("owns exactly 40 data fields, 43 legacy actions, and one project-reset action", () => {
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
    expect(LEGACY_ACTION_KEYS).toHaveLength(43);
    expect(new Set(LEGACY_ACTION_KEYS).size).toBe(43);
    expect(data).toEqual([...DATA_KEYS].sort());
    expect(actions).toEqual([...LEGACY_ACTION_KEYS, "resetProjectToolState"].sort());
    expect(RESET_TOUCHED_KEYS).toHaveLength(22);
    expect(RESET_RETAINED_KEYS).toHaveLength(18);
    expect(sorted([...RESET_TOUCHED_KEYS, ...RESET_RETAINED_KEYS])).toEqual(sorted(DATA_KEYS));
  });

  it("freezes all construction defaults", () => {
    expect(useToolStore.getState()).toMatchObject({
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

describe("toolStore T1 — all legacy actions", () => {
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

describe("toolStore T1 — compound action semantics", () => {
  it("setMode writes exactly 16 fields and preserves excluded sessions", () => {
    const undo = [ANNOTATION];
    const pending = PENDING;
    useToolStore.setState({
      mode: "markup", tempPanMode: true, activeTakeoffItemId: 91,
      calibrationMode: "input", polygonDrawingMode: "drawing",
      polygonVertices: [{ x: 0.1, y: 0.2 }], bucketFillActive: true,
      bucketFillPreview: PREVIEW, bucketFillLoading: true, bucketFillError: "keep",
      bucketFillPendingPolygon: pending, bucketFillBarriers: [BARRIER],
      bucketFillBarrierMode: true, splitAreaActive: true,
      splitLineA: { x: 0.1, y: 0.2 }, splitLineB: { x: 0.7, y: 0.8 },
      splitPreview: SPLIT, splitError: "split", symbolSearchActive: true,
      takeoffUndoStack: undo,
    });
    const before = useToolStore.getState();
    before.setMode("pointer");
    const after = useToolStore.getState();

    expect(changedKeys(before, after)).toEqual(sorted([
      "mode", "tempPanMode", "activeTakeoffItemId", "polygonDrawingMode", "polygonVertices",
      "bucketFillActive", "bucketFillPreview", "bucketFillLoading", "bucketFillBarriers",
      "bucketFillBarrierMode", "splitAreaActive", "splitLineA", "splitLineB", "splitPreview",
      "splitError", "symbolSearchActive",
    ]));
    expect(after.bucketFillError).toBe("keep");
    expect(after.bucketFillPendingPolygon).toBe(pending);
    expect(after.takeoffUndoStack).toBe(undo);
    expect(after.calibrationMode).toBe("input");
  });

  it("keeps bucket activation's exact true/false asymmetry", () => {
    const barriers = [BARRIER];
    useToolStore.setState({
      mode: "markup", tempPanMode: true, activeTakeoffItemId: 91,
      bucketFillActive: false, bucketFillPreview: PREVIEW, bucketFillLoading: true,
      bucketFillError: "bucket", bucketFillPendingPolygon: PENDING,
      bucketFillBarriers: barriers, bucketFillBarrierMode: true,
      splitAreaActive: true, splitLineA: { x: 0.1, y: 0.2 },
      splitLineB: { x: 0.7, y: 0.8 }, splitPreview: SPLIT, splitError: "split",
      symbolSearchActive: true,
    });
    const beforeTrue = useToolStore.getState();
    beforeTrue.setBucketFillActive(true);
    const afterTrue = useToolStore.getState();
    expect(changedKeys(beforeTrue, afterTrue)).toEqual(sorted([
      "mode", "tempPanMode", "bucketFillActive", "bucketFillPreview", "bucketFillLoading",
      "bucketFillError", "bucketFillBarrierMode", "bucketFillPendingPolygon", "splitAreaActive",
      "splitLineA", "splitLineB", "splitPreview", "splitError", "symbolSearchActive",
    ]));
    expect(afterTrue.bucketFillBarriers).toBe(barriers);
    expect(afterTrue.activeTakeoffItemId).toBe(91);

    restore();
    useToolStore.setState({
      mode: "markup", bucketFillActive: true, bucketFillPreview: PREVIEW,
      bucketFillLoading: true, bucketFillError: "bucket", bucketFillPendingPolygon: PENDING,
      bucketFillBarriers: barriers, bucketFillBarrierMode: true,
      splitAreaActive: true, symbolSearchActive: true,
    });
    const beforeFalse = useToolStore.getState();
    beforeFalse.setBucketFillActive(false);
    const afterFalse = useToolStore.getState();
    expect(changedKeys(beforeFalse, afterFalse)).toEqual(sorted([
      "bucketFillActive", "bucketFillPreview", "bucketFillLoading", "bucketFillError",
      "bucketFillPendingPolygon", "bucketFillBarriers", "bucketFillBarrierMode",
    ]));
    expect(afterFalse).toMatchObject({
      mode: "markup", splitAreaActive: true, symbolSearchActive: true,
    });
  });

  it("keeps split activation's exact true/false asymmetry", () => {
    const pending = PENDING;
    const undo = [ANNOTATION];
    useToolStore.setState({
      mode: "markup", tempPanMode: true, activeTakeoffItemId: 91,
      bucketFillActive: true, bucketFillPreview: PREVIEW, bucketFillLoading: true,
      bucketFillError: "bucket", bucketFillPendingPolygon: pending,
      bucketFillBarriers: [BARRIER], bucketFillBarrierMode: true,
      splitAreaActive: false, splitLineA: { x: 0.1, y: 0.2 },
      splitLineB: { x: 0.7, y: 0.8 }, splitPreview: SPLIT, splitError: "split",
      symbolSearchActive: true, takeoffUndoStack: undo,
    });
    const beforeTrue = useToolStore.getState();
    beforeTrue.setSplitAreaActive(true);
    const afterTrue = useToolStore.getState();
    expect(changedKeys(beforeTrue, afterTrue)).toEqual(sorted([
      "mode", "activeTakeoffItemId", "bucketFillActive", "bucketFillPreview",
      "bucketFillLoading", "bucketFillError", "splitAreaActive", "splitLineA", "splitLineB",
      "splitPreview", "splitError", "bucketFillBarriers", "bucketFillBarrierMode",
      "symbolSearchActive",
    ]));
    expect(afterTrue.tempPanMode).toBe(true);
    expect(afterTrue.bucketFillPendingPolygon).toBe(pending);
    expect(afterTrue.takeoffUndoStack).toBe(undo);

    restore();
    useToolStore.setState({
      mode: "markup", bucketFillActive: true, symbolSearchActive: true,
      splitAreaActive: true, splitLineA: { x: 0.1, y: 0.2 },
      splitLineB: { x: 0.7, y: 0.8 }, splitPreview: SPLIT, splitError: "split",
    });
    const beforeFalse = useToolStore.getState();
    beforeFalse.setSplitAreaActive(false);
    const afterFalse = useToolStore.getState();
    expect(changedKeys(beforeFalse, afterFalse)).toEqual(sorted([
      "splitAreaActive", "splitLineA", "splitLineB", "splitPreview", "splitError",
    ]));
    expect(afterFalse).toMatchObject({
      mode: "markup", bucketFillActive: true, symbolSearchActive: true,
    });
  });

  it("keeps symbol activation/deactivation and clear/preset behavior exact", () => {
    const barriers = [BARRIER];
    const config = { ...defaultConfig(), multiScale: false, searchPages: [2, 4] };
    useToolStore.setState({
      mode: "markup", tempPanMode: true, activeTakeoffItemId: 91,
      bucketFillActive: true, bucketFillPreview: PREVIEW, bucketFillLoading: true,
      bucketFillError: "bucket", bucketFillPendingPolygon: PENDING,
      bucketFillBarriers: barriers, bucketFillBarrierMode: true,
      splitAreaActive: true, splitLineA: { x: 0.1, y: 0.2 },
      splitLineB: { x: 0.7, y: 0.8 }, splitPreview: SPLIT, splitError: "split",
      symbolSearchActive: false, symbolSearchLoading: true,
      symbolSearchProgress: { page: 3, pageIndex: 1, totalPages: 4, matches: 2 },
      symbolSearchConfidence: 0.42, dismissedSymbolMatches: new Set(["one"]),
      symbolSearchError: "symbol", symbolSearchTemplateBbox: [0.1, 0.2, 0.3, 0.4],
      symbolSearchSourcePage: 3, symbolSearchConfig: config, symbolSearchPreset: "power",
    });
    const beforeTrue = useToolStore.getState();
    beforeTrue.setSymbolSearchActive(true);
    const afterTrue = useToolStore.getState();
    expect(changedKeys(beforeTrue, afterTrue)).toEqual(sorted([
      "mode", "bucketFillActive", "bucketFillPreview", "bucketFillLoading",
      "bucketFillBarrierMode", "splitAreaActive", "splitLineA", "splitLineB", "splitPreview",
      "splitError", "symbolSearchActive",
    ]));
    expect(afterTrue).toMatchObject({
      tempPanMode: true, activeTakeoffItemId: 91, bucketFillError: "bucket",
      symbolSearchLoading: true, symbolSearchError: "symbol",
    });
    expect(afterTrue.bucketFillBarriers).toBe(barriers);
    expect(afterTrue.symbolSearchConfig).toBe(config);

    const beforeFalse = afterTrue;
    beforeFalse.setSymbolSearchActive(false);
    expect(changedKeys(beforeFalse, useToolStore.getState())).toEqual(["symbolSearchActive"]);

    const beforeClear = useToolStore.getState();
    beforeClear.clearSymbolSearch();
    const afterClear = useToolStore.getState();
    expect(changedKeys(beforeClear, afterClear)).toEqual(sorted([
      "symbolSearchLoading", "symbolSearchProgress", "symbolSearchConfidence",
      "dismissedSymbolMatches", "symbolSearchError", "symbolSearchTemplateBbox",
      "symbolSearchSourcePage", "symbolSearchConfig",
    ]));
    expect(afterClear.symbolSearchPreset).toBe("power");
    expect(afterClear.symbolSearchConfig).toEqual(defaultConfig());

    const configBeforePreset = afterClear.symbolSearchConfig;
    afterClear.setSymbolSearchPreset("power");
    const afterPreset = useToolStore.getState();
    expect(changedKeys(afterClear, afterPreset)).toEqual(["symbolSearchConfig"]);
    expect(afterPreset.symbolSearchConfig).not.toBe(configBeforePreset);
    expect(afterPreset.symbolSearchConfig).toMatchObject({
      scaleMin: 0.5, scaleMax: 2, nmsThreshold: 0.2,
    });
  });
});

describe("toolStore T1 — allocation and reset policy", () => {
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

  it("resetProjectToolState publishes once dirty, touches 22, retains 18, and keeps actions", () => {
    const scaleCalibrations = { 3: CALIBRATION };
    const calibrationPoints = { p1: { x: 0.1, y: 0.2 } };
    const vertices = [{ x: 0.1, y: 0.2 }];
    const barriers = [BARRIER];
    const undo = [ANNOTATION];
    const redo = [SECOND_ANNOTATION];
    const dismissed = new Set(["one"]);
    const config = { ...defaultConfig(), multiScale: false, searchPages: [2, 4] };
    useToolStore.setState({
      mode: "markup", tempPanMode: true, activeTakeoffItemId: 91,
      scaleCalibrations, calibrationMode: "input", calibrationPoints,
      polygonDrawingMode: "drawing", polygonVertices: vertices,
      bucketFillActive: true, bucketFillPreview: PREVIEW, bucketFillLoading: true,
      bucketFillError: "bucket", bucketFillTolerance: 44, bucketFillDilatePx: 7,
      bucketFillResolution: 4000, bucketFillPendingPolygon: PENDING,
      bucketFillBarriers: barriers, bucketFillBarrierMode: true,
      barrierPendingPoint: { x: 0.4, y: 0.5 }, takeoffUndoStack: undo,
      takeoffRedoStack: redo, splitAreaActive: true,
      splitLineA: { x: 0.1, y: 0.2 }, splitLineB: { x: 0.7, y: 0.8 },
      splitPreview: SPLIT, splitError: "split", yoloTagPickingMode: true,
      tagScanResults: { yoloClass: "door", yoloModel: "fixture", texts: [] },
      tagAddingMode: "tag-91", symbolSearchActive: true, symbolSearchLoading: true,
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
      tempPanMode: false, activeTakeoffItemId: null, scaleCalibrations: {},
      calibrationMode: "idle", calibrationPoints: {}, polygonDrawingMode: "idle",
      polygonVertices: [], bucketFillResolution: 1000, yoloTagPickingMode: false,
      tagScanResults: null, tagAddingMode: null, symbolSearchActive: false,
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
    unsubscribe();
  });
});
