// @vitest-environment node
// P2.5 freeze-first contract: project switches reset project-owned data while preserving only
// explicitly presentation-scoped UI preferences. It was introduced RED against the P2.3
// compatibility reset and remains the executable P2.5 survival ledger.

import { beforeEach, describe, expect, it } from "vitest";

import { useParseFlowStore, type ParseFlowState } from "@/stores/parseFlowStore";
import { useSessionStore, type SessionData } from "@/stores/sessionStore";
import { useToolStore, type ToolStoreData } from "@/stores/toolStore";
import { useUiStore, type UiData } from "@/stores/uiStore";
import { useViewerCoreStore, type ViewerCoreData } from "@/stores/viewerCoreStore";
import { resetProjectData } from "@/stores/viewerCommands";
import type { ClientAnnotation, ScaleCalibrationData } from "@/types";

const SESSION_KEYS = [
  "projectId",
  "publicId",
  "dataUrl",
  "isDemo",
  "demoFeatureConfig",
  "pageNames",
  "pageDrawingNumbers",
  "showLabelingWizard",
  "labelingWizardStep",
  "labelingSessions",
  "labelingCredentials",
] as const satisfies readonly (keyof SessionData)[];

const CORE_KEYS = [
  "pageNumber",
  "numPages",
  "scale",
  "pendingCenter",
  "pageDimensions",
] as const satisfies readonly (keyof ViewerCoreData)[];

const TOOL_KEYS = [
  "mode", "tempPanMode", "activeTool", "_drawing", "_drawStart", "_drawEnd", "_mousePos",
  "activeTakeoffItemId", "scaleCalibrations", "calibrationMode", "calibrationPoints",
  "polygonDrawingMode", "polygonVertices", "bucketFillPreview", "bucketFillLoading",
  "bucketFillError", "bucketFillTolerance", "bucketFillDilatePx", "bucketFillResolution",
  "bucketFillPendingPolygon", "splitLineA", "splitLineB", "splitPreview", "splitError",
  "bucketFillBarriers", "bucketFillBarrierMode", "barrierPendingPoint", "takeoffUndoStack",
  "takeoffRedoStack", "tagScanResults", "symbolSearchLoading", "symbolSearchProgress",
  "symbolSearchResults", "symbolSearchConfidence", "dismissedSymbolMatches", "symbolSearchError",
  "symbolSearchTemplateBbox", "symbolSearchSourcePage", "symbolSearchConfig", "symbolSearchPreset",
] as const satisfies readonly (keyof ToolStoreData)[];

const PARSE_KEYS = [
  "tableParseStep", "tableParseRegion", "tableParsedGrid", "tableParseMeta",
  "tableCellStructure", "showTableCellStructure", "tableParseColumnBBs",
  "tableParseColumnNames", "tableParseRowBBs", "tableParseTab", "tableParseOptions",
  "keynoteParseTab", "keynoteParseStep", "keynoteParseRegion", "keynoteColumnBBs",
  "keynoteRowBBs", "keynoteYoloClass", "parsedKeynoteData", "notesParseStep",
  "notesParseRegion", "guidedNotesRows", "guidedNotesCols", "notesFastManualActive",
  "notesFastManualGrid", "parseDraftRegion", "specParseStep", "specParseRegion",
  "paragraphWorkspaceOwner", "paragraphBatch", "paragraphClipboard", "guidedParseOwner",
  "guidedParseActive", "guidedParseRegion", "guidedParseRows", "guidedParseCols",
] as const satisfies readonly (keyof ParseFlowState)[];

