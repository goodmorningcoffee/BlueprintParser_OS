import { beforeEach, describe, expect, it } from "vitest";

import { resetProjectData } from "@/stores/viewerCommands";
import { useViewerStore } from "@/stores/viewerStore";

type ViewerState = ReturnType<typeof useViewerStore.getState>;

// P2.3 U0: this is the exact mechanically-pure uiStore candidate. Tool activation,
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
  "toggleDetectionPanel",
  "toggleViewAllPanel",
  "toggleCsiPanel",
  "togglePageIntelPanel",
  "toggleTakeoffPanel",
  "toggleTableParsePanel",
  "toggleKeynoteParsePanel",
  "toggleSpecsNotesPanel",
  "toggleParsePanel",
  "toggleToolsPanel",
  "toggleTableCompareModal",
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
  "setLlmHighlight",
  "toggleParsedRegions",
  "setParsedRegionColorMode",
  "toggleParsedRegionVisibility",
  "setFocusedParsedRegionId",
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

describe("viewerStore — P2.3 pure UI characterization", () => {
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
