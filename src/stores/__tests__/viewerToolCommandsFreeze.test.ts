// @vitest-environment node
// [refactor jul11 P2.3 T2] Post-carve characterization for the flat tool-store command seams.
//
// The first tool ownership flip splits actions that are currently one Zustand publication across
// the residual parse owner and toolStore. These tests freeze the legacy transition predicates,
// touched/untouched fields, action ordering, and the two viewer event cascades before that split.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useToolStore } from "@/stores/toolStore";
import {
  resetAllTools,
  setKeynoteParseStep,
  setNotesParseStep,
  setSpecParseStep,
  setTableParseStep,
} from "@/stores/viewerCommands";
import { useViewerStore } from "@/stores/viewerStore";

type ViewerState = ReturnType<typeof useViewerStore.getState>;
type ToolState = ReturnType<typeof useToolStore.getState>;

const ANNOTATION_OVERLAY = "src/components/viewer/AnnotationOverlay.tsx";
const PDF_VIEWER = "src/components/viewer/PDFViewer.tsx";

const PARSE_ENTRY_TOOL_KEYS = [
  "bucketFillActive",
  "bucketFillBarrierMode",
  "bucketFillLoading",
  "bucketFillPreview",
  "mode",
  "splitAreaActive",
  "symbolSearchActive",
] as const;

const PARSE_CASES = [
  {
    label: "table",
    key: "tableParseStep",
    action: "setTableParseStep",
  },
  {
    label: "keynote",
    key: "keynoteParseStep",
    action: "setKeynoteParseStep",
  },
  {
    label: "notes",
    key: "notesParseStep",
    action: "setNotesParseStep",
  },
  {
    label: "spec",
    key: "specParseStep",
    action: "setSpecParseStep",
  },
] as const;

function restoreViewerStore(): void {
  useToolStore.setState(useToolStore.getInitialState(), true);
  useViewerStore.setState(useViewerStore.getInitialState(), true);
}

function changedValueKeys(before: object, after: object): string[] {
  const previous = before as Record<string, unknown>;
  const current = after as Record<string, unknown>;
  return Object.keys(previous)
    .filter((key) => !Object.is(previous[key], current[key]))
    .sort();
}

function seedCompetingTools(): {
  polygonVertices: ToolState["polygonVertices"];
  bucketFillBarriers: ToolState["bucketFillBarriers"];
} {
  const polygonVertices = [{ x: 0.2, y: 0.3 }];
  const bucketFillBarriers = [{ x1: 0.1, y1: 0.2, x2: 0.8, y2: 0.9 }];
  useToolStore.setState({
    mode: "markup",
    activeTakeoffItemId: 41,
    polygonDrawingMode: "drawing",
    polygonVertices,
    bucketFillActive: true,
    bucketFillPreview: {
      vertices: [{ x: 0.1, y: 0.1 }],
      method: "sentinel",
    },
    bucketFillLoading: true,
    bucketFillError: "retain-bucket-error",
    bucketFillBarriers,
    bucketFillBarrierMode: true,
    barrierPendingPoint: { x: 0.4, y: 0.5 },
    splitAreaActive: true,
    splitLineA: { x: 0.2, y: 0.2 },
    splitLineB: { x: 0.8, y: 0.8 },
    splitError: "retain-split-error",
    symbolSearchActive: true,
    symbolSearchError: "retain-symbol-error",
    tempPanMode: true,
  });
  return { polygonVertices, bucketFillBarriers };
}

function invokeParseStep(
  actionName: (typeof PARSE_CASES)[number]["action"],
  step: string,
): void {
  const actions = {
    setTableParseStep,
    setKeynoteParseStep,
    setNotesParseStep,
    setSpecParseStep,
  };
  (actions[actionName] as (next: string) => void)(step);
}

