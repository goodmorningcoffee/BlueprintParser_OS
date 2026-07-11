import { create } from "zustand";
import type {
  ClientAnnotation,
  ScaleCalibrationData,
  SymbolSearchResult,
  SymbolSearchMatch,
  QtoWorkflow,
  ParsedRegion,
  TextractLine,
} from "@/types";

/** Stage 5 Phase 2.5 — a paragraph committed by the user via ParagraphOverlay.
 *  Lives in a batch until Save Spec / Save Note promotes it to a ParsedRegion. */
export interface PendingParagraph {
  id: string;
  bbox: [number, number, number, number];
  lines: TextractLine[];
  rowText: Record<string, string>;
  colBoundaries?: number[];
}

/** Stage 5 Phase 2.5 — Cmd+C clipboard shape shared across parsers. */
export interface ParagraphTemplate {
  colBoundaries: number[];
  headers: string[];
}

interface TagScanResults {
  yoloClass: string;
  yoloModel: string;
  texts: { text: string; count: number; pages: number[]; instances: { pageNumber: number; annotationId: number; bbox: [number, number, number, number]; confidence: number }[] }[];
}

interface ViewerState {
  // ─── Mode ────────────────────────────────────────────────
  // "group" mode powers the new multi-select / lasso tool. In this mode,
  // click-drag on empty canvas starts a marquee that selects every
  // intersecting annotation. Click on an annotation adds/removes it
  // from `selectedAnnotationIds` in uiStore. See useMultiSelectInteraction + the
  // useAnnotationGroups facade in src/queries/useAnnotationGroups.ts (P2.2⑤).
  mode: "move" | "pointer" | "markup" | "group";
  setMode: (m: "move" | "pointer" | "markup" | "group") => void;
  tempPanMode: boolean;
  setTempPanMode: (v: boolean) => void;

  // [refactor jul10 P2.2⑤] annotation groups + the M:N membership indexes moved to the
  // TanStack Query cache — see src/queries/useAnnotationGroups.ts (ONE key holds the raw
  // {groups, memberships} payload; the forward/reverse Set indexes are derived in-hook).
  // The old fields (annotationGroups / annotationGroupMemberships / groupMembers) and their
  // 6 actions are DELETED, not bridged; 4 of the 9 selector members were dead surface (E7).

  // [refactor jul11 P2.3] Project identity, demo policy, page labels, and labeling-session state
  // live in sessionStore. The residual csiGraph bootstrap value lives in useCsiGraph. Do not add
  // project/session data back to this UI/tool store.

  // [refactor jul11 P2.2⑦/⑧] Active page-window maps and per-page Textract OCR are query-owned.
  // Only project-wide bootstrap metadata from those former server-data slices remains here.
  allTrades: string[];
  setAllTrades: (trades: string[]) => void;

  // ─── CSI project metadata ─────────────────────────────────
  allCsiCodes: { code: string; description: string }[];
  setAllCsiCodes: (codes: { code: string; description: string }[]) => void;

  // ─── Takeoff ────────────────────────────────────────────
  // [refactor jul10 P2.2④] takeoffItems + takeoffGroups (and their collection actions,
  // incl. the two-key removeTakeoffGroup ungroup) moved to the TanStack Query cache —
  // src/queries/useTakeoff.ts (useTakeoffItems/useTakeoffGroups/readTakeoffItems/
  // seedTakeoffCache). setTakeoffItems/setTakeoffGroups were DELETED, not ported (sole
  // callers were the loader seeds seedTakeoffCache replaces). Only the UI fields below
  // stay Zustand but are split by responsibility: the active pointer and undo/redo stacks remain
  // tool state here; panel/filter/visibility/tab presentation lives in uiStore.
  activeTakeoffItemId: number | null;
  setActiveTakeoffItemId: (id: number | null) => void;

