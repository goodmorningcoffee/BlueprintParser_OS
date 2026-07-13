// @vitest-environment node
// [refactor jul13 P2.3 AT3] Atomic caller destinations and synchronous subscriber survival.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { beforeEach, describe, expect, it } from "vitest";

import {
  claimToolTailAuthority,
  invalidateToolTailAuthority,
  ownsToolTailAuthority,
} from "@/lib/parse-tool-authority";
import { useParseFlowStore } from "@/stores/parseFlowStore";
import {
  stopTakeoffPlacement,
  useToolStore,
} from "@/stores/toolStore";
import {
  resetNotesParseWorkspace,
  resetSpecParseWorkspace,
} from "@/stores/viewerCommands";

type ParseState = ReturnType<typeof useParseFlowStore.getState>;
type ToolState = ReturnType<typeof useToolStore.getState>;

const REGION_A: [number, number, number, number] = [0.1, 0.2, 0.7, 0.8];

function restoreStores(): void {
  invalidateToolTailAuthority();
  useParseFlowStore.setState(useParseFlowStore.getInitialState(), true);
  useToolStore.setState(useToolStore.getInitialState(), true);
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

function compact(node: ts.Node, source: ts.SourceFile): string {
  return node.getText(source).replace(/\s+/g, "");
}

function namedArrowBlock(source: ts.SourceFile, name: string): ts.Block {
  const declaration = descendants(source, ts.isVariableDeclaration).find(
    (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name,
  );
  expect(declaration, `${source.fileName} ${name} declaration`).toBeDefined();
  const initializer = declaration?.initializer;
  expect(initializer && ts.isArrowFunction(initializer), `${name} arrow function`).toBe(true);
  if (!initializer || !ts.isArrowFunction(initializer) || !ts.isBlock(initializer.body)) {
    throw new Error(`Expected ${name} to have an arrow-function block`);
  }
  return initializer.body;
}

function directTextElement(source: ts.SourceFile, label: string): ts.JsxElement {
  const elements = descendants(source, ts.isJsxElement).filter((element) =>
    element.children.some(
      (child) => ts.isJsxText(child) && child.getText(source).trim() === label,
    )
  );
  expect(elements, `${source.fileName} direct JSX text ${label}`).toHaveLength(1);
  if (!elements[0]) throw new Error(`Expected one ${label} JSX element`);
  return elements[0];
}

beforeEach(() => {
  restoreStores();
});

describe("AT3 atomic Notes/Spec Redraw commands", () => {
  const fixtures = [
    {
      flow: "notes" as const,
      seed: () => useParseFlowStore.setState({
        notesParseStep: "review",
        notesParseRegion: REGION_A,
        paragraphWorkspaceOwner: "notes",
      }),
      invoke: () => resetNotesParseWorkspace("select-region", {}, "pointer"),
      snapshot: (state: ParseState) => ({
        step: state.notesParseStep,
        region: state.notesParseRegion,
        owner: state.paragraphWorkspaceOwner,
      }),
    },
    {
      flow: "spec" as const,
      seed: () => useParseFlowStore.setState({
        specParseStep: "review",
        specParseRegion: REGION_A,
        paragraphWorkspaceOwner: "spec",
      }),
      invoke: () => resetSpecParseWorkspace("select-region", "pointer"),
      snapshot: (state: ParseState) => ({
        step: state.specParseStep,
        region: state.specParseRegion,
        owner: state.paragraphWorkspaceOwner,
      }),
    },
  ];

  for (const fixture of fixtures) {
    it(`${fixture.flow} Redraw fails closed before Parse when the Tool publication admits B`, () => {
      fixture.seed();
      const beforeParse = fixture.snapshot(useParseFlowStore.getState());
      let armed = true;
      let toolPublications = 0;
      let parsePublications = 0;
      let activationB: ToolState["activeTool"] = null;
      const unsubscribeTool = useToolStore.subscribe((state) => {
        toolPublications += 1;
        if (!armed) return;
        expect(state.mode).toBe("pointer");
        expect(state.activeTool).toEqual({ kind: "parseRect", flow: fixture.flow });
        armed = false;
        state.setTagAddingMode(`${fixture.flow}-subscriber-B`);
        activationB = useToolStore.getState().activeTool;
      });
      const unsubscribeParse = useParseFlowStore.subscribe(() => {
        parsePublications += 1;
      });

      let completed: boolean;
      try {
        completed = fixture.invoke();
      } finally {
        unsubscribeParse();
        unsubscribeTool();
      }

      expect(completed!).toBe(false);
      expect(armed).toBe(false);
      expect(toolPublications).toBe(2);
      expect(parsePublications).toBe(0);
      expect(activationB).toEqual({
        kind: "tagAdd",
        tagId: `${fixture.flow}-subscriber-B`,
      });
      expect(useToolStore.getState().activeTool).toBe(activationB);
      expect(fixture.snapshot(useParseFlowStore.getState())).toEqual(beforeParse);
    });
  }
});

describe("AT3 atomic calibration and Takeoff destinations", () => {
  it("Recalibrate clears both old points in its point1 publication and preserves subscriber B", () => {
    useToolStore.setState({
      mode: "markup",
      activeTool: { kind: "calibration" },
      calibrationMode: "input",
      calibrationPoints: {
        p1: { x: 0.1, y: 0.2 },
        p2: { x: 0.7, y: 0.8 },
      },
    });
    let armed = true;
    let publications = 0;
    let activationB: ToolState["activeTool"] = null;
    const unsubscribe = useToolStore.subscribe((state) => {
      publications += 1;
      if (!armed) return;
      armed = false;
      expect(state).toMatchObject({
        mode: "move",
        calibrationMode: "point1",
        calibrationPoints: {},
        activeTool: { kind: "calibration" },
      });
      state.setTagAddingMode("recalibrate-subscriber-B");
      activationB = useToolStore.getState().activeTool;
    });

    try {
      useToolStore.getState().setCalibrationMode("point1");
    } finally {
      unsubscribe();
    }

    expect(armed).toBe(false);
    expect(publications).toBe(2);
    expect(activationB).toEqual({
      kind: "tagAdd",
      tagId: "recalibrate-subscriber-B",
    });
    expect(useToolStore.getState()).toMatchObject({
      activeTool: activationB,
      calibrationMode: "point1",
      calibrationPoints: {},
    });
  });

  it("Stop publishes the complete destination once and preserves subscriber B", () => {
    const undoEntry = {} as ToolState["takeoffUndoStack"][number];
    const redoEntry = {} as ToolState["takeoffRedoStack"][number];
    useToolStore.setState({
      mode: "markup",
      tempPanMode: true,
      activeTool: { kind: "takeoffPlacement" },
      activeTakeoffItemId: 41,
      polygonDrawingMode: "drawing",
      polygonVertices: [{ x: 0.2, y: 0.3 }],
      takeoffUndoStack: [undoEntry],
      takeoffRedoStack: [redoEntry],
      bucketFillPreview: {
        vertices: [
          { x: 0.1, y: 0.1 },
          { x: 0.4, y: 0.1 },
          { x: 0.4, y: 0.4 },
        ],
        method: "stale-bucket",
      },
      bucketFillLoading: true,
      bucketFillBarriers: [{ x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.4 }],
      bucketFillBarrierMode: true,
      splitLineA: { x: 0.1, y: 0.2 },
      splitLineB: { x: 0.7, y: 0.8 },
      splitPreview: {
        targetAnnotationId: 44,
        original: [
          { x: 0.1, y: 0.1 },
          { x: 0.9, y: 0.1 },
          { x: 0.9, y: 0.9 },
        ],
        left: [
          { x: 0.1, y: 0.1 },
          { x: 0.5, y: 0.1 },
          { x: 0.5, y: 0.9 },
        ],
        right: [
          { x: 0.5, y: 0.1 },
          { x: 0.9, y: 0.1 },
          { x: 0.9, y: 0.9 },
        ],
        lineA: { x: 0.5, y: 0.1 },
        lineB: { x: 0.5, y: 0.9 },
      },
      splitError: "stale split",
    });
    let armed = true;
    let publications = 0;
    let activationB: ToolState["activeTool"] = null;
    const subscriberToken = {};
    const unsubscribe = useToolStore.subscribe((state) => {
      publications += 1;
      if (!armed) return;
      armed = false;
      expect(state).toMatchObject({
        mode: "move",
        tempPanMode: false,
        activeTool: null,
        activeTakeoffItemId: null,
        polygonDrawingMode: "idle",
        polygonVertices: [],
        takeoffUndoStack: [],
        takeoffRedoStack: [],
        bucketFillPreview: null,
        bucketFillLoading: false,
        bucketFillBarriers: [],
        bucketFillBarrierMode: false,
        splitLineA: null,
        splitLineB: null,
        splitPreview: null,
        splitError: null,
      });
      state.setTagAddingMode("stop-subscriber-B");
      activationB = useToolStore.getState().activeTool;
      claimToolTailAuthority(subscriberToken);
    });

    try {
      stopTakeoffPlacement();
    } finally {
      unsubscribe();
    }

    expect(armed).toBe(false);
    expect(publications).toBe(2);
    expect(ownsToolTailAuthority(subscriberToken)).toBe(true);
    expect(activationB).toEqual({ kind: "tagAdd", tagId: "stop-subscriber-B" });
    expect(useToolStore.getState()).toMatchObject({
      activeTool: activationB,
      activeTakeoffItemId: null,
      polygonDrawingMode: "idle",
      polygonVertices: [],
      takeoffUndoStack: [],
      takeoffRedoStack: [],
    });
  });

  it("Stop invalidates a prior tail even when no Tool subscriber publishes", () => {
    const priorToken = claimToolTailAuthority({});
    expect(ownsToolTailAuthority(priorToken)).toBe(true);

    stopTakeoffPlacement();

    expect(ownsToolTailAuthority(priorToken)).toBe(false);
  });
});

describe("AT3 atomic caller source topology", () => {
  it.each([
    {
      path: "src/components/viewer/NotesParser.tsx",
      command: "resetNotesParseWorkspace",
      argumentCount: 3,
    },
    {
      path: "src/components/viewer/SpecParser.tsx",
      command: "resetSpecParseWorkspace",
      argumentCount: 2,
    },
  ])("$path Redraw delegates pointer entry without a raw Tool setMode", ({
    path,
    command,
    argumentCount,
  }) => {
    const source = parseSource(path);
    const block = namedArrowBlock(source, "handleRedraw");
    const calls = descendants(block, ts.isCallExpression);
    const callees = calls.map((call) => compact(call.expression, source));

    expect(callees).not.toContain("useToolStore.getState().setMode");
    const delegated = calls.filter((call) => compact(call.expression, source) === command);
    expect(delegated, `${path} one ${command} call`).toHaveLength(1);
    expect(delegated[0].arguments).toHaveLength(argumentCount);
    expect(compact(delegated[0].arguments[argumentCount - 1], source)).toBe('"pointer"');
    const guard = descendants(block, ts.isIfStatement).find((statement) =>
      descendants(statement.expression, ts.isCallExpression).includes(delegated[0])
    );
    expect(guard, `${path} rejects the local Redraw tail when ${command} fails`).toBeDefined();
    if (!guard) throw new Error(`Expected ${path} guarded Redraw command`);
    expect(compact(guard.expression, source)).toBe(`!${compact(delegated[0], source)}`);
    expect(ts.isReturnStatement(guard.thenStatement)).toBe(true);
  });

  it.each([
    "src/components/viewer/AreaTab.tsx",
    "src/components/viewer/LinearTab.tsx",
  ])("%s Recalibrate uses the atomic point1 action without a reset prefix", (path) => {
    const source = parseSource(path);
    const recalibrate = directTextElement(source, "Recalibrate");
    const calls = descendants(recalibrate, ts.isCallExpression);
    const callees = calls.map((call) => compact(call.expression, source));

    expect(callees).not.toContain("resetCalibration");
    const point1Calls = calls.filter(
      (call) => compact(call.expression, source) === "setCalibrationMode" &&
        call.arguments.length === 1 && compact(call.arguments[0], source) === '"point1"',
    );
    expect(point1Calls).toHaveLength(1);
  });

  it("TakeoffPanel Stop delegates to one named command and has no three-leaf cascade", () => {
    const source = parseSource("src/components/viewer/TakeoffPanel.tsx");
    const stop = directTextElement(source, "Stop");
    const text = compact(stop, source);

    expect(text).toContain("onClick={stopTakeoffPlacement}");
    expect(text).not.toContain("setActiveTakeoffItemId");
    expect(text).not.toContain("resetPolygonDrawing");
    expect(text).not.toContain("setMode");
  });
});
