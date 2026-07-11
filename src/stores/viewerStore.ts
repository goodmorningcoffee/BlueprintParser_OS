import { create } from "zustand";
import type {
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

interface ViewerState {
  // [refactor jul10 P2.2⑤] annotation groups + the M:N membership indexes moved to the
  // TanStack Query cache — see src/queries/useAnnotationGroups.ts (ONE key holds the raw
  // {groups, memberships} payload; the forward/reverse Set indexes are derived in-hook).
  // The old fields (annotationGroups / annotationGroupMemberships / groupMembers) and their
  // 6 actions are DELETED, not bridged; 4 of the 9 selector members were dead surface (E7).

  // [refactor jul11 P2.3] Project identity, demo policy, page labels, and labeling-session state
  // live in sessionStore. The residual csiGraph bootstrap value lives in useCsiGraph. Do not add
  // project/session data back to this residual metadata/parse/drawing store.

  // [refactor jul11 P2.2⑦/⑧] Active page-window maps and per-page Textract OCR are query-owned.
  // Only project-wide bootstrap metadata from those former server-data slices remains here.
  allTrades: string[];
  setAllTrades: (trades: string[]) => void;

  // ─── CSI project metadata ─────────────────────────────────
  allCsiCodes: { code: string; description: string }[];
  setAllCsiCodes: (codes: { code: string; description: string }[]) => void;

  // ─── Auto-QTO ────────────────────────────────────────────
  // [refactor jul10 P2.2②] qtoWorkflows COLLECTION moved to the TanStack cache
  // (src/queries/useQtoWorkflows.ts). The active pointer stays here: it is a UI-selection /
  // in-progress draft, not a server collection (P2_DESIGN/QTO_IMPL/SPEC.md §3).
  activeQtoWorkflow: QtoWorkflow | null;
  setActiveQtoWorkflow: (w: QtoWorkflow | null) => void;

  // ─── Table Parse ───────────────────────────────────────
  tableParseStep: "idle" | "select-region" | "define-column" | "define-row" | "review";
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
  /** Remaining metadata/parse/drawing reset. Call resetProjectData from viewerCommands. */
  resetViewerState: () => void;
}

export const useViewerStore = create<ViewerState>((set) => ({
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

  // ─── Auto-QTO ──────────────────────────────────────────── (collection → query cache, P2.2②)
  activeQtoWorkflow: null,
  setActiveQtoWorkflow: (activeQtoWorkflow) => set({ activeQtoWorkflow }),

  tableParseStep: "idle",
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
      activeQtoWorkflow: null,
      // qtoWorkflows: cache-backed since P2.2② — reset deliberately does NOT touch the query
      // cache (RECIPE step 7; publicId-keyed isolation makes it unnecessary, SPEC §7).
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
      guidedParseActive: false,
      guidedParseRegion: null,
      guidedParseRows: [],
      guidedParseCols: [],
    }),
}));

// ═══════════════════════════════════════════════════════════════════
// Typed Slice Selectors
// ═══════════════════════════════════════════════════════════════════
//
// These grouped selectors cover residual parse sessions. Tool state lives in toolStore,
// page/zoom/dimensions in viewerCoreStore, and presentation in uiStore.
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

/** Table parse state */
export const useTableParse = () =>
  useViewerStore(useShallow((s) => ({
    tableParseStep: s.tableParseStep,
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
