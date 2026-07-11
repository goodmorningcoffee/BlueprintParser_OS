import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

import type { SearchWordMatch, TakeoffTab } from "@/types";

export type TextPanelTab = "ocr" | "annotations" | "graph" | "markups" | "textract";
export type SpecsNotesTab = "spec-parse" | "notes-parse" | "keynotes";
export type ParsePanelTab = "shape" | "template" | "yolo-tag-map";
export type ToolsPanelTab = "csi" | "text" | "intel";
export type ParsedRegionColorMode = "none" | "striped" | "checkerboard";

export interface TextAnnotationFilter {
  type: string;
  text: string;
}

export interface KeynoteFilter {
  shape: string;
  text: string;
}

export interface KeynoteHighlight {
  pageNumber: number;
  key: string;
}

export interface LlmHighlight {
  pageNumber: number;
  bbox: [number, number, number, number];
  label?: string;
}

export interface TableTagView {
  regionId: string;
  pageNum: number;
  bbox: [number, number, number, number];
  tagTexts: string[];
  source: "schedule" | "keynote";
}

/** The exact presentation-only ownership surface frozen by P2.3 U0. */
export interface UiData {
  // Search
  searchQuery: string;
  searchResults: number[];
  searchMatches: Record<number, SearchWordMatch[]>;
  searchLoading: boolean;

  // Annotation focus and multi-selection
  focusAnnotationId: number | null;
  selectedAnnotationIds: Set<number>;

  // Text display and markup
  showTextAnnotations: boolean;
  activeTextAnnotationTypes: Record<string, boolean>;
  hiddenTextAnnotations: Set<string>;
  textAnnotationColors: Record<string, string>;
  activeTextAnnotationFilter: TextAnnotationFilter | null;
  textPanelTab: TextPanelTab;
  activeMarkupId: number | null;

  // Display filters
  activeTakeoffFilter: number | null;
  activeKeynoteFilter: KeynoteFilter | null;
  activeAnnotationFilter: string | null;
  activeTradeFilter: string | null;
  activeCsiFilter: string | null;

  // Layout and help
  sidebarCollapsed: boolean;
  annotationPanelCollapsed: boolean;
  showTips: boolean;
  helpMode: boolean;

  // Panel and overlay visibility
  showTextPanel: boolean;
  showChatPanel: boolean;
  showDetections: boolean;
  showDetectionPanel: boolean;
  showViewAllPanel: boolean;
  showCsiPanel: boolean;
  showPageIntelPanel: boolean;
  showTakeoffPanel: boolean;
  showTableParsePanel: boolean;
  showKeynoteParsePanel: boolean;
  showSpecsNotesPanel: boolean;
  showParsePanel: boolean;
  showToolsPanel: boolean;
  showTableCompareModal: boolean;

  // Container tabs and chat
  specsNotesTab: SpecsNotesTab;
  parsePanelTab: ParsePanelTab;
  toolsPanelTab: ToolsPanelTab;
  chatScope: "page" | "project";

  // Detection display/configuration
  activeModels: Record<string, boolean>;
  confidenceThreshold: number;
  confidenceThresholds: Record<string, number>;
  hiddenAnnotationIds: Set<number>;
  hiddenClasses: Record<string, boolean>;

  // Keynote and takeoff display
  showKeynotes: boolean;
  activeKeynoteHighlight: KeynoteHighlight | null;
  hiddenTakeoffItemIds: Set<number>;
  takeoffTab: TakeoffTab;

  // YOLO display and browsing
  activeYoloTagId: string | null;
  yoloTagVisibility: Record<string, boolean>;
  activeYoloTagFilter: string | null;
  activeTableTagViews: Record<string, TableTagView>;
  tagBrowseId: string | null;
  tagBrowseIndex: number;

  // Generic and parsed-region display
  llmHighlight: LlmHighlight | null;
  showParsedRegions: boolean;
  parsedRegionColorMode: ParsedRegionColorMode;
  hiddenParsedRegionIds: Set<string>;
  focusedParsedRegionId: string | null;
}

// `showDetections` is the canvas overlay gate rather than a sidebar panel, but it remains in this
// 14-key visibility bundle so demo bootstrap and project reset each stay one UI publication.
export type PanelVisibilityField =
  | "showTextPanel"
  | "showChatPanel"
  | "showDetections"
  | "showDetectionPanel"
  | "showViewAllPanel"
  | "showCsiPanel"
  | "showPageIntelPanel"
  | "showTakeoffPanel"
  | "showTableParsePanel"
  | "showKeynoteParsePanel"
  | "showSpecsNotesPanel"
  | "showParsePanel"
  | "showToolsPanel"
  | "showTableCompareModal";

