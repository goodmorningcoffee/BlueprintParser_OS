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

describe("A2a raw parse-panel close boundaries", () => {
  it("Table close revokes Table authority in its one raw parse patch", () => {
    useUiStore.setState({ showTableParsePanel: true });
    useToolStore.setState({ mode: "markup" });
    useParseFlowStore.setState({
      tableParseStep: "review",
      tableParseRegion: [0.1, 0.2, 0.8, 0.9],
      tableParsedGrid: { headers: ["Tag"], rows: [{ Tag: "D1" }] },
      tableParseTab: "manual",
      guidedParseActive: true,
      guidedParseRegion: [0.1, 0.2, 0.8, 0.9],
      guidedParseRows: [0.2, 0.9],
      guidedParseCols: [0.1, 0.8],
    });
    const token = startOperation("table");
    const beforeOperations = useParseFlowStore.getState().parseOperations;
    const trace: string[] = [];
    const unsubscribeParse = useParseFlowStore.subscribe(() => trace.push("parse"));
    const unsubscribeTool = useToolStore.subscribe(() => trace.push("tool"));
    const unsubscribeUi = useUiStore.subscribe(() => trace.push("ui"));

    toggleTableParsePanel();

    expect(trace).toEqual(["parse", "tool", "ui"]);
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
    expect(after.parseOperations.table).toEqual({ revision: token.revision + 1, busy: false });
    expectOtherStatusIdentities("table", beforeOperations, after.parseOperations);
    expect(useToolStore.getState().mode).toBe("move");
    expect(useUiStore.getState().showTableParsePanel).toBe(false);
    unsubscribeUi();
    unsubscribeTool();
    unsubscribeParse();
  });

  it("Keynote close revokes Keynote authority in its one raw parse patch", () => {
    useUiStore.setState({ showKeynoteParsePanel: true });
    useToolStore.setState({ mode: "markup" });
    useParseFlowStore.setState({
      keynoteParseStep: "review",
      keynoteParseRegion: [0.1, 0.2, 0.8, 0.9],
      keynoteColumnBBs: [[0.1, 0.2, 0.4, 0.9]],
      keynoteRowBBs: [[0.1, 0.2, 0.8, 0.4]],
      keynoteParseTab: "manual",
      guidedParseActive: true,
      guidedParseRegion: [0.1, 0.2, 0.8, 0.9],
      guidedParseRows: [0.2, 0.9],
      guidedParseCols: [0.1, 0.8],
    });
    const token = startOperation("keynote");
    const beforeOperations = useParseFlowStore.getState().parseOperations;
    const trace: string[] = [];
    const unsubscribeParse = useParseFlowStore.subscribe(() => trace.push("parse"));
    const unsubscribeTool = useToolStore.subscribe(() => trace.push("tool"));
    const unsubscribeUi = useUiStore.subscribe(() => trace.push("ui"));

    toggleKeynoteParsePanel();

    expect(trace).toEqual(["parse", "tool", "ui"]);
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
    expect(after.parseOperations.keynote).toEqual({ revision: token.revision + 1, busy: false });
    expectOtherStatusIdentities("keynote", beforeOperations, after.parseOperations);
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
  it("keeps tool -> four kind resets -> guided reset -> tool and invalidates each lane once", () => {
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
    expect(parseSnapshots[0].parseOperations.table).toEqual({
      revision: tokens.table.revision + 1,
      busy: false,
    });
    expect(parseSnapshots[0].parseOperations.keynote.busy).toBe(true);
    expect(parseSnapshots[1].parseOperations.keynote).toEqual({
      revision: tokens.keynote.revision + 1,
      busy: false,
    });
    expect(parseSnapshots[2].parseOperations.notes).toEqual({
      revision: tokens.notes.revision + 1,
      busy: false,
    });
    expect(parseSnapshots[3].parseOperations.spec).toEqual({
      revision: tokens.spec.revision + 1,
      busy: false,
    });
    // Shared-guided reset is still its own fifth publication and does not re-invalidate any kind.
    expect(parseSnapshots[4].parseOperations).toBe(parseSnapshots[3].parseOperations);
    unsubscribeParse();
    unsubscribeTool();
  });
});