const UI_SURVIVE_KEYS = [
  "showTextAnnotations",
  "textAnnotationColors",
  "textPanelTab",
  "sidebarCollapsed",
  "annotationPanelCollapsed",
  "showTips",
  "helpMode",
  "showTextPanel",
  "showChatPanel",
  "showDetections",
  "showDetectionPanel",
  "showViewAllPanel",
  "showCsiPanel",
  "showPageIntelPanel",
  "showTakeoffPanel",
  "showTableParsePanel",
  "showKeynoteParsePanel",
  "showSpecsNotesPanel",
  "showParsePanel",
  "showToolsPanel",
  "showTableCompareModal",
  "specsNotesTab",
  "parsePanelTab",
  "toolsPanelTab",
  "chatScope",
  "showKeynotes",
  "takeoffTab",
  "showParsedRegions",
  "parsedRegionColorMode",
] as const satisfies readonly (keyof UiData)[];

const UI_RESET_KEYS = [
  "searchQuery",
  "searchResults",
  "searchMatches",
  "searchLoading",
  "focusAnnotationId",
  "selectedAnnotationIds",
  "activeTextAnnotationTypes",
  "hiddenTextAnnotations",
  "activeTextAnnotationFilter",
  "activeMarkupId",
  "activeTakeoffFilter",
  "activeKeynoteFilter",
  "activeAnnotationFilter",
  "activeTradeFilter",
  "activeCsiFilter",
  "activeModels",
  "confidenceThreshold",
  "confidenceThresholds",
  "hiddenAnnotationIds",
  "hiddenClasses",
  "activeKeynoteHighlight",
  "hiddenTakeoffItemIds",
  "activeYoloTagId",
  "yoloTagVisibility",
  "activeYoloTagFilter",
  "activeTableTagViews",
  "tagBrowseId",
  "tagBrowseIndex",
  "llmHighlight",
  "hiddenParsedRegionIds",
  "focusedParsedRegionId",
  "activeQtoWorkflow",
] as const satisfies readonly (keyof UiData)[];

type ParseDataKey = (typeof PARSE_KEYS)[number];

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

const TOOL_DIRTY = {
  mode: "markup",
  tempPanMode: true,
  activeTool: { kind: "tagAdd", tagId: "tag-91" },
  _drawing: true,
  _drawStart: { x: 11, y: 12 },
  _drawEnd: { x: 13, y: 14 },
  _mousePos: { x: 15, y: 16 },
  activeTakeoffItemId: 91,
  scaleCalibrations: { 3: CALIBRATION },
  calibrationMode: "input",
  calibrationPoints: { p1: { x: 0.1, y: 0.2 }, p2: { x: 0.7, y: 0.8 } },
  polygonDrawingMode: "drawing",
  polygonVertices: [{ x: 0.1, y: 0.2 }],
  bucketFillPreview: {
    vertices: [{ x: 0.1, y: 0.2 }, { x: 0.7, y: 0.2 }, { x: 0.4, y: 0.8 }],
    method: "fixture",
  },
  bucketFillLoading: true,
  bucketFillError: "bucket",
  bucketFillTolerance: 44,
  bucketFillDilatePx: 7,
  bucketFillResolution: 4000,
  bucketFillPendingPolygon: {
    vertices: [{ x: 0.1, y: 0.2 }, { x: 0.7, y: 0.2 }, { x: 0.4, y: 0.8 }],
    method: "fixture",
    bbox: [0.1, 0.2, 0.6, 0.6],
    areaSqUnits: 144,
    unit: "sq ft",
  },
  splitLineA: { x: 0.1, y: 0.2 },
  splitLineB: { x: 0.7, y: 0.8 },
  splitPreview: {
    targetAnnotationId: 91,
    original: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.5, y: 0.9 }],
    left: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.9 }],
    right: [{ x: 0.5, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.5, y: 0.9 }],
    lineA: { x: 0.5, y: 0 },
    lineB: { x: 0.5, y: 1 },
  },
  splitError: "split",
  bucketFillBarriers: [{ x1: 0.1, y1: 0.2, x2: 0.7, y2: 0.8 }],
  bucketFillBarrierMode: true,
  barrierPendingPoint: { x: 0.4, y: 0.5 },
  takeoffUndoStack: [ANNOTATION],
  takeoffRedoStack: [{ ...ANNOTATION, id: 92 }],
  tagScanResults: { yoloClass: "door", yoloModel: "fixture", texts: [] },
  symbolSearchLoading: true,
  symbolSearchProgress: { page: 3, pageIndex: 1, totalPages: 4, matches: 2 },
  symbolSearchResults: {
    templateBbox: [0.1, 0.2, 0.3, 0.4],
    sourcePageNumber: 3,
    matches: [],
    totalMatches: 0,
    pagesWithMatches: [],
    searchedAt: "2026-07-13T00:00:00.000Z",
  },
  symbolSearchConfidence: 0.42,
  dismissedSymbolMatches: new Set(["one"]),
  symbolSearchError: "symbol",
  symbolSearchTemplateBbox: [0.1, 0.2, 0.3, 0.4],
  symbolSearchSourcePage: 3,
  symbolSearchConfig: {
    multiScale: false,
    useSiftFallback: false,
    searchPages: [2, 4],
    scaleMin: 0.5,
    scaleMax: 2,
    nmsThreshold: 0.2,
    maxMatchesPerPage: 99,
  },
  symbolSearchPreset: "power",
} satisfies ToolStoreData;

