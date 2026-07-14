// @vitest-environment node
// [refactor jul13 P2.3 AT2] ActiveTool causal model and exact production adoption.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  activeToolAfterPageChange,
  activeToolReleaseFallback,
  captureCanvasGestureLease,
  isDrawCapableParseStep,
  matchesCanvasGestureLease,
  releaseActiveToolExact,
  resolveCanvasGestureOwner,
  selectActiveTagId,
  selectActiveToolKey,
  takeoffPlacementFallback,
  transitionActiveTool,
  type ActiveTool,
  type ActiveToolIntent,
  type ActiveToolKey,
  type ActiveToolObject,
  type ActiveToolProjection,
  type BaseInteractionMode,
  type CanvasGestureOwner,
  type CanvasGestureSnapshot,
  type ParseDrawingStep,
  type ParseRectFlow,
  type ParseStepByFlow,
} from "@/lib/active-tool-state";

const MODULE_FILE = "src/lib/active-tool-state.ts";
const EXPECTED_ACTIVE_TOOL_MEMBERS = [
  '{kind:"calibration"}',
  '{kind:"takeoffPlacement"}',
  '{kind:"bucketFill"}',
  '{kind:"split"}',
  '{kind:"symbolTemplate"}',
  '{kind:"tagPick"}',
  '{kind:"tagAdd";tagId:string}',
  '{kind:"parseRect";flow:"table"|"keynote"|"notes"|"spec"}',
  "null",
];

const ALL_ACTIVE_TOOLS: readonly ActiveToolObject[] = [
  { kind: "calibration" },
  { kind: "takeoffPlacement" },
  { kind: "bucketFill" },
  { kind: "split" },
  { kind: "symbolTemplate" },
  { kind: "tagPick" },
  { kind: "tagAdd", tagId: "TAG-A" },
  { kind: "parseRect", flow: "table" },
  { kind: "parseRect", flow: "keynote" },
  { kind: "parseRect", flow: "notes" },
  { kind: "parseRect", flow: "spec" },
];

type CorrelatedParsePair = {
  [F in ParseRectFlow]: readonly [flow: F, step: ParseStepByFlow[F]];
}[ParseRectFlow];
const VALID_PARSE_PAIRS = [
  ["table", "idle"],
  ["table", "select-region"],
  ["table", "define-column"],
  ["table", "define-row"],
  ["table", "review"],
  ["keynote", "idle"],
  ["keynote", "select-region"],
  ["keynote", "define-column"],
  ["keynote", "define-row"],
  ["keynote", "review"],
  ["notes", "idle"],
  ["notes", "select-region"],
  ["notes", "define-column"],
  ["notes", "define-row"],
  ["notes", "review"],
  ["spec", "idle"],
  ["spec", "select-region"],
  ["spec", "define-sections"],
  ["spec", "review"],
] as const satisfies readonly CorrelatedParsePair[];
const DRAWING_PARSE_PAIRS = new Set([
  "table:select-region",
  "table:define-column",
  "table:define-row",
  "keynote:select-region",
  "keynote:define-column",
  "keynote:define-row",
  "notes:select-region",
  "notes:define-column",
  "notes:define-row",
  "spec:select-region",
]);

const ACTIVATION_CASES = [
  [{ type: "selectTakeoff", itemId: 0 }, { kind: "takeoffPlacement" }],
  [{ type: "setCalibrationMode", mode: "point1" }, { kind: "calibration" }],
  [{ type: "setCalibrationMode", mode: "point2" }, { kind: "calibration" }],
  [{ type: "setCalibrationMode", mode: "input" }, { kind: "calibration" }],
  [{ type: "setBucketFill", active: true }, { kind: "bucketFill" }],
  [{ type: "setSplit", active: true }, { kind: "split" }],
  [{ type: "setSymbolTemplate", active: true }, { kind: "symbolTemplate" }],
  [{ type: "setTagPick", active: true }, { kind: "tagPick" }],
  [{ type: "setTagAdd", tagId: "" }, { kind: "tagAdd", tagId: "" }],
  [{ type: "setTagAdd", tagId: "TAG-A" }, { kind: "tagAdd", tagId: "TAG-A" }],
  [{ type: "setParseStep", flow: "table", step: "select-region" }, { kind: "parseRect", flow: "table" }],
  [{ type: "setParseStep", flow: "table", step: "define-column" }, { kind: "parseRect", flow: "table" }],
  [{ type: "setParseStep", flow: "table", step: "define-row" }, { kind: "parseRect", flow: "table" }],
  [{ type: "setParseStep", flow: "keynote", step: "select-region" }, { kind: "parseRect", flow: "keynote" }],
  [{ type: "setParseStep", flow: "keynote", step: "define-column" }, { kind: "parseRect", flow: "keynote" }],
  [{ type: "setParseStep", flow: "keynote", step: "define-row" }, { kind: "parseRect", flow: "keynote" }],
  [{ type: "setParseStep", flow: "notes", step: "select-region" }, { kind: "parseRect", flow: "notes" }],
  [{ type: "setParseStep", flow: "notes", step: "define-column" }, { kind: "parseRect", flow: "notes" }],
  [{ type: "setParseStep", flow: "notes", step: "define-row" }, { kind: "parseRect", flow: "notes" }],
  [{ type: "setParseStep", flow: "spec", step: "select-region" }, { kind: "parseRect", flow: "spec" }],
] as const satisfies ReadonlyArray<readonly [ActiveToolIntent, ActiveToolObject]>;