  // ─── Takeoff Area ──────────────────────────────────────
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
  /** Resolution knob for the bucket-fill worker — passed directly as
   *  `maxDimension` into `clientBucketFill`. Snap values: 1000 (instant,
   *  downscales heavily on high-DPI plans so thin walls vanish), 2000, 3000,
   *  4000 (near-native PDF.js canvas resolution, preserves 1-pixel walls,
   *  ~150-250ms worst case on big room fills). Session-scoped; resets to
   *  1000 on project switch. */
  bucketFillResolution: 1000 | 2000 | 3000 | 4000;
  setBucketFillResolution: (r: 1000 | 2000 | 3000 | 4000) => void;
  bucketFillPendingPolygon: {
    vertices: { x: number; y: number }[];
    /** Inner holes (courtyards) excluded from net area and rendered as evenodd cutouts.
     *  Non-empty holes are persisted in annotation JSONB; empty/missing holes are omitted. */
    holes?: { vertices: { x: number; y: number }[] }[];
    method: string;
    bbox: [number, number, number, number];
    areaSqUnits: number;
    unit: string;
  } | null;
  setBucketFillPendingPolygon: (v: ViewerState["bucketFillPendingPolygon"]) => void;
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
  // Takeoff undo/redo history stays UI/tool state. The cross-backend operations themselves live
  // beside the annotation cache (`takeoffUndo/Redo(qc)` in queries/useAnnotations.ts).
  takeoffUndoStack: ClientAnnotation[];
  takeoffRedoStack: ClientAnnotation[];

  // ─── Auto-QTO ────────────────────────────────────────────
  // [refactor jul10 P2.2②] qtoWorkflows COLLECTION moved to the TanStack cache
  // (src/queries/useQtoWorkflows.ts). The active pointer stays here: it is a UI-selection /
  // in-progress draft, not a server collection (P2_DESIGN/QTO_IMPL/SPEC.md §3).
  activeQtoWorkflow: QtoWorkflow | null;
  setActiveQtoWorkflow: (w: QtoWorkflow | null) => void;

  // ─── Table Parse ───────────────────────────────────────
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
  setTableParseRowBBs: (bbs: [number, number, number, number][]) => void;
  resetTableParse: () => void;
  tableParseTab: "all" | "auto" | "guided" | "manual" | "compare";
  setTableParseTab: (tab: "all" | "auto" | "guided" | "manual" | "compare") => void;
  tableParseOptions: {
    rowTolerance: number; minColGap: number; colHitRatio: number; headerMode: "auto" | "first" | "none";
    minHLineLengthRatio: number; minVLineLengthRatio: number; clusteringTolerance: number;
    mergerEditDistance: number;
  };
  setTableParseOptions: (patch: Partial<ViewerState["tableParseOptions"]>) => void;

  // ─── Keynote Parse ────────────────────────────────────
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
  resetKeynoteParse: () => void;

  // ─── Notes Parse (Stage 3 scaffold — consumed by Stage 4 UI) ───
  notesParseStep: "idle" | "select-region" | "define-column" | "define-row" | "review";
  setNotesParseStep: (step: "idle" | "select-region" | "define-column" | "define-row" | "review") => void;
  notesParseRegion: [number, number, number, number] | null;
  setNotesParseRegion: (bbox: [number, number, number, number] | null) => void;
  guidedNotesRows: [number, number, number, number][];
  addGuidedNotesRow: (bb: [number, number, number, number]) => void;
  guidedNotesCols: [number, number, number, number][];
  addGuidedNotesCol: (bb: [number, number, number, number]) => void;
  resetNotesParse: () => void;

  // ─── Shared parse draft (Stage 4) ──────────────────────
  /** Transient in-progress ParsedRegion rendered by ParseRegionLayer with a
   *  dashed stroke + reduced opacity. Written by any Parser (Notes today,
   *  Spec/Keynote later) during Auto/Guided/Fast-manual/Manual preview;
   *  cleared on commit or reset. Not persisted. */
  parseDraftRegion: ParsedRegion | null;
  setParseDraftRegion: (r: ParsedRegion | null) => void;