const BBOX = [0.1, 0.2, 0.7, 0.8] as [number, number, number, number];

const PARSE_DIRTY = {
  tableParseStep: "review",
  tableParseRegion: BBOX,
  tableParsedGrid: { headers: ["TAG"], rows: [{ TAG: "D-101" }] },
  tableParseMeta: {
    methodResults: [{ method: "fixture", headers: ["TAG"], rows: [{ TAG: "D-101" }], confidence: 0.9 }],
    baseMethod: "fixture",
    mergedSnapshot: { headers: ["TAG"], rows: [{ TAG: "D-101" }] },
  },
  tableCellStructure: {
    cells: [{
      bbox: BBOX,
      row: 0,
      col: 0,
      rowSpan: 1,
      colSpan: 1,
      type: "body",
      confidence: 0.9,
      text: "D-101",
      highlighted: true,
    }],
    pageNumber: 4,
    regionBbox: BBOX,
  },
  showTableCellStructure: true,
  tableParseColumnBBs: [BBOX],
  tableParseColumnNames: ["TAG"],
  tableParseRowBBs: [BBOX],
  tableParseTab: "compare",
  tableParseOptions: {
    rowTolerance: 0.02,
    minColGap: 0.03,
    colHitRatio: 0.8,
    headerMode: "none",
    minHLineLengthRatio: 0.5,
    minVLineLengthRatio: 0.6,
    clusteringTolerance: 30,
    mergerEditDistance: 8,
  },
  keynoteParseTab: "compare",
  keynoteParseStep: "review",
  keynoteParseRegion: BBOX,
  keynoteColumnBBs: [BBOX],
  keynoteRowBBs: [BBOX],
  keynoteYoloClass: { model: "fixture", className: "keynote" },
  parsedKeynoteData: [{ pageNumber: 4, keys: [{ key: "1", description: "Door" }] }],
  notesParseStep: "review",
  notesParseRegion: BBOX,
  guidedNotesRows: [BBOX],
  guidedNotesCols: [BBOX],
  notesFastManualActive: true,
  notesFastManualGrid: { headers: ["NOTE"], rows: [{ NOTE: "fixture" }] },
  parseDraftRegion: {
    id: "draft-1",
    type: "notes",
    category: "general-notes",
    bbox: BBOX,
    confidence: 1,
    data: { headers: ["NOTE"], rows: [{ NOTE: "fixture" }] },
  },
  specParseStep: "review",
  specParseRegion: BBOX,
  paragraphWorkspaceOwner: "notes",
  paragraphBatch: [{ id: "paragraph-1", bbox: BBOX, lines: [], rowText: { Note: "fixture" } }],
  paragraphClipboard: { colBoundaries: [0.3, 0.7], headers: ["Note", "Description"] },
  guidedParseOwner: "table",
  guidedParseActive: true,
  guidedParseRegion: BBOX,
  guidedParseRows: [0.3],
  guidedParseCols: [0.7],
} satisfies Pick<ParseFlowState, ParseDataKey>;

