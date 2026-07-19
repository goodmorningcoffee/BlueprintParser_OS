// @vitest-environment node
//
// [refactor jul19 P3.2] Cross-controller decline-purity gate. Existing direct nets prove each
// controller locally; this file adds the missing completeness census and relational property:
// every real eligible false return is effect-free, the disjoint takeoff claim partition is
// invariant across all six controller orders, and keynotePick's deliberately observable priority
// over parseRect remains fixed rather than being swept into a false global-commutativity claim.

import { readFileSync } from "node:fs";
import type { MouseEvent as ReactMouseEvent } from "react";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActiveTool } from "@/lib/active-tool-state";
import {
  claimToolTailAuthority,
  invalidateToolTailAuthority,
  ownsToolTailAuthority,
} from "@/lib/parse-tool-authority";
import { useParseFlowStore } from "@/stores/parseFlowStore";
import { useToolStore, type ToolStoreState } from "@/stores/toolStore";
import type { ClientAnnotation, ClientTakeoffItem } from "@/types";
import { TOOL_STORE_CAPABILITIES } from "../tools/capabilities";
import { keynotePickController } from "../tools/keynotePick";
import { parseRectController } from "../tools/parseRect";
import { dispatchToolMouseDown, TOOLS } from "../tools/registry";
import { takeoffCountController } from "../tools/takeoffCount";
import { takeoffLinearController } from "../tools/takeoffLinear";
import { takeoffPolygonController } from "../tools/takeoffPolygon";
import type {
  ToolContext,
  ToolController,
  ToolControllerKind,
  ToolPressSnapshot,
  ToolStoreCapabilities,
  ToolStoreReader,
} from "../tools/types";

type Journal = string[];
type ToolOverrides = Partial<
  Pick<
    ToolStoreState,
    "activeTakeoffItemId" | "polygonDrawingMode" | "polygonVertices"
  >
>;
type ContextExtras = Omit<
  Partial<ToolContext>,
  "press" | "page" | "stores" | "canAdoptProjectLifecycle"
>;

const TAKEOFF_CONTROLLERS = Object.freeze([
  takeoffPolygonController,
  takeoffLinearController,
  takeoffCountController,
]) satisfies readonly ToolController[];

const KEYNOTE_SENTINEL = Object.freeze({
  model: "decline-purity-sentinel-model",
  className: "decline-purity-sentinel-class",
});

const DECLINER_MANIFEST = Object.freeze([
  {
    kind: "keynotePick",
    controller: keynotePickController,
    falseReturns: 2,
  },
  {
    kind: "takeoffCount",
    controller: takeoffCountController,
    falseReturns: 2,
  },
  {
    kind: "takeoffLinear",
    controller: takeoffLinearController,
    falseReturns: 2,
  },
  {
    kind: "takeoffPolygon",
    controller: takeoffPolygonController,
    falseReturns: 2,
  },
] as const) satisfies readonly Readonly<{
  kind: ToolControllerKind;
  controller: ToolController;
  falseReturns: number;
}>[];

function record(journal: Journal, effect: string): void {
  journal.push(effect);
}

function toolSnapshot(
  activeTool: ActiveTool,
  overrides: ToolOverrides = {},
): Readonly<ToolStoreState> {
  const { polygonVertices = [], ...scalarOverrides } = overrides;
  const frozenActiveTool =
    activeTool === null ? null : Object.freeze({ ...activeTool });
  return Object.freeze({
    ...useToolStore.getState(),
    activeTool: frozenActiveTool,
    mode: "pointer",
    polygonDrawingMode: "idle",
    polygonVertices: Object.freeze([
      ...polygonVertices,
    ]) as unknown as ToolStoreState["polygonVertices"],
    ...scalarOverrides,
  });
}

