// [refactor jul11 P2.3 S0] One test-side seam for mixed viewer/session setup.
//
// The helper accepts one logical test setup patch, but publishes the three ownership partitions to
// sessionStore, uiStore, then viewerStore. This keeps tests explicit about production ownership
// without making every mixed setup repeat routing boilerplate. CSI bootstrap data is intentionally
// absent because its residual graph now has a dedicated Query facade instead of these owners.

import { useSessionStore } from "@/stores/sessionStore";
import { useUiStore } from "@/stores/uiStore";
import { useViewerStore } from "@/stores/viewerStore";

export type ViewerStoreTestState = ReturnType<typeof useViewerStore.getState>;
export type SessionStoreTestState = ReturnType<typeof useSessionStore.getState>;
export type UiStoreTestState = ReturnType<typeof useUiStore.getState>;

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
export type RemainingViewerStoreTestPatch = Partial<ViewerStoreTestState>;
export type ViewerStoreTestPatch = RemainingViewerStoreTestPatch &
  SessionStoreTestPatch &
  UiStoreTestPatch;

const SESSION_TEST_STATE_KEY_SET = new Set<string>(
  SESSION_TEST_STATE_KEYS,
);
const UI_TEST_STATE_KEY_SET = new Set<string>(UI_TEST_STATE_KEYS);

export function partitionViewerStoreTestState(patch: ViewerStoreTestPatch): {
  session: SessionStoreTestPatch;
  ui: UiStoreTestPatch;
  viewer: RemainingViewerStoreTestPatch;
} {
  const sessionEntries: [string, unknown][] = [];
  const uiEntries: [string, unknown][] = [];
  const viewerEntries: [string, unknown][] = [];

  for (const [key, value] of Object.entries(patch)) {
    const target = SESSION_TEST_STATE_KEY_SET.has(key)
      ? sessionEntries
      : UI_TEST_STATE_KEY_SET.has(key)
        ? uiEntries
        : viewerEntries;
    target.push([key, value]);
  }

  return {
    session: Object.fromEntries(sessionEntries) as SessionStoreTestPatch,
    ui: Object.fromEntries(uiEntries) as UiStoreTestPatch,
    viewer: Object.fromEntries(viewerEntries) as RemainingViewerStoreTestPatch,
  };
}

export function setViewerStoreStateForTest(patch: ViewerStoreTestPatch): void {
  const { session, ui, viewer } = partitionViewerStoreTestState(patch);

  // Identity/policy must be visible before presentation and viewer state. UI follows session so
  // its subscribers derive Query keys/guards from the destination project; viewer publishes last.
  // Empty partitions are skipped so a one-owner test setup remains exactly one publication.
  if (Object.keys(session).length > 0) useSessionStore.setState(session);
  if (Object.keys(ui).length > 0) useUiStore.setState(ui);
  if (Object.keys(viewer).length > 0) useViewerStore.setState(viewer);
}
