import { create } from "zustand";
import type {
  ClientAnnotation,
  ClientTakeoffItem,
  KeynoteData,
  CsiCode,
  TextractPageData,
  SearchWordMatch,
  ChatMsg,
  TakeoffTab,
  ScaleCalibrationData,
} from "@/types";

interface ViewerState {
  // ─── Page navigation ─────────────────────────────────────
  pageNumber: number;
  numPages: number;
  setPage: (n: number) => void;
  setNumPages: (n: number) => void;

  // ─── Zoom ────────────────────────────────────────────────
  scale: number;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomFit: () => void;
  setScale: (s: number) => void;

  // ─── Mode ────────────────────────────────────────────────
  mode: "move" | "pointer" | "markup" | "moveMarkup";
  setMode: (m: "move" | "pointer" | "markup" | "moveMarkup") => void;

  // ─── Search ──────────────────────────────────────────────
  searchQuery: string;
  searchResults: number[];
  searchMatches: Record<number, SearchWordMatch[]>;
  searchLoading: boolean;
  setSearch: (q: string) => void;
  setSearchResults: (pages: number[]) => void;
  setSearchMatches: (matches: Record<number, SearchWordMatch[]>) => void;
  setSearchLoading: (loading: boolean) => void;

  // ─── Annotations ─────────────────────────────────────────
  annotations: ClientAnnotation[];
  setAnnotations: (a: ClientAnnotation[]) => void;
  addAnnotation: (a: ClientAnnotation) => void;
  removeAnnotation: (id: number) => void;
  updateAnnotation: (id: number, updates: Partial<ClientAnnotation>) => void;

  // ─── Page data ───────────────────────────────────────────
  pageNames: Record<number, string>;
  setPageNames: (names: Record<number, string>) => void;
  setPageName: (pageNum: number, name: string) => void;

  // ─── Project data ────────────────────────────────────────
  projectId: number;
  setProjectId: (id: number) => void;
  dataUrl: string;
  setDataUrl: (url: string) => void;
  publicId: string;
  setPublicId: (id: string) => void;
  isDemo: boolean;
  setIsDemo: (v: boolean) => void;

  // ─── Textract data per page ──────────────────────────────
  textractData: Record<number, TextractPageData>;
  setTextractData: (pageNum: number, data: TextractPageData) => void;

  // ─── Keynotes per page ───────────────────────────────────
  keynotes: Record<number, KeynoteData[]>;
  setKeynotes: (pageNum: number, data: KeynoteData[]) => void;

  // ─── CSI codes per page ──────────────────────────────────
  csiCodes: Record<number, CsiCode[]>;
  setCsiCodes: (pageNum: number, codes: CsiCode[]) => void;
  allTrades: string[];
  setAllTrades: (trades: string[]) => void;

  // ─── Panels ──────────────────────────────────────────────
  showTextPanel: boolean;
  toggleTextPanel: () => void;
  showChatPanel: boolean;
  toggleChatPanel: () => void;

  // ─── Chat ────────────────────────────────────────────────
  chatMessages: ChatMsg[];
  addChatMessage: (msg: ChatMsg) => void;
  setChatMessages: (msgs: ChatMsg[]) => void;
  chatScope: "page" | "project";
  setChatScope: (scope: "page" | "project") => void;

  // ─── Detections ──────────────────────────────────────────
  showDetections: boolean;
  toggleDetections: () => void;
  activeModels: Record<string, boolean>;
  setModelActive: (model: string, active: boolean) => void;
  confidenceThreshold: number;
  setConfidenceThreshold: (t: number) => void;
  confidenceThresholds: Record<string, number>;
  setModelConfidence: (model: string, threshold: number) => void;
  initDetectionModels: (modelNames: string[]) => void;

  // ─── Keynotes ───────────────────────────────────────────
  showKeynotes: boolean;
  toggleKeynotes: () => void;
  activeKeynoteFilter: { shape: string; text: string } | null;
  setKeynoteFilter: (filter: { shape: string; text: string } | null) => void;

  // ─── Annotation filter ─────────────────────────────────
  activeAnnotationFilter: string | null;
  setAnnotationFilter: (label: string | null) => void;

  // ─── Trade filter ─────────────────────────────────────────
  activeTradeFilter: string | null;
  setTradeFilter: (trade: string | null) => void;

  // ─── CSI code filter ───────────────────────────────────────
  activeCsiFilter: string | null;
  setCsiFilter: (code: string | null) => void;
  allCsiCodes: { code: string; description: string }[];
  setAllCsiCodes: (codes: { code: string; description: string }[]) => void;

  // ─── Takeoff ────────────────────────────────────────────
  showTakeoffPanel: boolean;
  toggleTakeoffPanel: () => void;
  takeoffItems: ClientTakeoffItem[];
  setTakeoffItems: (items: ClientTakeoffItem[]) => void;
  addTakeoffItem: (item: ClientTakeoffItem) => void;
  removeTakeoffItem: (id: number) => void;
  updateTakeoffItem: (id: number, updates: Partial<ClientTakeoffItem>) => void;
  activeTakeoffItemId: number | null;
  setActiveTakeoffItemId: (id: number | null) => void;

