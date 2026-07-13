// @vitest-environment node
// [refactor jul13 P2.4] Global tool capability layered over independent parse-operation lanes.

import { readFileSync } from "node:fs";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  PARSE_KINDS,
  type ParseKind,
  type ParseOperationToken,
} from "@/lib/parse-operation-state";
import {
  invalidateParseToolAuthority,
  ownsParseToolAuthority,
} from "@/lib/parse-tool-authority";
import { takeoffRedo, takeoffUndo } from "@/queries/useAnnotations";
import { useParseFlowStore } from "@/stores/parseFlowStore";
import {
  publishSettledActiveTakeoffItemId,
  publishSettledCalibrationReset,
  publishSettledPolygonReset,
  publishSettledSymbolSearchActive,
  publishSettledToolMode,
  useToolStore,
} from "@/stores/toolStore";
import {
  completeKeynoteParseOperation,
  completeTableParseOperation,
  publishTableReviewForOperation,
  setTableParseStepForOperation,
} from "@/stores/viewerCommands";

type TerminalKind = "table" | "keynote";

function sourceSlice(path: string, startMarker: string, endMarker: string): string {
  const source = readFileSync(path, "utf8");
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(start, `${path} start marker`).toBeGreaterThan(-1);
  expect(end, `${path} end marker`).toBeGreaterThan(start);
  return source.slice(start, end);
}

function restoreStores(): void {
  invalidateParseToolAuthority();
  useParseFlowStore.setState(useParseFlowStore.getInitialState(), true);
  useToolStore.setState(useToolStore.getInitialState(), true);
}

function startOperation<K extends ParseKind>(kind: K): ParseOperationToken<K> {
  const result = useParseFlowStore.getState().beginParseOperation(kind);
  expect(result.status).toBe("started");
  if (result.status !== "started") throw new Error(`Expected ${kind} operation to start`);
  return result.token;
}

function seedTerminal(kind: TerminalKind): void {
  if (kind === "table") {
    useParseFlowStore.setState({
      tableParseStep: "review",
      tableParseRegion: [0.1, 0.2, 0.8, 0.9],
      tableParsedGrid: { headers: ["Tag"], rows: [{ Tag: "A" }] },
    });
    return;
  }
  useParseFlowStore.setState({
    keynoteParseStep: "review",
    keynoteParseRegion: [0.1, 0.2, 0.8, 0.9],
    keynoteColumnBBs: [[0.1, 0.2, 0.4, 0.9]],
  });
}

function completeOperation(
  kind: TerminalKind,
  token: ParseOperationToken,
  afterTerminal?: () => void,
): boolean {
  if (kind === "table") {
    return completeTableParseOperation(
      token as ParseOperationToken<"table">,
      afterTerminal ? { afterTerminal } : {},
    );
  }
  return completeKeynoteParseOperation(token as ParseOperationToken<"keynote">);
}

function expectTerminalReset(kind: TerminalKind, token: ParseOperationToken): void {
  const state = useParseFlowStore.getState();
  expect(state.parseOperations[kind]).toEqual({
    revision: token.revision + 1,
    busy: false,
  });
  if (kind === "table") {
    expect(state).toMatchObject({
      tableParseStep: "idle",
      tableParseRegion: null,
      tableParsedGrid: null,
    });
  } else {
    expect(state).toMatchObject({
      keynoteParseStep: "idle",
      keynoteParseRegion: null,
      keynoteColumnBBs: [],
    });
  }
}

function toolDataSnapshot(): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(useToolStore.getState()).filter(([, value]) => typeof value !== "function"),
  );
}

beforeEach(() => {
  restoreStores();
});

