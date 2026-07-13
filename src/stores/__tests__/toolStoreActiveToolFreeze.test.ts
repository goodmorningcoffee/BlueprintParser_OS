// @vitest-environment node
// [refactor jul13 P2.3 AT2] Runtime contract for the atomic activation discriminator.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  claimLatestToolOperation,
  claimToolTailAuthority,
  invalidateLatestToolOperation,
  invalidateToolTailAuthority,
  ownsLatestToolOperation,
  ownsToolTailAuthority,
} from "@/lib/parse-tool-authority";
import {
  advanceCalibrationGesture,
  publishSettledCalibrationReset,
  publishSettledSymbolSearchCleanup,
  reconcileSettledDeletedTakeoffItem,
  useToolStore,
} from "@/stores/toolStore";

function restore(): void {
  invalidateToolTailAuthority();
  invalidateLatestToolOperation("bucketFill");
  invalidateLatestToolOperation("symbolSession");
  useToolStore.setState(useToolStore.getInitialState(), true);
}

beforeEach(restore);

describe("toolStore AT2 — atomic active-tool transitions", () => {
  it("allocates a fresh activation for every activation and resumes only frozen fallbacks", () => {
    const tool = useToolStore.getState();
    tool.setActiveTakeoffItemId(17);
    const takeoffA = useToolStore.getState().activeTool;
    expect(takeoffA).toEqual({ kind: "takeoffPlacement" });

    useToolStore.getState().setActiveTakeoffItemId(17);
    const takeoffB = useToolStore.getState().activeTool;
    expect(takeoffB).toEqual({ kind: "takeoffPlacement" });
    expect(takeoffB).not.toBe(takeoffA);

    useToolStore.getState().setCalibrationMode("input");
    const calibrationA = useToolStore.getState().activeTool;
    useToolStore.getState().setCalibrationMode("input");
    const calibrationB = useToolStore.getState().activeTool;
    expect(calibrationB).toEqual({ kind: "calibration" });
    expect(calibrationB).not.toBe(calibrationA);

    useToolStore.getState().setCalibrationPoint("p1", { x: 0.1, y: 0.2 });
    useToolStore.getState().setCalibrationMode("idle");
    expect(useToolStore.getState().activeTool).toEqual({ kind: "takeoffPlacement" });
    expect(useToolStore.getState().activeTool).not.toBe(takeoffB);
    expect(useToolStore.getState().calibrationPoints).toEqual({});

    useToolStore.getState().setBucketFillActive(true);
    const bucketA = useToolStore.getState().activeTool;
    useToolStore.getState().setBucketFillActive(true);
    expect(useToolStore.getState().activeTool).toEqual({ kind: "bucketFill" });
    expect(useToolStore.getState().activeTool).not.toBe(bucketA);
    useToolStore.getState().setBucketFillActive(false);
    expect(useToolStore.getState().activeTool).toEqual({ kind: "takeoffPlacement" });

    useToolStore.getState().setSplitAreaActive(true);
    expect(useToolStore.getState().activeTakeoffItemId).toBeNull();
    useToolStore.getState().setSplitAreaActive(false);
    expect(useToolStore.getState().activeTool).toBeNull();
  });

  it("makes tag entry destructive and symbol entry pointer-atomic but takeoff-preserving", () => {
    useToolStore.setState({
      mode: "markup",
      tempPanMode: true,
      activeTakeoffItemId: 21,
      activeTool: { kind: "takeoffPlacement" },
      polygonDrawingMode: "drawing",
      polygonVertices: [{ x: 0.1, y: 0.2 }],
      bucketFillPreview: { vertices: [], method: "fixture" },
      bucketFillLoading: true,
      bucketFillBarriers: [{ x1: 0, y1: 0, x2: 1, y2: 1 }],
      splitLineA: { x: 0.1, y: 0.2 },
    });

    const polygonVertices = useToolStore.getState().polygonVertices;
    useToolStore.getState().setSymbolSearchActive(true);
    expect(useToolStore.getState()).toMatchObject({
      mode: "pointer",
      activeTool: { kind: "symbolTemplate" },
      activeTakeoffItemId: 21,
      polygonDrawingMode: "drawing",
    });
    expect(useToolStore.getState().polygonVertices).toBe(polygonVertices);

    useToolStore.getState().setTagAddingMode("door");
    expect(useToolStore.getState()).toMatchObject({
      mode: "pointer",
      activeTool: { kind: "tagAdd", tagId: "door" },
      activeTakeoffItemId: null,
      polygonDrawingMode: "idle",
      polygonVertices: [],
      bucketFillPreview: null,
      bucketFillLoading: false,
      bucketFillBarriers: [],
      splitLineA: null,
      tempPanMode: false,
    });
  });

  it("cleans dormant sessions without releasing an unrelated live owner", () => {
    useToolStore.getState().setYoloTagPickingMode(true);
    const tagPick = useToolStore.getState().activeTool;
    useToolStore.getState().setBucketFillActive(false);
    expect(useToolStore.getState().activeTool).toBe(tagPick);
    useToolStore.getState().setSplitAreaActive(false);
    expect(useToolStore.getState().activeTool).toBe(tagPick);
    useToolStore.getState().setSymbolSearchActive(false);
    expect(useToolStore.getState().activeTool).toBe(tagPick);
    useToolStore.getState().setCalibrationMode("idle");
    expect(useToolStore.getState().activeTool).toBe(tagPick);
  });

  it("preserves only the exact temporary bucket/split owner across project reset", () => {
    useToolStore.getState().setBucketFillActive(true);
    const bucket = useToolStore.getState().activeTool;
    useToolStore.getState().resetProjectToolState();
    expect(useToolStore.getState().activeTool).toBe(bucket);

    useToolStore.getState().setSplitAreaActive(true);
    const split = useToolStore.getState().activeTool;
    useToolStore.getState().resetProjectToolState();
    expect(useToolStore.getState().activeTool).toBe(split);

    useToolStore.getState().setYoloTagPickingMode(true);
    useToolStore.getState().resetProjectToolState();
    expect(useToolStore.getState().activeTool).toBeNull();
  });
});

