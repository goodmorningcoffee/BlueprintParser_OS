import { beforeEach, describe, expect, it } from "vitest";

import { useParseFlowStore } from "@/stores/parseFlowStore";
import { useSessionStore } from "@/stores/sessionStore";
import { useToolStore } from "@/stores/toolStore";
import { resetProjectData } from "@/stores/viewerCommands";
// Keep the U0 fixture's local store variable stable while flipping its imported owner. The module
// path is the ownership assertion: every data/action exercise below now runs against uiStore.
import { useUiStore as useViewerStore } from "@/stores/uiStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { useViewerStore as useResidualViewerStore } from "@/stores/viewerStore";
import {
  CORE_TEST_STATE_KEYS,
  partitionViewerStoreTestState,
  setViewerStoreStateForTest,
  TOOL_TEST_ACTION_KEYS,
  TOOL_TEST_STATE_KEYS,
  UI_TEST_STATE_KEYS,
} from "@/test/viewer-store-state";

type ViewerState = ReturnType<typeof useViewerStore.getState>;
type ToolState = ReturnType<typeof useToolStore.getState>;

// P2.3 U2: this is the exact mechanically-pure uiStore owner. Tool activation,
// parse drafts/tabs, project data, and mutable server-row drafts deliberately stay out.
const UI_FIELDS = [
  "searchQuery",
  "searchResults",
  "searchMatches",
  "searchLoading",
  "focusAnnotationId",
  "selectedAnnotationIds",
  "showTextAnnotations",
  "activeTextAnnotationTypes",
  "hiddenTextAnnotations",
  "textAnnotationColors",
  "activeTextAnnotationFilter",
  "textPanelTab",
  "activeMarkupId",
  "activeTakeoffFilter",
  "activeKeynoteFilter",
  "activeAnnotationFilter",
  "activeTradeFilter",
  "activeCsiFilter",
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
  "activeModels",
  "confidenceThreshold",
  "confidenceThresholds",
  "hiddenAnnotationIds",
  "hiddenClasses",
  "showKeynotes",
  "activeKeynoteHighlight",
  "hiddenTakeoffItemIds",
  "takeoffTab",
  "activeYoloTagId",
  "yoloTagVisibility",
  "activeYoloTagFilter",
  "activeTableTagViews",
  "tagBrowseId",
  "tagBrowseIndex",
  "llmHighlight",
  "showParsedRegions",
  "parsedRegionColorMode",
  "hiddenParsedRegionIds",
  "focusedParsedRegionId",
] as const satisfies readonly (keyof ViewerState)[];

type UiField = (typeof UI_FIELDS)[number];

const TOOL_FIELDS = [
  "mode",
  "tempPanMode",
  "activeTool",
  "_drawing",
  "_drawStart",
  "_drawEnd",
  "_mousePos",
  "activeTakeoffItemId",
  "scaleCalibrations",
  "calibrationMode",
  "calibrationPoints",
  "polygonDrawingMode",
  "polygonVertices",
  "bucketFillPreview",
  "bucketFillLoading",
  "bucketFillError",
  "bucketFillTolerance",
  "bucketFillDilatePx",
  "bucketFillResolution",
  "bucketFillPendingPolygon",
  "splitLineA",
  "splitLineB",
  "splitPreview",
  "splitError",
  "bucketFillBarriers",
  "bucketFillBarrierMode",
  "barrierPendingPoint",
  "takeoffUndoStack",
  "takeoffRedoStack",
  "tagScanResults",
  "symbolSearchLoading",
  "symbolSearchProgress",
  "symbolSearchResults",
  "symbolSearchConfidence",
  "dismissedSymbolMatches",
  "symbolSearchError",
  "symbolSearchTemplateBbox",
  "symbolSearchSourcePage",
  "symbolSearchConfig",
  "symbolSearchPreset",
] as const satisfies readonly (keyof ToolState)[];

