import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

import {
  activeToolAfterProjectReset,
  releaseActiveToolExact,
  transitionActiveTool,
  type ActiveTool,
  type ActiveToolObject,
} from "@/lib/active-tool-state";
import {
  invalidateLatestToolOperation,
  invalidateToolTailAuthority,
} from "@/lib/parse-tool-authority";
import type { ClientAnnotation, ScaleCalibrationData, SymbolSearchResult } from "@/types";

// [refactor jul11 P2.3 T2] Mechanically-flat interaction/tool owner. Production consumers read
// this leaf directly after the atomic ownership flip. Parse flows, server drafts, UI, viewer
// geometry, and the four high-frequency drawing fields deliberately remain outside this boundary.

export interface ToolTagScanResults {
  yoloClass: string;
  yoloModel: string;
  texts: {
    text: string;
    count: number;
    pages: number[];
    instances: {
      pageNumber: number;
      annotationId: number;
      bbox: [number, number, number, number];
      confidence: number;
    }[];
  }[];
}

export interface ToolStoreData {
  mode: "move" | "pointer" | "markup" | "group";
  tempPanMode: boolean;
  activeTool: ActiveTool;

  activeTakeoffItemId: number | null;
  scaleCalibrations: Record<number, ScaleCalibrationData>;
  calibrationMode: "idle" | "point1" | "point2" | "input";
  calibrationPoints: { p1?: { x: number; y: number }; p2?: { x: number; y: number } };
  polygonDrawingMode: "idle" | "drawing";
  polygonVertices: { x: number; y: number }[];

  bucketFillPreview: {
    vertices: { x: number; y: number }[];
    holes?: { vertices: { x: number; y: number }[] }[];
    method: string;
  } | null;
  bucketFillLoading: boolean;
  bucketFillError: string | null;
  bucketFillTolerance: number;
  bucketFillDilatePx: number;
  bucketFillResolution: 1000 | 2000 | 3000 | 4000;
  bucketFillPendingPolygon: {
    vertices: { x: number; y: number }[];
    holes?: { vertices: { x: number; y: number }[] }[];
    method: string;
    bbox: [number, number, number, number];
    areaSqUnits: number;
    unit: string;
  } | null;

  splitLineA: { x: number; y: number } | null;
  splitLineB: { x: number; y: number } | null;
  splitPreview: {
    targetAnnotationId: number;
    original: { x: number; y: number }[];
    left: { x: number; y: number }[];
    right: { x: number; y: number }[];
    lineA: { x: number; y: number };
    lineB: { x: number; y: number };
  } | null;
  splitError: string | null;

  bucketFillBarriers: { x1: number; y1: number; x2: number; y2: number }[];
  bucketFillBarrierMode: boolean;
  barrierPendingPoint: { x: number; y: number } | null;
  takeoffUndoStack: ClientAnnotation[];
  takeoffRedoStack: ClientAnnotation[];

  tagScanResults: ToolTagScanResults | null;

  symbolSearchLoading: boolean;
  symbolSearchProgress: {
    page: number;
    pageIndex: number;
    totalPages: number;
    matches: number;
  } | null;
  symbolSearchResults: SymbolSearchResult | null;
  symbolSearchConfidence: number;
  dismissedSymbolMatches: Set<string>;
  symbolSearchError: string | null;
  symbolSearchTemplateBbox: [number, number, number, number] | null;
  symbolSearchSourcePage: number | null;
  symbolSearchConfig: {
    multiScale: boolean;
    useSiftFallback: boolean;
    searchPages: number[] | null;
    scaleMin: number;
    scaleMax: number;
    nmsThreshold: number;
    maxMatchesPerPage: number;
  };
  symbolSearchPreset: "lite" | "power";
}

export interface ToolStoreActions {
  setMode: (mode: ToolStoreData["mode"]) => void;
  setTempPanMode: (value: boolean) => void;

  setActiveTakeoffItemId: (id: number | null) => void;
  setScaleCalibration: (pageNum: number, calibration: ScaleCalibrationData) => void;
  setCalibrationMode: (mode: ToolStoreData["calibrationMode"]) => void;
  setCalibrationPoint: (
    which: "p1" | "p2",
    point: { x: number; y: number },
  ) => void;
  resetCalibration: () => void;
  setPolygonDrawingMode: (mode: ToolStoreData["polygonDrawingMode"]) => void;
  addPolygonVertex: (vertex: { x: number; y: number }) => void;
  undoLastVertex: () => void;
  resetPolygonDrawing: () => void;

