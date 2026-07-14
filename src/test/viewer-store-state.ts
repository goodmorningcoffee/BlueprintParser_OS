// [refactor jul11 P2.3 S0] One test-side seam for mixed viewer/session setup.
//
// The helper accepts one logical test setup patch and partitions session, UI, core, tool, parse,
// then residual viewer state. P2.4 S2 makes every logical boundary physical and preserves that
// publication order. This keeps tests explicit about production ownership without repeating
// routing boilerplate. CSI bootstrap data is intentionally absent because its residual graph has a
// dedicated Query facade.

import {
  useParseFlowStore,
  type ParseFlowState,
} from "@/stores/parseFlowStore";
import { useSessionStore } from "@/stores/sessionStore";
import { useToolStore } from "@/stores/toolStore";
import { useUiStore } from "@/stores/uiStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { useViewerStore } from "@/stores/viewerStore";

export type ViewerStoreTestState = ReturnType<typeof useViewerStore.getState>;
export type SessionStoreTestState = ReturnType<typeof useSessionStore.getState>;
export type UiStoreTestState = ReturnType<typeof useUiStore.getState>;
export type ViewerCoreStoreTestState = ReturnType<
  typeof useViewerCoreStore.getState
>;
export type ToolStoreTestState = ReturnType<typeof useToolStore.getState>;
export type ParseStoreTestState = ParseFlowState;

export const SESSION_TEST_STATE_KEYS = [
  "projectId",
  "publicId",
  "assetBaseUrl",
  "isDemo",
  "demoFeatureConfig",
  "pageNames",
  "pageDrawingNumbers",
  "showLabelingWizard",
  "labelingWizardStep",
  "labelingSessions",
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
  "activeQtoWorkflow",
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

// [refactor jul13 P2.3] Exact tool setup ledger. Data stays separate from the four drawing action
// overrides so tests cannot smuggle unrelated Tool commands through this mixed setup seam.
export const TOOL_TEST_STATE_KEYS = [
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
] as const satisfies readonly (keyof ToolStoreTestState)[];

export type ToolTestStateKey = (typeof TOOL_TEST_STATE_KEYS)[number];
export const TOOL_TEST_ACTION_KEYS = [
  "_setDrawing",
  "_setDrawStart",
  "_setDrawEnd",
  "_setMousePos",
] as const satisfies readonly (keyof ToolStoreTestState)[];
export type ToolTestActionKey = (typeof TOOL_TEST_ACTION_KEYS)[number];
export type ToolStoreTestPatch = Partial<
  Pick<ToolStoreTestState, ToolTestStateKey | ToolTestActionKey>
>;

// [refactor jul11 P2.4 S2] Exact parse-owner ledger. Mixed setup publishes in deterministic
// session -> UI -> core -> tool -> parse -> residual order; call sites stay flat.
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
  "paragraphWorkspaceOwner",
  "paragraphBatch",
  "paragraphClipboard",
  "guidedParseOwner",
  "guidedParseActive",
  "guidedParseRegion",
  "guidedParseRows",
  "guidedParseCols",
] as const satisfies readonly (keyof ParseStoreTestState)[];

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
  "resetSpecParse",
  "setParagraphBatch",
  "upsertPendingParagraph",
  "removePendingParagraph",
  "setParagraphClipboard",
  "setGuidedParseActive",
  "setGuidedParseRegion",
  "setGuidedParseRows",
  "setGuidedParseCols",
  "resetGuidedParse",
] as const satisfies readonly (keyof ParseStoreTestState)[];

export type ParseTestActionKey = (typeof PARSE_TEST_ACTION_KEYS)[number];
export type ParseStoreTestPatch = Partial<
  Pick<ParseStoreTestState, ParseTestStateKey | ParseTestActionKey>
>;

