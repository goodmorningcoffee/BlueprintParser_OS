// @vitest-environment node
// [refactor jul12 P2.4 A2d freeze-first] Neutral Notes/Spec authority coordinators.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ParseKind,
  ParseOperationToken,
} from "@/lib/parse-operation-state";
import type {
  PendingParagraph,
  ParagraphTemplate,
} from "@/stores/parseFlowStore";
import { useParseFlowStore } from "@/stores/parseFlowStore";
import { useUiStore, type SpecsNotesTab } from "@/stores/uiStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import * as viewerCommands from "@/stores/viewerCommands";
import { resetProjectData } from "@/stores/viewerCommands";
import type { ParsedRegion } from "@/types";

type ParseRegion = [number, number, number, number];
type ParserWorkspaceLease = Readonly<{
  tableRevision: number;
  keynoteRevision: number;
  notesRevision: number;
  specRevision: number;
}>;

type PlannedCommands = {
  invalidateParagraphParseOperations: (except?: "notes" | "spec") => void;
  invalidateNotesWorkspaceOperations: (except?: ParseKind) => void;
  acceptNotesParseRegion: (region: ParseRegion) => void;
  acceptSpecParseRegion: (region: ParseRegion) => void;
  completeNotesParseOperation: (token: ParseOperationToken<"notes">) => boolean;
  completeSpecParseOperation: (token: ParseOperationToken<"spec">) => boolean;
  setSpecsNotesParseTab: (tab: SpecsNotesTab) => void;
  leaveNotesParserWorkspace: (
    lease: ParserWorkspaceLease,
    clearGuided?: boolean,
  ) => boolean;
  leaveSpecParserWorkspace: (lease: ParserWorkspaceLease) => boolean;
  openNotesParseTarget: (pageNumber: number, region: ParseRegion | null) => void;
  openSpecParseTarget: (pageNumber: number, region: ParseRegion | null) => void;
  transitionNotesParserMode: () => ParserWorkspaceLease;
  transitionSpecParserMode: () => ParserWorkspaceLease;
  setParagraphBatchForUser: (batch: PendingParagraph[]) => void;
  upsertParagraphForUser: (paragraph: PendingParagraph) => void;
  removeParagraphForUser: (id: string) => void;
};

function plannedCommand<K extends keyof PlannedCommands>(name: K): PlannedCommands[K] {
  const command = (viewerCommands as unknown as Record<string, unknown>)[name];
  expect(command, `${name} planned neutral API`).toBeTypeOf("function");
  return command as PlannedCommands[K];
}

const REGION_A: ParseRegion = [0.1, 0.2, 0.7, 0.8];
const REGION_B: ParseRegion = [0.2, 0.25, 0.8, 0.85];

function paragraph(id: string): PendingParagraph {
  return {
    id,
    bbox: [0.2, 0.3, 0.7, 0.4],
    lines: [],
    rowText: { Key: id, Note: `${id}-body` },
  };
}

function draft(id: string): ParsedRegion {
  return {
    id,
    type: "notes",
    category: "notes-preview",
    bbox: [0.1, 0.2, 0.6, 0.7],
    confidence: 0.85,
    source: "user",
    data: {},
  };
}

function beginAllKinds(): void {
  for (const kind of ["table", "keynote", "notes", "spec"] as const) {
    expect(useParseFlowStore.getState().beginParseOperation(kind).status).toBe("started");
  }
}

function currentWorkspaceLease(): ParserWorkspaceLease {
  const operations = useParseFlowStore.getState().parseOperations;
  return {
    tableRevision: operations.table.revision,
    keynoteRevision: operations.keynote.revision,
    notesRevision: operations.notes.revision,
    specRevision: operations.spec.revision,
  };
}

beforeEach(() => {
  resetProjectData();
});