function parseSource(relativePath: string): ts.SourceFile {
  const sourceText = readFileSync(join(process.cwd(), relativePath), "utf8");
  return ts.createSourceFile(
    relativePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
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

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function compact(node: ts.Node, source: ts.SourceFile): string {
  return node.getText(source).replace(/\s+/g, "");
}

function functionBlock(
  expression: ts.Expression,
): ts.Block {
  const unwrapped = unwrapExpression(expression);
  if (
    (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)) &&
    ts.isBlock(unwrapped.body)
  ) {
    return unwrapped.body;
  }
  throw new Error("Expected a block-bodied function expression");
}

function callLabels(root: ts.Node, source: ts.SourceFile): string[] {
  return descendants(root, ts.isCallExpression).map((call) => compact(call.expression, source));
}

function directBranchCalls(statement: ts.Statement, source: ts.SourceFile): string[] {
  return callLabels(statement, source).filter(
    (label) => label !== "useViewerStore.getState",
  );
}

function ifChain(
  root: ts.IfStatement,
): Array<{ condition: ts.Expression; body: ts.Statement }> {
  const branches: Array<{ condition: ts.Expression; body: ts.Statement }> = [];
  let current: ts.IfStatement | undefined = root;
  while (current) {
    branches.push({ condition: current.expression, body: current.thenStatement });
    const next: ts.Statement | undefined = current.elseStatement;
    current = next && ts.isIfStatement(next) ? next : undefined;
  }
  return branches;
}

function findNamedFunction(root: ts.Node, name: string): ts.FunctionDeclaration {
  const matches = descendants(
    root,
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  expect(matches, `one ${name} declaration`).toHaveLength(1);
  return matches[0];
}

function useEffectCalls(source: ts.SourceFile): ts.CallExpression[] {
  return descendants(source, ts.isCallExpression).filter((call) => {
    const expression = unwrapExpression(call.expression);
    return ts.isIdentifier(expression) && expression.text === "useEffect";
  });
}

function dependencyTexts(effect: ts.CallExpression, source: ts.SourceFile): string[] {
  const dependencies = effect.arguments[1];
  if (!dependencies || !ts.isArrayLiteralExpression(dependencies)) {
    throw new Error("Expected a useEffect dependency array");
  }
  return dependencies.elements.map((element) => compact(element, source));
}

beforeEach(() => {
  restoreViewerStore();
});

describe("P2.3 T2 parse-step cross-boundary characterization", () => {
  for (const parseCase of PARSE_CASES) {
    it(`${parseCase.label}: idle -> active publishes tool first, then the residual parse owner`, () => {
      const retained = seedCompetingTools();
      useViewerStore.setState({ [parseCase.key]: "idle" } as Partial<ViewerState>);
      const beforeTool = useToolStore.getState();
      const beforeViewer = useViewerStore.getState();
      const trace: string[] = [];
      const unsubscribeTool = useToolStore.subscribe(() => trace.push("tool"));
      const unsubscribeViewer = useViewerStore.subscribe(() => trace.push("viewer"));

      invokeParseStep(parseCase.action, "select-region");

      const afterTool = useToolStore.getState();
      const afterViewer = useViewerStore.getState();
      expect(trace).toEqual(["tool", "viewer"]);
      expect(changedValueKeys(beforeTool, afterTool)).toEqual([...PARSE_ENTRY_TOOL_KEYS].sort());
      expect(changedValueKeys(beforeViewer, afterViewer)).toEqual([parseCase.key]);
      expect(afterViewer[parseCase.key]).toBe("select-region");
      expect(afterTool).toMatchObject({
        mode: "move",
        bucketFillActive: false,
        bucketFillPreview: null,
        bucketFillLoading: false,
        bucketFillBarrierMode: false,
        splitAreaActive: false,
        symbolSearchActive: false,
        activeTakeoffItemId: 41,
        polygonDrawingMode: "drawing",
        bucketFillError: "retain-bucket-error",
        barrierPendingPoint: { x: 0.4, y: 0.5 },
        splitLineA: { x: 0.2, y: 0.2 },
        splitLineB: { x: 0.8, y: 0.8 },
        splitError: "retain-split-error",
        symbolSearchError: "retain-symbol-error",
        tempPanMode: true,
      });
      expect(afterTool.polygonVertices).toBe(retained.polygonVertices);
      expect(afterTool.bucketFillBarriers).toBe(retained.bucketFillBarriers);
      unsubscribeTool();
      unsubscribeViewer();
    });

    it(`${parseCase.label}: non-entry transitions publish but never clear tool state`, () => {
      const retained = seedCompetingTools();
      useViewerStore.setState({ [parseCase.key]: "select-region" } as Partial<ViewerState>);
      const viewerListener = vi.fn();
      const toolListener = vi.fn();
      const unsubscribeViewer = useViewerStore.subscribe(viewerListener);
      const unsubscribeTool = useToolStore.subscribe(toolListener);

      const beforeReview = useViewerStore.getState();
      invokeParseStep(parseCase.action, "review");
      expect(viewerListener).toHaveBeenCalledTimes(1);
      expect(toolListener).not.toHaveBeenCalled();
      expect(changedValueKeys(beforeReview, useViewerStore.getState())).toEqual([parseCase.key]);

      const beforeRepeatedReview = useViewerStore.getState();
      invokeParseStep(parseCase.action, "review");
      expect(viewerListener).toHaveBeenCalledTimes(2);
      expect(toolListener).not.toHaveBeenCalled();
      expect(changedValueKeys(beforeRepeatedReview, useViewerStore.getState())).toEqual([]);

      const beforeIdle = useViewerStore.getState();
      invokeParseStep(parseCase.action, "idle");
      expect(viewerListener).toHaveBeenCalledTimes(3);
      expect(toolListener).not.toHaveBeenCalled();
      expect(changedValueKeys(beforeIdle, useViewerStore.getState())).toEqual([parseCase.key]);

      const after = useToolStore.getState();
      expect(after).toMatchObject({
        mode: "markup",
        bucketFillActive: true,
        bucketFillLoading: true,
        bucketFillBarrierMode: true,
        splitAreaActive: true,
        symbolSearchActive: true,
        activeTakeoffItemId: 41,
        tempPanMode: true,
      });
      expect(after.polygonVertices).toBe(retained.polygonVertices);
      expect(after.bucketFillBarriers).toBe(retained.bucketFillBarriers);
      unsubscribeViewer();
      unsubscribeTool();
    });
  }
});

describe("P2.3 T2 resetAllTools characterization", () => {
  it("calls seven leaf actions in order across both owners, and every call publishes synchronously", () => {
    useToolStore.setState({
      mode: "markup",
      symbolSearchResults: {
        templateBbox: [0.1, 0.2, 0.3, 0.4],
        sourcePageNumber: 2,
        matches: [],
        totalMatches: 0,
        pagesWithMatches: [],
        searchedAt: "sentinel",
      },
    });
    useViewerStore.setState({
      tableParseStep: "review",
      keynoteParseStep: "review",
      notesParseStep: "review",
      specParseStep: "review",
      guidedParseActive: true,
    });
    const realTool = useToolStore.getState();
    const realViewer = useViewerStore.getState();
    const trace: string[] = [];
    useToolStore.setState({
      setMode: (mode) => {
        trace.push("call:setMode");
        realTool.setMode(mode);
      },
      clearSymbolSearch: () => {
        trace.push("call:clearSymbolSearch");
        realTool.clearSymbolSearch();
      },
    });
    useViewerStore.setState({
      resetTableParse: () => {
        trace.push("call:resetTableParse");
        realViewer.resetTableParse();
      },
      resetKeynoteParse: () => {
        trace.push("call:resetKeynoteParse");
        realViewer.resetKeynoteParse();
      },
      resetNotesParse: () => {
        trace.push("call:resetNotesParse");
        realViewer.resetNotesParse();
      },
      resetSpecParse: () => {
        trace.push("call:resetSpecParse");
        realViewer.resetSpecParse();
      },
      resetGuidedParse: () => {
        trace.push("call:resetGuidedParse");
        realViewer.resetGuidedParse();
      },
    });
    const unsubscribeTool = useToolStore.subscribe(() => trace.push("publication:tool"));
    const unsubscribeViewer = useViewerStore.subscribe(() => trace.push("publication:viewer"));

    resetAllTools();

    expect(trace).toEqual([
      "call:setMode",
      "publication:tool",
      "call:resetTableParse",
      "publication:viewer",
      "call:resetKeynoteParse",
      "publication:viewer",
      "call:resetNotesParse",
      "publication:viewer",
      "call:resetSpecParse",
      "publication:viewer",
      "call:resetGuidedParse",
      "publication:viewer",
      "call:clearSymbolSearch",
      "publication:tool",
    ]);
    unsubscribeTool();
    unsubscribeViewer();
  });

  it("pins reset output and the deliberately retained tool/parse omissions", () => {
    const scaleCalibrations: ToolState["scaleCalibrations"] = {
      2: {
        type: "scale-calibration",
        point1: { x: 0.1, y: 0.1 },
        point2: { x: 0.9, y: 0.9 },
        realDistance: 20,
        unit: "ft",
      },
    };
    const takeoffUndoStack: ToolState["takeoffUndoStack"] = [];
    const takeoffRedoStack: ToolState["takeoffRedoStack"] = [];
    const pendingPolygon: NonNullable<ToolState["bucketFillPendingPolygon"]> = {
      vertices: [{ x: 0.1, y: 0.1 }],
      method: "sentinel",
      bbox: [0.1, 0.1, 0.8, 0.8],
      areaSqUnits: 12,
      unit: "SF",
    };
    const paragraphClipboard: NonNullable<ViewerState["paragraphClipboard"]> = {
      colBoundaries: [0.25, 0.75],
      headers: ["Tag", "Description"],
    };
    const notesFastManualGrid: NonNullable<ViewerState["notesFastManualGrid"]> = {
      headers: ["Note"],
      rows: [{ Note: "retain" }],
    };
    const parsedKeynoteData: NonNullable<ViewerState["parsedKeynoteData"]> = [
      { pageNumber: 2, keys: [{ key: "1", description: "Door" }] },
    ];

    useToolStore.setState({
      mode: "markup",
      activeTakeoffItemId: 41,
      takeoffUndoStack,
      takeoffRedoStack,
      scaleCalibrations,
      calibrationMode: "input",
      calibrationPoints: { p1: { x: 0.1, y: 0.2 } },
      polygonDrawingMode: "drawing",
      polygonVertices: [{ x: 0.2, y: 0.3 }],
      bucketFillActive: true,
      bucketFillPreview: { vertices: [{ x: 0.1, y: 0.1 }], method: "sentinel" },
      bucketFillLoading: true,
      bucketFillError: "retain-bucket-error",
      bucketFillTolerance: 77,
      bucketFillDilatePx: 9,
      bucketFillResolution: 4000,
      bucketFillPendingPolygon: pendingPolygon,
      bucketFillBarriers: [{ x1: 0, y1: 0, x2: 1, y2: 1 }],
      bucketFillBarrierMode: true,
      barrierPendingPoint: { x: 0.4, y: 0.5 },
      splitAreaActive: true,
      splitLineA: { x: 0.1, y: 0.1 },
      splitLineB: { x: 0.9, y: 0.9 },
      splitPreview: {
        targetAnnotationId: 7,
        original: [],
        left: [],
        right: [],
        lineA: { x: 0.1, y: 0.1 },
        lineB: { x: 0.9, y: 0.9 },
      },
      splitError: "split-error",
      yoloTagPickingMode: true,
      tagScanResults: { yoloClass: "door", yoloModel: "model", texts: [] },
      tagAddingMode: "tag-1",
      symbolSearchActive: true,
      symbolSearchLoading: true,
      symbolSearchResults: {
        templateBbox: [0.1, 0.2, 0.3, 0.4],
        sourcePageNumber: 2,
        matches: [],
        totalMatches: 0,
        pagesWithMatches: [],
        searchedAt: "sentinel",
      },
      symbolSearchPreset: "power",
      tempPanMode: true,
    });
    useViewerStore.setState({
      tableParseTab: "compare",
      tableParseStep: "review",
      tableParseRegion: [0.1, 0.1, 0.9, 0.9],
      tableParsedGrid: { headers: ["Tag"], rows: [{ Tag: "D-101" }] },
      tableCellStructure: {
        cells: [],
        pageNumber: 2,
        regionBbox: [0.1, 0.1, 0.9, 0.9],
      },
      showTableCellStructure: true,
      keynoteParseTab: "compare",
      keynoteParseStep: "review",
      keynoteParseRegion: [0.1, 0.1, 0.9, 0.9],
      parsedKeynoteData,
      notesParseStep: "review",
      notesFastManualActive: true,
      notesFastManualGrid,
      specParseStep: "review",
      parseDraftRegion: {
        id: "draft",
        type: "notes",
        category: "notes",
        bbox: [0.1, 0.1, 0.9, 0.9],
        confidence: 1,
        data: {},
      },
      paragraphOverlayActive: true,
      paragraphBatch: [],
      paragraphClipboard,
      guidedParseActive: true,
      guidedParseRegion: [0.1, 0.1, 0.9, 0.9],
      guidedParseRows: [0.25],
      guidedParseCols: [0.75],
    });

    resetAllTools();

    const afterTool = useToolStore.getState();
    const afterViewer = useViewerStore.getState();
    expect(afterTool).toMatchObject({
      mode: "move",
      activeTakeoffItemId: null,
      polygonDrawingMode: "idle",
      polygonVertices: [],
      bucketFillActive: false,
      bucketFillPreview: null,
      bucketFillLoading: false,
      bucketFillBarriers: [],
      bucketFillBarrierMode: false,
      splitAreaActive: false,
      splitLineA: null,
      splitLineB: null,
      splitPreview: null,
      splitError: null,
      symbolSearchActive: false,
      symbolSearchLoading: false,
      symbolSearchResults: null,
      tempPanMode: false,
    });
    expect(afterViewer).toMatchObject({
      tableParseStep: "idle",
      tableParseRegion: null,
      tableParsedGrid: null,
      tableCellStructure: null,
      keynoteParseStep: "idle",
      keynoteParseRegion: null,
      notesParseStep: "idle",
      specParseStep: "idle",
      parseDraftRegion: null,
      paragraphOverlayActive: false,
      guidedParseActive: false,
      guidedParseRegion: null,
      guidedParseRows: [],
      guidedParseCols: [],
    });

    expect(afterTool.scaleCalibrations).toBe(scaleCalibrations);
    expect(afterTool.takeoffUndoStack).toBe(takeoffUndoStack);
    expect(afterTool.takeoffRedoStack).toBe(takeoffRedoStack);
    expect(afterTool.bucketFillPendingPolygon).toBe(pendingPolygon);
    expect(afterViewer.paragraphClipboard).toBe(paragraphClipboard);
    expect(afterViewer.notesFastManualGrid).toBe(notesFastManualGrid);
    expect(afterViewer.parsedKeynoteData).toBe(parsedKeynoteData);
    expect(afterTool).toMatchObject({
      calibrationMode: "input",
      calibrationPoints: { p1: { x: 0.1, y: 0.2 } },
      bucketFillError: "retain-bucket-error",
      bucketFillTolerance: 77,
      bucketFillDilatePx: 9,
      bucketFillResolution: 4000,
      barrierPendingPoint: { x: 0.4, y: 0.5 },
      yoloTagPickingMode: true,
      tagScanResults: { yoloClass: "door", yoloModel: "model", texts: [] },
      tagAddingMode: "tag-1",
      symbolSearchPreset: "power",
    });
    expect(afterViewer).toMatchObject({
      tableParseTab: "compare",
      showTableCellStructure: true,
      keynoteParseTab: "compare",
      notesFastManualActive: true,
    });
  });
});

describe("P2.3 T2 AnnotationOverlay event-command characterization", () => {
  const source = parseSource(ANNOTATION_OVERLAY);

  it("pins the Escape priority, live/captured split, and exact branch action order", () => {
    const handler = findNamedFunction(source, "handleEscape");
    if (!handler.body) throw new Error("handleEscape must have a body");
    const escapeIf = descendants(handler.body, ts.isIfStatement).find(
      (statement) => compact(statement.expression, source) === 'e.key==="Escape"',
    );
    if (!escapeIf || !ts.isBlock(escapeIf.thenStatement)) {
      throw new Error("Expected the Escape block");
    }

    const escapeBlock = escapeIf.thenStatement;
    const snapshotDeclarations = escapeBlock.statements.filter(ts.isVariableStatement);
    expect(snapshotDeclarations.map((statement) => compact(statement, source))).toEqual([
      "consttool=useToolStore.getState();",
      "constviewer=useViewerStore.getState();",
    ]);
    const cascade = escapeBlock.statements.find(ts.isIfStatement);
    if (!cascade) throw new Error("Expected the Escape priority cascade");
    const branches = ifChain(cascade);

    expect(branches.map(({ condition }) => compact(condition, source))).toEqual([
      "tool.splitPreview",
      "tool.splitAreaActive",
      "tool.bucketFillPendingPolygon",
      "tool.bucketFillPreview",
      "tool.bucketFillBarrierMode",
      "tool.bucketFillActive",
      'viewer.tableParseStep!=="idle"',
      'viewer.keynoteParseStep!=="idle"',
      'polygonDrawingMode==="drawing"',
      'calibrationMode!=="idle"',
      "activeTakeoffItemId!==null",
    ]);
    expect(branches.map(({ body }) => directBranchCalls(body, source))).toEqual([
      ["tool.setSplitPreview"],
      ["tool.setSplitAreaActive"],
      ["tool.setBucketFillPendingPolygon"],
      ["tool.setBucketFillPreview"],
      ["tool.setBucketFillBarrierMode", "tool.setBarrierPendingPoint"],
      ["tool.setBucketFillActive"],
      ["setTableParseStep", "tool.setMode"],
      ["setKeynoteParseStep", "tool.setMode"],
      ["resetPolygonDrawing", "setMousePos"],
      ["resetCalibration"],
      ["setActiveTakeoffItemId"],
    ]);

    // First six predicates use the live tool snapshot, the next two the live residual viewer
    // snapshot, and the final three deliberately use render-captured primitive subscriptions.
    expect(
      branches.slice(0, 6).every(({ condition }) => compact(condition, source).startsWith("tool.")),
    ).toBe(true);
    expect(
      branches.slice(6, 8).every(({ condition }) => compact(condition, source).startsWith("viewer.")),
    ).toBe(true);
    expect(
      branches.slice(8).some(({ condition }) => /^(?:tool|viewer)\./.test(compact(condition, source))),
    ).toBe(false);
    const conditions = branches.map(({ condition }) => compact(condition, source)).join("|");
    expect(conditions).not.toMatch(/notesParseStep|specParseStep|guidedParse/);
    expect(callLabels(escapeBlock, source)).not.toContain("e.preventDefault");
    expect(descendants(escapeBlock, ts.isBinaryExpression).some(
      (expression) => expression.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword,
    )).toBe(false);
  });

  it("pins the barrier Escape branch's deliberately duplicated null publication", () => {
    useToolStore.setState({
      bucketFillBarrierMode: true,
      barrierPendingPoint: { x: 0.4, y: 0.5 },
    });
    const publications: Array<{ mode: boolean; point: { x: number; y: number } | null }> = [];
    const unsubscribe = useToolStore.subscribe((state) => {
      publications.push({
        mode: state.bucketFillBarrierMode,
        point: state.barrierPendingPoint,
      });
    });
    const snapshot = useToolStore.getState();

    snapshot.setBucketFillBarrierMode(false);
    snapshot.setBarrierPendingPoint(null);

    expect(publications).toEqual([
      { mode: false, point: null },
      { mode: false, point: null },
    ]);
    unsubscribe();
  });

  it("pins page-change action order, one live snapshot, captured predicates, and omissions", () => {
    const pageEffect = useEffectCalls(source).find((effect) => {
      if (effect.arguments.length < 2) return false;
      if (dependencyTexts(effect, source).join(",") !== "pageNumber") return false;
      return callLabels(functionBlock(effect.arguments[0]), source).includes("setSelectedId");
    });
    if (!pageEffect) throw new Error("Expected the AnnotationOverlay page-change effect");
    const block = functionBlock(pageEffect.arguments[0]);

    const semanticOrder = block.statements.map((statement) => {
      if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
        return `call:${compact(statement.expression.expression, source)}`;
      }
      if (ts.isIfStatement(statement)) {
        return `if:${compact(statement.expression, source)}=>${directBranchCalls(statement.thenStatement, source).join(",")}`;
      }
      if (ts.isVariableStatement(statement)) {
        const declaration = statement.declarationList.declarations[0];
        return `snapshot:${compact(declaration.name, source)}=${declaration.initializer ? compact(declaration.initializer, source) : ""}`;
      }
      return compact(statement, source);
    });
    expect(semanticOrder).toEqual([
      "call:setSelectedId",
      'if:polygonDrawingMode==="drawing"=>resetPolygonDrawing,setMousePos',
      'if:calibrationMode!=="idle"=>resetCalibration',
      "snapshot:viewer=useViewerStore.getState()",
      "snapshot:tool=useToolStore.getState()",
      'if:viewer.tableParseStep!=="idle"=>viewer.resetTableParse,tool.setMode',
      'if:viewer.keynoteParseStep!=="idle"=>viewer.resetKeynoteParse,viewer.setKeynoteParseRegion,tool.setMode',
      "if:tool.symbolSearchActive=>tool.setSymbolSearchActive",
    ]);
    expect(dependencyTexts(pageEffect, source)).toEqual(["pageNumber"]);
    expect(
      callLabels(block, source).filter((label) => /use(?:Viewer|Tool)Store\.getState/.test(label)),
    ).toEqual(["useViewerStore.getState", "useToolStore.getState"]);

    const conditions = block.statements
      .filter(ts.isIfStatement)
      .map((statement) => compact(statement.expression, source));
    expect(conditions.slice(0, 2)).toEqual([
      'polygonDrawingMode==="drawing"',
      'calibrationMode!=="idle"',
    ]);
    expect(conditions.slice(2)).toEqual([
      'viewer.tableParseStep!=="idle"',
      'viewer.keynoteParseStep!=="idle"',
      "tool.symbolSearchActive",
    ]);
    expect(conditions.join("|")).not.toMatch(
      /bucketFill|splitArea|notesParseStep|specParseStep|guidedParse/,
    );
  });
});

describe("P2.3 T2 PDFViewer temporary-pan command characterization", () => {
  const source = parseSource(PDF_VIEWER);
  const keyboardEffect = useEffectCalls(source).find((effect) => {
    const callback = effect.arguments[0];
    if (!callback) return false;
    const block = functionBlock(callback);
    const names = descendants(block, ts.isFunctionDeclaration)
      .map((fn) => fn.name?.text)
      .filter((name): name is string => !!name);
    return names.includes("handleKeyDown") && names.includes("handleKeyUp") && names.includes("handleBlur");
  });
  if (!keyboardEffect) throw new Error("Expected PDFViewer's a/v keyboard effect");
  const effectBlock = functionBlock(keyboardEffect.arguments[0]);

  it("pins the exact v-active predicate and pointer/temp-pan destinations", () => {
    const keyDown = findNamedFunction(effectBlock, "handleKeyDown");
    if (!keyDown.body) throw new Error("handleKeyDown must have a body");
    const toolActive = descendants(keyDown.body, ts.isVariableDeclaration).find(
      (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "toolActive",
    );
    if (!toolActive?.initializer) throw new Error("Expected toolActive initializer");
    expect(compact(toolActive.initializer, source)).toBe(
      's.activeTakeoffItemId!==null||s.bucketFillActive||s.splitAreaActive||s.polygonDrawingMode==="drawing"||s.calibrationMode!=="idle"',
    );

    const calls = descendants(keyDown.body, ts.isCallExpression)
      .filter((call) => {
        const label = compact(call.expression, source);
        return label === "setMode" || label === "s.setTempPanMode" || label === "useToolStore.getState";
      })
      .map((call) => ({
        callee: compact(call.expression, source),
        args: call.arguments.map((argument) => compact(argument, source)),
      }));
    expect(calls).toEqual([
      { callee: "setMode", args: ['"pointer"'] },
      { callee: "useToolStore.getState", args: [] },
      { callee: "s.setTempPanMode", args: ["true"] },
      { callee: "setMode", args: ['"move"'] },
    ]);

    const vBranch = descendants(keyDown.body, ts.isIfStatement).find(
      (statement) => compact(statement.expression, source) === 'e.key==="v"',
    );
    if (!vBranch || !ts.isBlock(vBranch.thenStatement)) throw new Error("Expected the v branch");
    expect(compact(vBranch.thenStatement.statements[0], source)).toBe("if(e.repeat)return;");
  });

  it("pins keyup deferral, blur cleanup, and the mount-time dependency", () => {
    const keyUp = findNamedFunction(effectBlock, "handleKeyUp");
    const blur = findNamedFunction(effectBlock, "handleBlur");
    if (!keyUp.body || !blur.body) throw new Error("PDFViewer key handlers must have bodies");

    expect(
      descendants(keyUp.body, ts.isIfStatement).map((statement) => compact(statement.expression, source)),
    ).toEqual([
      'e.key!=="v"',
      "!s.tempPanMode",
      "isPanningRef.current",
    ]);
    expect(compact(keyUp.body, source)).toContain("vReleasedDuringPanRef.current=true");
    expect(compact(keyUp.body, source)).toContain("s.setTempPanMode(false)");
    expect(compact(blur.body, source)).toBe("{useToolStore.getState().setTempPanMode(false);}");
    expect(dependencyTexts(keyboardEffect, source)).toEqual(["setMode"]);
  });
});