describe("parse tool authority claim ordering", () => {
  it("claims an accepted peer before its parse publication reaches reentrant subscribers", () => {
    useToolStore.setState({ mode: "markup", bucketFillActive: true });
    seedTerminal("table");
    const tokenA = startOperation("table");
    const beforeTool = useToolStore.getState();
    const toolListener = vi.fn();
    const afterTerminal = vi.fn();
    let completed: boolean | null = null;
    let armed = true;
    const unsubscribeTool = useToolStore.subscribe(toolListener);
    const unsubscribeParse = useParseFlowStore.subscribe((state) => {
      if (!armed || !state.parseOperations.keynote.busy) return;
      armed = false;
      completed = completeTableParseOperation(tokenA, { afterTerminal });
    });

    const tokenB = startOperation("keynote");

    expect(armed).toBe(false);
    expect(completed).toBe(true);
    expect(useToolStore.getState()).toBe(beforeTool);
    expect(toolListener).not.toHaveBeenCalled();
    expectTerminalReset("table", tokenA);
    expect(useParseFlowStore.getState().parseOperations.keynote).toEqual({
      revision: tokenB.revision,
      busy: true,
    });
    expect(afterTerminal).toHaveBeenCalledTimes(1);
    unsubscribeParse();
    unsubscribeTool();
  });

  it("does not let a rejected same-kind begin steal the accepted owner's capability", () => {
    useToolStore.setState({ mode: "markup", bucketFillActive: true });
    seedTerminal("table");
    const token = startOperation("table");
    const trace: string[] = [];
    const unsubscribeTool = useToolStore.subscribe(() => trace.push("tool"));
    const unsubscribeParse = useParseFlowStore.subscribe(() => trace.push("parse"));

    expect(useParseFlowStore.getState().beginParseOperation("table")).toEqual({ status: "busy" });
    expect(completeTableParseOperation(token)).toBe(true);

    expect(trace).toEqual(["tool", "parse"]);
    expect(useToolStore.getState()).toMatchObject({ mode: "move", bucketFillActive: false });
    expectTerminalReset("table", token);
    unsubscribeParse();
    unsubscribeTool();
  });

  it("requires exact token identity for tool authority while retaining structural parse authority", () => {
    useToolStore.setState({ mode: "markup", bucketFillActive: true });
    seedTerminal("table");
    const token = startOperation("table");
    const clone = { ...token };
    const beforeTool = useToolStore.getState();
    const toolListener = vi.fn();
    const unsubscribeTool = useToolStore.subscribe(toolListener);

    expect(completeTableParseOperation(clone)).toBe(true);

    expect(useToolStore.getState()).toBe(beforeTool);
    expect(toolListener).not.toHaveBeenCalled();
    expectTerminalReset("table", token);
    unsubscribeTool();
  });
});

describe("cross-kind tool capability", () => {
  for (const target of ["table", "keynote"] as const) {
    for (const peer of PARSE_KINDS.filter((kind) => kind !== target)) {
      for (const settled of [false, true]) {
        it(`${target}: ${settled ? "settled" : "busy"} ${peer} peer owns the global tool tail`, () => {
          useToolStore.setState({ mode: "markup", bucketFillActive: true });
          seedTerminal(target);
          const tokenA = startOperation(target);
          const tokenB = startOperation(peer);
          if (settled) {
            expect(useParseFlowStore.getState().finishParseOperation(tokenB)).toBe(true);
          }
          const beforeTool = useToolStore.getState();
          const toolListener = vi.fn();
          const afterTerminal = vi.fn();
          const unsubscribeTool = useToolStore.subscribe(toolListener);

          expect(completeOperation(target, tokenA, afterTerminal)).toBe(true);

          expect(useToolStore.getState()).toBe(beforeTool);
          expect(toolListener).not.toHaveBeenCalled();
          expectTerminalReset(target, tokenA);
          expect(useParseFlowStore.getState().parseOperations[peer]).toEqual({
            revision: tokenB.revision,
            busy: !settled,
          });
          expect(afterTerminal).toHaveBeenCalledTimes(target === "table" ? 1 : 0);
          unsubscribeTool();
        });
      }
    }
  }
});