const UI_ACTION_FIELDS = [
  "setSearch",
  "setSearchResults",
  "setSearchMatches",
  "setSearchLoading",
  "setFocusAnnotationId",
  "setSelectedAnnotationIds",
  "addToSelection",
  "removeFromSelection",
  "toggleSelection",
  "clearSelection",
  "toggleTextAnnotations",
  "setTextAnnotationType",
  "setAllTextAnnotationTypes",
  "toggleTextAnnotationVisibility",
  "setTextAnnotationColor",
  "setTextAnnotationFilter",
  "setTextPanelTab",
  "setActiveMarkupId",
  "setTakeoffFilter",
  "setKeynoteFilter",
  "setAnnotationFilter",
  "setTradeFilter",
  "setCsiFilter",
  "toggleSidebar",
  "toggleAnnotationPanel",
  "toggleTips",
  "toggleHelpMode",
  "toggleTextPanel",
  "toggleChatPanel",
  "toggleDetections",
  "toggleViewAllPanel",
  "toggleCsiPanel",
  "togglePageIntelPanel",
  "toggleSpecsNotesPanel",
  "toggleToolsPanel",
  "toggleTableCompareModal",
  "setPanelVisibility",
  "setSpecsNotesTab",
  "setParsePanelTab",
  "setToolsPanelTab",
  "setChatScope",
  "setModelActive",
  "setConfidenceThreshold",
  "setModelConfidence",
  "initDetectionModels",
  "toggleAnnotationVisibility",
  "toggleClassVisibility",
  "toggleKeynotes",
  "setActiveKeynoteHighlight",
  "toggleTakeoffItemVisibility",
  "setTakeoffTab",
  "setActiveYoloTagId",
  "setYoloTagVisibility",
  "setYoloTagFilter",
  "setTableTagView",
  "setYoloBrowseState",
  "setLlmHighlight",
  "toggleParsedRegions",
  "setParsedRegionColorMode",
  "toggleParsedRegionVisibility",
  "setFocusedParsedRegionId",
  "resetProjectUiState",
] as const satisfies readonly (keyof ViewerState)[];

type UiActionField = (typeof UI_ACTION_FIELDS)[number];

function pickUi(state: ViewerState): Pick<ViewerState, UiField> {
  return Object.fromEntries(UI_FIELDS.map((field) => [field, state[field]])) as Pick<
    ViewerState,
    UiField
  >;
}

function pickUiActions(state: ViewerState): Pick<ViewerState, UiActionField> {
  return Object.fromEntries(UI_ACTION_FIELDS.map((field) => [field, state[field]])) as Pick<
    ViewerState,
    UiActionField
  >;
}

beforeEach(() => {
  resetProjectData();

  // The compatibility reset intentionally retains these fields. Normalize only
  // the omissions here so every characterization starts at construction defaults.
  useViewerStore.setState({
    focusAnnotationId: null,
    selectedAnnotationIds: new Set<number>(),
    showTextPanel: false,
    showChatPanel: true,
    showTips: false,
    helpMode: false,
    showKeynotes: false,
    hiddenClasses: {},
    hiddenTakeoffItemIds: new Set<number>(),
    showParsedRegions: true,
    parsedRegionColorMode: "striped",
    hiddenParsedRegionIds: new Set<string>(),
  });
});

