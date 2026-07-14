// @vitest-environment node
// [refactor jul11 P2.3 U2] Post-carve characterization for neutral cross-store UI commands.
// These tests pin owner-specific publication count/order, peer-panel timing, and close-reset shapes.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QueryClient } from "@tanstack/react-query";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  navigateYoloTag,
  seedYoloTagsFromBootstrap,
} from "@/queries/useYoloTags";
import { useSessionStore } from "@/stores/sessionStore";
import { useParseFlowStore } from "@/stores/parseFlowStore";
import { useToolStore } from "@/stores/toolStore";
import { useUiStore } from "@/stores/uiStore";
import {
  focusParsedTableRegionInCatalog,
  resetProjectData,
  toggleDetectionPanel,
  toggleKeynoteParsePanel,
  toggleParsePanel,
  toggleTableParsePanel,
  toggleTakeoffPanel,
} from "@/stores/viewerCommands";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { useViewerStore } from "@/stores/viewerStore";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";
import type { YoloTag } from "@/types";

let queryClient: QueryClient;

function restoreViewerStore(): void {
  // The residual viewer now has one complete public metadata reset; use that action instead of a
  // whole-store replacement. The other leaves still need construction-time replacement to restore
  // every action as well as every value after otherwise-impossible competing-tool combinations.
  useViewerStore.getState().resetViewerState();
  useParseFlowStore.setState(useParseFlowStore.getInitialState(), true);
  useToolStore.setState(useToolStore.getInitialState(), true);
  useViewerCoreStore.setState(useViewerCoreStore.getInitialState(), true);
  useUiStore.setState(useUiStore.getInitialState(), true);
  useSessionStore.setState(useSessionStore.getInitialState(), true);
}

