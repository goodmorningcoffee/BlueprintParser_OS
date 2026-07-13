// @vitest-environment node
// [refactor jul12 P2.4 A2e freeze-first] Explicit shared-Guided ownership and
// reentrant Table completion authority.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ParseKind, ParseOperationToken } from "@/lib/parse-operation-state";
import { useParseFlowStore, type ParseFlowState } from "@/stores/parseFlowStore";
import { useToolStore } from "@/stores/toolStore";
import { useUiStore } from "@/stores/uiStore";
import * as viewerCommands from "@/stores/viewerCommands";

type GuidedParseOwner = "table" | "keynote" | "notes";
type ParseRegion = [number, number, number, number];
type OperationStatus = "busy" | "settled";
type ParseStateWithGuidedOwner = ParseFlowState & {
  guidedParseOwner: GuidedParseOwner | null;
};

type GuidedLease = Readonly<{
  tableRevision: number;
  keynoteRevision: number;
  notesRevision: number;
  specRevision: number;
  guidedOwner: GuidedParseOwner | null;
}>;

type TableGrid = NonNullable<ParseFlowState["tableParsedGrid"]>;
type TableMeta = NonNullable<ParseFlowState["tableParseMeta"]>;

type PlannedCommands = {
  claimGuidedParseWorkspaceForOperation: <K extends GuidedParseOwner>(
    token: ParseOperationToken<K>,
    region: ParseRegion,
  ) => GuidedLease | null;
  publishGuidedProposalForOperation: <K extends GuidedParseOwner>(
    token: ParseOperationToken<K>,
    rows: number[],
    cols: number[],
  ) => boolean;
  beginGuidedGridEdit: (owner: GuidedParseOwner, expectedRegion: ParseRegion | null) => GuidedLease | null;
  setGuidedParseRowsForLease: (rows: number[], lease: GuidedLease) => boolean;
  setGuidedParseColsForLease: (cols: number[], lease: GuidedLease) => boolean;
  resetGuidedParseWorkspace: (owner: GuidedParseOwner) => boolean;
  publishTableReviewForOperation: (
    token: ParseOperationToken<"table">,
    payload: { grid: TableGrid; meta: TableMeta | null; region?: ParseRegion | null },
  ) => boolean;
  completeTableParseOperation: (
    token: ParseOperationToken<"table">,
    options?: { resetGuided?: boolean; afterTerminal?: () => void },
  ) => boolean;
  completeKeynoteParseOperation: (
    token: ParseOperationToken<"keynote">,
    options?: { resetGuided?: boolean },
  ) => boolean;
};

const REGION_A: ParseRegion = [0.1, 0.2, 0.7, 0.8];
const REGION_B: ParseRegion = [0.2, 0.25, 0.8, 0.85];
const GUIDED_ROWS_A = [0.2, 0.5, 0.8];
const GUIDED_COLS_A = [0.1, 0.4, 0.7];

function restoreStores(): void {
  useParseFlowStore.setState(useParseFlowStore.getInitialState(), true);
  useToolStore.setState(useToolStore.getInitialState(), true);
  useUiStore.setState(useUiStore.getInitialState(), true);
}

function plannedCommand<K extends keyof PlannedCommands>(name: K): PlannedCommands[K] {
  const command = (viewerCommands as unknown as Record<string, unknown>)[name];
  expect(command, `${name} A2e command`).toBeTypeOf("function");
  return command as PlannedCommands[K];
}

function parseState(): ParseStateWithGuidedOwner {
  return useParseFlowStore.getState() as ParseStateWithGuidedOwner;
}

function setParseState(patch: Partial<ParseStateWithGuidedOwner>): void {
  useParseFlowStore.setState(patch as Partial<ParseFlowState>);
}

function startOperation<K extends ParseKind>(kind: K): ParseOperationToken<K> {
  const result = useParseFlowStore.getState().beginParseOperation(kind);
  expect(result.status).toBe("started");
  if (result.status !== "started") throw new Error(`Expected ${kind} operation to start`);
  return result.token;
}