describe("A2d shared Notes/Spec invalidation commands", () => {
  it("invalidates both paragraph owners and preserves unrelated lane identities in one publication", () => {
    beginAllKinds();
    const before = useParseFlowStore.getState().parseOperations;
    const listener = vi.fn();
    const unsubscribe = useParseFlowStore.subscribe(listener);

    try {
      plannedCommand("invalidateParagraphParseOperations")();
    } finally {
      unsubscribe();
    }

    const after = useParseFlowStore.getState().parseOperations;
    expect(listener).toHaveBeenCalledTimes(1);
    expect(after.table).toBe(before.table);
    expect(after.keynote).toBe(before.keynote);
    for (const kind of ["notes", "spec"] as const) {
      expect(after[kind], kind).toEqual({
        revision: before[kind].revision + 1,
        busy: false,
      });
    }
  });

  it("invalidates only the non-excepted paragraph owner in one publication", () => {
    beginAllKinds();
    const before = useParseFlowStore.getState().parseOperations;
    const listener = vi.fn();
    const unsubscribe = useParseFlowStore.subscribe(listener);

    try {
      plannedCommand("invalidateParagraphParseOperations")("notes");
    } finally {
      unsubscribe();
    }

    const after = useParseFlowStore.getState().parseOperations;
    expect(listener).toHaveBeenCalledTimes(1);
    expect(after.table).toBe(before.table);
    expect(after.keynote).toBe(before.keynote);
    expect(after.notes).toBe(before.notes);
    expect(after.spec).toEqual({ revision: before.spec.revision + 1, busy: false });
  });

  it("invalidates the full Notes workspace union except its admitted owner in one publication", () => {
    beginAllKinds();
    useParseFlowStore.setState({ guidedParseOwner: "notes" });
    const before = useParseFlowStore.getState().parseOperations;
    const listener = vi.fn();
    const unsubscribe = useParseFlowStore.subscribe(listener);

    try {
      plannedCommand("invalidateNotesWorkspaceOperations")("notes");
    } finally {
      unsubscribe();
    }

    const after = useParseFlowStore.getState().parseOperations;
    expect(listener).toHaveBeenCalledTimes(1);
    expect(after.notes).toBe(before.notes);
    for (const kind of ["table", "keynote", "spec"] as const) {
      expect(after[kind], kind).toEqual({
        revision: before[kind].revision + 1,
        busy: false,
      });
    }
  });

  it("invalidates all four Notes workspace borrowers by default in one publication", () => {
    beginAllKinds();
    const before = useParseFlowStore.getState().parseOperations;
    const listener = vi.fn();
    const unsubscribe = useParseFlowStore.subscribe(listener);

    try {
      plannedCommand("invalidateNotesWorkspaceOperations")();
    } finally {
      unsubscribe();
    }

    const after = useParseFlowStore.getState().parseOperations;
    expect(listener).toHaveBeenCalledTimes(1);
    for (const kind of ["table", "keynote", "notes", "spec"] as const) {
      expect(after[kind], kind).toEqual({
        revision: before[kind].revision + 1,
        busy: false,
      });
    }
  });
});

describe("A2d atomic canvas-region acceptance", () => {
  it.each([
    {
      kind: "notes" as const,
      command: "acceptNotesParseRegion" as const,
      stepKey: "notesParseStep" as const,
      regionKey: "notesParseRegion" as const,
      changedKinds: ["table", "keynote", "notes", "spec"] as const,
    },
    {
      kind: "spec" as const,
      command: "acceptSpecParseRegion" as const,
      stepKey: "specParseStep" as const,
      regionKey: "specParseRegion" as const,
      changedKinds: ["notes", "spec"] as const,
    },
  ])("accepts a $kind region, idles its step, and revokes the required lanes once", (entry) => {
    beginAllKinds();
    const clipboard: ParagraphTemplate = {
      colBoundaries: [0.1, 0.45, 0.9],
      headers: ["Key", "Value"],
    };
    const guidedRows = [0.2, 0.55, 0.8];
    const guidedCols = [0.1, 0.4, 0.9];
    const fastGrid = {
      headers: ["Key", "Note"],
      rows: [{ Key: "stale", Note: "shared workspace" }],
    };
    useParseFlowStore.setState({
      notesParseStep: "select-region",
      notesParseRegion: REGION_A,
      guidedNotesRows: [REGION_A],
      guidedNotesCols: [REGION_B],
      notesFastManualActive: true,
      notesFastManualGrid: fastGrid,
      guidedParseOwner: "notes",
      guidedParseActive: true,
      guidedParseRegion: REGION_A,
      guidedParseRows: guidedRows,
      guidedParseCols: guidedCols,
      specParseStep: "select-region",
      specParseRegion: REGION_A,
      parseDraftRegion: draft(`${entry.kind}-accept-stale-draft`),
      paragraphOverlayActive: true,
      paragraphBatch: [paragraph(`${entry.kind}-accept-stale-batch`)],
      paragraphClipboard: clipboard,
    });
    const before = useParseFlowStore.getState().parseOperations;
    const listener = vi.fn();
    const unsubscribe = useParseFlowStore.subscribe(listener);

    try {
      (plannedCommand(entry.command) as (region: ParseRegion) => void)(REGION_B);
    } finally {
      unsubscribe();
    }

    const state = useParseFlowStore.getState();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(state[entry.regionKey]).toBe(REGION_B);
    expect(state[entry.stepKey]).toBe("idle");
    expect(state.parseDraftRegion).toBeNull();
    expect(state.paragraphOverlayActive).toBe(false);
    expect(state.paragraphBatch).toEqual([]);
    expect(state.paragraphClipboard).toBe(clipboard);

    if (entry.kind === "notes") {
      // Notes owns both shared workspaces. A new Notes region must retire the stale Spec family,
      // shared Guided projection, and derived Fast Manual projection in the same publication.
      expect(state.specParseStep).toBe("idle");
      expect(state.specParseRegion).toBeNull();
      expect(state.guidedParseActive).toBe(false);
      expect(state.guidedParseRegion).toBeNull();
      expect(state.guidedParseRows).toEqual([]);
      expect(state.guidedParseCols).toEqual([]);
      expect(state.notesFastManualActive).toBe(false);
      expect(state.notesFastManualGrid).toBeNull();
    } else {
      // Spec borrows only the draft/paragraph workspace. The independent Notes Guided generation
      // is not part of this handoff and must remain byte-for-byte owned by its existing family.
      expect(state.guidedParseActive).toBe(true);
      expect(state.guidedParseRegion).toBe(REGION_A);
      expect(state.guidedParseRows).toBe(guidedRows);
      expect(state.guidedParseCols).toBe(guidedCols);
      expect(state.notesFastManualActive).toBe(true);
      expect(state.notesFastManualGrid).toBe(fastGrid);
    }

    for (const kind of ["table", "keynote", "notes", "spec"] as const) {
      if (entry.changedKinds.includes(kind as never)) {
        expect(state.parseOperations[kind], kind).toEqual({
          revision: before[kind].revision + 1,
          busy: false,
        });
      } else {
        expect(state.parseOperations[kind], kind).toBe(before[kind]);
      }
    }
  });
});

