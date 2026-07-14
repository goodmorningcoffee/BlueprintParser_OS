import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  useFilterUiActions,
  useSearchUi,
  useSearchUiActions,
  useUiStore,
  type UiData,
  type UiState,
} from "@/stores/uiStore";

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
  "activeQtoWorkflow",
] as const satisfies readonly (keyof UiData)[];

type UiField = (typeof UI_FIELDS)[number];

const DEFAULT_UI = {
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
  activeQtoWorkflow: null,
} satisfies UiData;

const RETAINED_FIELDS = [
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
] as const satisfies readonly UiField[];

const RETAINED_CONTAINER_FIELDS = [
  "textAnnotationColors",
] as const satisfies readonly UiField[];

const REPLACED_CONTAINER_FIELDS = [
  "searchResults",
  "searchMatches",
  "selectedAnnotationIds",
  "activeTextAnnotationTypes",
  "hiddenTextAnnotations",
  "activeModels",
  "confidenceThresholds",
  "hiddenAnnotationIds",
  "hiddenClasses",
  "hiddenTakeoffItemIds",
  "yoloTagVisibility",
  "activeTableTagViews",
  "hiddenParsedRegionIds",
] as const satisfies readonly UiField[];

const CONSTRUCTION_COLLECTIONS = (() => {
  const state = useUiStore.getState();
  return {
    searchResults: state.searchResults,
    searchMatches: state.searchMatches,
    selectedAnnotationIds: state.selectedAnnotationIds,
    activeTextAnnotationTypes: state.activeTextAnnotationTypes,
    hiddenTextAnnotations: state.hiddenTextAnnotations,
    textAnnotationColors: state.textAnnotationColors,
    activeModels: state.activeModels,
    confidenceThresholds: state.confidenceThresholds,
    hiddenAnnotationIds: state.hiddenAnnotationIds,
    hiddenClasses: state.hiddenClasses,
    hiddenTakeoffItemIds: state.hiddenTakeoffItemIds,
    yoloTagVisibility: state.yoloTagVisibility,
    activeTableTagViews: state.activeTableTagViews,
    hiddenParsedRegionIds: state.hiddenParsedRegionIds,
  };
})();

function pickUi(state: UiState): Pick<UiData, UiField> {
  return Object.fromEntries(UI_FIELDS.map((field) => [field, state[field]])) as Pick<
    UiData,
    UiField
  >;
}

function normalizeConstructionDefaults(): void {
  useUiStore.setState(useUiStore.getInitialState(), true);
  useUiStore.getState().resetProjectUiState();
}

beforeEach(() => {
  normalizeConstructionDefaults();
});