// [refactor jul11 P2.4 S2] Keep the residual test seam independently enumerable. Falling every
// unknown key through to Viewer used to make an omitted migration ledger entry silently recreate
// hidden state through Zustand's permissive setState API. The exhaustive list and fail-closed
// partition below turn that class of ownership mistake into a type error or an immediate test
// setup error.
export const REMAINING_VIEWER_TEST_KEYS = [
  "allTrades",
  "setAllTrades",
  "allCsiCodes",
  "setAllCsiCodes",
  "resetViewerState",
] as const satisfies readonly (keyof ViewerStoreTestState)[];

type RemainingViewerTestKey = (typeof REMAINING_VIEWER_TEST_KEYS)[number];
type MissingRemainingViewerTestKey = Exclude<
  keyof ViewerStoreTestState,
  RemainingViewerTestKey
>;
// This assignment deliberately fails when Viewer gains a member without an explicit routing
// decision here. `satisfies` above independently rejects stale/extra ledger members.
const REMAINING_VIEWER_TEST_KEYS_ARE_EXHAUSTIVE: MissingRemainingViewerTestKey extends never
  ? true
  : never = true;
void REMAINING_VIEWER_TEST_KEYS_ARE_EXHAUSTIVE;

export type RemainingViewerStoreTestPatch = Partial<
  Pick<ViewerStoreTestState, RemainingViewerTestKey>
>;
export type ViewerStoreTestPatch = RemainingViewerStoreTestPatch &
  SessionStoreTestPatch &
  UiStoreTestPatch &
  ViewerCoreStoreTestPatch &
  ToolStoreTestPatch &
  ParseStoreTestPatch;

const SESSION_TEST_STATE_KEY_SET = new Set<string>(SESSION_TEST_STATE_KEYS);
const UI_TEST_STATE_KEY_SET = new Set<string>(UI_TEST_STATE_KEYS);
const CORE_TEST_STATE_KEY_SET = new Set<string>(CORE_TEST_STATE_KEYS);
const TOOL_TEST_STATE_KEY_SET = new Set<string>([
  ...TOOL_TEST_STATE_KEYS,
  ...TOOL_TEST_ACTION_KEYS,
]);
const PARSE_TEST_KEY_SET = new Set<string>([
  ...PARSE_TEST_STATE_KEYS,
  ...PARSE_TEST_ACTION_KEYS,
]);
const REMAINING_VIEWER_TEST_KEY_SET = new Set<string>(
  REMAINING_VIEWER_TEST_KEYS,
);

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
              : REMAINING_VIEWER_TEST_KEY_SET.has(key)
                ? viewerEntries
                : null;
    if (!target) {
      throw new Error(`Unowned viewer test-state key: ${key}`);
    }
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
  const { session, ui, core, tool, parse, viewer } =
    partitionViewerStoreTestState(patch);

  // Spell every residual property as a literal setState key. Besides preserving one publication,
  // this lets the shared ownership oracle prove that a computed/misrouted parse key cannot escape
  // through this otherwise-generic test helper.
  const residualViewerPatch = {
    ...("allTrades" in viewer ? { allTrades: viewer.allTrades } : {}),
    ...("setAllTrades" in viewer ? { setAllTrades: viewer.setAllTrades } : {}),
    ...("allCsiCodes" in viewer ? { allCsiCodes: viewer.allCsiCodes } : {}),
    ...("setAllCsiCodes" in viewer
      ? { setAllCsiCodes: viewer.setAllCsiCodes }
      : {}),
    ...("resetViewerState" in viewer
      ? { resetViewerState: viewer.resetViewerState }
      : {}),
  } satisfies RemainingViewerStoreTestPatch;

  // Identity/policy must be visible before presentation, geometry, tool, parse, and residual state.
  // Empty partitions are skipped so a one-owner setup remains exactly one publication.
  if (Object.keys(session).length > 0) useSessionStore.setState(session);
  if (Object.keys(ui).length > 0) useUiStore.setState(ui);
  if (Object.keys(core).length > 0) useViewerCoreStore.setState(core);
  if (Object.keys(tool).length > 0) useToolStore.setState(tool);
  if (Object.keys(parse).length > 0) useParseFlowStore.setState(parse);
  if (Object.keys(residualViewerPatch).length > 0) {
    useViewerStore.setState(residualViewerPatch);
  }
}