const IDLE_PARSE_STEPS: ParseStepByFlow = {
  table: "idle",
  keynote: "idle",
  notes: "idle",
  spec: "idle",
};

function compact(value: string): string {
  return value.replace(/\s+/g, "");
}

function parseSource(sourceText: string): ts.SourceFile {
  return ts.createSourceFile(
    MODULE_FILE,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function activeToolMembers(sourceText: string): string[] {
  const source = parseSource(sourceText);
  const alias = source.statements.find((statement): statement is ts.TypeAliasDeclaration =>
    ts.isTypeAliasDeclaration(statement) && statement.name.text === "ActiveTool"
  );
  if (!alias || !ts.isUnionTypeNode(alias.type)) return [];
  return alias.type.types.map((member) => compact(member.getText(source)));
}

function typeAliasText(sourceText: string, name: string): string | null {
  const source = parseSource(sourceText);
  const alias = source.statements.find((statement): statement is ts.TypeAliasDeclaration =>
    ts.isTypeAliasDeclaration(statement) && statement.name.text === name
  );
  return alias ? compact(alias.type.getText(source)) : null;
}

function exportedNames(source: ts.SourceFile): string[] {
  return source.statements.flatMap((statement) => {
    const exported = ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported || !("name" in statement)) return [];
    const name = statement.name;
    return name && ts.isIdentifier(name) ? [name.text] : [];
  });
}

function productionFiles(directory = join(process.cwd(), "src")): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) return productionFiles(absolute);
    if (!/\.tsx?$/.test(entry.name) || entry.name.endsWith(".d.ts")) return [];
    const path = relative(process.cwd(), absolute).replace(/\\/g, "/");
    if (path === MODULE_FILE || path.includes("/__tests__/") || /\.(?:test|spec)\./.test(path)) {
      return [];
    }
    return [path];
  });
}

function staticString(node: ts.Node): string | null {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (
    ts.isParenthesizedExpression(node) || ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) return staticString(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(node.left);
    const right = staticString(node.right);
    return left === null || right === null ? null : left + right;
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const expression = staticString(span.expression);
      if (expression === null) return null;
      value += expression + span.literal.text;
    }
    return value;
  }
  return null;
}

function normalizedLocalModule(importerPath: string, specifier: string): string | null {
  const withoutExtension = (value: string) =>
    value.replace(/\\/g, "/").replace(/\.(?:[cm]?[jt]sx?)$/, "").replace(/\/index$/, "");
  if (specifier.startsWith("@/")) {
    return withoutExtension(join("src", specifier.slice(2)));
  }
  if (specifier.startsWith(".")) {
    return withoutExtension(join(dirname(importerPath), specifier));
  }
  return null;
}

function moduleDependencyKinds(sourceText: string): string[] {
  const source = parseSource(sourceText);
  const hits = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      hits.add("import");
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      hits.add("export");
    } else if (
      ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
    ) {
      hits.add("import-equals");
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) hits.add("dynamic-import");
      if (ts.isIdentifier(node.expression) && node.expression.text === "require") hits.add("require");
    } else if (ts.isImportTypeNode(node)) {
      hits.add("import-type");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...hits].sort();
}

