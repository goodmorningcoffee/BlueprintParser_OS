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
  useNotesParseExtensions,
  useParagraphWorkspaceExtensions,
  useParseDraftExtensions,
  useParseFlowStore,
  useTableParseExtensions,
  type GuidedParseOwner,
  type ParseFlowState,
} from "@/stores/parseFlowStore";
import { useToolStore } from "@/stores/toolStore";
import {
  resetKeynoteParseWorkspace,
  resetNotesParseWorkspace,
  resetSpecParseWorkspace,
  resetTableParseWorkspace,
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
    expectTypeOf<ParseFlowState["guidedParseOwner"]>()
      .toEqualTypeOf<GuidedParseOwner>();
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
      resetAction: () => resetTableParseWorkspace,
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
      resetAction: () => resetKeynoteParseWorkspace,
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
      resetAction: () => resetNotesParseWorkspace,
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
      resetAction: () => resetSpecParseWorkspace,
    });
  });
});

describe("P2.4 A1 parse facade publication and subscription contract", () => {
  it("routes every draw-step entry tool-first with fresh ownership and no same-step hook rerender", () => {
    useToolStore.setState({
      mode: "markup",
      activeTool: { kind: "bucketFill" },
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
      activeTool: { kind: "parseRect", flow: "table" },
    });
    const firstActivation = useToolStore.getState().activeTool;
    expect(renders).toBe(initialRenders + 1);

    trace.length = 0;
    const rendersBeforeSameStep = renders;
    act(() => result.current.setStep("select-region"));
    expect(trace).toEqual(["tool", "parse"]);
    expect(useToolStore.getState().activeTool).toEqual({ kind: "parseRect", flow: "table" });
    expect(useToolStore.getState().activeTool).not.toBe(firstActivation);
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

  it("keeps the exact ten shared-grid fields independent from every kind lifecycle", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useGuidedParseExtensions();
    });
    const state = useParseFlowStore.getState();
    expect(result.current).toEqual({
      guidedParseOwner: state.guidedParseOwner,
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

    act(() => useParseFlowStore.setState({ guidedParseOwner: "notes" }));
    expect(renders).toBe(baseline + 1);
    expect(result.current.guidedParseOwner).toBe("notes");

    act(() => result.current.setGuidedParseActive(true));
    expect(renders).toBe(baseline + 2);
    expect(result.current.guidedParseActive).toBe(true);
    expect(result.current.setGuidedParseActive).toBe(first.setGuidedParseActive);
  });
});

describe("P2.4 A1 Notes and shared-workspace extension composition", () => {
  it("keeps the exact three Notes render fields independent from lifecycle/workspaces", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useNotesParseExtensions();
    });
    const state = useParseFlowStore.getState();
    expect(result.current).toEqual({
      guidedNotesRows: state.guidedNotesRows,
      guidedNotesCols: state.guidedNotesCols,
      notesFastManualGrid: state.notesFastManualGrid,
    });
    const first = result.current;
    const baseline = renders;

    act(() => useParseFlowStore.setState({
      notesParseStep: "select-region",
      notesParseRegion: BBOX,
      guidedParseActive: true,
      paragraphWorkspaceOwner: "notes",
    }));
    expect(renders).toBe(baseline);
    expect(result.current).toBe(first);

    act(() => useParseFlowStore.setState({ guidedNotesRows: [BBOX] }));
    expect(renders).toBe(baseline + 1);
    expect(result.current.guidedNotesRows).toEqual([BBOX]);
  });

  it("exposes only the stable draft writer and never observes draft value changes", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useParseDraftExtensions();
    });
    const state = useParseFlowStore.getState();
    expect(result.current).toEqual({ setParseDraftRegion: state.setParseDraftRegion });
    const first = result.current;
    const baseline = renders;

    act(() => result.current.setParseDraftRegion({
      id: "draft-notes",
      type: "notes",
      category: "notes-preview",
      bbox: BBOX,
      confidence: 1,
      data: {},
    }));
    expect(useParseFlowStore.getState().parseDraftRegion?.id).toBe("draft-notes");
    expect(renders).toBe(baseline);
    expect(result.current).toBe(first);
  });

  it("pins the four paragraph batch fields while excluding hot ownership and clipboard values", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useParagraphWorkspaceExtensions();
    });
    const state = useParseFlowStore.getState();
    expect(result.current).toEqual({
      paragraphBatch: state.paragraphBatch,
      setParagraphBatch: state.setParagraphBatch,
      removePendingParagraph: state.removePendingParagraph,
      upsertPendingParagraph: state.upsertPendingParagraph,
    });
    const first = result.current;
    const baseline = renders;

    act(() => useParseFlowStore.setState({
      notesParseStep: "select-region",
      parseDraftRegion: null,
      paragraphWorkspaceOwner: "notes",
      paragraphClipboard: { colBoundaries: [0, 1], headers: ["Key", "Note"] },
    }));
    expect(renders).toBe(baseline);
    expect(result.current).toBe(first);

    act(() => result.current.setParagraphBatch([{
      id: "paragraph-1",
      bbox: BBOX,
      lines: [],
      rowText: { Key: "1", Note: "Fixture" },
    }]));
    expect(renders).toBe(baseline + 1);
    expect(result.current.paragraphBatch).toHaveLength(1);
    expect(result.current.setParagraphBatch).toBe(first.setParagraphBatch);
  });
});