function startB<K extends GuidedParseOwner>(kind: K, status: OperationStatus): ParseOperationToken<K> {
  const token = startOperation(kind);
  if (status === "settled") {
    expect(useParseFlowStore.getState().finishParseOperation(token)).toBe(true);
  }
  return token;
}

function seedGuided(owner: GuidedParseOwner, region: ParseRegion = REGION_A): void {
  setParseState({
    guidedParseOwner: owner,
    guidedParseActive: true,
    guidedParseRegion: region,
    guidedParseRows: GUIDED_ROWS_A,
    guidedParseCols: GUIDED_COLS_A,
  });
}

function expectGuidedExact(before: ParseStateWithGuidedOwner): void {
  const after = parseState();
  expect(after.guidedParseOwner).toBe(before.guidedParseOwner);
  expect(after.guidedParseActive).toBe(before.guidedParseActive);
  expect(after.guidedParseRegion).toBe(before.guidedParseRegion);
  expect(after.guidedParseRows).toBe(before.guidedParseRows);
  expect(after.guidedParseCols).toBe(before.guidedParseCols);
}

beforeEach(() => {
  restoreStores();
});

describe("A2e explicit shared-Guided owner — co-mounted panel close", () => {
  it.each([
    ["Table", "keynote", "busy"],
    ["Table", "keynote", "settled"],
    ["Table", "notes", "busy"],
    ["Table", "notes", "settled"],
    ["Keynote", "table", "busy"],
    ["Keynote", "table", "settled"],
    ["Keynote", "notes", "busy"],
    ["Keynote", "notes", "settled"],
  ] as const)("closing non-owner %s preserves %s Guided B when B is %s", (
    closingPanel,
    owner,
    status,
  ) => {
    const closingKind = closingPanel === "Table" ? "table" : "keynote";
    const panelKey = closingPanel === "Table"
      ? "showTableParsePanel"
      : "showKeynoteParsePanel";
    useUiStore.setState({
      showTableParsePanel: closingPanel === "Table",
      showKeynoteParsePanel: closingPanel === "Keynote",
      showSpecsNotesPanel: true,
      specsNotesTab: owner === "keynote" ? "keynotes" : "notes-parse",
    });
    useToolStore.setState({ mode: "markup" });
    seedGuided(owner);
    const closingToken = startOperation(closingKind);
    const tokenB = startB(owner, status);
    const before = parseState();
    const beforeB = before.parseOperations[owner];
    const beforeTool = useToolStore.getState();
    const trace: string[] = [];
    const unsubscribeUi = useUiStore.subscribe(() => trace.push("ui"));
    const unsubscribeTool = useToolStore.subscribe(() => trace.push("tool"));
    const unsubscribeParse = useParseFlowStore.subscribe(() => trace.push("parse"));

    try {
      if (closingPanel === "Table") viewerCommands.toggleTableParsePanel();
      else viewerCommands.toggleKeynoteParsePanel();
    } finally {
      unsubscribeParse();
      unsubscribeTool();
      unsubscribeUi();
    }

    expect(trace).toEqual(["ui", "parse"]);
    expect(useUiStore.getState()[panelKey]).toBe(false);
    expectGuidedExact(before);
    expect(parseState().parseOperations[closingKind]).toEqual({
      revision: closingToken.revision + 1,
      busy: false,
    });
    expect(parseState().parseOperations[owner]).toBe(beforeB);
    expect(parseState().isParseOperationCurrent(tokenB)).toBe(status === "busy");
    expect(useToolStore.getState()).toBe(beforeTool);
  });

  it.each([
    ["Table", "table"],
    ["Keynote", "keynote"],
  ] as const)("closing owner %s clears only %s Guided ownership and its shared lanes", (
    closingPanel,
    owner,
  ) => {
    useUiStore.setState({
      showTableParsePanel: closingPanel === "Table",
      showKeynoteParsePanel: closingPanel === "Keynote",
    });
    seedGuided(owner);
    const tokens = {
      table: startOperation("table"),
      keynote: startOperation("keynote"),
      notes: startOperation("notes"),
      spec: startOperation("spec"),
    };
    const before = parseState();

    if (closingPanel === "Table") viewerCommands.toggleTableParsePanel();
    else viewerCommands.toggleKeynoteParsePanel();

    const after = parseState();
    expect(after).toMatchObject({
      guidedParseOwner: null,
      guidedParseActive: false,
      guidedParseRegion: null,
      guidedParseRows: [],
      guidedParseCols: [],
    });
    for (const kind of ["table", "keynote", "notes"] as const) {
      expect(after.parseOperations[kind], kind).toEqual({
        revision: tokens[kind].revision + 1,
        busy: false,
      });
    }
    expect(after.parseOperations.spec).toBe(before.parseOperations.spec);
    expect(after.parseOperations.spec).toEqual({ revision: tokens.spec.revision, busy: true });
  });

  it.each([
    ["Table", "table", "keynote", "busy"],
    ["Table", "table", "keynote", "settled"],
    ["Keynote", "keynote", "table", "busy"],
    ["Keynote", "keynote", "table", "settled"],
  ] as const)("closing owner %s cannot move the tool after reentrant %s B becomes %s", (
    closingPanel,
    closingOwner,
    nextOwner,
    status,
  ) => {
    useUiStore.setState({
      showTableParsePanel: closingPanel === "Table",
      showKeynoteParsePanel: closingPanel === "Keynote",
    });
    seedGuided(closingOwner);
    useToolStore.setState({ mode: "pointer" });
    let armed = true;
    let tokenB: ParseOperationToken<typeof nextOwner> | null = null;
    const unsubscribe = useParseFlowStore.subscribe((state, previous) => {
      if (
        !armed || previous.guidedParseOwner !== closingOwner ||
        state.guidedParseOwner !== null
      ) return;
      armed = false;
      tokenB = startB(nextOwner, status);
      seedGuided(nextOwner, REGION_B);
      useToolStore.setState({ mode: "markup" });
    });

    try {
      if (closingPanel === "Table") viewerCommands.toggleTableParsePanel();
      else viewerCommands.toggleKeynoteParsePanel();
    } finally {
      unsubscribe();
    }

    expect(tokenB).not.toBeNull();
    expect(parseState()).toMatchObject({
      guidedParseOwner: nextOwner,
      guidedParseActive: true,
      guidedParseRegion: REGION_B,
    });
    expect(parseState().parseOperations[nextOwner].busy).toBe(status === "busy");
    expect(useToolStore.getState().mode).toBe("markup");
  });
});

