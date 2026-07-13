// @vitest-environment node
// [refactor jul12 P2.4 A2a] Operation authority at the neutral viewer-command boundary.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  PARSE_KINDS,
  type ParseKind,
  type ParseOperationToken,
} from "@/lib/parse-operation-state";
import { useParseFlowStore } from "@/stores/parseFlowStore";
import { useToolStore } from "@/stores/toolStore";
import { useUiStore } from "@/stores/uiStore";
import {
  acceptKeynoteParseRegion,
  addKeynoteColumnForUser,
  addKeynoteRowForUser,
  addTableParseColumnForUser,
  addTableParseRowForUser,
  clearTableCellStructureForUser,
  completeKeynoteParseOperation,
  completeTableParseOperation,
  invalidateGuidedParseOperations,
  invalidateKeynoteTableOperations,
  publishTableReviewForOperation,
  resetKeynoteGuidedParse,
  resetTableParseWorkspace,
  restartTableParseFromCurrentRegion,
  setKeynoteParseStepWithTool,
  setKeynoteManualInputsForUser,
  setNotesParseStepWithTool,
  setSpecParseStepWithTool,
  setTableParseStepForOperation,
  setTableParseStepWithTool,
  setTableManualGeometryForUser,
  setTableParsedGridForUser,
  resetAllTools,
  setKeynoteParseStep,
  setNotesParseStep,
  setSpecParseStep,
  setTableParseStep,
  toggleKeynoteParsePanel,
  toggleTableParsePanel,
} from "@/stores/viewerCommands";

type ParseState = ReturnType<typeof useParseFlowStore.getState>;

const STEP_CASES = [
  {
    kind: "table",
    stepKey: "tableParseStep",
    activeStep: "review",
    command: setTableParseStep,
  },
  {
    kind: "keynote",
    stepKey: "keynoteParseStep",
    activeStep: "review",
    command: setKeynoteParseStep,
  },
  {
    kind: "notes",
    stepKey: "notesParseStep",
    activeStep: "review",
    command: setNotesParseStep,
  },
  {
    kind: "spec",
    stepKey: "specParseStep",
    activeStep: "review",
    command: setSpecParseStep,
  },
] as const;

const STEP_WITH_TOOL_CASES = [
  {
    kind: "table",
    stepKey: "tableParseStep",
    activeStep: "select-region",
    command: setTableParseStepWithTool,
  },
  {
    kind: "keynote",
    stepKey: "keynoteParseStep",
    activeStep: "select-region",
    command: setKeynoteParseStepWithTool,
  },
  {
    kind: "notes",
    stepKey: "notesParseStep",
    activeStep: "select-region",
    command: setNotesParseStepWithTool,
  },
  {
    kind: "spec",
    stepKey: "specParseStep",
    activeStep: "select-region",
    command: setSpecParseStepWithTool,
  },
] as const;

function restoreStores(): void {
  useParseFlowStore.setState(useParseFlowStore.getInitialState(), true);
  useToolStore.setState(useToolStore.getInitialState(), true);
  useUiStore.setState(useUiStore.getInitialState(), true);
}

function startOperation<K extends ParseKind>(kind: K): ParseOperationToken<K> {
  const result = useParseFlowStore.getState().beginParseOperation(kind);
  expect(result.status).toBe("started");
  if (result.status !== "started") throw new Error(`Expected ${kind} operation to start`);
  return result.token;
}

function invokeStep(command: (step: never) => void, step: string): void {
  (command as (next: string) => void)(step);
}

function invokeStepWithTool(
  command: (step: never, toolMode: never) => void,
  step: string,
  toolMode: "move" | "pointer",
): void {
  (command as (next: string, mode: "move" | "pointer") => void)(step, toolMode);
}

function expectOtherStatusIdentities(
  kind: ParseKind,
  before: ParseState["parseOperations"],
  after: ParseState["parseOperations"],
): void {
  for (const other of PARSE_KINDS) {
    if (other !== kind) expect(after[other], `${other} status identity`).toBe(before[other]);
  }
}

beforeEach(() => {
  restoreStores();
});