function pressFor(
  toolAtDown: Readonly<ToolStoreState>,
  position: Readonly<{ x: number; y: number }>,
): ToolPressSnapshot {
  return Object.freeze({
    toolAtDown,
    position: Object.freeze({ ...position }),
    publicId: "decline-purity",
    pageNumber: 3,
  });
}

function guardedReader<State extends object>(
  label: string,
  reader: ToolStoreReader<State>,
  journal: Journal,
): ToolStoreReader<State> {
  return {
    getState() {
      const state = reader.getState();
      return new Proxy(state, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            record(journal, `stores.${label}.${String(key)}(${args.length})`);
            return undefined;
          };
        },
      });
    },
  };
}

function guardedStores(journal: Journal): ToolStoreCapabilities {
  return {
    session: guardedReader("session", TOOL_STORE_CAPABILITIES.session, journal),
    viewerCore: guardedReader(
      "viewerCore",
      TOOL_STORE_CAPABILITIES.viewerCore,
      journal,
    ),
    tool: guardedReader("tool", TOOL_STORE_CAPABILITIES.tool, journal),
    parseFlow: guardedReader(
      "parseFlow",
      TOOL_STORE_CAPABILITIES.parseFlow,
      journal,
    ),
    ui: guardedReader("ui", TOOL_STORE_CAPABILITIES.ui, journal),
  };
}

function contextFor(
  state: Readonly<ToolStoreState>,
  position: Readonly<{ x: number; y: number }>,
  journal: Journal,
  extras: ContextExtras = {},
): ToolContext {
  const press = pressFor(state, position);
  return Object.freeze({
    press,
    page: Object.freeze({
      publicId: press.publicId,
      number: press.pageNumber,
      width: 200,
      height: 100,
    }),
    stores: guardedStores(journal),
    canAdoptProjectLifecycle: () => {
      record(journal, "canAdoptProjectLifecycle");
      return true;
    },
    ...extras,
  });
}

function eventFor(journal: Journal, detail = 1): ReactMouseEvent {
  return Object.freeze({
    button: 0,
    detail,
    stopPropagation: () => record(journal, "event.stopPropagation"),
    preventDefault: () => record(journal, "event.preventDefault"),
  }) as unknown as ReactMouseEvent;
}

function takeoffItem(
  id: number,
  shape: ClientTakeoffItem["shape"],
): ClientTakeoffItem {
  return Object.freeze({
    id,
    name: `${shape}-${id}`,
    shape,
    color: "#3b82f6",
    size: 10,
    sortOrder: 0,
    groupId: null,
  });
}

function yoloAnnotation(
  source: ClientAnnotation["source"],
  bbox: [number, number, number, number],
): ClientAnnotation {
  return Object.freeze({
    id: 91,
    pageNumber: 3,
    name: "fixture",
    bbox: Object.freeze(bbox) as unknown as ClientAnnotation["bbox"],
    note: null,
    source,
    data: Object.freeze({ modelName: "fixture" }),
  });
}

type EffectProbes = Readonly<{
  fetch: ReturnType<typeof vi.fn>;
  timer: ReturnType<typeof vi.fn>;
}>;

function installEffectProbes(): EffectProbes {
  const fetch = vi.fn(() =>
    Promise.resolve(new Response(null, { status: 204 })),
  );
  const timer = vi.fn(() => 0);
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("setTimeout", timer);
  return { fetch, timer };
}

type EffectBoundary = Readonly<{
  journal: readonly string[];
  ownsTail: boolean;
  storeStates: Readonly<{
    session: ReturnType<ToolStoreCapabilities["session"]["getState"]>;
    viewerCore: ReturnType<ToolStoreCapabilities["viewerCore"]["getState"]>;
    tool: ReturnType<ToolStoreCapabilities["tool"]["getState"]>;
    parseFlow: ReturnType<ToolStoreCapabilities["parseFlow"]["getState"]>;
    ui: ReturnType<ToolStoreCapabilities["ui"]["getState"]>;
  }>;
  fetchCalls: number;
  timerCalls: number;
}>;