const TOOL_INTENTS: ReadonlyArray<Readonly<{
  name: string;
  invoke: () => void;
}>> = [
  { name: "toolbar mode", invoke: () => useToolStore.getState().setMode("markup") },
  {
    name: "setMode ABA",
    invoke: () => {
      useToolStore.getState().setMode("markup");
      useToolStore.getState().setMode("move");
    },
  },
  { name: "temporary pan", invoke: () => useToolStore.getState().setTempPanMode(true) },
  { name: "takeoff selection", invoke: () => useToolStore.getState().setActiveTakeoffItemId(41) },
  { name: "calibration", invoke: () => useToolStore.getState().setCalibrationMode("point1") },
  { name: "calibration reset", invoke: () => useToolStore.getState().resetCalibration() },
  { name: "polygon", invoke: () => useToolStore.getState().setPolygonDrawingMode("drawing") },
  { name: "polygon reset", invoke: () => useToolStore.getState().resetPolygonDrawing() },
  { name: "bucket fill", invoke: () => useToolStore.getState().setBucketFillActive(true) },
  { name: "bucket barrier", invoke: () => useToolStore.getState().setBucketFillBarrierMode(true) },
  { name: "split area", invoke: () => useToolStore.getState().setSplitAreaActive(true) },
  { name: "YOLO tag pick", invoke: () => useToolStore.getState().setYoloTagPickingMode(true) },
  { name: "tag add", invoke: () => useToolStore.getState().setTagAddingMode("fixture") },
  { name: "symbol search", invoke: () => useToolStore.getState().setSymbolSearchActive(true) },
  { name: "symbol clear", invoke: () => useToolStore.getState().clearSymbolSearch() },
  { name: "project tool reset", invoke: () => useToolStore.getState().resetProjectToolState() },
];

