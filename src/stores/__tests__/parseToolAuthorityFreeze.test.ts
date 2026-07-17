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
  publishSettledSymbolSearchDeactivate,
  publishSettledToolMode,
  reconcileSettledDeletedTakeoffItem,
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
    useToolStore.setState({ mode: "markup", activeTool: { kind: "bucketFill" } });
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
    const bucketActivation = { kind: "bucketFill" } as const;
    useToolStore.setState({ mode: "markup", activeTool: bucketActivation });
    seedTerminal("table");
    const token = startOperation("table");
    const trace: string[] = [];
    const unsubscribeTool = useToolStore.subscribe(() => trace.push("tool"));
    const unsubscribeParse = useParseFlowStore.subscribe(() => trace.push("parse"));

    expect(useParseFlowStore.getState().beginParseOperation("table")).toEqual({ status: "busy" });
    expect(completeTableParseOperation(token)).toBe(true);

    expect(trace).toEqual(["tool", "parse"]);
    expect(useToolStore.getState()).toMatchObject({ mode: "move" });
    expect(useToolStore.getState().activeTool).toBe(bucketActivation);
    expectTerminalReset("table", token);
    unsubscribeParse();
    unsubscribeTool();
  });

  it("requires exact token identity for tool authority while retaining structural parse authority", () => {
    useToolStore.setState({ mode: "markup", activeTool: { kind: "bucketFill" } });
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
          useToolStore.setState({ mode: "markup", activeTool: { kind: "bucketFill" } });
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
  {
    name: "bucket same-kind ABA",
    invoke: () => {
      useToolStore.getState().setBucketFillActive(true);
      useToolStore.getState().setBucketFillActive(true);
    },
  },
  { name: "bucket barrier", invoke: () => useToolStore.getState().setBucketFillBarrierMode(true) },
  { name: "split area", invoke: () => useToolStore.getState().setSplitAreaActive(true) },
  { name: "YOLO tag pick", invoke: () => useToolStore.getState().setYoloTagPickingMode(true) },
  { name: "tag add", invoke: () => useToolStore.getState().setTagAddingMode("fixture") },
  { name: "symbol search", invoke: () => useToolStore.getState().setSymbolSearchActive(true) },
  { name: "symbol clear", invoke: () => useToolStore.getState().clearSymbolSearch() },
  { name: "project tool reset", invoke: () => useToolStore.getState().resetProjectToolState() },
];

describe("later user tool intent revokes parse completion writes", () => {
  it("rejects stale canvas targets before coordinates and claims only accepted branch work", () => {
    const source = readFileSync("src/components/viewer/AnnotationOverlay.tsx", "utf8");
    const start = source.indexOf("const handleMouseDown = useCallback(");
    // [refactor jul16 P3.2] First legacy branch after the seam is now Split (calibration moved
    // behind the registry).
    const firstBranch = source.indexOf("// Split Area mode", start);
    expect(start).toBeGreaterThan(-1);
    expect(firstBranch).toBeGreaterThan(start);
    const gesturePrefix = source.slice(start, firstBranch);
    const lifecycleGuard = gesturePrefix.indexOf("if (!canAdoptProjectLifecycle()) return");
    const cancel = gesturePrefix.indexOf("cancelDeferredDrawing()");
    const projectGuard = gesturePrefix.indexOf("useSessionStore.getState().publicId");
    const pageGuard = gesturePrefix.indexOf("useViewerCoreStore.getState().pageNumber");
    const toolSnapshot = gesturePrefix.indexOf("const toolAtDown = useToolStore.getState()");
    const activationSnapshot = gesturePrefix.indexOf("const activeTool = toolAtDown.activeTool");
    const coordinates = gesturePrefix.indexOf("getPos(e)");
    const registryDispatch = gesturePrefix.indexOf("dispatchToolMouseDown(");
    expect(lifecycleGuard).toBeGreaterThan(-1);
    expect(cancel).toBeGreaterThan(-1);
    expect(projectGuard).toBeGreaterThan(-1);
    expect(pageGuard).toBeGreaterThan(-1);
    expect(toolSnapshot).toBeGreaterThan(-1);
    expect(activationSnapshot).toBeGreaterThan(-1);
    expect(coordinates).toBeGreaterThan(-1);
    expect(registryDispatch).toBeGreaterThan(-1);
    expect(lifecycleGuard).toBeLessThan(cancel);
    expect(cancel).toBeLessThan(projectGuard);
    expect(projectGuard).toBeLessThan(pageGuard);
    expect(pageGuard).toBeLessThan(toolSnapshot);
    expect(toolSnapshot).toBeLessThan(activationSnapshot);
    expect(activationSnapshot).toBeLessThan(coordinates);
    expect(coordinates).toBeLessThan(registryDispatch);
    const compactPrefix = gesturePrefix.replace(/\s+/g, "");
    // [refactor jul16 P3.2] Non-vacuous 4-arg seam witness: the eagerly-captured press wires the
    // pre-seam snapshot/coordinates, the lazy factory wires page + module-level store readers +
    // the already-admitted lifecycle authority. cssScale stays unwired (proven-capabilities
    // rule); [refactor jul17 P3.2] mutations is wired as the takeoffCount-proven persistCreate
    // slice (see tools/types.ts).
    expect(compactPrefix).toContain(
      "constpress={toolAtDown,position:pos,publicId,pageNumber}asconst;",
    );
    // [refactor jul16 P3.2 markup] The factory gained the markup-proven capabilities: selection
    // (five handler-closure members), the memoized pageAnnotations, and the deferred-drawing
    // starter — all dep-neutral (already in the 37-entry array, stable setters, or the same
    // per-render deleteSelected closure the pointer block captures).
    // [refactor jul17 P3.2 takeoffCount] Plus the takeoffCount-proven capabilities: the narrowed
    // persistCreate mutations slice, the transient-error publisher, and the component takeoffItems
    // array — all three identifiers already in the 37-entry dependency array.
    expect(compactPrefix).toContain(
      "if(dispatchToolMouseDown(TOOLS,e,press,()=>({press,page:{publicId,number:pageNumber,width,height},stores:TOOL_STORE_CAPABILITIES,canAdoptProjectLifecycle," +
        "selection:{selectedId,setSelectedId,setResizeCorner,setDragging,deleteSelected},pageAnnotations,deferredDrawing:{start:startDeferredDrawing}," +
        "mutations:{annotations:{persistCreate}},transientError:{publish:publishTransientBucketFillError},takeoffItems,}))){return;}",
    );
    expect(compactPrefix).not.toContain("cssScale");
    const mouseDown = source.slice(
      start,
      source.indexOf("const handleMouseMove = useCallback(", start),
    );
    expect(mouseDown.match(/dispatchToolMouseDown\(/g)).toHaveLength(1);
    expect(
      source.slice(
        source.indexOf("const handleMouseMove = useCallback(", start),
      ),
    ).not.toContain("dispatchToolMouseDown(");
    expect(gesturePrefix).not.toContain("invalidateToolTailAuthority");
    expect(gesturePrefix).not.toContain("invalidateParseToolAuthority");

    // [refactor jul16 P3.2] The calibration gesture lives in the controller now; the overlay's
    // mousedown must carry no calibration logic at all.
    const calibration = readFileSync(
      "src/components/viewer/tools/calibration.ts",
      "utf8",
    );
    expect(calibration.match(/advanceCalibrationGesture\(/g)).toHaveLength(2);
    expect(calibration).not.toContain("setCalibrationPoint(");
    expect(calibration).not.toContain("setCalibrationMode(");
    expect(mouseDown).not.toContain("advanceCalibrationGesture(");
    expect(mouseDown).not.toContain('calibrationMode === "point1"');
    const calibrationCommand = sourceSlice(
      "src/stores/toolStore.ts",
      "export function advanceCalibrationGesture(",
      "export function publishSettledCalibrationReset(",
    );
    expect(calibrationCommand.match(/invalidateToolTailAuthority\(\)/g)).toHaveLength(1);
    expect(calibrationCommand.match(/useToolStore\.setState\(/g)).toHaveLength(1);
    expect(calibrationCommand).toContain("state.activeTool !== expectedActivation");
    expect(calibrationCommand).toContain("state.calibrationMode !== expectedMode");
    expect(calibrationCommand).toContain("calibrationPoints: { ...state.calibrationPoints, [which]: point }");
    expect(calibrationCommand).toContain("calibrationMode: nextMode");

    const deferred = sourceSlice(
      "src/components/viewer/AnnotationOverlay.tsx",
      "const startDeferredDrawing = useCallback(",
      "/** Save the current in-progress polygon",
    );
    const claim = deferred.indexOf("claimToolTailAuthority(token)");
    const capture = deferred.indexOf("captureCanvasGestureLease");
    const installLease = deferred.indexOf("drawingLeaseRef.current = lease");
    const startDrawing = deferred.indexOf("setDrawing(true)");
    expect(capture).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(capture);
    expect(installLease).toBeGreaterThan(claim);
    expect(startDrawing).toBeGreaterThan(claim);
    expect(deferred).toContain("ownsToolTailAuthority(token)");
    expect(deferred).toContain("matchesCanvasGestureLease(lease, readCanvasGestureSnapshot())");
    const publications = ["setDrawing(true)", "setDrawStart(pos)", "setDrawEnd(pos)"];
    const rechecks = [...deferred.matchAll(/if \(!stillOwnsLease\(\)\)/g)]
      .map((match) => match.index ?? -1);
    expect(rechecks).toHaveLength(publications.length);
    for (const [index, publication] of publications.entries()) {
      const publicationOffset = deferred.indexOf(publication);
      expect(publicationOffset).toBeGreaterThan(-1);
      expect(publicationOffset).toBeLessThan(rechecks[index]);
      if (index + 1 < publications.length) {
        expect(rechecks[index]).toBeLessThan(deferred.indexOf(publications[index + 1]));
      }
    }

    const bucket = sourceSlice(
      "src/components/viewer/AnnotationOverlay.tsx",
      "// Bucket fill mode — independent of item selection",
      "// Takeoff placement mode",
    );
    const globalClaim = bucket.indexOf("claimToolTailAuthority(bucketToken)");
    const laneClaim = bucket.indexOf(
      'claimLatestToolOperation("bucketFill", bucketToken)',
    );
    const cancellationRegistration = bucket.indexOf(
      "registerToolTailCancellation(bucketToken",
    );
    const loadingPublication = bucket.indexOf("bucketFillLoading: true", laneClaim);
    const tokenCreation = bucket.indexOf("const bucketToken = {}");
    expect(tokenCreation).toBeGreaterThan(-1);
    expect(globalClaim).toBeGreaterThan(tokenCreation);
    expect(globalClaim).toBeLessThan(laneClaim);
    expect(laneClaim).toBeLessThan(cancellationRegistration);
    expect(cancellationRegistration).toBeLessThan(loadingPublication);
    for (const guard of [
      "ownsToolTailAuthority(bucketToken)",
      'ownsLatestToolOperation("bucketFill", bucketToken)',
      "current.activeTool === bucketActivation",
      "useSessionStore.getState().projectId === bucketProjectDbId",
      "useSessionStore.getState().publicId === bucketPublicId",
      "useViewerCoreStore.getState().pageNumber === bucketPageNumber",
    ]) {
      expect(bucket).toContain(guard);
    }
    const terminalConsume = bucket.indexOf(
      "return consumeToolTailAuthority(bucketToken, publish)",
    );
    expect(terminalConsume).toBeGreaterThan(
      bucket.indexOf("releaseToolTailCancellation(bucketToken)"),
    );
    expect(bucket.match(/consumeBucketFill\(\(\) =>/g)).toHaveLength(3);

    const symbolCommit = sourceSlice(
      "src/components/viewer/AnnotationOverlay.tsx",
      'if (owner.kind === "symbolTemplate")',
      'if (owner.kind === "tagAdd")',
    );
    const symbolInvalidation = symbolCommit.indexOf(
      'invalidateLatestToolOperation("symbolSession")',
    );
    const symbolPublication = symbolCommit.indexOf("useToolStore.setState");
    expect(symbolInvalidation).toBeGreaterThan(-1);
    expect(symbolPublication).toBeGreaterThan(symbolInvalidation);
    expect(symbolCommit).toContain(
      "publishSettledSymbolSearchDeactivate(owner.activation)",
    );
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
      /onPointerDownCapture=\{\(\) => invalidateToolTailAuthority\(\)\}/g,
    )).toHaveLength(1);
    expect(sources.bucketDialog.match(
      /onKeyDownCapture=\{\(\) => invalidateToolTailAuthority\(\)\}/g,
    )).toHaveLength(1);
    expect(sources.symbolSearch.match(
      /onPointerDownCapture=\{\(\) => invalidateToolTailAuthority\(\)\}/g,
    )).toHaveLength(1);
    expect(sources.symbolSearch.match(
      /onKeyDownCapture=\{\(\) => invalidateToolTailAuthority\(\)\}/g,
    )).toHaveLength(1);

    for (const [name, source, expected] of [
      ["AreaTab tool/tuning controls", sources.area, 7],
      ["DrawingPreview accept/cancel/done/exit", sources.drawingPreview, 6],
      ["Takeoff undo/redo", sources.takeoff, 2],
    ] as const) {
      expect(
        source.match(/onPointerDown=\{\(\) => invalidateToolTailAuthority\(\)\}/g),
        `${name} pointer admission`,
      ).toHaveLength(expected);
      expect(
        source.match(/onKeyDown=\{\(\) => invalidateToolTailAuthority\(\)\}/g),
        `${name} keyboard admission`,
      ).toHaveLength(expected);
    }
    for (const [name, source] of Object.entries(sources)) {
      expect(source, `${name} uses only the generic global Tool slot`)
        .not.toContain("invalidateParseToolAuthority");
    }
  });

  it("pins keyboard preview, undo, delete, and drag revocation before their publications", () => {
    const source = readFileSync("src/components/viewer/AnnotationOverlay.tsx", "utf8");
    for (const pattern of [
      /if \(activeTool\?\.kind === "split"\) \{[\s\S]*?if \(tool\.splitPreview\) \{[\s\S]*?invalidateToolTailAuthority\(\);[\s\S]*?tool\.setSplitPreview\(null\)/,
      /else if \(activeTool\?\.kind === "bucketFill"\) \{[\s\S]*?if \(tool\.bucketFillPendingPolygon\) \{[\s\S]*?invalidateToolTailAuthority\(\);[\s\S]*?invalidateLatestToolOperation\("bucketFill"\);[\s\S]*?tool\.setBucketFillPendingPolygon\(null\)/,
      /else if \(tool\.bucketFillPreview\) \{[\s\S]*?invalidateToolTailAuthority\(\);[\s\S]*?invalidateLatestToolOperation\("bucketFill"\);[\s\S]*?tool\.setBucketFillPreview\(null\)/,
      /if \(store\.activeTool\?\.kind === "split" && store\.splitPreview\) \{[\s\S]*?invalidateToolTailAuthority\(\);[\s\S]*?acceptSplit\(\)/,
      /else if \(store\.activeTool\?\.kind === "bucketFill" && store\.bucketFillPreview\) \{[\s\S]*?invalidateToolTailAuthority\(\);[\s\S]*?invalidateLatestToolOperation\("bucketFill"\);[\s\S]*?prepareBucketFillPolygon\(\)/,
      /else if \(store\.activeTool\?\.kind === "takeoffPlacement" &&[\s\S]*?store\.polygonDrawingMode === "drawing"\) \{[\s\S]*?invalidateToolTailAuthority\(\);[\s\S]*?const verts = store\.polygonVertices/,
      /store\.activeTool\?\.kind === "bucketFill" && store\.bucketFillBarriers\.length > 0[\s\S]*?invalidateToolTailAuthority\(\);[\s\S]*?invalidateLatestToolOperation\("bucketFill"\);[\s\S]*?store\.undoLastBarrier\(\)/,
      /else if \(store\.activeTool\?\.kind === "takeoffPlacement" &&[\s\S]*?store\.polygonDrawingMode === "drawing"\) \{[\s\S]*?invalidateToolTailAuthority\(\);[\s\S]*?store\.undoLastVertex\(\)/,
      /e\.key === "Delete" \|\| e\.key === "Backspace"[\s\S]*?invalidateToolTailAuthority\(\);[\s\S]*?removeAnnotation/,
      /e\.key === "Enter" && dragging[\s\S]*?invalidateToolTailAuthority\(\);[\s\S]*?saveDragPosition\(\)/,
    ]) {
      expect(source).toMatch(pattern);
    }
    expect(source).not.toContain("invalidateParseToolAuthority");
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
    const calibrationActivation = { kind: "calibration" } as const;
    useToolStore.setState({
      mode: "markup",
      activeTool: calibrationActivation,
      activeTakeoffItemId: 41,
      calibrationMode: "input",
      calibrationPoints: { p1: { x: 0.1, y: 0.2 } },
      polygonDrawingMode: "drawing",
      polygonVertices: [{ x: 0.1, y: 0.2 }],
    });
    const token = startOperation("table");

    expect(publishSettledCalibrationReset(calibrationActivation)).toBe(true);
    expect(ownsParseToolAuthority(token)).toBe(true);
    publishSettledActiveTakeoffItemId(42);
    expect(ownsParseToolAuthority(token)).toBe(true);
    publishSettledPolygonReset();
    expect(ownsParseToolAuthority(token)).toBe(true);
    const symbolActivation = { kind: "symbolTemplate" } as const;
    useToolStore.setState({ activeTool: symbolActivation });
    expect(publishSettledSymbolSearchDeactivate(symbolActivation)).toBe(true);
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
      activeTool: null,
    });
  });

  it("keeps equivalent settled destinations byte-for-value equal to named leaf commands", () => {
    const seed = () => useToolStore.setState({
      mode: "markup",
      tempPanMode: true,
      activeTool: null,
      activeTakeoffItemId: 41,
      takeoffUndoStack: [{ id: 1 } as never],
      takeoffRedoStack: [{ id: 2 } as never],
      calibrationMode: "input",
      calibrationPoints: { p1: { x: 0.1, y: 0.2 } },
      polygonDrawingMode: "drawing",
      polygonVertices: [{ x: 0.2, y: 0.3 }],
      bucketFillLoading: true,
      bucketFillBarriers: [{ x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.4 }],
      bucketFillBarrierMode: true,
      splitLineA: { x: 0.1, y: 0.2 },
      splitLineB: { x: 0.3, y: 0.4 },
    });
    const cases = [
      {
        name: "mode",
        prepare: () => useToolStore.setState({ activeTool: { kind: "symbolTemplate" } }),
        action: () => useToolStore.getState().setMode("pointer"),
        settled: () => publishSettledToolMode("pointer"),
      },
      {
        name: "active takeoff",
        prepare: () => {},
        action: () => useToolStore.getState().setActiveTakeoffItemId(42),
        settled: () => publishSettledActiveTakeoffItemId(42),
      },
      {
        name: "calibration reset",
        prepare: () => useToolStore.setState({ activeTool: { kind: "calibration" } }),
        action: () => useToolStore.getState().resetCalibration(),
        settled: () => {
          const activation = useToolStore.getState().activeTool;
          if (activation?.kind !== "calibration") throw new Error("calibration fixture");
          publishSettledCalibrationReset(activation);
        },
      },
      {
        name: "polygon reset",
        prepare: () => {},
        action: () => useToolStore.getState().resetPolygonDrawing(),
        settled: () => publishSettledPolygonReset(),
      },
      {
        name: "symbol deactivate",
        prepare: () => useToolStore.setState({ activeTool: { kind: "symbolTemplate" } }),
        action: () => useToolStore.getState().setSymbolSearchActive(false),
        settled: () => {
          const activation = useToolStore.getState().activeTool;
          if (activation?.kind !== "symbolTemplate") throw new Error("symbol fixture");
          publishSettledSymbolSearchDeactivate(activation);
        },
      },
    ];

    for (const fixture of cases) {
      restoreStores();
      seed();
      fixture.prepare();
      fixture.action();
      const expected = toolDataSnapshot();
      restoreStores();
      seed();
      fixture.prepare();
      fixture.settled();
      expect(toolDataSnapshot(), fixture.name).toEqual(expected);
    }
  });

  it("denies stale exact cleanup across same-kind ABA while live delete reconciliation is id-based", () => {
    const calibrationA = { kind: "calibration" } as const;
    const calibrationB = { kind: "calibration" } as const;
    useToolStore.setState({
      activeTool: calibrationB,
      activeTakeoffItemId: 41,
      calibrationMode: "input",
      calibrationPoints: { p1: { x: 0.1, y: 0.2 } },
    });
    expect(publishSettledCalibrationReset(calibrationA)).toBe(false);
    expect(useToolStore.getState().activeTool).toBe(calibrationB);
    expect(useToolStore.getState().calibrationPoints).toHaveProperty("p1");

    const symbolA = { kind: "symbolTemplate" } as const;
    const symbolB = { kind: "symbolTemplate" } as const;
    useToolStore.setState({ activeTool: symbolB });
    expect(publishSettledSymbolSearchDeactivate(symbolA)).toBe(false);
    expect(useToolStore.getState().activeTool).toBe(symbolB);

    useToolStore.setState({ activeTool: { kind: "takeoffPlacement" }, activeTakeoffItemId: 41 });
    expect(reconcileSettledDeletedTakeoffItem(41)).toBe(true);
    expect(useToolStore.getState()).toMatchObject({ activeTool: null, activeTakeoffItemId: null });
  });

  it("lets a newer parse retain Tool authority across an older settled helper", () => {
    useToolStore.setState({ mode: "markup", activeTakeoffItemId: 41 });
    seedTerminal("table");
    seedTerminal("keynote");
    const tokenA = startOperation("table");
    invalidateParseToolAuthority();
    const tokenB = startOperation("keynote");

    publishSettledActiveTakeoffItemId(42);
    const takeoffActivation = useToolStore.getState().activeTool;
    expect(takeoffActivation).toEqual({ kind: "takeoffPlacement" });
    expect(ownsParseToolAuthority(tokenB)).toBe(true);
    expect(completeTableParseOperation(tokenA)).toBe(true);
    expect(useToolStore.getState().activeTakeoffItemId).toBe(42);
    expect(ownsParseToolAuthority(tokenB)).toBe(true);

    expect(completeKeynoteParseOperation(tokenB)).toBe(true);
    expect(useToolStore.getState()).toMatchObject({
      mode: "move",
      activeTakeoffItemId: 42,
    });
    expect(useToolStore.getState().activeTool).toBe(takeoffActivation);
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
      "reconcileSettledDeletedTakeoffItem",
      "publishSettledCalibrationReset",
      "publishSettledPolygonReset",
      "publishSettledSymbolSearchDeactivate",
      "publishSettledSymbolSearchCleanup",
    ];
    for (const name of helperNames) {
      const start = source.indexOf(`export function ${name}`);
      const nextFunction = source.indexOf("\nexport function ", start + 1);
      const hook = source.indexOf("/** Exact legacy 23-member grouped selector", start);
      const end = nextFunction > start ? nextFunction : hook;
      expect(start, `${name} exists`).toBeGreaterThan(-1);
      expect(end, `${name} bounded`).toBeGreaterThan(start);
      const body = source.slice(start, end);
      expect(body, `${name} publishes exactly once`).toMatch(/useToolStore\.setState\(/);
      expect(body, `${name} is capability-neutral`).not.toContain(
        "invalidateParseToolAuthority",
      );
      expect(body, `${name} is globally capability-neutral`).not.toContain(
        "invalidateToolTailAuthority",
      );
    }
  });

  it("claims create selection and reconciles delete settlement without erasing a newer item", () => {
    for (const path of [
      "src/components/viewer/CountTab.tsx",
      "src/components/viewer/AreaTab.tsx",
      "src/components/viewer/LinearTab.tsx",
    ]) {
      const create = sourceSlice(path, "async function handleCreate()", "async function handleDelete(");
      const claim = create.indexOf("claimToolTailAuthority({})");
      expect(create.match(/claimToolTailAuthority\(\{\}\)/g)).toHaveLength(1);
      expect(claim).toBeGreaterThan(create.indexOf("const capturedPublicId"));
      expect(claim).toBeLessThan(create.indexOf("queryClient.setQueryData"));
      expect(claim).toBeLessThan(create.indexOf("await "));
      expect(create.match(
        /consumeToolTailAuthority\(token, \(\) => publishSettledActiveTakeoffItemId\(item\.id\)\)/g,
      )).toHaveLength(2);
      expect(create.match(/ownsToolTailAuthority\(token\)/g)).toHaveLength(2);
      expect(create).not.toMatch(
        /invalidate(?:ToolTail|ParseTool)Authority|\bsetActiveTakeoffItemId\(/,
      );

      const deletion = sourceSlice(path, "async function handleDelete(", "async function handleRename(");
      expect(deletion.match(/invalidateToolTailAuthority\(\)/g)).toHaveLength(1);
      expect(deletion.indexOf("invalidateToolTailAuthority()"))
        .toBeLessThan(deletion.indexOf("queryClient.setQueryData"));
      expect(deletion.indexOf("invalidateToolTailAuthority()"))
        .toBeLessThan(deletion.indexOf("await "));
      expect(deletion.match(/reconcileSettledDeletedTakeoffItem\(item\.id\)/g)).toHaveLength(2);
      expect(deletion).not.toMatch(
        /invalidateParseToolAuthority|publishSettledActiveTakeoffItemId|\bsetActiveTakeoffItemId\(/,
      );
    }
  });

  it("pins exact authority for calibration, symbol, detection, and local-only page effects", () => {
    const calibration = sourceSlice(
      "src/components/viewer/CalibrationInput.tsx",
      "async function handleOk()",
      "\n  return (",
    );
    expect(calibration.match(/claimToolTailAuthority\(\{\}\)/g)).toHaveLength(1);
    expect(calibration.indexOf("claimToolTailAuthority({})"))
      .toBeLessThan(calibration.indexOf("await "));
    expect(calibration.indexOf("const activation = tool.activeTool"))
      .toBeLessThan(calibration.indexOf("claimToolTailAuthority({})"));
    expect(calibration.match(
      /consumeToolTailAuthority\(token, \(\) => publishSettledCalibrationReset\(activation\)\)/g,
    )).toHaveLength(2);
    expect(calibration.match(/useToolStore\.getState\(\)\.activeTool === activation/g))
      .toHaveLength(2);
    expect(calibration).not.toMatch(/\bresetCalibration\(\)/);

    const symbol = readFileSync("src/components/viewer/SymbolSearchPanel.tsx", "utf8");
    const symbolSave = sourceSlice(
      "src/components/viewer/SymbolSearchPanel.tsx",
      "{/* Bottom actions */}",
      "onClick={runSearch}",
    );
    expect(symbolSave.match(/claimLatestToolOperation\("symbolSession", \{\}\)/g))
      .toHaveLength(1);
    expect(symbolSave.indexOf("const capturedActivation"))
      .toBeLessThan(symbolSave.indexOf("claimLatestToolOperation"));
    expect(symbolSave.indexOf("claimLatestToolOperation"))
      .toBeLessThan(symbolSave.indexOf("await "));
    expect(symbolSave.match(
      /publishSettledSymbolSearchCleanup\(capturedActivation\)/g,
    )).toHaveLength(1);
    expect(symbolSave.indexOf("ownsSymbolSession(token, capturedPublicId)"))
      .toBeLessThan(symbolSave.indexOf("publishSettledSymbolSearchCleanup"));
    expect(symbolSave).not.toMatch(/clearSymbolSearch\(|setSymbolSearchActive\(false\)/);
    expect(symbol).not.toContain("publishSettledSymbolSearchActive");

    const detection = readFileSync("src/components/viewer/DetectionPanel.tsx", "utf8");
    expect(detection.match(/claimToolTailAuthority\(\{\}\)/g)).toHaveLength(2);
    expect(detection.match(/publishSettledToolMode\("move"\)/g)).toHaveLength(2);
    const settlementOffsets = [...detection.matchAll(/publishSettledToolMode\("move"\)/g)]
      .map((match) => match.index ?? -1);
    for (const settlement of settlementOffsets) {
      const entry = detection.lastIndexOf("onClick={async () => {", settlement);
      const claim = detection.indexOf("claimToolTailAuthority({})", entry);
      const consume = detection.lastIndexOf("consumeToolTailAuthority(token", settlement);
      const firstAwait = detection.indexOf("await ", entry);
      expect(entry).toBeGreaterThan(-1);
      expect(claim).toBeGreaterThan(entry);
      expect(claim).toBeLessThan(firstAwait);
      expect(firstAwait).toBeLessThan(settlement);
      expect(consume).toBeGreaterThan(firstAwait);
      expect(consume).toBeLessThan(settlement);
    }
    expect(detection).not.toContain("invalidateParseToolAuthority");

    const pageEffect = sourceSlice(
      "src/components/viewer/AnnotationOverlay.tsx",
      "// The synchronous viewer page command owns every Tool/Parse/drawing boundary.",
      "// Exit polygon drawing when switching interaction modes",
    );
    expect(pageEffect.match(/setSelectedId\(null\)/g)).toHaveLength(1);
    expect(pageEffect).toContain("}, [pageNumber]);");
    expect(pageEffect).not.toMatch(
      /useToolStore|publishSettled|invalidate.*Authority|reset.*Drawing|setSymbolSearchActive/,
    );

    const passiveEffects = sourceSlice(
      "src/components/viewer/AnnotationOverlay.tsx",
      "// Exit polygon drawing when switching interaction modes",
      "// Save markup from dialog",
    );
    expect(passiveEffects.match(/publishSettledPolygonReset\(\)/g)).toHaveLength(3);
    expect(passiveEffects).not.toMatch(
      /publishSettledCalibrationReset|publishSettledSymbolSearch|\bresetPolygonDrawing\(\)/,
    );
    expect(symbol.match(/publishSettledSymbolSearchCleanup\(capturedActivation\)/g))
      .toHaveLength(1);
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
        useToolStore.setState({ mode: "pointer", activeTool: { kind: "bucketFill" } });
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

  it("consumes review Tool capability once, then lets the same owner settle Parse-only terminally", () => {
    const bucketActivation = { kind: "bucketFill" } as const;
    useToolStore.setState({
      mode: "markup",
      activeTakeoffItemId: 41,
      activeTool: bucketActivation,
    });
    const token = startOperation("table");
    const trace: string[] = [];
    const unsubscribeTool = useToolStore.subscribe(() => trace.push("tool"));
    const unsubscribeParse = useParseFlowStore.subscribe(() => trace.push("parse"));

    expect(publishTableReviewForOperation(token, publication)).toBe(true);
    expect(useToolStore.getState()).toMatchObject({
      mode: "move",
      activeTakeoffItemId: 41,
      activeTool: { kind: "bucketFill" },
    });
    expect(completeTableParseOperation(token)).toBe(true);

    expect(trace).toEqual(["tool", "parse", "parse"]);
    expect(useToolStore.getState().activeTakeoffItemId).toBe(41);
    expect(useToolStore.getState().activeTool).toBe(bucketActivation);
    expectTerminalReset("table", token);
    unsubscribeParse();
    unsubscribeTool();
  });
});