describe("A2e explicit shared-Guided owner — geometry-independent family handoff", () => {
  it.each([
    ["notes-parse", "table", "busy"],
    ["notes-parse", "table", "settled"],
    ["keynotes", "table", "busy"],
    ["keynotes", "table", "settled"],
  ] as const)("departing %s preserves same-bbox %s B when B is %s", (
    departingTab,
    owner,
    status,
  ) => {
    useUiStore.setState({ specsNotesTab: departingTab });
    setParseState({
      notesParseRegion: REGION_A,
      keynoteParseRegion: REGION_A,
      specParseRegion: REGION_B,
    });
    seedGuided(owner, REGION_A);
    const tokenB = startB(owner, status);
    const before = parseState();
    const beforeB = before.parseOperations[owner];

    viewerCommands.setSpecsNotesParseTab(
      departingTab === "notes-parse" ? "spec-parse" : "notes-parse",
    );

    expectGuidedExact(before);
    expect(parseState().parseOperations[owner]).toBe(beforeB);
    expect(parseState().isParseOperationCurrent(tokenB)).toBe(status === "busy");
  });

  it.each([
    ["notes-parse", "notes"],
    ["keynotes", "keynote"],
  ] as const)("departing %s clears its explicitly owned Guided workspace even at a different bbox", (
    departingTab,
    owner,
  ) => {
    useUiStore.setState({ specsNotesTab: departingTab });
    setParseState({
      notesParseRegion: REGION_A,
      keynoteParseRegion: REGION_A,
      specParseRegion: REGION_B,
    });
    seedGuided(owner, REGION_B);
    startOperation(owner);

    viewerCommands.setSpecsNotesParseTab(
      departingTab === "notes-parse" ? "spec-parse" : "notes-parse",
    );

    expect(parseState()).toMatchObject({
      guidedParseOwner: null,
      guidedParseActive: false,
      guidedParseRegion: null,
      guidedParseRows: [],
      guidedParseCols: [],
    });
  });
});