export type PanelVisibilityPatch = Partial<Pick<UiData, PanelVisibilityField>>;

export type YoloBrowsePatch = Partial<
  Pick<UiData, "tagBrowseId" | "tagBrowseIndex" | "activeYoloTagId" | "llmHighlight">
>;

interface UiActions {
  setSearch: (searchQuery: string) => void;
  setSearchResults: (searchResults: number[]) => void;
  setSearchMatches: (searchMatches: Record<number, SearchWordMatch[]>) => void;
  setSearchLoading: (searchLoading: boolean) => void;

  setFocusAnnotationId: (focusAnnotationId: number | null) => void;
  setSelectedAnnotationIds: (selectedAnnotationIds: Set<number>) => void;
  addToSelection: (id: number) => void;
  removeFromSelection: (id: number) => void;
  toggleSelection: (id: number) => void;
  clearSelection: () => void;

  toggleTextAnnotations: () => void;
  setTextAnnotationType: (type: string, active: boolean) => void;
  setAllTextAnnotationTypes: (active: boolean) => void;
  toggleTextAnnotationVisibility: (pageNum: number, index: number) => void;
  setTextAnnotationColor: (type: string, color: string) => void;
  setTextAnnotationFilter: (activeTextAnnotationFilter: TextAnnotationFilter | null) => void;
  setTextPanelTab: (textPanelTab: TextPanelTab) => void;
  setActiveMarkupId: (activeMarkupId: number | null) => void;

  setTakeoffFilter: (activeTakeoffFilter: number | null) => void;
  setKeynoteFilter: (activeKeynoteFilter: KeynoteFilter | null) => void;
  setAnnotationFilter: (activeAnnotationFilter: string | null) => void;
  setTradeFilter: (activeTradeFilter: string | null) => void;
  setCsiFilter: (activeCsiFilter: string | null) => void;

  toggleSidebar: () => void;
  toggleAnnotationPanel: () => void;
  toggleTips: () => void;
  toggleHelpMode: () => void;

  toggleTextPanel: () => void;
  toggleChatPanel: () => void;
  toggleDetections: () => void;
  toggleViewAllPanel: () => void;
  toggleCsiPanel: () => void;
  togglePageIntelPanel: () => void;
  toggleSpecsNotesPanel: () => void;
  toggleToolsPanel: () => void;
  toggleTableCompareModal: () => void;
  setPanelVisibility: (patch: PanelVisibilityPatch) => void;

  setSpecsNotesTab: (specsNotesTab: SpecsNotesTab) => void;
  setParsePanelTab: (parsePanelTab: ParsePanelTab) => void;
  setToolsPanelTab: (toolsPanelTab: ToolsPanelTab) => void;
  setChatScope: (chatScope: "page" | "project") => void;

  setModelActive: (model: string, active: boolean) => void;
  setConfidenceThreshold: (confidenceThreshold: number) => void;
  setModelConfidence: (model: string, threshold: number) => void;
  initDetectionModels: (modelNames: string[]) => void;
  toggleAnnotationVisibility: (id: number) => void;
  toggleClassVisibility: (model: string, cls: string) => void;

  toggleKeynotes: () => void;
  setActiveKeynoteHighlight: (activeKeynoteHighlight: KeynoteHighlight | null) => void;
  toggleTakeoffItemVisibility: (itemId: number) => void;
  setTakeoffTab: (takeoffTab: TakeoffTab) => void;

  setActiveYoloTagId: (activeYoloTagId: string | null) => void;
  setYoloTagVisibility: (id: string, visible: boolean) => void;
  setYoloTagFilter: (activeYoloTagFilter: string | null) => void;
  setTableTagView: (regionId: string, view: TableTagView | null) => void;
  setYoloBrowseState: (patch: YoloBrowsePatch) => void;

  setLlmHighlight: (llmHighlight: LlmHighlight | null) => void;
  toggleParsedRegions: () => void;
  setParsedRegionColorMode: (parsedRegionColorMode: ParsedRegionColorMode) => void;
  toggleParsedRegionVisibility: (id: string) => void;
  setFocusedParsedRegionId: (focusedParsedRegionId: string | null) => void;

  resetProjectUiState: () => void;
}

export interface UiState extends UiData, UiActions {}

