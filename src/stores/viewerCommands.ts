// [refactor jul11 P2.3] Temporary cross-store project reset coordinator.
//
// Leaf stores must not import one another. Keeping the old reset as a viewerStore action would make
// the UI/tool store own session lifetime; duplicating it in loaders/tests would reopen reset drift.
// P2.3 therefore preserves today's reset output behind this neutral command. P2.5 replaces it with
// the generation/AbortController-aware openProject orchestrator and an explicit survival policy.

import {
  invalidateParseOperationKinds,
  type ParseKind,
  type ParseOperationRegistry,
  type ParseOperationToken,
} from "@/lib/parse-operation-state";
import { useSessionStore } from "@/stores/sessionStore";
import { useParseFlowStore } from "@/stores/parseFlowStore";
import { useToolStore } from "@/stores/toolStore";
import { useUiStore } from "@/stores/uiStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { useViewerStore } from "@/stores/viewerStore";

export function resetProjectData(): void {
  // Session first: every Query observer immediately re-keys away from the old project before the
  // remaining UI/core/tool/viewer reset publishes. All writes are synchronous; there is no
  // await/paint gap.
  useSessionStore.getState().resetSession();
  useUiStore.getState().resetProjectUiState();
  useViewerCoreStore.getState().resetViewerCoreState();
  useToolStore.getState().resetProjectToolState();
  useParseFlowStore.getState().resetProjectParseState();
  useViewerStore.getState().resetViewerState();
}

type TableParseStep = "idle" | "select-region" | "define-column" | "define-row" | "review";
type KeynoteParseStep = TableParseStep;
type ParseRegion = [number, number, number, number];
type NotesParseStep = TableParseStep;
type SpecParseStep = "idle" | "select-region" | "define-sections" | "review";

const PARSE_ENTRY_TOOL_DESTINATION = {
  mode: "move",
  bucketFillActive: false,
  bucketFillPreview: null,
  bucketFillLoading: false,
  bucketFillBarrierMode: false,
  splitAreaActive: false,
  symbolSearchActive: false,
} as const;

/**
 * A parse entry used to be one viewerStore publication. The flat carve necessarily splits that
 * write, so competing tools publish their exact raw destination first and the parse step follows
 * synchronously. Tool-first prevents raw subscribers from seeing active parse + an active tool.
 */
function prepareParseEntry(currentStep: string, nextStep: string): void {
  if (currentStep === "idle" && nextStep !== "idle") {
    useToolStore.setState(PARSE_ENTRY_TOOL_DESTINATION);
  }
}

/**
 * User entry and cancel are ownership boundaries. Active-to-active transitions stay in the same
 * flow; A2b gives async-owned idle-to-review completion a separate token-authorized command so it
 * cannot invalidate itself through this generic user boundary.
 */
function crossesParseOperationBoundary(currentStep: string, nextStep: string): boolean {
  return (currentStep === "idle") !== (nextStep === "idle");
}

function operationBoundaryPatch(
  parseOperations: ParseOperationRegistry,
  kind: ParseKind,
  currentStep: string,
  nextStep: string,
): { parseOperations?: ParseOperationRegistry } {
  if (!crossesParseOperationBoundary(currentStep, nextStep)) return {};
  return {
    parseOperations: invalidateParseOperationKinds(parseOperations, [kind]),
  };
}

/**
 * Revoke the Table/Keynote/Notes owners that share the guided-grid workspace in one publication.
 * `except` keeps a newly admitted root current while it hands the shared workspace away from peers.
 * Direct grid edits omit it because the edit itself is a new user-owned workspace generation.
 */
export function invalidateGuidedParseOperations(
  except?: "table" | "keynote" | "notes",
): void {
  const sharedKinds = ["table", "keynote", "notes"] as const;
  const kinds = sharedKinds.filter((kind) => kind !== except);
  useParseFlowStore.setState((state) => ({
    parseOperations: invalidateParseOperationKinds(state.parseOperations, kinds),
  }));
}

/** Revoke a retained-Keynote -> Table-review handoff atomically before its first shared seed. */
export function invalidateKeynoteTableOperations(): void {
  useParseFlowStore.setState((state) => ({
    parseOperations: invalidateParseOperationKinds(
      state.parseOperations,
      ["keynote", "table"],
    ),
  }));
}

/**
 * Clear Keynote and its shared Guided workspace in one parse publication. This is the user reset
 * boundary; splitting invalidation from cleanup would let a synchronous subscriber start B in the
 * gap and then have B's workspace erased by A's remaining reset calls.
 */
