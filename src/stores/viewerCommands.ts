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
import {
  useParseFlowStore,
  type GuidedParseOwner,
  type ParseFlowState,
  type PendingParagraph,
} from "@/stores/parseFlowStore";
import { useToolStore } from "@/stores/toolStore";
import { useUiStore, type SpecsNotesTab } from "@/stores/uiStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { useViewerStore } from "@/stores/viewerStore";
import type { ParsedRegion } from "@/types";

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
type NotesParserMode = "auto" | "guided" | "paragraph" | "fast-manual" | "manual";
type SpecParserMode = "auto" | "paragraph" | "manual";
type ActiveGuidedParseOwner = Exclude<GuidedParseOwner, null>;

function isParseKind(value: unknown): value is ParseKind {
  return value === "table" || value === "keynote" || value === "notes" || value === "spec";
}

function isActiveGuidedParseOwner(value: unknown): value is ActiveGuidedParseOwner {
  return isParseKind(value) && value !== "spec";
}

/**
 * Snapshot created by the same atomic publication that begins a shared-workspace gesture or
 * transition. Later publications must match the relevant lane revisions exactly; `busy:false`
 * alone cannot distinguish the originating gesture from a newer operation that already settled.
 */
export type ParseWorkspaceLease = Readonly<{
  tableRevision: number;
  keynoteRevision: number;
  notesRevision: number;
  specRevision: number;
  guidedOwner: GuidedParseOwner;
}>;

function workspaceLease(
  parseOperations: ParseOperationRegistry,
  guidedOwner: GuidedParseOwner,
): ParseWorkspaceLease {
  return {
    tableRevision: parseOperations.table.revision,
    keynoteRevision: parseOperations.keynote.revision,
    notesRevision: parseOperations.notes.revision,
    specRevision: parseOperations.spec.revision,
    guidedOwner,
  };
}

/**
 * Preserve the legacy canvas page-exit behavior before core page observers run: only active Table
 * and Keynote drawing state resets. Notes, Spec, shared workspaces, settings, and retained history
 * are not generic-navigation data. The post-page authority publication below revokes every async
 * owner after synchronous core subscribers have finished.
 */
function legacyParsePageExitPatch(state: ParseFlowState): Partial<ParseFlowState> | null {
  const clearsTable = state.tableParseStep !== "idle";
  const clearsKeynote = state.keynoteParseStep !== "idle";
  if (!clearsTable && !clearsKeynote) return null;
  const kinds: ParseKind[] = [];
  if (clearsTable) kinds.push("table");
  if (clearsKeynote) kinds.push("keynote");
  return {
    ...(clearsTable
      ? {
          tableParseStep: "idle" as const,
          tableParseRegion: null,
          tableParsedGrid: null,
          tableParseMeta: null,
          tableCellStructure: null,
          tableParseColumnBBs: [],
          tableParseColumnNames: [],
          tableParseRowBBs: [],
        }
      : {}),
    ...(clearsKeynote
      ? {
          keynoteParseStep: "idle" as const,
          keynoteParseRegion: null,
          keynoteColumnBBs: [],
          keynoteRowBBs: [],
          keynoteYoloClass: null,
        }
      : {}),
    parseOperations: invalidateParseOperationKinds(state.parseOperations, kinds),
  };
}

function prepareLegacyParsePageExit(prepareTool = true): boolean {
  const before = useParseFlowStore.getState();
  if (before.tableParseStep === "idle" && before.keynoteParseStep === "idle") return false;
  // Tool first: the subsequent Parse publication may synchronously admit B, which must own every
  // later tool write. This has the same final legacy destination as AnnotationOverlay's old effect.
  if (prepareTool) useToolStore.getState().setMode("move");
  useParseFlowStore.setState((state) => legacyParsePageExitPatch(state) ?? state);
  return true;
}

/** Revoke old-page A and any synchronous core-page subscriber B after the new page is installed. */
function publishPageOperationBoundary(): void {
  useParseFlowStore.setState((state) => ({
    parseOperations: invalidateParseOperationKinds(
      state.parseOperations,
      ["table", "keynote", "notes", "spec"],
    ),
  }));
}

/**
 * Global page navigation boundary. Legacy Table/Keynote canvas cleanup stays conditional; after
 * core page subscribers return, one authority-only publication invalidates every old/new-page
 * operation. A subscriber admitted by that terminal publication necessarily captures the new page.
 */
export function navigateViewerPage(pageNumber: number): void {
  const core = useViewerCoreStore.getState();
  const targetPage = Math.max(1, Math.min(pageNumber, core.numPages || 1));
  if (targetPage === core.pageNumber) return;
  prepareLegacyParsePageExit();
  useViewerCoreStore.getState().setPage(targetPage);
  publishPageOperationBoundary();
}

/**
 * Legacy YOLO-instance navigation accepts its stored page number verbatim instead of clamping it.
 * Keep that destination contract while still applying the same pre-core Parse authority boundary.
 */
export function navigateViewerPageUnclamped(pageNumber: number): void {
  if (pageNumber === useViewerCoreStore.getState().pageNumber) return;
  prepareLegacyParsePageExit();
  useViewerCoreStore.setState({ pageNumber });
  publishPageOperationBoundary();
}

function matchesParagraphLease(
  parseOperations: ParseOperationRegistry,
  lease: ParseWorkspaceLease,
): boolean {
  return parseOperations.notes.revision === lease.notesRevision &&
    parseOperations.spec.revision === lease.specRevision &&
    !parseOperations.notes.busy && !parseOperations.spec.busy;
}

function matchesParagraphLeaseRevisions(
  parseOperations: ParseOperationRegistry,
  lease: ParseWorkspaceLease,
): boolean {
  return parseOperations.notes.revision === lease.notesRevision &&
    parseOperations.spec.revision === lease.specRevision;
}

function matchesGuidedLeaseRevisions(
  parseOperations: ParseOperationRegistry,
  lease: ParseWorkspaceLease,
  guidedOwner: GuidedParseOwner,
): boolean {
  return parseOperations.table.revision === lease.tableRevision &&
    parseOperations.keynote.revision === lease.keynoteRevision &&
    parseOperations.notes.revision === lease.notesRevision &&
    guidedOwner === lease.guidedOwner;
}

function matchesGuidedLease(
  parseOperations: ParseOperationRegistry,
  lease: ParseWorkspaceLease,
  guidedOwner: GuidedParseOwner,
): boolean {
  return parseOperations.table.revision === lease.tableRevision &&
    parseOperations.keynote.revision === lease.keynoteRevision &&
    parseOperations.notes.revision === lease.notesRevision &&
    lease.guidedOwner !== null && guidedOwner === lease.guidedOwner &&
    !parseOperations.table.busy && !parseOperations.keynote.busy &&
    !parseOperations.notes.busy;
}

function notesDraftForGrid(
  grid: NonNullable<ParseFlowState["notesFastManualGrid"]>,
  region: ParseRegion,
): ParsedRegion {
  return {
    id: "draft-notes",
    type: "notes",
    category: "notes-preview",
    bbox: [...region],
    confidence: 0.85,
    source: "user",
    data: {
      headers: grid.headers,
      rows: grid.rows,
      tagColumn: grid.headers[0],
      tableName: "(preview)",
      rowCount: grid.rows.length,
      columnCount: grid.headers.length,
      rowBoundaries: grid.rowBoundaries,
      colBoundaries: grid.colBoundaries,
    },
  };
}