  /** Stage 4: gate for PDFPage's NotesFastManualOverlaySlot. Toggled by
   *  NotesParser when the user enters/leaves the Fast-manual sub-mode. */
  notesFastManualActive: boolean;
  setNotesFastManualActive: (active: boolean) => void;

  /** Stage 4: FastManualParseOverlay writes its cumulative grid here on
   *  every double-click. NotesParser mirrors into local `preview` state
   *  via useEffect when mode === "fast-manual". Cleared on mode change. */
  notesFastManualGrid: {
    headers: string[];
    rows: Record<string, string>[];
    colBoundaries?: number[];
    rowBoundaries?: number[];
  } | null;
  setNotesFastManualGrid: (g: {
    headers: string[];
    rows: Record<string, string>[];
    colBoundaries?: number[];
    rowBoundaries?: number[];
  } | null) => void;

  // ─── Spec Parse (Stage 3 scaffold — consumed by Stage 5 UI) ────
  specParseStep: "idle" | "select-region" | "define-sections" | "review";
  setSpecParseStep: (step: "idle" | "select-region" | "define-sections" | "review") => void;
  specParseRegion: [number, number, number, number] | null;
  setSpecParseRegion: (bbox: [number, number, number, number] | null) => void;
  guidedSpecSectionBBs: [number, number, number, number][];
  addGuidedSpecSectionBB: (bb: [number, number, number, number]) => void;
  resetSpecParse: () => void;

  // ─── Paragraph Overlay (Stage 5 Phase 2.5) ─────────────
  /** Gate for PDFPage's ParagraphOverlaySlot. Toggled by Phase 2.6
   *  ParagraphMode.tsx when the user enters/leaves that sub-mode. */
  paragraphOverlayActive: boolean;
  setParagraphOverlayActive: (active: boolean) => void;
  /** User-committed paragraphs accumulated until Save. */
  paragraphBatch: PendingParagraph[];
  setParagraphBatch: (batch: PendingParagraph[]) => void;
  upsertPendingParagraph: (p: PendingParagraph) => void;
  removePendingParagraph: (id: string) => void;
  /** Shared Cmd+C/V clipboard. Persists across parser-mode switches +
   *  tool exits; cleared only by resetProjectData. */
  paragraphClipboard: ParagraphTemplate | null;
  setParagraphClipboard: (t: ParagraphTemplate | null) => void;
  // ─── YOLO Tag tool state (collection lives in Query; presentation lives in uiStore) ──────
  yoloTagPickingMode: boolean;
  setYoloTagPickingMode: (v: boolean) => void;
  // Class-scan flow: scan results pending user selection
  tagScanResults: TagScanResults | null;
  setTagScanResults: (r: TagScanResults | null) => void;
  // Add-instance mode: draw BB to add to a specific tag
  tagAddingMode: string | null; // tagId when active
  setTagAddingMode: (tagId: string | null) => void;

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
  /** Preset bundling scaleMin/scaleMax/nmsThreshold. "lite" is fast default
   *  (0.8-1.5, NMS 0.3). "power" widens recall (0.5-2.0, NMS 0.2) at ~2x
   *  per-page runtime. UI shows a third derived "custom" state when the
   *  advanced sliders have been hand-tuned to values that don't match
   *  either preset — see SymbolSearchPanel for the derivation. */
  symbolSearchPreset: "lite" | "power";
  setSymbolSearchPreset: (preset: "lite" | "power") => void;
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

  // Universal tool-state tear-down — compose of setMode("move") +
  // resetTableParse + resetKeynoteParse + resetGuidedParse + clearSymbolSearch.
  // Called from parent-panel toggles on close and from cancel buttons.
  resetAllTools: () => void;

  // ─── Reset ─────────────────────────────────────────────
  /** Remaining viewer/tool/parse half of reset. Call resetProjectData from viewerCommands. */
  resetViewerState: () => void;
}