export function resetKeynoteGuidedParse(): void {
  useParseFlowStore.setState((state) => ({
    keynoteParseStep: "idle",
    keynoteParseRegion: null,
    keynoteColumnBBs: [],
    keynoteRowBBs: [],
    keynoteYoloClass: null,
    guidedParseActive: false,
    guidedParseRegion: null,
    guidedParseRows: [],
    guidedParseCols: [],
    parseOperations: invalidateParseOperationKinds(
      state.parseOperations,
      ["table", "keynote", "notes"],
    ),
  }));
}

export function setTableParseStep(tableParseStep: TableParseStep): void {
  const currentStep = useParseFlowStore.getState().tableParseStep;
  prepareParseEntry(currentStep, tableParseStep);
  useParseFlowStore.setState((state) => ({
    tableParseStep,
    ...operationBoundaryPatch(
      state.parseOperations,
      "table",
      state.tableParseStep,
      tableParseStep,
    ),
  }));
}

/**
 * Advance a Table wizard only for the async operation that still owns the Table lane.
 *
 * Generic `setTableParseStep` treats idle -> active as a user-created flow and therefore revokes
 * the old operation. Auto/Guided/Manual completions instead need to enter review *inside* their
 * existing flow. This command keeps the historic tool-first entry publication, retains the exact
 * operation registry, and denies stale completions without publishing either store.
 */
export function setTableParseStepForOperation(
  token: ParseOperationToken<"table">,
  tableParseStep: TableParseStep,
): boolean {
  // Keep the runtime boundary fail-closed as well as the ordinary TypeScript call site. Casts and
  // untyped/event payloads must not authorize Table through a same-revision token from another lane.
  if (token.kind !== "table") return false;
  const before = useParseFlowStore.getState();
  const current = before.parseOperations.table;
  if (!current.busy || current.revision !== token.revision) return false;

  prepareParseEntry(before.tableParseStep, tableParseStep);

  // Re-check in the functional write. Tool subscribers are synchronous; if one revokes the
  // operation during the tool-first publication, the stale parse step still cannot land.
  let committed = false;
  useParseFlowStore.setState((state) => {
    const live = state.parseOperations.table;
    if (token.kind !== "table" || !live.busy || live.revision !== token.revision) return state;
    committed = true;
    return { tableParseStep };
  });
  return committed;
}

export function setKeynoteParseStep(keynoteParseStep: KeynoteParseStep): void {
  const currentStep = useParseFlowStore.getState().keynoteParseStep;
  prepareParseEntry(currentStep, keynoteParseStep);
  useParseFlowStore.setState((state) => ({
    keynoteParseStep,
    ...operationBoundaryPatch(
      state.parseOperations,
      "keynote",
      state.keynoteParseStep,
      keynoteParseStep,
    ),
  }));
}

/**
 * Accept one canvas-drawn Keynote region as a single user boundary. Region, idle destination, and
 * owner revocation must publish atomically: a subscriber cannot start B between separate writes.
 */
export function acceptKeynoteParseRegion(keynoteParseRegion: ParseRegion): void {
  useParseFlowStore.setState((state) => ({
    keynoteParseRegion,
    keynoteParseStep: "idle",
    parseOperations: invalidateParseOperationKinds(state.parseOperations, ["keynote"]),
  }));
}

/**
 * Finish a current Keynote wizard without letting a synchronous subscriber start B between A's
 * reset and A's final tool write. Tool/shared cleanup happens first with a currentness recheck after
 * every publication; the Keynote reset is last and performs the terminal revision invalidation.
 */
export function completeKeynoteParseOperation(
  token: ParseOperationToken<"keynote">,
  options?: { resetGuided?: boolean },
): boolean {
  if (token.kind !== "keynote" || !useParseFlowStore.getState().isParseOperationCurrent(token)) {
    return false;
  }

  useToolStore.getState().setMode("move");
  if (!useParseFlowStore.getState().isParseOperationCurrent(token)) return false;

  if (options?.resetGuided) {
    useParseFlowStore.getState().resetGuidedParse();
    if (!useParseFlowStore.getState().isParseOperationCurrent(token)) return false;
  }

  // This reset invalidates the token and is deliberately the final publication owned by A.
  useParseFlowStore.getState().resetKeynoteParse();
  return true;
}

export function setNotesParseStep(notesParseStep: NotesParseStep): void {
  const currentStep = useParseFlowStore.getState().notesParseStep;
  prepareParseEntry(currentStep, notesParseStep);
  useParseFlowStore.setState((state) => ({
    notesParseStep,
    ...operationBoundaryPatch(
      state.parseOperations,
      "notes",
      state.notesParseStep,
      notesParseStep,
    ),
  }));
}