beforeEach(() => {
  // queueMicrotask is the only clock used by the peer-panel commands. Faking it lets each test
  // distinguish call-stack publication from the deferred teardown without relying on host timing.
  vi.useFakeTimers({ toFake: ["queueMicrotask"] });
  restoreViewerStore();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  vi.runAllTicks();
  restoreViewerStore();
  queryClient.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function changedValueKeys<T extends object>(before: T, after: T): string[] {
  return Object.keys(before)
    .filter((key) => !Object.is(before[key as keyof T], after[key as keyof T]))
    .sort();
}

function yoloTag(id: string, instances: YoloTag["instances"] = []): YoloTag {
  return {
    id,
    name: id,
    tagText: id,
    yoloClass: "door",
    yoloModel: "fixture-model",
    source: "schedule",
    scope: "project",
    instances,
  };
}

describe("viewer UI command freeze — project reset", () => {
  it("publishes session -> UI -> core -> tool -> parse -> residual viewer synchronously", () => {
    const drawStart = { x: 11, y: 12 };
    const drawEnd = { x: 13, y: 14 };
    const mousePos = { x: 15, y: 16 };
    setViewerStoreStateForTest({
      publicId: "old-project",
      searchQuery: "needle",
      pageNumber: 7,
      mode: "markup",
      _drawing: true,
      _drawStart: drawStart,
      _drawEnd: drawEnd,
      _mousePos: mousePos,
    });
    const publications: string[] = [];
    const unsubscribeSession = useSessionStore.subscribe(() => publications.push("session"));
    const unsubscribeUi = useUiStore.subscribe(() => publications.push("ui"));
    const unsubscribeCore = useViewerCoreStore.subscribe(() => publications.push("core"));
    const unsubscribeTool = useToolStore.subscribe(() => publications.push("tool"));
    const unsubscribeParse = useParseFlowStore.subscribe(() => publications.push("parse"));
    const unsubscribeViewer = useViewerStore.subscribe(() => publications.push("viewer"));

    resetProjectData();

    expect(publications).toEqual(["session", "ui", "core", "tool", "parse", "viewer"]);
    expect(useSessionStore.getState().publicId).toBe("");
    expect(useUiStore.getState().searchQuery).toBe("");
    expect(useViewerCoreStore.getState().pageNumber).toBe(1);
    expect(useToolStore.getState().mode).toBe("move");
    expect(useToolStore.getState()._drawing).toBe(false);
    expect(useToolStore.getState()._drawStart).toEqual({ x: 0, y: 0 });
    expect(useToolStore.getState()._drawEnd).toEqual({ x: 0, y: 0 });
    expect(useToolStore.getState()._mousePos).toBeNull();
    unsubscribeSession();
    unsubscribeUi();
    unsubscribeCore();
    unsubscribeTool();
    unsubscribeParse();
    unsubscribeViewer();
  });
});

describe("viewer UI command freeze — takeoff panel", () => {
  it("opens over chat without clearing the active item or either history stack", () => {
    const undo = useToolStore.getState().takeoffUndoStack.slice();
    const redo = useToolStore.getState().takeoffRedoStack.slice();
    setViewerStoreStateForTest({
      showTakeoffPanel: false,
      showChatPanel: true,
      activeTakeoffItemId: 41,
      takeoffUndoStack: undo,
      takeoffRedoStack: redo,
    });

    const publications: string[] = [];
    const unsubscribeTool = useToolStore.subscribe(() => publications.push("tool"));
    const unsubscribeUi = useUiStore.subscribe(() => publications.push("ui"));
    toggleTakeoffPanel();

    const state = useToolStore.getState();
    expect(useUiStore.getState()).toMatchObject({
      showTakeoffPanel: true,
      showChatPanel: false,
    });
    expect(state).toMatchObject({
      activeTakeoffItemId: 41,
    });
    expect(publications).toEqual(["ui"]);
    expect(state.takeoffUndoStack).toBe(undo);
    expect(state.takeoffRedoStack).toBe(redo);
    unsubscribeTool();
    unsubscribeUi();
  });

  it("closes with a direct active-id clear, preserving chat and both history references", () => {
    const undo = useToolStore.getState().takeoffUndoStack.slice();
    const redo = useToolStore.getState().takeoffRedoStack.slice();
    setViewerStoreStateForTest({
      showTakeoffPanel: true,
      showChatPanel: true,
      activeTakeoffItemId: 41,
      takeoffUndoStack: undo,
      takeoffRedoStack: redo,
    });

    const publications: string[] = [];
    const unsubscribeTool = useToolStore.subscribe(() => publications.push("tool"));
    const unsubscribeUi = useUiStore.subscribe(() => publications.push("ui"));
    toggleTakeoffPanel();

    const state = useToolStore.getState();
    expect(useUiStore.getState()).toMatchObject({
      showTakeoffPanel: false,
      showChatPanel: true,
    });
    expect(state).toMatchObject({
      activeTakeoffItemId: null,
    });
    expect(publications).toEqual(["tool", "ui"]);
    // setActiveTakeoffItemId(null) would allocate two new empty arrays. The compound toggle does
    // not call that action; undo/redo history survives the panel close.
    expect(state.takeoffUndoStack).toBe(undo);
    expect(state.takeoffRedoStack).toBe(redo);
    unsubscribeTool();
    unsubscribeUi();
  });
});

const peerPanelScenarios = [
  {
    label: "detection host with parse peer",
    closedHostSeed: { showDetectionPanel: true, showParsePanel: false },
    openPeerSeed: { showParsePanel: true },
    closePeerSeed: { showParsePanel: false },
    hostKey: "showDetectionPanel" as const,
    toggle: toggleDetectionPanel,
  },
  {
    label: "parse host with detection peer",
    closedHostSeed: { showParsePanel: true, showDetectionPanel: false },
    openPeerSeed: { showDetectionPanel: true },
    closePeerSeed: { showDetectionPanel: false },
    hostKey: "showParsePanel" as const,
    toggle: toggleParsePanel,
  },
] as const;

describe("viewer UI command freeze — peer-host teardown", () => {
  for (const scenario of peerPanelScenarios) {
    it(`${scenario.label}: decides from the peer at call time, then resets in a microtask`, () => {
      useUiStore.setState(scenario.closedHostSeed);
      useToolStore.setState({ mode: "markup" });
      useParseFlowStore.setState({ tableParseStep: "review" });

      scenario.toggle();

      expect(useUiStore.getState()[scenario.hostKey]).toBe(false);
      expect(useToolStore.getState().mode).toBe("markup");
      expect(useParseFlowStore.getState().tableParseStep).toBe("review");

      // Opening the peer after the close call does not cancel the already-queued teardown.
      useUiStore.setState(scenario.openPeerSeed);
      expect(useToolStore.getState().mode).toBe("markup");
      vi.runAllTicks();
      expect(useToolStore.getState().mode).toBe("move");
      expect(useParseFlowStore.getState().tableParseStep).toBe("idle");
    });

    it(`${scenario.label}: an open peer at call time suppresses teardown permanently`, () => {
      useUiStore.setState({ ...scenario.closedHostSeed, ...scenario.openPeerSeed });
      useToolStore.setState({ mode: "markup" });

      scenario.toggle();
      // Closing the peer before microtasks drain does not retroactively schedule a reset.
      useUiStore.setState(scenario.closePeerSeed);
      vi.runAllTicks();

      expect(useUiStore.getState()[scenario.hostKey]).toBe(false);
      expect(useToolStore.getState().mode).toBe("markup");
    });

    it(`${scenario.label}: opening the host never schedules teardown`, () => {
      restoreViewerStore();
      useUiStore.setState(scenario.closePeerSeed);
      useToolStore.setState({ mode: "markup" });

      scenario.toggle();
      vi.runAllTicks();

      expect(useUiStore.getState()[scenario.hostKey]).toBe(true);
      expect(useToolStore.getState().mode).toBe("markup");
    });
  }
});

describe("viewer UI command freeze — parser-panel close shapes", () => {
  it("table close changes only its inline reset list and preserves an unrelated exact tool", () => {
    const setMode = vi.fn();
    const tableCellStructure = {
      cells: [],
      pageNumber: 8,
      regionBbox: [0.1, 0.2, 0.8, 0.9] as [number, number, number, number],
    };
    const tableParseOptions = useParseFlowStore.getState().tableParseOptions;
    const polygonVertices = [{ x: 3, y: 4 }];
    const bucketFillPreview = { vertices: [{ x: 1, y: 2 }], method: "sentinel" };
    const activeTool = { kind: "bucketFill" } as const;
    useToolStore.setState({ setMode });
    setViewerStoreStateForTest({
      showTableParsePanel: true,
      tableParseStep: "review",
      tableParseRegion: [0.1, 0.2, 0.8, 0.9],
      tableParsedGrid: { headers: ["Tag"], rows: [{ Tag: "D-101" }] },
      tableParseMeta: {
        methodResults: [],
        baseMethod: "merged",
        mergedSnapshot: { headers: ["Tag"], rows: [{ Tag: "D-101" }] },
      },
      tableParseColumnBBs: [[0.1, 0.2, 0.3, 0.9]],
      tableParseColumnNames: ["Tag"],
      tableParseRowBBs: [[0.1, 0.2, 0.8, 0.3]],
      tableParseTab: "compare",
      guidedParseOwner: "table",
      guidedParseActive: true,
      guidedParseRegion: [0.1, 0.2, 0.8, 0.9],
      guidedParseRows: [0.4],
      guidedParseCols: [0.5],
      mode: "markup",
      tableCellStructure,
      showTableCellStructure: true,
      tableParseOptions,
      showTableCompareModal: true,
      activeTakeoffItemId: 41,
      polygonDrawingMode: "drawing",
      polygonVertices,
      activeTool,
      bucketFillPreview,
      tempPanMode: true,
    });
    const before = useParseFlowStore.getState();
    const beforeTool = useToolStore.getState();
    const beforeUi = useUiStore.getState();
    const publications: string[] = [];
    const unsubscribeParse = useParseFlowStore.subscribe(() => publications.push("parse"));
    const unsubscribeTool = useToolStore.subscribe(() => publications.push("tool"));
    const unsubscribeUi = useUiStore.subscribe(() => publications.push("ui"));

    toggleTableParsePanel();

    const after = useParseFlowStore.getState();
    const afterTool = useToolStore.getState();
    expect(changedValueKeys(before, after)).toEqual([
      "guidedParseActive",
      "guidedParseCols",
      "guidedParseOwner",
      "guidedParseRegion",
      "guidedParseRows",
      "parseOperations",
      "tableParseColumnBBs",
      "tableParseColumnNames",
      "tableParseMeta",
      "tableParseRegion",
      "tableParseRowBBs",
      "tableParseStep",
      "tableParseTab",
      "tableParsedGrid",
    ]);
    expect(changedValueKeys(beforeUi, useUiStore.getState())).toEqual(["showTableParsePanel"]);
    expect(after).toMatchObject({
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
      showTableCellStructure: true,
    });
    expect(changedValueKeys(beforeTool, afterTool)).toEqual([]);
    expect(afterTool).toMatchObject({
      mode: "markup",
      activeTakeoffItemId: 41,
      polygonDrawingMode: "drawing",
      activeTool,
      tempPanMode: true,
    });
    expect(useUiStore.getState()).toMatchObject({
      showTableParsePanel: false,
      showTableCompareModal: true,
    });
    expect(after.tableCellStructure).toBe(tableCellStructure);
    expect(after.tableParseOptions).toBe(tableParseOptions);
    expect(afterTool.activeTool).toBe(activeTool);
    expect(afterTool.polygonVertices).toBe(polygonVertices);
    expect(afterTool.bucketFillPreview).toBe(bucketFillPreview);
    expect(setMode).not.toHaveBeenCalled();
    expect(publications).toEqual(["ui", "parse"]);
    unsubscribeParse();
    unsubscribeTool();
    unsubscribeUi();
  });

  it("keynote close preserves saved/highlight state and an unrelated exact tool", () => {
    const setMode = vi.fn();
    const parsedKeynoteData = [{
      pageNumber: 8,
      keys: [{ key: "1", description: "Door" }],
    }];
    const activeKeynoteHighlight = { pageNumber: 8, key: "1" };
    const polygonVertices = [{ x: 3, y: 4 }];
    const bucketFillPreview = { vertices: [{ x: 1, y: 2 }], method: "sentinel" };
    const activeTool = { kind: "symbolTemplate" } as const;
    useToolStore.setState({ setMode });
    setViewerStoreStateForTest({
      showKeynoteParsePanel: true,
      keynoteParseStep: "review",
      keynoteParseRegion: [0.1, 0.2, 0.8, 0.9],
      keynoteColumnBBs: [[0.1, 0.2, 0.3, 0.9]],
      keynoteRowBBs: [[0.1, 0.2, 0.8, 0.3]],
      keynoteYoloClass: { model: "fixture", className: "keynote" },
      keynoteParseTab: "compare",
      guidedParseOwner: "keynote",
      guidedParseActive: true,
      guidedParseRegion: [0.1, 0.2, 0.8, 0.9],
      guidedParseRows: [0.4],
      guidedParseCols: [0.5],
      mode: "markup",
      parsedKeynoteData,
      activeKeynoteHighlight,
      activeTakeoffItemId: 41,
      polygonDrawingMode: "drawing",
      polygonVertices,
      activeTool,
      bucketFillPreview,
      tempPanMode: true,
    });
    const before = useParseFlowStore.getState();
    const beforeTool = useToolStore.getState();
    const beforeUi = useUiStore.getState();
    const publications: string[] = [];
    const unsubscribeParse = useParseFlowStore.subscribe(() => publications.push("parse"));
    const unsubscribeTool = useToolStore.subscribe(() => publications.push("tool"));
    const unsubscribeUi = useUiStore.subscribe(() => publications.push("ui"));

    toggleKeynoteParsePanel();

    const after = useParseFlowStore.getState();
    const afterTool = useToolStore.getState();
    expect(changedValueKeys(before, after)).toEqual([
      "guidedParseActive",
      "guidedParseCols",
      "guidedParseOwner",
      "guidedParseRegion",
      "guidedParseRows",
      "keynoteColumnBBs",
      "keynoteParseRegion",
      "keynoteParseStep",
      "keynoteParseTab",
      "keynoteRowBBs",
      "keynoteYoloClass",
      "parseOperations",
    ]);
    expect(changedValueKeys(beforeUi, useUiStore.getState())).toEqual(["showKeynoteParsePanel"]);
    expect(after).toMatchObject({
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
    });
    expect(changedValueKeys(beforeTool, afterTool)).toEqual([]);
    expect(afterTool).toMatchObject({
      mode: "markup",
      activeTakeoffItemId: 41,
      polygonDrawingMode: "drawing",
      activeTool,
      tempPanMode: true,
    });
    expect(useUiStore.getState().showKeynoteParsePanel).toBe(false);
    expect(after.parsedKeynoteData).toBe(parsedKeynoteData);
    expect(useUiStore.getState().activeKeynoteHighlight).toBe(activeKeynoteHighlight);
    expect(afterTool.activeTool).toBe(activeTool);
    expect(afterTool.polygonVertices).toBe(polygonVertices);
    expect(afterTool.bucketFillPreview).toBe(bucketFillPreview);
    expect(setMode).not.toHaveBeenCalled();
    expect(publications).toEqual(["ui", "parse"]);
    unsubscribeParse();
    unsubscribeTool();
    unsubscribeUi();
  });

  const reentrantCloseScenarios = [
    {
      label: "table",
      kind: "table" as const,
      panelKey: "showTableParsePanel" as const,
      seedPanel: () => useUiStore.setState({ showTableParsePanel: true }),
      reopenPanel: () =>
        useUiStore.getState().setPanelVisibility({ showTableParsePanel: true }),
      close: toggleTableParsePanel,
    },
    {
      label: "keynote",
      kind: "keynote" as const,
      panelKey: "showKeynoteParsePanel" as const,
      seedPanel: () => useUiStore.setState({ showKeynoteParsePanel: true }),
      reopenPanel: () =>
        useUiStore.getState().setPanelVisibility({ showKeynoteParsePanel: true }),
      close: toggleKeynoteParsePanel,
    },
  ] as const;

  for (const scenario of reentrantCloseScenarios) {
    for (const settleReplacement of [false, true]) {
      it(`${scenario.label} close has no UI/tool tail after a synchronous ${
        settleReplacement ? "settled" : "busy"
      } replacement`, () => {
        scenario.seedPanel();
        useToolStore.setState({ mode: "markup" });

        const publications: string[] = [];
        let replacementStarted = false;
        let replacementRevision: number | null = null;
        const unsubscribeUi = useUiStore.subscribe(() => publications.push("ui"));
        const unsubscribeTool = useToolStore.subscribe(() => publications.push("tool"));
        const unsubscribeParse = useParseFlowStore.subscribe(() => {
          publications.push("parse");
          if (replacementStarted) return;

          replacementStarted = true;
          // B reacts synchronously to A's terminal Parse publication. Any later A presentation or
          // tool write would now erase these replacement-owned destinations.
          scenario.reopenPanel();
          useToolStore.setState({ mode: "pointer" });
          const started = useParseFlowStore.getState().beginParseOperation(scenario.kind);
          expect(started.status).toBe("started");
          if (started.status !== "started") return;
          replacementRevision = started.token.revision;
          if (settleReplacement) {
            expect(useParseFlowStore.getState().finishParseOperation(started.token)).toBe(true);
          }
        });

        scenario.close();

        expect(replacementStarted).toBe(true);
        expect(replacementRevision).not.toBeNull();
        expect(publications).toEqual([
          "ui",
          "parse",
          "ui",
          "tool",
          "parse",
          ...(settleReplacement ? ["parse"] : []),
        ]);
        expect(useUiStore.getState()[scenario.panelKey]).toBe(true);
        expect(useToolStore.getState().mode).toBe("pointer");
        expect(useParseFlowStore.getState().parseOperations[scenario.kind]).toEqual({
          revision: replacementRevision,
          busy: !settleReplacement,
        });

        unsubscribeUi();
        unsubscribeTool();
        unsubscribeParse();
      });
    }
  }
});

describe("viewer UI command freeze — parsed Table catalog focus", () => {
  it("publishes one complete UI destination before one terminal Table tab handoff", () => {
    useUiStore.setState({
      showTableParsePanel: false,
      focusedParsedRegionId: "old-region",
    });
    useParseFlowStore.setState({ tableParseTab: "manual" });
    useToolStore.setState({ mode: "markup" });
    const started = useParseFlowStore.getState().beginParseOperation("table");
    expect(started.status).toBe("started");
    if (started.status !== "started") return;
    const beforeOperations = useParseFlowStore.getState().parseOperations;
    const beforeTool = useToolStore.getState();
    const trace: string[] = [];
    const unsubscribeUi = useUiStore.subscribe(() => trace.push("ui"));
    const unsubscribeParse = useParseFlowStore.subscribe(() => trace.push("parse"));
    const unsubscribeTool = useToolStore.subscribe(() => trace.push("tool"));

    try {
      focusParsedTableRegionInCatalog("target-region");
    } finally {
      unsubscribeTool();
      unsubscribeParse();
      unsubscribeUi();
    }

    expect(trace).toEqual(["ui", "parse"]);
    expect(useUiStore.getState()).toMatchObject({
      showTableParsePanel: true,
      focusedParsedRegionId: "target-region",
    });
    expect(useParseFlowStore.getState().tableParseTab).toBe("all");
    expect(useParseFlowStore.getState().parseOperations.table).toEqual({
      revision: started.token.revision + 1,
      busy: false,
    });
    for (const kind of ["keynote", "notes", "spec"] as const) {
      expect(useParseFlowStore.getState().parseOperations[kind]).toBe(beforeOperations[kind]);
    }
    expect(useToolStore.getState()).toBe(beforeTool);
  });

  for (const settleReplacement of [false, true]) {
    it(`has no post-Parse UI tail after synchronous Table B becomes ${
      settleReplacement ? "settled" : "busy"
    }`, () => {
      useUiStore.setState({
        showTableParsePanel: false,
        focusedParsedRegionId: "old-region",
      });
      useParseFlowStore.setState({ tableParseTab: "manual" });
      const publications: string[] = [];
      let armed = true;
      let revisionB: number | null = null;
      const unsubscribeUi = useUiStore.subscribe(() => publications.push("ui"));
      const unsubscribeParse = useParseFlowStore.subscribe((state) => {
        publications.push("parse");
        if (!armed) return;
        armed = false;
        const started = state.beginParseOperation("table");
        expect(started.status).toBe("started");
        if (started.status !== "started") return;
        revisionB = started.token.revision;
        if (settleReplacement) {
          expect(useParseFlowStore.getState().finishParseOperation(started.token)).toBe(true);
        }
        useParseFlowStore.setState({ tableParseTab: "guided" });
        useUiStore.setState({
          showTableParsePanel: false,
          focusedParsedRegionId: "replacement-region",
        });
      });

      try {
        focusParsedTableRegionInCatalog("target-region");
      } finally {
        unsubscribeParse();
        unsubscribeUi();
      }

      expect(revisionB).not.toBeNull();
      expect(publications).toEqual([
        "ui",
        "parse",
        "parse",
        ...(settleReplacement ? ["parse"] : []),
        "parse",
        "ui",
      ]);
      expect(useParseFlowStore.getState().parseOperations.table).toEqual({
        revision: revisionB,
        busy: !settleReplacement,
      });
      expect(useParseFlowStore.getState().tableParseTab).toBe("guided");
      expect(useUiStore.getState()).toMatchObject({
        showTableParsePanel: false,
        focusedParsedRegionId: "replacement-region",
      });
    });
  }
});

describe("viewer UI command freeze — YOLO browse navigation", () => {
  it("keeps absent tags publication-free and gives empty tags one current-store merge", () => {
    seedYoloTagsFromBootstrap(queryClient, "project-A", {
      yoloTags: [yoloTag("empty")],
    });
    const oldHighlight = {
      pageNumber: 7,
      bbox: [0, 0, 1, 1] as [number, number, number, number],
      label: "old",
    };
    setViewerStoreStateForTest({
      pageNumber: 7,
      searchQuery: "unrelated-current-value",
      activeYoloTagId: "old",
      tagBrowseId: "old",
      tagBrowseIndex: 3,
      llmHighlight: oldHighlight,
    });
    const missingCoreBaseline = useViewerCoreStore.getState();
    const missingUiBaseline = useUiStore.getState();
    const publications: string[] = [];
    const unsubscribeCore = useViewerCoreStore.subscribe(() => publications.push("core"));
    const unsubscribeUi = useUiStore.subscribe(() => publications.push("ui"));

    navigateYoloTag(queryClient, "project-A", "missing", 99);
    expect(publications).toEqual([]);
    expect(useViewerCoreStore.getState()).toBe(missingCoreBaseline);
    expect(useUiStore.getState()).toBe(missingUiBaseline);

    navigateYoloTag(queryClient, "project-A", "empty", 99);
    unsubscribeCore();
    unsubscribeUi();

    expect(publications).toEqual(["ui"]);
    expect(useViewerCoreStore.getState()).toBe(missingCoreBaseline);
    expect(useViewerCoreStore.getState().pageNumber).toBe(7);
    expect(useUiStore.getState()).toMatchObject({
      searchQuery: "unrelated-current-value",
      activeYoloTagId: "empty",
      tagBrowseId: "empty",
      tagBrowseIndex: 0,
      llmHighlight: null,
    });
  });

  it("wraps indexes and publishes raw page first, then one UI bundle", () => {
    const instances: YoloTag["instances"] = [
      { pageNumber: 2, annotationId: 1, bbox: [0, 0, 0.1, 0.1], confidence: 1 },
      { pageNumber: 5, annotationId: 2, bbox: [0.2, 0.2, 0.3, 0.3], confidence: 1 },
    ];
    seedYoloTagsFromBootstrap(queryClient, "project-A", {
      yoloTags: [yoloTag("D-201", instances)],
    });
    useUiStore.setState({ searchQuery: "preserve-me" });
    const publications: string[] = [];
    const uiObservedPages: number[] = [];
    const unsubscribeCore = useViewerCoreStore.subscribe(() => publications.push("core"));
    const unsubscribeUi = useUiStore.subscribe(() => {
      publications.push("ui");
      uiObservedPages.push(useViewerCoreStore.getState().pageNumber);
    });

    navigateYoloTag(queryClient, "project-A", "D-201", -1);

    expect(publications).toEqual(["core", "ui"]);
    expect(uiObservedPages).toEqual([5]);
    expect(useViewerCoreStore.getState().pageNumber).toBe(5);
    expect(useUiStore.getState()).toMatchObject({
      searchQuery: "preserve-me",
      activeYoloTagId: "D-201",
      tagBrowseId: "D-201",
      tagBrowseIndex: 1,
      llmHighlight: {
        pageNumber: 5,
        bbox: [0.2, 0.2, 0.3, 0.3],
        label: "D-201 — 2 of 2",
      },
    });

    navigateYoloTag(queryClient, "project-A", "D-201", 4);
    unsubscribeCore();
    unsubscribeUi();

    expect(publications).toEqual(["core", "ui", "core", "ui"]);
    expect(uiObservedPages).toEqual([5, 2]);
    expect(useViewerCoreStore.getState().pageNumber).toBe(2);
    expect(useUiStore.getState()).toMatchObject({
      searchQuery: "preserve-me",
      tagBrowseIndex: 0,
      llmHighlight: {
        pageNumber: 2,
        bbox: [0, 0, 0.1, 0.1],
        label: "D-201 — 1 of 2",
      },
    });
  });
});

const PROJECT_LIFECYCLE = "src/lib/project-lifecycle.ts";

function parseProjectLifecycle(): ts.SourceFile {
  const absolutePath = join(process.cwd(), PROJECT_LIFECYCLE);
  return ts.createSourceFile(
    absolutePath,
    readFileSync(absolutePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

function descendants<T extends ts.Node>(
  root: ts.Node,
  predicate: (node: ts.Node) => node is T,
): T[] {
  const matches: T[] = [];
  const visit = (node: ts.Node) => {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return matches;
}

function compact(node: ts.Node, source: ts.SourceFile): string {
  return node.getText(source).replace(/\s+/g, "");
}

function findFunctionBody(source: ts.SourceFile, name: string): ts.Block {
  const declarations = descendants(
    source,
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  expect(declarations).toHaveLength(1);
  expect(declarations[0].body).toBeDefined();
  return declarations[0].body!;
}

function directStatement(node: ts.Node, block: ts.Block): ts.Statement {
  let current = node;
  while (current.parent && current.parent !== block) current = current.parent;
  expect(current.parent).toBe(block);
  return current as ts.Statement;
}

function callPath(call: ts.CallExpression): string {
  const parts: string[] = [];
  let expression: ts.Expression = call.expression;
  while (ts.isPropertyAccessExpression(expression)) {
    parts.unshift(expression.name.text);
    expression = expression.expression;
    if (ts.isCallExpression(expression)) {
      parts.unshift(`${callPath(expression)}()`);
      return parts.join(".");
    }
  }
  if (ts.isIdentifier(expression)) parts.unshift(expression.text);
  return parts.join(".");
}

describe("viewer UI command freeze — unified project lifecycle", () => {
  it("applies demo tuning during adoption and publishes session activation last", () => {
    const source = parseProjectLifecycle();
    const adoptBody = findFunctionBody(source, "adoptProject");
    const calls = descendants(adoptBody, ts.isCallExpression);
    const oneCall = (path: string) => {
      const matches = calls.filter((call) => callPath(call) === path);
      expect(matches).toHaveLength(1);
      return matches[0];
    };
    const confidence = oneCall("ui.setConfidenceThreshold");
    const parsePatch = oneCall("useParseFlowStore.setState");
    const uiPatch = oneCall("useUiStore.setState");
    const corePatch = oneCall("useViewerCoreStore.setState");
    const activation = oneCall("useSessionStore.setState");
    const catalogSeeds = calls.filter(
      (call) => callPath(call) === "seedProjectCatalogsCache",
    );
    expect(catalogSeeds).toHaveLength(2);
    expect(compact(catalogSeeds[0].arguments[2], source)).toBe("null");
    expect(compact(catalogSeeds[1].arguments[2], source)).toBe(
      "deriveProjectCatalogs(data.summaries,chunk?.pages,options.demo)",
    );
    const catalogSeedIndexes = catalogSeeds.map((call) =>
      adoptBody.statements.indexOf(directStatement(call, adoptBody)));
    expect(catalogSeedIndexes[1]).toBe(catalogSeedIndexes[0] + 2);
    for (const seedIndex of catalogSeedIndexes) {
      expect(compact(adoptBody.statements[seedIndex + 1], source)).toBe(
        "if(!canPublish())returnfalse;",
      );
    }

    expect(compact(confidence.arguments[0], source)).toBe("0");
    expect(parsePatch.arguments).toHaveLength(1);
    expect(compact(parsePatch.arguments[0], source)).toBe('{tableParseTab:"auto"}');
    expect(uiPatch.arguments).toHaveLength(1);
    expect(ts.isObjectLiteralExpression(uiPatch.arguments[0])).toBe(true);
    const properties = Object.fromEntries(
      (uiPatch.arguments[0] as ts.ObjectLiteralExpression).properties.map((property) => {
        expect(ts.isPropertyAssignment(property)).toBe(true);
        const assignment = property as ts.PropertyAssignment;
        expect(ts.isIdentifier(assignment.name)).toBe(true);
        return [(assignment.name as ts.Identifier).text, compact(assignment.initializer, source)];
      }),
    );
    expect(properties).toEqual({
      helpMode: "false",
      showTips: "false",
      showChatPanel: "false",
      showTableParsePanel: "true",
    });

    const demoIfs = adoptBody.statements.filter(
      (statement): statement is ts.IfStatement =>
        ts.isIfStatement(statement) && compact(statement.expression, source) === "options.demo",
    );
    expect(demoIfs).toHaveLength(1);
    for (const call of [confidence, parsePatch, uiPatch]) {
      expect(directStatement(call, adoptBody)).toBe(demoIfs[0]);
    }

    expect(ts.isObjectLiteralExpression(activation.arguments[0])).toBe(true);
    const activationProperties = Object.fromEntries(
      (activation.arguments[0] as ts.ObjectLiteralExpression).properties.map((property) => {
        if (ts.isShorthandPropertyAssignment(property)) {
          return [property.name.text, property.name.text];
        }
        expect(ts.isPropertyAssignment(property)).toBe(true);
        const assignment = property as ts.PropertyAssignment;
        expect(ts.isIdentifier(assignment.name)).toBe(true);
        return [(assignment.name as ts.Identifier).text, compact(assignment.initializer, source)];
      }),
    );
    expect(activationProperties).toMatchObject({
      publicId: "publicId",
      isDemo: "options.demo",
      demoFeatureConfig: "options.demo?(data.demoConfig??null):null",
    });

    const activationStatement = directStatement(activation, adoptBody);
    // Session activation is the final publication. The sole following statement must recheck the
    // exact lifecycle token because a synchronous session subscriber can start successor B during
    // setState; A must then report superseded rather than reveal stale route-local state.
    expect(adoptBody.statements.at(-2)).toBe(activationStatement);
    const authorityReturn = adoptBody.statements.at(-1)!;
    expect(ts.isReturnStatement(authorityReturn)).toBe(true);
    expect(compact((authorityReturn as ts.ReturnStatement).expression!, source)).toBe(
      "canPublish()",
    );
    const activationIndex = adoptBody.statements.indexOf(activationStatement);
    const preparedBeforeActivation = [
      "seedYoloTagsFromBootstrap",
      "seedCsiGraphFromBootstrap",
      "seedSummariesCache",
      "seedChatCache",
      "seedTakeoffCache",
      "seedAnnotationGroupsCache",
      "queryClient.setQueryData",
      "publishBootstrapPageWindow",
    ].map(oneCall);
    for (const call of [...preparedBeforeActivation, ...catalogSeeds, corePatch]) {
      expect(adoptBody.statements.indexOf(directStatement(call, adoptBody))).toBeLessThan(
        activationIndex,
      );
    }
    expect(descendants(adoptBody, ts.isAwaitExpression)).toHaveLength(0);
  });
});
