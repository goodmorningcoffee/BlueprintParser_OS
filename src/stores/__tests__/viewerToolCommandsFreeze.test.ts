// @vitest-environment node
// [refactor jul11 P2.3 T2] Post-carve characterization for the flat tool-store command seams.
//
// The tool/parse ownership flip splits actions that were once one Zustand publication across
// parseFlowStore and toolStore. These tests freeze the canonical activation predicates,
// touched/untouched fields, action ordering, and the two viewer event cascades across that split.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { beforeEach, describe, expect, it } from "vitest";
import { PARSE_KINDS } from "@/lib/parse-operation-state";
import { useParseFlowStore } from "@/stores/parseFlowStore";
import { useToolStore } from "@/stores/toolStore";
import {
  resetAllTools,
  setKeynoteParseStep,
  setNotesParseStep,
  setSpecParseStep,
  setTableParseStep,
} from "@/stores/viewerCommands";

type ParseState = ReturnType<typeof useParseFlowStore.getState>;
type ToolState = ReturnType<typeof useToolStore.getState>;

const ANNOTATION_OVERLAY = "src/components/viewer/AnnotationOverlay.tsx";
const PDF_VIEWER = "src/components/viewer/PDFViewer.tsx";
const VIEWER_COMMANDS = "src/stores/viewerCommands.ts";

const PARSE_ENTRY_TOOL_KEYS = [
  "activeTakeoffItemId",
  "activeTool",
  "mode",
  "polygonDrawingMode",
  "polygonVertices",
] as const;

const PARSE_CASES = [
  {
    label: "table",
    key: "tableParseStep",
    action: "setTableParseStep",
    drawTargets: ["select-region", "define-column", "define-row"],
    passiveTargets: ["review"],
  },
  {
    label: "keynote",
    key: "keynoteParseStep",
    action: "setKeynoteParseStep",
    drawTargets: ["select-region", "define-column", "define-row"],
    passiveTargets: ["review"],
  },
  {
    label: "notes",
    key: "notesParseStep",
    action: "setNotesParseStep",
    drawTargets: ["select-region", "define-column", "define-row"],
    passiveTargets: ["review"],
  },
  {
    label: "spec",
    key: "specParseStep",
    action: "setSpecParseStep",
    drawTargets: ["select-region"],
    passiveTargets: ["define-sections", "review"],
  },
] as const;

function restoreStores(): void {
  useToolStore.setState(useToolStore.getInitialState(), true);
  useParseFlowStore.setState(useParseFlowStore.getInitialState(), true);
}

function changedValueKeys(before: object, after: object): string[] {
  const previous = before as Record<string, unknown>;
  const current = after as Record<string, unknown>;
  return Object.keys(previous)
    .filter((key) => !Object.is(previous[key], current[key]))
    .sort();
}

function seedDormantToolSessions(
  activeTool: ToolState["activeTool"] = { kind: "bucketFill" },
): {
  polygonVertices: ToolState["polygonVertices"];
  bucketFillBarriers: ToolState["bucketFillBarriers"];
  activeTool: ToolState["activeTool"];
} {
  const polygonVertices = [{ x: 0.2, y: 0.3 }];
  const bucketFillBarriers = [{ x1: 0.1, y1: 0.2, x2: 0.8, y2: 0.9 }];
  useToolStore.setState({
    mode: "markup",
    activeTool,
    activeTakeoffItemId: 41,
    polygonDrawingMode: "drawing",
    polygonVertices,
    bucketFillPreview: {
      vertices: [{ x: 0.1, y: 0.1 }],
      method: "sentinel",
    },
    bucketFillLoading: true,
    bucketFillError: "retain-bucket-error",
    bucketFillBarriers,
    bucketFillBarrierMode: true,
    barrierPendingPoint: { x: 0.4, y: 0.5 },
    splitLineA: { x: 0.2, y: 0.2 },
    splitLineB: { x: 0.8, y: 0.8 },
    splitError: "retain-split-error",
    symbolSearchError: "retain-symbol-error",
    tempPanMode: true,
  });
  return { polygonVertices, bucketFillBarriers, activeTool };
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
    (label) => label !== "useParseFlowStore.getState",
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
  restoreStores();
});

