import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

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

  activeTakeoffItemId: number | null;
  scaleCalibrations: Record<number, ScaleCalibrationData>;
  calibrationMode: "idle" | "point1" | "point2" | "input";
  calibrationPoints: { p1?: { x: number; y: number }; p2?: { x: number; y: number } };
  polygonDrawingMode: "idle" | "drawing";
  polygonVertices: { x: number; y: number }[];

  bucketFillActive: boolean;
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

  splitAreaActive: boolean;
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

  yoloTagPickingMode: boolean;
  tagScanResults: ToolTagScanResults | null;
  tagAddingMode: string | null;

  symbolSearchActive: boolean;
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

  /** Preserve the legacy 22-touched/18-retained project-switch policy until P2.5. */
  resetProjectToolState: () => void;
}

export type ToolStoreState = ToolStoreData & ToolStoreActions;

export const useToolStore = create<ToolStoreState>((set) => ({
  mode: "move",
  setMode: (mode) => set({
    mode,
    activeTakeoffItemId: null,
    polygonDrawingMode: "idle",
    polygonVertices: [],
    bucketFillActive: false,
    bucketFillPreview: null,
    bucketFillLoading: false,
    bucketFillBarriers: [],
    bucketFillBarrierMode: false,
    splitAreaActive: false,
    splitLineA: null,
    splitLineB: null,
    splitPreview: null,
    splitError: null,
    symbolSearchActive: false,
    tempPanMode: false,
  }),
  tempPanMode: false,
  setTempPanMode: (tempPanMode) => set({ tempPanMode }),

  activeTakeoffItemId: null,
  setActiveTakeoffItemId: (activeTakeoffItemId) => set({
    activeTakeoffItemId,
    takeoffUndoStack: [],
    takeoffRedoStack: [],
  }),

  scaleCalibrations: {},
  setScaleCalibration: (pageNum, calibration) => set((state) => ({
    scaleCalibrations: { ...state.scaleCalibrations, [pageNum]: calibration },
  })),
  calibrationMode: "idle",
  setCalibrationMode: (calibrationMode) => set({ calibrationMode }),
  calibrationPoints: {},
  setCalibrationPoint: (which, point) => set((state) => ({
    calibrationPoints: { ...state.calibrationPoints, [which]: point },
  })),
  resetCalibration: () => set({ calibrationMode: "idle", calibrationPoints: {} }),

  polygonDrawingMode: "idle",
  setPolygonDrawingMode: (polygonDrawingMode) => set({ polygonDrawingMode }),
  polygonVertices: [],
  addPolygonVertex: (vertex) => set((state) => ({
    polygonVertices: [...state.polygonVertices, vertex],
  })),
  undoLastVertex: () => set((state) => ({
    polygonVertices: state.polygonVertices.slice(0, -1),
  })),
  resetPolygonDrawing: () => set({ polygonDrawingMode: "idle", polygonVertices: [] }),

  bucketFillActive: false,
  setBucketFillActive: (bucketFillActive) => set({
    bucketFillActive,
    bucketFillPreview: null,
    bucketFillLoading: false,
    bucketFillError: null,
    bucketFillBarrierMode: false,
    bucketFillPendingPolygon: null,
    ...(bucketFillActive
      ? {
          mode: "move" as const,
          splitAreaActive: false,
          splitLineA: null,
          splitLineB: null,
          splitPreview: null,
          splitError: null,
          symbolSearchActive: false,
          tempPanMode: false,
        }
      : { bucketFillBarriers: [] }),
  }),
  bucketFillPreview: null,
  setBucketFillPreview: (bucketFillPreview) => set({ bucketFillPreview }),
  bucketFillLoading: false,
  setBucketFillLoading: (bucketFillLoading) => set({ bucketFillLoading }),
  bucketFillError: null,
  setBucketFillError: (bucketFillError) => set({ bucketFillError }),
  bucketFillTolerance: 30,
  setBucketFillTolerance: (bucketFillTolerance) => set({ bucketFillTolerance }),
  bucketFillDilatePx: 3,
  setBucketFillDilatePx: (bucketFillDilatePx) => set({ bucketFillDilatePx }),
  bucketFillResolution: 1000,
  setBucketFillResolution: (bucketFillResolution) => set({ bucketFillResolution }),
  bucketFillPendingPolygon: null,
  setBucketFillPendingPolygon: (bucketFillPendingPolygon) => set({
    bucketFillPendingPolygon,
  }),

  splitAreaActive: false,
  setSplitAreaActive: (splitAreaActive) => set({
    splitAreaActive,
    splitLineA: null,
    splitLineB: null,
    splitPreview: null,
    splitError: null,
    ...(splitAreaActive
      ? {
          mode: "move" as const,
          bucketFillActive: false,
          bucketFillPreview: null,
          bucketFillLoading: false,
          bucketFillError: null,
          bucketFillBarrierMode: false,
          bucketFillBarriers: [],
          symbolSearchActive: false,
          activeTakeoffItemId: null,
        }
      : {}),
  }),
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
  addBucketFillBarrier: (line) => set((state) => ({
    bucketFillBarriers: [...state.bucketFillBarriers, line],
  })),
  undoLastBarrier: () => set((state) => ({
    bucketFillBarriers: state.bucketFillBarriers.slice(0, -1),
  })),
  clearBucketFillBarriers: () => set({ bucketFillBarriers: [] }),
  bucketFillBarrierMode: false,
  setBucketFillBarrierMode: (bucketFillBarrierMode) => set({
    bucketFillBarrierMode,
    barrierPendingPoint: null,
  }),
  barrierPendingPoint: null,
  setBarrierPendingPoint: (barrierPendingPoint) => set({ barrierPendingPoint }),
  takeoffUndoStack: [],
  takeoffRedoStack: [],

  yoloTagPickingMode: false,
  setYoloTagPickingMode: (yoloTagPickingMode) => set({ yoloTagPickingMode }),
  tagScanResults: null,
  setTagScanResults: (tagScanResults) => set({ tagScanResults }),
  tagAddingMode: null,
  setTagAddingMode: (tagAddingMode) => set({ tagAddingMode }),

  symbolSearchActive: false,
  setSymbolSearchActive: (symbolSearchActive) => set(
    symbolSearchActive
      ? {
          symbolSearchActive,
          mode: "move" as const,
          bucketFillActive: false,
          bucketFillPreview: null,
          bucketFillLoading: false,
          bucketFillBarrierMode: false,
          splitAreaActive: false,
          splitLineA: null,
          splitLineB: null,
          splitPreview: null,
          splitError: null,
        }
      : { symbolSearchActive },
  ),
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
  clearSymbolSearch: () => set({
    symbolSearchActive: false,
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
  }),

  resetProjectToolState: () => set({
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
  }),
}));

/** Exact legacy 23-member grouped selector; narrowing is a later measured cleanup. */
export const useSymbolSearch = () => useToolStore(useShallow((state) => ({
  symbolSearchActive: state.symbolSearchActive,
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