function effectBoundary(
  journal: Journal,
  token: object,
  probes: EffectProbes,
): EffectBoundary {
  return {
    journal: [...journal],
    ownsTail: ownsToolTailAuthority(token),
    storeStates: {
      session: TOOL_STORE_CAPABILITIES.session.getState(),
      viewerCore: TOOL_STORE_CAPABILITIES.viewerCore.getState(),
      tool: TOOL_STORE_CAPABILITIES.tool.getState(),
      parseFlow: TOOL_STORE_CAPABILITIES.parseFlow.getState(),
      ui: TOOL_STORE_CAPABILITIES.ui.getState(),
    },
    fetchCalls: probes.fetch.mock.calls.length,
    timerCalls: probes.timer.mock.calls.length,
  };
}

function expectBoundaryUnchanged(
  before: EffectBoundary,
  journal: Journal,
  token: object,
  probes: EffectProbes,
  label: string,
): void {
  const after = effectBoundary(journal, token, probes);
  expect(after.journal, `${label}: effect journal`).toEqual(before.journal);
  expect(after.ownsTail, `${label}: tail ownership`).toBe(before.ownsTail);
  expect(
    before.storeStates.parseFlow.keynoteYoloClass,
    `${label}: seeded parse sentinel before`,
  ).toBe(KEYNOTE_SENTINEL);
  expect(
    after.storeStates.parseFlow.keynoteYoloClass,
    `${label}: seeded parse sentinel after`,
  ).toBe(KEYNOTE_SENTINEL);
  for (const store of [
    "session",
    "viewerCore",
    "tool",
    "parseFlow",
    "ui",
  ] as const) {
    expect(
      after.storeStates[store],
      `${label}: ${store} store publication`,
    ).toBe(before.storeStates[store]);
  }
  expect(after.fetchCalls, `${label}: fetch`).toBe(before.fetchCalls);
  expect(after.timerCalls, `${label}: timer`).toBe(before.timerCalls);
}

beforeEach(() => {
  useParseFlowStore.setState({ keynoteYoloClass: KEYNOTE_SENTINEL });
});

afterEach(() => {
  invalidateToolTailAuthority();
  useParseFlowStore.setState({ keynoteYoloClass: null });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    if (
      ts.isCallExpression(current) &&
      current.expression.getText() === "Object.freeze" &&
      current.arguments.length === 1
    ) {
      current = current.arguments[0];
      continue;
    }
    return current;
  }
}

function staticName(
  name: ts.PropertyName | ts.BindingName | undefined,
): string | null {
  if (!name) return null;
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return null;
}

function controllerObject(
  source: ts.SourceFile,
  variableName: string,
): ts.ObjectLiteralExpression {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        staticName(declaration.name) !== variableName ||
        !declaration.initializer
      ) {
        continue;
      }
      const initializer = unwrapExpression(declaration.initializer);
      if (ts.isObjectLiteralExpression(initializer)) return initializer;
    }
  }
  throw new Error(`controller object ${variableName} not found`);
}

function handlerBody(object: ts.ObjectLiteralExpression): ts.Block {
  const member = object.properties.find(
    (candidate) => staticName(candidate.name) === "onMouseDown",
  );
  if (member && ts.isMethodDeclaration(member) && member.body) {
    return member.body;
  }
  if (member && ts.isPropertyAssignment(member)) {
    const initializer = unwrapExpression(member.initializer);
    if (
      (ts.isArrowFunction(initializer) ||
        ts.isFunctionExpression(initializer)) &&
      ts.isBlock(initializer.body)
    ) {
      return initializer.body;
    }
  }
  throw new Error("controller onMouseDown body not found");
}

function directHandlerReturns(body: ts.Block): ts.ReturnStatement[] {
  const returns: ts.ReturnStatement[] = [];
  const visit = (node: ts.Node): void => {
    if (
      node !== body &&
      (ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node))
    ) {
      return;
    }
    if (ts.isReturnStatement(node)) returns.push(node);
    ts.forEachChild(node, visit);
  };
  visit(body);
  return returns;
}

