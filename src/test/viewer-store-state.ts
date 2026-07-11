// [refactor jul11 P2.3 S0] One test-side seam for mixed viewer/session setup.
//
// The helper accepts one logical test setup patch, but publishes the five ownership partitions to
// sessionStore, uiStore, viewerCoreStore, toolStore, then the residual viewer store. This keeps tests
// explicit about production ownership without repeating routing boilerplate. CSI bootstrap data is
// intentionally absent because its residual graph has a dedicated Query facade.

import { useSessionStore } from "@/stores/sessionStore";
import { useToolStore } from "@/stores/toolStore";
import { useUiStore } from "@/stores/uiStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { useViewerStore } from "@/stores/viewerStore";

export type ViewerStoreTestState = ReturnType<typeof useViewerStore.getState>;
export type SessionStoreTestState = ReturnType<typeof useSessionStore.getState>;
export type UiStoreTestState = ReturnType<typeof useUiStore.getState>;
export type ViewerCoreStoreTestState = ReturnType<typeof useViewerCoreStore.getState>;
export type ToolStoreTestState = ReturnType<typeof useToolStore.getState>;

export const SESSION_TEST_STATE_KEYS = [
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
] as const satisfies readonly (keyof SessionStoreTestState)[];

export type SessionTestStateKey = (typeof SESSION_TEST_STATE_KEYS)[number];
export type SessionStoreTestPatch = Partial<
  Pick<SessionStoreTestState, SessionTestStateKey>
>;

// [refactor jul11 P2.3 U2] Exact presentation-data ownership ledger. Keep this list data-only:
// actions are called from their real owner, never smuggled through a mixed setup patch.
export const UI_TEST_STATE_KEYS = [
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
] as const satisfies readonly (keyof UiStoreTestState)[];

export type UiTestStateKey = (typeof UI_TEST_STATE_KEYS)[number];
export type UiStoreTestPatch = Partial<Pick<UiStoreTestState, UiTestStateKey>>;

export const CORE_TEST_STATE_KEYS = [
  "pageNumber",
  "numPages",
  "scale",
  "pendingCenter",
  "pageDimensions",
] as const satisfies readonly (keyof ViewerCoreStoreTestState)[];

export type CoreTestStateKey = (typeof CORE_TEST_STATE_KEYS)[number];
export type ViewerCoreStoreTestPatch = Partial<
  Pick<ViewerCoreStoreTestState, CoreTestStateKey>
>;

// [refactor jul11 P2.3 T2] Exact data-only tool ownership ledger. Actions stay on their real
// owner and are intentionally excluded from the mixed setup patch's routing contract.
export const TOOL_TEST_STATE_KEYS = [
  "mode",
  "tempPanMode",
  "activeTakeoffItemId",
  "scaleCalibrations",
  "calibrationMode",
  "calibrationPoints",
  "polygonDrawingMode",
  "polygonVertices",
  "bucketFillActive",
  "bucketFillPreview",
  "bucketFillLoading",
  "bucketFillError",
  "bucketFillTolerance",
  "bucketFillDilatePx",
  "bucketFillResolution",
  "bucketFillPendingPolygon",
  "splitAreaActive",
  "splitLineA",
  "splitLineB",
  "splitPreview",
  "splitError",
  "bucketFillBarriers",
  "bucketFillBarrierMode",
  "barrierPendingPoint",
  "takeoffUndoStack",
  "takeoffRedoStack",
  "yoloTagPickingMode",
  "tagScanResults",
  "tagAddingMode",
  "symbolSearchActive",
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
] as const satisfies readonly (keyof ToolStoreTestState)[];

export type ToolTestStateKey = (typeof TOOL_TEST_STATE_KEYS)[number];
export type ToolStoreTestPatch = Partial<Pick<ToolStoreTestState, ToolTestStateKey>>;
export type RemainingViewerStoreTestPatch = Partial<ViewerStoreTestState>;
export type ViewerStoreTestPatch = RemainingViewerStoreTestPatch &
  SessionStoreTestPatch &
  UiStoreTestPatch &
  ViewerCoreStoreTestPatch &
  ToolStoreTestPatch;

const SESSION_TEST_STATE_KEY_SET = new Set<string>(
  SESSION_TEST_STATE_KEYS,
);
const UI_TEST_STATE_KEY_SET = new Set<string>(UI_TEST_STATE_KEYS);
const CORE_TEST_STATE_KEY_SET = new Set<string>(CORE_TEST_STATE_KEYS);
const TOOL_TEST_STATE_KEY_SET = new Set<string>(TOOL_TEST_STATE_KEYS);

export function partitionViewerStoreTestState(patch: ViewerStoreTestPatch): {
  session: SessionStoreTestPatch;
  ui: UiStoreTestPatch;
  core: ViewerCoreStoreTestPatch;
  tool: ToolStoreTestPatch;
  viewer: RemainingViewerStoreTestPatch;
} {
  const sessionEntries: [string, unknown][] = [];
  const uiEntries: [string, unknown][] = [];
  const coreEntries: [string, unknown][] = [];
  const toolEntries: [string, unknown][] = [];
  const viewerEntries: [string, unknown][] = [];

  for (const [key, value] of Object.entries(patch)) {
    const target = SESSION_TEST_STATE_KEY_SET.has(key)
      ? sessionEntries
      : UI_TEST_STATE_KEY_SET.has(key)
        ? uiEntries
        : CORE_TEST_STATE_KEY_SET.has(key)
          ? coreEntries
          : TOOL_TEST_STATE_KEY_SET.has(key)
            ? toolEntries
            : viewerEntries;
    target.push([key, value]);
  }

  return {
    session: Object.fromEntries(sessionEntries) as SessionStoreTestPatch,
    ui: Object.fromEntries(uiEntries) as UiStoreTestPatch,
    core: Object.fromEntries(coreEntries) as ViewerCoreStoreTestPatch,
    tool: Object.fromEntries(toolEntries) as ToolStoreTestPatch,
    viewer: Object.fromEntries(viewerEntries) as RemainingViewerStoreTestPatch,
  };
}

export function setViewerStoreStateForTest(patch: ViewerStoreTestPatch): void {
  const { session, ui, core, tool, viewer } = partitionViewerStoreTestState(patch);

  // Identity/policy must be visible before presentation, geometry, and tool state. Empty
  // partitions are skipped so a one-owner setup remains exactly one publication.
  if (Object.keys(session).length > 0) useSessionStore.setState(session);
  if (Object.keys(ui).length > 0) useUiStore.setState(ui);
  if (Object.keys(core).length > 0) useViewerCoreStore.setState(core);
  if (Object.keys(tool).length > 0) useToolStore.setState(tool);
  if (Object.keys(viewer).length > 0) useViewerStore.setState(viewer);
}
