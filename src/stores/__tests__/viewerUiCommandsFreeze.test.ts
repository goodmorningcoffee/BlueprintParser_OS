// @vitest-environment node
// [refactor jul11 P2.3 U0] Characterization for compound commands that still live in the
// monolithic viewerStore. These tests deliberately pin publication count, peer-panel timing,
// and the uneven close-reset shapes before the UI command/store carve changes their owner.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QueryClient } from "@tanstack/react-query";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  navigateYoloTag,
  seedYoloTagsFromBootstrap,
} from "@/queries/useYoloTags";
import { useViewerStore } from "@/stores/viewerStore";
import type { YoloTag } from "@/types";

let queryClient: QueryClient;

function restoreViewerStore(): void {
  // Replacing with Zustand's construction-time state restores every action as well as every
  // value. resetViewerState intentionally preserves several tool fields, so it is not sufficient
  // isolation for characterization that seeds otherwise-impossible competing-tool combinations.
  useViewerStore.setState(useViewerStore.getInitialState(), true);
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

function changedValueKeys(
  before: ReturnType<typeof useViewerStore.getState>,
  after: ReturnType<typeof useViewerStore.getState>,
): string[] {
  return Object.keys(before)
    .filter((key) => !Object.is(before[key as keyof typeof before], after[key as keyof typeof after]))
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

describe("viewer UI command freeze — takeoff panel", () => {
  it("opens over chat without clearing the active item or either history stack", () => {
    const undo = useViewerStore.getState().takeoffUndoStack.slice();
    const redo = useViewerStore.getState().takeoffRedoStack.slice();
    useViewerStore.setState({
      showTakeoffPanel: false,
      showChatPanel: true,
      activeTakeoffItemId: 41,
      takeoffUndoStack: undo,
      takeoffRedoStack: redo,
    });

    useViewerStore.getState().toggleTakeoffPanel();

    const state = useViewerStore.getState();
    expect(state).toMatchObject({
      showTakeoffPanel: true,
      showChatPanel: false,
      activeTakeoffItemId: 41,
    });
    expect(state.takeoffUndoStack).toBe(undo);
    expect(state.takeoffRedoStack).toBe(redo);
  });

  it("closes with a direct active-id clear, preserving chat and both history references", () => {
    const undo = useViewerStore.getState().takeoffUndoStack.slice();
    const redo = useViewerStore.getState().takeoffRedoStack.slice();
    useViewerStore.setState({
      showTakeoffPanel: true,
      showChatPanel: true,
      activeTakeoffItemId: 41,
      takeoffUndoStack: undo,
      takeoffRedoStack: redo,
    });

    useViewerStore.getState().toggleTakeoffPanel();

    const state = useViewerStore.getState();
    expect(state).toMatchObject({
      showTakeoffPanel: false,
      showChatPanel: true,
      activeTakeoffItemId: null,
    });
    // setActiveTakeoffItemId(null) would allocate two new empty arrays. The compound toggle does
    // not call that action; undo/redo history survives the panel close.
    expect(state.takeoffUndoStack).toBe(undo);
    expect(state.takeoffRedoStack).toBe(redo);
  });
});

const peerPanelScenarios = [
  {
    label: "detection host with parse peer",
    closedHostSeed: { showDetectionPanel: true, showParsePanel: false },
    openPeerSeed: { showParsePanel: true },
    closePeerSeed: { showParsePanel: false },
    hostKey: "showDetectionPanel" as const,
    toggle: () => useViewerStore.getState().toggleDetectionPanel(),
  },
  {
    label: "parse host with detection peer",
    closedHostSeed: { showParsePanel: true, showDetectionPanel: false },
    openPeerSeed: { showDetectionPanel: true },
    closePeerSeed: { showDetectionPanel: false },
    hostKey: "showParsePanel" as const,
    toggle: () => useViewerStore.getState().toggleParsePanel(),
  },
] as const;

describe("viewer UI command freeze — peer-host teardown", () => {
  for (const scenario of peerPanelScenarios) {
    it(`${scenario.label}: decides from the peer at call time, then resets in a microtask`, () => {
      const resetAllTools = vi.fn();
      useViewerStore.setState({ ...scenario.closedHostSeed, resetAllTools });

      scenario.toggle();

      expect(useViewerStore.getState()[scenario.hostKey]).toBe(false);
      expect(resetAllTools).not.toHaveBeenCalled();

      // Opening the peer after the close call does not cancel the already-queued teardown.
      useViewerStore.setState(scenario.openPeerSeed);
      expect(resetAllTools).not.toHaveBeenCalled();
      vi.runAllTicks();
      expect(resetAllTools).toHaveBeenCalledTimes(1);
    });

    it(`${scenario.label}: an open peer at call time suppresses teardown permanently`, () => {
      const resetAllTools = vi.fn();
      useViewerStore.setState({ ...scenario.closedHostSeed, ...scenario.openPeerSeed, resetAllTools });

      scenario.toggle();
      // Closing the peer before microtasks drain does not retroactively schedule a reset.
      useViewerStore.setState(scenario.closePeerSeed);
      vi.runAllTicks();

      expect(useViewerStore.getState()[scenario.hostKey]).toBe(false);
      expect(resetAllTools).not.toHaveBeenCalled();
    });

    it(`${scenario.label}: opening the host never schedules teardown`, () => {
      restoreViewerStore();
      const resetAllTools = vi.fn();
      useViewerStore.setState({ ...scenario.closePeerSeed, resetAllTools });

      scenario.toggle();
      vi.runAllTicks();

      expect(useViewerStore.getState()[scenario.hostKey]).toBe(true);
      expect(resetAllTools).not.toHaveBeenCalled();
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
    const tableParseOptions = useViewerStore.getState().tableParseOptions;
    const polygonVertices = [{ x: 3, y: 4 }];
    const bucketFillPreview = { vertices: [{ x: 1, y: 2 }], method: "sentinel" };
    useViewerStore.setState({
      setMode,
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
    const before = useViewerStore.getState();

    before.toggleTableParsePanel();

    const after = useViewerStore.getState();
    expect(changedValueKeys(before, after)).toEqual([
      "guidedParseActive",
      "guidedParseCols",
      "guidedParseRegion",
      "guidedParseRows",
      "mode",
      "showTableParsePanel",
      "tableParseColumnBBs",
      "tableParseColumnNames",
      "tableParseMeta",
      "tableParseRegion",
      "tableParseRowBBs",
      "tableParseStep",
      "tableParseTab",
      "tableParsedGrid",
    ]);
    expect(after).toMatchObject({
      showTableParsePanel: false,
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
      mode: "move",
      showTableCellStructure: true,
      showTableCompareModal: true,
      activeTakeoffItemId: 41,
      polygonDrawingMode: "drawing",
      bucketFillActive: true,
      symbolSearchActive: true,
      tempPanMode: true,
    });
    expect(after.tableCellStructure).toBe(tableCellStructure);
    expect(after.tableParseOptions).toBe(tableParseOptions);
    expect(after.polygonVertices).toBe(polygonVertices);
    expect(after.bucketFillPreview).toBe(bucketFillPreview);
    expect(setMode).not.toHaveBeenCalled();
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
    useViewerStore.setState({
      setMode,
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
    const before = useViewerStore.getState();

    before.toggleKeynoteParsePanel();

    const after = useViewerStore.getState();
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
      "mode",
      "showKeynoteParsePanel",
    ]);
    expect(after).toMatchObject({
      showKeynoteParsePanel: false,
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
      mode: "move",
      activeTakeoffItemId: 41,
      polygonDrawingMode: "drawing",
      bucketFillActive: true,
      symbolSearchActive: true,
      tempPanMode: true,
    });
    expect(after.parsedKeynoteData).toBe(parsedKeynoteData);
    expect(after.activeKeynoteHighlight).toBe(activeKeynoteHighlight);
    expect(after.polygonVertices).toBe(polygonVertices);
    expect(after.bucketFillPreview).toBe(bucketFillPreview);
    expect(setMode).not.toHaveBeenCalled();
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
    useViewerStore.setState({
      pageNumber: 7,
      searchQuery: "unrelated-current-value",
      activeYoloTagId: "old",
      tagBrowseId: "old",
      tagBrowseIndex: 3,
      llmHighlight: oldHighlight,
    });
    const missingBaseline = useViewerStore.getState();
    const publications: Array<{
      next: ReturnType<typeof useViewerStore.getState>;
      previous: ReturnType<typeof useViewerStore.getState>;
    }> = [];
    const unsubscribe = useViewerStore.subscribe((next, previous) => {
      publications.push({ next, previous });
    });

    navigateYoloTag(queryClient, "project-A", "missing", 99);
    expect(publications).toEqual([]);
    expect(useViewerStore.getState()).toBe(missingBaseline);

    navigateYoloTag(queryClient, "project-A", "empty", 99);
    unsubscribe();

    expect(publications).toHaveLength(1);
    expect(publications[0].previous).toBe(missingBaseline);
    expect(publications[0].next).toBe(useViewerStore.getState());
    expect(publications[0].next).toMatchObject({
      pageNumber: 7,
      searchQuery: "unrelated-current-value",
      activeYoloTagId: "empty",
      tagBrowseId: "empty",
      tagBrowseIndex: 0,
      llmHighlight: null,
    });
  });

  it("wraps negative and positive indexes and publishes each nonempty navigation once", () => {
    const instances: YoloTag["instances"] = [
      { pageNumber: 2, annotationId: 1, bbox: [0, 0, 0.1, 0.1], confidence: 1 },
      { pageNumber: 5, annotationId: 2, bbox: [0.2, 0.2, 0.3, 0.3], confidence: 1 },
    ];
    seedYoloTagsFromBootstrap(queryClient, "project-A", {
      yoloTags: [yoloTag("D-201", instances)],
    });
    useViewerStore.setState({ searchQuery: "preserve-me" });
    const publications: Array<{
      next: ReturnType<typeof useViewerStore.getState>;
      previous: ReturnType<typeof useViewerStore.getState>;
    }> = [];
    const unsubscribe = useViewerStore.subscribe((next, previous) => {
      publications.push({ next, previous });
    });
    const negativeBaseline = useViewerStore.getState();

    navigateYoloTag(queryClient, "project-A", "D-201", -1);

    expect(publications).toHaveLength(1);
    expect(publications[0].previous).toBe(negativeBaseline);
    expect(publications[0].next).toMatchObject({
      pageNumber: 5,
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
    const positiveBaseline = useViewerStore.getState();

    navigateYoloTag(queryClient, "project-A", "D-201", 4);
    unsubscribe();

    expect(publications).toHaveLength(2);
    expect(publications[1].previous).toBe(positiveBaseline);
    expect(publications[1].next).toMatchObject({
      pageNumber: 2,
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
    const confidence = oneCall("useViewerStore.getState().setConfidenceThreshold");
    const uiPatch = oneCall("useViewerStore.setState");
    const promiseAll = oneCall("Promise.all");

    expect(compact(demoPolicy.arguments[0], source)).toBe("true");
    expect(compact(confidence.arguments[0], source)).toBe("0");
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
      tableParseTab: '"auto"',
    });

    const indexes = [reset, demoPolicy, confidence, uiPatch, promiseAll].map((node) =>
      tryBlock.statements.indexOf(directStatement(node, tryBlock)),
    );
    expect(indexes).toEqual([
      indexes[0],
      indexes[0] + 1,
      indexes[0] + 2,
      indexes[0] + 3,
      indexes[0] + 4,
    ]);
    for (const call of [reset, demoPolicy, confidence, uiPatch]) {
      expect(descendants(directStatement(call, tryBlock), ts.isAwaitExpression)).toHaveLength(0);
    }
  });
});