  setBucketFillActive: (active: boolean) => void;
  setBucketFillPreview: (preview: ToolStoreData["bucketFillPreview"]) => void;
  setBucketFillLoading: (loading: boolean) => void;
  setBucketFillError: (error: string | null) => void;
  setBucketFillTolerance: (tolerance: number) => void;
  setBucketFillDilatePx: (pixels: number) => void;
  setBucketFillResolution: (resolution: ToolStoreData["bucketFillResolution"]) => void;
  setBucketFillPendingPolygon: (
    polygon: ToolStoreData["bucketFillPendingPolygon"],
  ) => void;

  setSplitAreaActive: (active: boolean) => void;
  setSplitLineEndpoint: (
    which: "a" | "b",
    point: { x: number; y: number } | null,
  ) => void;
  setSplitPreview: (preview: ToolStoreData["splitPreview"]) => void;
  setSplitError: (error: string | null) => void;
  addBucketFillBarrier: (
    line: { x1: number; y1: number; x2: number; y2: number },
  ) => void;
  undoLastBarrier: () => void;
  clearBucketFillBarriers: () => void;
  setBucketFillBarrierMode: (active: boolean) => void;
  setBarrierPendingPoint: (point: { x: number; y: number } | null) => void;

  setYoloTagPickingMode: (active: boolean) => void;
  setTagScanResults: (results: ToolTagScanResults | null) => void;
  setTagAddingMode: (tagId: string | null) => void;

  setSymbolSearchActive: (active: boolean) => void;
  setSymbolSearchLoading: (loading: boolean) => void;
  setSymbolSearchProgress: (progress: ToolStoreData["symbolSearchProgress"]) => void;
  setSymbolSearchResults: (results: SymbolSearchResult | null) => void;
  setSymbolSearchConfidence: (confidence: number) => void;
  dismissSymbolMatch: (matchId: string) => void;
  setSymbolSearchError: (error: string | null) => void;
  setSymbolSearchTemplateBbox: (
    bbox: [number, number, number, number] | null,
  ) => void;
  setSymbolSearchSourcePage: (page: number | null) => void;
  setSymbolSearchConfig: (patch: Partial<ToolStoreData["symbolSearchConfig"]>) => void;
  setSymbolSearchPreset: (preset: ToolStoreData["symbolSearchPreset"]) => void;
  clearSymbolSearch: () => void;

  /** Preserve the exact temporary 20-touched/16-retained project-switch policy until P2.5. */
  resetProjectToolState: () => void;
}

export type ToolStoreState = ToolStoreData & ToolStoreActions;

function modeDestination(mode: ToolStoreData["mode"]): Partial<ToolStoreData> {
  return {
    mode,
    activeTool: null,
    activeTakeoffItemId: null,
    polygonDrawingMode: "idle",
    polygonVertices: [],
    bucketFillPreview: null,
    bucketFillLoading: false,
    bucketFillBarriers: [],
    bucketFillBarrierMode: false,
    splitLineA: null,
    splitLineB: null,
    splitPreview: null,
    splitError: null,
    tempPanMode: false,
  };
}

function activeTakeoffDestination(
  state: Pick<ToolStoreData, "activeTool" | "activeTakeoffItemId">,
  activeTakeoffItemId: number | null,
): Partial<ToolStoreData> {
  return {
    activeTakeoffItemId,
    activeTool: transitionActiveTool(state, {
      type: "selectTakeoff",
      itemId: activeTakeoffItemId,
    }),
    takeoffUndoStack: [],
    takeoffRedoStack: [],
  };
}

function symbolSearchActiveDestination(
  state: Pick<ToolStoreData, "activeTool" | "activeTakeoffItemId">,
  active: boolean,
): Partial<ToolStoreData> {
  const activeTool = transitionActiveTool(state, { type: "setSymbolTemplate", active });
  return active
    ? {
        activeTool,
        mode: "pointer",
        tempPanMode: false,
        bucketFillPreview: null,
        bucketFillLoading: false,
        bucketFillBarrierMode: false,
        splitLineA: null,
        splitLineB: null,
        splitPreview: null,
        splitError: null,
      }
    : { activeTool };
}