describe("A2c shared Guided operation boundary", () => {
  it("invalidates Table and Notes in one publication while retaining the admitted Keynote owner", () => {
    const tokens = {
      table: startOperation("table"),
      keynote: startOperation("keynote"),
      notes: startOperation("notes"),
      spec: startOperation("spec"),
    };
    useParseFlowStore.setState({ guidedParseOwner: "keynote" });
    const before = useParseFlowStore.getState().parseOperations;
    const listener = vi.fn();
    const unsubscribe = useParseFlowStore.subscribe(listener);

    invalidateGuidedParseOperations("keynote");

    const after = useParseFlowStore.getState().parseOperations;
    expect(listener).toHaveBeenCalledTimes(1);
    expect(after.keynote).toBe(before.keynote);
    expect(after.keynote).toEqual({ revision: tokens.keynote.revision, busy: true });
    expect(after.table).toEqual({ revision: tokens.table.revision + 1, busy: false });
    expect(after.notes).toEqual({ revision: tokens.notes.revision + 1, busy: false });
    expect(after.spec).toBe(before.spec);
    expect(after.spec).toEqual({ revision: tokens.spec.revision, busy: true });
    unsubscribe();
  });

  it("invalidates all three shared owners, but never Spec, for a direct grid edit", () => {
    const tokens = {
      table: startOperation("table"),
      keynote: startOperation("keynote"),
      notes: startOperation("notes"),
      spec: startOperation("spec"),
    };
    const beforeSpec = useParseFlowStore.getState().parseOperations.spec;
    const listener = vi.fn();
    const unsubscribe = useParseFlowStore.subscribe(listener);

    invalidateGuidedParseOperations();

    const after = useParseFlowStore.getState().parseOperations;
    expect(listener).toHaveBeenCalledTimes(1);
    for (const kind of ["table", "keynote", "notes"] as const) {
      expect(after[kind]).toEqual({ revision: tokens[kind].revision + 1, busy: false });
    }
    expect(after.spec).toBe(beforeSpec);
    unsubscribe();
  });

  it("revokes a Keynote-to-Table handoff in one publication while retaining peer identities", () => {
    const tokens = {
      table: startOperation("table"),
      keynote: startOperation("keynote"),
      notes: startOperation("notes"),
      spec: startOperation("spec"),
    };
    const before = useParseFlowStore.getState().parseOperations;
    const listener = vi.fn();
    const unsubscribe = useParseFlowStore.subscribe(listener);

    invalidateKeynoteTableOperations();

    const after = useParseFlowStore.getState().parseOperations;
    expect(listener).toHaveBeenCalledTimes(1);
    expect(after.table).toEqual({ revision: tokens.table.revision + 1, busy: false });
    expect(after.keynote).toEqual({ revision: tokens.keynote.revision + 1, busy: false });
    expect(after.notes).toBe(before.notes);
    expect(after.spec).toBe(before.spec);
    unsubscribe();
  });

  it("accepts a Keynote canvas region and revokes its owner in one atomic publication", () => {
    useParseFlowStore.setState({ keynoteParseStep: "select-region" });
    const token = startOperation("keynote");
    const before = useParseFlowStore.getState().parseOperations;
    const listener = vi.fn();
    const unsubscribe = useParseFlowStore.subscribe(listener);

    acceptKeynoteParseRegion([0.1, 0.2, 0.8, 0.9]);

    const after = useParseFlowStore.getState();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(after.keynoteParseRegion).toEqual([0.1, 0.2, 0.8, 0.9]);
    expect(after.keynoteParseStep).toBe("idle");
    expect(after.parseOperations.keynote).toEqual({
      revision: token.revision + 1,
      busy: false,
    });
    expectOtherStatusIdentities("keynote", before, after.parseOperations);
    unsubscribe();
  });

  it("resets Keynote and its shared Guided workspace in one publication", () => {
    const tokens = {
      table: startOperation("table"),
      keynote: startOperation("keynote"),
      notes: startOperation("notes"),
      spec: startOperation("spec"),
    };
    useParseFlowStore.setState({
      keynoteParseStep: "review",
      keynoteParseRegion: [0.1, 0.2, 0.8, 0.9],
      keynoteColumnBBs: [[0.1, 0.2, 0.4, 0.9]],
      keynoteRowBBs: [[0.1, 0.2, 0.8, 0.4]],
      keynoteYoloClass: { model: "fixture", className: "door" },
      guidedParseOwner: "keynote",
      guidedParseActive: true,
      guidedParseRegion: [0.1, 0.2, 0.8, 0.9],
      guidedParseRows: [0.2, 0.9],
      guidedParseCols: [0.1, 0.8],
    });
    const beforeSpec = useParseFlowStore.getState().parseOperations.spec;
    const listener = vi.fn();
    const unsubscribe = useParseFlowStore.subscribe(listener);

    resetKeynoteGuidedParse();

    const after = useParseFlowStore.getState();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(after).toMatchObject({
      keynoteParseStep: "idle",
      keynoteParseRegion: null,
      keynoteColumnBBs: [],
      keynoteRowBBs: [],
      keynoteYoloClass: null,
      guidedParseActive: false,
      guidedParseRegion: null,
      guidedParseRows: [],
      guidedParseCols: [],
    });
    for (const kind of ["table", "keynote", "notes"] as const) {
      expect(after.parseOperations[kind]).toEqual({
        revision: tokens[kind].revision + 1,
        busy: false,
      });
    }
    expect(after.parseOperations.spec).toBe(beforeSpec);
    expect(after.parseOperations.spec).toEqual({ revision: tokens.spec.revision, busy: true });
    unsubscribe();
  });
});

describe("A2c token-authorized Keynote completion boundary", () => {
  it("moves the tool first and leaves the terminal Keynote reset as A's final publication", () => {
    useToolStore.setState({ mode: "markup", bucketFillActive: true });
    useParseFlowStore.setState({
      keynoteParseStep: "review",
      keynoteParseRegion: [0.1, 0.2, 0.8, 0.9],
      keynoteColumnBBs: [[0.1, 0.2, 0.4, 0.9]],
    });
    const token = startOperation("keynote");
    const trace: string[] = [];
    const unsubscribeTool = useToolStore.subscribe(() => trace.push("tool"));
    const unsubscribeParse = useParseFlowStore.subscribe(() => trace.push("parse"));

    expect(completeKeynoteParseOperation(token)).toBe(true);

    expect(trace).toEqual(["tool", "parse"]);
    expect(useParseFlowStore.getState()).toMatchObject({
      keynoteParseStep: "idle",
      keynoteParseRegion: null,
      keynoteColumnBBs: [],
      parseOperations: {
        keynote: { revision: token.revision + 1, busy: false },
      },
    });
    expect(useToolStore.getState()).toMatchObject({ mode: "move", bucketFillActive: false });
    unsubscribeParse();
    unsubscribeTool();
  });

  it("stops before reset when a synchronous tool subscriber revokes A", () => {
    useToolStore.setState({ mode: "markup", bucketFillActive: true });
    useParseFlowStore.setState({ keynoteParseRegion: [0.1, 0.2, 0.8, 0.9] });
    const token = startOperation("keynote");
    const unsubscribeTool = useToolStore.subscribe(() => {
      useParseFlowStore.getState().invalidateParseOperation("keynote");
      useParseFlowStore.setState({ keynoteParseRegion: [0.2, 0.3, 0.9, 0.95] });
    });

    expect(completeKeynoteParseOperation(token)).toBe(false);

    expect(useParseFlowStore.getState().keynoteParseRegion).toEqual([0.2, 0.3, 0.9, 0.95]);
    expect(useParseFlowStore.getState().parseOperations.keynote).toEqual({
      revision: token.revision + 1,
      busy: false,
    });
    unsubscribeTool();
  });

  it("leaves the atomic terminal reset as its final publication when a subscriber starts B", () => {
    useToolStore.setState({ mode: "markup" });
    useParseFlowStore.setState({
      keynoteParseRegion: [0.1, 0.2, 0.8, 0.9],
      guidedParseOwner: "keynote",
      guidedParseActive: true,
      guidedParseRows: [0.2, 0.9],
      guidedParseCols: [0.1, 0.8],
    });
    const token = startOperation("keynote");
    let armed = true;
    const unsubscribeParse = useParseFlowStore.subscribe((state, previous) => {
      if (!armed || previous.guidedParseActive === state.guidedParseActive || state.guidedParseActive) {
        return;
      }
      armed = false;
      state.invalidateParseOperation("keynote");
      useParseFlowStore.setState({ keynoteParseRegion: [0.2, 0.3, 0.9, 0.95] });
      startOperation("keynote");
    });

    expect(completeKeynoteParseOperation(token, { resetGuided: true })).toBe(true);

    expect(useParseFlowStore.getState().keynoteParseRegion).toEqual([0.2, 0.3, 0.9, 0.95]);
    expect(useParseFlowStore.getState().parseOperations.keynote.busy).toBe(true);
    unsubscribeParse();
  });
});