describe("toolStore AT2 — narrow passive settlement", () => {
  it("reconciles only a live matching deleted selection and matching takeoff owner", () => {
    useToolStore.getState().setActiveTakeoffItemId(31);
    expect(reconcileSettledDeletedTakeoffItem(31)).toBe(true);
    expect(useToolStore.getState()).toMatchObject({
      activeTakeoffItemId: null,
      activeTool: null,
      takeoffUndoStack: [],
      takeoffRedoStack: [],
    });

    useToolStore.getState().setActiveTakeoffItemId(32);
    useToolStore.getState().setBucketFillActive(true);
    const bucket = useToolStore.getState().activeTool;
    expect(reconcileSettledDeletedTakeoffItem(32)).toBe(true);
    expect(useToolStore.getState().activeTakeoffItemId).toBeNull();
    expect(useToolStore.getState().activeTool).toBe(bucket);

    const before = useToolStore.getState();
    const listener = vi.fn();
    const unsubscribe = useToolStore.subscribe(listener);
    expect(reconcileSettledDeletedTakeoffItem(999)).toBe(false);
    expect(useToolStore.getState()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("CASes calibration cleanup by exact activation identity", () => {
    useToolStore.getState().setActiveTakeoffItemId(41);
    useToolStore.getState().setCalibrationMode("input");
    const stale = useToolStore.getState().activeTool;
    expect(stale?.kind).toBe("calibration");
    if (stale?.kind !== "calibration") throw new Error("expected calibration fixture");

    useToolStore.getState().setCalibrationPoint("p1", { x: 0.1, y: 0.2 });
    useToolStore.getState().setCalibrationMode("input");
    const current = useToolStore.getState().activeTool;
    expect(current?.kind).toBe("calibration");
    if (current?.kind !== "calibration") throw new Error("expected calibration fixture");

    expect(publishSettledCalibrationReset(stale)).toBe(false);
    expect(useToolStore.getState().activeTool).toBe(current);
    expect(useToolStore.getState().calibrationPoints).toHaveProperty("p1");

    expect(publishSettledCalibrationReset(current)).toBe(true);
    expect(useToolStore.getState()).toMatchObject({
      calibrationMode: "idle",
      calibrationPoints: {},
      activeTool: { kind: "takeoffPlacement" },
    });
  });

  it("advances calibration point plus phase once and preserves subscriber B", () => {
    useToolStore.getState().setCalibrationMode("point1");
    const calibrationA = useToolStore.getState().activeTool;
    if (calibrationA?.kind !== "calibration") throw new Error("expected calibration fixture");
    let admittedB = false;
    const unsubscribe = useToolStore.subscribe((state) => {
      if (admittedB || state.calibrationMode !== "point2" || !state.calibrationPoints.p1) return;
      admittedB = true;
      state.setSymbolSearchActive(true);
    });

    expect(advanceCalibrationGesture(
      calibrationA,
      "point1",
      "p1",
      { x: 0.25, y: 0.5 },
      "point2",
    )).toBe(true);
    unsubscribe();
    expect(admittedB).toBe(true);
    expect(useToolStore.getState()).toMatchObject({
      activeTool: { kind: "symbolTemplate" },
      calibrationMode: "point2",
      calibrationPoints: { p1: { x: 0.25, y: 0.5 } },
    });
    expect(advanceCalibrationGesture(
      calibrationA,
      "point1",
      "p1",
      { x: 0.9, y: 0.9 },
      "point2",
    )).toBe(false);
    expect(useToolStore.getState().calibrationPoints.p1).toEqual({ x: 0.25, y: 0.5 });
  });

  it.each([
    { name: "tolerance", invoke: () => useToolStore.getState().setBucketFillTolerance(41) },
    { name: "dilation", invoke: () => useToolStore.getState().setBucketFillDilatePx(6) },
    { name: "resolution", invoke: () => useToolStore.getState().setBucketFillResolution(2000) },
    { name: "add barrier", invoke: () => useToolStore.getState().addBucketFillBarrier({ x1: 0, y1: 0, x2: 1, y2: 1 }) },
    { name: "undo barrier", invoke: () => useToolStore.getState().undoLastBarrier() },
    { name: "clear barriers", invoke: () => useToolStore.getState().clearBucketFillBarriers() },
    { name: "barrier mode", invoke: () => useToolStore.getState().setBucketFillBarrierMode(true) },
    { name: "pending point", invoke: () => useToolStore.getState().setBarrierPendingPoint({ x: 0.2, y: 0.3 }) },
  ])("makes the $name control an eager Bucket cancellation boundary", ({ invoke }) => {
    const activation = { kind: "bucketFill" } as const;
    const token = {};
    useToolStore.setState({
      activeTool: activation,
      bucketFillLoading: true,
      bucketFillError: "old error",
      bucketFillBarriers: [{ x1: 0, y1: 0, x2: 0.5, y2: 0.5 }],
    });
    claimToolTailAuthority(token);
    claimLatestToolOperation("bucketFill", token);

    invoke();
    expect(useToolStore.getState().activeTool).toBe(activation);
    expect(useToolStore.getState().bucketFillLoading).toBe(false);
    expect(useToolStore.getState().bucketFillError).toBeNull();
    expect(ownsToolTailAuthority(token)).toBe(false);
    expect(ownsLatestToolOperation("bucketFill", token)).toBe(false);
  });

  it("clears an authorized symbol session while exact-release preserves a newer owner", () => {
    useToolStore.getState().setActiveTakeoffItemId(51);
    useToolStore.getState().setSymbolSearchActive(true);
    const symbol = useToolStore.getState().activeTool;
    expect(symbol?.kind).toBe("symbolTemplate");
    if (symbol?.kind !== "symbolTemplate") throw new Error("expected symbol fixture");
    useToolStore.getState().setSymbolSearchTemplateBbox([0.1, 0.2, 0.3, 0.4]);

    useToolStore.getState().setYoloTagPickingMode(true);
    const tagPick = useToolStore.getState().activeTool;
    expect(publishSettledSymbolSearchCleanup(symbol)).toBe(false);
    expect(useToolStore.getState().activeTool).toBe(tagPick);
    expect(useToolStore.getState().symbolSearchTemplateBbox).toBeNull();
  });

  it("invalidates the global and both latest-result lanes before project publication", () => {
    const global = claimToolTailAuthority({});
    const bucket = claimLatestToolOperation("bucketFill", {});
    const symbol = claimLatestToolOperation("symbolSession", {});
    useToolStore.getState().resetProjectToolState();
    expect(ownsToolTailAuthority(global)).toBe(false);
    expect(ownsLatestToolOperation("bucketFill", bucket)).toBe(false);
    expect(ownsLatestToolOperation("symbolSession", symbol)).toBe(false);
  });
});