describe("A2d current-token completion commands", () => {
  it.each([
    ["notes", "completeNotesParseOperation"],
    ["spec", "completeSpecParseOperation"],
  ] as const)("fails closed for a stale %s token without publishing", (kind, commandName) => {
    const started = useParseFlowStore.getState().beginParseOperation(kind);
    if (started.status !== "started") throw new Error(`Could not admit ${kind} token`);
    useParseFlowStore.getState().invalidateParseOperation(kind);
    const before = useParseFlowStore.getState();
    const listener = vi.fn();
    const unsubscribe = useParseFlowStore.subscribe(listener);

    let completed: boolean;
    try {
      completed = (plannedCommand(commandName) as (
        token: ParseOperationToken<typeof kind>,
      ) => boolean)(started.token);
    } finally {
      unsubscribe();
    }

    expect(completed!).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(useParseFlowStore.getState()).toBe(before);
  });

  it.each([
    ["notes", "spec", "completeNotesParseOperation"],
    ["spec", "notes", "completeSpecParseOperation"],
  ] as const)("rejects a runtime %s command with a %s token without publishing", (
    commandKind,
    tokenKind,
    commandName,
  ) => {
    const started = useParseFlowStore.getState().beginParseOperation(tokenKind);
    if (started.status !== "started") throw new Error(`Could not admit ${tokenKind} token`);
    const before = useParseFlowStore.getState();
    const listener = vi.fn();
    const unsubscribe = useParseFlowStore.subscribe(listener);

    let completed: boolean;
    try {
      completed = (plannedCommand(commandName) as (
        token: ParseOperationToken,
      ) => boolean)(started.token);
    } finally {
      unsubscribe();
    }

    expect(completed!, commandKind).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(useParseFlowStore.getState()).toBe(before);
  });

  it.each([
    ["notes", "completeNotesParseOperation"],
    ["spec", "completeSpecParseOperation"],
  ] as const)("completes current %s state and shared paragraph teardown in one publication", (
    kind,
    commandName,
  ) => {
    const peer = kind === "notes" ? "spec" : "notes";
    const started = useParseFlowStore.getState().beginParseOperation(kind);
    const peerStarted = useParseFlowStore.getState().beginParseOperation(peer);
    if (started.status !== "started" || peerStarted.status !== "started") {
      throw new Error(`Could not admit ${kind}/peer tokens`);
    }
    const clipboard: ParagraphTemplate = {
      colBoundaries: [0.2, 0.5, 0.8],
      headers: ["Key", "Value"],
    };
    const fastGrid = {
      headers: ["Key", "Note"],
      rows: [{ Key: "1", Note: "Retained" }],
    };
    useParseFlowStore.setState({
      notesParseStep: "review",
      notesParseRegion: REGION_A,
      guidedNotesRows: [REGION_A],
      guidedNotesCols: [REGION_B],
      guidedParseOwner: "notes",
      guidedParseActive: true,
      guidedParseRegion: REGION_A,
      guidedParseRows: [0.2, 0.8],
      guidedParseCols: [0.1, 0.9],
      notesFastManualActive: true,
      notesFastManualGrid: fastGrid,
      specParseStep: "review",
      specParseRegion: REGION_B,
      parseDraftRegion: draft("completion-draft"),
      paragraphOverlayActive: true,
      paragraphBatch: [paragraph("completion-A")],
      paragraphClipboard: clipboard,
    });
    const before = useParseFlowStore.getState().parseOperations;
    const listener = vi.fn();
    const unsubscribe = useParseFlowStore.subscribe(listener);

    let completed: boolean;
    try {
      completed = (plannedCommand(commandName) as (
        token: ParseOperationToken<typeof kind>,
      ) => boolean)(started.token);
    } finally {
      unsubscribe();
    }

    const state = useParseFlowStore.getState();
    expect(completed!).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(state.parseDraftRegion).toBeNull();
    expect(state.paragraphOverlayActive).toBe(false);
    expect(state.paragraphBatch).toEqual([]);
    expect(state.paragraphClipboard).toBe(clipboard);
    expect(state.parseOperations.notes).toEqual({
      revision: before.notes.revision + 1,
      busy: false,
    });
    expect(state.parseOperations.spec).toEqual({
      revision: before.spec.revision + 1,
      busy: false,
    });
    expect(state.parseOperations.table).toBe(before.table);
    expect(state.parseOperations.keynote).toBe(before.keynote);

    if (kind === "notes") {
      expect(state.notesParseStep).toBe("idle");
      expect(state.notesParseRegion).toBeNull();
      expect(state.guidedNotesRows).toEqual([]);
      expect(state.guidedNotesCols).toEqual([]);
      expect(state.notesFastManualActive).toBe(true);
      expect(state.notesFastManualGrid).toBe(fastGrid);
      expect(state.specParseRegion).toBe(REGION_B);
    } else {
      expect(state.specParseStep).toBe("idle");
      expect(state.specParseRegion).toBeNull();
      expect(state.notesParseRegion).toBe(REGION_A);
    }
  });

  it.each([
    ["notes", "completeNotesParseOperation", "notesParseRegion"],
    ["spec", "completeSpecParseOperation", "specParseRegion"],
  ] as const)("cannot let stale %s cleanup clear synchronous subscriber B", (
    kind,
    commandName,
    regionKey,
  ) => {
    useParseFlowStore.setState({
      [regionKey]: REGION_A,
      paragraphBatch: [paragraph("subscriber-A")],
    });
    const started = useParseFlowStore.getState().beginParseOperation(kind);
    if (started.status !== "started") throw new Error(`Could not admit ${kind} token A`);

    let armed = true;
    let tokenB: ParseOperationToken<typeof kind> | undefined;
    const unsubscribe = useParseFlowStore.subscribe((state, previous) => {
      if (kind === "notes") {
        if (!armed || previous.notesParseRegion === null || state.notesParseRegion !== null) return;
      } else if (!armed || previous.specParseRegion === null || state.specParseRegion !== null) {
        return;
      }
      armed = false;
      useParseFlowStore.setState({
        [regionKey]: REGION_B,
        paragraphBatch: [paragraph("subscriber-B")],
      });
      const replacement = useParseFlowStore.getState().beginParseOperation(kind);
      if (replacement.status !== "started") throw new Error(`Subscriber could not admit ${kind} B`);
      tokenB = replacement.token;
    });

    try {
      expect((plannedCommand(commandName) as (
        token: ParseOperationToken<typeof kind>,
      ) => boolean)(started.token)).toBe(true);
      expect(useParseFlowStore.getState().finishParseOperation(started.token)).toBe(false);
    } finally {
      unsubscribe();
    }

    const state = useParseFlowStore.getState();
    expect(tokenB).toBeDefined();
    expect(state[regionKey]).toBe(REGION_B);
    expect(state.paragraphBatch.map((entry) => entry.id)).toEqual(["subscriber-B"]);
    expect(state.parseOperations[kind]).toEqual({
      revision: tokenB!.revision,
      busy: true,
    });
  });
});