describe("A2e token command runtime discrimination", () => {
  const fixtures: ReadonlyArray<{
    name: string;
    target: "table" | "keynote";
    invoke: (token: ParseOperationToken) => boolean;
  }> = [
    {
      name: "Table review publication",
      target: "table",
      invoke: (token) => publishTableReviewForOperation(
        token as ParseOperationToken<"table">,
        {
          grid: { headers: ["Tag"], rows: [{ Tag: "A" }] },
          meta: null,
          region: [0.1, 0.2, 0.8, 0.9],
        },
      ),
    },
    {
      name: "Table completion",
      target: "table",
      invoke: (token) => completeTableParseOperation(token as ParseOperationToken<"table">),
    },
    {
      name: "Keynote completion",
      target: "keynote",
      invoke: (token) => completeKeynoteParseOperation(token as ParseOperationToken<"keynote">),
    },
  ];

  for (const fixture of fixtures) {
    for (const wrongKind of PARSE_KINDS.filter((kind) => kind !== fixture.target)) {
      it(`${fixture.name}: denies a cast ${wrongKind} token with a matching revision and zero publications`, () => {
        const targetToken = startOperation(fixture.target);
        useToolStore.setState({ mode: "markup", bucketFillActive: true });
        const wrongToken = {
          kind: wrongKind,
          revision: targetToken.revision,
        } as ParseOperationToken;
        const beforeParse = useParseFlowStore.getState();
        const beforeTool = useToolStore.getState();
        const parseListener = vi.fn();
        const toolListener = vi.fn();
        const unsubscribeParse = useParseFlowStore.subscribe(parseListener);
        const unsubscribeTool = useToolStore.subscribe(toolListener);

        expect(fixture.invoke(wrongToken)).toBe(false);

        expect(useParseFlowStore.getState()).toBe(beforeParse);
        expect(useToolStore.getState()).toBe(beforeTool);
        expect(parseListener).not.toHaveBeenCalled();
        expect(toolListener).not.toHaveBeenCalled();
        unsubscribeTool();
        unsubscribeParse();
      });
    }
  }
});

describe("A2e completion tool-first same-family admission", () => {
  const fixtures = [
    {
      kind: "table" as const,
      command: (token: ParseOperationToken<"table">) => completeTableParseOperation(token),
      seed: () => useParseFlowStore.setState({
        tableParseStep: "review",
        tableParseRegion: [0.1, 0.2, 0.8, 0.9],
        tableParsedGrid: { headers: ["Tag"], rows: [{ Tag: "A" }] },
      }),
      publishB: () => useParseFlowStore.setState({
        tableParseRegion: [0.2, 0.3, 0.9, 0.95],
      }),
      readRegion: () => useParseFlowStore.getState().tableParseRegion,
    },
    {
      kind: "keynote" as const,
      command: (token: ParseOperationToken<"keynote">) => completeKeynoteParseOperation(token),
      seed: () => useParseFlowStore.setState({
        keynoteParseStep: "review",
        keynoteParseRegion: [0.1, 0.2, 0.8, 0.9],
        keynoteColumnBBs: [[0.1, 0.2, 0.4, 0.9]],
      }),
      publishB: () => useParseFlowStore.setState({
        keynoteParseRegion: [0.2, 0.3, 0.9, 0.95],
      }),
      readRegion: () => useParseFlowStore.getState().keynoteParseRegion,
    },
  ] as const;

  for (const fixture of fixtures) {
    for (const settles of [false, true]) {
      it(`${fixture.kind}: tool subscriber admits ${settles ? "settled" : "busy"} B and A stops before its reset`, () => {
        fixture.seed();
        useToolStore.setState({ mode: "markup", bucketFillActive: true });
        const token = startOperation(fixture.kind);
        let armed = true;
        const unsubscribeTool = useToolStore.subscribe(() => {
          if (!armed) return;
          armed = false;
          const parse = useParseFlowStore.getState();
          parse.invalidateParseOperation(fixture.kind);
          const result = useParseFlowStore.getState().beginParseOperation(fixture.kind);
          expect(result.status).toBe("started");
          if (result.status !== "started") return;
          fixture.publishB();
          if (settles) useParseFlowStore.getState().finishParseOperation(result.token);
          useToolStore.getState().setMode("markup");
        });

        expect(fixture.command(token as never)).toBe(false);

        expect(armed).toBe(false);
        expect(fixture.readRegion()).toEqual([0.2, 0.3, 0.9, 0.95]);
        expect(useParseFlowStore.getState().parseOperations[fixture.kind]).toEqual({
          revision: token.revision + 2,
          busy: !settles,
        });
        expect(useToolStore.getState().mode).toBe("markup");
        unsubscribeTool();
      });
    }
  }
});