function specDraftForParagraphBatch(
  paragraphBatch: PendingParagraph[],
): ParsedRegion | null {
  if (paragraphBatch.length === 0) return null;
  const xs = paragraphBatch.flatMap((paragraph) => [paragraph.bbox[0], paragraph.bbox[2]]);
  const ys = paragraphBatch.flatMap((paragraph) => [paragraph.bbox[1], paragraph.bbox[3]]);
  return {
    id: "draft-spec",
    type: "spec",
    category: "spec-preview",
    bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
    confidence: 0.85,
    source: "user",
    data: {
      sections: paragraphBatch.map((paragraph) => ({
        sectionHeader: paragraph.rowText.sectionHeader ?? "",
        body: paragraph.rowText.body ?? "",
      })),
      tableName: `(draft — ${paragraphBatch.length} paragraph${paragraphBatch.length === 1 ? "" : "s"})`,
    },
  };
}

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
): ParseWorkspaceLease {
  const sharedKinds = ["table", "keynote", "notes"] as const;
  let lease!: ParseWorkspaceLease;
  useParseFlowStore.setState((state) => {
    // Proposal roots claim through claimGuidedParseWorkspaceForOperation. This retained-grid seam
    // may only keep an already matching owner; a queued/stale handler cannot relabel peer B bytes.
    const ownsWorkspace = except === undefined || state.guidedParseOwner === except;
    const kinds = except === undefined
      ? [...sharedKinds]
      : ownsWorkspace
        ? sharedKinds.filter((kind) => kind !== except)
        : [except];
    const parseOperations = invalidateParseOperationKinds(state.parseOperations, kinds);
    lease = workspaceLease(parseOperations, state.guidedParseOwner);
    return { parseOperations };
  });
  return lease;
}

/**
 * Claim a fresh Guided generation for one admitted parser root. Ownership, empty bytes, region,
 * and peer revocation are one publication; equal bounding boxes never imply equal ownership.
 */
export function claimGuidedParseWorkspaceForOperation(
  token: ParseOperationToken<"table" | "keynote" | "notes">,
  guidedParseRegion: ParseRegion,
): ParseWorkspaceLease | null {
  // TypeScript prevents this for in-repo callers; the runtime gate keeps JS/forged tokens from
  // indexing another operation lane and installing an impossible Guided owner.
  if (!isActiveGuidedParseOwner(token.kind)) return null;
  let lease: ParseWorkspaceLease | null = null;
  useParseFlowStore.setState((state) => {
    const live = state.parseOperations[token.kind];
    if (!live.busy || live.revision !== token.revision) return state;
    const retainsGrid = state.guidedParseOwner === token.kind &&
      state.guidedParseRegion !== null &&
      state.guidedParseRegion.every((value, index) => value === guidedParseRegion[index]);
    const parseOperations = invalidateParseOperationKinds(
      state.parseOperations,
      (["table", "keynote", "notes"] as const).filter((kind) => kind !== token.kind),
    );
    lease = workspaceLease(parseOperations, token.kind);
    return {
      guidedParseOwner: token.kind,
      guidedParseRegion,
      ...(retainsGrid
        ? {}
        : {
            guidedParseActive: false,
            guidedParseRows: [],
            guidedParseCols: [],
          }),
      parseOperations,
    };
  });
  return lease;
}

/** Publish a proposal only into the exact owner/token generation that requested it. */
export function publishGuidedProposalForOperation(
  token: ParseOperationToken<"table" | "keynote" | "notes">,
  guidedParseRows: number[],
  guidedParseCols: number[],
): boolean {
  if (!isActiveGuidedParseOwner(token.kind)) return false;
  let committed = false;
  useParseFlowStore.setState((state) => {
    const live = state.parseOperations[token.kind];
    if (
      !live.busy || live.revision !== token.revision ||
      state.guidedParseOwner !== token.kind
    ) return state;
    committed = true;
    return {
      guidedParseRows,
      guidedParseCols,
      guidedParseActive: true,
    };
  });
  return committed;
}

/**
 * Clear only the departing family's Guided generation. A co-mounted peer's bytes and operation
 * identities survive exactly, even when its region happens to be byte-equal.
 */
export function resetGuidedParseWorkspace(owner: "table" | "keynote" | "notes"): boolean {
  if (!isActiveGuidedParseOwner(owner)) return false;
  const before = useParseFlowStore.getState();
  if (before.guidedParseOwner === null || before.guidedParseOwner === owner) {
    useToolStore.setState({ mode: "move" });
  }
  let cleared = false;
  useParseFlowStore.setState((state) => {
    const ownsGuided = state.guidedParseOwner === owner;
    const ownerPatch = owner === "table"
      ? { tableParseStep: "idle" as const, tableParseRegion: null }
      : owner === "keynote"
        ? { keynoteParseStep: "idle" as const, keynoteParseRegion: null }
        : { notesParseStep: "idle" as const, notesParseRegion: null };
    cleared = ownsGuided;
    return {
      ...ownerPatch,
      ...(ownsGuided
        ? {
            guidedParseOwner: null,
            guidedParseActive: false,
            guidedParseRegion: null,
            guidedParseRows: [],
            guidedParseCols: [],
          }
        : {}),
      parseOperations: invalidateParseOperationKinds(
        state.parseOperations,
        ownsGuided ? ["table", "keynote", "notes"] : [owner],
      ),
    };
  });
  return cleared;
}

/** Full Table user reset with tool-first ordering and owner-aware shared cleanup. */
export function resetTableParseWorkspace(): void {
  const before = useParseFlowStore.getState();
  const preservesPeerGuided = before.guidedParseOwner !== null &&
    before.guidedParseOwner !== "table";
  if (!preservesPeerGuided) useToolStore.getState().setMode("move");
  useParseFlowStore.setState((state) => {
    const clearsGuided = state.guidedParseOwner === "table";
    return {
      tableParseStep: "idle",
      tableParseRegion: null,
      tableParsedGrid: null,
      tableParseMeta: null,
      tableCellStructure: null,
      tableParseColumnBBs: [],
      tableParseColumnNames: [],
      tableParseRowBBs: [],
      ...(clearsGuided
        ? {
            guidedParseOwner: null,
            guidedParseActive: false,
            guidedParseRegion: null,
            guidedParseRows: [],
            guidedParseCols: [],
          }
        : {}),
      parseOperations: invalidateParseOperationKinds(
        state.parseOperations,
        clearsGuided ? ["table", "keynote", "notes"] : ["table"],
      ),
    };
  });
}

/** Return Auto review to its retained region in one user-owned terminal Parse publication. */
export function restartTableParseFromCurrentRegion(): void {
  useToolStore.getState().setMode("move");
  useParseFlowStore.setState((state) => ({
    tableParseStep: "idle",
    tableParsedGrid: null,
    parseOperations: invalidateParseOperationKinds(state.parseOperations, ["table"]),
  }));
}

/** Clear page-relative cell structure and revoke the Table owner in the same user publication. */
export function clearTableCellStructureForUser(): void {
  useParseFlowStore.setState((state) => ({
    tableCellStructure: null,
    showTableCellStructure: false,
    parseOperations: invalidateParseOperationKinds(state.parseOperations, ["table"]),
  }));
}

/** Table review/input edits replace their bytes and revoke the old owner in one publication. */
export function setTableParsedGridForUser(
  tableParsedGrid: ParseFlowState["tableParsedGrid"],
): void {
  useParseFlowStore.setState((state) => ({
    tableParsedGrid,
    parseOperations: invalidateParseOperationKinds(state.parseOperations, ["table"]),
  }));
}

type TableManualGeometryPatch = Partial<Pick<
  ParseFlowState,
  "tableParseColumnBBs" | "tableParseColumnNames" | "tableParseRowBBs"