describe("A2d Specs/Notes family handoff", () => {
  it.each([
    ["spec-parse", "notes-parse", "spec"],
    ["notes-parse", "spec-parse", "notes"],
  ] as const)("hands %s to %s by clearing only the outgoing incompatible workspace", (
    currentTab,
    nextTab,
    outgoingKind,
  ) => {
    useUiStore.setState({ specsNotesTab: currentTab });
    beginAllKinds();
    const clipboard: ParagraphTemplate = {
      colBoundaries: [0.1, 0.4, 0.9],
      headers: ["sectionHeader", "body"],
    };
    const batch = [paragraph("handoff-A")];
    const parseDraft = draft("handoff-draft");
    useParseFlowStore.setState({
      notesParseStep: "review",
      notesParseRegion: REGION_A,
      guidedNotesRows: [REGION_A],
      guidedNotesCols: [REGION_B],
      guidedParseOwner: "notes",
      guidedParseActive: true,
      guidedParseRegion: REGION_A,
      guidedParseRows: [0.2, 0.8],
      guidedParseCols: [0.1, 0.9],
      specParseStep: "review",
      specParseRegion: REGION_B,
      parseDraftRegion: parseDraft,
      paragraphOverlayActive: true,
      paragraphBatch: batch,
      paragraphClipboard: clipboard,
    });
    const before = useParseFlowStore.getState().parseOperations;
    const trace: string[] = [];
    let parsePublications = 0;
    const unsubscribeParse = useParseFlowStore.subscribe(() => {
      parsePublications += 1;
      trace.push("parse");
    });
    const unsubscribeUi = useUiStore.subscribe((state, previous) => {
      if (state.specsNotesTab !== previous.specsNotesTab) trace.push("ui");
    });

    try {
      plannedCommand("setSpecsNotesParseTab")(nextTab);
    } finally {
      unsubscribeParse();
      unsubscribeUi();
    }

    const state = useParseFlowStore.getState();
    expect(trace).toEqual(["parse", "ui"]);
    expect(parsePublications).toBe(1);
    expect(useUiStore.getState().specsNotesTab).toBe(nextTab);
    expect(state.parseDraftRegion).toBeNull();
    expect(state.paragraphOverlayActive).toBe(false);
    expect(state.paragraphBatch).toEqual([]);
    expect(state.paragraphClipboard).toBe(clipboard);
    if (outgoingKind === "notes") {
      // Leaving Notes also tears down the Table/Keynote/Notes shared Guided projection.
      for (const kind of ["table", "keynote"] as const) {
        expect(state.parseOperations[kind], kind).toEqual({
          revision: before[kind].revision + 1,
          busy: false,
        });
      }
    } else {
      expect(state.parseOperations.table).toBe(before.table);
      expect(state.parseOperations.keynote).toBe(before.keynote);
    }
    expect(state.parseOperations.notes).toEqual({
      revision: before.notes.revision + 1,
      busy: false,
    });
    expect(state.parseOperations.spec).toEqual({
      revision: before.spec.revision + 1,
      busy: false,
    });

    if (outgoingKind === "spec") {
      expect(state.specParseStep).toBe("idle");
      expect(state.specParseRegion).toBeNull();
      expect(state.notesParseStep).toBe("review");
      expect(state.notesParseRegion).toBe(REGION_A);
    } else {
      expect(state.notesParseStep).toBe("idle");
      expect(state.notesParseRegion).toBeNull();
      expect(state.guidedNotesRows).toEqual([]);
      expect(state.guidedNotesCols).toEqual([]);
      expect(state.specParseStep).toBe("review");
      expect(state.specParseRegion).toBe(REGION_B);
    }
  });

  it("preserves an independently owned Guided generation when departing Notes", () => {
    useUiStore.setState({ specsNotesTab: "notes-parse" });
    beginAllKinds();
    const guidedRegion: ParseRegion = [0.3, 0.15, 0.9, 0.75];
    const guidedRows = [0.15, 0.45, 0.75];
    const guidedCols = [0.3, 0.6, 0.9];
    const clipboard: ParagraphTemplate = {
      colBoundaries: [0.1, 0.5, 0.9],
      headers: ["Key", "Value"],
    };
    useParseFlowStore.setState({
      tableParseRegion: guidedRegion,
      keynoteParseRegion: guidedRegion,
      notesParseStep: "review",
      notesParseRegion: REGION_A,
      guidedParseActive: true,
      guidedParseRegion: guidedRegion,
      guidedParseRows: guidedRows,
      guidedParseCols: guidedCols,
      specParseStep: "review",
      specParseRegion: REGION_B,
      parseDraftRegion: draft("departing-notes-draft"),
      paragraphOverlayActive: true,
      paragraphBatch: [paragraph("departing-notes-batch")],
      paragraphClipboard: clipboard,
    });
    const before = useParseFlowStore.getState().parseOperations;
    const listener = vi.fn();
    const unsubscribe = useParseFlowStore.subscribe(listener);

    try {
      plannedCommand("setSpecsNotesParseTab")("spec-parse");
    } finally {
      unsubscribe();
    }

    const state = useParseFlowStore.getState();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().specsNotesTab).toBe("spec-parse");
    expect(state.notesParseStep).toBe("idle");
    expect(state.notesParseRegion).toBeNull();
    expect(state.specParseStep).toBe("review");
    expect(state.specParseRegion).toBe(REGION_B);
    expect(state.parseDraftRegion).toBeNull();
    expect(state.paragraphOverlayActive).toBe(false);
    expect(state.paragraphBatch).toEqual([]);
    expect(state.paragraphClipboard).toBe(clipboard);

    expect(state.guidedParseActive).toBe(true);
    expect(state.guidedParseRegion).toBe(guidedRegion);
    expect(state.guidedParseRows).toBe(guidedRows);
    expect(state.guidedParseCols).toBe(guidedCols);
    expect(state.tableParseRegion).toBe(guidedRegion);
    expect(state.keynoteParseRegion).toBe(guidedRegion);
    expect(state.parseOperations.table).toBe(before.table);
    expect(state.parseOperations.keynote).toBe(before.keynote);
    expect(state.parseOperations.notes).toEqual({
      revision: before.notes.revision + 1,
      busy: false,
    });
    expect(state.parseOperations.spec).toEqual({
      revision: before.spec.revision + 1,
      busy: false,
    });
  });
});

