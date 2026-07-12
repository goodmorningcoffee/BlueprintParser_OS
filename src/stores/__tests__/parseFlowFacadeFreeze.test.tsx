// @vitest-environment jsdom
// [refactor jul11 P2.4 A1] Semantic lifecycle facade over the unchanged flat parse owner.

import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

import {
  useParseFlow,
  type ParseFlowLifecycle,
  type ParseKind,
  type ParseStepMap,
} from "@/hooks/useParseFlow";
import {
  useGuidedParseExtensions,
  useKeynoteParseExtensions,
  useParseFlowStore,
  useTableParseExtensions,
  type ParseFlowState,
} from "@/stores/parseFlowStore";
import { useToolStore } from "@/stores/toolStore";
import {
  setKeynoteParseStep,
  setNotesParseStep,
  setSpecParseStep,
  setTableParseStep,
} from "@/stores/viewerCommands";
import type { BboxMinMax } from "@/types";

const BBOX = [0.1, 0.2, 0.7, 0.8] as BboxMinMax;

beforeEach(() => {
  useParseFlowStore.setState(useParseFlowStore.getInitialState(), true);
  useToolStore.setState(useToolStore.getInitialState(), true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type LifecycleCase<K extends ParseKind> = {
  kind: K;
  activeStep: ParseStepMap[K];
  command: ParseFlowLifecycle<K>["setStep"];
  readStep: (state: ParseFlowState) => ParseStepMap[K];
  readRegion: (state: ParseFlowState) => BboxMinMax | null;
  setRegionAction: (state: ParseFlowState) => ParseFlowLifecycle<K>["setRegion"];
  resetAction: (state: ParseFlowState) => () => void;
};

type ExpectedParseStepMap = {
  table: ParseFlowState["tableParseStep"];
  keynote: ParseFlowState["keynoteParseStep"];
  notes: ParseFlowState["notesParseStep"];
  spec: ParseFlowState["specParseStep"];
};

type ExpectedLifecycle<K extends ParseKind> = {
  kind: K;
  step: ExpectedParseStepMap[K];
  region: BboxMinMax | null;
  setStep: (step: ExpectedParseStepMap[K]) => void;
  setRegion: (region: BboxMinMax | null) => void;
  reset: () => void;
};

function exerciseLifecycle<K extends ParseKind>(fixture: LifecycleCase<K>): void {
  const { result, unmount } = renderHook(() => useParseFlow(fixture.kind));
  const initialState = useParseFlowStore.getState();

  expect(result.current).toEqual({
    kind: fixture.kind,
    step: "idle",
    region: null,
    setStep: fixture.command,
    setRegion: fixture.setRegionAction(initialState),
    reset: fixture.resetAction(initialState),
  });

  act(() => result.current.setRegion(BBOX));
  expect(fixture.readRegion(useParseFlowStore.getState())).toBe(BBOX);
  act(() => result.current.setStep(fixture.activeStep));
  expect(fixture.readStep(useParseFlowStore.getState())).toBe(fixture.activeStep);

  const reset = result.current.reset;
  act(() => reset());
  expect(fixture.readStep(useParseFlowStore.getState())).toBe("idle");
  expect(fixture.readRegion(useParseFlowStore.getState())).toBeNull();
  unmount();
}

describe("P2.4 A1 parse facade type and dispatch contract", () => {
  it("keeps the independent four-kind step and lifecycle types exact", () => {
    expectTypeOf<ParseKind>().toEqualTypeOf<"table" | "keynote" | "notes" | "spec">();
    expectTypeOf<ParseStepMap>().toEqualTypeOf<ExpectedParseStepMap>();
    expectTypeOf<ParseStepMap["table"]>()
      .toEqualTypeOf<ParseFlowState["tableParseStep"]>();
    expectTypeOf<ParseStepMap["keynote"]>()
      .toEqualTypeOf<ParseFlowState["keynoteParseStep"]>();
    expectTypeOf<ParseStepMap["notes"]>()
      .toEqualTypeOf<ParseFlowState["notesParseStep"]>();
    expectTypeOf<ParseStepMap["spec"]>()
      .toEqualTypeOf<ParseFlowState["specParseStep"]>();
    expectTypeOf<ParseFlowLifecycle<"spec">["region"]>()
      .toEqualTypeOf<BboxMinMax | null>();
    expectTypeOf<ParseFlowLifecycle<"spec">["setStep"]>()
      .parameter(0).toEqualTypeOf<ParseFlowState["specParseStep"]>();
    expectTypeOf<ParseFlowLifecycle<"table">>()
      .toEqualTypeOf<ExpectedLifecycle<"table">>();
    expectTypeOf<ParseFlowLifecycle<"keynote">>()
      .toEqualTypeOf<ExpectedLifecycle<"keynote">>();
    expectTypeOf<ParseFlowLifecycle<"notes">>()
      .toEqualTypeOf<ExpectedLifecycle<"notes">>();
    expectTypeOf<ParseFlowLifecycle<"spec">>()
      .toEqualTypeOf<ExpectedLifecycle<"spec">>();
  });

  it("maps Table to the exact neutral command and leaf actions", () => {
    exerciseLifecycle({
      kind: "table",
      activeStep: "define-column",
      command: setTableParseStep,
      readStep: (state) => state.tableParseStep,
      readRegion: (state) => state.tableParseRegion,
      setRegionAction: (state) => state.setTableParseRegion,
      resetAction: (state) => state.resetTableParse,
    });
  });

  it("maps Keynote to the exact neutral command and leaf actions", () => {
    exerciseLifecycle({
      kind: "keynote",
      activeStep: "define-row",
      command: setKeynoteParseStep,
      readStep: (state) => state.keynoteParseStep,
      readRegion: (state) => state.keynoteParseRegion,
      setRegionAction: (state) => state.setKeynoteParseRegion,
      resetAction: (state) => state.resetKeynoteParse,
    });
  });

  it("maps Notes to the exact neutral command and leaf actions", () => {
    exerciseLifecycle({
      kind: "notes",
      activeStep: "review",
      command: setNotesParseStep,
      readStep: (state) => state.notesParseStep,
      readRegion: (state) => state.notesParseRegion,
      setRegionAction: (state) => state.setNotesParseRegion,
      resetAction: (state) => state.resetNotesParse,
    });
  });

  it("maps Spec to its distinct step union and exact leaf actions", () => {
    exerciseLifecycle({
      kind: "spec",
      activeStep: "define-sections",
      command: setSpecParseStep,
      readStep: (state) => state.specParseStep,
      readRegion: (state) => state.specParseRegion,
      setRegionAction: (state) => state.setSpecParseRegion,
      resetAction: (state) => state.resetSpecParse,
    });
  });
});

describe("P2.4 A1 parse facade publication and subscription contract", () => {
  it("routes idle entry tool-first, then same-step publishes Parse only without a hook rerender", () => {
    useToolStore.setState({
      mode: "markup",
      bucketFillActive: true,
      splitAreaActive: true,
      symbolSearchActive: true,
    });
    const trace: string[] = [];
    const unsubscribeTool = useToolStore.subscribe(() => trace.push("tool"));
    const unsubscribeParse = useParseFlowStore.subscribe(() => trace.push("parse"));
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useParseFlow("table");
    });
    const initialRenders = renders;

    act(() => result.current.setStep("select-region"));
    expect(trace).toEqual(["tool", "parse"]);
    expect(useToolStore.getState()).toMatchObject({
      mode: "move",
      bucketFillActive: false,
      splitAreaActive: false,
      symbolSearchActive: false,
    });
    expect(renders).toBe(initialRenders + 1);

    trace.length = 0;
    const rendersBeforeSameStep = renders;
    act(() => result.current.setStep("select-region"));
    expect(trace).toEqual(["parse"]);
    expect(renders).toBe(rendersBeforeSameStep);
    unsubscribeParse();
    unsubscribeTool();
  });

  it("suppresses unrelated same-store publications and retains every action identity", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useParseFlow("table");
    });
    const first = result.current;
    const baseline = renders;

    act(() => {
      useParseFlowStore.getState().setKeynoteYoloClass({ model: "fixture", className: "door" });
      useParseFlowStore.getState().setTableParsedGrid({ headers: [], rows: [] });
    });
    expect(renders).toBe(baseline);
    expect(result.current).toBe(first);

    act(() => useParseFlowStore.getState().setTableParseRegion(BBOX));
    expect(renders).toBe(baseline + 1);
    expect(result.current).not.toBe(first);
    expect(result.current.setStep).toBe(first.setStep);
    expect(result.current.setRegion).toBe(first.setRegion);
    expect(result.current.reset).toBe(first.reset);
  });

  it("switches one unconditional hook across equal idle/null kinds without stale adapters", () => {
    const { result, rerender } = renderHook(
      ({ kind }: { kind: ParseKind }) => useParseFlow(kind),
      { initialProps: { kind: "table" as ParseKind } },
    );

    expect(result.current.kind).toBe("table");
    expect(result.current.setStep).toBe(setTableParseStep);
    rerender({ kind: "spec" });
    expect(result.current.kind).toBe("spec");
    expect(result.current.setStep).toBe(setSpecParseStep);
    rerender({ kind: "notes" });
    expect(result.current.kind).toBe("notes");
    expect(result.current.setStep).toBe(setNotesParseStep);
    rerender({ kind: "keynote" });
    expect(result.current.kind).toBe("keynote");
    expect(result.current.setStep).toBe(setKeynoteParseStep);
  });
});