describe("P2.3 T2 parse-step cross-boundary characterization", () => {
  for (const parseCase of PARSE_CASES) {
    it(`${parseCase.label}: every draw-capable target renews one exact parse owner Tool-first`, () => {
      for (const target of parseCase.drawTargets) {
        restoreStores();
        const retained = seedDormantToolSessions();
        useParseFlowStore.setState({ [parseCase.key]: "idle" } as Partial<ParseState>);
        const beforeTool = useToolStore.getState();
        const beforeParse = useParseFlowStore.getState();
        const trace: string[] = [];
        const unsubscribeTool = useToolStore.subscribe(() => trace.push("tool"));
        const unsubscribeParse = useParseFlowStore.subscribe(() => trace.push("parse"));

        invokeParseStep(parseCase.action, target);

        expect(trace, `${parseCase.label} -> ${target}`).toEqual(["tool", "parse"]);
        const afterTool = useToolStore.getState();
        const afterParse = useParseFlowStore.getState();
        expect(changedValueKeys(beforeTool, afterTool)).toEqual([...PARSE_ENTRY_TOOL_KEYS].sort());
        expect(changedValueKeys(beforeParse, afterParse)).toEqual(
          [parseCase.key, "parseOperations"].sort(),
        );
        expect(afterParse[parseCase.key]).toBe(target);
        expect(afterTool).toMatchObject({
          mode: "move",
          activeTool: { kind: "parseRect", flow: parseCase.label },
          activeTakeoffItemId: null,
          polygonDrawingMode: "idle",
          polygonVertices: [],
          bucketFillLoading: true,
          bucketFillBarrierMode: true,
          tempPanMode: true,
        });
        expect(afterTool.bucketFillBarriers).toBe(retained.bucketFillBarriers);
        unsubscribeTool();
        unsubscribeParse();
      }
    });

    it(`${parseCase.label}: same-kind draw entry publishes a fresh activation and gesture buffer`, () => {
      const previousActivation = { kind: "parseRect", flow: parseCase.label } as const;
      const previousVertices: ToolState["polygonVertices"] = [];
      useToolStore.setState({
        mode: "move",
        activeTool: previousActivation,
        activeTakeoffItemId: null,
        polygonDrawingMode: "idle",
        polygonVertices: previousVertices,
      });
      useParseFlowStore.setState({ [parseCase.key]: "idle" } as Partial<ParseState>);
      const beforeTool = useToolStore.getState();
      const beforeParse = useParseFlowStore.getState();
      const trace: string[] = [];
      const unsubscribeTool = useToolStore.subscribe(() => trace.push("tool"));
      const unsubscribeParse = useParseFlowStore.subscribe(() => trace.push("parse"));

      invokeParseStep(parseCase.action, parseCase.drawTargets[0]);

      expect(trace).toEqual(["tool", "parse"]);
      const afterTool = useToolStore.getState();
      expect(changedValueKeys(beforeTool, afterTool)).toEqual(["activeTool", "polygonVertices"]);
      expect(afterTool.activeTool).toEqual(previousActivation);
      expect(afterTool.activeTool).not.toBe(previousActivation);
      expect(afterTool.polygonVertices).toEqual([]);
      expect(afterTool.polygonVertices).not.toBe(previousVertices);
      expect(changedValueKeys(beforeParse, useParseFlowStore.getState())).toEqual(
        [parseCase.key, "parseOperations"].sort(),
      );
      unsubscribeTool();
      unsubscribeParse();
    });

    it(`${parseCase.label}: null -> draw-capable installs the sole owner and clears gesture state`, () => {
      const retained = seedDormantToolSessions(null);
      useParseFlowStore.setState({ [parseCase.key]: "idle" } as Partial<ParseState>);
      const beforeTool = useToolStore.getState();
      const beforeParse = useParseFlowStore.getState();
      const trace: string[] = [];
      const unsubscribeTool = useToolStore.subscribe(() => trace.push("tool"));
      const unsubscribeParse = useParseFlowStore.subscribe(() => trace.push("parse"));

      invokeParseStep(parseCase.action, "select-region");

      const afterTool = useToolStore.getState();
      const afterParse = useParseFlowStore.getState();
      expect(trace).toEqual(["tool", "parse"]);
      expect(changedValueKeys(beforeTool, afterTool)).toEqual([...PARSE_ENTRY_TOOL_KEYS].sort());
      expect(changedValueKeys(beforeParse, afterParse)).toEqual(
        [parseCase.key, "parseOperations"].sort(),
      );
      expect(afterParse[parseCase.key]).toBe("select-region");
      expect(afterTool).toMatchObject({
        mode: "move",
        activeTool: { kind: "parseRect", flow: parseCase.label },
        activeTakeoffItemId: null,
        polygonDrawingMode: "idle",
        polygonVertices: [],
        bucketFillLoading: true,
        bucketFillBarrierMode: true,
        bucketFillError: "retain-bucket-error",
        barrierPendingPoint: { x: 0.4, y: 0.5 },
        splitLineA: { x: 0.2, y: 0.2 },
        splitLineB: { x: 0.8, y: 0.8 },
        splitError: "retain-split-error",
        symbolSearchError: "retain-symbol-error",
        tempPanMode: true,
      });
      expect(afterTool.polygonVertices).not.toBe(retained.polygonVertices);
      expect(afterTool.bucketFillBarriers).toBe(retained.bucketFillBarriers);
      unsubscribeTool();
      unsubscribeParse();
    });

    it(`${parseCase.label}: passive targets are Parse-only and preserve an unrelated exact owner`, () => {
      for (const target of parseCase.passiveTargets) {
        restoreStores();
        const retained = seedDormantToolSessions();
        useParseFlowStore.setState({ [parseCase.key]: "idle" } as Partial<ParseState>);
        const beforeTool = useToolStore.getState();
        const beforeParse = useParseFlowStore.getState();
        const trace: string[] = [];
        const unsubscribeTool = useToolStore.subscribe(() => trace.push("tool"));
        const unsubscribeParse = useParseFlowStore.subscribe(() => trace.push("parse"));

        invokeParseStep(parseCase.action, target);

        expect(trace).toEqual(["parse"]);
        expect(useToolStore.getState()).toBe(beforeTool);
        expect(useToolStore.getState().activeTool).toBe(retained.activeTool);
        expect(changedValueKeys(beforeParse, useParseFlowStore.getState())).toEqual(
          [parseCase.key, "parseOperations"].sort(),
        );
        unsubscribeTool();
        unsubscribeParse();
      }
    });

    it(`${parseCase.label}: leaving drawing releases only its matching activation`, () => {
      const activation = { kind: "parseRect", flow: parseCase.label } as const;
      seedDormantToolSessions(activation);
      useToolStore.setState({
        mode: "move",
        activeTakeoffItemId: null,
        polygonDrawingMode: "idle",
        polygonVertices: [],
      });
      useParseFlowStore.setState({
        [parseCase.key]: parseCase.drawTargets[0],
      } as Partial<ParseState>);
      const beforeTool = useToolStore.getState();
      const beforeParse = useParseFlowStore.getState();
      const trace: string[] = [];
      const unsubscribeTool = useToolStore.subscribe(() => trace.push("tool"));
      const unsubscribeParse = useParseFlowStore.subscribe(() => trace.push("parse"));

      invokeParseStep(parseCase.action, parseCase.passiveTargets[0]);

      expect(trace).toEqual(["tool", "parse"]);
      expect(changedValueKeys(beforeTool, useToolStore.getState())).toEqual(["activeTool"]);
      expect(useToolStore.getState().activeTool).toBeNull();
      expect(changedValueKeys(beforeParse, useParseFlowStore.getState())).toEqual([parseCase.key]);
      unsubscribeTool();
      unsubscribeParse();
    });

    it(`${parseCase.label}: a dormant draw step cannot release an unrelated owner`, () => {
      const retained = seedDormantToolSessions();
      useParseFlowStore.setState({
        [parseCase.key]: parseCase.drawTargets[0],
      } as Partial<ParseState>);
      const beforeTool = useToolStore.getState();
      const trace: string[] = [];
      const unsubscribeTool = useToolStore.subscribe(() => trace.push("tool"));
      const unsubscribeParse = useParseFlowStore.subscribe(() => trace.push("parse"));

      invokeParseStep(parseCase.action, parseCase.passiveTargets[0]);

      expect(trace).toEqual(["parse"]);
      expect(useToolStore.getState()).toBe(beforeTool);
      expect(useToolStore.getState().activeTool).toBe(retained.activeTool);
      unsubscribeTool();
      unsubscribeParse();
    });

    it(`${parseCase.label}: semantic-null drawing exit keeps the correlated Tool -> Parse boundary`, () => {
      useToolStore.setState({ activeTool: null, mode: "move" });
      useParseFlowStore.setState({
        [parseCase.key]: parseCase.drawTargets[0],
      } as Partial<ParseState>);
      const beforeTool = useToolStore.getState();
      const trace: string[] = [];
      const unsubscribeTool = useToolStore.subscribe(() => trace.push("tool"));
      const unsubscribeParse = useParseFlowStore.subscribe(() => trace.push("parse"));

      invokeParseStep(parseCase.action, parseCase.passiveTargets[0]);

      expect(trace).toEqual(["tool", "parse"]);
      expect(changedValueKeys(beforeTool, useToolStore.getState())).toEqual([]);
      expect(useToolStore.getState().activeTool).toBeNull();
      unsubscribeTool();
      unsubscribeParse();
    });
  }

  it("a reentrant same-kind B admitted by A's Tool release defeats A's stale Parse tail", () => {
    const activationA = { kind: "parseRect", flow: "table" } as const;
    useToolStore.setState({ activeTool: activationA, mode: "move" });
    useParseFlowStore.setState({ tableParseStep: "select-region" });
    const trace: string[] = [];
    let armed = true;
    let activationB: ToolState["activeTool"] = null;
    const unsubscribeTool = useToolStore.subscribe((state) => {
      trace.push("tool");
      if (!armed) return;
      armed = false;
      expect(state.activeTool).toBeNull();
      setTableParseStep("select-region");
      activationB = useToolStore.getState().activeTool;
    });
    const unsubscribeParse = useParseFlowStore.subscribe(() => trace.push("parse"));

    setTableParseStep("review");

    expect(trace).toEqual(["tool", "tool", "parse"]);
    expect(activationB).toEqual({ kind: "parseRect", flow: "table" });
    expect(activationB).not.toBe(activationA);
    expect(useToolStore.getState().activeTool).toBe(activationB);
    expect(useParseFlowStore.getState().tableParseStep).toBe("select-region");
    unsubscribeTool();
    unsubscribeParse();
  });
});