export const useToolStore = create<ToolStoreState>((set) => ({
  mode: "move",
  setMode: (mode) => {
    invalidateToolTailAuthority();
    set(modeDestination(mode));
  },
  tempPanMode: false,
  setTempPanMode: (tempPanMode) => {
    invalidateToolTailAuthority();
    set({ tempPanMode });
  },
  activeTool: null,

  activeTakeoffItemId: null,
  setActiveTakeoffItemId: (activeTakeoffItemId) => {
    invalidateToolTailAuthority();
    set((state) => activeTakeoffDestination(state, activeTakeoffItemId));
  },

  scaleCalibrations: {},
  setScaleCalibration: (pageNum, calibration) => set((state) => ({
    scaleCalibrations: { ...state.scaleCalibrations, [pageNum]: calibration },
  })),
  calibrationMode: "idle",
  setCalibrationMode: (calibrationMode) => {
    invalidateToolTailAuthority();
    set((state) => ({
      ...(calibrationMode === "idle" || calibrationMode === "point1"
        ? { calibrationPoints: {} }
        : {}),
      ...(calibrationMode !== "idle" ? { mode: "move" as const } : {}),
      calibrationMode,
      activeTool: transitionActiveTool(state, {
        type: "setCalibrationMode",
        mode: calibrationMode,
      }),
    }));
  },
  calibrationPoints: {},
  setCalibrationPoint: (which, point) => set((state) => ({
    calibrationPoints: { ...state.calibrationPoints, [which]: point },
  })),
  resetCalibration: () => {
    invalidateToolTailAuthority();
    set((state) => ({
      calibrationMode: "idle",
      calibrationPoints: {},
      activeTool: transitionActiveTool(state, {
        type: "setCalibrationMode",
        mode: "idle",
      }),
    }));
  },

  polygonDrawingMode: "idle",
  setPolygonDrawingMode: (polygonDrawingMode) => {
    invalidateToolTailAuthority();
    set({ polygonDrawingMode });
  },
  polygonVertices: [],
  addPolygonVertex: (vertex) => set((state) => ({
    polygonVertices: [...state.polygonVertices, vertex],
  })),
  undoLastVertex: () => set((state) => ({
    polygonVertices: state.polygonVertices.slice(0, -1),
  })),
  resetPolygonDrawing: () => {
    invalidateToolTailAuthority();
    set({ polygonDrawingMode: "idle", polygonVertices: [] });
  },

  setBucketFillActive: (active) => {
    invalidateToolTailAuthority();
    invalidateLatestToolOperation("bucketFill");
    set((state) => ({
      activeTool: transitionActiveTool(state, { type: "setBucketFill", active }),
      bucketFillPreview: null,
      bucketFillLoading: false,
      bucketFillError: null,
      bucketFillBarrierMode: false,
      bucketFillPendingPolygon: null,
      ...(active
        ? {
            mode: "move" as const,
            splitLineA: null,
            splitLineB: null,
            splitPreview: null,
            splitError: null,
            tempPanMode: false,
          }
        : { bucketFillBarriers: [] }),
    }));
  },
  bucketFillPreview: null,
  setBucketFillPreview: (bucketFillPreview) => set({ bucketFillPreview }),
  bucketFillLoading: false,
  setBucketFillLoading: (bucketFillLoading) => set({ bucketFillLoading }),
  bucketFillError: null,
  setBucketFillError: (bucketFillError) => set({ bucketFillError }),
  bucketFillTolerance: 30,
  setBucketFillTolerance: (bucketFillTolerance) => {
    invalidateToolTailAuthority();
    invalidateLatestToolOperation("bucketFill");
    set({ bucketFillTolerance, bucketFillLoading: false, bucketFillError: null });
  },
  bucketFillDilatePx: 3,
  setBucketFillDilatePx: (bucketFillDilatePx) => {
    invalidateToolTailAuthority();
    invalidateLatestToolOperation("bucketFill");
    set({ bucketFillDilatePx, bucketFillLoading: false, bucketFillError: null });
  },
  bucketFillResolution: 1000,
  setBucketFillResolution: (bucketFillResolution) => {
    invalidateToolTailAuthority();
    invalidateLatestToolOperation("bucketFill");
    set({ bucketFillResolution, bucketFillLoading: false, bucketFillError: null });
  },
  bucketFillPendingPolygon: null,
  setBucketFillPendingPolygon: (bucketFillPendingPolygon) => set({
    bucketFillPendingPolygon,
  }),

  setSplitAreaActive: (active) => {
    invalidateToolTailAuthority();
    set((state) => ({
      activeTool: transitionActiveTool(state, { type: "setSplit", active }),
      splitLineA: null,
      splitLineB: null,
      splitPreview: null,
      splitError: null,
      ...(active
        ? {
            mode: "move" as const,
            bucketFillPreview: null,
            bucketFillLoading: false,
            bucketFillError: null,
            bucketFillBarrierMode: false,
            bucketFillBarriers: [],
            activeTakeoffItemId: null,
          }
        : {}),
    }));
  },
  splitLineA: null,
  splitLineB: null,
  setSplitLineEndpoint: (which, point) => set(
    which === "a" ? { splitLineA: point } : { splitLineB: point },
  ),
  splitPreview: null,
  setSplitPreview: (splitPreview) => set({ splitPreview }),
  splitError: null,
  setSplitError: (splitError) => set({ splitError }),

  bucketFillBarriers: [],
  addBucketFillBarrier: (line) => {
    invalidateToolTailAuthority();
    invalidateLatestToolOperation("bucketFill");
    set((state) => ({
      bucketFillBarriers: [...state.bucketFillBarriers, line],
      bucketFillLoading: false,
      bucketFillError: null,
    }));
  },
  undoLastBarrier: () => {
    invalidateToolTailAuthority();
    invalidateLatestToolOperation("bucketFill");
    set((state) => ({
      bucketFillBarriers: state.bucketFillBarriers.slice(0, -1),
      bucketFillLoading: false,
      bucketFillError: null,
    }));
  },
  clearBucketFillBarriers: () => {
    invalidateToolTailAuthority();
    invalidateLatestToolOperation("bucketFill");
    set({ bucketFillBarriers: [], bucketFillLoading: false, bucketFillError: null });
  },
  bucketFillBarrierMode: false,
  setBucketFillBarrierMode: (bucketFillBarrierMode) => {
    invalidateToolTailAuthority();
    invalidateLatestToolOperation("bucketFill");
    set({
      bucketFillBarrierMode,
      barrierPendingPoint: null,
      bucketFillLoading: false,
      bucketFillError: null,
    });
  },
  barrierPendingPoint: null,
  setBarrierPendingPoint: (barrierPendingPoint) => {
    invalidateToolTailAuthority();
    invalidateLatestToolOperation("bucketFill");
    set({
      barrierPendingPoint,
      bucketFillLoading: false,
      bucketFillError: null,
    });
  },
  takeoffUndoStack: [],
  takeoffRedoStack: [],

  setYoloTagPickingMode: (active) => {
    invalidateToolTailAuthority();
    set((state) => active
      ? {
          ...modeDestination("pointer"),
          activeTool: transitionActiveTool(state, { type: "setTagPick", active: true }),
        }
      : {
          activeTool: transitionActiveTool(state, { type: "setTagPick", active: false }),
        });
  },
  tagScanResults: null,
  setTagScanResults: (tagScanResults) => set({ tagScanResults }),
  setTagAddingMode: (tagId) => {
    invalidateToolTailAuthority();
    set((state) => tagId !== null
      ? {
          ...modeDestination("pointer"),
          activeTool: transitionActiveTool(state, { type: "setTagAdd", tagId }),
        }
      : {
          activeTool: transitionActiveTool(state, { type: "setTagAdd", tagId: null }),
        });
  },

  setSymbolSearchActive: (active) => {
    invalidateToolTailAuthority();
    invalidateLatestToolOperation("symbolSession");
    set((state) => symbolSearchActiveDestination(state, active));
  },
  symbolSearchLoading: false,
  setSymbolSearchLoading: (symbolSearchLoading) => set({ symbolSearchLoading }),
  symbolSearchProgress: null,
  setSymbolSearchProgress: (symbolSearchProgress) => set({ symbolSearchProgress }),
  symbolSearchResults: null,
  setSymbolSearchResults: (symbolSearchResults) => set({ symbolSearchResults }),
  symbolSearchConfidence: 0.75,
  setSymbolSearchConfidence: (symbolSearchConfidence) => set({ symbolSearchConfidence }),
  dismissedSymbolMatches: new Set<string>(),
  dismissSymbolMatch: (matchId) => set((state) => {
    const dismissedSymbolMatches = new Set(state.dismissedSymbolMatches);
    dismissedSymbolMatches.add(matchId);
    return { dismissedSymbolMatches };
  }),
  symbolSearchError: null,
  setSymbolSearchError: (symbolSearchError) => set({ symbolSearchError }),
  symbolSearchTemplateBbox: null,
  setSymbolSearchTemplateBbox: (symbolSearchTemplateBbox) => set({
    symbolSearchTemplateBbox,
  }),
  symbolSearchSourcePage: null,
  setSymbolSearchSourcePage: (symbolSearchSourcePage) => set({ symbolSearchSourcePage }),
  symbolSearchConfig: {
    multiScale: true,
    useSiftFallback: true,
    searchPages: null,
    scaleMin: 0.8,
    scaleMax: 1.5,
    nmsThreshold: 0.3,
    maxMatchesPerPage: 50,
  },
  setSymbolSearchConfig: (patch) => set((state) => ({
    symbolSearchConfig: { ...state.symbolSearchConfig, ...patch },
  })),
  symbolSearchPreset: "lite",
  setSymbolSearchPreset: (symbolSearchPreset) => {
    const config = symbolSearchPreset === "power"
      ? { scaleMin: 0.5, scaleMax: 2, nmsThreshold: 0.2 }
      : { scaleMin: 0.8, scaleMax: 1.5, nmsThreshold: 0.3 };
    set((state) => ({
      symbolSearchPreset,
      symbolSearchConfig: { ...state.symbolSearchConfig, ...config },
    }));
  },
  clearSymbolSearch: () => {
    invalidateToolTailAuthority();
    invalidateLatestToolOperation("symbolSession");
    set((state) => ({
      activeTool: transitionActiveTool(state, { type: "setSymbolTemplate", active: false }),
      symbolSearchLoading: false,
      symbolSearchProgress: null,
      symbolSearchResults: null,
      symbolSearchConfidence: 0.75,
      dismissedSymbolMatches: new Set<string>(),
      symbolSearchError: null,
      symbolSearchTemplateBbox: null,
      symbolSearchSourcePage: null,
      symbolSearchConfig: {
        multiScale: true,
        useSiftFallback: true,
        searchPages: null,
        scaleMin: 0.8,
        scaleMax: 1.5,
        nmsThreshold: 0.3,
        maxMatchesPerPage: 50,
      },
    }));
  },

  resetProjectToolState: () => {
    invalidateToolTailAuthority();
    invalidateLatestToolOperation("bucketFill");
    invalidateLatestToolOperation("symbolSession");
    set((state) => ({
      tempPanMode: false,
      activeTool: activeToolAfterProjectReset(state.activeTool),
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
      dismissedSymbolMatches: new Set<string>(),
      symbolSearchError: null,
      symbolSearchTemplateBbox: null,
      symbolSearchSourcePage: null,
      symbolSearchConfig: {
        multiScale: true,
        useSiftFallback: true,
        searchPages: null,
        scaleMin: 0.8,
        scaleMax: 1.5,
        nmsThreshold: 0.3,
        maxMatchesPerPage: 50,
      },
      symbolSearchPreset: "lite",
    }));
  },
}));

