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
}>;

function workspaceLease(parseOperations: ParseOperationRegistry): ParseWorkspaceLease {
  return {
    tableRevision: parseOperations.table.revision,
    keynoteRevision: parseOperations.keynote.revision,
    notesRevision: parseOperations.notes.revision,
    specRevision: parseOperations.spec.revision,
  };
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
): boolean {
  return parseOperations.table.revision === lease.tableRevision &&
    parseOperations.keynote.revision === lease.keynoteRevision &&
    parseOperations.notes.revision === lease.notesRevision;
}

function matchesGuidedLease(
  parseOperations: ParseOperationRegistry,
  lease: ParseWorkspaceLease,
): boolean {
  return parseOperations.table.revision === lease.tableRevision &&
    parseOperations.keynote.revision === lease.keynoteRevision &&
    parseOperations.notes.revision === lease.notesRevision &&
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

function sameParseRegion(a: ParseRegion | null, b: ParseRegion | null): boolean {
  return Boolean(a && b && a.every((value, index) => value === b[index]));
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
  const kinds = sharedKinds.filter((kind) => kind !== except);
  let lease!: ParseWorkspaceLease;
  useParseFlowStore.setState((state) => {
    const parseOperations = invalidateParseOperationKinds(state.parseOperations, kinds);
    lease = workspaceLease(parseOperations);
    return { parseOperations };
  });
  return lease;
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

/** Revoke the Notes/Spec owners of the shared draft + paragraph workspace in one publication. */
export function invalidateParagraphParseOperations(
  except?: "notes" | "spec",
): ParseWorkspaceLease {
  const sharedKinds = ["notes", "spec"] as const;
  const kinds = sharedKinds.filter((kind) => kind !== except);
  let lease!: ParseWorkspaceLease;
  useParseFlowStore.setState((state) => {
    const parseOperations = invalidateParseOperationKinds(state.parseOperations, kinds);
    lease = workspaceLease(parseOperations);
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
  const kinds = (["table", "keynote", "notes", "spec"] as const)
    .filter((kind) => kind !== except);
  let lease!: ParseWorkspaceLease;
  useParseFlowStore.setState((state) => {
    const parseOperations = invalidateParseOperationKinds(state.parseOperations, kinds);
    lease = workspaceLease(parseOperations);
    return { parseOperations };
  });
  return lease;
}

/** Single-lane page/lifetime invalidation with a causally captured shared-workspace lease. */
export function invalidateParseOperationForWorkspace(kind: ParseKind): ParseWorkspaceLease {
  let lease!: ParseWorkspaceLease;
  useParseFlowStore.setState((state) => {
    const parseOperations = invalidateParseOperationKinds(state.parseOperations, [kind]);
    lease = workspaceLease(parseOperations);
    return { parseOperations };
  });
  return lease;
}

/** Begin one shared Guided-grid gesture and return the exact generation its writes may mutate. */
export function beginGuidedGridEdit(): ParseWorkspaceLease {
  let lease!: ParseWorkspaceLease;
  useParseFlowStore.setState((state) => {
    const parseOperations = invalidateParseOperationKinds(
      state.parseOperations,
      ["table", "keynote", "notes"],
    );
    lease = workspaceLease(parseOperations);
    return { parseOperations };
  });
  return lease;
}

export function setGuidedParseRowsForLease(
  guidedParseRows: number[],
  lease: ParseWorkspaceLease,
): boolean {
  let committed = false;
  useParseFlowStore.setState((state) => {
    if (!matchesGuidedLease(state.parseOperations, lease)) return state;
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
    if (!matchesGuidedLease(state.parseOperations, lease)) return state;
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
    lease = workspaceLease(parseOperations);
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
  useParseFlowStore.setState((state) => ({
    notesParseRegion,
    notesParseStep: "idle",
    specParseStep: "idle",
    specParseRegion: null,
    guidedSpecSectionBBs: [],
    parseDraftRegion: null,
    paragraphOverlayActive: false,
    paragraphBatch: [],
    notesFastManualActive: false,
    notesFastManualGrid: null,
    guidedParseActive: false,
    guidedParseRegion: null,
    guidedParseRows: [],
    guidedParseCols: [],
    parseOperations: invalidateParseOperationKinds(
      state.parseOperations,
      ["table", "keynote", "notes", "spec"],
    ),
  }));
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

/**
 * Index handoffs seed/reset the parse destination once before page subscribers run. No parse write
 * follows `setPage`, so a synchronous B admitted by page navigation cannot be erased by old A.
 */
export function openNotesParseTarget(
  pageNumber: number,
  notesParseRegion: ParseRegion | null,
): void {
  useParseFlowStore.setState((state) => notesParseRegion
    ? {
        notesParseRegion,
        notesParseStep: "idle",
        specParseStep: "idle",
        specParseRegion: null,
        guidedSpecSectionBBs: [],
        parseDraftRegion: null,
        paragraphOverlayActive: false,
        paragraphBatch: [],
        notesFastManualActive: false,
        notesFastManualGrid: null,
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
          ["notes", "spec"],
        ),
      });
  useViewerCoreStore.getState().setPage(pageNumber);
}

export function openSpecParseTarget(
  pageNumber: number,
  specParseRegion: ParseRegion | null,
): void {
  useParseFlowStore.setState((state) => ({
    specParseStep: "idle",
    specParseRegion,
    guidedSpecSectionBBs: [],
    parseDraftRegion: null,
    paragraphOverlayActive: false,
    paragraphBatch: [],
    parseOperations: invalidateParseOperationKinds(state.parseOperations, ["notes", "spec"]),
  }));
  useViewerCoreStore.getState().setPage(pageNumber);
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
      ...(options.guided ? { guidedParseActive: false } : {}),
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
      guidedSpecSectionBBs: [],
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
  useParseFlowStore.setState((state) => ({
    notesParseStep,
    notesParseRegion: null,
    guidedNotesRows: [],
    guidedNotesCols: [],
    parseDraftRegion: null,
    paragraphOverlayActive: false,
    paragraphBatch: [],
    ...(options.guided ? { guidedParseActive: false } : {}),
    ...(options.guided
      ? { guidedParseRegion: null, guidedParseRows: [], guidedParseCols: [] }
      : {}),
    ...(options.fastManual
      ? { notesFastManualActive: false, notesFastManualGrid: null }
      : {}),
    parseOperations: invalidateParseOperationKinds(
      state.parseOperations,
      options.guided
        ? ["table", "keynote", "notes", "spec"]
        : ["notes", "spec"],
    ),
  }));
}

/** Atomic user Clear/Redraw destination for Spec. */
export function resetSpecParseWorkspace(
  specParseStep: SpecParseStep = "idle",
): void {
  useParseFlowStore.setState((state) => ({
    specParseStep,
    specParseRegion: null,
    guidedSpecSectionBBs: [],
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
    if (
      !matchesParagraphLeaseRevisions(state.parseOperations, lease) ||
      state.parseOperations.spec.busy ||
      (clearGuided && (
        !matchesGuidedLeaseRevisions(state.parseOperations, lease) ||
        state.parseOperations.table.busy || state.parseOperations.keynote.busy
      ))
    ) return state;
    const sharedClean = state.parseDraftRegion === null && !state.paragraphOverlayActive &&
      !state.notesFastManualActive && state.notesFastManualGrid === null;
    const guidedClean = !clearGuided || (
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
      ...(clearGuided
        ? {
            guidedParseActive: false,
            guidedParseRegion: null,
            guidedParseRows: [],
            guidedParseCols: [],
          }
        : {}),
      parseOperations: invalidateParseOperationKinds(
        state.parseOperations,
        clearGuided
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
    const parseOperations = invalidateParseOperationKinds(
      state.parseOperations,
      ["table", "keynote", "notes", "spec"],
    );
    lease = workspaceLease(parseOperations);
    const active = notesParseRegion !== null;
    return {
      parseDraftRegion: null,
      paragraphOverlayActive: nextMode === "paragraph" && active,
      notesFastManualActive: nextMode === "fast-manual" && active,
      notesFastManualGrid: null,
      guidedParseActive: nextMode === "guided" && active,
      guidedParseRegion: nextMode === "guided" ? notesParseRegion : null,
      guidedParseRows: [],
      guidedParseCols: [],
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
    lease = workspaceLease(parseOperations);
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

/**
 * Clear the parser family that is leaving the Specs/Notes shell. This closes the pre-existing
 * retained-region collision where PDFPage's sacred `spec ?? notes` projection could bind a newly
 * opened Notes paragraph flow to an old Spec bbox. Clipboard identity is deliberately untouched.
 */
function leaveSpecsNotesParseTab(tab: SpecsNotesTab): void {
  if (tab === "keynotes") {
    useParseFlowStore.setState((state) => {
      const ownsGuided = sameParseRegion(state.keynoteParseRegion, state.guidedParseRegion);
      return {
        ...(ownsGuided
          ? {
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
      const ownsGuided = sameParseRegion(state.notesParseRegion, state.guidedParseRegion);
      return {
        notesParseStep: "idle",
        notesParseRegion: null,
        guidedNotesRows: [],
        guidedNotesCols: [],
        notesFastManualActive: false,
        notesFastManualGrid: null,
        ...(ownsGuided
          ? {
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
    guidedSpecSectionBBs: [],
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