describe("P2.4 A1 Table extension composition", () => {
  it("returns the exact 13 non-lifecycle fields and ignores lifecycle-only publications", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useTableParseExtensions();
    });
    const state = useParseFlowStore.getState();
    expect(result.current).toEqual({
      tableParsedGrid: state.tableParsedGrid,
      setTableParsedGrid: state.setTableParsedGrid,
      tableParseColumnBBs: state.tableParseColumnBBs,
      addTableParseColumnBB: state.addTableParseColumnBB,
      tableParseRowBBs: state.tableParseRowBBs,
      addTableParseRowBB: state.addTableParseRowBB,
      setTableParseRowBBs: state.setTableParseRowBBs,
      tableParseColumnNames: state.tableParseColumnNames,
      setTableParseColumnNames: state.setTableParseColumnNames,
      tableParseTab: state.tableParseTab,
      setTableParseTab: state.setTableParseTab,
      tableParseOptions: state.tableParseOptions,
      setTableParseOptions: state.setTableParseOptions,
    });
    const first = result.current;
    const baseline = renders;

    act(() => useParseFlowStore.setState({
      tableParseStep: "review",
      tableParseRegion: BBOX,
    }));
    expect(renders).toBe(baseline);
    expect(result.current).toBe(first);

    act(() => result.current.setTableParsedGrid({ headers: ["TAG"], rows: [] }));
    expect(renders).toBe(baseline + 1);
    expect(result.current.tableParsedGrid).toEqual({ headers: ["TAG"], rows: [] });
    expect(result.current.setTableParsedGrid).toBe(first.setTableParsedGrid);
  });
});