>>;

export function setTableManualGeometryForUser(patch: TableManualGeometryPatch): void {
  useParseFlowStore.setState((state) => ({
    ...patch,
    parseOperations: invalidateParseOperationKinds(state.parseOperations, ["table"]),
  }));
}

export function addTableParseColumnForUser(bbox: ParseRegion): void {
  useParseFlowStore.setState((state) => ({
    tableParseColumnBBs: [...state.tableParseColumnBBs, bbox],
    parseOperations: invalidateParseOperationKinds(state.parseOperations, ["table"]),
  }));
}

export function addTableParseRowForUser(bbox: ParseRegion): void {
  useParseFlowStore.setState((state) => ({
    tableParseRowBBs: [...state.tableParseRowBBs, bbox],
    parseOperations: invalidateParseOperationKinds(state.parseOperations, ["table"]),
  }));
}

type KeynoteManualInputPatch = Partial<Pick<
  ParseFlowState,
  "keynoteColumnBBs" | "keynoteRowBBs" | "keynoteYoloClass"
>>;

export function setKeynoteManualInputsForUser(patch: KeynoteManualInputPatch): void {
  useParseFlowStore.setState((state) => ({
    ...patch,
    parseOperations: invalidateParseOperationKinds(state.parseOperations, ["keynote"]),
  }));
}

export function addKeynoteColumnForUser(bbox: ParseRegion): void {
  useParseFlowStore.setState((state) => ({
    keynoteColumnBBs: [...state.keynoteColumnBBs, bbox],
    parseOperations: invalidateParseOperationKinds(state.parseOperations, ["keynote"]),
  }));
}

export function addKeynoteRowForUser(bbox: ParseRegion): void {
  useParseFlowStore.setState((state) => ({
    keynoteRowBBs: [...state.keynoteRowBBs, bbox],
    parseOperations: invalidateParseOperationKinds(state.parseOperations, ["keynote"]),
  }));
}

/** Consume Shape's accepted Table region only if the exact rendered generation still owns it. */
export function consumeTableParseRegionForShape(
  expectedRegion: ParseRegion,
  expectedRevision: number,
): boolean {
  let consumed = false;
  useParseFlowStore.setState((state) => {
    if (
      state.tableParseRegion !== expectedRegion ||
      state.parseOperations.table.revision !== expectedRevision
    ) return state;
    consumed = true;
    return {
      tableParseRegion: null,
      parseOperations: invalidateParseOperationKinds(state.parseOperations, ["table"]),
    };
  });
  return consumed;
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
  const before = useParseFlowStore.getState();
  if (before.guidedParseOwner === null || before.guidedParseOwner === "keynote") {
    useToolStore.setState({ mode: "move" });
  }
  useParseFlowStore.setState((state) => {
    const ownsGuided = state.guidedParseOwner === "keynote";
    return {
      keynoteParseStep: "idle",
      keynoteParseRegion: null,
      keynoteColumnBBs: [],
      keynoteRowBBs: [],
      keynoteYoloClass: null,
      ...(ownsGuided
        ? {
            guidedParseOwner: null,
            guidedParseActive: false,
            guidedParseRegion: null,
            guidedParseRows: [],
            guidedParseCols: [],
          }
        : {}),
      parseOperations: invalidateParseOperationKinds(
        state.parseOperations,
        ownsGuided ? ["table", "keynote", "notes"] : ["keynote"],
      ),
    };
  });
}

/** Stored Table submode handoff with owner-aware Guided teardown in one parse publication. */
export function transitionTableParseTab(
  tableParseTab: ParseFlowState["tableParseTab"],
): void {
  const before = useParseFlowStore.getState();
  if (before.tableParseTab === tableParseTab) return;
  const preservesPeerGuided = before.guidedParseOwner !== null &&
    before.guidedParseOwner !== "table";
  if (!preservesPeerGuided) useToolStore.setState({ mode: "move" });
  useParseFlowStore.setState((state) => {
    const ownsGuided = state.guidedParseOwner === "table";
    return {
      tableParseTab,
      ...(ownsGuided
        ? {
            guidedParseOwner: null,
            guidedParseActive: false,
            guidedParseRegion: null,
            guidedParseRows: [],
            guidedParseCols: [],
          }
        : {}),
      parseOperations: invalidateParseOperationKinds(
        state.parseOperations,
        ownsGuided ? ["table", "keynote", "notes"] : ["table"],
      ),
    };
  });
}

/** Canvas double-click handoff: presentation first, then one terminal Table catalog publication. */
export function focusParsedTableRegionInCatalog(regionId: string): void {
  useUiStore.setState({
    showTableParsePanel: true,
    focusedParsedRegionId: regionId,
  });
  useParseFlowStore.setState((state) => ({
    tableParseTab: "all",
    parseOperations: invalidateParseOperationKinds(state.parseOperations, ["table"]),
  }));
}

/** Stored Keynote submode handoff; reset and destination cannot straddle a peer B publication. */
export function transitionKeynoteParseTab(
  keynoteParseTab: ParseFlowState["keynoteParseTab"],
): void {
  const before = useParseFlowStore.getState();
  if (before.keynoteParseTab === keynoteParseTab) return;
  const preservesPeerGuided = before.guidedParseOwner !== null &&
    before.guidedParseOwner !== "keynote";
  if (!preservesPeerGuided) useToolStore.setState({ mode: "move" });
  useParseFlowStore.setState((state) => {
    const ownsGuided = state.guidedParseOwner === "keynote";
    return {
      keynoteParseTab,
      keynoteParseStep: "idle",
      keynoteParseRegion: null,
      keynoteColumnBBs: [],
      keynoteRowBBs: [],
      keynoteYoloClass: null,
      ...(ownsGuided
        ? {
            guidedParseOwner: null,
            guidedParseActive: false,
            guidedParseRegion: null,
            guidedParseRows: [],
            guidedParseCols: [],
          }
        : {}),
      parseOperations: invalidateParseOperationKinds(
        state.parseOperations,
        ownsGuided ? ["table", "keynote", "notes"] : ["keynote"],
      ),
    };
  });
}

/** Revoke the Notes/Spec owners of the shared draft + paragraph workspace in one publication. */
export function invalidateParagraphParseOperations(
  except?: "notes" | "spec",
): ParseWorkspaceLease {
  const sharedKinds = ["notes", "spec"] as const;
  const kinds = sharedKinds.filter((kind) => kind !== except);
  let lease!: ParseWorkspaceLease;
  useParseFlowStore.setState((state) => {
    const parseOperations = invalidateParseOperationKinds(state.parseOperations, kinds);
    lease = workspaceLease(parseOperations, state.guidedParseOwner);
    return { parseOperations };
  });
  return lease;
}

/**
 * Notes spans both shared parse workspaces: Guided borrows Table/Keynote state while draft and
 * paragraph editing borrow Spec state. A Notes mode/region mutation therefore needs one union
 * publication, rather than two invalidations with a re-entrant gap between them.
 */
export function invalidateNotesWorkspaceOperations(except?: ParseKind): ParseWorkspaceLease {
  let lease!: ParseWorkspaceLease;
  useParseFlowStore.setState((state) => {
    const mayRetainGuided = except !== "notes" || state.guidedParseOwner === "notes";
    const kinds = except === "notes" && !mayRetainGuided
      ? (["notes", "spec"] as const)
      : (["table", "keynote", "notes", "spec"] as const)
        .filter((kind) => kind !== except);
    const parseOperations = invalidateParseOperationKinds(state.parseOperations, kinds);
    lease = workspaceLease(parseOperations, state.guidedParseOwner);
    return { parseOperations };
  });
  return lease;
}

