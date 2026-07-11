// [refactor jul11 P2.3 S0] One test-side seam for mixed viewer/session setup.
//
// The helper accepts one logical test setup patch and partitions session, UI, core, tool, parse,
// then residual viewer state. During P2.4 F0 parse + residual are coalesced into their current one
// physical viewerStore publication; S2 makes the logical boundary physical. This keeps tests
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

// [refactor jul11 P2.4 F0] Exact logical parse-data ledger. Parse still physically lives in
// viewerStore during F0, but partitioning it now gives mixed test setup the final deterministic
// session -> UI -> core -> tool -> parse -> residual order. S2 changes only this partition's
// physical target to parseFlowStore; test call sites and the 35-key contract remain fixed.
export const PARSE_TEST_STATE_KEYS = [
  "tableParseStep",
  "tableParseRegion",
  "tableParsedGrid",
  "tableParseMeta",
  "tableCellStructure",
  "showTableCellStructure",
  "tableParseColumnBBs",
  "tableParseColumnNames",
  "tableParseRowBBs",
  "tableParseTab",
  "tableParseOptions",
  "keynoteParseTab",
  "keynoteParseStep",
  "keynoteParseRegion",
  "keynoteColumnBBs",
  "keynoteRowBBs",
  "keynoteYoloClass",
  "parsedKeynoteData",
  "notesParseStep",
  "notesParseRegion",
  "guidedNotesRows",
  "guidedNotesCols",
  "notesFastManualActive",
  "notesFastManualGrid",
  "parseDraftRegion",
  "specParseStep",
  "specParseRegion",
  "guidedSpecSectionBBs",
  "paragraphOverlayActive",
  "paragraphBatch",
  "paragraphClipboard",
  "guidedParseActive",
  "guidedParseRegion",
  "guidedParseRows",
  "guidedParseCols",
] as const satisfies readonly (keyof ViewerStoreTestState)[];

export type ParseTestStateKey = (typeof PARSE_TEST_STATE_KEYS)[number];

// Action overrides are uncommon, but they must never fall through to the residual viewer
// partition. Keeping the action ledger independent also makes a stale helper override fail at the
// same ownership seam as ordinary parse data during S2.
export const PARSE_TEST_ACTION_KEYS = [
  "setTableParseRegion",
  "setTableParsedGrid",
  "setTableParseMeta",
  "setTableCellStructure",
  "toggleCellHighlight",
  "setShowTableCellStructure",
  "addTableParseColumnBB",
  "setTableParseColumnNames",
  "addTableParseRowBB",
  "setTableParseRowBBs",
  "resetTableParse",
  "setTableParseTab",
  "setTableParseOptions",
  "setKeynoteParseTab",
  "setKeynoteParseRegion",
  "addKeynoteColumnBB",
  "addKeynoteRowBB",
  "setKeynoteYoloClass",
  "setParsedKeynoteData",
  "addParsedKeynote",
  "resetKeynoteParse",
  "setNotesParseRegion",
  "addGuidedNotesRow",
  "addGuidedNotesCol",
  "resetNotesParse",
  "setNotesFastManualActive",
  "setNotesFastManualGrid",
  "setParseDraftRegion",
  "setSpecParseRegion",
  "addGuidedSpecSectionBB",
  "resetSpecParse",
  "setParagraphOverlayActive",
  "setParagraphBatch",
  "upsertPendingParagraph",
  "removePendingParagraph",
  "setParagraphClipboard",
  "setGuidedParseActive",
  "setGuidedParseRegion",
  "setGuidedParseRows",
  "setGuidedParseCols",
  "resetGuidedParse",
] as const satisfies readonly (keyof ViewerStoreTestState)[];

export type ParseTestActionKey = (typeof PARSE_TEST_ACTION_KEYS)[number];
export type ParseStoreTestPatch = Partial<
  Pick<ViewerStoreTestState, ParseTestStateKey | ParseTestActionKey>
>;
export type RemainingViewerStoreTestPatch = Partial<
  Omit<ViewerStoreTestState, ParseTestStateKey | ParseTestActionKey>
>;
export type ViewerStoreTestPatch = RemainingViewerStoreTestPatch &
  SessionStoreTestPatch &
  UiStoreTestPatch &
  ViewerCoreStoreTestPatch &
  ToolStoreTestPatch &
  ParseStoreTestPatch;

const SESSION_TEST_STATE_KEY_SET = new Set<string>(
  SESSION_TEST_STATE_KEYS,
);
const UI_TEST_STATE_KEY_SET = new Set<string>(UI_TEST_STATE_KEYS);
const CORE_TEST_STATE_KEY_SET = new Set<string>(CORE_TEST_STATE_KEYS);
const TOOL_TEST_STATE_KEY_SET = new Set<string>(TOOL_TEST_STATE_KEYS);
const PARSE_TEST_KEY_SET = new Set<string>([
  ...PARSE_TEST_STATE_KEYS,
  ...PARSE_TEST_ACTION_KEYS,
]);

export function partitionViewerStoreTestState(patch: ViewerStoreTestPatch): {
  session: SessionStoreTestPatch;
  ui: UiStoreTestPatch;
  core: ViewerCoreStoreTestPatch;
  tool: ToolStoreTestPatch;
  parse: ParseStoreTestPatch;
  viewer: RemainingViewerStoreTestPatch;
} {
  const sessionEntries: [string, unknown][] = [];
  const uiEntries: [string, unknown][] = [];
  const coreEntries: [string, unknown][] = [];
  const toolEntries: [string, unknown][] = [];
  const parseEntries: [string, unknown][] = [];
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
            : PARSE_TEST_KEY_SET.has(key)
              ? parseEntries
              : viewerEntries;
    target.push([key, value]);
  }

  return {
    session: Object.fromEntries(sessionEntries) as SessionStoreTestPatch,
    ui: Object.fromEntries(uiEntries) as UiStoreTestPatch,
    core: Object.fromEntries(coreEntries) as ViewerCoreStoreTestPatch,
    tool: Object.fromEntries(toolEntries) as ToolStoreTestPatch,
    parse: Object.fromEntries(parseEntries) as ParseStoreTestPatch,
    viewer: Object.fromEntries(viewerEntries) as RemainingViewerStoreTestPatch,
  };
}

export function setViewerStoreStateForTest(patch: ViewerStoreTestPatch): void {
  const { session, ui, core, tool, parse, viewer } = partitionViewerStoreTestState(patch);

  // Identity/policy must be visible before presentation, geometry, tool, parse, and residual state.
  // Empty partitions are skipped so a one-owner setup remains exactly one publication.
  if (Object.keys(session).length > 0) useSessionStore.setState(session);
  if (Object.keys(ui).length > 0) useUiStore.setState(ui);
  if (Object.keys(core).length > 0) useViewerCoreStore.setState(core);
  if (Object.keys(tool).length > 0) useToolStore.setState(tool);
  // F0's logical parse and residual partitions still share one physical owner. Coalesce them to
  // preserve the legacy one-publication setup contract; S2 replaces this line with parse-owner
  // then residual-viewer publications without changing the partition or any caller.
  const currentViewerPatch = { ...parse, ...viewer };
  if (Object.keys(currentViewerPatch).length > 0) useViewerStore.setState(currentViewerPatch);
}