describe("uiStore — P2.3 post-carve pure UI ownership", () => {
  it("freezes the exact 60-field candidate and its construction defaults", () => {
    expect(UI_FIELDS).toHaveLength(60);
    expect(pickUi(useViewerStore.getState())).toEqual({
      searchQuery: "",
      searchResults: [],
      searchMatches: {},
      searchLoading: false,
      focusAnnotationId: null,
      selectedAnnotationIds: new Set<number>(),
      showTextAnnotations: false,
      activeTextAnnotationTypes: {},
      hiddenTextAnnotations: new Set<string>(),
      textAnnotationColors: {},
      activeTextAnnotationFilter: null,
      textPanelTab: "annotations",
      activeMarkupId: null,
      activeTakeoffFilter: null,
      activeKeynoteFilter: null,
      activeAnnotationFilter: null,
      activeTradeFilter: null,
      activeCsiFilter: null,
      sidebarCollapsed: false,
      annotationPanelCollapsed: false,
      showTips: false,
      helpMode: false,
      showTextPanel: false,
      showChatPanel: true,
      showDetections: false,
      showDetectionPanel: false,
      showViewAllPanel: false,
      showCsiPanel: false,
      showPageIntelPanel: false,
      showTakeoffPanel: false,
      showTableParsePanel: false,
      showKeynoteParsePanel: false,
      showSpecsNotesPanel: false,
      showParsePanel: false,
      showToolsPanel: false,
      showTableCompareModal: false,
      specsNotesTab: "spec-parse",
      parsePanelTab: "shape",
      toolsPanelTab: "csi",
      chatScope: "page",
      activeModels: {},
      confidenceThreshold: 0.1,
      confidenceThresholds: {},
      hiddenAnnotationIds: new Set<number>(),
      hiddenClasses: {},
      showKeynotes: false,
      activeKeynoteHighlight: null,
      hiddenTakeoffItemIds: new Set<number>(),
      takeoffTab: "count",
      activeYoloTagId: null,
      yoloTagVisibility: {},
      activeYoloTagFilter: null,
      activeTableTagViews: {},
      tagBrowseId: null,
      tagBrowseIndex: 0,
      llmHighlight: null,
      showParsedRegions: true,
      parsedRegionColorMode: "striped",
      hiddenParsedRegionIds: new Set<string>(),
      focusedParsedRegionId: null,
    });
  });

  it("routes exact seams through the logical parse partition and skips empty owners", () => {
    expect(UI_TEST_STATE_KEYS).toEqual(UI_FIELDS);
    expect(CORE_TEST_STATE_KEYS).toEqual([
      "pageNumber",
      "numPages",
      "scale",
      "pendingCenter",
      "pageDimensions",
    ]);
    expect(TOOL_TEST_STATE_KEYS).toEqual(TOOL_FIELDS);
    expect(TOOL_TEST_ACTION_KEYS).toEqual([
      "_setDrawing", "_setDrawStart", "_setDrawEnd", "_setMousePos",
    ]);
    const toolPatch = {
      mode: "markup",
      tempPanMode: true,
      activeTool: { kind: "tagAdd", tagId: "tag-fixture" },
      _drawing: true,
      _drawStart: { x: 11, y: 12 },
      _drawEnd: { x: 13, y: 14 },
      _mousePos: { x: 15, y: 16 },
      activeTakeoffItemId: 41,
      scaleCalibrations: {},
      calibrationMode: "point1",
      calibrationPoints: { p1: { x: 0.1, y: 0.2 } },
      polygonDrawingMode: "drawing",
      polygonVertices: [{ x: 0.2, y: 0.3 }],
      bucketFillPreview: {
        vertices: [{ x: 0.1, y: 0.1 }],
        method: "fixture",
      },
      bucketFillLoading: true,
      bucketFillError: "bucket-fixture",
      bucketFillTolerance: 31,
      bucketFillDilatePx: 4,
      bucketFillResolution: 2000,
      bucketFillPendingPolygon: {
        vertices: [{ x: 0.1, y: 0.1 }],
        method: "fixture",
        bbox: [0.1, 0.1, 0.8, 0.8],
        areaSqUnits: 12,
        unit: "SF",
      },
      splitLineA: { x: 0.1, y: 0.2 },
      splitLineB: { x: 0.8, y: 0.9 },
      splitPreview: {
        targetAnnotationId: 17,
        original: [{ x: 0.1, y: 0.1 }],
        left: [{ x: 0.1, y: 0.1 }],
        right: [{ x: 0.8, y: 0.9 }],
        lineA: { x: 0.1, y: 0.2 },
        lineB: { x: 0.8, y: 0.9 },
      },
      splitError: "split-fixture",
      bucketFillBarriers: [{ x1: 0.1, y1: 0.2, x2: 0.8, y2: 0.9 }],
      bucketFillBarrierMode: true,
      barrierPendingPoint: { x: 0.4, y: 0.5 },
      takeoffUndoStack: [],
      takeoffRedoStack: [],
      tagScanResults: {
        yoloClass: "door",
        yoloModel: "fixture-model",
        texts: [],
      },
      symbolSearchLoading: true,
      symbolSearchProgress: { page: 3, pageIndex: 2, totalPages: 9, matches: 4 },
      symbolSearchResults: null,
      symbolSearchConfidence: 0.8,
      dismissedSymbolMatches: new Set(["match-fixture"]),
      symbolSearchError: "symbol-fixture",
      symbolSearchTemplateBbox: [0.1, 0.2, 0.3, 0.4],
      symbolSearchSourcePage: 3,
      symbolSearchConfig: {
        multiScale: false,
        useSiftFallback: false,
        searchPages: [3],
        scaleMin: 0.7,
        scaleMax: 1.7,
        nmsThreshold: 0.25,
        maxMatchesPerPage: 25,
      },
      symbolSearchPreset: "power",
    } satisfies Pick<ToolState, (typeof TOOL_FIELDS)[number]>;
    const mixedPatch = {
      publicId: "destination",
      searchQuery: "needle",
      pageNumber: 7,
      ...toolPatch,
      tableParseStep: "review" as const,
      allTrades: ["Concrete"],
    };
    const partitions = partitionViewerStoreTestState(mixedPatch);
    expect(partitions).toEqual({
      session: { publicId: "destination" },
      ui: { searchQuery: "needle" },
      core: { pageNumber: 7 },
      tool: toolPatch,
      parse: { tableParseStep: "review" },
      viewer: { allTrades: ["Concrete"] },
    });
    const drawingOverride = () => undefined;
    expect(partitionViewerStoreTestState({ _setDrawing: drawingOverride })).toEqual({
      session: {},
      ui: {},
      core: {},
      tool: { _setDrawing: drawingOverride },
      parse: {},
      viewer: {},
    });

    const publications: string[] = [];
    const unsubscribeSession = useSessionStore.subscribe(() => publications.push("session"));
    const unsubscribeUi = useViewerStore.subscribe(() => publications.push("ui"));
    const unsubscribeCore = useViewerCoreStore.subscribe(() => publications.push("core"));
    const unsubscribeTool = useToolStore.subscribe(() => publications.push("tool"));
    const unsubscribeParse = useParseFlowStore.subscribe(() => publications.push("parse"));
    const unsubscribeViewer = useResidualViewerStore.subscribe(() => publications.push("viewer"));

    setViewerStoreStateForTest(mixedPatch);
    expect(publications).toEqual(["session", "ui", "core", "tool", "parse", "viewer"]);
    expect(useParseFlowStore.getState()).toMatchObject({
      tableParseStep: "review",
    });
    expect(useResidualViewerStore.getState().allTrades).toEqual(["Concrete"]);
    // The S2 parse topology gate proves definition/runtime absence from residual Viewer. This
    // helper characterization stays on its own side of that boundary and proves the split through
    // the independent parse/residual values and publication trace above.

    publications.length = 0;
    setViewerStoreStateForTest({ searchQuery: "ui-only" });
    expect(publications).toEqual(["ui"]);

    publications.length = 0;
    setViewerStoreStateForTest({});
    expect(publications).toEqual([]);
    unsubscribeSession();
    unsubscribeUi();
    unsubscribeCore();
    unsubscribeTool();
    unsubscribeParse();
    unsubscribeViewer();
  });

  it("preserves selection pass-through/no-op identity and copies every visibility Set toggle", () => {
    const suppliedSelection = new Set([7]);
    const selection = useViewerStore.getState();
    selection.setSelectedAnnotationIds(suppliedSelection);
    expect(useViewerStore.getState().selectedAnnotationIds).toBe(suppliedSelection);

    selection.addToSelection(7);
    selection.removeFromSelection(99);
    expect(useViewerStore.getState().selectedAnnotationIds).toBe(suppliedSelection);

    selection.addToSelection(8);
    const afterAdd = useViewerStore.getState().selectedAnnotationIds;
    expect(afterAdd).not.toBe(suppliedSelection);
    expect(afterAdd).toEqual(new Set([7, 8]));

    selection.removeFromSelection(7);
    const afterRemove = useViewerStore.getState().selectedAnnotationIds;
    expect(afterRemove).not.toBe(afterAdd);
    expect(afterRemove).toEqual(new Set([8]));

    selection.toggleSelection(8);
    const afterToggleOff = useViewerStore.getState().selectedAnnotationIds;
    expect(afterToggleOff).not.toBe(afterRemove);
    expect(afterToggleOff).toEqual(new Set<number>());

    selection.clearSelection();
    const afterFirstClear = useViewerStore.getState().selectedAnnotationIds;
    selection.clearSelection();
    expect(useViewerStore.getState().selectedAnnotationIds).not.toBe(afterFirstClear);

    const setToggleCases: {
      read: () => ReadonlySet<unknown>;
      toggle: () => void;
      key: unknown;
    }[] = [
      {
        read: () => useViewerStore.getState().hiddenTextAnnotations,
        toggle: () => useViewerStore.getState().toggleTextAnnotationVisibility(3, 4),
        key: "3:4",
      },
      {
        read: () => useViewerStore.getState().hiddenAnnotationIds,
        toggle: () => useViewerStore.getState().toggleAnnotationVisibility(17),
        key: 17,
      },
      {
        read: () => useViewerStore.getState().hiddenTakeoffItemIds,
        toggle: () => useViewerStore.getState().toggleTakeoffItemVisibility(23),
        key: 23,
      },
      {
        read: () => useViewerStore.getState().hiddenParsedRegionIds,
        toggle: () => useViewerStore.getState().toggleParsedRegionVisibility("region-9"),
        key: "region-9",
      },
    ];

    for (const { read, toggle, key } of setToggleCases) {
      const before = read();
      toggle();
      const added = read();
      expect(added).not.toBe(before);
      expect(added.has(key)).toBe(true);
      expect(before.has(key)).toBe(false);

      toggle();
      const removed = read();
      expect(removed).not.toBe(added);
      expect(removed.has(key)).toBe(false);
    }
  });

  it("copies keyed UI maps, preserves unrelated entries, and rebuilds all-text values", () => {
    useViewerStore.setState({
      activeTextAnnotationTypes: { existing: false },
      textAnnotationColors: { existing: "#111111" },
      activeModels: { existing: false },
      confidenceThresholds: { existing: 0.22 },
      yoloTagVisibility: { existing: false },
    });

    const mapCases = [
      {
        read: () => useViewerStore.getState().activeTextAnnotationTypes,
        write: () => useViewerStore.getState().setTextAnnotationType("added", true),
        expected: { existing: false, added: true },
      },
      {
        read: () => useViewerStore.getState().textAnnotationColors,
        write: () => useViewerStore.getState().setTextAnnotationColor("added", "#abcdef"),
        expected: { existing: "#111111", added: "#abcdef" },
      },
      {
        read: () => useViewerStore.getState().activeModels,
        write: () => useViewerStore.getState().setModelActive("added", true),
        expected: { existing: false, added: true },
      },
      {
        read: () => useViewerStore.getState().confidenceThresholds,
        write: () => useViewerStore.getState().setModelConfidence("added", 0.73),
        expected: { existing: 0.22, added: 0.73 },
      },
      {
        read: () => useViewerStore.getState().yoloTagVisibility,
        write: () => useViewerStore.getState().setYoloTagVisibility("added", true),
        expected: { existing: false, added: true },
      },
    ];

    for (const { read, write, expected } of mapCases) {
      const before = read();
      write();
      expect(read()).not.toBe(before);
      expect(read()).toEqual(expected);
    }

    const beforeAll = useViewerStore.getState().activeTextAnnotationTypes;
    useViewerStore.getState().setAllTextAnnotationTypes(false);
    expect(useViewerStore.getState().activeTextAnnotationTypes).not.toBe(beforeAll);
    expect(useViewerStore.getState().activeTextAnnotationTypes).toEqual({
      existing: false,
      added: false,
    });
  });

  it("rebuilds detection model maps and preserves explicit false/zero values", () => {
    useViewerStore.setState({
      activeModels: { keep: false, drop: true },
      confidenceThresholds: { keep: 0, drop: 0.91 },
    });
    const beforeModels = useViewerStore.getState().activeModels;
    const beforeThresholds = useViewerStore.getState().confidenceThresholds;

    useViewerStore.getState().initDetectionModels(["keep", "new"]);

    const state = useViewerStore.getState();
    expect(state.activeModels).not.toBe(beforeModels);
    expect(state.confidenceThresholds).not.toBe(beforeThresholds);
    expect(state.activeModels).toEqual({ keep: false, new: true });
    expect(state.confidenceThresholds).toEqual({ keep: 0, new: 0.1 });
  });

  it("uses false-as-hidden class inversion and copy-on-write table view deletion", () => {
    const initialClasses = useViewerStore.getState().hiddenClasses;
    useViewerStore.getState().toggleClassVisibility("model-a", "door");
    const hidden = useViewerStore.getState().hiddenClasses;
    expect(hidden).not.toBe(initialClasses);
    expect(hidden).toEqual({ "model-a:door": false });

    useViewerStore.getState().toggleClassVisibility("model-a", "door");
    const visible = useViewerStore.getState().hiddenClasses;
    expect(visible).not.toBe(hidden);
    expect(visible).toEqual({ "model-a:door": true });

    const firstView: ViewerState["activeTableTagViews"][string] = {
      regionId: "region-a",
      pageNum: 2,
      bbox: [0.1, 0.2, 0.3, 0.4],
      tagTexts: ["D-101"],
      source: "schedule",
    };
    const secondView: ViewerState["activeTableTagViews"][string] = {
      regionId: "region-b",
      pageNum: 4,
      bbox: [0.2, 0.3, 0.4, 0.5],
      tagTexts: ["K-1"],
      source: "keynote",
    };

    const emptyViews = useViewerStore.getState().activeTableTagViews;
    useViewerStore.getState().setTableTagView("region-a", firstView);
    const withFirst = useViewerStore.getState().activeTableTagViews;
    expect(withFirst).not.toBe(emptyViews);
    expect(withFirst["region-a"]).toBe(firstView);

    useViewerStore.getState().setTableTagView("region-b", secondView);
    const withBoth = useViewerStore.getState().activeTableTagViews;
    expect(withBoth).not.toBe(withFirst);
    expect(withBoth["region-a"]).toBe(firstView);
    expect(withBoth["region-b"]).toBe(secondView);

    useViewerStore.getState().setTableTagView("region-a", null);
    const afterDelete = useViewerStore.getState().activeTableTagViews;
    expect(afterDelete).not.toBe(withBoth);
    expect(afterDelete).toEqual({ "region-b": secondView });

    useViewerStore.getState().setTableTagView("missing", null);
    expect(useViewerStore.getState().activeTableTagViews).not.toBe(afterDelete);
    expect(useViewerStore.getState().activeTableTagViews).toEqual({ "region-b": secondView });
  });

  it("freezes the complete reset touched/retained ledger and container/action identities", () => {
    const retainedSelection = new Set([41]);
    const retainedHiddenClasses = { "model-z:window": false };
    const retainedHiddenTakeoffs = new Set([42]);
    const retainedHiddenRegions = new Set(["region-z"]);
    const tableView: ViewerState["activeTableTagViews"][string] = {
      regionId: "region-z",
      pageNum: 9,
      bbox: [0.1, 0.2, 0.8, 0.9],
      tagTexts: ["Z-9"],
      source: "schedule",
    };

    useViewerStore.setState({
      searchQuery: "needle",
      searchResults: [9],
      searchMatches: { 9: [] },
      searchLoading: true,
      focusAnnotationId: 41,
      selectedAnnotationIds: retainedSelection,
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
      hiddenClasses: retainedHiddenClasses,
      showKeynotes: true,
      activeKeynoteHighlight: { pageNumber: 9, key: "K-9" },
      hiddenTakeoffItemIds: retainedHiddenTakeoffs,
      takeoffTab: "area",
      activeYoloTagId: "tag-z",
      yoloTagVisibility: { "tag-z": false },
      activeYoloTagFilter: "tag-z",
      activeTableTagViews: { "region-z": tableView },
      tagBrowseId: "tag-z",
      tagBrowseIndex: 5,
      llmHighlight: { pageNumber: 9, bbox: [0.1, 0.2, 0.3, 0.4], label: "hit" },
      showParsedRegions: false,
      parsedRegionColorMode: "checkerboard",
      hiddenParsedRegionIds: retainedHiddenRegions,
      focusedParsedRegionId: "region-z",
    });

    const dirty = useViewerStore.getState();
    const actionRefs = pickUiActions(dirty);
    resetProjectData();
    const reset = useViewerStore.getState();

    expect(pickUi(reset)).toEqual({
      searchQuery: "",
      searchResults: [],
      searchMatches: {},
      searchLoading: false,
      focusAnnotationId: 41,
      selectedAnnotationIds: retainedSelection,
      showTextAnnotations: false,
      activeTextAnnotationTypes: {},
      hiddenTextAnnotations: new Set<string>(),
      textAnnotationColors: {},
      activeTextAnnotationFilter: null,
      textPanelTab: "annotations",
      activeMarkupId: null,
      activeTakeoffFilter: null,
      activeKeynoteFilter: null,
      activeAnnotationFilter: null,
      activeTradeFilter: null,
      activeCsiFilter: null,
      sidebarCollapsed: false,
      annotationPanelCollapsed: false,
      showTips: true,
      helpMode: true,
      showTextPanel: true,
      showChatPanel: false,
      showDetections: false,
      showDetectionPanel: false,
      showViewAllPanel: false,
      showCsiPanel: false,
      showPageIntelPanel: false,
      showTakeoffPanel: false,
      showTableParsePanel: false,
      showKeynoteParsePanel: false,
      showSpecsNotesPanel: false,
      showParsePanel: false,
      showToolsPanel: false,
      showTableCompareModal: false,
      specsNotesTab: "spec-parse",
      parsePanelTab: "shape",
      toolsPanelTab: "csi",
      chatScope: "page",
      activeModels: {},
      confidenceThreshold: 0.1,
      confidenceThresholds: {},
      hiddenAnnotationIds: new Set<number>(),
      hiddenClasses: retainedHiddenClasses,
      showKeynotes: true,
      activeKeynoteHighlight: null,
      hiddenTakeoffItemIds: retainedHiddenTakeoffs,
      takeoffTab: "count",
      activeYoloTagId: null,
      yoloTagVisibility: {},
      activeYoloTagFilter: null,
      activeTableTagViews: {},
      tagBrowseId: null,
      tagBrowseIndex: 0,
      llmHighlight: null,
      showParsedRegions: false,
      parsedRegionColorMode: "checkerboard",
      hiddenParsedRegionIds: retainedHiddenRegions,
      focusedParsedRegionId: null,
    });

    const retainedContainerFields = [
      "selectedAnnotationIds",
      "hiddenClasses",
      "hiddenTakeoffItemIds",
      "hiddenParsedRegionIds",
    ] as const satisfies readonly UiField[];
    for (const field of retainedContainerFields) {
      expect(reset[field]).toBe(dirty[field]);
    }

    const replacedContainerFields = [
      "searchResults",
      "searchMatches",
      "activeTextAnnotationTypes",
      "hiddenTextAnnotations",
      "textAnnotationColors",
      "activeModels",
      "confidenceThresholds",
      "hiddenAnnotationIds",
      "yoloTagVisibility",
      "activeTableTagViews",
    ] as const satisfies readonly UiField[];
    for (const field of replacedContainerFields) {
      expect(reset[field]).not.toBe(dirty[field]);
    }

    for (const field of UI_ACTION_FIELDS) {
      expect(reset[field]).toBe(actionRefs[field]);
    }
  });
});