/**
 * Async-root variant of the paragraph boundary. A begin subscriber may replace A synchronously;
 * only the exact still-current Notes/Spec token is allowed to invalidate its peer workspace.
 */
export function invalidateParagraphParseOperationsForOperation(
  token: ParseOperationToken<"notes" | "spec">,
): ParseWorkspaceLease | null {
  let lease: ParseWorkspaceLease | null = null;
  useParseFlowStore.setState((state) => {
    const live = state.parseOperations[token.kind];
    if (!live.busy || live.revision !== token.revision) return state;
    const kinds = (["notes", "spec"] as const).filter((kind) => kind !== token.kind);
    const parseOperations = invalidateParseOperationKinds(state.parseOperations, kinds);
    lease = workspaceLease(parseOperations, state.guidedParseOwner);
    return { parseOperations };
  });
  return lease;
}

/** Token-authorized union boundary for a Notes root entering the Guided or paragraph workspace. */
export function invalidateNotesWorkspaceOperationsForOperation(
  token: ParseOperationToken<"notes">,
): ParseWorkspaceLease | null {
  let lease: ParseWorkspaceLease | null = null;
  useParseFlowStore.setState((state) => {
    const live = state.parseOperations.notes;
    if (!live.busy || live.revision !== token.revision) return state;
    const mayRetainGuided = state.guidedParseOwner === "notes";
    const kinds = mayRetainGuided
      ? (["table", "keynote", "spec"] as const)
      : (["notes", "spec"] as const);
    const parseOperations = invalidateParseOperationKinds(state.parseOperations, kinds);
    lease = workspaceLease(parseOperations, state.guidedParseOwner);
    return { parseOperations };
  });
  return lease;
}

/** Single-lane page/lifetime invalidation with a causally captured shared-workspace lease. */
export function invalidateParseOperationForWorkspace(kind: ParseKind): ParseWorkspaceLease {
  let lease!: ParseWorkspaceLease;
  useParseFlowStore.setState((state) => {
    const parseOperations = invalidateParseOperationKinds(state.parseOperations, [kind]);
    lease = workspaceLease(parseOperations, state.guidedParseOwner);
    return { parseOperations };
  });
  return lease;
}

/** Lifecycle CAS: an old render may revoke only the exact revision it observed. */
export function invalidateParseOperationAtRevision(
  kind: ParseKind,
  expectedRevision: number,
): boolean {
  if (!isParseKind(kind)) return false;
  let invalidated = false;
  useParseFlowStore.setState((state) => {
    if (state.parseOperations[kind].revision !== expectedRevision) return state;
    invalidated = true;
    return {
      parseOperations: invalidateParseOperationKinds(state.parseOperations, [kind]),
    };
  });
  return invalidated;
}

/** Begin one owner-bound Guided-grid gesture and return the exact generation it may mutate. */
export function beginGuidedGridEdit(
  owner: ActiveGuidedParseOwner,
  expectedRegion: ParseRegion | null,
): ParseWorkspaceLease | null {
  if (!isActiveGuidedParseOwner(owner) || expectedRegion === null) return null;
  let lease: ParseWorkspaceLease | null = null;
  useParseFlowStore.setState((state) => {
    // Region identity is the rendered shared-workspace generation. A same-family proposal claim
    // publishes a fresh captured region even when its coordinates are equal, so an old event
    // closure cannot edit B. This avoids subscribing the PDFPage hot slot to operation revisions.
    if (
      state.guidedParseOwner !== owner ||
      state.guidedParseRegion !== expectedRegion
    ) return state;
    const parseOperations = invalidateParseOperationKinds(
      state.parseOperations,
      ["table", "keynote", "notes"],
    );
    lease = workspaceLease(parseOperations, owner);
    return { parseOperations };
  });
  if (!lease) return null;
  const current = useParseFlowStore.getState();
  return matchesGuidedLease(current.parseOperations, lease, current.guidedParseOwner)
    ? lease
    : null;
}

export function setGuidedParseRowsForLease(
  guidedParseRows: number[],
  lease: ParseWorkspaceLease,
): boolean {
  let committed = false;
  useParseFlowStore.setState((state) => {
    if (!matchesGuidedLease(state.parseOperations, lease, state.guidedParseOwner)) return state;
    committed = true;
    return { guidedParseRows };
  });
  return committed;
}

export function setGuidedParseColsForLease(
  guidedParseCols: number[],
  lease: ParseWorkspaceLease,
): boolean {
  let committed = false;
  useParseFlowStore.setState((state) => {
    if (!matchesGuidedLease(state.parseOperations, lease, state.guidedParseOwner)) return state;
    committed = true;
    return { guidedParseCols };
  });
  return committed;
}

/** Begin one paragraph gesture; drag moves reuse this lease without repeated invalidation. */
export function beginParagraphWorkspaceEdit(): ParseWorkspaceLease {
  let lease!: ParseWorkspaceLease;
  useParseFlowStore.setState((state) => {
    const parseOperations = invalidateParseOperationKinds(
      state.parseOperations,
      ["notes", "spec"],
    );
    lease = workspaceLease(parseOperations, state.guidedParseOwner);
    return { parseOperations };
  });
  return lease;
}

export function upsertParagraphForLease(
  paragraph: PendingParagraph,
  lease: ParseWorkspaceLease,
): boolean {
  let committed = false;
  useParseFlowStore.setState((state) => {
    if (!matchesParagraphLease(state.parseOperations, lease)) return state;
    const index = state.paragraphBatch.findIndex((current) => current.id === paragraph.id);
    const paragraphBatch = index === -1
      ? [...state.paragraphBatch, paragraph]
      : state.paragraphBatch.map((current, currentIndex) =>
        currentIndex === index ? paragraph : current
      );
    committed = true;
    return {
      paragraphBatch,
      ...(state.specParseRegion
        ? { parseDraftRegion: specDraftForParagraphBatch(paragraphBatch) }
        : {}),
    };
  });
  return committed;
}

export function removeParagraphForLease(
  id: string,
  lease: ParseWorkspaceLease,
): boolean {
  let committed = false;
  useParseFlowStore.setState((state) => {
    if (!matchesParagraphLease(state.parseOperations, lease)) return state;
    const paragraphBatch = state.paragraphBatch.filter((paragraph) => paragraph.id !== id);
    committed = true;
    return {
      paragraphBatch,
      ...(state.specParseRegion
        ? { parseDraftRegion: specDraftForParagraphBatch(paragraphBatch) }
        : {}),
    };
  });
  return committed;
}

/** Fast Manual owns Notes data but feeds the Notes/Spec shared draft, so both lanes are leased. */
export function beginNotesFastManualEdit(): ParseWorkspaceLease {
  return beginParagraphWorkspaceEdit();
}

/**
 * Accept a canvas/index/classifier Notes region as one new workspace generation. Notes may drive
 * both shared overlays, so the region, incompatible Spec state, shared cleanup, and all affected
 * owner revocations land together. The intentionally shared paragraph clipboard survives.
 */
export function acceptNotesParseRegion(notesParseRegion: ParseRegion): void {
  useParseFlowStore.setState((state) => {
    const ownsGuided = state.guidedParseOwner === "notes";
    return {
      notesParseRegion,
      notesParseStep: "idle",
      specParseStep: "idle",
      specParseRegion: null,
      parseDraftRegion: null,
      paragraphOverlayActive: false,
      paragraphBatch: [],
      notesFastManualActive: false,
      notesFastManualGrid: null,
      ...(ownsGuided
        ? {
            guidedParseOwner: null,
            guidedParseActive: false,
            guidedParseRegion: null,
            guidedParseRows: [],
            guidedParseCols: [],
          }
        : {}),
      parseOperations: invalidateParseOperationKinds(
        state.parseOperations,
        ownsGuided ? ["table", "keynote", "notes", "spec"] : ["notes", "spec"],
      ),
    };
  });
}