export const useViewerStore = create<ViewerState>((set, get) => ({
  mode: "move",
  // Switching modes disengages every competing tool so mode="markup" can't coexist
  // with bucketFillActive=true / symbolSearchActive=true / etc.
  setMode: (mode) => set({ mode, activeTakeoffItemId: null, polygonDrawingMode: "idle", polygonVertices: [], bucketFillActive: false, bucketFillPreview: null, bucketFillLoading: false, bucketFillBarriers: [], bucketFillBarrierMode: false, splitAreaActive: false, splitLineA: null, splitLineB: null, splitPreview: null, splitError: null, symbolSearchActive: false, tempPanMode: false }),
  tempPanMode: false,
  setTempPanMode: (tempPanMode) => set({ tempPanMode }),

  // [refactor jul10 P2.2⑤] annotationGroups init + 6 actions (setAnnotationGroups,
  // upsertAnnotationGroup, removeAnnotationGroupLocal, hydrateGroupMemberships,
  // addAnnotationToGroup, removeAnnotationFromGroup) and the two index inits moved/deleted →
  // src/queries/useAnnotationGroups.ts. upsertAnnotationGroup + the hydrate index-rebuild loop
  // were ported VERBATIM (facade upsert / deriveGroupIndexes); the other four were dead surface
  // (grep-verified zero external callers — the loader's setAnnotationGroups call became the
  // cache seed). NOTE the former monolithic reset never cleared these fields — that omission was
  // the old cross-project stale-retention bug; publicId-keyed cache entries eliminate the class
  // (SPEC §5-E3), so do NOT add group lines to resetViewerState.

  allTrades: [],
  setAllTrades: (allTrades) => set({ allTrades }),

  allCsiCodes: [],
  setAllCsiCodes: (allCsiCodes) => set({ allCsiCodes }),
  // [refactor jul10 P2.2④] takeoffItems/takeoffGroups collection state + actions moved to the
  // TanStack cache (src/queries/useTakeoff.ts). The FK-SET-NULL ungroup that lived in
  // removeTakeoffGroup here is now the facade's two-key notifyManager.batch write.
  activeTakeoffItemId: null,
  setActiveTakeoffItemId: (activeTakeoffItemId) => set({ activeTakeoffItemId, takeoffUndoStack: [], takeoffRedoStack: [] }),

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
        ? { mode: "move" as const, splitAreaActive: false, splitLineA: null, splitLineB: null, splitPreview: null, splitError: null, symbolSearchActive: false, tempPanMode: false }
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
  setBucketFillPendingPolygon: (bucketFillPendingPolygon) => set({ bucketFillPendingPolygon }),
  // [refactor jul11 P2.2⑥] Cross-backend commit moved to useAnnotations().commitBucketFill.
  splitAreaActive: false,
  setSplitAreaActive: (splitAreaActive) =>
    set({
      splitAreaActive,
      splitLineA: null,
      splitLineB: null,
      splitPreview: null,
      splitError: null,
      ...(splitAreaActive
        ? { mode: "move" as const, bucketFillActive: false, bucketFillPreview: null, bucketFillLoading: false, bucketFillError: null, bucketFillBarrierMode: false, bucketFillBarriers: [], symbolSearchActive: false, activeTakeoffItemId: null }
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
  // Takeoff undo/redo history; cache+stack operations live in useAnnotations.
  takeoffUndoStack: [],
  takeoffRedoStack: [],

  // ─── Auto-QTO ──────────────────────────────────────────── (collection → query cache, P2.2②)
  activeQtoWorkflow: null,
  setActiveQtoWorkflow: (activeQtoWorkflow) => set({ activeQtoWorkflow }),

  tableParseStep: "idle",
  setTableParseStep: (tableParseStep) =>
    set((s) => ({
      tableParseStep,
      // Entering table-parse flow (idle → any other step): disengage markup/bucket-fill/etc.
      ...(s.tableParseStep === "idle" && tableParseStep !== "idle"
        ? { mode: "move" as const, bucketFillActive: false, bucketFillPreview: null, bucketFillLoading: false, bucketFillBarrierMode: false, splitAreaActive: false, symbolSearchActive: false }
        : {}),
    })),
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
  setTableParseRowBBs: (tableParseRowBBs) => set({ tableParseRowBBs }),
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
  keynoteParseTab: "all",
  setKeynoteParseTab: (keynoteParseTab) => set({ keynoteParseTab }),
  keynoteParseStep: "idle",
  setKeynoteParseStep: (keynoteParseStep) =>
    set((s) => ({
      keynoteParseStep,
      // Entering keynote-parse flow (idle → any other step): disengage markup/bucket-fill/etc.
      ...(s.keynoteParseStep === "idle" && keynoteParseStep !== "idle"
        ? { mode: "move" as const, bucketFillActive: false, bucketFillPreview: null, bucketFillLoading: false, bucketFillBarrierMode: false, splitAreaActive: false, symbolSearchActive: false }
        : {}),
    })),
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
  resetKeynoteParse: () => set({
    keynoteParseStep: "idle",
    keynoteParseRegion: null,
    keynoteColumnBBs: [],
    keynoteRowBBs: [],
    keynoteYoloClass: null,
  }),

  // ─── Notes Parse (Stage 3 scaffold) ─────────────────────
  notesParseStep: "idle",
  setNotesParseStep: (notesParseStep) =>
    set((s) => ({
      notesParseStep,
      ...(s.notesParseStep === "idle" && notesParseStep !== "idle"
        ? { mode: "move" as const, bucketFillActive: false, bucketFillPreview: null, bucketFillLoading: false, bucketFillBarrierMode: false, splitAreaActive: false, symbolSearchActive: false }
        : {}),
    })),
  notesParseRegion: null,
  setNotesParseRegion: (notesParseRegion) => set({ notesParseRegion }),
  guidedNotesRows: [],
  addGuidedNotesRow: (bb) => set((s) => ({ guidedNotesRows: [...s.guidedNotesRows, bb] })),
  guidedNotesCols: [],
  addGuidedNotesCol: (bb) => set((s) => ({ guidedNotesCols: [...s.guidedNotesCols, bb] })),
  resetNotesParse: () => set({
    notesParseStep: "idle",
    notesParseRegion: null,
    guidedNotesRows: [],
    guidedNotesCols: [],
    parseDraftRegion: null,
    paragraphOverlayActive: false,
    paragraphBatch: [],
  }),

  parseDraftRegion: null,
  setParseDraftRegion: (parseDraftRegion) => set({ parseDraftRegion }),

  notesFastManualActive: false,
  setNotesFastManualActive: (notesFastManualActive) => set({ notesFastManualActive }),
  notesFastManualGrid: null,
  setNotesFastManualGrid: (notesFastManualGrid) => set({ notesFastManualGrid }),

  // ─── Spec Parse (Stage 3 scaffold) ──────────────────────
  specParseStep: "idle",
  setSpecParseStep: (specParseStep) =>
    set((s) => ({
      specParseStep,
      ...(s.specParseStep === "idle" && specParseStep !== "idle"
        ? { mode: "move" as const, bucketFillActive: false, bucketFillPreview: null, bucketFillLoading: false, bucketFillBarrierMode: false, splitAreaActive: false, symbolSearchActive: false }
        : {}),
    })),
  specParseRegion: null,
  setSpecParseRegion: (specParseRegion) => set({ specParseRegion }),
  guidedSpecSectionBBs: [],
  addGuidedSpecSectionBB: (bb) => set((s) => ({ guidedSpecSectionBBs: [...s.guidedSpecSectionBBs, bb] })),
  resetSpecParse: () => set({
    specParseStep: "idle",
    specParseRegion: null,
    guidedSpecSectionBBs: [],
    parseDraftRegion: null,
    paragraphOverlayActive: false,
    paragraphBatch: [],
  }),

  // ─── Paragraph Overlay (Stage 5 Phase 2.5) ────────────
  paragraphOverlayActive: false,
  setParagraphOverlayActive: (paragraphOverlayActive) => set({ paragraphOverlayActive }),
  paragraphBatch: [],
  setParagraphBatch: (paragraphBatch) => set({ paragraphBatch }),
  upsertPendingParagraph: (p) => set((s) => {
    const idx = s.paragraphBatch.findIndex((x) => x.id === p.id);
    if (idx === -1) return { paragraphBatch: [...s.paragraphBatch, p] };
    const next = s.paragraphBatch.slice();
    next[idx] = p;
    return { paragraphBatch: next };
  }),
  removePendingParagraph: (id) => set((s) => ({
    paragraphBatch: s.paragraphBatch.filter((p) => p.id !== id),
  })),
  paragraphClipboard: null,
  setParagraphClipboard: (paragraphClipboard) => set({ paragraphClipboard }),

  yoloTagPickingMode: false,
  setYoloTagPickingMode: (yoloTagPickingMode) => set({ yoloTagPickingMode }),
  tagScanResults: null,
  setTagScanResults: (tagScanResults) => set({ tagScanResults }),
  tagAddingMode: null,
  setTagAddingMode: (tagAddingMode) => set({ tagAddingMode }),

  symbolSearchActive: false,
  setSymbolSearchActive: (symbolSearchActive) =>
    set(
      symbolSearchActive
        ? { symbolSearchActive, mode: "move" as const, bucketFillActive: false, bucketFillPreview: null, bucketFillLoading: false, bucketFillBarrierMode: false, splitAreaActive: false, splitLineA: null, splitLineB: null, splitPreview: null, splitError: null }
        : { symbolSearchActive }
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
  symbolSearchPreset: "lite",
  setSymbolSearchPreset: (preset) => {
    const config = preset === "power"
      ? { scaleMin: 0.5, scaleMax: 2.0, nmsThreshold: 0.2 }
      : { scaleMin: 0.8, scaleMax: 1.5, nmsThreshold: 0.3 };
    set((s) => ({
      symbolSearchPreset: preset,
      symbolSearchConfig: { ...s.symbolSearchConfig, ...config },
    }));
  },
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

  // Universal tool-state tear-down. Composes the reset primitives instead of
  // inlining field lists so each subsystem stays the owner of its own cleanup
  // shape. Called from parent-panel toggles (Parse, Detection, Table, Keynote)
  // on close, and from cancel buttons inside parse panels. Explicitly does NOT
  // touch uiStore presentation, takeoffs, or parsedKeynoteData. Annotation groups + annotations
  // live in project-keyed Query caches (P2.2⑤/⑥) and are equally untouched. Saved work and
  // multi-select presentation therefore survive a tool reset exactly as before.
  resetAllTools: () => {
    const s = get();
    s.setMode("move");          // clears bucket/split/symbol-active/polygon/tempPan
    s.resetTableParse();
    s.resetKeynoteParse();
    s.resetNotesParse();
    s.resetSpecParse();
    s.resetGuidedParse();
    s.clearSymbolSearch();
  },

  _drawing: false,
  _drawStart: { x: 0, y: 0 },
  _drawEnd: { x: 0, y: 0 },
  _mousePos: null,
  _setDrawing: (_drawing) => set({ _drawing }),
  _setDrawStart: (_drawStart) => set({ _drawStart }),
  _setDrawEnd: (_drawEnd) => set({ _drawEnd }),
  _setMousePos: (_mousePos) => set({ _mousePos }),

  resetViewerState: () =>
    set({
      // [refactor jul11 P2.2⑥] annotations reset deleted: loader seeds the publicId-keyed cache
      // unconditionally before reveal; the coordinator's preceding session reset re-keys observers.
      // [refactor jul11 P2.3] session identity/page-label fields and csiGraph are reset by the
      // neutral viewerCommands.resetProjectData coordinator, not this leaf store.
      // [refactor jul10 P2.2③] `summaries: null` reset line deleted — summaries live in the query
      // cache now (publicId-keyed entries give free cross-project isolation; the old key's entry
      // persists but is unobservable: resetProjectData resets session identity first, and consumers
      // are unmounted behind the loaders' `loading` gates until the fresh seed lands).
      allTrades: [],
      allCsiCodes: [],
      // takeoffItems/takeoffGroups: cache-backed since P2.2④ — reset deliberately does NOT
      // touch the query cache (RECIPE step 7; publicId-keyed isolation makes it unnecessary).
      activeTakeoffItemId: null,
      activeQtoWorkflow: null,
      // qtoWorkflows: cache-backed since P2.2② — reset deliberately does NOT touch the query
      // cache (RECIPE step 7; publicId-keyed isolation makes it unnecessary, SPEC §7).
      scaleCalibrations: {},
      calibrationMode: "idle",
      calibrationPoints: {},
      polygonDrawingMode: "idle",
      polygonVertices: [],
      tableParseTab: "all",
      tableParseStep: "idle",
      tableParseRegion: null,
      tableParsedGrid: null,
      tableParseMeta: null,
      tableParseColumnBBs: [],
      tableParseColumnNames: [],
      tableParseRowBBs: [],
      keynoteParseTab: "all",
      keynoteParseStep: "idle",
      keynoteParseRegion: null,
      keynoteColumnBBs: [],
      keynoteRowBBs: [],
      keynoteYoloClass: null,
      parsedKeynoteData: null,
      // Stage 3 scaffold — reset on project change so slices don't leak across projects
      notesParseStep: "idle",
      notesParseRegion: null,
      guidedNotesRows: [],
      guidedNotesCols: [],
      specParseStep: "idle",
      specParseRegion: null,
      guidedSpecSectionBBs: [],
      parseDraftRegion: null,
      notesFastManualActive: false,
      notesFastManualGrid: null,
      paragraphOverlayActive: false,
      paragraphBatch: [],
      paragraphClipboard: null,
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
      symbolSearchConfig: { multiScale: true, useSiftFallback: true, searchPages: null, scaleMin: 0.8, scaleMax: 1.5, nmsThreshold: 0.3, maxMatchesPerPage: 50 },
      symbolSearchPreset: "lite" as const,
      bucketFillResolution: 1000 as const,
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
// These remaining grouped selectors cover residual tool/parse sessions. Page/zoom/dimensions live
// in viewerCoreStore and presentation lives in uiStore; do not rebuild cross-owner mega-slices here.
//
// Per REFACTORING_RESEARCH.md Part 1: "Store Slices + Bridge"

import { useShallow } from "zustand/react/shallow";

// [refactor jul10 P2.2⑤] useAnnotationGroups selector DELETED — the facade now lives in
// src/queries/useAnnotationGroups.ts (same name, 5-member live shape; the 4 dead members
// dropped per SPEC §5-E7). Consumers changed only their import line.

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
    symbolSearchPreset: s.symbolSearchPreset,
    setSymbolSearchPreset: s.setSymbolSearchPreset,
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
    setTableParseRowBBs: s.setTableParseRowBBs,
    tableParseColumnNames: s.tableParseColumnNames,
    setTableParseColumnNames: s.setTableParseColumnNames,
    tableParseTab: s.tableParseTab,
    setTableParseTab: s.setTableParseTab,
    tableParseOptions: s.tableParseOptions,
    setTableParseOptions: s.setTableParseOptions,
    resetTableParse: s.resetTableParse,
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

/** Project-wide CSI catalog. Its active display filter lives in uiStore. */
export const usePageData = () =>
  useViewerStore(useShallow((s) => ({
    allCsiCodes: s.allCsiCodes,
  })));

// [refactor jul10 P2.2②] useQtoWorkflow selector DELETED — its sole consumer (AutoQtoTab) now
// uses the cache facade src/queries/useQtoWorkflows.ts, which also surfaces the zustand-resident
// activeQtoWorkflow pair. (Unlike chat's useChat, no second caller kept a slice alive.)

// [refactor jul11 P2.2⑦] useSummaries remains a cache-only compatibility name in
// src/queries/useSummaries.ts. Its temporary loaded-range/loading passthrough was removed with the
// legacy window fields; consumers needing range or status use the page-window facade/controller.