/** One complete user Stop destination; a synchronous subscriber can only publish after it. */
export function stopTakeoffPlacement(): void {
  invalidateToolTailAuthority();
  useToolStore.setState({
    ...modeDestination("move"),
    takeoffUndoStack: [],
    takeoffRedoStack: [],
  });
}

/** One user-owned redraw/new-template publication; reentrant Symbol B necessarily lands after A. */
export function renewSymbolSearchTemplate(clearError = false): void {
  invalidateToolTailAuthority();
  invalidateLatestToolOperation("symbolSession");
  useToolStore.setState((state) => ({
    ...symbolSearchActiveDestination(state, true),
    symbolSearchLoading: false,
    symbolSearchProgress: null,
    symbolSearchResults: null,
    symbolSearchTemplateBbox: null,
    ...(clearError ? { symbolSearchError: null } : {}),
  }));
}

/**
 * Legacy async tool settlements may still publish their historical destination, but they are not
 * a new user gesture and therefore must not revoke a parse admitted after their request began.
 * Callers must invalidate synchronously at the initiating gesture. These narrow helpers preserve
 * that ordering without giving passive network callbacks ownership of the global parse tool tail.
 */
export function publishSettledToolMode(mode: ToolStoreData["mode"]): void {
  useToolStore.setState(modeDestination(mode));
}