const TABLE_VIEW: UiData["activeTableTagViews"][string] = {
  regionId: "region-z",
  pageNum: 9,
  bbox: [0.1, 0.2, 0.8, 0.9],
  tagTexts: ["Z-9"],
  source: "schedule",
};

const UI_DIRTY = {
  searchQuery: "needle",
  searchResults: [9],
  searchMatches: { 9: [] },
  searchLoading: true,
  focusAnnotationId: 41,
  selectedAnnotationIds: new Set([41]),
  showTextAnnotations: true,
  activeTextAnnotationTypes: { note: true },
  hiddenTextAnnotations: new Set(["9:1"]),
  textAnnotationColors: { note: "#abcdef" },
  activeTextAnnotationFilter: { type: "note", text: "needle" },
  textPanelTab: "graph",
  activeMarkupId: 43,
  activeTakeoffFilter: 44,
  activeKeynoteFilter: { shape: "hexagon", text: "K-9" },
  activeAnnotationFilter: "door",
  activeTradeFilter: "Electrical",
  activeCsiFilter: "26 00 00",
  sidebarCollapsed: true,
  annotationPanelCollapsed: true,
  showTips: true,
  helpMode: true,
  showTextPanel: true,
  showChatPanel: false,
  showDetections: true,
  showDetectionPanel: true,
  showViewAllPanel: true,
  showCsiPanel: true,
  showPageIntelPanel: true,
  showTakeoffPanel: true,
  showTableParsePanel: true,
  showKeynoteParsePanel: true,
  showSpecsNotesPanel: true,
  showParsePanel: true,
  showToolsPanel: true,
  showTableCompareModal: true,
  specsNotesTab: "notes-parse",
  parsePanelTab: "template",
  toolsPanelTab: "text",
  chatScope: "project",
  activeModels: { "model-z": false },
  confidenceThreshold: 0.88,
  confidenceThresholds: { "model-z": 0.66 },
  hiddenAnnotationIds: new Set([45]),
  hiddenClasses: { "model-z:window": false },
  showKeynotes: true,
  activeKeynoteHighlight: { pageNumber: 9, key: "K-9" },
  hiddenTakeoffItemIds: new Set([42]),
  takeoffTab: "area",
  activeYoloTagId: "tag-z",
  yoloTagVisibility: { "tag-z": false },
  activeYoloTagFilter: "tag-z",
  activeTableTagViews: { "region-z": TABLE_VIEW },
  tagBrowseId: "tag-z",
  tagBrowseIndex: 5,
  llmHighlight: { pageNumber: 9, bbox: [0.1, 0.2, 0.3, 0.4], label: "hit" },
  showParsedRegions: false,
  parsedRegionColorMode: "checkerboard",
  hiddenParsedRegionIds: new Set(["region-z"]),
  focusedParsedRegionId: "region-z",
  activeQtoWorkflow: { id: 91 } as UiData["activeQtoWorkflow"],
} satisfies UiData;

function restoreStores(): void {
  useSessionStore.setState(useSessionStore.getInitialState(), true);
  useViewerCoreStore.setState(useViewerCoreStore.getInitialState(), true);
  useToolStore.setState(useToolStore.getInitialState(), true);
  useParseFlowStore.setState(useParseFlowStore.getInitialState(), true);
  useUiStore.setState(useUiStore.getInitialState(), true);
}

beforeEach(restoreStores);