function falseReturnCensus(): ReadonlyArray<{
  kind: ToolControllerKind;
  falseReturns: number;
}> {
  const census: Array<{
    kind: ToolControllerKind;
    falseReturns: number;
  }> = [];
  for (const controller of TOOLS) {
    const sourceUrl = new URL(
      `../tools/${controller.kind}.ts`,
      import.meta.url,
    );
    const sourceText = readFileSync(sourceUrl, "utf8");
    const source = ts.createSourceFile(
      sourceUrl.pathname,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const body = handlerBody(
      controllerObject(source, `${controller.kind}Controller`),
    );
    const returns = directHandlerReturns(body);
    const nonLiteral = returns.filter((statement) => {
      if (!statement.expression) return true;
      const expression = unwrapExpression(statement.expression);
      return (
        expression.kind !== ts.SyntaxKind.TrueKeyword &&
        expression.kind !== ts.SyntaxKind.FalseKeyword
      );
    });
    expect(
      nonLiteral.map((statement) => statement.getText(source)),
      `${controller.kind} must keep directly censusable boolean claims`,
    ).toEqual([]);
    const falseReturns = returns.filter(
      (statement) =>
        statement.expression &&
        unwrapExpression(statement.expression).kind ===
          ts.SyntaxKind.FalseKeyword,
    ).length;
    if (falseReturns > 0) census.push({ kind: controller.kind, falseReturns });
  }
  return census.sort((left, right) => left.kind.localeCompare(right.kind));
}

type TakeoffScenarioName = "polygon" | "linear" | "count" | "null" | "stale";
type TakeoffOwner = "takeoffPolygon" | "takeoffLinear" | "takeoffCount" | null;

type TakeoffScenario = Readonly<{
  name: TakeoffScenarioName;
  owner: TakeoffOwner;
  state: Readonly<ToolStoreState>;
  items: readonly ClientTakeoffItem[];
  position: Readonly<{ x: number; y: number }>;
  expectedEffects: readonly string[];
}>;

const POLYGON_VERTICES = Object.freeze([
  Object.freeze({ x: 0.5, y: 0.5 }),
  Object.freeze({ x: 0.8, y: 0.2 }),
  Object.freeze({ x: 0.9, y: 0.8 }),
]);
const LINEAR_VERTICES = Object.freeze([
  Object.freeze({ x: 0.1, y: 0.2 }),
  Object.freeze({ x: 0.5, y: 0.5 }),
]);

function takeoffScenario(name: TakeoffScenarioName): TakeoffScenario {
  if (name === "null" || name === "stale") {
    return {
      name,
      owner: null,
      state: toolSnapshot(
        { kind: "takeoffPlacement" },
        { activeTakeoffItemId: name === "null" ? null : 999 },
      ),
      items: Object.freeze([takeoffItem(5, "circle")]),
      position: Object.freeze({ x: 50, y: 50 }),
      expectedEffects: Object.freeze([]),
    };
  }
  if (name === "polygon") {
    return {
      name,
      owner: "takeoffPolygon",
      state: toolSnapshot(
        { kind: "takeoffPlacement" },
        {
          activeTakeoffItemId: 5,
          polygonDrawingMode: "drawing",
          polygonVertices: [...POLYGON_VERTICES],
        },
      ),
      items: Object.freeze([takeoffItem(5, "polygon")]),
      position: Object.freeze({ x: 114, y: 50 }),
      expectedEffects: Object.freeze([
        "event.stopPropagation",
        "takeoffDrawing.savePolygon",
      ]),
    };
  }
  if (name === "linear") {
    return {
      name,
      owner: "takeoffLinear",
      state: toolSnapshot(
        { kind: "takeoffPlacement" },
        {
          activeTakeoffItemId: 5,
          polygonDrawingMode: "drawing",
          polygonVertices: [...LINEAR_VERTICES],
        },
      ),
      items: Object.freeze([takeoffItem(5, "linear")]),
      position: Object.freeze({ x: 109, y: 50 }),
      expectedEffects: Object.freeze([
        "event.stopPropagation",
        "takeoffDrawing.saveLinearPolyline",
      ]),
    };
  }
  return {
    name,
    owner: "takeoffCount",
    state: toolSnapshot(
      { kind: "takeoffPlacement" },
      { activeTakeoffItemId: 5 },
    ),
    items: Object.freeze([takeoffItem(5, "circle")]),
    position: Object.freeze({ x: 120, y: 70 }),
    expectedEffects: Object.freeze([
      "event.stopPropagation",
      "mutations.annotations.persistCreate:takeoff:count-marker:5",
    ]),
  };
}

const TAKEOFF_SCENARIOS = Object.freeze([
  takeoffScenario("polygon"),
  takeoffScenario("linear"),
  takeoffScenario("count"),
  takeoffScenario("null"),
  takeoffScenario("stale"),
]);

type DirectDeclineCase = Readonly<{
  label: string;
  kind: ToolControllerKind;
  site: string;
  controller: ToolController;
  context: (journal: Journal) => ToolContext;
  absentCapabilities: readonly string[];
}>;

const TAKEOFF_DIRECT_CASES: readonly DirectDeclineCase[] =
  TAKEOFF_CONTROLLERS.flatMap((controller) =>
    TAKEOFF_SCENARIOS.filter(
      (scenario) => scenario.owner !== controller.kind,
    ).map((scenario) => ({
      label: `${controller.kind} / ${scenario.name}`,
      kind: controller.kind,
      site:
        scenario.owner === null
          ? "missing-item"
          : controller.kind === "takeoffCount"
            ? "excluded-shape"
            : "wrong-shape",
      controller,
      context: (journal: Journal) =>
        contextFor(scenario.state, scenario.position, journal, {
          takeoffItems: scenario.items,
        }),
      absentCapabilities:
        controller.kind === "takeoffCount"
          ? Object.freeze([
              "selection",
              "pageAnnotations",
              "mutations",
              "transientError",
            ])
          : Object.freeze(["takeoffDrawing"]),
    })),
  );

const KEYNOTE_STATE = toolSnapshot({ kind: "parseRect", flow: "keynote" });
const KEYNOTE_DIRECT_CASES: readonly DirectDeclineCase[] = Object.freeze([
  {
    label: "keynotePick / absent projection",
    kind: "keynotePick",
    site: "inactive-projection",
    controller: keynotePickController,
    context: (journal) => contextFor(KEYNOTE_STATE, { x: 50, y: 25 }, journal),
    absentCapabilities: Object.freeze(["keynotePick", "pageAnnotations"]),
  },
  {
    label: "keynotePick / inactive projection",
    kind: "keynotePick",
    site: "inactive-projection",
    controller: keynotePickController,
    context: (journal) =>
      contextFor(KEYNOTE_STATE, { x: 50, y: 25 }, journal, {
        keynotePick: { active: false },
      }),
    absentCapabilities: Object.freeze(["pageAnnotations"]),
  },
  {
    label: "keynotePick / active empty miss",
    kind: "keynotePick",
    site: "active-miss",
    controller: keynotePickController,
    context: (journal) =>
      contextFor(KEYNOTE_STATE, { x: 50, y: 25 }, journal, {
        keynotePick: { active: true },
        pageAnnotations: Object.freeze([]),
      }),
    absentCapabilities: Object.freeze(["deferredDrawing"]),
  },
  {
    label: "keynotePick / active filtered and out-of-bbox miss",
    kind: "keynotePick",
    site: "active-miss",
    controller: keynotePickController,
    context: (journal) =>
      contextFor(KEYNOTE_STATE, { x: 50, y: 25 }, journal, {
        keynotePick: { active: true },
        pageAnnotations: Object.freeze([
          yoloAnnotation("user", [0.2, 0.1, 0.4, 0.4]),
          yoloAnnotation("yolo", [0.7, 0.7, 0.9, 0.9]),
        ]),
      }),
    absentCapabilities: Object.freeze(["deferredDrawing"]),
  },
]);

const DIRECT_DECLINE_CASES = Object.freeze([
  ...TAKEOFF_DIRECT_CASES,
  ...KEYNOTE_DIRECT_CASES,
]);

function permutations<T>(values: readonly T[]): readonly (readonly T[])[] {
  if (values.length <= 1) return [values.slice()];
  return values.flatMap((value, index) =>
    permutations([...values.slice(0, index), ...values.slice(index + 1)]).map(
      (tail) => [value, ...tail],
    ),
  );
}

const TAKEOFF_PERMUTATIONS = Object.freeze(permutations(TAKEOFF_CONTROLLERS));

function fullTakeoffContext(
  scenario: TakeoffScenario,
  journal: Journal,
): ToolContext {
  const takeoffDrawing = {
    setPolygonDrawingMode: () =>
      record(journal, "takeoffDrawing.setPolygonDrawingMode"),
    addPolygonVertex: () => record(journal, "takeoffDrawing.addPolygonVertex"),
    saveLinearPolyline: () =>
      record(journal, "takeoffDrawing.saveLinearPolyline"),
    savePolygon: () => record(journal, "takeoffDrawing.savePolygon"),
  } satisfies NonNullable<ToolContext["takeoffDrawing"]>;
  const selection = {
    selectedId: null,
    setSelectedId: () => record(journal, "selection.setSelectedId"),
    setResizeCorner: () => record(journal, "selection.setResizeCorner"),
    setDragging: () => record(journal, "selection.setDragging"),
    deleteSelected: () => record(journal, "selection.deleteSelected"),
  } satisfies NonNullable<ToolContext["selection"]>;
  const mutations = {
    annotations: {
      persistCreate: async (draft) => {
        const data = draft.data as Record<string, unknown> | undefined;
        record(
          journal,
          `mutations.annotations.persistCreate:${draft.source}:${String(data?.type)}:${String(data?.takeoffItemId)}`,
        );
        return -1;
      },
    },
  } satisfies NonNullable<ToolContext["mutations"]>;

  return contextFor(scenario.state, scenario.position, journal, {
    takeoffItems: scenario.items,
    takeoffDrawing,
    selection,
    pageAnnotations: Object.freeze([]),
    mutations,
    transientError: {
      publish: () => record(journal, "transientError.publish"),
    },
    deferredDrawing: {
      start: () => {
        record(journal, "deferredDrawing.start");
        return true;
      },
    },
  });
}

type PermutationSummary = Readonly<{
  result: boolean;
  claimant: ToolControllerKind | null;
  effects: readonly string[];
  ownsTail: boolean;
  contextCalls: number;
  fetchCalls: number;
  timerCalls: number;
}>;

function runTakeoffPermutation(
  order: readonly ToolController[],
  scenario: TakeoffScenario,
): PermutationSummary {
  const signature = order.map((controller) => controller.kind).join("→");
  const journal: Journal = [];
  const context = fullTakeoffContext(scenario, journal);
  const event = eventFor(journal);
  const token = claimToolTailAuthority({ signature, scenario: scenario.name });
  const probes = installEffectProbes();
  const invoked: string[] = [];
  let claimant: ToolControllerKind | null = null;
  const observed = order.map((controller): ToolController => ({
    kind: controller.kind,
    wantsEvents: controller.wantsEvents,
    matches: controller.matches,
    onMouseDown(candidateEvent, candidateContext) {
      const before = effectBoundary(journal, token, probes);
      const claimed = controller.onMouseDown(candidateEvent, candidateContext);
      invoked.push(`${controller.kind}:${String(claimed)}`);
      if (!claimed) {
        expectBoundaryUnchanged(
          before,
          journal,
          token,
          probes,
          `${signature} ${scenario.name} ${controller.kind} decline`,
        );
      } else {
        expect(claimant, `${signature} has at most one claimant`).toBeNull();
        claimant = controller.kind;
      }
      return claimed;
    },
  }));
  const createContext = vi.fn(() => context);

  try {
    for (const controller of order) {
      expect(
        controller.matches(context.press),
        `${signature} ${scenario.name} eligibility`,
      ).toBe(true);
    }
    const result = dispatchToolMouseDown(
      observed,
      event,
      context.press,
      createContext,
    );
    const ownerIndex = scenario.owner
      ? order.findIndex((controller) => controller.kind === scenario.owner)
      : -1;
    const expectedInvoked = (
      ownerIndex < 0 ? order : order.slice(0, ownerIndex + 1)
    ).map(
      (controller, index) =>
        `${controller.kind}:${String(ownerIndex >= 0 && index === ownerIndex)}`,
    );
    expect(invoked, `${signature} stops exactly at the unique owner`).toEqual(
      expectedInvoked,
    );
    return {
      result,
      claimant,
      effects: [...journal],
      ownsTail: ownsToolTailAuthority(token),
      contextCalls: createContext.mock.calls.length,
      fetchCalls: probes.fetch.mock.calls.length,
      timerCalls: probes.timer.mock.calls.length,
    };
  } finally {
    invalidateToolTailAuthority();
    vi.unstubAllGlobals();
  }
}

describe("registered controller decline census", () => {
  it("ties every direct literal-false site to the explicit runtime manifest", () => {
    const expected = DECLINER_MANIFEST.map(({ kind, falseReturns }) => ({
      kind,
      falseReturns,
    })).sort((left, right) => left.kind.localeCompare(right.kind));
    expect(falseReturnCensus()).toEqual(expected);

    for (const entry of DECLINER_MANIFEST) {
      expect(
        TOOLS.filter((controller) => controller === entry.controller),
        `${entry.kind} real object registration`,
      ).toHaveLength(1);
      expect(
        TOOLS.filter((controller) => controller.kind === entry.kind),
        `${entry.kind} unique kind registration`,
      ).toEqual([entry.controller]);
      const sites = new Set(
        DIRECT_DECLINE_CASES.filter((row) => row.kind === entry.kind).map(
          (row) => row.site,
        ),
      );
      expect(
        [...sites].sort(),
        `${entry.kind} semantic decline sites`,
      ).toHaveLength(entry.falseReturns);
    }
  });
});

describe("real eligible declines share one zero-effect contract", () => {
  it.each(DIRECT_DECLINE_CASES)("$label", (row) => {
    const journal: Journal = [];
    const context = row.context(journal);
    const event = eventFor(journal);
    const token = claimToolTailAuthority({ label: row.label });
    const probes = installEffectProbes();
    try {
      const contextRecord = context as unknown as Readonly<
        Record<string, unknown>
      >;
      for (const capability of row.absentCapabilities) {
        expect(
          contextRecord[capability],
          `${row.label} omits claim-only ${capability}`,
        ).toBeUndefined();
      }
      const beforeMatch = effectBoundary(journal, token, probes);
      expect(row.controller.matches(context.press), row.label).toBe(true);
      expectBoundaryUnchanged(
        beforeMatch,
        journal,
        token,
        probes,
        `${row.label} matches is eligibility-only`,
      );

      const beforeDecline = effectBoundary(journal, token, probes);
      expect(row.controller.onMouseDown(event, context), row.label).toBe(false);
      expectBoundaryUnchanged(
        beforeDecline,
        journal,
        token,
        probes,
        `${row.label} false is pure`,
      );
    } finally {
      invalidateToolTailAuthority();
      vi.unstubAllGlobals();
    }
  });
});

describe("takeoff decline purity makes only the disjoint trio order-invariant", () => {
  it("generates all six unique controller permutations", () => {
    expect(TAKEOFF_PERMUTATIONS).toHaveLength(6);
    expect(
      new Set(
        TAKEOFF_PERMUTATIONS.map((order) =>
          order.map((controller) => controller.kind).join("→"),
        ),
      ).size,
    ).toBe(6);
  });

  it.each(TAKEOFF_SCENARIOS)(
    "$name has one invariant external result",
    (scenario) => {
      const summaries = TAKEOFF_PERMUTATIONS.map((order) =>
        runTakeoffPermutation(order, scenario),
      );
      const expected: PermutationSummary = {
        result: scenario.owner !== null,
        claimant: scenario.owner,
        effects: scenario.expectedEffects,
        ownsTail: scenario.owner === null,
        contextCalls: 1,
        fetchCalls: 0,
        timerCalls: 0,
      };
      for (const summary of summaries) expect(summary).toEqual(expected);
      expect(summaries).toEqual(Array.from({ length: 6 }, () => expected));
    },
  );
});

describe("keynote decline stays pure inside its intentional fixed priority", () => {
  it.each([
    { label: "inactive projection", keynotePick: { active: false } },
    { label: "active miss", keynotePick: { active: true } },
  ])(
    "$label delegates keynotePick:false → parseRect:true",
    ({ keynotePick }) => {
      const journal: Journal = [];
      const position = Object.freeze({ x: 50, y: 25 });
      let context!: ToolContext;
      const deferredDrawing = {
        start: (candidate: { x: number; y: number }) => {
          expect(candidate).toBe(context.press.position);
          record(journal, "deferredDrawing.start");
          return true;
        },
      };
      context = contextFor(KEYNOTE_STATE, position, journal, {
        keynotePick,
        ...(keynotePick.active ? { pageAnnotations: Object.freeze([]) } : {}),
        deferredDrawing,
      });
      const event = eventFor(journal);
      const token = claimToolTailAuthority({ label: keynotePick.active });
      const probes = installEffectProbes();
      const steps: string[] = [];
      const pair: readonly ToolController[] = [
        {
          ...keynotePickController,
          onMouseDown(candidateEvent, candidateContext) {
            expect(candidateContext).toBe(context);
            const before = effectBoundary(journal, token, probes);
            const result = keynotePickController.onMouseDown(
              candidateEvent,
              candidateContext,
            );
            steps.push(`keynotePick:${String(result)}`);
            expect(result).toBe(false);
            expectBoundaryUnchanged(
              before,
              journal,
              token,
              probes,
              "keynote intermediate decline boundary",
            );
            return result;
          },
        },
        {
          ...parseRectController,
          onMouseDown(candidateEvent, candidateContext) {
            expect(candidateContext).toBe(context);
            const result = parseRectController.onMouseDown(
              candidateEvent,
              candidateContext,
            );
            steps.push(`parseRect:${String(result)}`);
            return result;
          },
        },
      ];
      const createContext = vi.fn(() => context);
      try {
        expect(TOOLS.indexOf(keynotePickController)).toBeLessThan(
          TOOLS.indexOf(parseRectController),
        );
        expect(
          dispatchToolMouseDown(pair, event, context.press, createContext),
        ).toBe(true);
        expect(steps).toEqual(["keynotePick:false", "parseRect:true"]);
        expect(journal).toEqual([
          "event.stopPropagation",
          "deferredDrawing.start",
        ]);
        expect(createContext).toHaveBeenCalledTimes(1);
        expect(probes.fetch).not.toHaveBeenCalled();
        expect(probes.timer).not.toHaveBeenCalled();
      } finally {
        invalidateToolTailAuthority();
        vi.unstubAllGlobals();
      }
    },
  );
});