describe("uiStore — additive presentation owner", () => {
  it("has exactly the frozen 61 data fields and construction defaults", () => {
    const state = useUiStore.getState();
    const runtimeDataFields = Object.entries(state)
      .filter(([, value]) => typeof value !== "function")
      .map(([field]) => field)
      .sort();

    expect(UI_FIELDS).toHaveLength(61);
    expect(runtimeDataFields).toEqual([...UI_FIELDS].sort());
    expect(pickUi(state)).toEqual(DEFAULT_UI);
  });

  it("uses independent construction containers and fresh containers on every touched reset", () => {
    expect(CONSTRUCTION_COLLECTIONS.selectedAnnotationIds).not.toBe(
      CONSTRUCTION_COLLECTIONS.hiddenAnnotationIds,
    );
    expect(CONSTRUCTION_COLLECTIONS.hiddenTextAnnotations).not.toBe(
      CONSTRUCTION_COLLECTIONS.hiddenParsedRegionIds,
    );
    expect(CONSTRUCTION_COLLECTIONS.searchMatches).not.toBe(CONSTRUCTION_COLLECTIONS.activeModels);
    expect(CONSTRUCTION_COLLECTIONS.activeModels).not.toBe(
      CONSTRUCTION_COLLECTIONS.confidenceThresholds,
    );
    expect(CONSTRUCTION_COLLECTIONS.yoloTagVisibility).not.toBe(
      CONSTRUCTION_COLLECTIONS.activeTableTagViews,
    );

    const first = useUiStore.getState();
    for (const field of REPLACED_CONTAINER_FIELDS) {
      expect(first[field], field).not.toBe(CONSTRUCTION_COLLECTIONS[field]);
    }

    const retained = Object.fromEntries(
      RETAINED_CONTAINER_FIELDS.map((field) => [field, first[field]]),
    ) as Record<(typeof RETAINED_CONTAINER_FIELDS)[number], unknown>;
    const firstReset = Object.fromEntries(
      REPLACED_CONTAINER_FIELDS.map((field) => [field, first[field]]),
    ) as Record<(typeof REPLACED_CONTAINER_FIELDS)[number], unknown>;

    first.resetProjectUiState();
    const second = useUiStore.getState();
    for (const field of REPLACED_CONTAINER_FIELDS) {
      expect(second[field], field).not.toBe(firstReset[field]);
    }
    for (const field of RETAINED_CONTAINER_FIELDS) {
      expect(second[field], field).toBe(retained[field]);
    }

    const secondReset = Object.fromEntries(
      REPLACED_CONTAINER_FIELDS.map((field) => [field, second[field]]),
    ) as Record<(typeof REPLACED_CONTAINER_FIELDS)[number], unknown>;
    second.resetProjectUiState();
    const third = useUiStore.getState();
    for (const field of REPLACED_CONTAINER_FIELDS) {
      expect(third[field], field).not.toBe(secondReset[field]);
    }
  });

  it("preserves selection pass-through/no-op identity and clones every visibility Set toggle", () => {
    const suppliedSelection = new Set([7]);
    const actions = useUiStore.getState();
    actions.setSelectedAnnotationIds(suppliedSelection);
    expect(useUiStore.getState().selectedAnnotationIds).toBe(suppliedSelection);

    actions.addToSelection(7);
    actions.removeFromSelection(99);
    expect(useUiStore.getState().selectedAnnotationIds).toBe(suppliedSelection);

    actions.addToSelection(8);
    const afterAdd = useUiStore.getState().selectedAnnotationIds;
    expect(afterAdd).not.toBe(suppliedSelection);
    expect(afterAdd).toEqual(new Set([7, 8]));

    actions.removeFromSelection(7);
    const afterRemove = useUiStore.getState().selectedAnnotationIds;
    expect(afterRemove).not.toBe(afterAdd);
    expect(afterRemove).toEqual(new Set([8]));

    actions.toggleSelection(8);
    const afterToggle = useUiStore.getState().selectedAnnotationIds;
    expect(afterToggle).not.toBe(afterRemove);
    expect(afterToggle).toEqual(new Set<number>());

    actions.clearSelection();
    const afterFirstClear = useUiStore.getState().selectedAnnotationIds;
    actions.clearSelection();
    expect(useUiStore.getState().selectedAnnotationIds).not.toBe(afterFirstClear);

    const setCases: {
      read: () => ReadonlySet<unknown>;
      toggle: () => void;
      key: unknown;
    }[] = [
      {
        read: () => useUiStore.getState().hiddenTextAnnotations,
        toggle: () => useUiStore.getState().toggleTextAnnotationVisibility(3, 4),
        key: "3:4",
      },
      {
        read: () => useUiStore.getState().hiddenAnnotationIds,
        toggle: () => useUiStore.getState().toggleAnnotationVisibility(17),
        key: 17,
      },
      {
        read: () => useUiStore.getState().hiddenTakeoffItemIds,
        toggle: () => useUiStore.getState().toggleTakeoffItemVisibility(23),
        key: 23,
      },
      {
        read: () => useUiStore.getState().hiddenParsedRegionIds,
        toggle: () => useUiStore.getState().toggleParsedRegionVisibility("region-9"),
        key: "region-9",
      },
    ];

    for (const { read, toggle, key } of setCases) {
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

  it("retains replacement inputs, copies keyed maps, and rebuilds only known text keys", () => {
    const suppliedResults = [2, 5];
    const suppliedMatches = {};
    useUiStore.getState().setSearchResults(suppliedResults);
    useUiStore.getState().setSearchMatches(suppliedMatches);
    expect(useUiStore.getState().searchResults).toBe(suppliedResults);
    expect(useUiStore.getState().searchMatches).toBe(suppliedMatches);

    useUiStore.setState({
      activeTextAnnotationTypes: { existing: false },
      textAnnotationColors: { existing: "#111111" },
      activeModels: { existing: false },
      confidenceThresholds: { existing: 0.22 },
      yoloTagVisibility: { existing: false },
    });

    const mapCases = [
      {
        read: () => useUiStore.getState().activeTextAnnotationTypes,
        write: () => useUiStore.getState().setTextAnnotationType("added", true),
        expected: { existing: false, added: true },
      },
      {
        read: () => useUiStore.getState().textAnnotationColors,
        write: () => useUiStore.getState().setTextAnnotationColor("added", "#abcdef"),
        expected: { existing: "#111111", added: "#abcdef" },
      },
      {
        read: () => useUiStore.getState().activeModels,
        write: () => useUiStore.getState().setModelActive("added", true),
        expected: { existing: false, added: true },
      },
      {
        read: () => useUiStore.getState().confidenceThresholds,
        write: () => useUiStore.getState().setModelConfidence("added", 0.73),
        expected: { existing: 0.22, added: 0.73 },
      },
      {
        read: () => useUiStore.getState().yoloTagVisibility,
        write: () => useUiStore.getState().setYoloTagVisibility("added", true),
        expected: { existing: false, added: true },
      },
    ];

    for (const { read, write, expected } of mapCases) {
      const before = read();
      write();
      expect(read()).not.toBe(before);
      expect(read()).toEqual(expected);
    }

    const beforeAll = useUiStore.getState().activeTextAnnotationTypes;
    useUiStore.getState().setAllTextAnnotationTypes(false);
    expect(useUiStore.getState().activeTextAnnotationTypes).not.toBe(beforeAll);
    expect(useUiStore.getState().activeTextAnnotationTypes).toEqual({
      existing: false,
      added: false,
    });
  });

  it("rebuilds detection maps while preserving explicit false and zero values", () => {
    useUiStore.setState({
      activeModels: { keep: false, drop: true },
      confidenceThresholds: { keep: 0, drop: 0.91 },
    });
    const beforeModels = useUiStore.getState().activeModels;
    const beforeThresholds = useUiStore.getState().confidenceThresholds;

    useUiStore.getState().initDetectionModels(["keep", "new"]);

    const state = useUiStore.getState();
    expect(state.activeModels).not.toBe(beforeModels);
    expect(state.confidenceThresholds).not.toBe(beforeThresholds);
    expect(state.activeModels).toEqual({ keep: false, new: true });
    expect(state.confidenceThresholds).toEqual({ keep: 0, new: 0.1 });
  });

  it("uses false-as-hidden inversion and copy-on-write table-view deletion", () => {
    const initialClasses = useUiStore.getState().hiddenClasses;
    useUiStore.getState().toggleClassVisibility("model-a", "door");
    const hidden = useUiStore.getState().hiddenClasses;
    expect(hidden).not.toBe(initialClasses);
    expect(hidden).toEqual({ "model-a:door": false });

    useUiStore.getState().toggleClassVisibility("model-a", "door");
    const visible = useUiStore.getState().hiddenClasses;
    expect(visible).not.toBe(hidden);
    expect(visible).toEqual({ "model-a:door": true });

    const firstView: UiData["activeTableTagViews"][string] = {
      regionId: "region-a",
      pageNum: 2,
      bbox: [0.1, 0.2, 0.3, 0.4],
      tagTexts: ["D-101"],
      source: "schedule",
    };
    const secondView: UiData["activeTableTagViews"][string] = {
      regionId: "region-b",
      pageNum: 4,
      bbox: [0.2, 0.3, 0.4, 0.5],
      tagTexts: ["K-1"],
      source: "keynote",
    };

    const empty = useUiStore.getState().activeTableTagViews;
    useUiStore.getState().setTableTagView("region-a", firstView);
    const withFirst = useUiStore.getState().activeTableTagViews;
    expect(withFirst).not.toBe(empty);
    expect(withFirst["region-a"]).toBe(firstView);

    useUiStore.getState().setTableTagView("region-b", secondView);
    const withBoth = useUiStore.getState().activeTableTagViews;
    expect(withBoth).not.toBe(withFirst);
    expect(withBoth["region-a"]).toBe(firstView);
    expect(withBoth["region-b"]).toBe(secondView);

    useUiStore.getState().setTableTagView("region-a", null);
    const afterDelete = useUiStore.getState().activeTableTagViews;
    expect(afterDelete).not.toBe(withBoth);
    expect(afterDelete).toEqual({ "region-b": secondView });

    useUiStore.getState().setTableTagView("missing", null);
    expect(useUiStore.getState().activeTableTagViews).not.toBe(afterDelete);
    expect(useUiStore.getState().activeTableTagViews).toEqual({ "region-b": secondView });
  });

  it("publishes raw panel and YOLO browse bundles once and preserves omitted values", () => {
    const listener = vi.fn();
    const unsubscribe = useUiStore.subscribe(listener);

    useUiStore.getState().setPanelVisibility({
      showDetectionPanel: true,
      showParsePanel: true,
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState()).toMatchObject({
      showDetectionPanel: true,
      showParsePanel: true,
      showChatPanel: true,
    });

    listener.mockClear();
    const highlight: UiData["llmHighlight"] = {
      pageNumber: 7,
      bbox: [0.1, 0.2, 0.3, 0.4],
      label: "Door",
    };
    const visibility = useUiStore.getState().yoloTagVisibility;
    useUiStore.getState().setYoloBrowseState({
      tagBrowseId: "tag-7",
      tagBrowseIndex: 3,
      activeYoloTagId: "tag-7",
      llmHighlight: highlight,
    });

    const bundled = useUiStore.getState();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(bundled).toMatchObject({
      tagBrowseId: "tag-7",
      tagBrowseIndex: 3,
      activeYoloTagId: "tag-7",
    });
    expect(bundled.llmHighlight).toBe(highlight);
    expect(bundled.yoloTagVisibility).toBe(visibility);

    listener.mockClear();
    bundled.setYoloBrowseState({ tagBrowseIndex: 4 });
    const partial = useUiStore.getState();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(partial.tagBrowseIndex).toBe(4);
    expect(partial.tagBrowseId).toBe("tag-7");
    expect(partial.activeYoloTagId).toBe("tag-7");
    expect(partial.llmHighlight).toBe(highlight);
    unsubscribe();
  });

  it("keeps narrow data and action projections isolated from unrelated writes", () => {
    let searchRenders = 0;
    let actionRenders = 0;
    let filterActionRenders = 0;
    const search = renderHook(() => {
      searchRenders += 1;
      return useSearchUi();
    });
    const searchActions = renderHook(() => {
      actionRenders += 1;
      return useSearchUiActions();
    });
    const filterActions = renderHook(() => {
      filterActionRenders += 1;
      return useFilterUiActions();
    });
    const initialSearchRenders = searchRenders;
    const initialActionRenders = actionRenders;
    const initialFilterActionRenders = filterActionRenders;

    act(() => useUiStore.getState().toggleTips());
    expect(searchRenders).toBe(initialSearchRenders);
    expect(actionRenders).toBe(initialActionRenders);
    expect(filterActionRenders).toBe(initialFilterActionRenders);

    const results = [6, 9];
    act(() => useUiStore.getState().setSearchResults(results));
    expect(searchRenders).toBe(initialSearchRenders + 1);
    expect(actionRenders).toBe(initialActionRenders);
    expect(filterActionRenders).toBe(initialFilterActionRenders);
    expect(search.result.current.searchResults).toBe(results);

    act(() => useUiStore.getState().setFocusAnnotationId(12));
    expect(searchRenders).toBe(initialSearchRenders + 1);
    expect(actionRenders).toBe(initialActionRenders);
    expect(filterActionRenders).toBe(initialFilterActionRenders);
    expect(searchActions.result.current.setSearch).toBe(useUiStore.getState().setSearch);
    expect(filterActions.result.current.setTakeoffFilter).toBe(
      useUiStore.getState().setTakeoffFilter,
    );
    search.unmount();
    searchActions.unmount();
    filterActions.unmount();
  });

  it("preserves the exact reset touched/retained value and reference ledger", () => {
    const dirtySelection = new Set([41]);
    const retainedTextAnnotationColors = { note: "#abcdef" };
    const dirtyHiddenClasses = { "model-z:window": false };
    const dirtyHiddenTakeoffs = new Set([42]);
    const dirtyHiddenRegions = new Set(["region-z"]);
    const tableView: UiData["activeTableTagViews"][string] = {
      regionId: "region-z",
      pageNum: 9,
      bbox: [0.1, 0.2, 0.8, 0.9],
      tagTexts: ["Z-9"],
      source: "schedule",
    };
    const dirtyValues = {
      searchQuery: "needle",
      searchResults: [9],
      searchMatches: { 9: [] },
      searchLoading: true,
      focusAnnotationId: 41,
      selectedAnnotationIds: dirtySelection,
      showTextAnnotations: true,
      activeTextAnnotationTypes: { note: true },
      hiddenTextAnnotations: new Set(["9:1"]),
      textAnnotationColors: retainedTextAnnotationColors,
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
      hiddenClasses: dirtyHiddenClasses,
      showKeynotes: true,
      activeKeynoteHighlight: { pageNumber: 9, key: "K-9" },
      hiddenTakeoffItemIds: dirtyHiddenTakeoffs,
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
      hiddenParsedRegionIds: dirtyHiddenRegions,
      focusedParsedRegionId: "region-z",
      activeQtoWorkflow: { id: 91 } as UiData["activeQtoWorkflow"],
    } satisfies UiData;

    useUiStore.setState(dirtyValues);
    const dirty = useUiStore.getState();
    const actionRefs = Object.fromEntries(
      Object.entries(dirty).filter(([, value]) => typeof value === "function"),
    ) as Record<string, unknown>;

    dirty.resetProjectUiState();
    const reset = useUiStore.getState();
    const expectedReset = {
      ...DEFAULT_UI,
      showTextAnnotations: dirtyValues.showTextAnnotations,
      textAnnotationColors: retainedTextAnnotationColors,
      textPanelTab: dirtyValues.textPanelTab,
      sidebarCollapsed: dirtyValues.sidebarCollapsed,
      annotationPanelCollapsed: dirtyValues.annotationPanelCollapsed,
      showTips: dirtyValues.showTips,
      helpMode: dirtyValues.helpMode,
      showTextPanel: dirtyValues.showTextPanel,
      showChatPanel: dirtyValues.showChatPanel,
      showDetections: dirtyValues.showDetections,
      showDetectionPanel: dirtyValues.showDetectionPanel,
      showViewAllPanel: dirtyValues.showViewAllPanel,
      showCsiPanel: dirtyValues.showCsiPanel,
      showPageIntelPanel: dirtyValues.showPageIntelPanel,
      showTakeoffPanel: dirtyValues.showTakeoffPanel,
      showTableParsePanel: dirtyValues.showTableParsePanel,
      showKeynoteParsePanel: dirtyValues.showKeynoteParsePanel,
      showSpecsNotesPanel: dirtyValues.showSpecsNotesPanel,
      showParsePanel: dirtyValues.showParsePanel,
      showToolsPanel: dirtyValues.showToolsPanel,
      showTableCompareModal: dirtyValues.showTableCompareModal,
      specsNotesTab: dirtyValues.specsNotesTab,
      parsePanelTab: dirtyValues.parsePanelTab,
      toolsPanelTab: dirtyValues.toolsPanelTab,
      chatScope: dirtyValues.chatScope,
      showKeynotes: dirtyValues.showKeynotes,
      takeoffTab: dirtyValues.takeoffTab,
      showParsedRegions: dirtyValues.showParsedRegions,
      parsedRegionColorMode: dirtyValues.parsedRegionColorMode,
    } satisfies UiData;

    expect(RETAINED_FIELDS).toHaveLength(29);
    expect(pickUi(reset)).toEqual(expectedReset);
    for (const field of RETAINED_CONTAINER_FIELDS) {
      expect(reset[field], field).toBe(dirty[field]);
    }
    for (const field of REPLACED_CONTAINER_FIELDS) {
      expect(reset[field], field).not.toBe(dirty[field]);
    }
    for (const [field, action] of Object.entries(actionRefs)) {
      expect(reset[field as keyof UiState], field).toBe(action);
    }
  });
});