/** Accept a Spec region and revoke both owners of its shared paragraph/draft workspace atomically. */
export function acceptSpecParseRegion(specParseRegion: ParseRegion): void {
  useParseFlowStore.setState((state) => ({
    specParseRegion,
    specParseStep: "idle",
    parseDraftRegion: null,
    paragraphOverlayActive: false,
    paragraphBatch: [],
    parseOperations: invalidateParseOperationKinds(state.parseOperations, ["notes", "spec"]),
  }));
}

/** Index handoff: install the destination page first, then atomically revoke/seed Parse. */
export function openNotesParseTarget(
  pageNumber: number,
  notesParseRegion: ParseRegion | null,
): void {
  const crossesPage = useViewerCoreStore.getState().pageNumber !== pageNumber;
  if (crossesPage) {
    prepareLegacyParsePageExit();
    useViewerCoreStore.getState().setPage(pageNumber);
  }
  useParseFlowStore.setState((state) => notesParseRegion
    ? {
        notesParseRegion,
        notesParseStep: "idle",
        specParseStep: "idle",
        specParseRegion: null,
        parseDraftRegion: null,
        paragraphOverlayActive: false,
        paragraphBatch: [],
        notesFastManualActive: false,
        notesFastManualGrid: null,
        guidedParseOwner: null,
        guidedParseActive: false,
        guidedParseRegion: null,
        guidedParseRows: [],
        guidedParseCols: [],
        parseOperations: invalidateParseOperationKinds(
          state.parseOperations,
          ["table", "keynote", "notes", "spec"],
        ),
      }
    : {
        notesParseStep: "idle",
        notesParseRegion: null,
        guidedNotesRows: [],
        guidedNotesCols: [],
        parseDraftRegion: null,
        paragraphOverlayActive: false,
        paragraphBatch: [],
        parseOperations: invalidateParseOperationKinds(
          state.parseOperations,
          crossesPage ? ["table", "keynote", "notes", "spec"] : ["notes", "spec"],
        ),
      });
}

export function openSpecParseTarget(
  pageNumber: number,
  specParseRegion: ParseRegion | null,
): void {
  const crossesPage = useViewerCoreStore.getState().pageNumber !== pageNumber;
  if (crossesPage) {
    prepareLegacyParsePageExit();
    useViewerCoreStore.getState().setPage(pageNumber);
  }
  useParseFlowStore.setState((state) => ({
    specParseStep: "idle",
    specParseRegion,
    parseDraftRegion: null,
    paragraphOverlayActive: false,
    paragraphBatch: [],
    parseOperations: invalidateParseOperationKinds(
      state.parseOperations,
      crossesPage ? ["table", "keynote", "notes", "spec"] : ["notes", "spec"],
    ),
  }));
}

type NotesCompletionOptions = Readonly<{
  guided?: boolean;
  fastManual?: boolean;
}>;

/**
 * Commit the exact Notes reset for the still-current root in one terminal parse publication.
 * Shared paragraph cleanup revokes Spec at the same time. Optional derived-overlay cleanup moves
 * work that used to lag in React effects into the authorized completion itself.
 */
export function completeNotesParseOperation(
  token: ParseOperationToken<"notes">,
  options: NotesCompletionOptions = {},
): boolean {
  if (token.kind !== "notes") return false;
  let completed = false;
  useParseFlowStore.setState((state) => {
    const live = state.parseOperations.notes;
    if (!live.busy || live.revision !== token.revision) return state;
    if (options.guided && state.guidedParseOwner !== "notes") return state;
    completed = true;
    const kinds: ParseKind[] = options.guided
      ? ["table", "keynote", "notes", "spec"]
      : ["notes", "spec"];
    return {
      notesParseStep: "idle",
      notesParseRegion: null,
      guidedNotesRows: [],
      guidedNotesCols: [],
      parseDraftRegion: null,
      paragraphOverlayActive: false,
      paragraphBatch: [],
      ...(options.guided ? { guidedParseOwner: null, guidedParseActive: false } : {}),
      ...(options.guided
        ? { guidedParseRegion: null, guidedParseRows: [], guidedParseCols: [] }
        : {}),
      ...(options.fastManual
        ? { notesFastManualActive: false, notesFastManualGrid: null }
        : {}),
      parseOperations: invalidateParseOperationKinds(state.parseOperations, kinds),
    };
  });
  return completed;
}

/** Commit the exact Spec/shared reset only for the current Spec root. */
export function completeSpecParseOperation(token: ParseOperationToken<"spec">): boolean {
  if (token.kind !== "spec") return false;
  let completed = false;
  useParseFlowStore.setState((state) => {
    const live = state.parseOperations.spec;
    if (!live.busy || live.revision !== token.revision) return state;
    completed = true;
    return {
      specParseStep: "idle",
      specParseRegion: null,
      parseDraftRegion: null,
      paragraphOverlayActive: false,
      paragraphBatch: [],
      parseOperations: invalidateParseOperationKinds(state.parseOperations, ["notes", "spec"]),
    };
  });
  return completed;
}

/** Atomic user Clear/Redraw destination for Notes. */
export function resetNotesParseWorkspace(
  notesParseStep: NotesParseStep = "idle",
  options: NotesCompletionOptions = {},
): void {
  useParseFlowStore.setState((state) => {
    const clearsGuided = options.guided && state.guidedParseOwner === "notes";
    return {
      notesParseStep,
      notesParseRegion: null,
      guidedNotesRows: [],
      guidedNotesCols: [],
      parseDraftRegion: null,
      paragraphOverlayActive: false,
      paragraphBatch: [],
      ...(clearsGuided ? { guidedParseOwner: null, guidedParseActive: false } : {}),
      ...(clearsGuided
        ? { guidedParseRegion: null, guidedParseRows: [], guidedParseCols: [] }
        : {}),
      ...(options.fastManual
        ? { notesFastManualActive: false, notesFastManualGrid: null }
        : {}),
      parseOperations: invalidateParseOperationKinds(
        state.parseOperations,
        clearsGuided
          ? ["table", "keynote", "notes", "spec"]
          : ["notes", "spec"],
      ),
    };
  });
}

/** Atomic user Clear/Redraw destination for Spec. */
export function resetSpecParseWorkspace(
  specParseStep: SpecParseStep = "idle",
): void {
  useParseFlowStore.setState((state) => ({
    specParseStep,
    specParseRegion: null,
    parseDraftRegion: null,
    paragraphOverlayActive: false,
    paragraphBatch: [],
    parseOperations: invalidateParseOperationKinds(state.parseOperations, ["notes", "spec"]),
  }));
}

/**
 * One-publication Notes parser teardown. The mounted instance must present the exact workspace
 * generation it observed before unmount; parent handoff commands remain the sole owner once their
 * prior invalidation has advanced that generation.
 */
