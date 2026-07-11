// [refactor jul11 P2.3 S0] One test-side seam for mixed viewer/session setup.
//
// The helper accepts one logical test setup patch, but publishes the four ownership partitions to
// sessionStore, uiStore, viewerCoreStore, then the residual viewer/tool store. This keeps tests
// explicit about production ownership without repeating routing boilerplate. CSI bootstrap data is
// intentionally absent because its residual graph has a dedicated Query facade.

import { useSessionStore } from "@/stores/sessionStore";
import { useUiStore } from "@/stores/uiStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { useViewerStore } from "@/stores/viewerStore";

export type ViewerStoreTestState = ReturnType<typeof useViewerStore.getState>;
export type SessionStoreTestState = ReturnType<typeof useSessionStore.getState>;
export type UiStoreTestState = ReturnType<typeof useUiStore.getState>;
export type ViewerCoreStoreTestState = ReturnType<typeof useViewerCoreStore.getState>;

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
export type RemainingViewerStoreTestPatch = Partial<ViewerStoreTestState>;
export type ViewerStoreTestPatch = RemainingViewerStoreTestPatch &
  SessionStoreTestPatch &
  UiStoreTestPatch &
  ViewerCoreStoreTestPatch;

const SESSION_TEST_STATE_KEY_SET = new Set<string>(
  SESSION_TEST_STATE_KEYS,
);
const UI_TEST_STATE_KEY_SET = new Set<string>(UI_TEST_STATE_KEYS);
const CORE_TEST_STATE_KEY_SET = new Set<string>(CORE_TEST_STATE_KEYS);

export function partitionViewerStoreTestState(patch: ViewerStoreTestPatch): {
  session: SessionStoreTestPatch;
  ui: UiStoreTestPatch;
  core: ViewerCoreStoreTestPatch;
  viewer: RemainingViewerStoreTestPatch;
} {
  const sessionEntries: [string, unknown][] = [];
  const uiEntries: [string, unknown][] = [];
  const coreEntries: [string, unknown][] = [];
  const viewerEntries: [string, unknown][] = [];

  for (const [key, value] of Object.entries(patch)) {
    const target = SESSION_TEST_STATE_KEY_SET.has(key)
      ? sessionEntries
      : UI_TEST_STATE_KEY_SET.has(key)
        ? uiEntries
        : CORE_TEST_STATE_KEY_SET.has(key)
          ? coreEntries
          : viewerEntries;
    target.push([key, value]);
  }

  return {
    session: Object.fromEntries(sessionEntries) as SessionStoreTestPatch,
    ui: Object.fromEntries(uiEntries) as UiStoreTestPatch,
    core: Object.fromEntries(coreEntries) as ViewerCoreStoreTestPatch,
    viewer: Object.fromEntries(viewerEntries) as RemainingViewerStoreTestPatch,
  };
}

export function setViewerStoreStateForTest(patch: ViewerStoreTestPatch): void {
  const { session, ui, core, viewer } = partitionViewerStoreTestState(patch);

  // Identity/policy must be visible before presentation, geometry, and tool state. Empty
  // partitions are skipped so a one-owner setup remains exactly one publication.
  if (Object.keys(session).length > 0) useSessionStore.setState(session);
  if (Object.keys(ui).length > 0) useUiStore.setState(ui);
  if (Object.keys(core).length > 0) useViewerCoreStore.setState(core);
  if (Object.keys(viewer).length > 0) useViewerStore.setState(viewer);
}