  // ─── Takeoff Area ──────────────────────────────────────
  takeoffTab: TakeoffTab;
  setTakeoffTab: (tab: TakeoffTab) => void;
  pageDimensions: Record<number, { width: number; height: number }>;
  setPageDimensions: (pageNum: number, width: number, height: number) => void;
  scaleCalibrations: Record<number, ScaleCalibrationData>;
  setScaleCalibration: (pageNum: number, cal: ScaleCalibrationData) => void;
  calibrationMode: "idle" | "point1" | "point2" | "input";
  setCalibrationMode: (mode: "idle" | "point1" | "point2" | "input") => void;
  calibrationPoints: { p1?: { x: number; y: number }; p2?: { x: number; y: number } };
  setCalibrationPoint: (which: "p1" | "p2", point: { x: number; y: number }) => void;
  resetCalibration: () => void;
  polygonDrawingMode: "idle" | "drawing";
  setPolygonDrawingMode: (mode: "idle" | "drawing") => void;
  polygonVertices: { x: number; y: number }[];
  addPolygonVertex: (v: { x: number; y: number }) => void;
  undoLastVertex: () => void;
  resetPolygonDrawing: () => void;

  // ─── Reset ─────────────────────────────────────────────
  resetProjectData: () => void;
}

export const useViewerStore = create<ViewerState>((set) => ({
  pageNumber: 1,
  numPages: 0,
  setPage: (n) =>
    set((s) => ({ pageNumber: Math.max(1, Math.min(n, s.numPages || 1)) })),
  setNumPages: (n) => set({ numPages: n }),

  scale: 1,
  zoomIn: () => set((s) => ({ scale: Math.min(s.scale * (1 / 0.95), 10) })),
  zoomOut: () => set((s) => ({ scale: Math.max(s.scale * 0.95, 0.2) })),
  zoomFit: () => set({ scale: 1 }),
  setScale: (scale) => set({ scale }),

  mode: "move",
  setMode: (mode) => set({ mode }),

  searchQuery: "",
  searchResults: [],
  searchMatches: {},
  searchLoading: false,
  setSearch: (searchQuery) => set({ searchQuery }),
  setSearchResults: (searchResults) => set({ searchResults }),
  setSearchMatches: (searchMatches) => set({ searchMatches }),
  setSearchLoading: (searchLoading) => set({ searchLoading }),

  annotations: [],
  setAnnotations: (annotations) => set({ annotations }),
  addAnnotation: (a) => set((s) => ({ annotations: [...s.annotations, a] })),
  removeAnnotation: (id) =>
    set((s) => ({ annotations: s.annotations.filter((a) => a.id !== id) })),
  updateAnnotation: (id, updates) =>
    set((s) => ({
      annotations: s.annotations.map((a) =>
        a.id === id ? { ...a, ...updates } : a
      ),
    })),

  pageNames: {},
  setPageNames: (pageNames) => set({ pageNames }),
  setPageName: (pageNum, name) =>
    set((s) => ({ pageNames: { ...s.pageNames, [pageNum]: name } })),

  projectId: 0,
  setProjectId: (projectId) => set({ projectId }),
  dataUrl: "",
  setDataUrl: (dataUrl) => set({ dataUrl }),
  publicId: "",
  setPublicId: (publicId) => set({ publicId }),
  isDemo: false,
  setIsDemo: (isDemo) => set({ isDemo }),

  textractData: {},
  setTextractData: (pageNum, data) =>
    set((s) => ({ textractData: { ...s.textractData, [pageNum]: data } })),

  keynotes: {},
  setKeynotes: (pageNum, data) =>
    set((s) => ({ keynotes: { ...s.keynotes, [pageNum]: data } })),

  csiCodes: {},
  setCsiCodes: (pageNum, codes) =>
    set((s) => ({ csiCodes: { ...s.csiCodes, [pageNum]: codes } })),
  allTrades: [],
  setAllTrades: (allTrades) => set({ allTrades }),

  showTextPanel: false,
  toggleTextPanel: () => set((s) => ({ showTextPanel: !s.showTextPanel })),
  showChatPanel: false,
  toggleChatPanel: () => set((s) => ({ showChatPanel: !s.showChatPanel })),

  chatMessages: [],
  addChatMessage: (msg) =>
    set((s) => ({ chatMessages: [...s.chatMessages, msg] })),
  setChatMessages: (chatMessages) => set({ chatMessages }),
  chatScope: "page",
  setChatScope: (chatScope) => set({ chatScope }),

  showDetections: false,
  toggleDetections: () =>
    set((s) => ({ showDetections: !s.showDetections })),
  activeModels: {},
  setModelActive: (model, active) =>
    set((s) => ({ activeModels: { ...s.activeModels, [model]: active } })),
  confidenceThreshold: 0.25,
  setConfidenceThreshold: (confidenceThreshold) =>
    set({ confidenceThreshold }),
  confidenceThresholds: {},
  setModelConfidence: (model, threshold) =>
    set((s) => ({ confidenceThresholds: { ...s.confidenceThresholds, [model]: threshold } })),
  initDetectionModels: (modelNames) =>
    set((s) => {
      const activeModels: Record<string, boolean> = {};
      const confidenceThresholds: Record<string, number> = {};
      for (const name of modelNames) {
        activeModels[name] = s.activeModels[name] ?? true;
        confidenceThresholds[name] = s.confidenceThresholds[name] ?? 0.25;
      }
      return { activeModels, confidenceThresholds };
    }),

  showKeynotes: true,
  toggleKeynotes: () => set((s) => ({ showKeynotes: !s.showKeynotes })),
  activeKeynoteFilter: null,
  setKeynoteFilter: (activeKeynoteFilter) => set({ activeKeynoteFilter }),

  activeAnnotationFilter: null,
  setAnnotationFilter: (activeAnnotationFilter) => set({ activeAnnotationFilter }),

  activeTradeFilter: null,
  setTradeFilter: (activeTradeFilter) => set({ activeTradeFilter }),

  activeCsiFilter: null,
  setCsiFilter: (activeCsiFilter) => set({ activeCsiFilter }),
  allCsiCodes: [],
  setAllCsiCodes: (allCsiCodes) => set({ allCsiCodes }),

  showTakeoffPanel: false,
  toggleTakeoffPanel: () =>
    set((s) => ({
      showTakeoffPanel: !s.showTakeoffPanel,
      // Clear active item when closing panel
      ...(s.showTakeoffPanel ? { activeTakeoffItemId: null } : {}),
      ...(s.showChatPanel && !s.showTakeoffPanel ? { showChatPanel: false } : {}),
    })),
  takeoffItems: [],
  setTakeoffItems: (takeoffItems) => set({ takeoffItems }),
  addTakeoffItem: (item) =>
    set((s) => ({ takeoffItems: [...s.takeoffItems, item] })),
  removeTakeoffItem: (id) =>
    set((s) => ({ takeoffItems: s.takeoffItems.filter((t) => t.id !== id) })),
  updateTakeoffItem: (id, updates) =>
    set((s) => ({
      takeoffItems: s.takeoffItems.map((t) =>
        t.id === id ? { ...t, ...updates } : t
      ),
    })),
  activeTakeoffItemId: null,
  setActiveTakeoffItemId: (activeTakeoffItemId) => set({ activeTakeoffItemId }),

  takeoffTab: "count",
  setTakeoffTab: (takeoffTab) => set({ takeoffTab }),
  pageDimensions: {},
  setPageDimensions: (pageNum, width, height) =>
    set((s) => ({ pageDimensions: { ...s.pageDimensions, [pageNum]: { width, height } } })),
  scaleCalibrations: {},
  setScaleCalibration: (pageNum, cal) =>
    set((s) => ({ scaleCalibrations: { ...s.scaleCalibrations, [pageNum]: cal } })),
  calibrationMode: "idle",
  setCalibrationMode: (calibrationMode) => set({ calibrationMode }),
  calibrationPoints: {},
  setCalibrationPoint: (which, point) =>
    set((s) => ({ calibrationPoints: { ...s.calibrationPoints, [which]: point } })),
  resetCalibration: () =>
    set({ calibrationMode: "idle", calibrationPoints: {} }),
  polygonDrawingMode: "idle",
  setPolygonDrawingMode: (polygonDrawingMode) => set({ polygonDrawingMode }),
  polygonVertices: [],
  addPolygonVertex: (v) =>
    set((s) => ({ polygonVertices: [...s.polygonVertices, v] })),
  undoLastVertex: () =>
    set((s) => ({ polygonVertices: s.polygonVertices.slice(0, -1) })),
  resetPolygonDrawing: () =>
    set({ polygonDrawingMode: "idle", polygonVertices: [] }),

  resetProjectData: () =>
    set({
      pageNumber: 1,
      numPages: 0,
      scale: 1,
      searchQuery: "",
      searchResults: [],
      searchMatches: {},
      searchLoading: false,
      annotations: [],
      pageNames: {},
      projectId: 0,
      dataUrl: "",
      publicId: "",
      isDemo: false,
      textractData: {},
      keynotes: {},
      csiCodes: {},
      allTrades: [],
      chatMessages: [],
      chatScope: "page",
      activeKeynoteFilter: null,
      activeAnnotationFilter: null,
      activeTradeFilter: null,
      activeCsiFilter: null,
      allCsiCodes: [],
      showDetections: false,
      confidenceThreshold: 0.25,
      activeModels: {},
      confidenceThresholds: {},
      showTakeoffPanel: false,
      takeoffItems: [],
      activeTakeoffItemId: null,
      takeoffTab: "count",
      pageDimensions: {},
      scaleCalibrations: {},
      calibrationMode: "idle",
      calibrationPoints: {},
      polygonDrawingMode: "idle",
      polygonVertices: [],
    }),
}));