describe("A2a neutral parse-step operation boundaries", () => {
  for (const fixture of STEP_CASES) {
    it(`${fixture.kind}: idle -> any active step stays tool-first and invalidates in one parse publication`, () => {
      useToolStore.setState({
        mode: "markup",
        bucketFillActive: true,
        bucketFillPreview: { vertices: [{ x: 0.1, y: 0.2 }], method: "fixture" },
        bucketFillLoading: true,
        bucketFillBarrierMode: true,
        splitAreaActive: true,
        symbolSearchActive: true,
      });
      const token = startOperation(fixture.kind);
      const beforeOperations = useParseFlowStore.getState().parseOperations;
      const trace: string[] = [];
      const parseSnapshots: ParseState[] = [];
      const unsubscribeTool = useToolStore.subscribe(() => trace.push("tool"));
      const unsubscribeParse = useParseFlowStore.subscribe((state) => {
        trace.push("parse");
        parseSnapshots.push(state);
      });

      // `review` is intentionally used here: the generic command treats every idle -> active target
      // as user entry. A2b must use a token-authorized seam for async-owned idle -> review.
      invokeStep(fixture.command as (step: never) => void, fixture.activeStep);

      expect(trace).toEqual(["tool", "parse"]);
      expect(parseSnapshots).toHaveLength(1);
      const after = useParseFlowStore.getState();
      expect(after[fixture.stepKey]).toBe(fixture.activeStep);
      expect(after.parseOperations[fixture.kind]).toEqual({
        revision: token.revision + 1,
        busy: false,
      });
      expectOtherStatusIdentities(fixture.kind, beforeOperations, after.parseOperations);
      expect(useToolStore.getState()).toMatchObject({
        mode: "move",
        bucketFillActive: false,
        bucketFillPreview: null,
        bucketFillLoading: false,
        bucketFillBarrierMode: false,
        splitAreaActive: false,
        symbolSearchActive: false,
      });
      unsubscribeParse();
      unsubscribeTool();
    });

    it(`${fixture.kind}: active -> idle cancel invalidates once without a tool publication`, () => {
      useParseFlowStore.setState({
        [fixture.stepKey]: fixture.activeStep,
      } as Partial<ParseState>);
      const token = startOperation(fixture.kind);
      const beforeOperations = useParseFlowStore.getState().parseOperations;
      const parseListener = vi.fn();
      const toolListener = vi.fn();
      const unsubscribeParse = useParseFlowStore.subscribe(parseListener);
      const unsubscribeTool = useToolStore.subscribe(toolListener);

      invokeStep(fixture.command as (step: never) => void, "idle");

      const after = useParseFlowStore.getState();
      expect(parseListener).toHaveBeenCalledTimes(1);
      expect(toolListener).not.toHaveBeenCalled();
      expect(after[fixture.stepKey]).toBe("idle");
      expect(after.parseOperations[fixture.kind]).toEqual({
        revision: token.revision + 1,
        busy: false,
      });
      expectOtherStatusIdentities(fixture.kind, beforeOperations, after.parseOperations);
      unsubscribeParse();
      unsubscribeTool();
    });

    it(`${fixture.kind}: active -> active stays in the same operation lane`, () => {
      useParseFlowStore.setState({
        [fixture.stepKey]: "select-region",
      } as Partial<ParseState>);
      const token = startOperation(fixture.kind);
      const beforeOperations = useParseFlowStore.getState().parseOperations;
      const parseListener = vi.fn();
      const toolListener = vi.fn();
      const unsubscribeParse = useParseFlowStore.subscribe(parseListener);
      const unsubscribeTool = useToolStore.subscribe(toolListener);

      invokeStep(fixture.command as (step: never) => void, fixture.activeStep);

      const after = useParseFlowStore.getState();
      expect(parseListener).toHaveBeenCalledTimes(1);
      expect(toolListener).not.toHaveBeenCalled();
      expect(after[fixture.stepKey]).toBe(fixture.activeStep);
      expect(after.parseOperations).toBe(beforeOperations);
      expect(after.parseOperations[fixture.kind]).toEqual({
        revision: token.revision,
        busy: true,
      });
      unsubscribeParse();
      unsubscribeTool();
    });
  }
});

describe("A2e explicit tool-and-step user boundaries", () => {
  for (const fixture of STEP_WITH_TOOL_CASES) {
    it(`${fixture.kind}: publishes the exact Tool destination before one terminal Parse transition`, () => {
      useToolStore.setState({ mode: "markup", bucketFillActive: true });
      const token = startOperation(fixture.kind);
      const beforeOperations = useParseFlowStore.getState().parseOperations;
      const trace: string[] = [];
      const snapshots: ParseState[] = [];
      const unsubscribeTool = useToolStore.subscribe(() => trace.push("tool"));
      const unsubscribeParse = useParseFlowStore.subscribe((state) => {
        trace.push("parse");
        snapshots.push(state);
      });

      invokeStepWithTool(
        fixture.command as (step: never, toolMode: never) => void,
        fixture.activeStep,
        "pointer",
      );

      expect(trace).toEqual(["tool", "parse"]);
      expect(snapshots).toHaveLength(1);
      const after = useParseFlowStore.getState();
      expect(after[fixture.stepKey]).toBe(fixture.activeStep);
      expect(after.parseOperations[fixture.kind]).toEqual({
        revision: token.revision + 1,
        busy: false,
      });
      expectOtherStatusIdentities(fixture.kind, beforeOperations, after.parseOperations);
      expect(useToolStore.getState().mode).toBe("pointer");
      unsubscribeParse();
      unsubscribeTool();
    });

    for (const settles of [false, true]) {
      it(`${fixture.kind}: a terminal subscriber's ${settles ? "settled" : "busy"} B and tool choice survive with no A tail`, () => {
        useToolStore.setState({ mode: "markup" });
        const token = startOperation(fixture.kind);
        let armed = true;
        let terminalSnapshot: ParseState | null = null;
        const unsubscribeParse = useParseFlowStore.subscribe((state) => {
          if (!armed || state[fixture.stepKey] !== fixture.activeStep) return;
          armed = false;
          terminalSnapshot = state;
          const result = state.beginParseOperation(fixture.kind);
          expect(result.status).toBe("started");
          if (result.status !== "started") return;
          if (settles) useParseFlowStore.getState().finishParseOperation(result.token);
          useToolStore.getState().setMode("markup");
        });

        invokeStepWithTool(
          fixture.command as (step: never, toolMode: never) => void,
          fixture.activeStep,
          "pointer",
        );

        const observedTerminal = terminalSnapshot as ParseState | null;
        expect(observedTerminal).not.toBeNull();
        expect((observedTerminal as ParseState).parseOperations[fixture.kind]).toEqual({
          revision: token.revision + 1,
          busy: false,
        });
        expect(useParseFlowStore.getState()[fixture.stepKey]).toBe(fixture.activeStep);
        expect(useParseFlowStore.getState().parseOperations[fixture.kind]).toEqual({
          revision: token.revision + 2,
          busy: !settles,
        });
        expect(useToolStore.getState().mode).toBe("markup");
        unsubscribeParse();
      });
    }
  }
});