function activeToolModuleLoads(path: string, sourceText: string): string[] {
  if (
    !sourceText.includes("active-tool-state") &&
    !/\b(?:import|require)\s*\(/.test(sourceText)
  ) return [];
  const source = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const target = MODULE_FILE.replace(/\.ts$/, "");
  const referencesTarget = (expression: ts.Node): boolean => {
    const specifier = staticString(expression);
    if (specifier !== null) return normalizedLocalModule(path, specifier) === target;
    return expression.getText(source).includes("active-tool-state");
  };
  const hits = new Set<string>();
  const add = (kind: string) => hits.add(`${path}:${kind}`);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && referencesTarget(node.moduleSpecifier)) {
      add("import");
    } else if (
      ts.isExportDeclaration(node) && node.moduleSpecifier && referencesTarget(node.moduleSpecifier)
    ) {
      add("export");
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression &&
      referencesTarget(node.moduleReference.expression)
    ) {
      add("import-equals");
    } else if (ts.isCallExpression(node) && node.arguments[0]) {
      const kind = node.expression.kind === ts.SyntaxKind.ImportKeyword
        ? "dynamic-import"
        : ts.isIdentifier(node.expression) && node.expression.text === "require"
        ? "require"
        : null;
      if (
        kind &&
        (staticString(node.arguments[0]) === null || referencesTarget(node.arguments[0]))
      ) add(kind);
    } else if (
      ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) &&
      referencesTarget(node.argument.literal)
    ) {
      add("import-type");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...hits].sort();
}

function projection(
  activeTool: ActiveTool,
  activeTakeoffItemId: number | null = 7,
): ActiveToolProjection {
  return { activeTool, activeTakeoffItemId };
}

function snapshot(
  activeTool: ActiveTool,
  options: Partial<Omit<CanvasGestureSnapshot, "activeTool">> = {},
): CanvasGestureSnapshot {
  return {
    activeTool,
    mode: "move",
    parseSteps: IDLE_PARSE_STEPS,
    publicId: "P-A",
    pageNumber: 7,
    ...options,
  };
}

function setActiveStep<F extends ParseRectFlow>(
  flow: F,
  step: ParseStepByFlow[F],
): ParseStepByFlow {
  return { ...IDLE_PARSE_STEPS, [flow]: step };
}

function parseIntent(pair: CorrelatedParsePair): ActiveToolIntent {
  switch (pair[0]) {
    case "table":
      return { type: "setParseStep", flow: pair[0], step: pair[1] };
    case "keynote":
      return { type: "setParseStep", flow: pair[0], step: pair[1] };
    case "notes":
      return { type: "setParseStep", flow: pair[0], step: pair[1] };
    case "spec":
      return { type: "setParseStep", flow: pair[0], step: pair[1] };
  }
}

