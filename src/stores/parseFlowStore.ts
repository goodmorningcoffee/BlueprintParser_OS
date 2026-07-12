import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

import {
  createParseOperationRegistry,
  invalidateParseOperationKinds,
  PARSE_KINDS,
  type BeginParseOperationPolicy,
  type BeginParseOperationResult,
  type ParseKind,
  type ParseOperationRegistry,
  type ParseOperationToken,
} from "@/lib/parse-operation-state";
import type { ParsedRegion, TextractLine } from "@/types";

/**
 * [refactor jul11 P2.4 S2] Sole leaf owner for transient Table, Keynote, Notes, and Spec parsing.
 *
 * S1 staged this contract production-dead; S2 moved every borrower atomically and deleted the
 * legacy Viewer copy. Keep the leaf dependency-free: the four set*ParseStep commands remain in
 * viewerCommands because idle-to-active entry also writes the tool owner. Do not import a sibling
 * store, Query facade, command, or UI concern here.
 */

/** Stage 5 Phase 2.5 — a paragraph committed by the user via ParagraphOverlay.
 * Lives in a batch until Save Spec / Save Note promotes it to a ParsedRegion. */
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

export interface ParseFlowState {
  // ─── Table Parse ───────────────────────────────────────
  tableParseStep: "idle" | "select-region" | "define-column" | "define-row" | "review";
  tableParseRegion: [number, number, number, number] | null;
  setTableParseRegion: (bbox: [number, number, number, number] | null) => void;
  tableParsedGrid: {
    headers: string[];
    rows: Record<string, string>[];
    tagColumn?: string;
    tableName?: string;
    csiTags?: { code: string; description: string }[];
    colBoundaries?: number[];
    rowBoundaries?: number[];
  } | null;
  setTableParsedGrid: (grid: ParseFlowState["tableParsedGrid"]) => void;
  /** Per-method grids plus the auto-picked merged snapshot. Live-only and not persisted. */
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
    mergedSnapshot: {
      headers: string[];
      rows: Record<string, string>[];
      tagColumn?: string;
      colBoundaries?: number[];
      rowBoundaries?: number[];
    };
  } | null;
  setTableParseMeta: (meta: ParseFlowState["tableParseMeta"]) => void;
  tableCellStructure: {
    cells: Array<{
      bbox: [number, number, number, number];
      row: number;
      col: number;
      rowSpan: number;
      colSpan: number;
      type: string;
      confidence: number;
      text: string;
      highlighted: boolean;
    }>;
    pageNumber: number;
    regionBbox: [number, number, number, number];
  } | null;
  setTableCellStructure: (structure: ParseFlowState["tableCellStructure"]) => void;
  toggleCellHighlight: (row: number, col: number) => void;
  showTableCellStructure: boolean;
  setShowTableCellStructure: (show: boolean) => void;
  tableParseColumnBBs: [number, number, number, number][];
  addTableParseColumnBB: (bb: [number, number, number, number]) => void;
  tableParseColumnNames: string[];
  setTableParseColumnNames: (names: string[]) => void;
  tableParseRowBBs: [number, number, number, number][];
  addTableParseRowBB: (bb: [number, number, number, number]) => void;
  setTableParseRowBBs: (bbs: [number, number, number, number][]) => void;
  resetTableParse: () => void;
  tableParseTab: "all" | "auto" | "guided" | "manual" | "compare";
  setTableParseTab: (tab: "all" | "auto" | "guided" | "manual" | "compare") => void;
  tableParseOptions: {
    rowTolerance: number;
    minColGap: number;
    colHitRatio: number;
    headerMode: "auto" | "first" | "none";
    minHLineLengthRatio: number;
    minVLineLengthRatio: number;
    clusteringTolerance: number;
    mergerEditDistance: number;
  };
  setTableParseOptions: (patch: Partial<ParseFlowState["tableParseOptions"]>) => void;

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
  parsedKeynoteData: Array<{
    pageNumber: number;
    keys: { key: string; description: string }[];
    yoloClass?: string;
    tableName?: string;
  }> | null;
  setParsedKeynoteData: (data: ParseFlowState["parsedKeynoteData"]) => void;
  addParsedKeynote: (entry: NonNullable<ParseFlowState["parsedKeynoteData"]>[number]) => void;
  resetKeynoteParse: () => void;

  // ─── Notes Parse ──────────────────────────────────────
  notesParseStep: "idle" | "select-region" | "define-column" | "define-row" | "review";
  notesParseRegion: [number, number, number, number] | null;
  setNotesParseRegion: (bbox: [number, number, number, number] | null) => void;
  guidedNotesRows: [number, number, number, number][];
  addGuidedNotesRow: (bb: [number, number, number, number]) => void;
  guidedNotesCols: [number, number, number, number][];
  addGuidedNotesCol: (bb: [number, number, number, number]) => void;
  resetNotesParse: () => void;

  // ─── Shared parse draft ───────────────────────────────
  /** Transient preview rendered by ParseRegionLayer; never persisted. */
  parseDraftRegion: ParsedRegion | null;
  setParseDraftRegion: (region: ParsedRegion | null) => void;

  notesFastManualActive: boolean;
  setNotesFastManualActive: (active: boolean) => void;
  notesFastManualGrid: {
    headers: string[];
    rows: Record<string, string>[];
    colBoundaries?: number[];
    rowBoundaries?: number[];
  } | null;
  setNotesFastManualGrid: (grid: ParseFlowState["notesFastManualGrid"]) => void;

  // ─── Spec Parse ───────────────────────────────────────
  specParseStep: "idle" | "select-region" | "define-sections" | "review";
  specParseRegion: [number, number, number, number] | null;
  setSpecParseRegion: (bbox: [number, number, number, number] | null) => void;
  guidedSpecSectionBBs: [number, number, number, number][];
  addGuidedSpecSectionBB: (bb: [number, number, number, number]) => void;
  resetSpecParse: () => void;

  // ─── Shared paragraph workspace ───────────────────────
  paragraphOverlayActive: boolean;
  setParagraphOverlayActive: (active: boolean) => void;
  paragraphBatch: PendingParagraph[];
  setParagraphBatch: (batch: PendingParagraph[]) => void;
  upsertPendingParagraph: (paragraph: PendingParagraph) => void;
  removePendingParagraph: (id: string) => void;
  paragraphClipboard: ParagraphTemplate | null;
  setParagraphClipboard: (template: ParagraphTemplate | null) => void;

  // ─── Shared guided grid ───────────────────────────────
  guidedParseActive: boolean;
  guidedParseRegion: [number, number, number, number] | null;
  guidedParseRows: number[];
  guidedParseCols: number[];
  setGuidedParseActive: (active: boolean) => void;
  setGuidedParseRegion: (region: [number, number, number, number] | null) => void;
  setGuidedParseRows: (rows: number[]) => void;
  setGuidedParseCols: (cols: number[]) => void;
  resetGuidedParse: () => void;

  // ─── Per-kind async operation authority (A2 additive contract) ───
  parseOperations: ParseOperationRegistry;
  beginParseOperation: <K extends ParseKind>(
    kind: K,
    policy?: BeginParseOperationPolicy,
  ) => BeginParseOperationResult<K>;
  isParseOperationCurrent: (token: ParseOperationToken) => boolean;
  finishParseOperation: (token: ParseOperationToken) => boolean;
  invalidateParseOperation: (kind: ParseKind) => void;

  /**
   * Project-reset seam. It intentionally preserves the characterized three-field policy:
   * tableCellStructure, showTableCellStructure, and tableParseOptions retain their references.
   */
  resetProjectParseState: () => void;
}