describe("A2e atomic parse-input user commands", () => {
  const tableColumnA = [0.1, 0.2, 0.4, 0.9] as [number, number, number, number];
  const tableColumnB = [0.5, 0.2, 0.8, 0.9] as [number, number, number, number];
  const tableRowA = [0.1, 0.2, 0.8, 0.4] as [number, number, number, number];
  const tableRowB = [0.1, 0.5, 0.8, 0.9] as [number, number, number, number];
  const gridA = { headers: ["Tag"], rows: [{ Tag: "A" }] };
  const gridB = { headers: ["Tag"], rows: [{ Tag: "B" }] };
  const structureA = {
    cells: [{
      bbox: tableColumnA,
      row: 0,
      col: 0,
      rowSpan: 1,
      colSpan: 1,
      type: "data",
      confidence: 0.9,
      text: "A",
      highlighted: false,
    }],
    pageNumber: 1,
    regionBbox: [0.1, 0.2, 0.8, 0.9] as [number, number, number, number],
  };
  const structureB = {
    ...structureA,
    cells: [{ ...structureA.cells[0], bbox: tableColumnB, text: "B" }],
    pageNumber: 2,
  };
  const fixtures: ReadonlyArray<{
    name: string;
    kind: ParseKind;
    seed: () => void;
    command: () => void;
    read: (state: ParseState) => unknown;
    expected: unknown;
    publishB: () => void;
    bExpected: unknown;
  }> = [
    {
      name: "replace Table review grid",
      kind: "table",
      seed: () => useParseFlowStore.setState({ tableParsedGrid: null }),
      command: () => setTableParsedGridForUser(gridA),
      read: (state) => state.tableParsedGrid,
      expected: gridA,
      publishB: () => useParseFlowStore.setState({ tableParsedGrid: gridB }),
      bExpected: gridB,
    },
    {
      name: "replace Table manual geometry",
      kind: "table",
      seed: () => useParseFlowStore.setState({
        tableParseColumnBBs: [],
        tableParseColumnNames: [],
      }),
      command: () => setTableManualGeometryForUser({
        tableParseColumnBBs: [tableColumnA],
        tableParseColumnNames: ["A"],
      }),
      read: (state) => [state.tableParseColumnBBs, state.tableParseColumnNames],
      expected: [[tableColumnA], ["A"]],
      publishB: () => useParseFlowStore.setState({
        tableParseColumnBBs: [tableColumnB],
        tableParseColumnNames: ["B"],
      }),
      bExpected: [[tableColumnB], ["B"]],
    },
    {
      name: "append Table column",
      kind: "table",
      seed: () => useParseFlowStore.setState({ tableParseColumnBBs: [] }),
      command: () => addTableParseColumnForUser(tableColumnA),
      read: (state) => state.tableParseColumnBBs,
      expected: [tableColumnA],
      publishB: () => useParseFlowStore.setState({ tableParseColumnBBs: [tableColumnB] }),
      bExpected: [tableColumnB],
    },
    {
      name: "append Table row",
      kind: "table",
      seed: () => useParseFlowStore.setState({ tableParseRowBBs: [] }),
      command: () => addTableParseRowForUser(tableRowA),
      read: (state) => state.tableParseRowBBs,
      expected: [tableRowA],
      publishB: () => useParseFlowStore.setState({ tableParseRowBBs: [tableRowB] }),
      bExpected: [tableRowB],
    },
    {
      name: "clear Table cell structure",
      kind: "table",
      seed: () => useParseFlowStore.setState({
        tableCellStructure: structureA,
        showTableCellStructure: true,
      }),
      command: clearTableCellStructureForUser,
      read: (state) => [state.tableCellStructure, state.showTableCellStructure],
      expected: [null, false],
      publishB: () => useParseFlowStore.setState({
        tableCellStructure: structureB,
        showTableCellStructure: true,
      }),
      bExpected: [structureB, true],
    },
    {
      name: "replace Keynote manual inputs",
      kind: "keynote",
      seed: () => useParseFlowStore.setState({ keynoteYoloClass: null }),
      command: () => setKeynoteManualInputsForUser({
        keynoteYoloClass: { model: "fixture", className: "A" },
      }),
      read: (state) => state.keynoteYoloClass,
      expected: { model: "fixture", className: "A" },
      publishB: () => useParseFlowStore.setState({
        keynoteYoloClass: { model: "fixture", className: "B" },
      }),
      bExpected: { model: "fixture", className: "B" },
    },
    {
      name: "append Keynote column",
      kind: "keynote",
      seed: () => useParseFlowStore.setState({ keynoteColumnBBs: [] }),
      command: () => addKeynoteColumnForUser(tableColumnA),
      read: (state) => state.keynoteColumnBBs,
      expected: [tableColumnA],
      publishB: () => useParseFlowStore.setState({ keynoteColumnBBs: [tableColumnB] }),
      bExpected: [tableColumnB],
    },
    {
      name: "append Keynote row",
      kind: "keynote",
      seed: () => useParseFlowStore.setState({ keynoteRowBBs: [] }),
      command: () => addKeynoteRowForUser(tableRowA),
      read: (state) => state.keynoteRowBBs,
      expected: [tableRowA],
      publishB: () => useParseFlowStore.setState({ keynoteRowBBs: [tableRowB] }),
      bExpected: [tableRowB],
    },
  ];

  for (const fixture of fixtures) {
    it(`${fixture.name}: publishes mutation and one revision invalidation atomically`, () => {
      fixture.seed();
      const token = startOperation(fixture.kind);
      const beforeOperations = useParseFlowStore.getState().parseOperations;
      const snapshots: ParseState[] = [];
      const toolListener = vi.fn();
      const unsubscribeTool = useToolStore.subscribe(toolListener);
      const unsubscribeParse = useParseFlowStore.subscribe((state) => snapshots.push(state));

      fixture.command();

      expect(snapshots).toHaveLength(1);
      expect(fixture.read(snapshots[0])).toEqual(fixture.expected);
      expect(snapshots[0].parseOperations[fixture.kind]).toEqual({
        revision: token.revision + 1,
        busy: false,
      });
      expectOtherStatusIdentities(fixture.kind, beforeOperations, snapshots[0].parseOperations);
      expect(toolListener).not.toHaveBeenCalled();
      unsubscribeParse();
      unsubscribeTool();
    });

    for (const settles of [false, true]) {
      it(`${fixture.name}: terminal subscriber ${settles ? "settled" : "busy"} B survives with no command tail`, () => {
        fixture.seed();
        const token = startOperation(fixture.kind);
        let armed = true;
        const unsubscribeParse = useParseFlowStore.subscribe((state) => {
          if (
            !armed ||
            state.parseOperations[fixture.kind].revision !== token.revision + 1 ||
            state.parseOperations[fixture.kind].busy
          ) return;
          armed = false;
          expect(fixture.read(state)).toEqual(fixture.expected);
          const result = state.beginParseOperation(fixture.kind);
          expect(result.status).toBe("started");
          if (result.status !== "started") return;
          fixture.publishB();
          if (settles) useParseFlowStore.getState().finishParseOperation(result.token);
        });

        fixture.command();

        expect(armed).toBe(false);
        expect(fixture.read(useParseFlowStore.getState())).toEqual(fixture.bExpected);
        expect(useParseFlowStore.getState().parseOperations[fixture.kind]).toEqual({
          revision: token.revision + 2,
          busy: !settles,
        });
        unsubscribeParse();
      });
    }
  }
});