function freshUiState(): UiData {
  return {
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
    confidenceThreshold: 0.10,
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
  };
}

function freshProjectUiReset(): Partial<UiData> {
  return {
    searchQuery: "",
    searchResults: [],
    searchMatches: {},
    searchLoading: false,
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
    confidenceThreshold: 0.10,
    confidenceThresholds: {},
    hiddenAnnotationIds: new Set<number>(),
    activeKeynoteHighlight: null,
    takeoffTab: "count",
    activeYoloTagId: null,
    yoloTagVisibility: {},
    activeYoloTagFilter: null,
    activeTableTagViews: {},
    tagBrowseId: null,
    tagBrowseIndex: 0,
    llmHighlight: null,
    focusedParsedRegionId: null,
  };
}

// Cross-store panel teardown and navigation live in a neutral coordinator. This leaf exposes only
// raw bundled publications, so one legacy publication cannot accidentally fan out into many.
export const useUiStore = create<UiState>((set) => ({
  ...freshUiState(),

  setSearch: (searchQuery) => set({ searchQuery }),
  setSearchResults: (searchResults) => set({ searchResults }),
  setSearchMatches: (searchMatches) => set({ searchMatches }),
  setSearchLoading: (searchLoading) => set({ searchLoading }),

  setFocusAnnotationId: (focusAnnotationId) => set({ focusAnnotationId }),
  setSelectedAnnotationIds: (selectedAnnotationIds) => set({ selectedAnnotationIds }),
  addToSelection: (id) =>
    set((state) => {
      if (state.selectedAnnotationIds.has(id)) return {};
      const next = new Set(state.selectedAnnotationIds);
      next.add(id);
      return { selectedAnnotationIds: next };
    }),
  removeFromSelection: (id) =>
    set((state) => {
      if (!state.selectedAnnotationIds.has(id)) return {};
      const next = new Set(state.selectedAnnotationIds);
      next.delete(id);
      return { selectedAnnotationIds: next };
    }),
  toggleSelection: (id) =>
    set((state) => {
      const next = new Set(state.selectedAnnotationIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { selectedAnnotationIds: next };
    }),
  clearSelection: () => set({ selectedAnnotationIds: new Set<number>() }),

  toggleTextAnnotations: () =>
    set((state) => ({ showTextAnnotations: !state.showTextAnnotations })),
  setTextAnnotationType: (type, active) =>
    set((state) => ({
      activeTextAnnotationTypes: { ...state.activeTextAnnotationTypes, [type]: active },
    })),
  setAllTextAnnotationTypes: (active) =>
    set((state) => {
      const activeTextAnnotationTypes: Record<string, boolean> = {};
      for (const key of Object.keys(state.activeTextAnnotationTypes)) {
        activeTextAnnotationTypes[key] = active;
      }
      return { activeTextAnnotationTypes };
    }),
  toggleTextAnnotationVisibility: (pageNum, index) =>
    set((state) => {
      const key = `${pageNum}:${index}`;
      const next = new Set(state.hiddenTextAnnotations);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { hiddenTextAnnotations: next };
    }),
  setTextAnnotationColor: (type, color) =>
    set((state) => ({ textAnnotationColors: { ...state.textAnnotationColors, [type]: color } })),
  setTextAnnotationFilter: (activeTextAnnotationFilter) => set({ activeTextAnnotationFilter }),
  setTextPanelTab: (textPanelTab) => set({ textPanelTab }),
  setActiveMarkupId: (activeMarkupId) => set({ activeMarkupId }),

  setTakeoffFilter: (activeTakeoffFilter) => set({ activeTakeoffFilter }),
  setKeynoteFilter: (activeKeynoteFilter) => set({ activeKeynoteFilter }),
  setAnnotationFilter: (activeAnnotationFilter) => set({ activeAnnotationFilter }),
  setTradeFilter: (activeTradeFilter) => set({ activeTradeFilter }),
  setCsiFilter: (activeCsiFilter) => set({ activeCsiFilter }),

  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  toggleAnnotationPanel: () =>
    set((state) => ({ annotationPanelCollapsed: !state.annotationPanelCollapsed })),
  toggleTips: () => set((state) => ({ showTips: !state.showTips })),
  toggleHelpMode: () => set((state) => ({ helpMode: !state.helpMode })),

  toggleTextPanel: () => set((state) => ({ showTextPanel: !state.showTextPanel })),
  toggleChatPanel: () => set((state) => ({ showChatPanel: !state.showChatPanel })),
  toggleDetections: () => set((state) => ({ showDetections: !state.showDetections })),
  toggleViewAllPanel: () => set((state) => ({ showViewAllPanel: !state.showViewAllPanel })),
  toggleCsiPanel: () => set((state) => ({ showCsiPanel: !state.showCsiPanel })),
  togglePageIntelPanel: () =>
    set((state) => ({ showPageIntelPanel: !state.showPageIntelPanel })),
  toggleSpecsNotesPanel: () =>
    set((state) => ({ showSpecsNotesPanel: !state.showSpecsNotesPanel })),
  toggleToolsPanel: () => set((state) => ({ showToolsPanel: !state.showToolsPanel })),
  toggleTableCompareModal: () =>
    set((state) => ({ showTableCompareModal: !state.showTableCompareModal })),
  setPanelVisibility: (patch) => set(patch),

  setSpecsNotesTab: (specsNotesTab) => set({ specsNotesTab }),
  setParsePanelTab: (parsePanelTab) => set({ parsePanelTab }),
  setToolsPanelTab: (toolsPanelTab) => set({ toolsPanelTab }),
  setChatScope: (chatScope) => set({ chatScope }),

  setModelActive: (model, active) =>
    set((state) => ({ activeModels: { ...state.activeModels, [model]: active } })),
  setConfidenceThreshold: (confidenceThreshold) => set({ confidenceThreshold }),
  setModelConfidence: (model, threshold) =>
    set((state) => ({
      confidenceThresholds: { ...state.confidenceThresholds, [model]: threshold },
    })),
  initDetectionModels: (modelNames) =>
    set((state) => {
      const activeModels: Record<string, boolean> = {};
      const confidenceThresholds: Record<string, number> = {};
      for (const name of modelNames) {
        activeModels[name] = state.activeModels[name] ?? true;
        confidenceThresholds[name] = state.confidenceThresholds[name] ?? 0.10;
      }
      return { activeModels, confidenceThresholds };
    }),
  toggleAnnotationVisibility: (id) =>
    set((state) => {
      const next = new Set(state.hiddenAnnotationIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { hiddenAnnotationIds: next };
    }),
  toggleClassVisibility: (model, cls) =>
    set((state) => {
      const key = `${model}:${cls}`;
      const current = state.hiddenClasses[key] !== false;
      // The legacy map stores the inverse of its name: exactly false is hidden; missing is visible.
      return { hiddenClasses: { ...state.hiddenClasses, [key]: !current } };
    }),

  toggleKeynotes: () => set((state) => ({ showKeynotes: !state.showKeynotes })),
  setActiveKeynoteHighlight: (activeKeynoteHighlight) => set({ activeKeynoteHighlight }),
  toggleTakeoffItemVisibility: (itemId) =>
    set((state) => {
      const next = new Set(state.hiddenTakeoffItemIds);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return { hiddenTakeoffItemIds: next };
    }),
  setTakeoffTab: (takeoffTab) => set({ takeoffTab }),

  setActiveYoloTagId: (activeYoloTagId) => set({ activeYoloTagId }),
  setYoloTagVisibility: (id, visible) =>
    set((state) => ({ yoloTagVisibility: { ...state.yoloTagVisibility, [id]: visible } })),
  setYoloTagFilter: (activeYoloTagFilter) => set({ activeYoloTagFilter }),
  setTableTagView: (regionId, view) =>
    set((state) => {
      const activeTableTagViews = { ...state.activeTableTagViews };
      if (view) activeTableTagViews[regionId] = view;
      else delete activeTableTagViews[regionId];
      return { activeTableTagViews };
    }),
  setYoloBrowseState: (patch) => set(patch),

  setLlmHighlight: (llmHighlight) => set({ llmHighlight }),
  toggleParsedRegions: () =>
    set((state) => ({ showParsedRegions: !state.showParsedRegions })),
  setParsedRegionColorMode: (parsedRegionColorMode) => set({ parsedRegionColorMode }),
  toggleParsedRegionVisibility: (id) =>
    set((state) => {
      const next = new Set(state.hiddenParsedRegionIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { hiddenParsedRegionIds: next };
    }),
  setFocusedParsedRegionId: (focusedParsedRegionId) => set({ focusedParsedRegionId }),

  // Preserve today's project-switch omissions. P2.5 owns the policy decision about retained UI.
  resetProjectUiState: () => set(freshProjectUiReset()),
}));

export const useSearchUi = () =>
  useUiStore(
    useShallow((state) => ({
      searchQuery: state.searchQuery,
      searchResults: state.searchResults,
      searchMatches: state.searchMatches,
      searchLoading: state.searchLoading,
    })),
  );

export const useSearchUiActions = () =>
  useUiStore(
    useShallow((state) => ({
      setSearch: state.setSearch,
      setSearchResults: state.setSearchResults,
      setSearchMatches: state.setSearchMatches,
      setSearchLoading: state.setSearchLoading,
    })),
  );

export const useSelectionUi = () =>
  useUiStore(
    useShallow((state) => ({
      selectedAnnotationIds: state.selectedAnnotationIds,
    })),
  );

export const useSelectionUiActions = () =>
  useUiStore(
    useShallow((state) => ({
      setFocusAnnotationId: state.setFocusAnnotationId,
      setSelectedAnnotationIds: state.setSelectedAnnotationIds,
      addToSelection: state.addToSelection,
      removeFromSelection: state.removeFromSelection,
      toggleSelection: state.toggleSelection,
      clearSelection: state.clearSelection,
    })),
  );

// Filter writers are intentionally action-only. Most readers need one primitive filter, while
// grouping all five values would make unrelated panel filters re-render together.
export const useFilterUiActions = () =>
  useUiStore(
    useShallow((state) => ({
      setTakeoffFilter: state.setTakeoffFilter,
      setKeynoteFilter: state.setKeynoteFilter,
      setAnnotationFilter: state.setAnnotationFilter,
      setTradeFilter: state.setTradeFilter,
      setCsiFilter: state.setCsiFilter,
    })),
  );

export const usePanelVisibility = () =>
  useUiStore(
    useShallow((state) => ({
      showTextPanel: state.showTextPanel,
      showChatPanel: state.showChatPanel,
      showDetections: state.showDetections,
      showDetectionPanel: state.showDetectionPanel,
      showViewAllPanel: state.showViewAllPanel,
      showCsiPanel: state.showCsiPanel,
      showPageIntelPanel: state.showPageIntelPanel,
      showTakeoffPanel: state.showTakeoffPanel,
      showTableParsePanel: state.showTableParsePanel,
      showKeynoteParsePanel: state.showKeynoteParsePanel,
      showSpecsNotesPanel: state.showSpecsNotesPanel,
      showParsePanel: state.showParsePanel,
      showToolsPanel: state.showToolsPanel,
      showTableCompareModal: state.showTableCompareModal,
    })),
  );

export const usePanelUiActions = () =>
  useUiStore(
    useShallow((state) => ({
      toggleTextPanel: state.toggleTextPanel,
      toggleChatPanel: state.toggleChatPanel,
      toggleDetections: state.toggleDetections,
      toggleViewAllPanel: state.toggleViewAllPanel,
      toggleCsiPanel: state.toggleCsiPanel,
      togglePageIntelPanel: state.togglePageIntelPanel,
      toggleSpecsNotesPanel: state.toggleSpecsNotesPanel,
      toggleToolsPanel: state.toggleToolsPanel,
      toggleTableCompareModal: state.toggleTableCompareModal,
      setPanelVisibility: state.setPanelVisibility,
    })),
  );

export const useLayoutUi = () =>
  useUiStore(
    useShallow((state) => ({
      sidebarCollapsed: state.sidebarCollapsed,
      annotationPanelCollapsed: state.annotationPanelCollapsed,
      showTips: state.showTips,
      helpMode: state.helpMode,
    })),
  );

export const useLayoutUiActions = () =>
  useUiStore(
    useShallow((state) => ({
      toggleSidebar: state.toggleSidebar,
      toggleAnnotationPanel: state.toggleAnnotationPanel,
      toggleTips: state.toggleTips,
      toggleHelpMode: state.toggleHelpMode,
    })),
  );

export const usePanelTabs = () =>
  useUiStore(
    useShallow((state) => ({
      textPanelTab: state.textPanelTab,
      specsNotesTab: state.specsNotesTab,
      parsePanelTab: state.parsePanelTab,
      toolsPanelTab: state.toolsPanelTab,
    })),
  );

export const usePanelTabActions = () =>
  useUiStore(
    useShallow((state) => ({
      setTextPanelTab: state.setTextPanelTab,
      setSpecsNotesTab: state.setSpecsNotesTab,
      setParsePanelTab: state.setParsePanelTab,
      setToolsPanelTab: state.setToolsPanelTab,
    })),
  );

export const useDetectionUi = () =>
  useUiStore(
    useShallow((state) => ({
      activeModels: state.activeModels,
      confidenceThreshold: state.confidenceThreshold,
      confidenceThresholds: state.confidenceThresholds,
      hiddenAnnotationIds: state.hiddenAnnotationIds,
      hiddenClasses: state.hiddenClasses,
      activeAnnotationFilter: state.activeAnnotationFilter,
    })),
  );

export const useDetectionUiActions = () =>
  useUiStore(
    useShallow((state) => ({
      setModelActive: state.setModelActive,
      setConfidenceThreshold: state.setConfidenceThreshold,
      setModelConfidence: state.setModelConfidence,
      initDetectionModels: state.initDetectionModels,
      toggleAnnotationVisibility: state.toggleAnnotationVisibility,
      toggleClassVisibility: state.toggleClassVisibility,
      setAnnotationFilter: state.setAnnotationFilter,
    })),
  );

/**
 * Sacred canvas projection retained byte-shaped from AnnotationOverlay. This is the one deliberate
 * broad UI read: those eight values jointly decide which annotation primitives are painted.
 */
export const useAnnotationFiltersUi = () =>
  useUiStore(
    useShallow((state) => ({
      showDetections: state.showDetections,
      confidenceThreshold: state.confidenceThreshold,
      activeModels: state.activeModels,
      hiddenClasses: state.hiddenClasses,
      confidenceThresholds: state.confidenceThresholds,
      activeAnnotationFilter: state.activeAnnotationFilter,
      activeCsiFilter: state.activeCsiFilter,
      hiddenAnnotationIds: state.hiddenAnnotationIds,
    })),
  );

export const useTextAnnotationUi = () =>
  useUiStore(
    useShallow((state) => ({
      showTextAnnotations: state.showTextAnnotations,
      activeTextAnnotationTypes: state.activeTextAnnotationTypes,
      hiddenTextAnnotations: state.hiddenTextAnnotations,
      textAnnotationColors: state.textAnnotationColors,
      activeTextAnnotationFilter: state.activeTextAnnotationFilter,
    })),
  );

export const useTextAnnotationUiActions = () =>
  useUiStore(
    useShallow((state) => ({
      toggleTextAnnotations: state.toggleTextAnnotations,
      setTextAnnotationType: state.setTextAnnotationType,
      setAllTextAnnotationTypes: state.setAllTextAnnotationTypes,
      toggleTextAnnotationVisibility: state.toggleTextAnnotationVisibility,
      setTextAnnotationColor: state.setTextAnnotationColor,
      setTextAnnotationFilter: state.setTextAnnotationFilter,
    })),
  );

export const useYoloDisplayUi = () =>
  useUiStore(
    useShallow((state) => ({
      activeYoloTagId: state.activeYoloTagId,
      yoloTagVisibility: state.yoloTagVisibility,
      activeYoloTagFilter: state.activeYoloTagFilter,
      activeTableTagViews: state.activeTableTagViews,
      tagBrowseId: state.tagBrowseId,
      tagBrowseIndex: state.tagBrowseIndex,
      llmHighlight: state.llmHighlight,
    })),
  );

export const useYoloDisplayUiActions = () =>
  useUiStore(
    useShallow((state) => ({
      setActiveYoloTagId: state.setActiveYoloTagId,
      setYoloTagVisibility: state.setYoloTagVisibility,
      setYoloTagFilter: state.setYoloTagFilter,
      setTableTagView: state.setTableTagView,
      setYoloBrowseState: state.setYoloBrowseState,
      setLlmHighlight: state.setLlmHighlight,
    })),
  );

export const useParsedRegionUi = () =>
  useUiStore(
    useShallow((state) => ({
      showParsedRegions: state.showParsedRegions,
      parsedRegionColorMode: state.parsedRegionColorMode,
      hiddenParsedRegionIds: state.hiddenParsedRegionIds,
      focusedParsedRegionId: state.focusedParsedRegionId,
    })),
  );

export const useParsedRegionUiActions = () =>
  useUiStore(
    useShallow((state) => ({
      toggleParsedRegions: state.toggleParsedRegions,
      setParsedRegionColorMode: state.setParsedRegionColorMode,
      toggleParsedRegionVisibility: state.toggleParsedRegionVisibility,
      setFocusedParsedRegionId: state.setFocusedParsedRegionId,
    })),
  );