describe("P2.3 T2 resetAllTools characterization", () => {
  it("calls six leaf actions in order, then publishes the guarded symbol-session reset", () => {
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
    useParseFlowStore.setState({
      tableParseStep: "review",
      keynoteParseStep: "review",
      notesParseStep: "review",
      specParseStep: "review",
      guidedParseActive: true,
    });
    const realTool = useToolStore.getState();
    const realParse = useParseFlowStore.getState();
    const trace: string[] = [];
    useToolStore.setState({
      setMode: (mode) => {
        trace.push("call:setMode");
        realTool.setMode(mode);
      },
    });
    useParseFlowStore.setState({
      resetTableParse: () => {
        trace.push("call:resetTableParse");
        realParse.resetTableParse();
      },
      resetKeynoteParse: () => {
        trace.push("call:resetKeynoteParse");
        realParse.resetKeynoteParse();
      },
      resetNotesParse: () => {
        trace.push("call:resetNotesParse");
        realParse.resetNotesParse();
      },
      resetSpecParse: () => {
        trace.push("call:resetSpecParse");
        realParse.resetSpecParse();
      },
      resetGuidedParse: () => {
        trace.push("call:resetGuidedParse");
        realParse.resetGuidedParse();
      },
    });
    const unsubscribeTool = useToolStore.subscribe(() => trace.push("publication:tool"));
    const unsubscribeParse = useParseFlowStore.subscribe(() => trace.push("publication:parse"));

    resetAllTools();

    expect(trace).toEqual([
      "call:setMode",
      "publication:tool",
      "call:resetTableParse",
      "publication:parse",
      "call:resetKeynoteParse",
      "publication:parse",
      "call:resetNotesParse",
      "publication:parse",
      "call:resetSpecParse",
      "publication:parse",
      "call:resetGuidedParse",
      "publication:parse",
      "publication:tool",
    ]);
    unsubscribeTool();
    unsubscribeParse();
  });

  for (const kind of PARSE_KINDS) {
    for (const settleReplacement of [false, true]) {
      it(`has no tool or Parse tail after synchronous ${kind} B becomes ${
        settleReplacement ? "settled" : "busy"
      } from the terminal reset`, () => {
        useToolStore.setState({ mode: "markup" });
        useParseFlowStore.setState({
          tableParseStep: "review",
          keynoteParseStep: "review",
          notesParseStep: "review",
          specParseStep: "review",
        });
        let armed = true;
        let revisionB: number | null = null;
        const unsubscribe = useParseFlowStore.subscribe((state) => {
          if (
            !armed || state.tableParseStep !== "idle" ||
            state.keynoteParseStep !== "idle" || state.notesParseStep !== "idle" ||
            state.specParseStep !== "idle"
          ) return;
          armed = false;
          const started = state.beginParseOperation(kind);
          expect(started.status).toBe("started");
          if (started.status === "started") {
            revisionB = started.token.revision;
            if (settleReplacement) {
              expect(useParseFlowStore.getState().finishParseOperation(started.token)).toBe(true);
            }
          }
          useToolStore.setState({ mode: "markup" });
        });

        try {
          resetAllTools();
        } finally {
          unsubscribe();
        }

        expect(revisionB).not.toBeNull();
        expect(useParseFlowStore.getState().parseOperations[kind]).toEqual({
          revision: revisionB,
          busy: !settleReplacement,
        });
        expect(useToolStore.getState().mode).toBe("markup");
      });
    }
  }

  it("exhaustively matches the canonical reset output and retained tool/parse omissions", () => {
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
    const paragraphClipboard: NonNullable<ParseState["paragraphClipboard"]> = {
      colBoundaries: [0.25, 0.75],
      headers: ["Tag", "Description"],
    };
    const notesFastManualGrid: NonNullable<ParseState["notesFastManualGrid"]> = {
      headers: ["Note"],
      rows: [{ Note: "retain" }],
    };
    const parsedKeynoteData: NonNullable<ParseState["parsedKeynoteData"]> = [
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
      activeTool: { kind: "tagAdd", tagId: "tag-1" },
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
      tagScanResults: { yoloClass: "door", yoloModel: "model", texts: [] },
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
    useParseFlowStore.setState({
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
      notesParseRegion: [0.1, 0.1, 0.9, 0.9],
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
      paragraphWorkspaceOwner: "notes",
      paragraphBatch: [],
      paragraphClipboard,
      guidedParseActive: true,
      guidedParseRegion: [0.1, 0.1, 0.9, 0.9],
      guidedParseRows: [0.25],
      guidedParseCols: [0.75],
    });

    // Derive the exhaustive expected destination from the six leaf resets plus the terminal
    // symbol-session bytes. Captured states remain immutable after Zustand publishes replacements,
    // so they can be restored byte-for-byte before exercising the coordinated command.
    const seededTool = useToolStore.getState();
    const seededParse = useParseFlowStore.getState();
    seededTool.setMode("move");
    seededParse.resetTableParse();
    seededParse.resetKeynoteParse();
    seededParse.resetNotesParse();
    seededParse.resetSpecParse();
    seededParse.resetGuidedParse();
    seededTool.clearSymbolSearch();
    const expectedTool = Object.fromEntries(
      Object.entries(useToolStore.getState()).filter(([, value]) => typeof value !== "function"),
    );
    const expectedParse = Object.fromEntries(
      Object.entries(useParseFlowStore.getState()).filter(([, value]) => typeof value !== "function"),
    );

    useToolStore.setState(seededTool, true);
    useParseFlowStore.setState(seededParse, true);
    resetAllTools();

    const afterTool = useToolStore.getState();
    const afterParse = useParseFlowStore.getState();
    expect(Object.fromEntries(
      Object.entries(afterTool).filter(([, value]) => typeof value !== "function"),
    )).toEqual(expectedTool);
    expect(Object.fromEntries(
      Object.entries(afterParse).filter(([, value]) => typeof value !== "function"),
    )).toEqual(expectedParse);
    expect(afterTool).toMatchObject({
      mode: "move",
      activeTool: null,
      activeTakeoffItemId: null,
      polygonDrawingMode: "idle",
      polygonVertices: [],
      bucketFillPreview: null,
      bucketFillLoading: false,
      bucketFillBarriers: [],
      bucketFillBarrierMode: false,
      splitLineA: null,
      splitLineB: null,
      splitPreview: null,
      splitError: null,
      symbolSearchLoading: false,
      symbolSearchResults: null,
      tempPanMode: false,
    });
    expect(afterParse).toMatchObject({
      tableParseStep: "idle",
      tableParseRegion: null,
      tableParsedGrid: null,
      tableCellStructure: null,
      keynoteParseStep: "idle",
      keynoteParseRegion: null,
      notesParseStep: "idle",
      specParseStep: "idle",
      parseDraftRegion: null,
      paragraphWorkspaceOwner: null,
      guidedParseActive: false,
      guidedParseRegion: null,
      guidedParseRows: [],
      guidedParseCols: [],
    });

    expect(afterTool.scaleCalibrations).toBe(scaleCalibrations);
    expect(afterTool.takeoffUndoStack).toBe(takeoffUndoStack);
    expect(afterTool.takeoffRedoStack).toBe(takeoffRedoStack);
    expect(afterTool.bucketFillPendingPolygon).toBe(pendingPolygon);
    expect(afterParse.paragraphClipboard).toBe(paragraphClipboard);
    expect(afterParse.notesFastManualGrid).toBe(notesFastManualGrid);
    expect(afterParse.parsedKeynoteData).toBe(parsedKeynoteData);
    expect(afterTool).toMatchObject({
      calibrationMode: "input",
      calibrationPoints: { p1: { x: 0.1, y: 0.2 } },
      bucketFillError: "retain-bucket-error",
      bucketFillTolerance: 77,
      bucketFillDilatePx: 9,
      bucketFillResolution: 4000,
      barrierPendingPoint: { x: 0.4, y: 0.5 },
      tagScanResults: { yoloClass: "door", yoloModel: "model", texts: [] },
      symbolSearchPreset: "power",
    });
    expect(afterParse).toMatchObject({
      tableParseTab: "compare",
      showTableCellStructure: true,
      keynoteParseTab: "compare",
      notesFastManualActive: true,
    });
  });
});

describe("P2.3 T2 AnnotationOverlay event-command characterization", () => {
  const source = parseSource(ANNOTATION_OVERLAY);

  it("pins the captured gesture lease and exact flow-owned mouseup dispatch", () => {
    const callbackBody = (name: string): ts.Block => {
      const declarations = descendants(
        source,
        (node): node is ts.VariableDeclaration =>
          ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name,
      );
      expect(declarations, name).toHaveLength(1);
      const initializer = declarations[0].initializer;
      if (!initializer || !ts.isCallExpression(initializer)) throw new Error(`Expected ${name} callback`);
      return functionBlock(initializer.arguments[0]);
    };

    const startDrawing = callbackBody("startDeferredDrawing");
    const startText = compact(startDrawing, source);
    expect(startText).toContain("constsnapshot=readCanvasGestureSnapshot()");
    expect(startText).toContain("constlease=captureCanvasGestureLease(token,snapshot)");
    expect(startText).toContain("claimToolTailAuthority(token)");
    expect(startText).toContain("drawingLeaseRef.current=lease");
    expect(startText).toContain("registerToolTailCancellation(token,()=>{");
    expect(startText).toContain(
      "if(drawingLeaseRef.current!==lease)return;drawingLeaseRef.current=null;if(useToolStore.getState()._drawing)setDrawing(false)",
    );
    expect(startText).toContain(
      "conststillOwnsLease=()=>drawingLeaseRef.current===lease&&ownsToolTailAuthority(token)&&matchesCanvasGestureLease(lease,readCanvasGestureSnapshot())",
    );
    expect(callLabels(startDrawing, source).filter((label) => label === "stillOwnsLease"))
      .toHaveLength(3);

    const mouseUp = callbackBody("handleMouseUp");
    const mouseUpText = compact(mouseUp, source);
    expect(mouseUpText).toContain("constlease=drawingLeaseRef.current");
    const conditionalClear = "if(drawingLeaseRef.current===lease)drawingLeaseRef.current=null;";
    const release = "if(lease)releaseToolTailCancellation(lease.token);";
    expect(mouseUpText).toContain(`${conditionalClear}${release}setDrawing(false);`);
    expect(mouseUpText).toContain(
      "if(!lease||!ownsToolTailAuthority(lease.token)||!matchesCanvasGestureLease(lease,readCanvasGestureSnapshot()))return;",
    );

    const consumeCalls = descendants(mouseUp, ts.isCallExpression).filter(
      (call) => compact(call.expression, source) === "consumeToolTailAuthority",
    );
    expect(consumeCalls).toHaveLength(2);
    const commit = consumeCalls.find((call) => {
      const callback = call.arguments[1];
      return callback && compact(callback, source).includes("constowner=lease.owner");
    });
    if (!commit) throw new Error("Expected the lease-consuming mouseup commit");
    expect(compact(commit.arguments[0], source)).toBe("lease.token");
    const commitBody = functionBlock(commit.arguments[1]);
    const flowSwitch = descendants(commitBody, ts.isSwitchStatement).find(
      (statement) => compact(statement.expression, source) === "owner.activation.flow",
    );
    if (!flowSwitch) throw new Error("Expected parse flow dispatch from the captured owner");

    const caseCalls = Object.fromEntries(flowSwitch.caseBlock.clauses
      .filter(ts.isCaseClause)
      .map((clause) => [compact(clause.expression, source), callLabels(clause, source)]));
    expect(caseCalls).toEqual({
      '"table"': [
        "acceptTableParseRegion", "addTableParseColumnForUser", "addTableParseRowForUser",
      ],
      '"keynote"': [
        "acceptKeynoteParseRegion", "addKeynoteColumnForUser", "addKeynoteRowForUser",
      ],
      '"notes"': [
        "acceptNotesParseRegion", "addGuidedNotesColumnForUser", "addGuidedNotesRowForUser",
      ],
      '"spec"': ["acceptSpecParseRegion"],
    });
  });

  it("pins Escape to one exact live activation and kind-local action order", () => {
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
      "constexpectedActiveTool=useToolStore.getState().activeTool;",
      "consttool=useToolStore.getState();",
      "constactiveTool=expectedActiveTool;",
    ]);
    expect(compact(escapeBlock, source)).toContain(
      "cancelDeferredDrawing();consttool=useToolStore.getState();if(tool.activeTool!==expectedActiveTool)return;",
    );
    const cascade = escapeBlock.statements.filter(ts.isIfStatement).find(
      (statement) => compact(statement.expression, source) === 'activeTool?.kind==="split"',
    );
    if (!cascade) throw new Error("Expected the Escape priority cascade");
    const branches = ifChain(cascade);

    expect(branches.map(({ condition }) => compact(condition, source))).toEqual([
      'activeTool?.kind==="split"',
      'activeTool?.kind==="bucketFill"',
      'activeTool?.kind==="parseRect"',
      'activeTool?.kind==="takeoffPlacement"',
      'activeTool?.kind==="calibration"',
      'activeTool?.kind==="symbolTemplate"',
      'activeTool?.kind==="tagPick"',
      'activeTool?.kind==="tagAdd"',
    ]);
    expect(branches.map(({ body }) => directBranchCalls(body, source))).toEqual([
      ["invalidateToolTailAuthority", "tool.setSplitPreview", "tool.setSplitAreaActive"],
      [
        "invalidateToolTailAuthority", "invalidateLatestToolOperation",
        "tool.setBucketFillPendingPolygon", "invalidateToolTailAuthority",
        "invalidateLatestToolOperation", "tool.setBucketFillPreview",
        "invalidateLatestToolOperation", "tool.setBucketFillBarrierMode",
        "tool.setBucketFillActive",
      ],
      [
        "setTableParseStepWithTool", "setKeynoteParseStepWithTool",
        "setNotesParseStepWithTool", "setSpecParseStepWithTool",
      ],
      ["tool.resetPolygonDrawing", "setMousePos", "tool.setActiveTakeoffItemId"],
      ["tool.resetCalibration"],
      ["tool.setSymbolSearchActive"],
      ["tool.setYoloTagPickingMode"],
      ["tool.setTagAddingMode"],
    ]);

    const bucketBranch = branches[1].body;
    const bucketCascade = descendants(bucketBranch, ts.isIfStatement).find(
      (statement) => compact(statement.expression, source) === "tool.bucketFillPendingPolygon",
    );
    if (!bucketCascade) throw new Error("Expected exact Bucket Escape guards");
    expect(ifChain(bucketCascade).map(({ condition }) => compact(condition, source))).toEqual([
      "tool.bucketFillPendingPolygon",
      "tool.bucketFillPreview",
      "tool.bucketFillBarrierMode",
    ]);
    expect(callLabels(escapeBlock, source)).not.toContain("e.preventDefault");
    expect(descendants(escapeBlock, ts.isBinaryExpression).some(
      (expression) => expression.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword,
    )).toBe(false);
  });

  it("pins the barrier Escape action's atomic mode-and-pending-point publication", () => {
    useToolStore.setState({
      activeTool: { kind: "bucketFill" },
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

    expect(publications).toEqual([
      { mode: false, point: null },
    ]);
    unsubscribe();
  });

  it("keeps the Overlay page effect local and pins the global page authority boundary", () => {
    const pageEffect = useEffectCalls(source).find((effect) => {
      if (effect.arguments.length < 2) return false;
      if (dependencyTexts(effect, source).join(",") !== "pageNumber") return false;
      return callLabels(functionBlock(effect.arguments[0]), source).includes("setSelectedId");
    });
    if (!pageEffect) throw new Error("Expected the AnnotationOverlay page-change effect");
    const block = functionBlock(pageEffect.arguments[0]);

    expect(block.statements.map((statement) => compact(statement, source))).toEqual([
      "if(selectedPageRef.current===pageNumber)return;",
      "selectedPageRef.current=pageNumber;",
      "setSelectedId(null);",
    ]);
    expect(dependencyTexts(pageEffect, source)).toEqual(["pageNumber"]);

    const commands = parseSource(VIEWER_COMMANDS);
    const pageBoundary = findNamedFunction(commands, "publishViewerPageBoundary");
    if (!pageBoundary.body) throw new Error("publishViewerPageBoundary must have a body");
    const directCalls = pageBoundary.body.statements.flatMap((statement) => {
      if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return [];
      return [compact(statement.expression.expression, commands)];
    });
    expect(directCalls).toEqual([
      "invalidateToolTailAuthority",
      "useToolStore.setState",
      "useParseFlowStore.setState",
      "invalidateToolTailAuthority",
      "installCorePage",
      "publishPageOperationBoundary",
    ]);

    const toolPatch = findNamedFunction(commands, "toolPageExitPatch");
    if (!toolPatch.body) throw new Error("toolPageExitPatch must have a body");
    const returned = toolPatch.body.statements.find(ts.isReturnStatement)?.expression;
    if (!returned) throw new Error("Expected the Tool page-exit projection");
    const projection = unwrapExpression(returned);
    if (!ts.isObjectLiteralExpression(projection)) throw new Error("Expected Tool exit object");
    const projectionKeys = projection.properties.map((property) =>
      property.name && ts.isIdentifier(property.name) ? property.name.text : null);
    expect(projectionKeys).toEqual([
      "activeTool", "calibrationMode", "calibrationPoints", "polygonDrawingMode",
      "polygonVertices", "bucketFillPreview", "bucketFillLoading", "bucketFillError",
      "bucketFillPendingPolygon", "bucketFillBarriers", "bucketFillBarrierMode",
      "barrierPendingPoint", "splitLineA", "splitLineB", "splitPreview", "splitError",
    ]);
    const activeToolProperty = projection.properties.find(
      (property) => property.name && ts.isIdentifier(property.name) && property.name.text === "activeTool",
    );
    if (!activeToolProperty || !ts.isShorthandPropertyAssignment(activeToolProperty)) {
      throw new Error("Expected activeTool page projection");
    }
    expect(activeToolProperty.name.text).toBe("activeTool");

    const exactToolExit = findNamedFunction(commands, "publishToolPageExitExact");
    expect(compact(exactToolExit, commands)).toContain(
      "state.activeTool===expectedActiveTool?toolPageExitPatch(activeToolAfterPageChange(state)):state",
    );

    const parseBoundary = findNamedFunction(commands, "publishPageOperationBoundary");
    if (!parseBoundary.body) throw new Error("publishPageOperationBoundary must have a body");
    expect(compact(parseBoundary.body, commands)).toContain(
      'invalidateParseOperationKinds(state.parseOperations,["table","keynote","notes","spec"],)',
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
    expect(compact(toolActive.initializer, source)).toBe("s.activeTool!==null");

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