describe("A2b token-authorized Table completion boundary", () => {
  it("advances an idle current owner to review tool-first without invalidating its token", () => {
    useToolStore.setState({
      mode: "markup",
      bucketFillActive: true,
      splitAreaActive: true,
      symbolSearchActive: true,
    });
    const token = startOperation("table");
    const beforeOperations = useParseFlowStore.getState().parseOperations;
    const trace: string[] = [];
    const unsubscribeTool = useToolStore.subscribe(() => trace.push("tool"));
    const unsubscribeParse = useParseFlowStore.subscribe(() => trace.push("parse"));

    expect(setTableParseStepForOperation(token, "review")).toBe(true);

    const after = useParseFlowStore.getState();
    expect(trace).toEqual(["tool", "parse"]);
    expect(after.tableParseStep).toBe("review");
    expect(after.parseOperations).toBe(beforeOperations);
    expect(after.parseOperations.table).toEqual({ revision: token.revision, busy: true });
    expect(after.isParseOperationCurrent(token)).toBe(true);
    expect(useToolStore.getState()).toMatchObject({
      mode: "move",
      bucketFillActive: false,
      splitAreaActive: false,
      symbolSearchActive: false,
    });
    unsubscribeParse();
    unsubscribeTool();
  });

  it("fails closed when a synchronous tool subscriber revokes the token before the parse write", () => {
    useToolStore.setState({ mode: "markup", bucketFillActive: true });
    const token = startOperation("table");
    const unsubscribeTool = useToolStore.subscribe(() => {
      useParseFlowStore.getState().invalidateParseOperation("table");
    });

    expect(setTableParseStepForOperation(token, "review")).toBe(false);

    expect(useParseFlowStore.getState().tableParseStep).toBe("idle");
    expect(useParseFlowStore.getState().parseOperations.table).toEqual({
      revision: token.revision + 1,
      busy: false,
    });
    expect(useToolStore.getState()).toMatchObject({ mode: "move", bucketFillActive: false });
    unsubscribeTool();
  });

  it("denies a stale completion with no parse or tool publication", () => {
    const token = startOperation("table");
    useParseFlowStore.getState().invalidateParseOperation("table");
    useToolStore.setState({ mode: "markup", bucketFillActive: true });
    const beforeParse = useParseFlowStore.getState();
    const beforeTool = useToolStore.getState();
    const parseListener = vi.fn();
    const toolListener = vi.fn();
    const unsubscribeParse = useParseFlowStore.subscribe(parseListener);
    const unsubscribeTool = useToolStore.subscribe(toolListener);

    expect(setTableParseStepForOperation(token, "review")).toBe(false);

    expect(useParseFlowStore.getState()).toBe(beforeParse);
    expect(useToolStore.getState()).toBe(beforeTool);
    expect(parseListener).not.toHaveBeenCalled();
    expect(toolListener).not.toHaveBeenCalled();
    unsubscribeTool();
    unsubscribeParse();
  });

  it("denies a cast wrong-kind token even when its revision matches Table", () => {
    const token = startOperation("table");
    const wrongKind = { kind: "keynote", revision: token.revision } as unknown as typeof token;
    useToolStore.setState({ mode: "markup", bucketFillActive: true });
    const beforeParse = useParseFlowStore.getState();
    const beforeTool = useToolStore.getState();
    const parseListener = vi.fn();
    const toolListener = vi.fn();
    const unsubscribeParse = useParseFlowStore.subscribe(parseListener);
    const unsubscribeTool = useToolStore.subscribe(toolListener);

    expect(setTableParseStepForOperation(wrongKind, "review")).toBe(false);

    expect(useParseFlowStore.getState()).toBe(beforeParse);
    expect(useToolStore.getState()).toBe(beforeTool);
    expect(parseListener).not.toHaveBeenCalled();
    expect(toolListener).not.toHaveBeenCalled();
    unsubscribeTool();
    unsubscribeParse();
  });

  it("keeps active-to-active completion inside the current lane without touching tools", () => {
    useParseFlowStore.setState({ tableParseStep: "select-region" });
    useToolStore.setState({ mode: "markup", bucketFillActive: true });
    const token = startOperation("table");
    const beforeOperations = useParseFlowStore.getState().parseOperations;
    const parseListener = vi.fn();
    const toolListener = vi.fn();
    const unsubscribeParse = useParseFlowStore.subscribe(parseListener);
    const unsubscribeTool = useToolStore.subscribe(toolListener);

    expect(setTableParseStepForOperation(token, "review")).toBe(true);

    expect(parseListener).toHaveBeenCalledTimes(1);
    expect(toolListener).not.toHaveBeenCalled();
    expect(useParseFlowStore.getState().tableParseStep).toBe("review");
    expect(useParseFlowStore.getState().parseOperations).toBe(beforeOperations);
    expect(useParseFlowStore.getState().isParseOperationCurrent(token)).toBe(true);
    unsubscribeTool();
    unsubscribeParse();
  });
});