describe("AT2 exact ActiveTool representation", () => {
  it("pins the dependency-free API, exact union, and closed production borrowers", () => {
    const sourceText = readFileSync(join(process.cwd(), MODULE_FILE), "utf8");
    const source = parseSource(sourceText);

    expect(source.statements.filter(ts.isImportDeclaration)).toEqual([]);
    expect(moduleDependencyKinds(sourceText)).toEqual([]);
    expect(source.statements.filter(ts.isVariableStatement)).toEqual([]);
    expect(exportedNames(source)).toEqual([
      "TableLikeParseStep",
      "SpecParseStep",
      "ParseStepByFlow",
      "ParseRectFlow",
      "ParseDrawingStep",
      "ParseDrawingStepByFlow",
      "BaseInteractionMode",
      "ActiveTool",
      "ActiveToolObject",
      "ActiveToolKey",
      "ActiveToolProjection",
      "ActiveToolIntent",
      "CanvasGestureOwner",
      "CanvasGestureSnapshot",
      "CanvasGestureLease",
      "selectActiveToolKey",
      "selectActiveTagId",
      "isDrawCapableParseStep",
      "takeoffPlacementFallback",
      "activeToolReleaseFallback",
      "transitionActiveTool",
      "releaseActiveToolExact",
      "activeToolAfterPageChange",
      "resolveCanvasGestureOwner",
      "captureCanvasGestureLease",
      "matchesCanvasGestureLease",
    ]);
    expect(activeToolMembers(sourceText)).toEqual(EXPECTED_ACTIVE_TOOL_MEMBERS);
    expect(typeAliasText(sourceText, "TableLikeParseStep")).toBe(
      '|"idle"|"select-region"|"define-column"|"define-row"|"review"',
    );
    expect(typeAliasText(sourceText, "SpecParseStep")).toBe(
      '"idle"|"select-region"|"define-sections"|"review"',
    );
    expect(typeAliasText(sourceText, "ParseDrawingStep")).toBe(
      '"select-region"|"define-column"|"define-row"',
    );
    expect(typeAliasText(sourceText, "ParseStepByFlow")).toBe(
      "Readonly<{table:TableLikeParseStep;keynote:TableLikeParseStep;" +
      "notes:TableLikeParseStep;spec:SpecParseStep;}>",
    );
    expect(typeAliasText(sourceText, "ParseDrawingStepByFlow")).toBe(
      'Readonly<{table:ParseDrawingStep;keynote:ParseDrawingStep;' +
      'notes:ParseDrawingStep;spec:"select-region";}>',
    );
    expect(typeAliasText(sourceText, "ActiveToolKey")).toBe(
      '|"calibration"|"takeoffPlacement"|"bucketFill"|"split"|"symbolTemplate"' +
      '|"tagPick"|"tagAdd"|`parseRect:${ParseRectFlow}`|null',
    );
    expect(typeAliasText(sourceText, "ParseStepIntent")).toBe(
      '{[FinParseRectFlow]:{type:"setParseStep";flow:F;step:ParseStepByFlow[F]};}' +
      '[ParseRectFlow]',
    );
    expect(typeAliasText(sourceText, "ParseGestureOwner")).toBe(
      '{[FinParseRectFlow]:{kind:"parseRect";activation:{kind:"parseRect";flow:F};' +
      'step:ParseDrawingStepByFlow[F];};}[ParseRectFlow]',
    );
    expect(typeAliasText(sourceText, "CanvasGestureOwner")).toBe(
      '|{kind:"baseRect";mode:"markup"|"group"}' +
      '|{kind:"symbolTemplate";activation:SymbolActivation}' +
      '|{kind:"tagAdd";activation:TagAddActivation}|ParseGestureOwner',
    );
    expect(typeAliasText(sourceText, "ActiveToolIntent")).toBe(
      '|{type:"setMode";mode:BaseInteractionMode}' +
      '|{type:"selectTakeoff";itemId:number|null}' +
      '|{type:"setCalibrationMode";mode:"idle"|"point1"|"point2"|"input"}' +
      '|{type:"setBucketFill";active:boolean}' +
      '|{type:"setSplit";active:boolean}' +
      '|{type:"setSymbolTemplate";active:boolean}' +
      '|{type:"setTagPick";active:boolean}' +
      '|{type:"setTagAdd";tagId:string|null}|ParseStepIntent',
    );
    expect(sourceText).not.toMatch(/setActiveTool|\brevision\b/);

    for (const [before, after] of [
      ['| { kind: "bucketFill" }', '| { kind: "bucketFlood" }'],
      ['| { kind: "tagAdd"; tagId: string }', '| { kind: "tagAdd" }'],
      ['"table" | "keynote" | "notes" | "spec"', '"table" | "keynote" | "notes"'],
    ] as const) {
      const mutated = sourceText.replace(before, after);
      expect(mutated, before).not.toBe(sourceText);
      expect(activeToolMembers(mutated), before).not.toEqual(EXPECTED_ACTIVE_TOOL_MEMBERS);
    }

    expect(activeToolModuleLoads(MODULE_FILE, sourceText)).toEqual([]);
    const borrowers = productionFiles().flatMap((path) =>
      activeToolModuleLoads(path, readFileSync(join(process.cwd(), path), "utf8"))
    );
    expect(borrowers.sort()).toEqual([
      "src/components/viewer/AnnotationOverlay.tsx:import",
      "src/components/viewer/AreaTab.tsx:import",
      "src/components/viewer/DrawingPreviewLayer.tsx:import",
      "src/components/viewer/LinearTab.tsx:import",
      "src/components/viewer/TakeoffPanel.tsx:import",
      "src/queries/useYoloTags.ts:import",
      "src/stores/toolStore.ts:import",
      "src/stores/viewerCommands.ts:import",
    ]);
    const borrowerMutants = [
      `import * as model from "../lib/active-tool-state"; void model;`,
      `import model = require("@/lib/active-tool-state"); void model;`,
      `const model = require("@/lib/" + "active-tool-state"); void model;`,
      `void import("../lib/active-tool-state");`,
      `export * from "../lib/active-tool-state";`,
      `type Model = import("../lib/active-tool-state").ActiveTool; void 0 as unknown as Model;`,
      `const suffix = runtimeSuffix(); void import("../lib/active-tool-state" + suffix);`,
      `const target = "../lib/active-tool-state"; void import(target);`,
    ];
    for (const mutant of borrowerMutants) {
      expect(activeToolModuleLoads("src/components/model-bypass-mutant.ts", mutant), mutant)
        .not.toEqual([]);
    }
    expect(readFileSync(join(process.cwd(), "src/stores/toolStore.ts"), "utf8"))
      .toMatch(/\bactiveTool:\s*ActiveTool\b/);

    const exactKey: ActiveToolKey = "parseRect:spec";
    const exactDrawingStep: ParseDrawingStep = "define-column";
    const exactOwner: CanvasGestureOwner = {
      kind: "parseRect",
      activation: { kind: "parseRect", flow: "spec" },
      step: "select-region",
    };
    void exactKey;
    void exactDrawingStep;
    void exactOwner;
    // @ts-expect-error AT1 keys are a closed primitive union.
    const invalidKey: ActiveToolKey = "anything";
    // @ts-expect-error Idle is not a drawing step.
    const invalidDrawingStep: ParseDrawingStep = "idle";
    const invalidSpecOwner: CanvasGestureOwner = {
      kind: "parseRect",
      // @ts-expect-error Spec cannot use a table-only drawing step.
      activation: { kind: "parseRect", flow: "spec" },
      step: "define-column",
    };
    const invalidSpecIntent: ActiveToolIntent = {
      type: "setParseStep",
      flow: "spec",
      // @ts-expect-error Parse flow and step must remain correlated.
      step: "define-column",
    };
    void invalidKey;
    void invalidDrawingStep;
    void invalidSpecOwner;
    void invalidSpecIntent;
  }, 15_000);

  it("derives one primitive hot key and a separate cold exact tag id", () => {
    const cases: Array<[ActiveTool, ReturnType<typeof selectActiveToolKey>, string | null]> = [
      [null, null, null],
      [{ kind: "calibration" }, "calibration", null],
      [{ kind: "takeoffPlacement" }, "takeoffPlacement", null],
      [{ kind: "bucketFill" }, "bucketFill", null],
      [{ kind: "split" }, "split", null],
      [{ kind: "symbolTemplate" }, "symbolTemplate", null],
      [{ kind: "tagPick" }, "tagPick", null],
      [{ kind: "tagAdd", tagId: "" }, "tagAdd", ""],
      [{ kind: "tagAdd", tagId: "TAG-A" }, "tagAdd", "TAG-A"],
      [{ kind: "parseRect", flow: "table" }, "parseRect:table", null],
      [{ kind: "parseRect", flow: "keynote" }, "parseRect:keynote", null],
      [{ kind: "parseRect", flow: "notes" }, "parseRect:notes", null],
      [{ kind: "parseRect", flow: "spec" }, "parseRect:spec", null],
    ];
    for (const [activeTool, key, tagId] of cases) {
      expect(selectActiveToolKey({ activeTool }), JSON.stringify(activeTool)).toBe(key);
      expect(selectActiveTagId({ activeTool }), JSON.stringify(activeTool)).toBe(tagId);
    }
  });
});