describe("A2d Index target handoff", () => {
  it.each([
    ["notes", "openNotesParseTarget", "notesParseRegion", "notesParseStep", REGION_A],
    ["notes", "openNotesParseTarget", "notesParseRegion", "notesParseStep", null],
    ["spec", "openSpecParseTarget", "specParseRegion", "specParseStep", REGION_A],
    ["spec", "openSpecParseTarget", "specParseRegion", "specParseStep", null],
  ] as const)("opens a %s target with destination page before one parse seed and no stale tail", (
    kind,
    commandName,
    regionKey,
    stepKey,
    targetRegion,
  ) => {
    const oldPage = 2;
    const targetPage = 7;
    useViewerCoreStore.setState({ pageNumber: oldPage, numPages: 12 });
    useParseFlowStore.setState({
      notesParseStep: "review",
      notesParseRegion: REGION_B,
      specParseStep: "review",
      specParseRegion: REGION_B,
      parseDraftRegion: draft(`${kind}-outgoing`),
      paragraphOverlayActive: true,
      paragraphBatch: [paragraph(`${kind}-outgoing`)],
    });
    const beforeRevision = useParseFlowStore.getState().parseOperations[kind].revision;
    const trace: string[] = [];
    let parsePublications = 0;
    let armed = true;
    let tokenB: ParseOperationToken<typeof kind> | undefined;
    const unsubscribeParse = useParseFlowStore.subscribe((state) => {
      parsePublications += 1;
      if (!armed) return;
      armed = false;
      trace.push("parse-seed");
      expect(useViewerCoreStore.getState().pageNumber).toBe(targetPage);
      expect(state[regionKey]).toBe(targetRegion);
      expect(state[stepKey]).toBe("idle");
      expect(state.parseDraftRegion).toBeNull();
      expect(state.parseOperations[kind]).toEqual({
        revision: beforeRevision + 1,
        busy: false,
      });

      const started = useParseFlowStore.getState().beginParseOperation(kind);
      if (started.status !== "started") throw new Error(`could not admit synchronous ${kind} B`);
      tokenB = started.token;
      useParseFlowStore.setState({
        [regionKey]: REGION_B,
        parseDraftRegion: draft(`${kind}-subscriber-B`),
        paragraphOverlayActive: true,
        paragraphBatch: [paragraph(`${kind}-subscriber-B`)],
      });
    });
    const unsubscribeCore = useViewerCoreStore.subscribe((state, previous) => {
      if (state.pageNumber !== previous.pageNumber) trace.push("page");
    });

    try {
      if (commandName === "openNotesParseTarget") {
        plannedCommand(commandName)(targetPage, targetRegion);
      } else {
        plannedCommand(commandName)(targetPage, targetRegion);
      }
    } finally {
      unsubscribeParse();
      unsubscribeCore();
    }

    expect(trace).toEqual(["page", "parse-seed"]);
    // The target command owns one parse publication. The other two are B's begin + seed inside the
    // synchronous subscriber; any command-side parse tail would add a fourth and erase B.
    expect(parsePublications).toBe(3);
    expect(useViewerCoreStore.getState().pageNumber).toBe(targetPage);
    expect(tokenB).toBeDefined();
    const state = useParseFlowStore.getState();
    expect(state[regionKey]).toBe(REGION_B);
    expect(state.parseDraftRegion?.id).toBe(`${kind}-subscriber-B`);
    expect(state.paragraphBatch[0].id).toBe(`${kind}-subscriber-B`);
    expect(state.parseOperations[kind]).toEqual({
      revision: tokenB!.revision,
      busy: true,
    });
  });
});

