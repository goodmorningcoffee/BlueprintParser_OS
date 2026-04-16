import { create } from "zustand";
import type {
  ClientAnnotation,
  ClientTakeoffItem,
  TakeoffGroup,
  KeynoteShapeData,
  CsiCode,
  TextractPageData,
  PageIntelligence,
  SearchWordMatch,
  ChatMsg,
  TakeoffTab,
  ScaleCalibrationData,
  TextAnnotation,
  TextAnnotationResult,
  YoloTag,
  SymbolSearchResult,
  SymbolSearchMatch,
  QtoWorkflow,
  ProjectSummaries,
} from "@/types";

interface TagScanResults {
  yoloClass: string;
  yoloModel: string;
  texts: { text: string; count: number; pages: number[]; instances: { pageNumber: number; annotationId: number; bbox: [number, number, number, number]; confidence: number }[] }[];
}

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
  tempPanMode: boolean;
  setTempPanMode: (v: boolean) => void;

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
  /** One-shot signal to focus/select an annotation from outside AnnotationOverlay.
   *  AnnotationOverlay owns the local `selectedId` state; external callers
   *  (TakeoffPanel instance-click, AreaTab instance-click) set this field and
   *  AnnotationOverlay's useEffect consumes it, setting its local selectedId
   *  and clearing the field back to null. */
  focusAnnotationId: number | null;
  setFocusAnnotationId: (id: number | null) => void;

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
  demoFeatureConfig: Record<string, boolean> | null;
  setDemoFeatureConfig: (config: Record<string, boolean>) => void;
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

  // ─── Project Summaries (chunking support) ────────────────
  summaries: ProjectSummaries | null;
  setSummaries: (s: ProjectSummaries | null) => void;
  loadedPageRange: { from: number; to: number } | null;
  setLoadedPageRange: (range: { from: number; to: number } | null) => void;
  chunkLoading: boolean;
  setChunkLoading: (v: boolean) => void;

  // ─── Textract data per page ──────────────────────────────
  textractData: Record<number, TextractPageData>;
  setTextractData: (pageNum: number, data: TextractPageData) => void;

  // ─── Keynotes per page ───────────────────────────────────
  keynotes: Record<number, KeynoteShapeData[]>;
  setKeynotes: (pageNum: number, data: KeynoteShapeData[]) => void;
  setBatchKeynotes: (updates: Record<number, KeynoteShapeData[]>) => void;

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
  textPanelTab: "ocr" | "annotations" | "graph" | "markups" | "textract";
  setTextPanelTab: (tab: "ocr" | "annotations" | "graph" | "markups" | "textract") => void;
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
  hiddenAnnotationIds: Set<number>;
  toggleAnnotationVisibility: (id: number) => void;
  hiddenClasses: Record<string, boolean>; // "model:class" -> false means hidden
  toggleClassVisibility: (model: string, cls: string) => void;

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
  pageIntelligence: Record<number, PageIntelligence>;
  setPageIntelligence: (pageNum: number, data: PageIntelligence) => void;

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
  takeoffGroups: TakeoffGroup[];
  setTakeoffGroups: (groups: TakeoffGroup[]) => void;
  addTakeoffGroup: (g: TakeoffGroup) => void;
  removeTakeoffGroup: (id: number) => void;
  updateTakeoffGroup: (id: number, updates: Partial<TakeoffGroup>) => void;

  // ─── Takeoff item visibility ─────────────────────────────
  hiddenTakeoffItemIds: Set<number>;
  toggleTakeoffItemVisibility: (itemId: number) => void;

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
  // Bucket fill
  bucketFillActive: boolean;
  setBucketFillActive: (active: boolean) => void;
  bucketFillPreview: {
    vertices: { x: number; y: number }[];
    /** Inner holes (courtyards inside the filled region). Empty when none. */
    holes?: { vertices: { x: number; y: number }[] }[];
    method: string;
  } | null;
  setBucketFillPreview: (v: ViewerState["bucketFillPreview"]) => void;
  bucketFillLoading: boolean;
  setBucketFillLoading: (v: boolean) => void;
  bucketFillError: string | null;
  setBucketFillError: (msg: string | null) => void;
  bucketFillTolerance: number;
  setBucketFillTolerance: (n: number) => void;
  bucketFillDilatePx: number;
  setBucketFillDilatePx: (n: number) => void;
  /** 0-100 (percent). Default 25. User slider in AreaTab maps to 0.10-0.80
   *  fraction at API call time. Matches the client worker default. */
  bucketFillLeakThresholdPct: number;
  setBucketFillLeakThresholdPct: (n: number) => void;
  bucketFillPendingPolygon: {
    vertices: { x: number; y: number }[];
    /** Inner holes (courtyards) excluded from the net area calc. Rendered as
     *  evenodd cutouts in the preview. Dropped at commit time because the
     *  current annotation schema only stores a flat vertex array — see
     *  featureRoadMap/debug_and_vector_methods_plan.md for follow-up work. */
    holes?: { vertices: { x: number; y: number }[] }[];
    method: string;
    bbox: [number, number, number, number];
    areaSqUnits: number;
    unit: string;
  } | null;
  setBucketFillPendingPolygon: (v: ViewerState["bucketFillPendingPolygon"]) => void;
  commitBucketFillToItem: (item: ClientTakeoffItem) => void;
  // ─── Split Area tool ────────────────────────────────────
  splitAreaActive: boolean;
  setSplitAreaActive: (v: boolean) => void;
  splitLineA: { x: number; y: number } | null;
  splitLineB: { x: number; y: number } | null;
  setSplitLineEndpoint: (which: "a" | "b", pt: { x: number; y: number } | null) => void;
  splitPreview: {
    targetAnnotationId: number;
    original: { x: number; y: number }[];
    left: { x: number; y: number }[];
    right: { x: number; y: number }[];
    lineA: { x: number; y: number };
    lineB: { x: number; y: number };
  } | null;
  setSplitPreview: (p: {
    targetAnnotationId: number;
    original: { x: number; y: number }[];
    left: { x: number; y: number }[];
    right: { x: number; y: number }[];
    lineA: { x: number; y: number };
    lineB: { x: number; y: number };
  } | null) => void;
  splitError: string | null;
  setSplitError: (msg: string | null) => void;
  bucketFillBarriers: { x1: number; y1: number; x2: number; y2: number }[];
  addBucketFillBarrier: (line: { x1: number; y1: number; x2: number; y2: number }) => void;
  undoLastBarrier: () => void;
  clearBucketFillBarriers: () => void;
  bucketFillBarrierMode: boolean;
  setBucketFillBarrierMode: (v: boolean) => void;
  barrierPendingPoint: { x: number; y: number } | null;
  setBarrierPendingPoint: (v: { x: number; y: number } | null) => void;
  // Takeoff undo/redo
  takeoffUndoStack: ClientAnnotation[];
  takeoffRedoStack: ClientAnnotation[];
  takeoffUndo: () => void;
  takeoffRedo: () => void;

  // ─── Auto-QTO ────────────────────────────────────────────
  activeQtoWorkflow: QtoWorkflow | null;
  setActiveQtoWorkflow: (w: QtoWorkflow | null) => void;
  qtoWorkflows: QtoWorkflow[];
  setQtoWorkflows: (workflows: QtoWorkflow[]) => void;

  // ─── Table Parse ───────────────────────────────────────
  showTableParsePanel: boolean;
  toggleTableParsePanel: () => void;
  tableParseStep: "idle" | "select-region" | "define-column" | "define-row" | "review";
  setTableParseStep: (step: "idle" | "select-region" | "define-column" | "define-row" | "review") => void;
  tableParseRegion: [number, number, number, number] | null; // [minX, minY, maxX, maxY] normalized
  setTableParseRegion: (bbox: [number, number, number, number] | null) => void;
  tableParsedGrid: { headers: string[]; rows: Record<string, string>[]; tagColumn?: string; tableName?: string; csiTags?: { code: string; description: string }[]; colBoundaries?: number[]; rowBoundaries?: number[] } | null;
  setTableParsedGrid: (grid: { headers: string[]; rows: Record<string, string>[]; tagColumn?: string; tableName?: string; csiTags?: { code: string; description: string }[]; colBoundaries?: number[]; rowBoundaries?: number[] } | null) => void;
  /** Per-method raw grids + snapshot of the auto-picked merged grid. Lets the
   *  Compare/Edit modal show a "Source" dropdown for swapping between the
   *  auto-merged result and any individual method. Live-only (not persisted)
   *  and populated only when the server returned methodResults (debug mode). */
  tableParseMeta: {
    methodResults: Array<{
      method: string;
      headers: string[];
      rows: Record<string, string>[];
      confidence: number;
      tagColumn?: string;
      colBoundaries?: number[];
      rowBoundaries?: number[];
      error?: string;
    }>;
    baseMethod: string;
    mergedSnapshot: { headers: string[]; rows: Record<string, string>[]; tagColumn?: string; colBoundaries?: number[]; rowBoundaries?: number[] };
  } | null;
  setTableParseMeta: (meta: ViewerState["tableParseMeta"]) => void;
  tableCellStructure: {
    cells: Array<{ bbox: [number, number, number, number]; row: number; col: number; rowSpan: number; colSpan: number; type: string; confidence: number; text: string; highlighted: boolean }>;
    pageNumber: number;
    regionBbox: [number, number, number, number];
  } | null;
  setTableCellStructure: (structure: ViewerState["tableCellStructure"]) => void;
  toggleCellHighlight: (row: number, col: number) => void;
  /** TATR-OVERLAY: visibility toggle for the TATR cell overlay on the canvas.
   *  Defaults to true after the user runs Detect Cell Structure so they can
   *  see what was found. Toggle button lives in AutoParseTab next to the
   *  DetectCellStructureButton. Off by default at app start. */
  showTableCellStructure: boolean;
  setShowTableCellStructure: (show: boolean) => void;
  tableParseColumnBBs: [number, number, number, number][]; // user-drawn column BBs
  addTableParseColumnBB: (bb: [number, number, number, number]) => void;
  tableParseColumnNames: string[]; // user-defined names for each column
  setTableParseColumnNames: (names: string[]) => void;
  tableParseRowBBs: [number, number, number, number][]; // user-drawn row BBs
  addTableParseRowBB: (bb: [number, number, number, number]) => void;
  resetTableParse: () => void;
  tableParseTab: "all" | "auto" | "guided" | "manual" | "compare";
  setTableParseTab: (tab: "all" | "auto" | "guided" | "manual" | "compare") => void;
  tableParseOptions: {
    rowTolerance: number; minColGap: number; colHitRatio: number; headerMode: "auto" | "first" | "none";
    minHLineLengthRatio: number; minVLineLengthRatio: number; clusteringTolerance: number;
    mergerEditDistance: number;
  };
  setTableParseOptions: (patch: Partial<ViewerState["tableParseOptions"]>) => void;
  showTableCompareModal: boolean;
  toggleTableCompareModal: () => void;

  // ─── Keynote Parse ────────────────────────────────────
  showKeynoteParsePanel: boolean;
  toggleKeynoteParsePanel: () => void;
  keynoteParseTab: "all" | "auto" | "guided" | "manual" | "compare";
  setKeynoteParseTab: (tab: "all" | "auto" | "guided" | "manual" | "compare") => void;
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
  // Class-scan flow: scan results pending user selection
  tagScanResults: TagScanResults | null;
  setTagScanResults: (r: TagScanResults | null) => void;
  // Add-instance mode: draw BB to add to a specific tag
  tagAddingMode: string | null; // tagId when active
  setTagAddingMode: (tagId: string | null) => void;
  // Per-table/keynote tag view — eye icon toggle shows mapped tags + blue region highlight
  activeTableTagViews: Record<string, { regionId: string; pageNum: number; bbox: [number, number, number, number]; tagTexts: string[]; source: "schedule" | "keynote" }>;
  setTableTagView: (regionId: string, view: { regionId: string; pageNum: number; bbox: [number, number, number, number]; tagTexts: string[]; source: "schedule" | "keynote" } | null) => void;
  // LLM tool use highlight (auto-clears after timeout)
  llmHighlight: { pageNumber: number; bbox: [number, number, number, number]; label?: string } | null;
  setLlmHighlight: (h: { pageNumber: number; bbox: [number, number, number, number]; label?: string } | null) => void;
  // Tag instance browser ("Find All" for tags)
  tagBrowseId: string | null;
  tagBrowseIndex: number;
  tagBrowseNavigate: (tagId: string, index: number) => void;

  // ─── Parsed Region Visibility ──────────────────────────
  showParsedRegions: boolean;
  toggleParsedRegions: () => void;
  parsedRegionColorMode: "none" | "striped" | "checkerboard";
  setParsedRegionColorMode: (mode: "none" | "striped" | "checkerboard") => void;
  hiddenParsedRegionIds: Set<string>;
  toggleParsedRegionVisibility: (id: string) => void;
  focusedParsedRegionId: string | null;
  setFocusedParsedRegionId: (id: string | null) => void;

  // ─── Symbol Search ────────────────────────────────────
  symbolSearchActive: boolean;                    // draw mode active (crosshair cursor)
  setSymbolSearchActive: (active: boolean) => void;
  symbolSearchLoading: boolean;
  setSymbolSearchLoading: (loading: boolean) => void;
  symbolSearchProgress: { page: number; pageIndex: number; totalPages: number; matches: number } | null;
  setSymbolSearchProgress: (p: { page: number; pageIndex: number; totalPages: number; matches: number } | null) => void;
  symbolSearchResults: SymbolSearchResult | null;
  setSymbolSearchResults: (results: SymbolSearchResult | null) => void;
  symbolSearchConfidence: number;                 // slider value for filtering
  setSymbolSearchConfidence: (val: number) => void;
  dismissedSymbolMatches: Set<string>;            // dismissed match IDs
  dismissSymbolMatch: (matchId: string) => void;
  symbolSearchError: string | null;
  setSymbolSearchError: (error: string | null) => void;
  symbolSearchTemplateBbox: [number, number, number, number] | null;
  setSymbolSearchTemplateBbox: (bbox: [number, number, number, number] | null) => void;
  symbolSearchSourcePage: number | null;
  setSymbolSearchSourcePage: (page: number | null) => void;
  symbolSearchConfig: { multiScale: boolean; useSiftFallback: boolean; searchPages: number[] | null; scaleMin: number; scaleMax: number; nmsThreshold: number; maxMatchesPerPage: number };
  setSymbolSearchConfig: (patch: Partial<{ multiScale: boolean; useSiftFallback: boolean; searchPages: number[] | null; scaleMin: number; scaleMax: number; nmsThreshold: number; maxMatchesPerPage: number }>) => void;
  clearSymbolSearch: () => void;

  // ─── Drawing State (used by DrawingPreviewLayer, NOT subscribed by AnnotationOverlay) ──
  _drawing: boolean;
  _drawStart: { x: number; y: number };
  _drawEnd: { x: number; y: number };
  _mousePos: { x: number; y: number } | null;
  _setDrawing: (d: boolean) => void;
  _setDrawStart: (pos: { x: number; y: number }) => void;
  _setDrawEnd: (pos: { x: number; y: number }) => void;
  _setMousePos: (pos: { x: number; y: number } | null) => void;

  // ─── Guided Parse ─────────────────────────────────────
  guidedParseActive: boolean;
  guidedParseRegion: [number, number, number, number] | null; // MinMax BB
  guidedParseRows: number[];     // Y boundary positions (normalized 0-1)
  guidedParseCols: number[];     // X boundary positions (normalized 0-1)
  setGuidedParseActive: (active: boolean) => void;
  setGuidedParseRegion: (region: [number, number, number, number] | null) => void;
  setGuidedParseRows: (rows: number[]) => void;
  setGuidedParseCols: (cols: number[]) => void;
  resetGuidedParse: () => void;

  // ─── Reset ─────────────────────────────────────────────
  resetProjectData: () => void;
}