describe("AT1 pure transition and fallback table", () => {
  it("activates every command freshly from null and all eleven incumbent tools", () => {
    for (const [intent, expected] of ACTIVATION_CASES) {
      let priorResult: ActiveToolObject | null = null;
      for (const current of [null, ...ALL_ACTIVE_TOOLS] as const) {
        const result = transitionActiveTool(projection(current), intent);
        expect(result, `${intent.type}:${JSON.stringify(current)}`).toEqual(expected);
        expect(result).not.toBe(current);
        if (priorResult !== null) expect(result).not.toBe(priorResult);
        if (result === null) throw new Error("activation unexpectedly returned null");
        priorResult = result;
      }
    }
  });

  it("pins all 19 correlated parse pairs and the exact ten draw-capable pairs", () => {
    let validPairs = 0;
    let drawingPairs = 0;
    for (const pair of VALID_PARSE_PAIRS) {
      const [flow, step] = pair;
      validPairs += 1;
      const drawing = DRAWING_PARSE_PAIRS.has(`${flow}:${step}`);
      if (drawing) drawingPairs += 1;
      expect(isDrawCapableParseStep(flow, step), `${flow}:${step}:helper`).toBe(drawing);
      const current: ActiveToolObject = { kind: "parseRect", flow };
      const intent = parseIntent(pair);
      const result = transitionActiveTool(projection(current), intent);
      expect(result, `${flow}:${step}`).toEqual(
        drawing ? { kind: "parseRect", flow } : null,
      );
      if (drawing) expect(result, `${flow}:${step}:fresh`).not.toBe(current);
      if (!drawing) {
        for (const incumbent of [null, ...ALL_ACTIVE_TOOLS] as const) {
          const released = transitionActiveTool(projection(incumbent), intent);
          if (incumbent?.kind === "parseRect" && incumbent.flow === flow) {
            expect(released, `${flow}:${step}:matching:${incumbent.flow}`).toBeNull();
          } else {
            expect(released, `${flow}:${step}:dormant:${incumbent?.kind ?? "null"}`)
              .toBe(incumbent);
          }
        }
      }
    }
    expect(validPairs).toBe(19);
    expect(drawingPairs).toBe(10);
  });

  it("centralizes matching release fallbacks and treats 0/negative IDs as selected", () => {
    for (const itemId of [0, -1, 7]) {
      expect(takeoffPlacementFallback(itemId)).toEqual({ kind: "takeoffPlacement" });
      for (const current of [
        { kind: "calibration" },
        { kind: "bucketFill" },
        { kind: "symbolTemplate" },
      ] satisfies ActiveToolObject[]) {
        expect(activeToolReleaseFallback(current, itemId)).toEqual({ kind: "takeoffPlacement" });
      }
    }
    expect(takeoffPlacementFallback(null)).toBeNull();
    for (const current of [
      { kind: "calibration" },
      { kind: "bucketFill" },
      { kind: "symbolTemplate" },
    ] satisfies ActiveToolObject[]) {
      expect(activeToolReleaseFallback(current, null), `${current.kind}:absent`).toBeNull();
    }
    for (const current of [
      { kind: "takeoffPlacement" },
      { kind: "split" },
      { kind: "tagPick" },
      { kind: "tagAdd", tagId: "TAG-A" },
      { kind: "parseRect", flow: "notes" },
    ] satisfies ActiveToolObject[]) {
      expect(activeToolReleaseFallback(current, 7), current.kind).toBeNull();
    }
  });

  it("applies every matching deactivation and leaves all nonmatching dormant releases inert", () => {
    const cases: ReadonlyArray<readonly [ActiveToolObject, ActiveToolIntent, ActiveTool]> = [
      [{ kind: "takeoffPlacement" }, { type: "selectTakeoff", itemId: null }, null],
      [{ kind: "calibration" }, { type: "setCalibrationMode", mode: "idle" }, { kind: "takeoffPlacement" }],
      [{ kind: "bucketFill" }, { type: "setBucketFill", active: false }, { kind: "takeoffPlacement" }],
      [{ kind: "split" }, { type: "setSplit", active: false }, null],
      [{ kind: "symbolTemplate" }, { type: "setSymbolTemplate", active: false }, { kind: "takeoffPlacement" }],
      [{ kind: "tagPick" }, { type: "setTagPick", active: false }, null],
      [{ kind: "tagAdd", tagId: "TAG-A" }, { type: "setTagAdd", tagId: null }, null],
      [{ kind: "parseRect", flow: "table" }, { type: "setParseStep", flow: "table", step: "review" }, null],
      [{ kind: "parseRect", flow: "keynote" }, { type: "setParseStep", flow: "keynote", step: "idle" }, null],
      [{ kind: "parseRect", flow: "notes" }, { type: "setParseStep", flow: "notes", step: "review" }, null],
      [{ kind: "parseRect", flow: "spec" }, { type: "setParseStep", flow: "spec", step: "define-sections" }, null],
    ];
    for (let ownerIndex = 0; ownerIndex < cases.length; ownerIndex += 1) {
      const [owner, , expected] = cases[ownerIndex];
      expect(transitionActiveTool(projection(owner), cases[ownerIndex][1])).toEqual(expected);
      for (let intentIndex = 0; intentIndex < cases.length; intentIndex += 1) {
        if (intentIndex === ownerIndex) continue;
        const intent = cases[intentIndex][1];
        expect(transitionActiveTool(projection(owner), intent), `${owner.kind}:${intent.type}`)
          .toBe(owner);
      }
    }
    for (const [owner, intent] of cases.filter(([candidate]) =>
      candidate.kind === "calibration" || candidate.kind === "bucketFill" ||
      candidate.kind === "symbolTemplate"
    )) {
      expect(transitionActiveTool(projection(owner, null), intent), `${owner.kind}:absent`)
        .toBeNull();
    }
  });

  it("lets base mode always win and non-null takeoff selection replace every owner", () => {
    for (const current of [null, ...ALL_ACTIVE_TOOLS]) {
      for (const mode of ["move", "pointer", "markup", "group"] as const) {
        expect(transitionActiveTool(
          projection(current),
          { type: "setMode", mode },
        ), `${JSON.stringify(current)}:${mode}`).toBeNull();
      }
      expect(transitionActiveTool(
        projection(current),
        { type: "selectTakeoff", itemId: 0 },
      )).toEqual({ kind: "takeoffPlacement" });
    }
  });

  it("uses exact-object CAS so same-kind B survives stale A release", () => {
    for (const activeA of ALL_ACTIVE_TOOLS) {
      const activeB = { ...activeA } as ActiveToolObject;
      expect(releaseActiveToolExact(activeB, activeA, 7), activeA.kind).toBe(activeB);
      expect(releaseActiveToolExact(activeA, activeA, 7), activeA.kind)
        .toEqual(activeToolReleaseFallback(activeA, 7));
    }
  });

  it("pins every page destination with exact survivor identity", () => {
    type PagePolicy = "null" | "same" | "freshTakeoff";
    const pageCases: ReadonlyArray<readonly [
      current: ActiveToolObject,
      selected: PagePolicy,
      unselected: PagePolicy,
    ]> = [
      [{ kind: "takeoffPlacement" }, "same", "null"],
      [{ kind: "calibration" }, "freshTakeoff", "null"],
      [{ kind: "bucketFill" }, "freshTakeoff", "null"],
      [{ kind: "split" }, "null", "null"],
      [{ kind: "symbolTemplate" }, "freshTakeoff", "null"],
      [{ kind: "tagPick" }, "same", "same"],
      [{ kind: "tagAdd", tagId: "TAG-A" }, "same", "same"],
      [{ kind: "parseRect", flow: "table" }, "null", "null"],
      [{ kind: "parseRect", flow: "keynote" }, "null", "null"],
      [{ kind: "parseRect", flow: "notes" }, "same", "same"],
      [{ kind: "parseRect", flow: "spec" }, "same", "same"],
    ];
    for (const activeTakeoffItemId of [null, 0, -1, 7]) {
      expect(activeToolAfterPageChange(projection(null, activeTakeoffItemId))).toBeNull();
      for (const [current, selected, unselected] of pageCases) {
        const policy = activeTakeoffItemId === null ? unselected : selected;
        const result = activeToolAfterPageChange(projection(current, activeTakeoffItemId));
        const label = `${current.kind}:${activeTakeoffItemId}`;
        if (policy === "null") {
          expect(result, label).toBeNull();
        } else if (policy === "same") {
          expect(result, label).toBe(current);
        } else {
          expect(result, label).toEqual({ kind: "takeoffPlacement" });
          expect(result, label).not.toBe(current);
        }
      }
    }
  });

  it("does not mutate frozen state or intent inputs", () => {
    const activeTool = Object.freeze({ kind: "tagAdd", tagId: "TAG-A" } as const);
    const state = Object.freeze({ activeTool, activeTakeoffItemId: 7 });
    const intent = Object.freeze({ type: "setTagAdd", tagId: null } as const);
    expect(transitionActiveTool(state, intent)).toBeNull();
    expect(state).toEqual({ activeTool, activeTakeoffItemId: 7 });
    expect(intent).toEqual({ type: "setTagAdd", tagId: null });
  });
});

