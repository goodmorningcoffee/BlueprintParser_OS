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
    setViewerStoreStateForTest({
      publicId: "old-project",
      searchQuery: "needle",
      pageNumber: 7,
      mode: "markup",
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
    // Project reset deliberately retains interaction mode until P2.5 decides survival policy.
    expect(useToolStore.getState().mode).toBe("markup");
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
  it("table close changes only its inline reset list and assigns mode without calling setMode", () => {
    const setMode = vi.fn();
    const tableCellStructure = {
      cells: [],
      pageNumber: 8,
      regionBbox: [0.1, 0.2, 0.8, 0.9] as [number, number, number, number],
    };
    const tableParseOptions = useParseFlowStore.getState().tableParseOptions;
    const polygonVertices = [{ x: 3, y: 4 }];
    const bucketFillPreview = { vertices: [{ x: 1, y: 2 }], method: "sentinel" };
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
      bucketFillActive: true,
      bucketFillPreview,
      symbolSearchActive: true,
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
    expect(changedValueKeys(beforeTool, afterTool)).toEqual(["mode"]);
    expect(afterTool).toMatchObject({
      mode: "move",
      activeTakeoffItemId: 41,
      polygonDrawingMode: "drawing",
      bucketFillActive: true,
      symbolSearchActive: true,
      tempPanMode: true,
    });
    expect(useUiStore.getState()).toMatchObject({
      showTableParsePanel: false,
      showTableCompareModal: true,
    });
    expect(after.tableCellStructure).toBe(tableCellStructure);
    expect(after.tableParseOptions).toBe(tableParseOptions);
    expect(afterTool.polygonVertices).toBe(polygonVertices);
    expect(afterTool.bucketFillPreview).toBe(bucketFillPreview);
    expect(setMode).not.toHaveBeenCalled();
    expect(publications).toEqual(["parse", "tool", "ui"]);
    unsubscribeParse();
    unsubscribeTool();
    unsubscribeUi();
  });

  it("keynote close changes only its inline reset list and preserves saved/highlight state", () => {
    const setMode = vi.fn();
    const parsedKeynoteData = [{
      pageNumber: 8,
      keys: [{ key: "1", description: "Door" }],
    }];
    const activeKeynoteHighlight = { pageNumber: 8, key: "1" };
    const polygonVertices = [{ x: 3, y: 4 }];
    const bucketFillPreview = { vertices: [{ x: 1, y: 2 }], method: "sentinel" };
    useToolStore.setState({ setMode });
    setViewerStoreStateForTest({
      showKeynoteParsePanel: true,
      keynoteParseStep: "review",
      keynoteParseRegion: [0.1, 0.2, 0.8, 0.9],
      keynoteColumnBBs: [[0.1, 0.2, 0.3, 0.9]],
      keynoteRowBBs: [[0.1, 0.2, 0.8, 0.3]],
      keynoteYoloClass: { model: "fixture", className: "keynote" },
      keynoteParseTab: "compare",
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
      bucketFillActive: true,
      bucketFillPreview,
      symbolSearchActive: true,
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
    expect(changedValueKeys(beforeTool, afterTool)).toEqual(["mode"]);
    expect(afterTool).toMatchObject({
      mode: "move",
      activeTakeoffItemId: 41,
      polygonDrawingMode: "drawing",
      bucketFillActive: true,
      symbolSearchActive: true,
      tempPanMode: true,
    });
    expect(useUiStore.getState().showKeynoteParsePanel).toBe(false);
    expect(after.parsedKeynoteData).toBe(parsedKeynoteData);
    expect(useUiStore.getState().activeKeynoteHighlight).toBe(activeKeynoteHighlight);
    expect(afterTool.polygonVertices).toBe(polygonVertices);
    expect(afterTool.bucketFillPreview).toBe(bucketFillPreview);
    expect(setMode).not.toHaveBeenCalled();
    expect(publications).toEqual(["parse", "tool", "ui"]);
    unsubscribeParse();
    unsubscribeTool();
    unsubscribeUi();
  });
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

const DEMO_LOADER = "src/app/demo/project/[id]/page.tsx";

function parseDemoLoader(): ts.SourceFile {
  const absolutePath = join(process.cwd(), DEMO_LOADER);
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

function findLoadTryBlock(source: ts.SourceFile): ts.Block {
  const declarations = descendants(
    source,
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "load",
  );
  expect(declarations).toHaveLength(1);
  const initializer = declarations[0].initializer;
  expect(initializer && ts.isCallExpression(initializer)).toBe(true);
  const callback = (initializer as ts.CallExpression).arguments[0];
  expect(callback && ts.isArrowFunction(callback)).toBe(true);
  const body = (callback as ts.ArrowFunction).body;
  expect(ts.isBlock(body)).toBe(true);
  const tries = (body as ts.Block).statements.filter(ts.isTryStatement);
  expect(tries).toHaveLength(1);
  return tries[0].tryBlock;
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

describe("viewer UI command freeze — demo mixed bootstrap source", () => {
  it("publishes session policy, direct tool defaults, and the UI patch in order before transport", () => {
    const source = parseDemoLoader();
    const tryBlock = findLoadTryBlock(source);
    const calls = descendants(tryBlock, ts.isCallExpression);
    const oneCall = (path: string) => {
      const matches = calls.filter((call) => callPath(call) === path);
      expect(matches).toHaveLength(1);
      return matches[0];
    };
    const reset = oneCall("resetProjectData");
    const demoPolicy = oneCall("setIsDemo");
    const confidence = oneCall("useUiStore.getState().setConfidenceThreshold");
    const parsePatch = oneCall("useParseFlowStore.setState");
    const uiPatch = oneCall("useUiStore.setState");
    const promiseAll = oneCall("Promise.all");

    expect(compact(demoPolicy.arguments[0], source)).toBe("true");
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

    const indexes = [reset, demoPolicy, confidence, parsePatch, uiPatch, promiseAll].map((node) =>
      tryBlock.statements.indexOf(directStatement(node, tryBlock)),
    );
    expect(indexes).toEqual([
      indexes[0],
      indexes[0] + 1,
      indexes[0] + 2,
      indexes[0] + 3,
      indexes[0] + 4,
      indexes[0] + 5,
    ]);
    for (const call of [reset, demoPolicy, confidence, parsePatch, uiPatch]) {
      expect(descendants(directStatement(call, tryBlock), ts.isAwaitExpression)).toHaveLength(0);
    }
  });
});