export function publishSettledActiveTakeoffItemId(
  activeTakeoffItemId: number | null,
): void {
  useToolStore.setState((state) => activeTakeoffDestination(state, activeTakeoffItemId));
}

export function reconcileSettledDeletedTakeoffItem(deletedItemId: number): boolean {
  let reconciled = false;
  useToolStore.setState((state) => {
    if (state.activeTakeoffItemId !== deletedItemId) return state;
    reconciled = true;
    return activeTakeoffDestination(state, null);
  });
  return reconciled;
}

export type CalibrationActivation = Extract<ActiveToolObject, { kind: "calibration" }>;

/**
 * One calibration click advances its exact activation, point, and phase atomically. A synchronous
 * Tool B admitted by this publication therefore lands after A and cannot be reactivated by a
 * second stale phase write.
 */
export function advanceCalibrationGesture(
  expectedActivation: CalibrationActivation,
  expectedMode: "point1" | "point2",
  which: "p1" | "p2",
  point: { x: number; y: number },
  nextMode: "point2" | "input",
): boolean {
  invalidateToolTailAuthority();
  let advanced = false;
  useToolStore.setState((state) => {
    if (
      state.activeTool !== expectedActivation ||
      state.calibrationMode !== expectedMode
    ) return state;
    advanced = true;
    return {
      mode: "move",
      calibrationMode: nextMode,
      calibrationPoints: { ...state.calibrationPoints, [which]: point },
      activeTool: transitionActiveTool(state, {
        type: "setCalibrationMode",
        mode: nextMode,
      }),
    };
  });
  return advanced;
}