export const useParseFlowStore = create<ParseFlowState>((set, get) => ({
  tableParseStep: "idle",
  tableParseRegion: null,
  setTableParseRegion: (tableParseRegion) => set({ tableParseRegion }),
  tableParsedGrid: null,
  setTableParsedGrid: (tableParsedGrid) => set({ tableParsedGrid }),
  tableParseMeta: null,
  setTableParseMeta: (tableParseMeta) => set({ tableParseMeta }),
  tableCellStructure: null,
  setTableCellStructure: (tableCellStructure) =>
    set({ tableCellStructure, showTableCellStructure: tableCellStructure !== null }),
  showTableCellStructure: false,
  setShowTableCellStructure: (showTableCellStructure) => set({ showTableCellStructure }),
  toggleCellHighlight: (row, col) => set((state) => {
    // Legacy oddity: even no structure returns an empty patch and therefore publishes once.
    if (!state.tableCellStructure) return {};
    return {
      tableCellStructure: {
        ...state.tableCellStructure,
        cells: state.tableCellStructure.cells.map((cell) =>
          cell.row === row && cell.col === col
            ? { ...cell, highlighted: !cell.highlighted }
            : cell
        ),
      },
    };
  }),
  tableParseColumnBBs: [],
  addTableParseColumnBB: (bb) =>
    set((state) => ({ tableParseColumnBBs: [...state.tableParseColumnBBs, bb] })),
  tableParseColumnNames: [],
  setTableParseColumnNames: (tableParseColumnNames) => set({ tableParseColumnNames }),
  tableParseRowBBs: [],
  addTableParseRowBB: (bb) =>
    set((state) => ({ tableParseRowBBs: [...state.tableParseRowBBs, bb] })),
  setTableParseRowBBs: (tableParseRowBBs) => set({ tableParseRowBBs }),
  resetTableParse: () => set((state) => ({
    tableParseStep: "idle",
    tableParseRegion: null,
    tableParsedGrid: null,
    tableParseMeta: null,
    tableCellStructure: null,
    tableParseColumnBBs: [],
    tableParseColumnNames: [],
    tableParseRowBBs: [],
    // Intentionally retain showTableCellStructure, tab, and options.
    parseOperations: invalidateParseOperationKinds(state.parseOperations, ["table"]),
  })),
  tableParseTab: "all",
  setTableParseTab: (tableParseTab) => set({ tableParseTab }),
  tableParseOptions: {
    rowTolerance: 0.006,
    minColGap: 0.015,
    colHitRatio: 0.3,
    headerMode: "auto",
    minHLineLengthRatio: 0.15,
    minVLineLengthRatio: 0.10,
    clusteringTolerance: 15,
    mergerEditDistance: 2,
  },
  setTableParseOptions: (patch) =>
    set((state) => ({ tableParseOptions: { ...state.tableParseOptions, ...patch } })),

  keynoteParseTab: "all",
  setKeynoteParseTab: (keynoteParseTab) => set({ keynoteParseTab }),
  keynoteParseStep: "idle",
  keynoteParseRegion: null,
  setKeynoteParseRegion: (keynoteParseRegion) => set({ keynoteParseRegion }),
  keynoteColumnBBs: [],
  addKeynoteColumnBB: (bb) =>
    set((state) => ({ keynoteColumnBBs: [...state.keynoteColumnBBs, bb] })),
  keynoteRowBBs: [],
  addKeynoteRowBB: (bb) =>
    set((state) => ({ keynoteRowBBs: [...state.keynoteRowBBs, bb] })),
  keynoteYoloClass: null,
  setKeynoteYoloClass: (keynoteYoloClass) => set({ keynoteYoloClass }),
  parsedKeynoteData: null,
  setParsedKeynoteData: (parsedKeynoteData) => set({ parsedKeynoteData }),
  addParsedKeynote: (entry) => set((state) => ({
    parsedKeynoteData: [...(state.parsedKeynoteData || []), entry],
  })),
  resetKeynoteParse: () => set((state) => ({
    keynoteParseStep: "idle",
    keynoteParseRegion: null,
    keynoteColumnBBs: [],
    keynoteRowBBs: [],
    keynoteYoloClass: null,
    // Intentionally retain keynoteParseTab and parsedKeynoteData.
    parseOperations: invalidateParseOperationKinds(state.parseOperations, ["keynote"]),
  })),

  notesParseStep: "idle",
  notesParseRegion: null,
  setNotesParseRegion: (notesParseRegion) => set({ notesParseRegion }),
  guidedNotesRows: [],
  addGuidedNotesRow: (bb) =>
    set((state) => ({ guidedNotesRows: [...state.guidedNotesRows, bb] })),
  guidedNotesCols: [],
  addGuidedNotesCol: (bb) =>
    set((state) => ({ guidedNotesCols: [...state.guidedNotesCols, bb] })),
  resetNotesParse: () => set((state) => ({
    notesParseStep: "idle",
    notesParseRegion: null,
    guidedNotesRows: [],
    guidedNotesCols: [],
    parseDraftRegion: null,
    paragraphOverlayActive: false,
    paragraphBatch: [],
    // Fast-manual state, clipboard, and the shared guided grid intentionally survive.
    parseOperations: invalidateParseOperationKinds(state.parseOperations, ["notes"]),
  })),

  parseDraftRegion: null,
  setParseDraftRegion: (parseDraftRegion) => set({ parseDraftRegion }),
  notesFastManualActive: false,
  setNotesFastManualActive: (notesFastManualActive) => set({ notesFastManualActive }),
  notesFastManualGrid: null,
  setNotesFastManualGrid: (notesFastManualGrid) => set({ notesFastManualGrid }),

  specParseStep: "idle",
  specParseRegion: null,
  setSpecParseRegion: (specParseRegion) => set({ specParseRegion }),
  guidedSpecSectionBBs: [],
  addGuidedSpecSectionBB: (bb) =>
    set((state) => ({ guidedSpecSectionBBs: [...state.guidedSpecSectionBBs, bb] })),
  resetSpecParse: () => set((state) => ({
    specParseStep: "idle",
    specParseRegion: null,
    guidedSpecSectionBBs: [],
    parseDraftRegion: null,
    paragraphOverlayActive: false,
    paragraphBatch: [],
    // Clipboard intentionally survives. Notes and Spec each publish their own fresh batch reset.
    parseOperations: invalidateParseOperationKinds(state.parseOperations, ["spec"]),
  })),

  paragraphOverlayActive: false,
  setParagraphOverlayActive: (paragraphOverlayActive) => set({ paragraphOverlayActive }),
  paragraphBatch: [],
  setParagraphBatch: (paragraphBatch) => set({ paragraphBatch }),
  upsertPendingParagraph: (paragraph) => set((state) => {
    const index = state.paragraphBatch.findIndex((current) => current.id === paragraph.id);
    if (index === -1) return { paragraphBatch: [...state.paragraphBatch, paragraph] };
    const next = state.paragraphBatch.slice();
    next[index] = paragraph;
    return { paragraphBatch: next };
  }),
  removePendingParagraph: (id) => set((state) => ({
    // filter intentionally allocates even when the id is absent.
    paragraphBatch: state.paragraphBatch.filter((paragraph) => paragraph.id !== id),
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
  resetGuidedParse: () => set({
    guidedParseActive: false,
    guidedParseRegion: null,
    guidedParseRows: [],
    guidedParseCols: [],
  }),

  parseOperations: createParseOperationRegistry(),
  beginParseOperation: <K extends ParseKind>(
    kind: K,
    policy: BeginParseOperationPolicy = "reject",
  ): BeginParseOperationResult<K> => {
    let result: BeginParseOperationResult<K> = { status: "busy" };
    set((state) => {
      const current = state.parseOperations[kind];
      if (current.busy && policy === "reject") return state;

      const revision = current.revision + 1;
      result = { status: "started", token: { kind, revision } };
      return {
        parseOperations: {
          ...state.parseOperations,
          [kind]: { revision, busy: true },
        },
      };
    });
    return result;
  },
  isParseOperationCurrent: (token) => {
    const current = get().parseOperations[token.kind];
    return current.busy && current.revision === token.revision;
  },
  finishParseOperation: (token) => {
    let finished = false;
    set((state) => {
      const current = state.parseOperations[token.kind];
      if (!current.busy || current.revision !== token.revision) return state;

      finished = true;
      return {
        parseOperations: {
          ...state.parseOperations,
          [token.kind]: { revision: current.revision, busy: false },
        },
      };
    });
    return finished;
  },
  invalidateParseOperation: (kind) => set((state) => ({
    parseOperations: invalidateParseOperationKinds(state.parseOperations, [kind]),
  })),

  resetProjectParseState: () => set((state) => ({
    // Exact legacy project-reset policy: 32 touched, with three Table fields retained above.
    // A2 adds only the monotonic four-kind invalidation below; no legacy survival policy changes.
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
    notesParseStep: "idle",
    notesParseRegion: null,
    guidedNotesRows: [],
    guidedNotesCols: [],
    notesFastManualActive: false,
    notesFastManualGrid: null,
    parseDraftRegion: null,
    specParseStep: "idle",
    specParseRegion: null,
    guidedSpecSectionBBs: [],
    paragraphOverlayActive: false,
    paragraphBatch: [],
    paragraphClipboard: null,
    guidedParseActive: false,
    guidedParseRegion: null,
    guidedParseRows: [],
    guidedParseCols: [],
    parseOperations: invalidateParseOperationKinds(state.parseOperations, PARSE_KINDS),
  })),
}));

/** Exact legacy 17-member Table grouped surface. Step writes remain neutral commands. */
export const useTableParse = () =>
  useParseFlowStore(useShallow((state) => ({
    tableParseStep: state.tableParseStep,
    tableParseRegion: state.tableParseRegion,
    setTableParseRegion: state.setTableParseRegion,
    tableParsedGrid: state.tableParsedGrid,
    setTableParsedGrid: state.setTableParsedGrid,
    tableParseColumnBBs: state.tableParseColumnBBs,
    addTableParseColumnBB: state.addTableParseColumnBB,
    tableParseRowBBs: state.tableParseRowBBs,
    addTableParseRowBB: state.addTableParseRowBB,
    setTableParseRowBBs: state.setTableParseRowBBs,
    tableParseColumnNames: state.tableParseColumnNames,
    setTableParseColumnNames: state.setTableParseColumnNames,
    tableParseTab: state.tableParseTab,
    setTableParseTab: state.setTableParseTab,
    tableParseOptions: state.tableParseOptions,
    setTableParseOptions: state.setTableParseOptions,
    resetTableParse: state.resetTableParse,
  })));

/**
 * [refactor jul11 P2.4 A1] Cold-panel Table fields outside the shared lifecycle facade.
 * Sacred AnnotationOverlay keeps the legacy combined hook; migrated panels compose this extension
 * bundle with `useParseFlow("table")` so lifecycle and Table-only state stay independently typed.
 */
export const useTableParseExtensions = () =>
  useParseFlowStore(useShallow((state) => ({
    tableParsedGrid: state.tableParsedGrid,
    setTableParsedGrid: state.setTableParsedGrid,
    tableParseColumnBBs: state.tableParseColumnBBs,
    addTableParseColumnBB: state.addTableParseColumnBB,
    tableParseRowBBs: state.tableParseRowBBs,
    addTableParseRowBB: state.addTableParseRowBB,
    setTableParseRowBBs: state.setTableParseRowBBs,
    tableParseColumnNames: state.tableParseColumnNames,
    setTableParseColumnNames: state.setTableParseColumnNames,
    tableParseTab: state.tableParseTab,
    setTableParseTab: state.setTableParseTab,
    tableParseOptions: state.tableParseOptions,
    setTableParseOptions: state.setTableParseOptions,
  })));

/** Exact legacy 21-member Keynote + shared-guided grouped surface. */
export const useKeynoteParse = () =>
  useParseFlowStore(useShallow((state) => ({
    keynoteParseStep: state.keynoteParseStep,
    keynoteParseRegion: state.keynoteParseRegion,
    setKeynoteParseRegion: state.setKeynoteParseRegion,
    keynoteColumnBBs: state.keynoteColumnBBs,
    addKeynoteColumnBB: state.addKeynoteColumnBB,
    keynoteRowBBs: state.keynoteRowBBs,
    addKeynoteRowBB: state.addKeynoteRowBB,
    keynoteParseTab: state.keynoteParseTab,
    setKeynoteParseTab: state.setKeynoteParseTab,
    keynoteYoloClass: state.keynoteYoloClass,
    setKeynoteYoloClass: state.setKeynoteYoloClass,
    resetKeynoteParse: state.resetKeynoteParse,
    guidedParseActive: state.guidedParseActive,
    setGuidedParseActive: state.setGuidedParseActive,
    guidedParseRegion: state.guidedParseRegion,
    setGuidedParseRegion: state.setGuidedParseRegion,
    guidedParseRows: state.guidedParseRows,
    setGuidedParseRows: state.setGuidedParseRows,
    guidedParseCols: state.guidedParseCols,
    setGuidedParseCols: state.setGuidedParseCols,
    resetGuidedParse: state.resetGuidedParse,
  })));

/**
 * [refactor jul11 P2.4 A1] Keynote-only state outside the common lifecycle and shared grid.
 * Event-time deletion keeps its imperative `setParsedKeynoteData` read so a render snapshot cannot
 * overwrite a newer table; the hook exposes only the render-reactive fields used by cold panels.
 */
export const useKeynoteParseExtensions = () =>
  useParseFlowStore(useShallow((state) => ({
    keynoteParseTab: state.keynoteParseTab,
    setKeynoteParseTab: state.setKeynoteParseTab,
    keynoteColumnBBs: state.keynoteColumnBBs,
    addKeynoteColumnBB: state.addKeynoteColumnBB,
    keynoteRowBBs: state.keynoteRowBBs,
    addKeynoteRowBB: state.addKeynoteRowBB,
    keynoteYoloClass: state.keynoteYoloClass,
    setKeynoteYoloClass: state.setKeynoteYoloClass,
    parsedKeynoteData: state.parsedKeynoteData,
    addParsedKeynote: state.addParsedKeynote,
  })));

/**
 * Shared proposed-grid workspace used by Table guided parsing and Keynote guided parsing.
 * It deliberately has no parse kind: the flat owner permits dormant cross-kind reuse, so callers
 * compose this beside a lifecycle facade instead of pretending the workspace belongs to Keynote.
 */
export const useGuidedParseExtensions = () =>
  useParseFlowStore(useShallow((state) => ({
    guidedParseActive: state.guidedParseActive,
    setGuidedParseActive: state.setGuidedParseActive,
    guidedParseRegion: state.guidedParseRegion,
    setGuidedParseRegion: state.setGuidedParseRegion,
    guidedParseRows: state.guidedParseRows,
    setGuidedParseRows: state.setGuidedParseRows,
    guidedParseCols: state.guidedParseCols,
    setGuidedParseCols: state.setGuidedParseCols,
    resetGuidedParse: state.resetGuidedParse,
  })));

/** Notes-only render inputs; shared draft/guided/paragraph workspaces stay separate. */
export const useNotesParseExtensions = () =>
  useParseFlowStore(useShallow((state) => ({
    guidedNotesRows: state.guidedNotesRows,
    guidedNotesCols: state.guidedNotesCols,
    notesFastManualGrid: state.notesFastManualGrid,
  })));

/**
 * Shared draft writer for Notes and Spec cold panels. The draft value remains a sacred primitive
 * canvas read, so writers do not subscribe to and rerender for their own preview publications.
 */
export const useParseDraftExtensions = () =>
  useParseFlowStore(useShallow((state) => ({
    setParseDraftRegion: state.setParseDraftRegion,
  })));

/**
 * Shared Notes/Spec paragraph workspace used by cold parsers. Overlay visibility and clipboard
 * values stay out: PDFPage and ParagraphOverlay retain their exact hot-path projections.
 */
export const useParagraphWorkspaceExtensions = () =>
  useParseFlowStore(useShallow((state) => ({
    paragraphBatch: state.paragraphBatch,
    setParagraphBatch: state.setParagraphBatch,
    removePendingParagraph: state.removePendingParagraph,
    upsertPendingParagraph: state.upsertPendingParagraph,
    setParagraphOverlayActive: state.setParagraphOverlayActive,
  })));