describe("A2e Guided owner claim, proposal, edit lease, and teardown", () => {
  it.each(["busy", "settled"] as const)(
    "cannot let a stale Table parse relabel Notes owner B when B is %s",
    (status) => {
      seedGuided("notes", REGION_B);
      const tokenB = startB("notes", status);
      const tokenA = startOperation("table");
      const before = parseState();
      const beforeB = before.parseOperations.notes;

      const lease = viewerCommands.invalidateGuidedParseOperations("table");

      expect(lease.guidedOwner).toBe("notes");
      expectGuidedExact(before);
      expect(parseState().parseOperations.notes).toBe(beforeB);
      expect(parseState().isParseOperationCurrent(tokenB)).toBe(status === "busy");
      expect(parseState().isParseOperationCurrent(tokenA)).toBe(false);
    },
  );

  it.each(["busy", "settled"] as const)(
    "cannot let a stale Notes save relabel Table owner B when B is %s",
    (status) => {
      seedGuided("table", REGION_B);
      const tokenB = startB("table", status);
      const tokenA = startOperation("notes");
      const before = parseState();
      const beforeB = before.parseOperations.table;

      const lease = viewerCommands.invalidateNotesWorkspaceOperations("notes");

      expect(lease.guidedOwner).toBe("table");
      expectGuidedExact(before);
      expect(parseState().parseOperations.table).toBe(beforeB);
      expect(parseState().isParseOperationCurrent(tokenB)).toBe(status === "busy");
      expect(parseState().isParseOperationCurrent(tokenA)).toBe(false);
    },
  );

  it.each(["table", "keynote", "notes"] as const)(
    "%s claims owner + clean region atomically while retaining its token",
    (owner) => {
      const tokens = {
        table: startOperation("table"),
        keynote: startOperation("keynote"),
        notes: startOperation("notes"),
        spec: startOperation("spec"),
      };
      seedGuided(owner === "table" ? "notes" : "table", REGION_B);
      const before = parseState();
      const listener = vi.fn();
      const unsubscribe = useParseFlowStore.subscribe(listener);

      const lease = plannedCommand("claimGuidedParseWorkspaceForOperation")(
        tokens[owner],
        REGION_A,
      );
      unsubscribe();

      expect(lease).not.toBeNull();
      expect(listener).toHaveBeenCalledTimes(1);
      const after = parseState();
      expect(after).toMatchObject({
        guidedParseOwner: owner,
        guidedParseActive: false,
        guidedParseRegion: REGION_A,
        guidedParseRows: [],
        guidedParseCols: [],
      });
      expect(after.parseOperations[owner]).toBe(before.parseOperations[owner]);
      expect(after.isParseOperationCurrent(tokens[owner])).toBe(true);
      for (const peer of ["table", "keynote", "notes"] as const) {
        if (peer === owner) continue;
        expect(after.parseOperations[peer]).toEqual({
          revision: tokens[peer].revision + 1,
          busy: false,
        });
      }
      expect(after.parseOperations.spec).toBe(before.parseOperations.spec);
    },
  );

  it("clears a different owner's grid even when the new claim uses the identical bbox", () => {
    seedGuided("notes", REGION_A);
    const token = startOperation("table");

    expect(plannedCommand("claimGuidedParseWorkspaceForOperation")(
      token,
      REGION_A,
    )).not.toBeNull();

    expect(parseState()).toMatchObject({
      guidedParseOwner: "table",
      guidedParseActive: false,
      guidedParseRows: [],
      guidedParseCols: [],
    });
  });

  it("retains one owner's tuned grid only for its same-owner same-bbox claim", () => {
    seedGuided("table", REGION_A);
    const before = parseState();
    const token = startOperation("table");

    expect(plannedCommand("claimGuidedParseWorkspaceForOperation")(
      token,
      REGION_A,
    )).not.toBeNull();

    expect(parseState().guidedParseOwner).toBe("table");
    expect(parseState().guidedParseRegion).toBe(REGION_A);
    expect(parseState().guidedParseRows).toBe(before.guidedParseRows);
    expect(parseState().guidedParseCols).toBe(before.guidedParseCols);
    expect(parseState().guidedParseActive).toBe(true);
  });

  it("publishes proposal rows, columns, and active in one owner-authorized publication", () => {
    const token = startOperation("table");
    expect(plannedCommand("claimGuidedParseWorkspaceForOperation")(token, REGION_A)).not.toBeNull();
    const rows = [0.2, 0.45, 0.8];
    const cols = [0.1, 0.35, 0.7];
    const listener = vi.fn();
    const unsubscribe = useParseFlowStore.subscribe(listener);

    expect(plannedCommand("publishGuidedProposalForOperation")(token, rows, cols)).toBe(true);
    unsubscribe();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(parseState()).toMatchObject({
      guidedParseOwner: "table",
      guidedParseActive: true,
      guidedParseRows: rows,
      guidedParseCols: cols,
    });
  });

  it.each(["busy", "settled"] as const)(
    "rejects a stale edit lease after same-turn owner B becomes %s",
    (status) => {
      const tokenA = startOperation("table");
      expect(plannedCommand("claimGuidedParseWorkspaceForOperation")(tokenA, REGION_A)).not.toBeNull();
      expect(plannedCommand("publishGuidedProposalForOperation")(
        tokenA,
        GUIDED_ROWS_A,
        GUIDED_COLS_A,
      )).toBe(true);
      // A proposal is settled before the direct user edit begins.
      expect(useParseFlowStore.getState().finishParseOperation(tokenA)).toBe(true);
      const renderedRegion = parseState().guidedParseRegion;

      let tokenB: ParseOperationToken<"notes"> | null = null;
      let armed = true;
      const unsubscribe = useParseFlowStore.subscribe((state, previous) => {
        if (!armed || state.parseOperations === previous.parseOperations) return;
        armed = false;
        tokenB = startOperation("notes");
        expect(plannedCommand("claimGuidedParseWorkspaceForOperation")(tokenB, REGION_B)).not.toBeNull();
        expect(plannedCommand("publishGuidedProposalForOperation")(
          tokenB,
          [0.25, 0.55, 0.85],
          [0.2, 0.5, 0.8],
        )).toBe(true);
        if (status === "settled") {
          expect(useParseFlowStore.getState().finishParseOperation(tokenB)).toBe(true);
        }
      });

      const lease = plannedCommand("beginGuidedGridEdit")("table", renderedRegion);
      expect(lease).toBeNull();
      const beforeWrite = parseState();
      unsubscribe();

      expect(tokenB).not.toBeNull();
      expectGuidedExact(beforeWrite);
      expect(parseState().parseOperations.notes).toBe(beforeWrite.parseOperations.notes);
    },
  );

  it("refuses a stale owner-bound edit before invalidating the peer generation", () => {
    seedGuided("notes", REGION_B);
    const tokenB = startOperation("notes");
    const before = parseState();
    const listener = vi.fn();
    const unsubscribe = useParseFlowStore.subscribe(listener);

    try {
      expect(plannedCommand("beginGuidedGridEdit")("table", REGION_A)).toBeNull();
    } finally {
      unsubscribe();
    }

    expect(listener).not.toHaveBeenCalled();
    expect(parseState()).toBe(before);
    expect(parseState().isParseOperationCurrent(tokenB)).toBe(true);
  });

  it.each(["busy", "settled"] as const)(
    "refuses a stale same-owner render before invalidating Table B when B is %s",
    (status) => {
      seedGuided("table", REGION_A);
      const renderedRegion = parseState().guidedParseRegion;
      const tokenB = startB("table", status);
      setParseState({ guidedParseRegion: [...REGION_A] as ParseRegion });
      const before = parseState();
      const listener = vi.fn();
      const unsubscribe = useParseFlowStore.subscribe(listener);

      try {
        expect(plannedCommand("beginGuidedGridEdit")(
          "table",
          renderedRegion,
        )).toBeNull();
      } finally {
        unsubscribe();
      }

      expect(listener).not.toHaveBeenCalled();
      expect(parseState()).toBe(before);
      expect(parseState().isParseOperationCurrent(tokenB)).toBe(status === "busy");
    },
  );

  it("lets the matching rendered owner cancel its still-busy proposal into an edit lease", () => {
    seedGuided("table", REGION_A);
    const token = startOperation("table");

    const lease = plannedCommand("beginGuidedGridEdit")("table", parseState().guidedParseRegion);

    expect(lease).not.toBeNull();
    if (!lease) throw new Error("Expected current Table edit lease");
    expect(parseState().parseOperations.table).toEqual({
      revision: token.revision + 1,
      busy: false,
    });
    expect(plannedCommand("setGuidedParseRowsForLease")(
      [0.15, 0.45, 0.85],
      lease,
    )).toBe(true);
  });

  it.each([
    ["rows", "table", "busy"],
    ["rows", "table", "settled"],
    ["rows", "keynote", "busy"],
    ["rows", "keynote", "settled"],
    ["rows", "notes", "busy"],
    ["rows", "notes", "settled"],
    ["cols", "table", "busy"],
    ["cols", "table", "settled"],
    ["cols", "keynote", "busy"],
    ["cols", "keynote", "settled"],
    ["cols", "notes", "busy"],
    ["cols", "notes", "settled"],
  ] as const)(
    "rejects a once-valid %s lease after %s B becomes %s without publishing",
    (axis, nextOwner, status) => {
      seedGuided("table", REGION_A);
      const lease = plannedCommand("beginGuidedGridEdit")("table", parseState().guidedParseRegion);
      expect(lease).not.toBeNull();
      if (!lease) throw new Error("Expected current Table edit lease");

      const tokenB = startB(nextOwner, status);
      const before = parseState();
      const beforeOperations = before.parseOperations;
      const listener = vi.fn();
      const unsubscribe = useParseFlowStore.subscribe(listener);

      const committed = axis === "rows"
        ? plannedCommand("setGuidedParseRowsForLease")([0.25, 0.6, 0.9], lease)
        : plannedCommand("setGuidedParseColsForLease")([0.15, 0.5, 0.85], lease);
      unsubscribe();

      expect(committed).toBe(false);
      expect(listener).not.toHaveBeenCalled();
      expect(parseState()).toBe(before);
      expect(parseState().parseOperations).toBe(beforeOperations);
      expectGuidedExact(before);
      expect(parseState().isParseOperationCurrent(tokenB)).toBe(status === "busy");
    },
  );

  it("rejects forged non-Guided operation kinds without reading or mutating a lane", () => {
    const specToken = startOperation("spec");
    const before = parseState();
    const forgedSpec = specToken as unknown as ParseOperationToken<"table">;
    const forgedUnknown = { kind: "bogus", revision: 1 } as unknown as ParseOperationToken<"table">;
    const claim = plannedCommand("claimGuidedParseWorkspaceForOperation");
    const publish = plannedCommand("publishGuidedProposalForOperation");
    const reset = plannedCommand("resetGuidedParseWorkspace");

    expect(claim(forgedSpec, REGION_A)).toBeNull();
    expect(claim(forgedUnknown, REGION_A)).toBeNull();
    expect(publish(forgedSpec, GUIDED_ROWS_A, GUIDED_COLS_A)).toBe(false);
    expect(publish(forgedUnknown, GUIDED_ROWS_A, GUIDED_COLS_A)).toBe(false);
    expect(reset("spec" as unknown as GuidedParseOwner)).toBe(false);
    expect(parseState()).toBe(before);
  });

  it("denies non-owner Guided reset while retiring its own lane, then lets the owner clear", () => {
    const token = startOperation("table");
    expect(plannedCommand("claimGuidedParseWorkspaceForOperation")(token, REGION_A)).not.toBeNull();
    expect(plannedCommand("publishGuidedProposalForOperation")(
      token,
      GUIDED_ROWS_A,
      GUIDED_COLS_A,
    )).toBe(true);
    const before = parseState();
    const beforeNotes = before.parseOperations.notes;
    const listener = vi.fn();
    const unsubscribe = useParseFlowStore.subscribe(listener);

    expect(plannedCommand("resetGuidedParseWorkspace")("notes")).toBe(false);
    expectGuidedExact(before);
    expect(parseState().parseOperations.notes).toEqual({
      revision: beforeNotes.revision + 1,
      busy: false,
    });
    expect(listener).toHaveBeenCalledTimes(1);

    expect(plannedCommand("resetGuidedParseWorkspace")("table")).toBe(true);
    unsubscribe();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(parseState()).toMatchObject({
      guidedParseOwner: null,
      guidedParseActive: false,
      guidedParseRegion: null,
      guidedParseRows: [],
      guidedParseCols: [],
    });
  });
});