// Debounced save for YOLO tags — persists to projectIntelligence.yoloTags via PUT
let _yoloTagSaveTimer: ReturnType<typeof setTimeout> | null = null;
function _debounceSaveYoloTags() {
  if (_yoloTagSaveTimer) clearTimeout(_yoloTagSaveTimer);
  _yoloTagSaveTimer = setTimeout(() => {
    const { publicId, yoloTags, isDemo } = useViewerStore.getState();
    if (!publicId || isDemo) return;
    fetch(`/api/projects/${publicId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ yoloTags }),
    }).catch((e) => console.error("[yoloTags] Save failed:", e));
  }, 500);
}

export const useViewerStore = create<ViewerState>((set, get) => ({
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
  setMode: (mode) => set({ mode, activeTakeoffItemId: null, polygonDrawingMode: "idle", polygonVertices: [], bucketFillActive: false, bucketFillPreview: null, bucketFillLoading: false, bucketFillBarriers: [], bucketFillBarrierMode: false, tempPanMode: false }),
  tempPanMode: false,
  setTempPanMode: (tempPanMode) => set({ tempPanMode }),

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
  focusAnnotationId: null,
  setFocusAnnotationId: (focusAnnotationId) => set({ focusAnnotationId }),

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
  demoFeatureConfig: null,
  setDemoFeatureConfig: (demoFeatureConfig) => set({ demoFeatureConfig }),
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

  summaries: null,
  setSummaries: (summaries) => set({ summaries }),
  loadedPageRange: null,
  setLoadedPageRange: (loadedPageRange) => set({ loadedPageRange }),
  chunkLoading: false,
  setChunkLoading: (chunkLoading) => set({ chunkLoading }),

  textractData: {},
  setTextractData: (pageNum, data) =>
    set((s) => ({ textractData: { ...s.textractData, [pageNum]: data } })),

  keynotes: {},
  setKeynotes: (pageNum, data) =>
    set((s) => ({ keynotes: { ...s.keynotes, [pageNum]: data } })),
  setBatchKeynotes: (updates) =>
    set((s) => ({ keynotes: { ...s.keynotes, ...updates } })),

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
  confidenceThreshold: 0.10,
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
        confidenceThresholds[name] = s.confidenceThresholds[name] ?? 0.10;
      }
      return { activeModels, confidenceThresholds };
    }),
  hiddenAnnotationIds: new Set<number>(),
  toggleAnnotationVisibility: (id) =>
    set((s) => {
      const next = new Set(s.hiddenAnnotationIds);
      if (next.has(id)) next.delete(id); else next.add(id);
      return { hiddenAnnotationIds: next };
    }),
  hiddenClasses: {},
  toggleClassVisibility: (model, cls) =>
    set((s) => {
      const key = `${model}:${cls}`;
      const current = s.hiddenClasses[key] !== false; // default visible
      return { hiddenClasses: { ...s.hiddenClasses, [key]: !current } };
    }),

  showTips: false,
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
  setActiveTakeoffItemId: (activeTakeoffItemId) => set({ activeTakeoffItemId, takeoffUndoStack: [], takeoffRedoStack: [] }),

  takeoffGroups: [],
  setTakeoffGroups: (takeoffGroups) => set({ takeoffGroups }),
  addTakeoffGroup: (g) => set((s) => ({ takeoffGroups: [...s.takeoffGroups, g] })),
  removeTakeoffGroup: (id) =>
    set((s) => ({
      takeoffGroups: s.takeoffGroups.filter((g) => g.id !== id),
      // Mirror FK SET NULL: ungroup items that belonged to this group
      takeoffItems: s.takeoffItems.map((t) => (t.groupId === id ? { ...t, groupId: null } : t)),
    })),
  updateTakeoffGroup: (id, updates) =>
    set((s) => ({
      takeoffGroups: s.takeoffGroups.map((g) => (g.id === id ? { ...g, ...updates } : g)),
    })),

  hiddenTakeoffItemIds: new Set<number>(),
  toggleTakeoffItemVisibility: (itemId) =>
    set((s) => {
      const next = new Set(s.hiddenTakeoffItemIds);
      if (next.has(itemId)) next.delete(itemId); else next.add(itemId);
      return { hiddenTakeoffItemIds: next };
    }),

  takeoffTab: "count",
  setTakeoffTab: (takeoffTab) => set({ takeoffTab }),
  pageDimensions: {},
  setPageDimensions: (pageNum, width, height) => {
    const existing = get().pageDimensions[pageNum];
    if (existing && existing.width === width && existing.height === height) return;
    set((s) => ({ pageDimensions: { ...s.pageDimensions, [pageNum]: { width, height } } }));
  },
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
  // Bucket fill
  bucketFillActive: false,
  setBucketFillActive: (bucketFillActive) =>
    set({
      bucketFillActive,
      bucketFillPreview: null,
      bucketFillLoading: false,
      bucketFillError: null,
      bucketFillBarrierMode: false,
      bucketFillPendingPolygon: null,
      ...(bucketFillActive
        ? { splitAreaActive: false, splitLineA: null, splitLineB: null, splitPreview: null, splitError: null, tempPanMode: false }
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
  bucketFillLeakThresholdPct: 25,
  setBucketFillLeakThresholdPct: (bucketFillLeakThresholdPct) => set({ bucketFillLeakThresholdPct }),
  bucketFillPendingPolygon: null,
  setBucketFillPendingPolygon: (bucketFillPendingPolygon) => set({ bucketFillPendingPolygon }),
  commitBucketFillToItem: (item) => {
    const s = get();
    const pending = s.bucketFillPendingPolygon;
    if (!pending) return;
    // Only include `holes` when actually present — keeps JSONB clean for the
    // common case (most rooms don't have courtyards). Preview and render paths
    // both treat `undefined` and `[]` identically via `data.holes ?? []`.
    const polygonData = {
      type: "area-polygon" as const,
      takeoffItemId: item.id,
      color: item.color,
      vertices: pending.vertices,
      ...(pending.holes && pending.holes.length > 0 ? { holes: pending.holes } : {}),
      areaSqUnits: pending.areaSqUnits,
      unit: pending.unit,
    };
    const tempId = -Date.now();
    set((prev) => ({
      annotations: [...prev.annotations, {
        id: tempId,
        pageNumber: prev.pageNumber,
        name: item.name,
        bbox: pending.bbox,
        note: null,
        source: "takeoff" as const,
        data: polygonData as unknown as Record<string, unknown>,
      }],
      bucketFillPendingPolygon: null,
    }));
    // Persist to server (non-demo)
    if (!s.isDemo) {
      fetch("/api/annotations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: s.publicId,
          pageNumber: s.pageNumber,
          name: item.name,
          bbox: pending.bbox,
          source: "takeoff",
          data: polygonData,
        }),
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((saved) => {
          if (saved) set((prev) => ({
            annotations: prev.annotations.map((a) => a.id === tempId ? { ...a, id: saved.id } : a),
          }));
        })
        .catch((err) => console.error("Failed to persist bucket fill annotation:", err));
    }
  },
  splitAreaActive: false,
  setSplitAreaActive: (splitAreaActive) =>
    set({
      splitAreaActive,
      splitLineA: null,
      splitLineB: null,
      splitPreview: null,
      splitError: null,
      ...(splitAreaActive
        ? { bucketFillActive: false, bucketFillPreview: null, bucketFillLoading: false, bucketFillError: null, bucketFillBarrierMode: false, bucketFillBarriers: [], activeTakeoffItemId: null }
        : {}),
    }),
  splitLineA: null,
  splitLineB: null,
  setSplitLineEndpoint: (which, pt) =>
    set((s) => (which === "a" ? { splitLineA: pt } : { splitLineB: pt })),
  splitPreview: null,
  setSplitPreview: (splitPreview) => set({ splitPreview }),
  splitError: null,
  setSplitError: (splitError) => set({ splitError }),
  bucketFillBarriers: [],
  addBucketFillBarrier: (line) =>
    set((s) => ({ bucketFillBarriers: [...s.bucketFillBarriers, line] })),
  undoLastBarrier: () =>
    set((s) => ({ bucketFillBarriers: s.bucketFillBarriers.slice(0, -1) })),
  clearBucketFillBarriers: () => set({ bucketFillBarriers: [] }),
  bucketFillBarrierMode: false,
  setBucketFillBarrierMode: (bucketFillBarrierMode) => set({ bucketFillBarrierMode, barrierPendingPoint: null }),
  barrierPendingPoint: null,
  setBarrierPendingPoint: (barrierPendingPoint) => set({ barrierPendingPoint }),
  // Takeoff undo/redo (per active item, current page)
  takeoffUndoStack: [],
  takeoffRedoStack: [],
  takeoffUndo: () => set((s) => {
    const activeId = s.activeTakeoffItemId;
    if (!activeId) return s;
    // Find last annotation for this item on current page
    const pageNum = s.pageNumber;
    const idx = [...s.annotations].reverse().findIndex(
      (a) => a.source === "takeoff" && (a.data as any)?.takeoffItemId === activeId && a.pageNumber === pageNum
    );
    if (idx === -1) return s;
    const realIdx = s.annotations.length - 1 - idx;
    const removed = s.annotations[realIdx];
    return {
      annotations: s.annotations.filter((_, i) => i !== realIdx),
      takeoffUndoStack: [...s.takeoffUndoStack, removed],
      takeoffRedoStack: [],
    };
  }),
  takeoffRedo: () => set((s) => {
    if (s.takeoffUndoStack.length === 0) return s;
    const restored = s.takeoffUndoStack[s.takeoffUndoStack.length - 1];
    return {
      annotations: [...s.annotations, restored],
      takeoffUndoStack: s.takeoffUndoStack.slice(0, -1),
      takeoffRedoStack: [...s.takeoffRedoStack, restored],
    };
  }),

  // ─── Auto-QTO ────────────────────────────────────────────
  activeQtoWorkflow: null,
  setActiveQtoWorkflow: (activeQtoWorkflow) => set({ activeQtoWorkflow }),
  qtoWorkflows: [],
  setQtoWorkflows: (qtoWorkflows) => set({ qtoWorkflows }),

  showTableParsePanel: false,
  toggleTableParsePanel: () =>
    set((s) => ({
      showTableParsePanel: !s.showTableParsePanel,
      // Reset all parse state when closing
      ...(!s.showTableParsePanel ? {} : {
        tableParseStep: "idle" as const,
        tableParseRegion: null,
        tableParsedGrid: null,
        tableParseMeta: null,
        tableParseColumnBBs: [],
        tableParseColumnNames: [],
        tableParseRowBBs: [],
        tableParseTab: "all" as const,
        mode: "move" as const,
      }),
    })),
  tableParseStep: "idle",
  setTableParseStep: (tableParseStep) => set({ tableParseStep }),
  tableParseRegion: null,
  setTableParseRegion: (tableParseRegion) => set({ tableParseRegion }),
  tableParsedGrid: null,
  setTableParsedGrid: (tableParsedGrid) => set({ tableParsedGrid }),
  tableParseMeta: null,
  setTableParseMeta: (tableParseMeta) => set({ tableParseMeta }),
  tableCellStructure: null,
  // TATR-OVERLAY: when the user runs Detect Cell Structure, auto-show the
  // overlay so they can see what was found. Setter wired to a toggle button
  // in AutoParseTab. Persists for the session, resets to false on app load.
  setTableCellStructure: (tableCellStructure) =>
    set({ tableCellStructure, showTableCellStructure: tableCellStructure !== null }),
  showTableCellStructure: false,
  setShowTableCellStructure: (showTableCellStructure) => set({ showTableCellStructure }),
  toggleCellHighlight: (row, col) => set((s) => {
    if (!s.tableCellStructure) return {};
    return {
      tableCellStructure: {
        ...s.tableCellStructure,
        cells: s.tableCellStructure.cells.map((c) =>
          c.row === row && c.col === col ? { ...c, highlighted: !c.highlighted } : c
        ),
      },
    };
  }),
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
      tableParseMeta: null,
      tableCellStructure: null,
      tableParseColumnBBs: [],
      tableParseColumnNames: [],
      tableParseRowBBs: [],
    }),
  tableParseTab: "all",
  setTableParseTab: (tableParseTab) => set({ tableParseTab }),
  tableParseOptions: {
    rowTolerance: 0.006, minColGap: 0.015, colHitRatio: 0.3, headerMode: "auto" as const,
    minHLineLengthRatio: 0.15, minVLineLengthRatio: 0.10, clusteringTolerance: 15,
    mergerEditDistance: 2,
  },
  setTableParseOptions: (patch) =>
    set((s) => ({ tableParseOptions: { ...s.tableParseOptions, ...patch } })),
  showTableCompareModal: false,
  toggleTableCompareModal: () => set((s) => ({ showTableCompareModal: !s.showTableCompareModal })),

  showKeynoteParsePanel: false,
  toggleKeynoteParsePanel: () =>
    set((s) => ({
      showKeynoteParsePanel: !s.showKeynoteParsePanel,
      // Reset all parse state when closing
      ...(!s.showKeynoteParsePanel ? {} : {
        keynoteParseStep: "idle" as const,
        keynoteParseRegion: null,
        keynoteColumnBBs: [],
        keynoteRowBBs: [],
        keynoteYoloClass: null,
        keynoteParseTab: "all" as const,
        mode: "move" as const,
      }),
    })),
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
  setYoloTags: (yoloTags) => set({ yoloTags }), // hydration only — no DB save
  addYoloTag: (tag) => {
    set((s) => ({ yoloTags: [...s.yoloTags, tag] }));
    _debounceSaveYoloTags();
  },
  removeYoloTag: (id) => {
    set((s) => ({ yoloTags: s.yoloTags.filter((t) => t.id !== id) }));
    _debounceSaveYoloTags();
  },
  updateYoloTag: (id, updates) => {
    set((s) => ({
      yoloTags: s.yoloTags.map((t) => (t.id === id ? { ...t, ...updates } : t)),
    }));
    _debounceSaveYoloTags();
  },
  activeYoloTagId: null,
  setActiveYoloTagId: (activeYoloTagId) => set({ activeYoloTagId }),
  yoloTagVisibility: {},
  setYoloTagVisibility: (id, visible) =>
    set((s) => ({ yoloTagVisibility: { ...s.yoloTagVisibility, [id]: visible } })),
  activeYoloTagFilter: null,
  setYoloTagFilter: (activeYoloTagFilter) => set({ activeYoloTagFilter }),
  yoloTagPickingMode: false,
  setYoloTagPickingMode: (yoloTagPickingMode) => set({ yoloTagPickingMode }),
  tagScanResults: null,
  setTagScanResults: (tagScanResults) => set({ tagScanResults }),
  tagAddingMode: null,
  setTagAddingMode: (tagAddingMode) => set({ tagAddingMode }),
  activeTableTagViews: {},
  setTableTagView: (regionId, view) => set((s) => {
    const updated = { ...s.activeTableTagViews };
    if (view) { updated[regionId] = view; } else { delete updated[regionId]; }
    return { activeTableTagViews: updated };
  }),
  llmHighlight: null,
  setLlmHighlight: (llmHighlight) => set({ llmHighlight }),
  tagBrowseId: null,
  tagBrowseIndex: 0,
  tagBrowseNavigate: (tagId, index) => set((s) => {
    const tag = s.yoloTags.find((t) => t.id === tagId);
    if (!tag || tag.instances.length === 0) return s;
    const idx = ((index % tag.instances.length) + tag.instances.length) % tag.instances.length;
    const inst = tag.instances[idx];
    return {
      tagBrowseId: tagId,
      tagBrowseIndex: idx,
      activeYoloTagId: tagId,
      pageNumber: inst.pageNumber,
      llmHighlight: {
        pageNumber: inst.pageNumber,
        bbox: inst.bbox,
        label: `${tag.tagText} — ${idx + 1} of ${tag.instances.length}`,
      },
    };
  }),

  showParsedRegions: true,
  toggleParsedRegions: () => set((s) => ({ showParsedRegions: !s.showParsedRegions })),
  parsedRegionColorMode: "striped" as const,
  setParsedRegionColorMode: (parsedRegionColorMode) => set({ parsedRegionColorMode }),
  hiddenParsedRegionIds: new Set<string>(),
  toggleParsedRegionVisibility: (id) => set((s) => {
    const next = new Set(s.hiddenParsedRegionIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    return { hiddenParsedRegionIds: next };
  }),
  focusedParsedRegionId: null,
  setFocusedParsedRegionId: (focusedParsedRegionId) => set({ focusedParsedRegionId }),

  symbolSearchActive: false,
  setSymbolSearchActive: (symbolSearchActive) => set({ symbolSearchActive }),
  symbolSearchLoading: false,
  setSymbolSearchLoading: (symbolSearchLoading) => set({ symbolSearchLoading }),
  symbolSearchProgress: null,
  setSymbolSearchProgress: (symbolSearchProgress) => set({ symbolSearchProgress }),
  symbolSearchResults: null,
  setSymbolSearchResults: (symbolSearchResults) => set({ symbolSearchResults }),
  symbolSearchConfidence: 0.75,
  setSymbolSearchConfidence: (symbolSearchConfidence) => set({ symbolSearchConfidence }),
  dismissedSymbolMatches: new Set<string>(),
  dismissSymbolMatch: (matchId) =>
    set((s) => {
      const next = new Set(s.dismissedSymbolMatches);
      next.add(matchId);
      return { dismissedSymbolMatches: next };
    }),
  symbolSearchError: null,
  setSymbolSearchError: (symbolSearchError) => set({ symbolSearchError }),
  symbolSearchTemplateBbox: null,
  setSymbolSearchTemplateBbox: (symbolSearchTemplateBbox) => set({ symbolSearchTemplateBbox }),
  symbolSearchSourcePage: null,
  setSymbolSearchSourcePage: (symbolSearchSourcePage) => set({ symbolSearchSourcePage }),
  symbolSearchConfig: {
    multiScale: true,
    useSiftFallback: true,
    searchPages: null as number[] | null,
    scaleMin: 0.8,
    scaleMax: 1.5,
    nmsThreshold: 0.3,
    maxMatchesPerPage: 50,
  },
  setSymbolSearchConfig: (patch: Partial<{ multiScale: boolean; useSiftFallback: boolean; searchPages: number[] | null; scaleMin: number; scaleMax: number; nmsThreshold: number; maxMatchesPerPage: number }>) =>
    set((s) => ({ symbolSearchConfig: { ...s.symbolSearchConfig, ...patch } })),
  clearSymbolSearch: () =>
    set({
      symbolSearchActive: false,
      symbolSearchLoading: false,
      symbolSearchProgress: null,
      symbolSearchResults: null,
      symbolSearchConfidence: 0.75,
      dismissedSymbolMatches: new Set<string>(),
      symbolSearchError: null,
      symbolSearchTemplateBbox: null,
      symbolSearchSourcePage: null,
      symbolSearchConfig: { multiScale: true, useSiftFallback: true, searchPages: null, scaleMin: 0.8, scaleMax: 1.5, nmsThreshold: 0.3, maxMatchesPerPage: 50 },
    }),

  guidedParseActive: false,
  guidedParseRegion: null,
  guidedParseRows: [],
  guidedParseCols: [],
  setGuidedParseActive: (guidedParseActive) => set({ guidedParseActive }),
  setGuidedParseRegion: (guidedParseRegion) => set({ guidedParseRegion }),
  setGuidedParseRows: (guidedParseRows) => set({ guidedParseRows }),
  setGuidedParseCols: (guidedParseCols) => set({ guidedParseCols }),
  resetGuidedParse: () => set({ guidedParseActive: false, guidedParseRegion: null, guidedParseRows: [], guidedParseCols: [] }),

  _drawing: false,
  _drawStart: { x: 0, y: 0 },
  _drawEnd: { x: 0, y: 0 },
  _mousePos: null,
  _setDrawing: (_drawing) => set({ _drawing }),
  _setDrawStart: (_drawStart) => set({ _drawStart }),
  _setDrawEnd: (_drawEnd) => set({ _drawEnd }),
  _setMousePos: (_mousePos) => set({ _mousePos }),

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
      demoFeatureConfig: null,
      projectIntelligenceData: null,
      summaries: null,
      loadedPageRange: null,
      chunkLoading: false,
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
      confidenceThreshold: 0.10,
      activeModels: {},
      confidenceThresholds: {},
      hiddenAnnotationIds: new Set<number>(),
      showTakeoffPanel: false,
      takeoffItems: [],
      takeoffGroups: [],
      activeTakeoffItemId: null,
      takeoffTab: "count",
      activeQtoWorkflow: null,
      qtoWorkflows: [],
      pageDimensions: {},
      scaleCalibrations: {},
      calibrationMode: "idle",
      calibrationPoints: {},
      polygonDrawingMode: "idle",
      polygonVertices: [],
      showTableParsePanel: false,
      focusedParsedRegionId: null,
      tableParseTab: "all",
      tableParseStep: "idle",
      tableParseRegion: null,
      tableParsedGrid: null,
      tableParseMeta: null,
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
      tagScanResults: null,
      tagAddingMode: null,
      llmHighlight: null,
      symbolSearchActive: false,
      symbolSearchLoading: false,
      symbolSearchProgress: null,
      symbolSearchResults: null,
      symbolSearchConfidence: 0.75,
      dismissedSymbolMatches: new Set<string>(),
      symbolSearchError: null,
      symbolSearchTemplateBbox: null,
      symbolSearchSourcePage: null,
      symbolSearchConfig: { multiScale: true, useSiftFallback: true, searchPages: null, scaleMin: 0.8, scaleMax: 1.5, nmsThreshold: 0.3, maxMatchesPerPage: 50 },
      guidedParseActive: false,
      guidedParseRegion: null,
      guidedParseRows: [],
      guidedParseCols: [],
      tempPanMode: false,
    }),
}));

// ═══════════════════════════════════════════════════════════════════
// Typed Slice Selectors
// ═══════════════════════════════════════════════════════════════════
//
// Use these instead of raw `useViewerStore((s) => s.field)` calls.
// Each selector uses `useShallow` to prevent re-renders when
// unrelated fields change. Components import these selectors
// instead of accessing the store directly.
//
// Migration: Replace `useViewerStore((s) => s.pageNumber)` with
// `const { pageNumber } = useNavigation()`
//
// Per REFACTORING_RESEARCH.md Part 1: "Store Slices + Bridge"

import { useShallow } from "zustand/react/shallow";

/** Page navigation + zoom state */
export const useNavigation = () =>
  useViewerStore(useShallow((s) => ({
    pageNumber: s.pageNumber,
    numPages: s.numPages,
    mode: s.mode,
    setPage: s.setPage,
    setNumPages: s.setNumPages,
    setMode: s.setMode,
  })));

/** Panel visibility toggles */
export const usePanels = () =>
  useViewerStore(useShallow((s) => ({
    showTextPanel: s.showTextPanel,
    toggleTextPanel: s.toggleTextPanel,
    showChatPanel: s.showChatPanel,
    toggleChatPanel: s.toggleChatPanel,
    showTakeoffPanel: s.showTakeoffPanel,
    toggleTakeoffPanel: s.toggleTakeoffPanel,
    showDetectionPanel: s.showDetectionPanel,
    toggleDetectionPanel: s.toggleDetectionPanel,
    showCsiPanel: s.showCsiPanel,
    toggleCsiPanel: s.toggleCsiPanel,
    showPageIntelPanel: s.showPageIntelPanel,
    togglePageIntelPanel: s.togglePageIntelPanel,
    showTableParsePanel: s.showTableParsePanel,
    toggleTableParsePanel: s.toggleTableParsePanel,
    showKeynoteParsePanel: s.showKeynoteParsePanel,
    toggleKeynoteParsePanel: s.toggleKeynoteParsePanel,
    sidebarCollapsed: s.sidebarCollapsed,
    toggleSidebar: s.toggleSidebar,
    textPanelTab: s.textPanelTab,
    setTextPanelTab: s.setTextPanelTab,
  })));

/** Drawing state (only DrawingPreviewLayer should subscribe) */
export const useDrawingState = () =>
  useViewerStore(useShallow((s) => ({
    _drawing: s._drawing,
    _drawStart: s._drawStart,
    _drawEnd: s._drawEnd,
    _mousePos: s._mousePos,
    _setDrawing: s._setDrawing,
    _setDrawStart: s._setDrawStart,
    _setDrawEnd: s._setDrawEnd,
    _setMousePos: s._setMousePos,
  })));

/** Symbol search state */
export const useSymbolSearch = () =>
  useViewerStore(useShallow((s) => ({
    symbolSearchActive: s.symbolSearchActive,
    setSymbolSearchActive: s.setSymbolSearchActive,
    symbolSearchLoading: s.symbolSearchLoading,
    setSymbolSearchLoading: s.setSymbolSearchLoading,
    symbolSearchProgress: s.symbolSearchProgress,
    setSymbolSearchProgress: s.setSymbolSearchProgress,
    symbolSearchResults: s.symbolSearchResults,
    setSymbolSearchResults: s.setSymbolSearchResults,
    symbolSearchConfidence: s.symbolSearchConfidence,
    setSymbolSearchConfidence: s.setSymbolSearchConfidence,
    symbolSearchError: s.symbolSearchError,
    setSymbolSearchError: s.setSymbolSearchError,
    symbolSearchTemplateBbox: s.symbolSearchTemplateBbox,
    setSymbolSearchTemplateBbox: s.setSymbolSearchTemplateBbox,
    symbolSearchSourcePage: s.symbolSearchSourcePage,
    setSymbolSearchSourcePage: s.setSymbolSearchSourcePage,
    dismissedSymbolMatches: s.dismissedSymbolMatches,
    dismissSymbolMatch: s.dismissSymbolMatch,
    clearSymbolSearch: s.clearSymbolSearch,
    symbolSearchConfig: s.symbolSearchConfig,
    setSymbolSearchConfig: s.setSymbolSearchConfig,
  })));

/** Chat state */
export const useChat = () =>
  useViewerStore(useShallow((s) => ({
    chatMessages: s.chatMessages,
    addChatMessage: s.addChatMessage,
    setChatMessages: s.setChatMessages,
    clearChatMessages: s.clearChatMessages,
    chatScope: s.chatScope,
    setChatScope: s.setChatScope,
  })));

/** Table parse state */
export const useTableParse = () =>
  useViewerStore(useShallow((s) => ({
    tableParseStep: s.tableParseStep,
    setTableParseStep: s.setTableParseStep,
    tableParseRegion: s.tableParseRegion,
    setTableParseRegion: s.setTableParseRegion,
    tableParsedGrid: s.tableParsedGrid,
    setTableParsedGrid: s.setTableParsedGrid,
    tableParseColumnBBs: s.tableParseColumnBBs,
    addTableParseColumnBB: s.addTableParseColumnBB,
    tableParseRowBBs: s.tableParseRowBBs,
    addTableParseRowBB: s.addTableParseRowBB,
    tableParseColumnNames: s.tableParseColumnNames,
    setTableParseColumnNames: s.setTableParseColumnNames,
    tableParseTab: s.tableParseTab,
    setTableParseTab: s.setTableParseTab,
    tableParseOptions: s.tableParseOptions,
    setTableParseOptions: s.setTableParseOptions,
    showTableCompareModal: s.showTableCompareModal,
    toggleTableCompareModal: s.toggleTableCompareModal,
    resetTableParse: s.resetTableParse,
    showParsedRegions: s.showParsedRegions,
    toggleParsedRegions: s.toggleParsedRegions,
    parsedRegionColorMode: s.parsedRegionColorMode,
    setParsedRegionColorMode: s.setParsedRegionColorMode,
  })));

/** Keynote parse + guided parse state */
export const useKeynoteParse = () =>
  useViewerStore(useShallow((s) => ({
    keynoteParseStep: s.keynoteParseStep,
    setKeynoteParseStep: s.setKeynoteParseStep,
    keynoteParseRegion: s.keynoteParseRegion,
    setKeynoteParseRegion: s.setKeynoteParseRegion,
    keynoteColumnBBs: s.keynoteColumnBBs,
    addKeynoteColumnBB: s.addKeynoteColumnBB,
    keynoteRowBBs: s.keynoteRowBBs,
    addKeynoteRowBB: s.addKeynoteRowBB,
    keynoteParseTab: s.keynoteParseTab,
    setKeynoteParseTab: s.setKeynoteParseTab,
    keynoteYoloClass: s.keynoteYoloClass,
    setKeynoteYoloClass: s.setKeynoteYoloClass,
    resetKeynoteParse: s.resetKeynoteParse,
    guidedParseActive: s.guidedParseActive,
    setGuidedParseActive: s.setGuidedParseActive,
    guidedParseRegion: s.guidedParseRegion,
    setGuidedParseRegion: s.setGuidedParseRegion,
    guidedParseRows: s.guidedParseRows,
    setGuidedParseRows: s.setGuidedParseRows,
    guidedParseCols: s.guidedParseCols,
    setGuidedParseCols: s.setGuidedParseCols,
    resetGuidedParse: s.resetGuidedParse,
  })));

/** Project-level context (read-mostly) */
export const useProject = () =>
  useViewerStore(useShallow((s) => ({
    projectId: s.projectId,
    publicId: s.publicId,
    dataUrl: s.dataUrl,
    isDemo: s.isDemo,
    demoFeatureConfig: s.demoFeatureConfig,
    pageNames: s.pageNames,
    projectIntelligenceData: s.projectIntelligenceData,
  })));

/**
 * Check if a feature is enabled for demo visitors.
 * Non-demo always returns true. Demo checks company config (default: enabled).
 */
export function isDemoFeatureEnabled(feature: string): boolean {
  const { isDemo, demoFeatureConfig } = useViewerStore.getState();
  if (!isDemo) return true;
  if (!demoFeatureConfig) return true; // no config = all features enabled
  return demoFeatureConfig[feature] !== false; // default: enabled unless explicitly off
}

/** Per-page data cache */
export const usePageData = () =>
  useViewerStore(useShallow((s) => ({
    textractData: s.textractData,
    setTextractData: s.setTextractData,
    keynotes: s.keynotes,
    setKeynotes: s.setKeynotes,
    setBatchKeynotes: s.setBatchKeynotes,
    csiCodes: s.csiCodes,
    setCsiCodes: s.setCsiCodes,
    textAnnotations: s.textAnnotations,
    setTextAnnotations: s.setTextAnnotations,
    pageIntelligence: s.pageIntelligence,
    setPageIntelligence: s.setPageIntelligence,
    allCsiCodes: s.allCsiCodes,
    activeCsiFilter: s.activeCsiFilter,
    setCsiFilter: s.setCsiFilter,
  })));

/** YOLO detection model state + annotation list + filters */
export const useDetection = () =>
  useViewerStore(useShallow((s) => ({
    annotations: s.annotations,
    activeModels: s.activeModels,
    setModelActive: s.setModelActive,
    confidenceThreshold: s.confidenceThreshold,
    setConfidenceThreshold: s.setConfidenceThreshold,
    activeAnnotationFilter: s.activeAnnotationFilter,
    setAnnotationFilter: s.setAnnotationFilter,
    // Cross-cutting: searchQuery/setSearch included here because consumers
    // pair them with filter toggles. May extract to useSearch() later.
    searchQuery: s.searchQuery,
    setSearch: s.setSearch,
    hiddenAnnotationIds: s.hiddenAnnotationIds,
    toggleAnnotationVisibility: s.toggleAnnotationVisibility,
    hiddenClasses: s.hiddenClasses,
    toggleClassVisibility: s.toggleClassVisibility,
  })));

/** YOLO tag CRUD + visibility state */
export const useYoloTags = () =>
  useViewerStore(useShallow((s) => ({
    yoloTags: s.yoloTags,
    activeYoloTagId: s.activeYoloTagId,
    setActiveYoloTagId: s.setActiveYoloTagId,
    yoloTagVisibility: s.yoloTagVisibility,
    setYoloTagVisibility: s.setYoloTagVisibility,
    setYoloTagFilter: s.setYoloTagFilter,
    removeYoloTag: s.removeYoloTag,
    updateYoloTag: s.updateYoloTag,
    yoloTagPickingMode: s.yoloTagPickingMode,
    setYoloTagPickingMode: s.setYoloTagPickingMode,
    tagScanResults: s.tagScanResults,
    setTagScanResults: s.setTagScanResults,
    tagAddingMode: s.tagAddingMode,
    setTagAddingMode: s.setTagAddingMode,
  })));

/** Text annotation visibility + styling controls */
export const useTextAnnotationDisplay = () =>
  useViewerStore(useShallow((s) => ({
    showTextAnnotations: s.showTextAnnotations,
    toggleTextAnnotations: s.toggleTextAnnotations,
    activeTextAnnotationTypes: s.activeTextAnnotationTypes,
    setTextAnnotationType: s.setTextAnnotationType,
    setAllTextAnnotationTypes: s.setAllTextAnnotationTypes,
    hiddenTextAnnotations: s.hiddenTextAnnotations,
    toggleTextAnnotationVisibility: s.toggleTextAnnotationVisibility,
    textAnnotationColors: s.textAnnotationColors,
    setTextAnnotationColor: s.setTextAnnotationColor,
    activeTextAnnotationFilter: s.activeTextAnnotationFilter,
    setTextAnnotationFilter: s.setTextAnnotationFilter,
  })));

/** Annotation visibility filter state (used by AnnotationOverlay pageAnnotations useMemo) */
export const useAnnotationFilters = () =>
  useViewerStore(useShallow((s) => ({
    showDetections: s.showDetections,
    confidenceThreshold: s.confidenceThreshold,
    activeModels: s.activeModels,
    hiddenClasses: s.hiddenClasses,
    confidenceThresholds: s.confidenceThresholds,
    activeAnnotationFilter: s.activeAnnotationFilter,
    activeCsiFilter: s.activeCsiFilter,
    hiddenAnnotationIds: s.hiddenAnnotationIds,
  })));

/** Auto-QTO workflow state */
export const useQtoWorkflow = () =>
  useViewerStore(useShallow((s) => ({
    activeQtoWorkflow: s.activeQtoWorkflow,
    setActiveQtoWorkflow: s.setActiveQtoWorkflow,
    qtoWorkflows: s.qtoWorkflows,
    setQtoWorkflows: s.setQtoWorkflows,
  })));

export const useSummaries = () =>
  useViewerStore(useShallow((s) => ({
    summaries: s.summaries,
    setSummaries: s.setSummaries,
    loadedPageRange: s.loadedPageRange,
    setLoadedPageRange: s.setLoadedPageRange,
    chunkLoading: s.chunkLoading,
    setChunkLoading: s.setChunkLoading,
  })));