export function leaveNotesParserWorkspace(
  lease: ParseWorkspaceLease,
  clearGuided = true,
): boolean {
  let cleaned = false;
  useParseFlowStore.setState((state) => {
    const clearsGuided = clearGuided && state.guidedParseOwner === "notes";
    if (
      !matchesParagraphLeaseRevisions(state.parseOperations, lease) ||
      state.parseOperations.spec.busy ||
      (clearsGuided && (
        !matchesGuidedLeaseRevisions(
          state.parseOperations,
          lease,
          state.guidedParseOwner,
        ) ||
        state.parseOperations.table.busy || state.parseOperations.keynote.busy
      ))
    ) return state;
    const sharedClean = state.parseDraftRegion === null && !state.paragraphOverlayActive &&
      !state.notesFastManualActive && state.notesFastManualGrid === null;
    const guidedClean = !clearsGuided || (
      !state.guidedParseActive && state.guidedParseRegion === null &&
      state.guidedParseRows.length === 0 && state.guidedParseCols.length === 0
    );
    if (sharedClean && guidedClean && !state.parseOperations.notes.busy) return state;
    cleaned = true;
    return {
      parseDraftRegion: null,
      paragraphOverlayActive: false,
      notesFastManualActive: false,
      notesFastManualGrid: null,
      ...(clearsGuided
        ? {
            guidedParseOwner: null,
            guidedParseActive: false,
            guidedParseRegion: null,
            guidedParseRows: [],
            guidedParseCols: [],
          }
        : {}),
      parseOperations: invalidateParseOperationKinds(
        state.parseOperations,
        clearsGuided
          ? ["table", "keynote", "notes", "spec"]
          : ["notes", "spec"],
      ),
    };
  });
  return cleaned;
}

/** One-publication Spec parser teardown; region, batch, and clipboard retain their legacy policy. */
export function leaveSpecParserWorkspace(lease: ParseWorkspaceLease): boolean {
  let cleaned = false;
  useParseFlowStore.setState((state) => {
    if (
      !matchesParagraphLeaseRevisions(state.parseOperations, lease) ||
      state.parseOperations.notes.busy
    ) return state;
    if (
      state.parseDraftRegion === null && !state.paragraphOverlayActive &&
      !state.parseOperations.spec.busy
    ) return state;
    cleaned = true;
    return {
      parseDraftRegion: null,
      paragraphOverlayActive: false,
      parseOperations: invalidateParseOperationKinds(state.parseOperations, ["notes", "spec"]),
    };
  });
  return cleaned;
}

/** Local Notes submode boundary with derived gates and revocation in one publication. */
export function transitionNotesParserMode(
  nextMode?: NotesParserMode,
  notesParseRegion: ParseRegion | null = null,
): ParseWorkspaceLease {
  let lease!: ParseWorkspaceLease;
  useParseFlowStore.setState((state) => {
    const entersGuided = nextMode === "guided" && notesParseRegion !== null;
    const clearsGuided = state.guidedParseOwner === "notes";
    const parseOperations = invalidateParseOperationKinds(
      state.parseOperations,
      entersGuided || clearsGuided
        ? ["table", "keynote", "notes", "spec"]
        : ["notes", "spec"],
    );
    const guidedParseOwner = entersGuided
      ? "notes"
      : clearsGuided
        ? null
        : state.guidedParseOwner;
    lease = workspaceLease(parseOperations, guidedParseOwner);
    const active = notesParseRegion !== null;
    return {
      parseDraftRegion: null,
      paragraphOverlayActive: nextMode === "paragraph" && active,
      notesFastManualActive: nextMode === "fast-manual" && active,
      notesFastManualGrid: null,
      ...(entersGuided || clearsGuided
        ? {
            guidedParseOwner,
            guidedParseActive: entersGuided,
            guidedParseRegion: entersGuided ? notesParseRegion : null,
            guidedParseRows: [],
            guidedParseCols: [],
          }
        : {}),
      parseOperations,
    };
  });
  return lease;
}

/** Local Spec submode boundary with its paragraph gate and revocation kept atomic. */
export function transitionSpecParserMode(
  nextMode?: SpecParserMode,
  specParseRegion: ParseRegion | null = null,
): ParseWorkspaceLease {
  let lease!: ParseWorkspaceLease;
  useParseFlowStore.setState((state) => {
    const parseOperations = invalidateParseOperationKinds(state.parseOperations, ["notes", "spec"]);
    lease = workspaceLease(parseOperations, state.guidedParseOwner);
    return {
      parseDraftRegion: nextMode === "paragraph"
        ? specDraftForParagraphBatch(state.paragraphBatch)
        : null,
      paragraphOverlayActive: nextMode === "paragraph" && specParseRegion !== null,
      parseOperations,
    };
  });
  return lease;
}

/** Single-action paragraph mutations use atomic user-owned workspace generations. */
export function setParagraphBatchForUser(paragraphBatch: PendingParagraph[]): void {
  useParseFlowStore.setState((state) => ({
    paragraphBatch,
    ...(state.specParseRegion
      ? { parseDraftRegion: specDraftForParagraphBatch(paragraphBatch) }
      : {}),
    parseOperations: invalidateParseOperationKinds(state.parseOperations, ["notes", "spec"]),
  }));
}

export function upsertParagraphForUser(paragraph: PendingParagraph): void {
  useParseFlowStore.setState((state) => {
    const index = state.paragraphBatch.findIndex((current) => current.id === paragraph.id);
    const paragraphBatch = index === -1
      ? [...state.paragraphBatch, paragraph]
      : state.paragraphBatch.map((current, currentIndex) =>
        currentIndex === index ? paragraph : current
      );
    return {
      paragraphBatch,
      ...(state.specParseRegion
        ? { parseDraftRegion: specDraftForParagraphBatch(paragraphBatch) }
        : {}),
      parseOperations: invalidateParseOperationKinds(state.parseOperations, ["notes", "spec"]),
    };
  });
}

export function removeParagraphForUser(id: string): void {
  useParseFlowStore.setState((state) => {
    const paragraphBatch = state.paragraphBatch.filter((paragraph) => paragraph.id !== id);
    return {
      paragraphBatch,
      ...(state.specParseRegion
        ? { parseDraftRegion: specDraftForParagraphBatch(paragraphBatch) }
        : {}),
      parseOperations: invalidateParseOperationKinds(state.parseOperations, ["notes", "spec"]),
    };
  });
}

export function addGuidedNotesColumnForUser(bbox: ParseRegion): void {
  useParseFlowStore.setState((state) => ({
    guidedNotesCols: [...state.guidedNotesCols, bbox],
    parseOperations: invalidateParseOperationKinds(state.parseOperations, ["notes"]),
  }));
}

export function addGuidedNotesRowForUser(bbox: ParseRegion): void {
  useParseFlowStore.setState((state) => ({
    guidedNotesRows: [...state.guidedNotesRows, bbox],
    parseOperations: invalidateParseOperationKinds(state.parseOperations, ["notes"]),
  }));
}