describe("later user tool intent revokes parse completion writes", () => {
  it("revokes at the shared canvas gesture boundary before coordinates or tool branches", () => {
    const source = readFileSync("src/components/viewer/AnnotationOverlay.tsx", "utf8");
    const start = source.indexOf("const handleMouseDown = useCallback(");
    const firstBranch = source.indexOf("// Scale calibration mode", start);
    expect(start).toBeGreaterThan(-1);
    expect(firstBranch).toBeGreaterThan(start);
    const gesturePrefix = source.slice(start, firstBranch);
    expect(gesturePrefix.match(/invalidateParseToolAuthority\(\)/g)).toHaveLength(1);
    expect(gesturePrefix.indexOf("invalidateParseToolAuthority()"))
      .toBeLessThan(gesturePrefix.indexOf("getPos(e)"));
  });

  it("pins press-time boundaries for every non-canvas continuation control", () => {
    const sources = {
      area: readFileSync("src/components/viewer/AreaTab.tsx", "utf8"),
      bucketDialog: readFileSync("src/components/viewer/BucketFillAssignDialog.tsx", "utf8"),
      drawingPreview: readFileSync("src/components/viewer/DrawingPreviewLayer.tsx", "utf8"),
      symbolSearch: readFileSync("src/components/viewer/SymbolSearchPanel.tsx", "utf8"),
      takeoff: readFileSync("src/components/viewer/TakeoffPanel.tsx", "utf8"),
    };

    expect(sources.bucketDialog.match(
      /onPointerDownCapture=\{\(\) => invalidateParseToolAuthority\(\)\}/g,
    )).toHaveLength(1);
    expect(sources.bucketDialog.match(
      /onKeyDownCapture=\{\(\) => invalidateParseToolAuthority\(\)\}/g,
    )).toHaveLength(1);
    expect(sources.symbolSearch.match(
      /onPointerDownCapture=\{\(\) => invalidateParseToolAuthority\(\)\}/g,
    )).toHaveLength(1);
    expect(sources.symbolSearch.match(
      /onKeyDownCapture=\{\(\) => invalidateParseToolAuthority\(\)\}/g,
    )).toHaveLength(1);

    for (const [name, source, expected] of [
      ["AreaTab tool/tuning controls", sources.area, 7],
      ["DrawingPreview accept/cancel/done/exit", sources.drawingPreview, 6],
      ["Takeoff undo/redo", sources.takeoff, 2],
    ] as const) {
      expect(
        source.match(/onPointerDown=\{\(\) => invalidateParseToolAuthority\(\)\}/g),
        `${name} pointer admission`,
      ).toHaveLength(expected);
      expect(
        source.match(/onKeyDown=\{\(\) => invalidateParseToolAuthority\(\)\}/g),
        `${name} keyboard admission`,
      ).toHaveLength(expected);
    }
  });

  it("pins keyboard preview, undo, delete, and drag revocation before their publications", () => {
    const source = readFileSync("src/components/viewer/AnnotationOverlay.tsx", "utf8");
    for (const pattern of [
      /if \(tool\.splitPreview\) \{[\s\S]*?invalidateParseToolAuthority\(\);[\s\S]*?tool\.setSplitPreview\(null\)/,
      /else if \(tool\.bucketFillPendingPolygon\) \{[\s\S]*?invalidateParseToolAuthority\(\);[\s\S]*?tool\.setBucketFillPendingPolygon\(null\)/,
      /else if \(tool\.bucketFillPreview\) \{[\s\S]*?invalidateParseToolAuthority\(\);[\s\S]*?tool\.setBucketFillPreview\(null\)/,
      /if \(store\.splitPreview\) \{[\s\S]*?invalidateParseToolAuthority\(\);[\s\S]*?acceptSplit\(\)/,
      /else if \(store\.bucketFillPreview\) \{[\s\S]*?invalidateParseToolAuthority\(\);[\s\S]*?prepareBucketFillPolygon\(\)/,
      /else if \(polygonDrawingMode === "drawing"\) \{[\s\S]*?invalidateParseToolAuthority\(\);[\s\S]*?const verts = store\.polygonVertices/,
      /store\.bucketFillActive && store\.bucketFillBarriers\.length > 0[\s\S]*?invalidateParseToolAuthority\(\);[\s\S]*?store\.undoLastBarrier\(\)/,
      /else if \(polygonDrawingMode === "drawing"\) \{[\s\S]*?invalidateParseToolAuthority\(\);[\s\S]*?undoLastVertex\(\)/,
      /e\.key === "Delete" \|\| e\.key === "Backspace"[\s\S]*?invalidateParseToolAuthority\(\);[\s\S]*?removeAnnotation/,
      /e\.key === "Enter" && dragging[\s\S]*?invalidateParseToolAuthority\(\);[\s\S]*?saveDragPosition\(\)/,
    ]) {
      expect(source).toMatch(pattern);
    }
  });

  for (const target of ["table", "keynote"] as const) {
    for (const [name, invoke] of [
      ["takeoff undo", takeoffUndo],
      ["takeoff redo", takeoffRedo],
    ] as const) {
      it(`${target}: ${name} no-op still preserves the newer active session`, () => {
        useToolStore.setState({ mode: "pointer", activeTakeoffItemId: 41 });
        seedTerminal(target);
        const token = startOperation(target);
        const queryClient = new QueryClient();

        invoke(queryClient);
        const afterIntent = useToolStore.getState();
        expect(completeOperation(target, token)).toBe(true);

        expect(useToolStore.getState()).toBe(afterIntent);
        expect(useToolStore.getState().activeTakeoffItemId).toBe(41);
        expectTerminalReset(target, token);
        queryClient.clear();
      });
    }
  }

  it("keeps capability-neutral async cleanup helpers from claiming or revoking authority", () => {
    useToolStore.setState({
      mode: "markup",
      activeTakeoffItemId: 41,
      calibrationMode: "input",
      polygonDrawingMode: "drawing",
      polygonVertices: [{ x: 0.1, y: 0.2 }],
      symbolSearchActive: true,
    });
    const token = startOperation("table");

    publishSettledActiveTakeoffItemId(42);
    expect(ownsParseToolAuthority(token)).toBe(true);
    publishSettledCalibrationReset();
    expect(ownsParseToolAuthority(token)).toBe(true);
    publishSettledPolygonReset();
    expect(ownsParseToolAuthority(token)).toBe(true);
    publishSettledSymbolSearchActive(false);
    expect(ownsParseToolAuthority(token)).toBe(true);
    publishSettledToolMode("pointer");
    expect(ownsParseToolAuthority(token)).toBe(true);

    const state = useToolStore.getState();
    expect(state).toMatchObject({
      mode: "pointer",
      activeTakeoffItemId: null,
      calibrationMode: "idle",
      calibrationPoints: {},
      polygonDrawingMode: "idle",
      polygonVertices: [],
      symbolSearchActive: false,
    });
  });

  it("keeps every settled helper patch byte-for-value equal to its legacy leaf action", () => {
    const seed = () => useToolStore.setState({
      mode: "markup",
      tempPanMode: true,
      activeTakeoffItemId: 41,
      takeoffUndoStack: [{ id: 1 } as never],
      takeoffRedoStack: [{ id: 2 } as never],
      calibrationMode: "input",
      calibrationPoints: { p1: { x: 0.1, y: 0.2 } },
      polygonDrawingMode: "drawing",
      polygonVertices: [{ x: 0.2, y: 0.3 }],
      bucketFillActive: true,
      bucketFillLoading: true,
      bucketFillBarriers: [{ x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.4 }],
      bucketFillBarrierMode: true,
      splitAreaActive: true,
      splitLineA: { x: 0.1, y: 0.2 },
      splitLineB: { x: 0.3, y: 0.4 },
      symbolSearchActive: true,
    });
    const cases = [
      {
        name: "mode",
        action: () => useToolStore.getState().setMode("pointer"),
        settled: () => publishSettledToolMode("pointer"),
      },
      {
        name: "active takeoff",
        action: () => useToolStore.getState().setActiveTakeoffItemId(42),
        settled: () => publishSettledActiveTakeoffItemId(42),
      },
      {
        name: "calibration reset",
        action: () => useToolStore.getState().resetCalibration(),
        settled: () => publishSettledCalibrationReset(),
      },
      {
        name: "polygon reset",
        action: () => useToolStore.getState().resetPolygonDrawing(),
        settled: () => publishSettledPolygonReset(),
      },
      {
        name: "symbol deactivate",
        action: () => useToolStore.getState().setSymbolSearchActive(false),
        settled: () => publishSettledSymbolSearchActive(false),
      },
      {
        name: "symbol activate",
        action: () => useToolStore.getState().setSymbolSearchActive(true),
        settled: () => publishSettledSymbolSearchActive(true),
      },
    ];

    for (const fixture of cases) {
      restoreStores();
      seed();
      fixture.action();
      const expected = toolDataSnapshot();
      restoreStores();
      seed();
      fixture.settled();
      expect(toolDataSnapshot(), fixture.name).toEqual(expected);
    }
  });

  it("lets a newer parse retain Tool authority across an older settled helper", () => {
    useToolStore.setState({ mode: "markup", activeTakeoffItemId: 41 });
    seedTerminal("table");
    seedTerminal("keynote");
    const tokenA = startOperation("table");
    invalidateParseToolAuthority();
    const tokenB = startOperation("keynote");

    publishSettledActiveTakeoffItemId(42);
    expect(ownsParseToolAuthority(tokenB)).toBe(true);
    expect(completeTableParseOperation(tokenA)).toBe(true);
    expect(useToolStore.getState().activeTakeoffItemId).toBe(42);
    expect(ownsParseToolAuthority(tokenB)).toBe(true);

    expect(completeKeynoteParseOperation(tokenB)).toBe(true);
    expect(useToolStore.getState()).toMatchObject({
      mode: "move",
      activeTakeoffItemId: null,
    });
    expectTerminalReset("table", tokenA);
    expectTerminalReset("keynote", tokenB);
  });

  it("preserves a reentrantly admitted parse across an older optimistic drawing reset", () => {
    useToolStore.setState({
      mode: "markup",
      polygonDrawingMode: "drawing",
      polygonVertices: [{ x: 0.1, y: 0.2 }],
    });
    seedTerminal("table");
    seedTerminal("keynote");
    const tokenA = startOperation("table");
    invalidateParseToolAuthority();
    const tokenB = startOperation("keynote");

    // Models persistCreate's synchronous optimistic Query publication admitting B before the
    // older savePolygon/saveLinearPolyline callback reaches its local drawing reset.
    publishSettledPolygonReset();
    expect(ownsParseToolAuthority(tokenB)).toBe(true);
    expect(completeTableParseOperation(tokenA)).toBe(true);
    expect(ownsParseToolAuthority(tokenB)).toBe(true);
    expect(useToolStore.getState().polygonDrawingMode).toBe("idle");

    expect(completeKeynoteParseOperation(tokenB)).toBe(true);
    expect(useToolStore.getState().mode).toBe("move");
    expectTerminalReset("table", tokenA);
    expectTerminalReset("keynote", tokenB);
  });

  it("keeps settled-helper bodies free of user-intent invalidation", () => {
    const source = readFileSync("src/stores/toolStore.ts", "utf8");
    const helperNames = [
      "publishSettledToolMode",
      "publishSettledActiveTakeoffItemId",
      "publishSettledCalibrationReset",
      "publishSettledPolygonReset",
      "publishSettledSymbolSearchActive",
    ];
    for (const [index, name] of helperNames.entries()) {
      const start = source.indexOf(`export function ${name}`);
      const end = index + 1 < helperNames.length
        ? source.indexOf(`export function ${helperNames[index + 1]}`, start)
        : source.indexOf("/** Exact legacy 23-member grouped selector", start);
      expect(start, `${name} exists`).toBeGreaterThan(-1);
      expect(end, `${name} bounded`).toBeGreaterThan(start);
      const body = source.slice(start, end);
      expect(body, `${name} publishes exactly once`).toMatch(/useToolStore\.setState\(/);
      expect(body, `${name} is capability-neutral`).not.toContain(
        "invalidateParseToolAuthority",
      );
    }
  });

  it("separates initiating user intent from older async takeoff settlements", () => {
    for (const path of [
      "src/components/viewer/CountTab.tsx",
      "src/components/viewer/AreaTab.tsx",
      "src/components/viewer/LinearTab.tsx",
    ]) {
      for (const [start, end] of [
        ["async function handleCreate()", "async function handleDelete("],
        ["async function handleDelete(", "async function handleRename("],
      ] as const) {
        const body = sourceSlice(path, start, end);
        expect(body.match(/invalidateParseToolAuthority\(\)/g)).toHaveLength(1);
        expect(body.indexOf("invalidateParseToolAuthority()"))
          .toBeLessThan(body.indexOf("await "));
        expect(body.match(/publishSettledActiveTakeoffItemId\(/g)).toHaveLength(2);
        expect(body).not.toMatch(/\bsetActiveTakeoffItemId\(/);
      }
    }
  });

  it("keeps calibration, symbol, detection, and React-effect settlements neutral", () => {
    const calibration = sourceSlice(
      "src/components/viewer/CalibrationInput.tsx",
      "async function handleOk()",
      "\n  return (",
    );
    expect(calibration.match(/invalidateParseToolAuthority\(\)/g)).toHaveLength(1);
    expect(calibration.indexOf("invalidateParseToolAuthority()"))
      .toBeLessThan(calibration.indexOf("await "));
    expect(calibration.match(/publishSettledCalibrationReset\(\)/g)).toHaveLength(2);
    expect(calibration).not.toMatch(/\bresetCalibration\(\)/);

    const symbol = readFileSync("src/components/viewer/SymbolSearchPanel.tsx", "utf8");
    expect(symbol.match(/publishSettledSymbolSearchActive\(false\)/g)).toHaveLength(1);
    expect(symbol).not.toContain("store.setSymbolSearchActive(false)");

    const detection = readFileSync("src/components/viewer/DetectionPanel.tsx", "utf8");
    expect(detection.match(/publishSettledToolMode\("move"\)/g)).toHaveLength(2);
    const settlementOffsets = [...detection.matchAll(/publishSettledToolMode\("move"\)/g)]
      .map((match) => match.index ?? -1);
    for (const settlement of settlementOffsets) {
      const entry = detection.lastIndexOf("onClick={async () => {", settlement);
      const invalidation = detection.indexOf("invalidateParseToolAuthority()", entry);
      const firstAwait = detection.indexOf("await ", entry);
      expect(entry).toBeGreaterThan(-1);
      expect(invalidation).toBeGreaterThan(entry);
      expect(invalidation).toBeLessThan(firstAwait);
      expect(firstAwait).toBeLessThan(settlement);
    }

    const effects = sourceSlice(
      "src/components/viewer/AnnotationOverlay.tsx",
      "// Cancel in-progress drawing modes on page change, deselect",
      "// Save markup from dialog",
    );
    expect(effects.match(/publishSettledPolygonReset\(\)/g)).toHaveLength(4);
    expect(effects.match(/publishSettledCalibrationReset\(\)/g)).toHaveLength(1);
    expect(effects.match(/publishSettledSymbolSearchActive\(false\)/g)).toHaveLength(1);
    expect(effects).not.toMatch(/\bresetPolygonDrawing\(\)|\bresetCalibration\(\)|\.setSymbolSearchActive\(/);
  });

  it("keeps both optimistic polygon save tails capability-neutral after cache publication", () => {
    for (const [start, end] of [
      ["const savePolygon = useCallback", "/** Prepare bucket fill preview"],
      ["const saveLinearPolyline = useCallback", "// Track which corner is being resized"],
    ] as const) {
      const body = sourceSlice("src/components/viewer/AnnotationOverlay.tsx", start, end);
      const publication = body.indexOf("void persistCreate(");
      const reset = body.indexOf("publishSettledPolygonReset()");
      expect(publication).toBeGreaterThan(-1);
      expect(reset).toBeGreaterThan(publication);
      expect(body).not.toMatch(/\bresetPolygonDrawing\(\)/);
    }
  });

  for (const target of ["table", "keynote"] as const) {
    for (const intent of TOOL_INTENTS) {
      it(`${target}: ${intent.name} survives the terminal parse reset by exact Tool identity`, () => {
        useToolStore.setState({ mode: "pointer", bucketFillActive: true });
        seedTerminal(target);
        const token = startOperation(target);

        intent.invoke();
        const afterIntent = useToolStore.getState();
        const toolListener = vi.fn();
        const afterTerminal = vi.fn();
        const unsubscribeTool = useToolStore.subscribe(toolListener);

        expect(completeOperation(target, token, afterTerminal)).toBe(true);

        expect(useToolStore.getState()).toBe(afterIntent);
        expect(toolListener).not.toHaveBeenCalled();
        expectTerminalReset(target, token);
        expect(afterTerminal).toHaveBeenCalledTimes(target === "table" ? 1 : 0);
        unsubscribeTool();
      });
    }
  }

  for (const fixture of [
    { name: "bucket activation", invoke: () => useToolStore.getState().setBucketFillActive(true) },
    { name: "project reset", invoke: () => useToolStore.getState().resetProjectToolState() },
  ]) {
    it(`${fixture.name} revokes before publication so a reentrant completion cannot nest a tool write`, () => {
      useToolStore.setState({ mode: "markup", activeTakeoffItemId: 41 });
      seedTerminal("table");
      const token = startOperation("table");
      let completed: boolean | null = null;
      let publications = 0;
      const unsubscribeTool = useToolStore.subscribe(() => {
        publications += 1;
        if (publications === 1) completed = completeTableParseOperation(token);
      });

      fixture.invoke();

      expect(completed).toBe(true);
      expect(publications).toBe(1);
      expectTerminalReset("table", token);
      unsubscribeTool();
    });
  }
});

describe("operation-owned Table preparation", () => {
  const publication = {
    grid: { headers: ["Tag"], rows: [{ Tag: "A" }] },
    meta: null,
    region: [0.1, 0.2, 0.8, 0.9] as [number, number, number, number],
  };

  it("skips stale review tool prep but still publishes review bytes and runs the terminal tail", () => {
    useToolStore.setState({ mode: "markup" });
    const token = startOperation("table");
    useToolStore.getState().setBucketFillActive(true);
    const afterIntent = useToolStore.getState();
    const toolListener = vi.fn();
    const parseListener = vi.fn();
    const unsubscribeTool = useToolStore.subscribe(toolListener);
    const unsubscribeParse = useParseFlowStore.subscribe(parseListener);

    expect(publishTableReviewForOperation(token, publication)).toBe(true);

    expect(useToolStore.getState()).toBe(afterIntent);
    expect(toolListener).not.toHaveBeenCalled();
    expect(parseListener).toHaveBeenCalledTimes(1);
    expect(useParseFlowStore.getState()).toMatchObject({
      tableParseStep: "review",
      tableParseRegion: publication.region,
      tableParsedGrid: publication.grid,
    });
    const afterTerminal = vi.fn();
    expect(completeTableParseOperation(token, { afterTerminal })).toBe(true);
    expect(useToolStore.getState()).toBe(afterIntent);
    expect(toolListener).not.toHaveBeenCalled();
    expect(parseListener).toHaveBeenCalledTimes(2);
    expect(afterTerminal).toHaveBeenCalledTimes(1);
    expectTerminalReset("table", token);
    unsubscribeParse();
    unsubscribeTool();
  });

  it("skips stale step tool prep while retaining the token-owned parse publication", () => {
    const token = startOperation("table");
    useToolStore.getState().setSplitAreaActive(true);
    const afterIntent = useToolStore.getState();
    const toolListener = vi.fn();
    const parseListener = vi.fn();
    const unsubscribeTool = useToolStore.subscribe(toolListener);
    const unsubscribeParse = useParseFlowStore.subscribe(parseListener);

    expect(setTableParseStepForOperation(token, "review")).toBe(true);

    expect(useToolStore.getState()).toBe(afterIntent);
    expect(toolListener).not.toHaveBeenCalled();
    expect(parseListener).toHaveBeenCalledTimes(1);
    expect(useParseFlowStore.getState().tableParseStep).toBe("review");
    expect(useParseFlowStore.getState().isParseOperationCurrent(token)).toBe(true);
    unsubscribeParse();
    unsubscribeTool();
  });

  it("retains capability through authorized review prep so the same owner may clean up terminally", () => {
    useToolStore.setState({
      mode: "markup",
      activeTakeoffItemId: 41,
      bucketFillActive: true,
    });
    const token = startOperation("table");
    const trace: string[] = [];
    const unsubscribeTool = useToolStore.subscribe(() => trace.push("tool"));
    const unsubscribeParse = useParseFlowStore.subscribe(() => trace.push("parse"));

    expect(publishTableReviewForOperation(token, publication)).toBe(true);
    expect(useToolStore.getState()).toMatchObject({
      mode: "move",
      activeTakeoffItemId: 41,
      bucketFillActive: false,
    });
    expect(completeTableParseOperation(token)).toBe(true);

    expect(trace).toEqual(["tool", "parse", "tool", "parse"]);
    expect(useToolStore.getState().activeTakeoffItemId).toBeNull();
    expectTerminalReset("table", token);
    unsubscribeParse();
    unsubscribeTool();
  });
});