describe("A2d derived workspace and teardown reentrancy", () => {
  it.each([
    ["notes", "transitionNotesParserMode"],
    ["spec", "transitionSpecParserMode"],
  ] as const)("moves a %s mode destination and revocation in one publication", (kind, command) => {
    beginAllKinds();
    useParseFlowStore.setState({
      parseDraftRegion: draft(`${kind}-mode`),
      paragraphOverlayActive: true,
      notesFastManualActive: true,
      notesFastManualGrid: { headers: ["Key"], rows: [{ Key: "A" }] },
      guidedParseOwner: "notes",
      guidedParseActive: true,
      guidedParseRegion: REGION_A,
      guidedParseRows: [0.2, 0.8],
      guidedParseCols: [0.1, 0.9],
    });
    const snapshots: ReturnType<typeof useParseFlowStore.getState>[] = [];
    const unsubscribe = useParseFlowStore.subscribe((state) => snapshots.push(state));

    try {
      plannedCommand(command)();
    } finally {
      unsubscribe();
    }

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].parseDraftRegion).toBeNull();
    expect(snapshots[0].paragraphOverlayActive).toBe(false);
    expect(snapshots[0].parseOperations.notes.busy).toBe(false);
    expect(snapshots[0].parseOperations.spec.busy).toBe(false);
    if (kind === "notes") {
      expect(snapshots[0].guidedParseRegion).toBeNull();
      expect(snapshots[0].notesFastManualGrid).toBeNull();
      expect(snapshots[0].parseOperations.table.busy).toBe(false);
      expect(snapshots[0].parseOperations.keynote.busy).toBe(false);
    }
  });

  it("combines each one-shot paragraph mutation with Notes/Spec revocation", () => {
    useParseFlowStore.setState({ paragraphBatch: [paragraph("A")] });

    for (const invoke of [
      () => plannedCommand("upsertParagraphForUser")(paragraph("B")),
      () => plannedCommand("removeParagraphForUser")("A"),
      () => plannedCommand("setParagraphBatchForUser")([paragraph("C")]),
    ]) {
      const notes = useParseFlowStore.getState().beginParseOperation("notes");
      const spec = useParseFlowStore.getState().beginParseOperation("spec");
      if (notes.status !== "started" || spec.status !== "started") {
        throw new Error("could not admit paragraph mutation owners");
      }
      const snapshots: ReturnType<typeof useParseFlowStore.getState>[] = [];
      const unsubscribe = useParseFlowStore.subscribe((state) => snapshots.push(state));
      try {
        invoke();
      } finally {
        unsubscribe();
      }
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].parseOperations.notes.busy).toBe(false);
      expect(snapshots[0].parseOperations.spec.busy).toBe(false);
    }
    expect(useParseFlowStore.getState().paragraphBatch.map((entry) => entry.id)).toEqual(["C"]);
  });

  it("keeps derived overlay gates inside atomic mode transitions, with no passive publisher API", () => {
    expect(viewerCommands).not.toHaveProperty("activateNotesGuidedWorkspace");
    expect(viewerCommands).not.toHaveProperty("syncNotesFastManualWorkspace");
    expect(viewerCommands).not.toHaveProperty("syncParagraphWorkspaceActive");
    expect(viewerCommands).not.toHaveProperty("syncNotesParserModeForLease");
    expect(viewerCommands).not.toHaveProperty("syncSpecParserModeForLease");

    useParseFlowStore.setState({ notesParseRegion: REGION_A });
    const snapshots: ReturnType<typeof useParseFlowStore.getState>[] = [];
    const unsubscribe = useParseFlowStore.subscribe((state) => snapshots.push(state));
    try {
      (plannedCommand("transitionNotesParserMode") as (
        mode: "guided",
        region: ParseRegion,
      ) => ParserWorkspaceLease)("guided", REGION_A);
    } finally {
      unsubscribe();
    }
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      guidedParseActive: true,
      guidedParseRegion: REGION_A,
      notesFastManualActive: false,
      paragraphOverlayActive: false,
    });
  });

  it.each([
    ["notes", true],
    ["notes", false],
    ["spec", true],
    ["spec", false],
  ] as const)("rejects stale %s teardown after same-kind B advances with busy=%s", (
    kind,
    bRemainsBusy,
  ) => {
    const lease = currentWorkspaceLease();
    const started = useParseFlowStore.getState().beginParseOperation(kind);
    if (started.status !== "started") throw new Error(`could not admit ${kind} B`);
    if (!bRemainsBusy) {
      expect(useParseFlowStore.getState().finishParseOperation(started.token)).toBe(true);
    }
    useParseFlowStore.setState({
      [kind === "notes" ? "notesParseRegion" : "specParseRegion"]: REGION_B,
      parseDraftRegion: draft(`${kind}-retry-B`),
      paragraphOverlayActive: true,
      paragraphBatch: [paragraph(`${kind}-retry-B`)],
      ...(kind === "notes"
        ? {
            notesFastManualActive: true,
            notesFastManualGrid: { headers: ["Key"], rows: [{ Key: "B" }] },
          }
        : {}),
    });
    const before = useParseFlowStore.getState();
    const listener = vi.fn();
    const unsubscribe = useParseFlowStore.subscribe(listener);

    let accepted: boolean;
    try {
      accepted = kind === "notes"
        ? plannedCommand("leaveNotesParserWorkspace")(
            lease,
            false,
          )
        : plannedCommand("leaveSpecParserWorkspace")(
            lease,
          );
    } finally {
      unsubscribe();
    }

    expect(accepted!).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(useParseFlowStore.getState()).toBe(before);
    expect(useParseFlowStore.getState().parseOperations[kind]).toEqual({
      revision: started.token.revision,
      busy: bRemainsBusy,
    });
    expect(useParseFlowStore.getState().paragraphBatch[0].id).toBe(`${kind}-retry-B`);
  });

  it.each([
    ["notes"],
    ["spec"],
  ] as const)("accepts the exact current %s teardown lease and cleans once", (
    kind,
  ) => {
    const started = useParseFlowStore.getState().beginParseOperation(kind);
    if (started.status !== "started") throw new Error(`could not admit current ${kind} lease`);
    const lease = currentWorkspaceLease();
    useParseFlowStore.setState({
      [kind === "notes" ? "notesParseRegion" : "specParseRegion"]: REGION_A,
      parseDraftRegion: draft(`${kind}-owned-A`),
      paragraphOverlayActive: true,
      paragraphBatch: [paragraph(`${kind}-owned-A`)],
      ...(kind === "notes"
        ? {
            notesFastManualActive: true,
            notesFastManualGrid: { headers: ["Key"], rows: [{ Key: "A" }] },
          }
        : {}),
    });
    const listener = vi.fn();
    const unsubscribe = useParseFlowStore.subscribe(listener);

    let accepted: boolean;
    try {
      accepted = kind === "notes"
        ? plannedCommand("leaveNotesParserWorkspace")(
            lease,
            false,
          )
        : plannedCommand("leaveSpecParserWorkspace")(
            lease,
          );
    } finally {
      unsubscribe();
    }

    expect(accepted!).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    const state = useParseFlowStore.getState();
    expect(state.parseDraftRegion).toBeNull();
    expect(state.paragraphOverlayActive).toBe(false);
    expect(state.paragraphBatch[0].id).toBe(`${kind}-owned-A`);
    expect(state.parseOperations[kind]).toEqual({
      revision: started.token.revision + 1,
      busy: false,
    });
    if (kind === "notes") {
      expect(state.notesFastManualActive).toBe(false);
      expect(state.notesFastManualGrid).toBeNull();
    }
  });

  it.each([
    ["spec-parse", "notes-parse", "notes", "leaveSpecParserWorkspace"],
    ["notes-parse", "spec-parse", "spec", "leaveNotesParserWorkspace"],
  ] as const)("keeps destination B after coordinated %s -> %s unmount cleanup", (
    currentTab,
    nextTab,
    destinationKind,
    leaveCommand,
  ) => {
    useUiStore.setState({ specsNotesTab: currentTab });
    useParseFlowStore.setState({
      notesParseRegion: REGION_A,
      specParseRegion: REGION_B,
      guidedParseRegion: currentTab === "notes-parse" ? REGION_A : null,
      parseDraftRegion: draft("outgoing"),
      paragraphOverlayActive: true,
      paragraphBatch: [paragraph("outgoing")],
    });
    const lease = currentWorkspaceLease();
    plannedCommand("setSpecsNotesParseTab")(nextTab);

    useParseFlowStore.setState({
      parseDraftRegion: draft("destination-B"),
      paragraphOverlayActive: true,
      paragraphBatch: [paragraph("destination-B")],
    });
    const started = useParseFlowStore.getState().beginParseOperation(destinationKind);
    if (started.status !== "started") throw new Error("could not admit destination B");
    const before = useParseFlowStore.getState();
    const listener = vi.fn();
    const unsubscribe = useParseFlowStore.subscribe(listener);

    try {
      if (leaveCommand === "leaveNotesParserWorkspace") {
        expect(plannedCommand(leaveCommand)(
          lease,
          false,
        )).toBe(false);
      } else {
        expect(plannedCommand(leaveCommand)(
          lease,
        )).toBe(false);
      }
    } finally {
      unsubscribe();
    }

    expect(listener).not.toHaveBeenCalled();
    expect(useParseFlowStore.getState()).toBe(before);
    expect(useParseFlowStore.getState().paragraphBatch[0].id).toBe("destination-B");
    expect(useParseFlowStore.getState().parseOperations[destinationKind]).toEqual({
      revision: started.token.revision,
      busy: true,
    });
  });
});
