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
  TextAnnotation,
  TextAnnotationResult,
  YoloTag,
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
  pendingCenter: boolean;
  clearPendingCenter: () => void;
  setScale: (s: number) => void;

  // ─── Mode ────────────────────────────────────────────────
  mode: "move" | "pointer" | "markup";
  setMode: (m: "move" | "pointer" | "markup") => void;

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
  projectIntelligenceData: any;
  setProjectIntelligenceData: (data: any) => void;
  showLabelingWizard: boolean;
  setShowLabelingWizard: (v: boolean) => void;
  labelingWizardStep: number;
  setLabelingWizardStep: (step: number) => void;
  labelingSessions: Array<{ labelStudioUrl: string; pageRange: string; taskCount: number }>;
  setLabelingSessions: (sessions: Array<{ labelStudioUrl: string; pageRange: string; taskCount: number }>) => void;
  labelingCredentials: { email: string; password: string } | null;
  setLabelingCredentials: (creds: { email: string; password: string } | null) => void;

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

  // ─── Text annotations ──────────────────────────────────────
  textAnnotations: Record<number, TextAnnotation[]>;
  setTextAnnotations: (pageNum: number, data: TextAnnotation[]) => void;
  showTextAnnotations: boolean; // global nuke toggle
  toggleTextAnnotations: () => void;
  activeTextAnnotationTypes: Record<string, boolean>;
  setTextAnnotationType: (type: string, active: boolean) => void;
  setAllTextAnnotationTypes: (active: boolean) => void;
  hiddenTextAnnotations: Set<string>; // "pageNum:index" keys for individually hidden
  toggleTextAnnotationVisibility: (pageNum: number, index: number) => void;
  textAnnotationColors: Record<string, string>;
  setTextAnnotationColor: (type: string, color: string) => void;
  activeTextAnnotationFilter: { type: string; text: string } | null;
  setTextAnnotationFilter: (filter: { type: string; text: string } | null) => void;
  activeTakeoffFilter: number | null; // takeoff item ID to filter sidebar by
  setTakeoffFilter: (id: number | null) => void;
  textPanelTab: "ocr" | "annotations" | "graph" | "markups";
  setTextPanelTab: (tab: "ocr" | "annotations" | "graph" | "markups") => void;
  activeMarkupId: number | null;
  setActiveMarkupId: (id: number | null) => void;

  // ─── Panels ──────────────────────────────────────────────
  showTextPanel: boolean;
  toggleTextPanel: () => void;
  showChatPanel: boolean;
  toggleChatPanel: () => void;

  // ─── Chat ────────────────────────────────────────────────
  chatMessages: ChatMsg[];
  addChatMessage: (msg: ChatMsg) => void;
  setChatMessages: (msgs: ChatMsg[]) => void;
  clearChatMessages: () => void;
  chatScope: "page" | "project";
  setChatScope: (scope: "page" | "project") => void;

  // ─── Detections ──────────────────────────────────────────
  showDetections: boolean;          // overlay visibility (stays on when panel closed)
  toggleDetections: () => void;
  showDetectionPanel: boolean;      // sidebar panel visibility
  toggleDetectionPanel: () => void;
  activeModels: Record<string, boolean>;
  setModelActive: (model: string, active: boolean) => void;
  confidenceThreshold: number;
  setConfidenceThreshold: (t: number) => void;
  confidenceThresholds: Record<string, number>;
  setModelConfidence: (model: string, threshold: number) => void;
  initDetectionModels: (modelNames: string[]) => void;

  // ─── Help tips ─────────────────────────────────────────
  showTips: boolean;
  toggleTips: () => void;
  helpMode: boolean;
  toggleHelpMode: () => void;

  // ─── Panel collapse ────────────────────────────────────
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  annotationPanelCollapsed: boolean;
  toggleAnnotationPanel: () => void;

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
  showCsiPanel: boolean;
  toggleCsiPanel: () => void;

  // ─── Page Intelligence ─────────────────────────────────
  showPageIntelPanel: boolean;
  togglePageIntelPanel: () => void;
  pageIntelligence: Record<number, any>;
  setPageIntelligence: (pageNum: number, data: any) => void;

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

  // ─── Table Parse ───────────────────────────────────────
  showTableParsePanel: boolean;
  toggleTableParsePanel: () => void;
  tableParseStep: "idle" | "select-region" | "define-column" | "define-row" | "review";
  setTableParseStep: (step: "idle" | "select-region" | "define-column" | "define-row" | "review") => void;
  tableParseRegion: [number, number, number, number] | null; // [minX, minY, maxX, maxY] normalized
  setTableParseRegion: (bbox: [number, number, number, number] | null) => void;
  tableParsedGrid: { headers: string[]; rows: Record<string, string>[]; tagColumn?: string; tableName?: string; csiTags?: { code: string; description: string }[] } | null;
  setTableParsedGrid: (grid: { headers: string[]; rows: Record<string, string>[]; tagColumn?: string; tableName?: string; csiTags?: { code: string; description: string }[] } | null) => void;
  tableParseColumnBBs: [number, number, number, number][]; // user-drawn column BBs
  addTableParseColumnBB: (bb: [number, number, number, number]) => void;
  tableParseColumnNames: string[]; // user-defined names for each column
  setTableParseColumnNames: (names: string[]) => void;
  tableParseRowBBs: [number, number, number, number][]; // user-drawn row BBs
  addTableParseRowBB: (bb: [number, number, number, number]) => void;
  resetTableParse: () => void;
  tableParseTab: "all" | "auto" | "manual" | "compare";
  setTableParseTab: (tab: "all" | "auto" | "manual" | "compare") => void;
  showTableCompareModal: boolean;
  toggleTableCompareModal: () => void;

  // ─── Keynote Parse ────────────────────────────────────
  showKeynoteParsePanel: boolean;
  toggleKeynoteParsePanel: () => void;
  keynoteParseTab: "all" | "auto" | "manual";
  setKeynoteParseTab: (tab: "all" | "auto" | "manual") => void;
  keynoteParseStep: "idle" | "select-region" | "define-column" | "define-row" | "review";
  setKeynoteParseStep: (step: "idle" | "select-region" | "define-column" | "define-row" | "review") => void;
  keynoteParseRegion: [number, number, number, number] | null;
  setKeynoteParseRegion: (bbox: [number, number, number, number] | null) => void;
  keynoteColumnBBs: [number, number, number, number][];
  addKeynoteColumnBB: (bb: [number, number, number, number]) => void;
  keynoteRowBBs: [number, number, number, number][];
  addKeynoteRowBB: (bb: [number, number, number, number]) => void;
  keynoteYoloClass: { model: string; className: string } | null;
  setKeynoteYoloClass: (cls: { model: string; className: string } | null) => void;
  parsedKeynoteData: { pageNumber: number; keys: { key: string; description: string }[]; yoloClass?: string; tableName?: string }[] | null;
  setParsedKeynoteData: (data: { pageNumber: number; keys: { key: string; description: string }[]; yoloClass?: string; tableName?: string }[] | null) => void;
  addParsedKeynote: (entry: { pageNumber: number; keys: { key: string; description: string }[]; yoloClass?: string; tableName?: string }) => void;
  activeKeynoteHighlight: { pageNumber: number; key: string } | null;
  setActiveKeynoteHighlight: (h: { pageNumber: number; key: string } | null) => void;
  resetKeynoteParse: () => void;

  // ─── YOLO Tags ─────────────────────────────────────────
  yoloTags: YoloTag[];
  setYoloTags: (tags: YoloTag[]) => void;
  addYoloTag: (tag: YoloTag) => void;
  removeYoloTag: (id: string) => void;
  updateYoloTag: (id: string, updates: Partial<YoloTag>) => void;
  activeYoloTagId: string | null;
  setActiveYoloTagId: (id: string | null) => void;
  yoloTagVisibility: Record<string, boolean>;
  setYoloTagVisibility: (id: string, visible: boolean) => void;
  activeYoloTagFilter: string | null;
  setYoloTagFilter: (id: string | null) => void;
  yoloTagPickingMode: boolean;
  setYoloTagPickingMode: (v: boolean) => void;

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
  zoomFit: () => set({ scale: 1, pendingCenter: true }),
  pendingCenter: false,
  clearPendingCenter: () => set({ pendingCenter: false }),
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
  projectIntelligenceData: null,
  setProjectIntelligenceData: (data) => set({ projectIntelligenceData: data }),
  showLabelingWizard: false,
  setShowLabelingWizard: (showLabelingWizard) => set({ showLabelingWizard }),
  labelingWizardStep: 1,
  setLabelingWizardStep: (labelingWizardStep) => set({ labelingWizardStep }),
  labelingSessions: [],
  setLabelingSessions: (labelingSessions) => set({ labelingSessions }),
  labelingCredentials: null,
  setLabelingCredentials: (labelingCredentials) => set({ labelingCredentials }),

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

  textAnnotations: {},
  setTextAnnotations: (pageNum, data) =>
    set((s) => ({ textAnnotations: { ...s.textAnnotations, [pageNum]: data } })),
  showTextAnnotations: false,
  toggleTextAnnotations: () => set((s) => ({ showTextAnnotations: !s.showTextAnnotations })),
  activeTextAnnotationTypes: {},
  setTextAnnotationType: (type, active) =>
    set((s) => ({ activeTextAnnotationTypes: { ...s.activeTextAnnotationTypes, [type]: active } })),
  setAllTextAnnotationTypes: (active) =>
    set((s) => {
      const updated: Record<string, boolean> = {};
      for (const key of Object.keys(s.activeTextAnnotationTypes)) updated[key] = active;
      return { activeTextAnnotationTypes: updated };
    }),
  hiddenTextAnnotations: new Set<string>(),
  toggleTextAnnotationVisibility: (pageNum, index) =>
    set((s) => {
      const key = `${pageNum}:${index}`;
      const next = new Set(s.hiddenTextAnnotations);
      if (next.has(key)) next.delete(key); else next.add(key);
      return { hiddenTextAnnotations: next };
    }),
  textAnnotationColors: {},
  setTextAnnotationColor: (type, color) =>
    set((s) => ({ textAnnotationColors: { ...s.textAnnotationColors, [type]: color } })),
  activeTextAnnotationFilter: null,
  setTextAnnotationFilter: (activeTextAnnotationFilter) => set({ activeTextAnnotationFilter }),
  activeTakeoffFilter: null,
  setTakeoffFilter: (activeTakeoffFilter) => set({ activeTakeoffFilter }),
  textPanelTab: "annotations",
  setTextPanelTab: (textPanelTab) => set({ textPanelTab }),
  activeMarkupId: null,
  setActiveMarkupId: (activeMarkupId) => set({ activeMarkupId }),

  showTextPanel: false,
  toggleTextPanel: () => set((s) => ({ showTextPanel: !s.showTextPanel })),
  showChatPanel: true,
  toggleChatPanel: () => set((s) => ({ showChatPanel: !s.showChatPanel })),

  chatMessages: [],
  addChatMessage: (msg) =>
    set((s) => ({ chatMessages: [...s.chatMessages, msg] })),
  setChatMessages: (chatMessages) => set({ chatMessages }),
  clearChatMessages: () => set({ chatMessages: [] }),
  chatScope: "page",
  setChatScope: (chatScope) => set({ chatScope }),

  showDetections: false,
  toggleDetections: () =>
    set((s) => ({ showDetections: !s.showDetections })),
  showDetectionPanel: false,
  toggleDetectionPanel: () =>
    set((s) => ({ showDetectionPanel: !s.showDetectionPanel })),
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

  showTips: true,
  toggleTips: () => set((s) => ({ showTips: !s.showTips })),
  helpMode: false,
  toggleHelpMode: () => set((s) => ({ helpMode: !s.helpMode })),

  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  annotationPanelCollapsed: false,
  toggleAnnotationPanel: () => set((s) => ({ annotationPanelCollapsed: !s.annotationPanelCollapsed })),

  showKeynotes: false,
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
  showCsiPanel: false,
  toggleCsiPanel: () => set((s) => ({ showCsiPanel: !s.showCsiPanel })),

  showPageIntelPanel: false,
  togglePageIntelPanel: () => set((s) => ({ showPageIntelPanel: !s.showPageIntelPanel })),
  pageIntelligence: {},
  setPageIntelligence: (pageNum, data) => set((s) => ({ pageIntelligence: { ...s.pageIntelligence, [pageNum]: data } })),

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

  showTableParsePanel: false,
  toggleTableParsePanel: () =>
    set((s) => ({
      showTableParsePanel: !s.showTableParsePanel,
      // Reset state when closing
      ...(!s.showTableParsePanel ? {} : {
        tableParseStep: "idle" as const,
        tableParseRegion: null,
        tableParsedGrid: null,
        tableParseColumnBBs: [],
      }),
    })),
  tableParseStep: "idle",
  setTableParseStep: (tableParseStep) => set({ tableParseStep }),
  tableParseRegion: null,
  setTableParseRegion: (tableParseRegion) => set({ tableParseRegion }),
  tableParsedGrid: null,
  setTableParsedGrid: (tableParsedGrid) => set({ tableParsedGrid }),
  tableParseColumnBBs: [],
  addTableParseColumnBB: (bb) =>
    set((s) => ({ tableParseColumnBBs: [...s.tableParseColumnBBs, bb] })),
  tableParseColumnNames: [],
  setTableParseColumnNames: (tableParseColumnNames) => set({ tableParseColumnNames }),
  tableParseRowBBs: [],
  addTableParseRowBB: (bb) =>
    set((s) => ({ tableParseRowBBs: [...s.tableParseRowBBs, bb] })),
  resetTableParse: () =>
    set({
      tableParseStep: "idle",
      tableParseRegion: null,
      tableParsedGrid: null,
      tableParseColumnBBs: [],
      tableParseColumnNames: [],
      tableParseRowBBs: [],
    }),
  tableParseTab: "all",
  setTableParseTab: (tableParseTab) => set({ tableParseTab }),
  showTableCompareModal: false,
  toggleTableCompareModal: () => set((s) => ({ showTableCompareModal: !s.showTableCompareModal })),

  showKeynoteParsePanel: false,
  toggleKeynoteParsePanel: () => set((s) => ({ showKeynoteParsePanel: !s.showKeynoteParsePanel })),
  keynoteParseTab: "all",
  setKeynoteParseTab: (keynoteParseTab) => set({ keynoteParseTab }),
  keynoteParseStep: "idle",
  setKeynoteParseStep: (keynoteParseStep) => set({ keynoteParseStep }),
  keynoteParseRegion: null,
  setKeynoteParseRegion: (keynoteParseRegion) => set({ keynoteParseRegion }),
  keynoteColumnBBs: [],
  addKeynoteColumnBB: (bb) => set((s) => ({ keynoteColumnBBs: [...s.keynoteColumnBBs, bb] })),
  keynoteRowBBs: [],
  addKeynoteRowBB: (bb) => set((s) => ({ keynoteRowBBs: [...s.keynoteRowBBs, bb] })),
  keynoteYoloClass: null,
  setKeynoteYoloClass: (keynoteYoloClass) => set({ keynoteYoloClass }),
  parsedKeynoteData: null,
  setParsedKeynoteData: (parsedKeynoteData) => set({ parsedKeynoteData }),
  addParsedKeynote: (entry) => set((s) => ({
    parsedKeynoteData: [...(s.parsedKeynoteData || []), entry],
  })),
  activeKeynoteHighlight: null,
  setActiveKeynoteHighlight: (activeKeynoteHighlight) => set({ activeKeynoteHighlight }),
  resetKeynoteParse: () => set({
    keynoteParseStep: "idle",
    keynoteParseRegion: null,
    keynoteColumnBBs: [],
    keynoteRowBBs: [],
    keynoteYoloClass: null,
  }),

  yoloTags: [],
  setYoloTags: (yoloTags) => set({ yoloTags }),
  addYoloTag: (tag) => set((s) => ({ yoloTags: [...s.yoloTags, tag] })),
  removeYoloTag: (id) => set((s) => ({ yoloTags: s.yoloTags.filter((t) => t.id !== id) })),
  updateYoloTag: (id, updates) =>
    set((s) => ({
      yoloTags: s.yoloTags.map((t) => (t.id === id ? { ...t, ...updates } : t)),
    })),
  activeYoloTagId: null,
  setActiveYoloTagId: (activeYoloTagId) => set({ activeYoloTagId }),
  yoloTagVisibility: {},
  setYoloTagVisibility: (id, visible) =>
    set((s) => ({ yoloTagVisibility: { ...s.yoloTagVisibility, [id]: visible } })),
  activeYoloTagFilter: null,
  setYoloTagFilter: (activeYoloTagFilter) => set({ activeYoloTagFilter }),
  yoloTagPickingMode: false,
  setYoloTagPickingMode: (yoloTagPickingMode) => set({ yoloTagPickingMode }),

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
      projectIntelligenceData: null,
      showLabelingWizard: false,
      labelingWizardStep: 1,
      labelingSessions: [],
      labelingCredentials: null,
      textractData: {},
      keynotes: {},
      csiCodes: {},
      allTrades: [],
      textAnnotations: {},
      showTextAnnotations: false,
      activeTextAnnotationTypes: {},
      hiddenTextAnnotations: new Set<string>(),
      textAnnotationColors: {},
      activeTextAnnotationFilter: null,
      activeTakeoffFilter: null,
      textPanelTab: "annotations",
      activeMarkupId: null,
      chatMessages: [],
      chatScope: "page",
      activeKeynoteFilter: null,
      activeAnnotationFilter: null,
      activeTradeFilter: null,
      activeCsiFilter: null,
      allCsiCodes: [],
      showCsiPanel: false,
      showPageIntelPanel: false,
      pageIntelligence: {},
      sidebarCollapsed: false,
      annotationPanelCollapsed: false,
      showDetections: false,
      showDetectionPanel: false,
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
      showTableParsePanel: false,
      tableParseTab: "all",
      tableParseStep: "idle",
      tableParseRegion: null,
      tableParsedGrid: null,
      tableParseColumnBBs: [],
      tableParseColumnNames: [],
      tableParseRowBBs: [],
      showTableCompareModal: false,
      showKeynoteParsePanel: false,
      keynoteParseTab: "all",
      keynoteParseStep: "idle",
      keynoteParseRegion: null,
      keynoteColumnBBs: [],
      keynoteRowBBs: [],
      keynoteYoloClass: null,
      parsedKeynoteData: null,
      activeKeynoteHighlight: null,
      yoloTags: [],
      activeYoloTagId: null,
      yoloTagVisibility: {},
      activeYoloTagFilter: null,
      yoloTagPickingMode: false,
    }),
}));