describe("A2e Table workspace terminal commands", () => {
  const fixtures = [
    { name: "full reset", command: resetTableParseWorkspace, retainsRegion: false },
    { name: "restart from retained region", command: restartTableParseFromCurrentRegion, retainsRegion: true },
  ] as const;

  for (const fixture of fixtures) {
    it(`${fixture.name}: emits Tool then exactly one Parse publication and invalidates Table once`, () => {
      const region = [0.1, 0.2, 0.8, 0.9] as const;
      useToolStore.setState({ mode: "markup" });
      useParseFlowStore.setState({
        tableParseStep: "review",
        tableParseRegion: [...region],
        tableParsedGrid: { headers: ["Tag"], rows: [{ Tag: "A" }] },
      });
      const token = startOperation("table");
      const beforeOperations = useParseFlowStore.getState().parseOperations;
      const trace: string[] = [];
      const unsubscribeTool = useToolStore.subscribe(() => trace.push("tool"));
      const unsubscribeParse = useParseFlowStore.subscribe(() => trace.push("parse"));

      fixture.command();

      const after = useParseFlowStore.getState();
      expect(trace).toEqual(["tool", "parse"]);
      expect(after.tableParseStep).toBe("idle");
      expect(after.tableParsedGrid).toBeNull();
      expect(after.tableParseRegion).toEqual(fixture.retainsRegion ? region : null);
      expect(after.parseOperations.table).toEqual({
        revision: token.revision + 1,
        busy: false,
      });
      expectOtherStatusIdentities("table", beforeOperations, after.parseOperations);
      expect(useToolStore.getState().mode).toBe("move");
      unsubscribeParse();
      unsubscribeTool();
    });

    for (const settles of [false, true]) {
      it(`${fixture.name}: a terminal subscriber's ${settles ? "settled" : "busy"} B survives without a Parse or Tool tail`, () => {
        useToolStore.setState({ mode: "markup" });
        useParseFlowStore.setState({
          tableParseStep: "review",
          tableParseRegion: [0.1, 0.2, 0.8, 0.9],
          tableParsedGrid: { headers: ["Tag"], rows: [{ Tag: "A" }] },
        });
        const token = startOperation("table");
        const bRegion = [0.2, 0.3, 0.9, 0.95] as const;
        let armed = true;
        const unsubscribeParse = useParseFlowStore.subscribe((state) => {
          if (
            !armed ||
            state.tableParsedGrid !== null ||
            state.parseOperations.table.revision !== token.revision + 1
          ) return;
          armed = false;
          const result = state.beginParseOperation("table");
          expect(result.status).toBe("started");
          if (result.status !== "started") return;
          useParseFlowStore.setState({ tableParseRegion: [...bRegion] });
          if (settles) useParseFlowStore.getState().finishParseOperation(result.token);
          useToolStore.getState().setMode("markup");
        });

        fixture.command();

        expect(armed).toBe(false);
        expect(useParseFlowStore.getState().tableParseRegion).toEqual(bRegion);
        expect(useParseFlowStore.getState().parseOperations.table).toEqual({
          revision: token.revision + 2,
          busy: !settles,
        });
        expect(useToolStore.getState().mode).toBe("markup");
        unsubscribeParse();
      });
    }
  }
});