/** Commit one Fast Manual gesture only while its exact Notes/Spec generation still owns the draft. */
export function setNotesFastManualGridFromOverlay(
  notesFastManualGrid: ReturnType<typeof useParseFlowStore.getState>["notesFastManualGrid"],
  lease: ParseWorkspaceLease,
): boolean {
  let committed = false;
  useParseFlowStore.setState((state) => {
    if (!matchesParagraphLease(state.parseOperations, lease)) return state;
    if (state.notesFastManualGrid === notesFastManualGrid) return state;
    committed = true;
    return {
      notesFastManualGrid,
      parseDraftRegion: notesFastManualGrid && state.notesParseRegion
        ? notesDraftForGrid(notesFastManualGrid, state.notesParseRegion)
        : null,
    };
  });
  return committed;
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

/** User drawing/cancel transition: exact final tool destination first, one Parse write last. */
export function setTableParseStepWithTool(
  tableParseStep: TableParseStep,
  toolMode: "move" | "pointer",
): void {
  useToolStore.getState().setMode(toolMode);
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

export type TableReviewPublication = Readonly<{
  grid: ParseFlowState["tableParsedGrid"];
  meta: ParseFlowState["tableParseMeta"];
  region?: ParseRegion | null;
}>;

function tableReviewPatch(publication: TableReviewPublication): Partial<ParseFlowState> {
  return {
    tableParsedGrid: publication.grid,
    tableParseMeta: publication.meta,
    ...(publication.region === undefined ? {} : { tableParseRegion: publication.region }),
    tableParseStep: "review",
  };
}

/** User-selected retained row on the current page: tool first, one terminal Parse seed. */
export function openTableReviewWorkspace(
  publication: TableReviewPublication,
  source: "table" | "keynote" = "table",
): void {
  useToolStore.getState().setMode("move");
  useParseFlowStore.setState((state) => ({
    ...tableReviewPatch(publication),
    parseOperations: invalidateParseOperationKinds(
      state.parseOperations,
      source === "keynote" ? ["table", "keynote"] : ["table"],
    ),
  }));
}

/** Cross-page retained-row handoff: destination core page first, then one Table review seed. */
export function openTableReviewTarget(
  pageNumber: number,
  publication: TableReviewPublication,
  source: "table" | "keynote" = "table",
): void {
  if (useViewerCoreStore.getState().pageNumber === pageNumber) {
    openTableReviewWorkspace(publication, source);
    return;
  }
  useToolStore.getState().setMode("move");
  prepareLegacyParsePageExit(false);
  useViewerCoreStore.getState().setPage(pageNumber);
  useParseFlowStore.setState((state) => ({
    ...tableReviewPatch(publication),
    parseOperations: invalidateParseOperationKinds(
      state.parseOperations,
      ["table", "keynote", "notes", "spec"],
    ),
  }));
}

/**
 * Publish one Table review snapshot under its still-current owner. Tool preparation happens first;
 * grid/meta/region/step then land in one parse publication, so a subscriber cannot seed B between
 * pieces of A's review state. A B started by that publication makes the command return false.
 */
export function publishTableReviewForOperation(
  token: ParseOperationToken<"table">,
  publication: TableReviewPublication,
): boolean {
  if (token.kind !== "table" || !useParseFlowStore.getState().isParseOperationCurrent(token)) {
    return false;
  }
  const before = useParseFlowStore.getState();
  prepareParseEntry(before.tableParseStep, "review");
  if (!useParseFlowStore.getState().isParseOperationCurrent(token)) return false;

  let committed = false;
  useParseFlowStore.setState((state) => {
    const live = state.parseOperations.table;
    if (!live.busy || live.revision !== token.revision) return state;
    committed = true;
    return {
      tableParsedGrid: publication.grid,
      tableParseMeta: publication.meta,
      ...(publication.region === undefined ? {} : { tableParseRegion: publication.region }),
      tableParseStep: "review",
    };
  });
  return committed && useParseFlowStore.getState().isParseOperationCurrent(token);
}

type TableCompletionOptions = Readonly<{
  resetGuided?: boolean;
  /** React-local bookkeeping only, denied if terminal subscribers publish any newer operation. */
  afterTerminal?: () => void;
}>;

/**
 * Terminal Table completion. No caller publication may follow the invalidating parse reset; this
 * command prepares the tool, resets atomically, then permits local bookkeeping only when the
 * terminal registry reference still proves that no synchronous B began (even if B settled).
 */
export function completeTableParseOperation(
  token: ParseOperationToken<"table">,
  options: TableCompletionOptions = {},
): boolean {
  const before = useParseFlowStore.getState();
  if (token.kind !== "table" || !before.isParseOperationCurrent(token)) {
    return false;
  }
  const guidedLease = options.resetGuided && before.guidedParseOwner === "table"
    ? workspaceLease(before.parseOperations, before.guidedParseOwner)
    : null;
  useToolStore.getState().setMode("move");
  const afterTool = useParseFlowStore.getState();
  if (!afterTool.isParseOperationCurrent(token)) return false;
  if (guidedLease && !matchesGuidedLeaseRevisions(
    afterTool.parseOperations,
    guidedLease,
    afterTool.guidedParseOwner,
  )) return false;

  let completed = false;
  let terminalOperations: ParseOperationRegistry | null = null;
  useParseFlowStore.setState((state) => {
    const live = state.parseOperations.table;
    if (!live.busy || live.revision !== token.revision) return state;
    const clearsGuided = options.resetGuided && state.guidedParseOwner === "table";
    completed = true;
    const parseOperations = invalidateParseOperationKinds(
      state.parseOperations,
      clearsGuided ? ["table", "keynote", "notes"] : ["table"],
    );
    terminalOperations = parseOperations;
    return {
      tableParseStep: "idle",
      tableParseRegion: null,
      tableParsedGrid: null,
      tableParseMeta: null,
      tableCellStructure: null,
      tableParseColumnBBs: [],
      tableParseColumnNames: [],
      tableParseRowBBs: [],
      ...(clearsGuided
        ? {
            guidedParseOwner: null,
            guidedParseActive: false,
            guidedParseRegion: null,
            guidedParseRows: [],
            guidedParseCols: [],
          }
        : {}),
      parseOperations,
    };
  });
  const expectedOperations = terminalOperations as ParseOperationRegistry | null;
  const currentOperations = useParseFlowStore.getState().parseOperations;
  if (
    completed && expectedOperations !== null &&
    currentOperations.table === expectedOperations.table &&
    (!options.resetGuided || (
      currentOperations.keynote === expectedOperations.keynote &&
      currentOperations.notes === expectedOperations.notes
    ))
  ) {
    options.afterTerminal?.();
  }
  return completed;
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

export function setKeynoteParseStepWithTool(
  keynoteParseStep: KeynoteParseStep,
  toolMode: "move" | "pointer",
): void {
  useToolStore.getState().setMode(toolMode);
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

/** Canvas-drawn Table region accepted as one user boundary before any passive consumer runs. */
export function acceptTableParseRegion(tableParseRegion: ParseRegion): void {
  useToolStore.setState({ mode: "move" });
  useParseFlowStore.setState((state) => ({
    tableParseRegion,
    tableParseStep: "idle",
    parseOperations: invalidateParseOperationKinds(state.parseOperations, ["table"]),
  }));
}

/**
 * Accept one canvas-drawn Keynote region as a single user boundary. Region, idle destination, and
 * owner revocation must publish atomically: a subscriber cannot start B between separate writes.
 */
export function acceptKeynoteParseRegion(keynoteParseRegion: ParseRegion): void {
  useToolStore.setState({ mode: "move" });
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
  const before = useParseFlowStore.getState();
  if (token.kind !== "keynote" || !before.isParseOperationCurrent(token)) {
    return false;
  }
  const guidedLease = options?.resetGuided && before.guidedParseOwner === "keynote"
    ? workspaceLease(before.parseOperations, before.guidedParseOwner)
    : null;
  useToolStore.getState().setMode("move");
  const afterTool = useParseFlowStore.getState();
  if (!afterTool.isParseOperationCurrent(token)) return false;
  if (guidedLease && !matchesGuidedLeaseRevisions(
    afterTool.parseOperations,
    guidedLease,
    afterTool.guidedParseOwner,
  )) return false;

  // The terminal reset is one parse publication. A synchronous B may start after it, but A owns no
  // subsequent parse/tool/local tail that could clear B. A peer-owned Guided grid is untouched.
  let completed = false;
  useParseFlowStore.setState((state) => {
    const live = state.parseOperations.keynote;
    if (!live.busy || live.revision !== token.revision) return state;
    const clearsGuided = options?.resetGuided && state.guidedParseOwner === "keynote";
    completed = true;
    return {
      keynoteParseStep: "idle",
      keynoteParseRegion: null,
      keynoteColumnBBs: [],
      keynoteRowBBs: [],
      keynoteYoloClass: null,
      ...(clearsGuided
        ? {
            guidedParseOwner: null,
            guidedParseActive: false,
            guidedParseRegion: null,
            guidedParseRows: [],
            guidedParseCols: [],
          }
        : {}),
      parseOperations: invalidateParseOperationKinds(
        state.parseOperations,
        clearsGuided ? ["table", "keynote", "notes"] : ["keynote"],
      ),
    };
  });
  return completed;
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

export function setNotesParseStepWithTool(
  notesParseStep: NotesParseStep,
  toolMode: "move" | "pointer",
): void {
  useToolStore.getState().setMode(toolMode);
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

export function setSpecParseStepWithTool(
  specParseStep: SpecParseStep,
  toolMode: "move" | "pointer",
): void {
  useToolStore.getState().setMode(toolMode);
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

/**
 * Clear the parser family that is leaving the Specs/Notes shell. This closes the pre-existing
 * retained-region collision where PDFPage's sacred `spec ?? notes` projection could bind a newly
 * opened Notes paragraph flow to an old Spec bbox. Clipboard identity is deliberately untouched.
 */
function leaveSpecsNotesParseTab(tab: SpecsNotesTab): void {
  if (tab === "keynotes") {
    useParseFlowStore.setState((state) => {
      const ownsGuided = state.guidedParseOwner === "keynote";
      return {
        ...(ownsGuided
          ? {
              guidedParseOwner: null,
              guidedParseActive: false,
              guidedParseRegion: null,
              guidedParseRows: [],
              guidedParseCols: [],
            }
          : {}),
        parseOperations: invalidateParseOperationKinds(
          state.parseOperations,
          ownsGuided ? ["table", "keynote", "notes"] : ["keynote"],
        ),
      };
    });
    return;
  }

  if (tab === "notes-parse") {
    useParseFlowStore.setState((state) => {
      const ownsGuided = state.guidedParseOwner === "notes";
      return {
        notesParseStep: "idle",
        notesParseRegion: null,
        guidedNotesRows: [],
        guidedNotesCols: [],
        notesFastManualActive: false,
        notesFastManualGrid: null,
        ...(ownsGuided
          ? {
              guidedParseOwner: null,
              guidedParseActive: false,
              guidedParseRegion: null,
              guidedParseRows: [],
              guidedParseCols: [],
            }
          : {}),
        parseDraftRegion: null,
        paragraphOverlayActive: false,
        paragraphBatch: [],
        parseOperations: invalidateParseOperationKinds(
          state.parseOperations,
          ownsGuided
            ? ["table", "keynote", "notes", "spec"]
            : ["notes", "spec"],
        ),
      };
    });
    return;
  }

  useParseFlowStore.setState((state) => ({
    specParseStep: "idle",
    specParseRegion: null,
    parseDraftRegion: null,
    paragraphOverlayActive: false,
    paragraphBatch: [],
    parseOperations: invalidateParseOperationKinds(state.parseOperations, ["notes", "spec"]),
  }));
}

/** Specs/Notes shell tab handoff: parse cleanup publishes before the UI destination. */
export function setSpecsNotesParseTab(specsNotesTab: SpecsNotesTab): void {
  const ui = useUiStore.getState();
  if (ui.specsNotesTab === specsNotesTab) return;
  leaveSpecsNotesParseTab(ui.specsNotesTab);
  useUiStore.getState().setSpecsNotesTab(specsNotesTab);
}

/** Toolbar/header panel toggle with active-family revocation on close. */
export function toggleSpecsNotesParsePanel(): void {
  const ui = useUiStore.getState();
  if (ui.showSpecsNotesPanel) leaveSpecsNotesParseTab(ui.specsNotesTab);
  useUiStore.getState().toggleSpecsNotesPanel();
}

/** Open the shell directly on a requested parser without bypassing an existing family handoff. */
export function openSpecsNotesParseTab(specsNotesTab: SpecsNotesTab): void {
  const ui = useUiStore.getState();
  if (ui.specsNotesTab !== specsNotesTab) leaveSpecsNotesParseTab(ui.specsNotesTab);
  if (!ui.showSpecsNotesPanel) useUiStore.getState().toggleSpecsNotesPanel();
  if (ui.specsNotesTab !== specsNotesTab) useUiStore.getState().setSpecsNotesTab(specsNotesTab);
}

export function toggleTableParsePanel(): void {
  const closing = useUiStore.getState().showTableParsePanel;

  if (closing) {
    // Presentation closes before the terminal Parse publication. A synchronous B started by that
    // terminal write may reopen itself; old A owns no later UI/tool tail that can hide it.
    useUiStore.getState().setPanelVisibility({ showTableParsePanel: false });
    const before = useParseFlowStore.getState();
    const preservesPeerGuided = before.guidedParseOwner !== null &&
      before.guidedParseOwner !== "table";
    // Preserve the old raw mode transition. Calling setMode would clear additional live tools.
    // Publish it before the Parse reset: a B started by that reset owns every later tool write.
    if (!preservesPeerGuided) useToolStore.setState({ mode: "move" });
    useParseFlowStore.setState((state) => {
      const ownsGuided = state.guidedParseOwner === "table";
      return {
        tableParseStep: "idle",
        tableParseRegion: null,
        tableParsedGrid: null,
        tableParseMeta: null,
        tableParseColumnBBs: [],
        tableParseColumnNames: [],
        tableParseRowBBs: [],
        tableParseTab: "all",
        ...(ownsGuided
          ? {
              guidedParseOwner: null,
              guidedParseActive: false,
              guidedParseRegion: null,
              guidedParseRows: [],
              guidedParseCols: [],
            }
          : {}),
        parseOperations: invalidateParseOperationKinds(
          state.parseOperations,
          ownsGuided ? ["table", "keynote", "notes"] : ["table"],
        ),
      };
    });
    return;
  }
  useUiStore.getState().setPanelVisibility({ showTableParsePanel: true });
}

export function toggleKeynoteParsePanel(): void {
  const closing = useUiStore.getState().showKeynoteParsePanel;

  if (closing) {
    useUiStore.getState().setPanelVisibility({ showKeynoteParsePanel: false });
    const before = useParseFlowStore.getState();
    const preservesPeerGuided = before.guidedParseOwner !== null &&
      before.guidedParseOwner !== "keynote";
    // Tool-first prevents the terminal Parse publication from creating a late A tool tail.
    if (!preservesPeerGuided) useToolStore.setState({ mode: "move" });
    useParseFlowStore.setState((state) => {
      const ownsGuided = state.guidedParseOwner === "keynote";
      return {
        keynoteParseStep: "idle",
        keynoteParseRegion: null,
        keynoteColumnBBs: [],
        keynoteRowBBs: [],
        keynoteYoloClass: null,
        keynoteParseTab: "all",
        ...(ownsGuided
          ? {
              guidedParseOwner: null,
              guidedParseActive: false,
              guidedParseRegion: null,
              guidedParseRows: [],
              guidedParseCols: [],
            }
          : {}),
        parseOperations: invalidateParseOperationKinds(
          state.parseOperations,
          ownsGuided ? ["table", "keynote", "notes"] : ["keynote"],
        ),
      };
    });
    return;
  }
  useUiStore.getState().setPanelVisibility({ showKeynoteParsePanel: true });
}