describe("P2.5 target project reset policy", () => {
  it("resets all 11 session fields and replaces project containers", () => {
    useSessionStore.setState({
      projectId: 7,
      publicId: "old-project",
      dataUrl: "old/data.pdf",
      isDemo: true,
      demoFeatureConfig: { chat: false },
      pageNames: { 1: "Old" },
      pageDrawingNumbers: { 1: "M-101" },
      showLabelingWizard: true,
      labelingWizardStep: 4,
      labelingSessions: [{ labelStudioUrl: "https://labels.test/9", pageRange: "all", taskCount: 1 }],
      labelingCredentials: { email: "old@example.test", password: "old" },
    });
    const before = useSessionStore.getState();

    resetProjectData();

    const after = useSessionStore.getState();
    const initial = useSessionStore.getInitialState();
    expect(SESSION_KEYS).toHaveLength(11);
    for (const key of SESSION_KEYS) expect.soft(after[key], `session reset: ${key}`).toEqual(initial[key]);
    for (const key of ["pageNames", "pageDrawingNumbers", "labelingSessions"] as const) {
      expect.soft(after[key], `fresh session container: ${key}`).not.toBe(before[key]);
    }
  });

  it("resets all five viewer-core fields, including pendingCenter", () => {
    useViewerCoreStore.setState({
      pageNumber: 8,
      numPages: 20,
      scale: 2.5,
      pendingCenter: true,
      pageDimensions: { 8: { width: 900, height: 1200 } },
    });

    resetProjectData();

    const after = useViewerCoreStore.getState();
    const initial = useViewerCoreStore.getInitialState();
    expect(CORE_KEYS).toHaveLength(5);
    for (const key of CORE_KEYS) expect.soft(after[key], `core reset: ${key}`).toEqual(initial[key]);
  });

  it("resets all 40 tool fields to construction defaults", () => {
    useToolStore.setState(TOOL_DIRTY);

    resetProjectData();

    const after = useToolStore.getState();
    const initial = useToolStore.getInitialState();
    expect(TOOL_KEYS).toHaveLength(40);
    for (const key of TOOL_KEYS) expect.soft(after[key], `tool reset: ${key}`).toEqual(initial[key]);
  });

  it("resets all 35 parse data fields while monotonically invalidating every operation lane", () => {
    useParseFlowStore.setState({
      ...PARSE_DIRTY,
      parseOperations: {
        table: { revision: 7, busy: true },
        keynote: { revision: 11, busy: false },
        notes: { revision: 13, busy: true },
        spec: { revision: 17, busy: false },
      },
    });

    resetProjectData();
    expect(useParseFlowStore.getState().parseOperations).toEqual({
      table: { revision: 8, busy: false },
      keynote: { revision: 12, busy: false },
      notes: { revision: 14, busy: false },
      spec: { revision: 18, busy: false },
    });

    resetProjectData();
    const after = useParseFlowStore.getState();
    expect(after.parseOperations).toEqual({
      table: { revision: 9, busy: false },
      keynote: { revision: 13, busy: false },
      notes: { revision: 15, busy: false },
      spec: { revision: 19, busy: false },
    });
    expect(PARSE_KEYS).toHaveLength(35);
    const initial = useParseFlowStore.getInitialState();
    for (const key of PARSE_KEYS) expect.soft(after[key], `parse reset: ${key}`).toEqual(initial[key]);
  });

  it("preserves exactly 29 UI presentation fields and resets exactly 32 project fields", () => {
    useUiStore.setState(UI_DIRTY);
    const before = useUiStore.getState();

    resetProjectData();

    const after = useUiStore.getState();
    const initial = useUiStore.getInitialState();
    const targetKeys = [...UI_SURVIVE_KEYS, ...UI_RESET_KEYS];
    const runtimeKeys = Object.entries(after)
      .filter(([, value]) => typeof value !== "function")
      .map(([key]) => key)
      .sort();

    expect(UI_SURVIVE_KEYS).toHaveLength(29);
    expect(UI_RESET_KEYS).toHaveLength(32);
    expect(new Set(targetKeys).size).toBe(61);
    expect([...targetKeys].sort()).toEqual(runtimeKeys);

    for (const key of UI_SURVIVE_KEYS) {
      expect.soft(after[key], `UI presentation survives: ${key}`).toBe(before[key]);
    }
    for (const key of UI_RESET_KEYS) {
      expect.soft(after[key], `UI project field resets: ${key}`).toEqual(initial[key]);
    }
  });
});