describe("A2c raw parse-panel close boundaries", () => {
  it("Table close revokes every shared Guided owner in its one raw parse patch", () => {
    useUiStore.setState({ showTableParsePanel: true });
    useToolStore.setState({ mode: "markup" });
    useParseFlowStore.setState({
      tableParseStep: "review",
      tableParseRegion: [0.1, 0.2, 0.8, 0.9],
      tableParsedGrid: { headers: ["Tag"], rows: [{ Tag: "D1" }] },
      tableParseTab: "manual",
      guidedParseOwner: "table",
      guidedParseActive: true,
      guidedParseRegion: [0.1, 0.2, 0.8, 0.9],
      guidedParseRows: [0.2, 0.9],
      guidedParseCols: [0.1, 0.8],
    });
    const tokens = {
      table: startOperation("table"),
      keynote: startOperation("keynote"),
      notes: startOperation("notes"),
    };
    const beforeOperations = useParseFlowStore.getState().parseOperations;
    const trace: string[] = [];
    const unsubscribeParse = useParseFlowStore.subscribe(() => trace.push("parse"));
    const unsubscribeTool = useToolStore.subscribe(() => trace.push("tool"));
    const unsubscribeUi = useUiStore.subscribe(() => trace.push("ui"));

    toggleTableParsePanel();

    expect(trace).toEqual(["ui", "tool", "parse"]);
    const after = useParseFlowStore.getState();
    expect(after).toMatchObject({
      tableParseStep: "idle",
      tableParseRegion: null,
      tableParsedGrid: null,
      tableParseTab: "all",
      guidedParseActive: false,
      guidedParseRegion: null,
      guidedParseRows: [],
      guidedParseCols: [],
    });
    for (const kind of ["table", "keynote", "notes"] as const) {
      expect(after.parseOperations[kind]).toEqual({
        revision: tokens[kind].revision + 1,
        busy: false,
      });
    }
    expect(after.parseOperations.spec).toBe(beforeOperations.spec);
    expect(useToolStore.getState().mode).toBe("move");
    expect(useUiStore.getState().showTableParsePanel).toBe(false);
    unsubscribeUi();
    unsubscribeTool();
    unsubscribeParse();
  });

  it("Keynote close revokes every shared Guided owner in its one raw parse patch", () => {
    useUiStore.setState({ showKeynoteParsePanel: true });
    useToolStore.setState({ mode: "markup" });
    useParseFlowStore.setState({
      keynoteParseStep: "review",
      keynoteParseRegion: [0.1, 0.2, 0.8, 0.9],
      keynoteColumnBBs: [[0.1, 0.2, 0.4, 0.9]],
      keynoteRowBBs: [[0.1, 0.2, 0.8, 0.4]],
      keynoteParseTab: "manual",
      guidedParseOwner: "keynote",
      guidedParseActive: true,
      guidedParseRegion: [0.1, 0.2, 0.8, 0.9],
      guidedParseRows: [0.2, 0.9],
      guidedParseCols: [0.1, 0.8],
    });
    const tokens = {
      table: startOperation("table"),
      keynote: startOperation("keynote"),
      notes: startOperation("notes"),
    };
    const beforeOperations = useParseFlowStore.getState().parseOperations;
    const trace: string[] = [];
    const unsubscribeParse = useParseFlowStore.subscribe(() => trace.push("parse"));
    const unsubscribeTool = useToolStore.subscribe(() => trace.push("tool"));
    const unsubscribeUi = useUiStore.subscribe(() => trace.push("ui"));

    toggleKeynoteParsePanel();

    expect(trace).toEqual(["ui", "tool", "parse"]);
    const after = useParseFlowStore.getState();
    expect(after).toMatchObject({
      keynoteParseStep: "idle",
      keynoteParseRegion: null,
      keynoteColumnBBs: [],
      keynoteRowBBs: [],
      keynoteParseTab: "all",
      guidedParseActive: false,
      guidedParseRegion: null,
      guidedParseRows: [],
      guidedParseCols: [],
    });
    for (const kind of ["table", "keynote", "notes"] as const) {
      expect(after.parseOperations[kind]).toEqual({
        revision: tokens[kind].revision + 1,
        busy: false,
      });
    }
    expect(after.parseOperations.spec).toBe(beforeOperations.spec);
    expect(useToolStore.getState().mode).toBe("move");
    expect(useUiStore.getState().showKeynoteParsePanel).toBe(false);
    unsubscribeUi();
    unsubscribeTool();
    unsubscribeParse();
  });

  it("opening either raw panel leaves parse and operation state untouched", () => {
    for (const fixture of [
      { kind: "table" as const, toggle: toggleTableParsePanel, uiKey: "showTableParsePanel" as const },
      { kind: "keynote" as const, toggle: toggleKeynoteParsePanel, uiKey: "showKeynoteParsePanel" as const },
    ]) {
      restoreStores();
      const token = startOperation(fixture.kind);
      const beforeParse = useParseFlowStore.getState();
      const trace: string[] = [];
      const unsubscribeParse = useParseFlowStore.subscribe(() => trace.push("parse"));
      const unsubscribeTool = useToolStore.subscribe(() => trace.push("tool"));
      const unsubscribeUi = useUiStore.subscribe(() => trace.push("ui"));

      fixture.toggle();

      expect(trace).toEqual(["ui"]);
      expect(useParseFlowStore.getState()).toBe(beforeParse);
      expect(useParseFlowStore.getState().parseOperations[fixture.kind]).toEqual({
        revision: token.revision,
        busy: true,
      });
      expect(useUiStore.getState()[fixture.uiKey]).toBe(true);
      unsubscribeUi();
      unsubscribeTool();
      unsubscribeParse();
    }
  });
});

describe("A2a universal reset operation trace", () => {
  it("preserves the seven-publication tool -> four kind -> Guided -> tool trace", () => {
    useToolStore.setState({ mode: "markup", symbolSearchActive: true });
    useParseFlowStore.setState({
      tableParseStep: "review",
      keynoteParseStep: "review",
      notesParseStep: "review",
      specParseStep: "review",
      guidedParseActive: true,
    });
    const tokens = Object.fromEntries(PARSE_KINDS.map((kind) => [kind, startOperation(kind)])) as
      Record<ParseKind, ParseOperationToken>;
    const trace: string[] = [];
    const parseSnapshots: ParseState[] = [];
    const unsubscribeTool = useToolStore.subscribe(() => trace.push("tool"));
    const unsubscribeParse = useParseFlowStore.subscribe((state) => {
      trace.push("parse");
      parseSnapshots.push(state);
    });

    resetAllTools();

    expect(trace).toEqual(["tool", "parse", "parse", "parse", "parse", "parse", "tool"]);
    expect(parseSnapshots).toHaveLength(5);
    for (const [index, kind] of PARSE_KINDS.entries()) {
      expect(parseSnapshots[index].parseOperations[kind]).toEqual({
        revision: tokens[kind].revision + 1,
        busy: false,
      });
    }
    expect(parseSnapshots.at(-1)).toMatchObject({
      tableParseStep: "idle",
      keynoteParseStep: "idle",
      notesParseStep: "idle",
      specParseStep: "idle",
      guidedParseOwner: null,
      guidedParseActive: false,
    });
    expect(useToolStore.getState()).toMatchObject({
      mode: "move",
      symbolSearchActive: false,
    });
    unsubscribeParse();
    unsubscribeTool();
  });
});