export function publishSettledCalibrationReset(
  expectedActivation: CalibrationActivation,
): boolean {
  let reset = false;
  useToolStore.setState((state) => {
    if (state.activeTool !== expectedActivation) return state;
    reset = true;
    return {
      calibrationMode: "idle",
      calibrationPoints: {},
      activeTool: releaseActiveToolExact(
        state.activeTool,
        expectedActivation,
        state.activeTakeoffItemId,
      ),
    };
  });
  return reset;
}

export function publishSettledPolygonReset(): void {
  useToolStore.setState({ polygonDrawingMode: "idle", polygonVertices: [] });
}

export type SymbolTemplateActivation = Extract<ActiveToolObject, { kind: "symbolTemplate" }>;

export function publishSettledSymbolSearchDeactivate(
  expectedActivation: SymbolTemplateActivation,
): boolean {
  let deactivated = false;
  useToolStore.setState((state) => {
    if (state.activeTool !== expectedActivation) return state;
    deactivated = true;
    return {
      activeTool: releaseActiveToolExact(
        state.activeTool,
        expectedActivation,
        state.activeTakeoffItemId,
      ),
    };
  });
  return deactivated;
}

export function publishSettledSymbolSearchCleanup(
  expectedActivation: SymbolTemplateActivation | null,
): boolean {
  let deactivated = false;
  useToolStore.setState((state) => {
    deactivated = expectedActivation !== null && state.activeTool === expectedActivation;
    return {
      activeTool: expectedActivation === null
        ? state.activeTool
        : releaseActiveToolExact(
            state.activeTool,
            expectedActivation,
            state.activeTakeoffItemId,
          ),
      symbolSearchResults: null,
      symbolSearchTemplateBbox: null,
    };
  });
  return deactivated;
}

/** Exact legacy 23-member grouped selector; narrowing is a later measured cleanup. */
export const useSymbolSearch = () => useToolStore(useShallow((state) => ({
  symbolSearchActive: state.activeTool?.kind === "symbolTemplate",
  setSymbolSearchActive: state.setSymbolSearchActive,
  symbolSearchLoading: state.symbolSearchLoading,
  setSymbolSearchLoading: state.setSymbolSearchLoading,
  symbolSearchProgress: state.symbolSearchProgress,
  setSymbolSearchProgress: state.setSymbolSearchProgress,
  symbolSearchResults: state.symbolSearchResults,
  setSymbolSearchResults: state.setSymbolSearchResults,
  symbolSearchConfidence: state.symbolSearchConfidence,
  setSymbolSearchConfidence: state.setSymbolSearchConfidence,
  symbolSearchError: state.symbolSearchError,
  setSymbolSearchError: state.setSymbolSearchError,
  symbolSearchTemplateBbox: state.symbolSearchTemplateBbox,
  setSymbolSearchTemplateBbox: state.setSymbolSearchTemplateBbox,
  symbolSearchSourcePage: state.symbolSearchSourcePage,
  setSymbolSearchSourcePage: state.setSymbolSearchSourcePage,
  dismissedSymbolMatches: state.dismissedSymbolMatches,
  dismissSymbolMatch: state.dismissSymbolMatch,
  clearSymbolSearch: state.clearSymbolSearch,
  symbolSearchConfig: state.symbolSearchConfig,
  setSymbolSearchConfig: state.setSymbolSearchConfig,
  symbolSearchPreset: state.symbolSearchPreset,
  setSymbolSearchPreset: state.setSymbolSearchPreset,
})));