describe("AT1 deferred canvas gesture leases", () => {
  it("selects base rectangles only from null and suppresses base fallthrough for every other tool", () => {
    for (const mode of ["move", "pointer", "markup", "group"] as const) {
      expect(resolveCanvasGestureOwner(snapshot(null, { mode }))).toEqual(
        mode === "markup" || mode === "group" ? { kind: "baseRect", mode } : null,
      );
    }
    for (const activeTool of ALL_ACTIVE_TOOLS.filter((candidate) =>
      candidate.kind !== "symbolTemplate" && candidate.kind !== "tagAdd" &&
      candidate.kind !== "parseRect"
    )) {
      for (const mode of ["markup", "group"] as const) {
        expect(resolveCanvasGestureOwner(snapshot(activeTool, { mode })), `${activeTool.kind}:${mode}`)
          .toBeNull();
      }
    }
  });

  it("gives Symbol and Tag Add exact-object precedence over every base mode", () => {
    const symbol: ActiveToolObject = { kind: "symbolTemplate" };
    const tag: ActiveToolObject = { kind: "tagAdd", tagId: "TAG-A" };
    for (const mode of ["move", "pointer", "markup", "group"] as const) {
      expect(resolveCanvasGestureOwner(snapshot(symbol, { mode })), `symbol:${mode}`)
        .toEqual({ kind: "symbolTemplate", activation: symbol });
      expect(resolveCanvasGestureOwner(snapshot(tag, { mode })), `tag:${mode}`)
        .toEqual({ kind: "tagAdd", activation: tag });
    }

    const symbolLease = captureCanvasGestureLease({}, snapshot(symbol, { mode: "markup" }));
    if (!symbolLease) throw new Error("expected Symbol canvas lease");
    const symbolB: ActiveToolObject = { kind: "symbolTemplate" };
    expect(matchesCanvasGestureLease(symbolLease, snapshot(symbolB, { mode: "markup" })))
      .toBe(false);
  });

  it("selects only the active flow from all 19 correlated parse pairs", () => {
    let pairs = 0;
    for (const [flow, step] of VALID_PARSE_PAIRS) {
      const activation: ActiveToolObject = { kind: "parseRect", flow };
      for (const mode of ["move", "pointer", "markup", "group"] as const) {
        pairs += 1;
        const owner = resolveCanvasGestureOwner(snapshot(activation, {
          mode,
          parseSteps: setActiveStep(flow, step),
        }));
        const drawing = DRAWING_PARSE_PAIRS.has(`${flow}:${step}`);
        expect(owner, `${flow}:${step}:${mode}`).toEqual(drawing
          ? { kind: "parseRect", activation, step }
          : null);
      }
    }
    expect(pairs).toBe(76);
  });

  it("captures exact target semantics and rejects target, activation, mode, and active-step drift", () => {
    const token = {};
    const activation: ActiveToolObject = { kind: "parseRect", flow: "table" };
    const start = snapshot(activation, {
      parseSteps: setActiveStep("table", "define-column"),
    });
    const lease = captureCanvasGestureLease(token, start);
    expect(lease).toEqual({
      token,
      owner: { kind: "parseRect", activation, step: "define-column" },
      publicId: "P-A",
      pageNumber: 7,
    });
    if (!lease) throw new Error("expected a deferred canvas lease");

    expect(matchesCanvasGestureLease(lease, start)).toBe(true);
    expect(matchesCanvasGestureLease(lease, { ...start, pageNumber: 8 })).toBe(false);
    expect(matchesCanvasGestureLease(lease, { ...start, publicId: "P-B" })).toBe(false);
    expect(matchesCanvasGestureLease(lease, {
      ...start,
      parseSteps: setActiveStep("table", "define-row"),
    })).toBe(false);
    expect(matchesCanvasGestureLease(lease, {
      ...start,
      activeTool: { kind: "parseRect", flow: "table" },
    })).toBe(false);

    const baseStart = snapshot(null, { mode: "markup" });
    const baseLease = captureCanvasGestureLease({}, baseStart);
    if (!baseLease) throw new Error("expected a base canvas lease");
    expect(matchesCanvasGestureLease(baseLease, baseStart)).toBe(true);
    expect(matchesCanvasGestureLease(baseLease, { ...baseStart, mode: "group" })).toBe(false);
    for (const activeTool of ALL_ACTIVE_TOOLS) {
      expect(
        matchesCanvasGestureLease(baseLease, { ...baseStart, activeTool }),
        `base-drift:${activeTool.kind}`,
      ).toBe(false);
    }
    // Null has no object generation; global exact-token ownership closes null→B→null ABA.
    expect(matchesCanvasGestureLease(baseLease, baseStart)).toBe(true);

    expect(captureCanvasGestureLease({}, snapshot({ kind: "bucketFill" }, { mode: "markup" })))
      .toBeNull();
  });

  it("ignores dormant peer parse-step mutations while the active flow stays exact", () => {
    const activation: ActiveToolObject = { kind: "parseRect", flow: "notes" };
    const start = snapshot(activation, {
      parseSteps: { ...IDLE_PARSE_STEPS, notes: "select-region" },
    });
    const lease = captureCanvasGestureLease({}, start);
    if (!lease) throw new Error("expected Notes canvas lease");
    expect(matchesCanvasGestureLease(lease, {
      ...start,
      parseSteps: {
        table: "define-row",
        keynote: "define-column",
        notes: "select-region",
        spec: "select-region",
      },
    })).toBe(true);
  });

  it("rejects same-payload Tag B and does not mutate frozen canvas snapshots", () => {
    const activationA = Object.freeze({ kind: "tagAdd", tagId: "TAG-A" } as const);
    const start = Object.freeze(snapshot(activationA));
    const token = Object.freeze({ gesture: "A" });
    const lease = captureCanvasGestureLease(token, start);
    if (!lease) throw new Error("expected Tag Add canvas lease");
    expect(matchesCanvasGestureLease(lease, snapshot({ kind: "tagAdd", tagId: "TAG-A" })))
      .toBe(false);
    expect(lease.token).toBe(token);
    expect(start.activeTool).toBe(activationA);
  });
});