describe("P2.4 A1 Keynote and shared-guided extension composition", () => {
  it("keeps the exact ten Keynote fields independent from lifecycle and guided publications", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useKeynoteParseExtensions();
    });
    const state = useParseFlowStore.getState();
    expect(result.current).toEqual({
      keynoteParseTab: state.keynoteParseTab,
      setKeynoteParseTab: state.setKeynoteParseTab,
      keynoteColumnBBs: state.keynoteColumnBBs,
      addKeynoteColumnBB: state.addKeynoteColumnBB,
      keynoteRowBBs: state.keynoteRowBBs,
      addKeynoteRowBB: state.addKeynoteRowBB,
      keynoteYoloClass: state.keynoteYoloClass,
      setKeynoteYoloClass: state.setKeynoteYoloClass,
      parsedKeynoteData: state.parsedKeynoteData,
      addParsedKeynote: state.addParsedKeynote,
    });
    const first = result.current;
    const baseline = renders;

    act(() => useParseFlowStore.setState({
      keynoteParseStep: "review",
      keynoteParseRegion: BBOX,
      guidedParseActive: true,
    }));
    expect(renders).toBe(baseline);
    expect(result.current).toBe(first);

    act(() => result.current.setKeynoteParseTab("manual"));
    expect(renders).toBe(baseline + 1);
    expect(result.current.keynoteParseTab).toBe("manual");
    expect(result.current.setKeynoteParseTab).toBe(first.setKeynoteParseTab);
  });

  it("keeps the exact nine shared-grid fields independent from every kind lifecycle", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useGuidedParseExtensions();
    });
    const state = useParseFlowStore.getState();
    expect(result.current).toEqual({
      guidedParseActive: state.guidedParseActive,
      setGuidedParseActive: state.setGuidedParseActive,
      guidedParseRegion: state.guidedParseRegion,
      setGuidedParseRegion: state.setGuidedParseRegion,
      guidedParseRows: state.guidedParseRows,
      setGuidedParseRows: state.setGuidedParseRows,
      guidedParseCols: state.guidedParseCols,
      setGuidedParseCols: state.setGuidedParseCols,
      resetGuidedParse: state.resetGuidedParse,
    });
    const first = result.current;
    const baseline = renders;

    act(() => useParseFlowStore.setState({
      tableParseStep: "review",
      keynoteParseRegion: BBOX,
      notesParseStep: "select-region",
      specParseRegion: BBOX,
    }));
    expect(renders).toBe(baseline);
    expect(result.current).toBe(first);

    act(() => result.current.setGuidedParseActive(true));
    expect(renders).toBe(baseline + 1);
    expect(result.current.guidedParseActive).toBe(true);
    expect(result.current.setGuidedParseActive).toBe(first.setGuidedParseActive);
  });
});