function grid(label: string): TableGrid {
  return { headers: ["Tag"], rows: [{ Tag: label }], tableName: label };
}

function meta(label: string): TableMeta {
  return {
    baseMethod: label,
    mergedSnapshot: { headers: ["Tag"], rows: [{ Tag: label }] },
    methodResults: [],
  };
}

describe("A2e atomic Table review and terminal completion", () => {
  it.each(["busy", "settled"] as const)(
    "returns denial and keeps reentrant Table B's complete review when B becomes %s",
    (status) => {
      const publishReview = plannedCommand("publishTableReviewForOperation");
      const tokenA = startOperation("table");
      useToolStore.setState({ mode: "pointer" });
      let tokenB: ParseOperationToken<"table"> | null = null;
      let armed = true;
      const gridB = grid("B");
      const metaB = meta("B");
      const unsubscribe = useParseFlowStore.subscribe((state, previous) => {
        if (!armed || state.tableParsedGrid === previous.tableParsedGrid) return;
        armed = false;
        const started = state.beginParseOperation("table", "supersede");
        expect(started.status).toBe("started");
        if (started.status !== "started") return;
        tokenB = started.token;
        setParseState({
          tableParsedGrid: gridB,
          tableParseMeta: metaB,
          tableParseRegion: REGION_B,
          tableParseStep: "review",
        });
        useToolStore.setState({ mode: "markup" });
        if (status === "settled") {
          expect(useParseFlowStore.getState().finishParseOperation(tokenB)).toBe(true);
        }
      });

      try {
        expect(publishReview(tokenA, {
          grid: grid("A"),
          meta: meta("A"),
          region: REGION_A,
        })).toBe(false);
      } finally {
        unsubscribe();
      }

      expect(tokenB).not.toBeNull();
      expect(parseState()).toMatchObject({
        tableParsedGrid: gridB,
        tableParseMeta: metaB,
        tableParseRegion: REGION_B,
        tableParseStep: "review",
      });
      expect(parseState().parseOperations.table.busy).toBe(status === "busy");
      expect(useToolStore.getState().mode).toBe("markup");
    },
  );

  it.each(["busy", "settled"] as const)(
    "leaves terminal reset as A's final publication so reentrant B survives %s",
    (status) => {
      const completeTable = plannedCommand("completeTableParseOperation");
      setParseState({
        tableParseStep: "review",
        tableParseRegion: REGION_A,
        tableParsedGrid: grid("A"),
        tableParseMeta: meta("A"),
      });
      const tokenA = startOperation("table");
      useToolStore.setState({ mode: "pointer" });
      let tokenB: ParseOperationToken<"table"> | null = null;
      const afterTerminal = vi.fn();
      let armed = true;
      const gridB = grid("B");
      const metaB = meta("B");
      const unsubscribe = useParseFlowStore.subscribe((state, previous) => {
        if (
          !armed ||
          state.parseOperations.table.revision === previous.parseOperations.table.revision
        ) return;
        armed = false;
        tokenB = startOperation("table");
        setParseState({
          tableParseStep: "review",
          tableParseRegion: REGION_B,
          tableParsedGrid: gridB,
          tableParseMeta: metaB,
        });
        useToolStore.setState({ mode: "markup" });
        if (status === "settled") {
          expect(useParseFlowStore.getState().finishParseOperation(tokenB)).toBe(true);
        }
      });

      try {
        expect(completeTable(tokenA, { afterTerminal })).toBe(true);
      } finally {
        unsubscribe();
      }

      expect(tokenB).not.toBeNull();
      expect(parseState()).toMatchObject({
        tableParseStep: "review",
        tableParseRegion: REGION_B,
        tableParsedGrid: gridB,
        tableParseMeta: metaB,
      });
      expect(parseState().parseOperations.table.busy).toBe(status === "busy");
      expect(useToolStore.getState().mode).toBe("markup");
      expect(afterTerminal).not.toHaveBeenCalled();
    },
  );

  it("runs terminal-local bookkeeping only after the untouched terminal registry", () => {
    const completeTable = plannedCommand("completeTableParseOperation");
    const token = startOperation("table");
    const trace: string[] = [];
    const unsubscribe = useParseFlowStore.subscribe(() => trace.push("parse"));

    try {
      expect(completeTable(token, {
        afterTerminal: () => trace.push("local"),
      })).toBe(true);
    } finally {
      unsubscribe();
    }

    expect(trace).toEqual(["parse", "local"]);
  });

  it.each(["busy", "settled"] as const)(
    "allows Table terminal bookkeeping when independent Spec B becomes %s",
    (status) => {
      seedGuided("table");
      const tokenA = startOperation("table");
      const afterTerminal = vi.fn();
      let tokenB: ParseOperationToken<"spec"> | null = null;
      let armed = true;
      const unsubscribe = useParseFlowStore.subscribe((state, previous) => {
        if (!armed || state.parseOperations.table === previous.parseOperations.table) return;
        armed = false;
        tokenB = startOperation("spec");
        if (status === "settled") {
          expect(useParseFlowStore.getState().finishParseOperation(tokenB)).toBe(true);
        }
      });

      try {
        expect(plannedCommand("completeTableParseOperation")(tokenA, {
          resetGuided: true,
          afterTerminal,
        })).toBe(true);
      } finally {
        unsubscribe();
      }

      expect(tokenB).not.toBeNull();
      expect(parseState().parseOperations.spec).toEqual({
        revision: tokenB!.revision,
        busy: status === "busy",
      });
      expect(afterTerminal).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["table", "keynote", "busy"],
    ["table", "keynote", "settled"],
    ["keynote", "table", "busy"],
    ["keynote", "table", "settled"],
  ] as const)("denies %s Guided terminal reset when tool preparation admits %s B (%s)", (
    owner,
    peer,
    status,
  ) => {
    seedGuided(owner);
    const tokenA = startOperation(owner);
    useToolStore.setState({ mode: "pointer" });
    let tokenB: ParseOperationToken<typeof peer> | null = null;
    let armed = true;
    const unsubscribe = useToolStore.subscribe((state, previous) => {
      if (!armed || state.mode === previous.mode) return;
      armed = false;
      tokenB = startB(peer, status);
      useToolStore.setState({ mode: "markup" });
    });

    let completed: boolean;
    try {
      completed = owner === "table"
        ? plannedCommand("completeTableParseOperation")(
            tokenA as ParseOperationToken<"table">,
            { resetGuided: true },
          )
        : plannedCommand("completeKeynoteParseOperation")(
            tokenA as ParseOperationToken<"keynote">,
            { resetGuided: true },
          );
    } finally {
      unsubscribe();
    }

    expect(completed!).toBe(false);
    expect(tokenB).not.toBeNull();
    expect(parseState().guidedParseOwner).toBe(owner);
    expect(parseState().parseOperations[peer].busy).toBe(status === "busy");
    expect(useToolStore.getState().mode).toBe("markup");
  });
});