export function setSpecParseStep(specParseStep: SpecParseStep): void {
  const currentStep = useParseFlowStore.getState().specParseStep;
  prepareParseEntry(currentStep, specParseStep);
  useParseFlowStore.setState((state) => ({
    specParseStep,
    ...operationBoundaryPatch(
      state.parseOperations,
      "spec",
      state.specParseStep,
      specParseStep,
    ),
  }));
}

/** Seven-publication universal tool/parse teardown preserved across the S2 ownership split. */
export function resetAllTools(): void {
  // Capture live action references at execution time. Detection/parse closes invoke this from a
  // microtask, matching the legacy get().resetAllTools() timing rather than the close-call time.
  const tool = useToolStore.getState();
  const parse = useParseFlowStore.getState();
  tool.setMode("move");
  parse.resetTableParse();
  parse.resetKeynoteParse();
  parse.resetNotesParse();
  parse.resetSpecParse();
  parse.resetGuidedParse();
  tool.clearSymbolSearch();
}

/**
 * Cross-store panel commands preserve the legacy destination and publication timing while keeping
 * uiStore dependency-free. These are product commands, not leaf-store toggles: each one may
 * coordinate presentation with toolStore or the dedicated parseFlowStore.
 */
export function toggleTakeoffPanel(): void {
  const ui = useUiStore.getState();

  if (ui.showTakeoffPanel) {
    // This is deliberately a raw write. setActiveTakeoffItemId also clears undo/redo history,
    // whereas the legacy panel close retained both stacks.
    useToolStore.setState({ activeTakeoffItemId: null });
    useUiStore.getState().setPanelVisibility({ showTakeoffPanel: false });
    return;
  }

  useUiStore.getState().setPanelVisibility({
    showTakeoffPanel: true,
    ...(ui.showChatPanel ? { showChatPanel: false } : {}),
  });
}

export function toggleDetectionPanel(): void {
  const ui = useUiStore.getState();
  const closing = ui.showDetectionPanel;
  const peerWasClosed = !ui.showParsePanel;

  useUiStore.getState().setPanelVisibility({ showDetectionPanel: !closing });
  if (closing && peerWasClosed) {
    queueMicrotask(() => resetAllTools());
  }
}

export function toggleParsePanel(): void {
  const ui = useUiStore.getState();
  const closing = ui.showParsePanel;
  const peerWasClosed = !ui.showDetectionPanel;

  useUiStore.getState().setPanelVisibility({ showParsePanel: !closing });
  if (closing && peerWasClosed) {
    queueMicrotask(() => resetAllTools());
  }
}

export function toggleTableParsePanel(): void {
  const closing = useUiStore.getState().showTableParsePanel;

  if (closing) {
    // Preserve the old raw mode transition. Calling setMode would clear additional live tools.
    useParseFlowStore.setState((state) => ({
      tableParseStep: "idle",
      tableParseRegion: null,
      tableParsedGrid: null,
      tableParseMeta: null,
      tableParseColumnBBs: [],
      tableParseColumnNames: [],
      tableParseRowBBs: [],
      tableParseTab: "all",
      guidedParseActive: false,
      guidedParseRegion: null,
      guidedParseRows: [],
      guidedParseCols: [],
      // Closing erases the Table/Keynote/Notes shared Guided workspace, so all three owners are
      // revoked in this same raw publication. Spec remains independent.
      parseOperations: invalidateParseOperationKinds(
        state.parseOperations,
        ["table", "keynote", "notes"],
      ),
    }));
    // Preserve the legacy raw mode assignment: setMode would clear unrelated active tools.
    useToolStore.setState({ mode: "move" });
  }
  useUiStore.getState().setPanelVisibility({ showTableParsePanel: !closing });
}

export function toggleKeynoteParsePanel(): void {
  const closing = useUiStore.getState().showKeynoteParsePanel;

  if (closing) {
    useParseFlowStore.setState((state) => ({
      keynoteParseStep: "idle",
      keynoteParseRegion: null,
      keynoteColumnBBs: [],
      keynoteRowBBs: [],
      keynoteYoloClass: null,
      keynoteParseTab: "all",
      guidedParseActive: false,
      guidedParseRegion: null,
      guidedParseRows: [],
      guidedParseCols: [],
      // Closing erases the Table/Keynote/Notes shared Guided workspace, so all three owners are
      // revoked in this same raw publication. Spec remains independent.
      parseOperations: invalidateParseOperationKinds(
        state.parseOperations,
        ["table", "keynote", "notes"],
      ),
    }));
    useToolStore.setState({ mode: "move" });
  }
  useUiStore.getState().setPanelVisibility({ showKeynoteParsePanel: !closing });
}
