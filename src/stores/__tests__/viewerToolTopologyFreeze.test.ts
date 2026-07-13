// @vitest-environment node
// [refactor jul11 P2.3 T2] Post-carve ownership/subscription contract for the flat tool slice.
// Runtime parity is characterized separately. This source gate protects sole ownership, the
// parse/drawing exclusions, and the two canvas-hot consumers from widened selectors.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const VIEWER_STORE_FILE = "src/stores/viewerStore.ts";
const PARSE_STORE_FILE = "src/stores/parseFlowStore.ts";
const TOOL_STORE_FILE = "src/stores/toolStore.ts";
const ANNOTATION_OVERLAY = "src/components/viewer/AnnotationOverlay.tsx";
const DRAWING_PREVIEW = "src/components/viewer/DrawingPreviewLayer.tsx";
const YOLO_FACADE = "src/queries/useYoloTags.ts";
const ACTIVE_TOOL_STATE_MODULE = "@/lib/active-tool-state";

const VIEWER_OWNER = {
  file: VIEWER_STORE_FILE,
  module: "@/stores/viewerStore",
  exportName: "useViewerStore",
} as const;
const PARSE_OWNER = {
  file: PARSE_STORE_FILE,
  module: "@/stores/parseFlowStore",
  exportName: "useParseFlowStore",
} as const;
const TOOL_OWNER = {
  file: TOOL_STORE_FILE,
  module: "@/stores/toolStore",
  exportName: "useToolStore",
} as const;

const ACTIVE_TOOL_OWNER = TOOL_OWNER;
const INACTIVE_TOOL_OWNER = VIEWER_OWNER;

type FieldContract = { readonly default: string; readonly actions: readonly string[] };

const TOOL_CONTRACT = {
  mode: { default: '"move"', actions: ["setMode"] },
  tempPanMode: { default: "false", actions: ["setTempPanMode"] },
  activeTool: {
    default: "null",
    actions: [
      "setMode", "setActiveTakeoffItemId", "setCalibrationMode", "resetCalibration",
      "setBucketFillActive", "setSplitAreaActive", "setYoloTagPickingMode",
      "setTagAddingMode", "setSymbolSearchActive", "clearSymbolSearch",
      "resetProjectToolState",
    ],
  },
  activeTakeoffItemId: { default: "null", actions: ["setActiveTakeoffItemId"] },
  scaleCalibrations: { default: "{}", actions: ["setScaleCalibration"] },
  calibrationMode: { default: '"idle"', actions: ["setCalibrationMode", "resetCalibration"] },
  calibrationPoints: {
    default: "{}",
    actions: ["setCalibrationMode", "setCalibrationPoint", "resetCalibration"],
  },
  polygonDrawingMode: { default: '"idle"', actions: ["setPolygonDrawingMode", "resetPolygonDrawing"] },
  polygonVertices: { default: "[]", actions: ["addPolygonVertex", "undoLastVertex", "resetPolygonDrawing"] },
  bucketFillPreview: { default: "null", actions: ["setBucketFillPreview"] },
  bucketFillLoading: { default: "false", actions: ["setBucketFillLoading"] },
  bucketFillError: { default: "null", actions: ["setBucketFillError"] },
  bucketFillTolerance: { default: "30", actions: ["setBucketFillTolerance"] },
  bucketFillDilatePx: { default: "3", actions: ["setBucketFillDilatePx"] },
  bucketFillResolution: { default: "1000", actions: ["setBucketFillResolution"] },
  bucketFillPendingPolygon: { default: "null", actions: ["setBucketFillPendingPolygon"] },
  splitLineA: { default: "null", actions: ["setSplitLineEndpoint"] },
  splitLineB: { default: "null", actions: ["setSplitLineEndpoint"] },
  splitPreview: { default: "null", actions: ["setSplitPreview"] },
  splitError: { default: "null", actions: ["setSplitError"] },
  bucketFillBarriers: { default: "[]", actions: ["addBucketFillBarrier", "undoLastBarrier", "clearBucketFillBarriers"] },
  bucketFillBarrierMode: { default: "false", actions: ["setBucketFillBarrierMode"] },
  barrierPendingPoint: { default: "null", actions: ["setBarrierPendingPoint"] },
  takeoffUndoStack: { default: "[]", actions: [] },
  takeoffRedoStack: { default: "[]", actions: [] },
  tagScanResults: { default: "null", actions: ["setTagScanResults"] },
  symbolSearchLoading: { default: "false", actions: ["setSymbolSearchLoading"] },
  symbolSearchProgress: { default: "null", actions: ["setSymbolSearchProgress"] },
  symbolSearchResults: { default: "null", actions: ["setSymbolSearchResults"] },
  symbolSearchConfidence: { default: "0.75", actions: ["setSymbolSearchConfidence"] },
  dismissedSymbolMatches: { default: "newSet<string>()", actions: ["dismissSymbolMatch"] },
  symbolSearchError: { default: "null", actions: ["setSymbolSearchError"] },
  symbolSearchTemplateBbox: { default: "null", actions: ["setSymbolSearchTemplateBbox"] },
  symbolSearchSourcePage: { default: "null", actions: ["setSymbolSearchSourcePage"] },
  symbolSearchConfig: {
    default: "{multiScale:true,useSiftFallback:true,searchPages:null,scaleMin:0.8,scaleMax:1.5,nmsThreshold:0.3,maxMatchesPerPage:50,}",
    actions: ["setSymbolSearchConfig"],
  },
  symbolSearchPreset: { default: '"lite"', actions: ["setSymbolSearchPreset"] },
} as const satisfies Record<string, FieldContract>;

const TOOL_ACTIONS = [
  "setMode", "setTempPanMode", "setActiveTakeoffItemId", "setScaleCalibration",
  "setCalibrationMode", "setCalibrationPoint", "resetCalibration", "setPolygonDrawingMode",
  "addPolygonVertex", "undoLastVertex", "resetPolygonDrawing", "setBucketFillActive",
  "setBucketFillPreview", "setBucketFillLoading", "setBucketFillError", "setBucketFillTolerance",
  "setBucketFillDilatePx", "setBucketFillResolution", "setBucketFillPendingPolygon",
  "setSplitAreaActive", "setSplitLineEndpoint", "setSplitPreview", "setSplitError",
  "addBucketFillBarrier", "undoLastBarrier", "clearBucketFillBarriers",
  "setBucketFillBarrierMode", "setBarrierPendingPoint", "setYoloTagPickingMode",
  "setTagScanResults", "setTagAddingMode", "setSymbolSearchActive", "setSymbolSearchLoading",
  "setSymbolSearchProgress", "setSymbolSearchResults", "setSymbolSearchConfidence",
  "dismissSymbolMatch", "setSymbolSearchError", "setSymbolSearchTemplateBbox",
  "setSymbolSearchSourcePage", "setSymbolSearchConfig", "setSymbolSearchPreset",
  "clearSymbolSearch", "resetProjectToolState",
] as const;

const LEGACY_ACTIVATION_FIELDS = [
  "bucketFillActive", "splitAreaActive", "yoloTagPickingMode", "tagAddingMode",
  "symbolSearchActive",
] as const;

const TOOL_MEMBERS = new Set<string>([...Object.keys(TOOL_CONTRACT), ...TOOL_ACTIONS]);
// These members are reached only through the exact useSymbolSearch grouped surface (pinned below),
// or are currently dead compatibility actions. The direct-owner census deliberately scans callers,
// not a store's self-referential selector implementation, so account for this explicit remainder.
const GROUPED_OR_UNUSED_TOOL_MEMBERS = new Set([
  "dismissSymbolMatch",
  "dismissedSymbolMatches",
  "setSymbolSearchConfidence",
  "setSymbolSearchConfig",
  "setSymbolSearchPreset",
  "symbolSearchError",
  "symbolSearchLoading",
  "symbolSearchPreset",
  "symbolSearchProgress",
  "symbolSearchResults",
]);
const DRAWING_DATA = ["_drawing", "_drawStart", "_drawEnd", "_mousePos"] as const;
const DRAWING_ACTIONS = ["_setDrawing", "_setDrawStart", "_setDrawEnd", "_setMousePos"] as const;
const PREVIEW_PARSE_DATA = [
  "tableParseStep", "keynoteParseStep", "notesParseStep", "specParseStep",
] as const;

const BOUNDARY_EXCLUSIONS = {
  serverMetadata: ["allTrades", "setAllTrades", "allCsiCodes", "setAllCsiCodes"],
  mutableServerDraft: ["activeQtoWorkflow", "setActiveQtoWorkflow"],
  parseFlow: [
    "tableParseStep", "keynoteParseStep", "notesParseStep", "specParseStep",
    "guidedParseActive", "paragraphWorkspaceOwner", "paragraphClipboard",
    "tableCellStructure", "showTableCellStructure", "parseDraftRegion",
    "notesFastManualActive", "notesFastManualGrid",
  ],
  neutralReset: ["resetAllTools"],
  drawingQuarantine: [...DRAWING_DATA, ...DRAWING_ACTIONS],
} as const;

const SYMBOL_HOOK_SHAPE = [
  "symbolSearchActive", "setSymbolSearchActive", "symbolSearchLoading", "setSymbolSearchLoading",
  "symbolSearchProgress", "setSymbolSearchProgress", "symbolSearchResults", "setSymbolSearchResults",
  "symbolSearchConfidence", "setSymbolSearchConfidence", "symbolSearchError", "setSymbolSearchError",
  "symbolSearchTemplateBbox", "setSymbolSearchTemplateBbox", "symbolSearchSourcePage",
  "setSymbolSearchSourcePage", "dismissedSymbolMatches", "dismissSymbolMatch", "clearSymbolSearch",
  "symbolSearchConfig", "setSymbolSearchConfig", "symbolSearchPreset", "setSymbolSearchPreset",
] as const;

const SYMBOL_HOOK_CALLERS = {
  "src/components/viewer/PDFViewer.tsx": 1,
  "src/components/viewer/PageSidebar.tsx": 1,
  "src/components/viewer/SymbolSearchPanel.tsx": 1,
} as const;

const YOLO_TOOL_PROJECTION = [
  "yoloTagPickingMode", "setYoloTagPickingMode", "tagScanResults", "setTagScanResults",
  "tagAddingMode", "setTagAddingMode",
] as const;

const YOLO_DIRECT_TOOL_PROJECTION = [
  "setYoloTagPickingMode", "tagScanResults", "setTagScanResults", "setTagAddingMode",
] as const;

const ANNOTATION_TOOL_PRIMITIVES = [
  "mode", "setYoloTagPickingMode", "symbolSearchResults", "symbolSearchConfidence",
  "dismissedSymbolMatches", "activeTakeoffItemId", "scaleCalibrations", "polygonDrawingMode",
  "setPolygonDrawingMode", "addPolygonVertex", "undoLastVertex", "bucketFillLoading",
  "setBucketFillPreview", "bucketFillBarrierMode", "addBucketFillBarrier",
  "setSplitLineEndpoint", "setSplitPreview", "setSplitError", "tempPanMode",
] as const;

const PREVIEW_TOOL_PRIMITIVES = [
  "mode", "calibrationMode", "calibrationPoints", "polygonDrawingMode",
  "polygonVertices", "activeTakeoffItemId", "bucketFillPreview",
  "bucketFillLoading", "bucketFillError", "bucketFillBarriers", "bucketFillBarrierMode",
  "barrierPendingPoint", "splitLineA", "splitLineB", "splitPreview",
  "splitError", "bucketFillPendingPolygon",
] as const;

const PREVIEW_IMPERATIVE_TOOL_READS = [
  "setBucketFillActive", "setBucketFillBarrierMode", "setBucketFillPreview", "setSplitPreview",
] as const;

const textCache = new Map<string, string>();
const sourceCache = new Map<string, ts.SourceFile>();

function existsRelative(path: string): boolean {
  return existsSync(join(process.cwd(), path));
}

function textOf(path: string): string {
  const cached = textCache.get(path);
  if (cached !== undefined) return cached;
  const text = readFileSync(join(process.cwd(), path), "utf8");
  textCache.set(path, text);
  return text;
}

function parse(path: string): ts.SourceFile {
  const cached = sourceCache.get(path);
  if (cached) return cached;
  const source = ts.createSourceFile(
    path, textOf(path), ts.ScriptTarget.Latest, true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  sourceCache.set(path, source);
  return source;
}

function productionFiles(directory = "src"): string[] {
  const output: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(join(process.cwd(), current), { withFileTypes: true })) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") visit(child);
      } else if (
        /\.(?:ts|tsx)$/.test(entry.name) &&
        !/\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name) &&
        !entry.name.endsWith(".d.ts") &&
        !child.startsWith("src/test/")
      ) output.push(child);
    }
  };
  visit(directory);
  return output.sort();
}

const productionSourceFiles = productionFiles();

// Test setup helpers publish into the real stores and can accidentally preserve a deleted owner
// just as easily as a component can. Keep them in the ownership census even though the broader
// production-topology checks intentionally exclude src/test/**.
function testSupportFiles(directory = "src/test"): string[] {
  if (!existsRelative(directory)) return [];
  const output: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(join(process.cwd(), current), { withFileTypes: true })) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (
        /\.(?:ts|tsx)$/.test(entry.name) &&
        !/\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name) &&
        !entry.name.endsWith(".d.ts")
      ) output.push(child);
    }
  };
  visit(directory);
  return output.sort();
}

function realTestFiles(directory = "src"): string[] {
  const output: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(join(process.cwd(), current), { withFileTypes: true })) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (/\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name)) output.push(child);
    }
  };
  visit(directory);
  return output.sort();
}

const ownerAuditSourceFiles = [
  ...productionSourceFiles,
  ...testSupportFiles(),
  ...realTestFiles(),
];

function descendants<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const output: T[] = [];
  const visit = (node: ts.Node) => {
    if (predicate(node)) output.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return output;
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) || ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) current = current.expression;
  return current;
}

function compact(node: ts.Node, source: ts.SourceFile): string {
  return node.getText(source).replace(/\s+/g, "");
}

function staticStrings(root: ts.Node): Map<string, string> {
  const constants = new Map<string, string>();
  const ambiguous = new Set<string>();
  const declarations = descendants(root, ts.isVariableDeclaration);
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const initializer = unwrap(declaration.initializer);
      const value = ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)
        ? initializer.text
        : ts.isIdentifier(initializer) ? constants.get(initializer.text) : undefined;
      if (value === undefined || ambiguous.has(declaration.name.text)) continue;
      const previous = constants.get(declaration.name.text);
      if (previous === value) continue;
      if (previous !== undefined) {
        constants.delete(declaration.name.text);
        ambiguous.add(declaration.name.text);
      } else {
        constants.set(declaration.name.text, value);
      }
      changed = true;
    }
  }
  return constants;
}

function staticName(
  name: ts.PropertyName | ts.BindingName | undefined,
  constants: ReadonlyMap<string, string> = new Map<string, string>(),
): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (!ts.isComputedPropertyName(name)) return null;
  const expression = unwrap(name.expression);
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  return ts.isIdentifier(expression) ? constants.get(expression.text) ?? null : null;
}

function elementName(access: ts.ElementAccessExpression, constants: ReadonlyMap<string, string>): string | null {
  const argument = access.argumentExpression && unwrap(access.argumentExpression);
  if (!argument) return null;
  if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) return argument.text;
  return ts.isIdentifier(argument) ? constants.get(argument.text) ?? null : null;
}

function directObjectKeys(object: ts.ObjectLiteralExpression, constants = new Map<string, string>()): string[] {
  return object.properties
    .map((property) => "name" in property ? staticName(property.name, constants) : null)
    .filter((name): name is string => name !== null);
}

function importedLocalNames(source: ts.SourceFile, moduleName: string, importedName: string): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== moduleName) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === importedName) names.add(element.name.text);
    }
  }
  return names;
}

function importedNamespaceLocalNames(source: ts.SourceFile, moduleName: string): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== moduleName) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
  }
  return names;
}

function aliases(root: ts.Node, seeds: Iterable<string>): Set<string> {
  const output = new Set(seeds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of descendants(root, ts.isVariableDeclaration)) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const initializer = unwrap(declaration.initializer);
      if (ts.isIdentifier(initializer) && output.has(initializer.text) && !output.has(declaration.name.text)) {
        output.add(declaration.name.text);
        changed = true;
      }
    }
  }
  return output;
}

function expressionMember(expression: ts.Expression, constants: ReadonlyMap<string, string>): string | null {
  const current = unwrap(expression);
  return ts.isPropertyAccessExpression(current)
    ? current.name.text
    : ts.isElementAccessExpression(current) ? elementName(current, constants) : null;
}

function methodAliases(
  source: ts.SourceFile,
  isStore: (expression: ts.Expression) => boolean,
  method: "getState" | "setState",
  constants: ReadonlyMap<string, string>,
): Set<string> {
  const seeds = new Set<string>();
  for (const declaration of descendants(source, ts.isVariableDeclaration)) {
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
    const initializer = unwrap(declaration.initializer);
    if (!ts.isPropertyAccessExpression(initializer) && !ts.isElementAccessExpression(initializer)) continue;
    const receiver = unwrap(initializer.expression);
    if (isStore(receiver) && expressionMember(initializer, constants) === method) {
      seeds.add(declaration.name.text);
    }
  }
  return aliases(source, seeds);
}

function isMethodCall(
  call: ts.CallExpression,
  isStore: (expression: ts.Expression) => boolean,
  methods: ReadonlySet<string>,
  method: "getState" | "setState",
  constants: ReadonlyMap<string, string>,
): boolean {
  const expression = unwrap(call.expression);
  if (ts.isIdentifier(expression)) return methods.has(expression.text);
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) return false;
  const receiver = unwrap(expression.expression);
  return isStore(receiver) && expressionMember(expression, constants) === method;
}

type SelectorFunction = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration;

function selectorFunction(
  source: ts.SourceFile,
  expression: ts.Expression | undefined,
  seen = new Set<string>(),
): SelectorFunction | null {
  if (!expression) return null;
  const current = unwrap(expression);
  if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) return current;
  if (ts.isIdentifier(current) && !seen.has(current.text)) {
    seen.add(current.text);
    const declarations = descendants(source, (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === current.text
    );
    if (declarations.length === 1) {
      return selectorFunction(source, declarations[0].initializer, seen);
    }
    const functions = descendants(source, (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === current.text
    );
    if (functions.length === 1) return functions[0];
  }
  if (ts.isCallExpression(current)) {
    for (const argument of current.arguments) {
      const nested = selectorFunction(source, argument, seen);
      if (nested) return nested;
    }
  }
  return null;
}

function bindingMembers(name: ts.BindingName, constants: ReadonlyMap<string, string>, members: ReadonlySet<string>): string[] {
  if (!ts.isObjectBindingPattern(name)) return [];
  return name.elements
    .map((element) => staticName(element.propertyName ?? element.name, constants))
    .filter((member): member is string => !!member && members.has(member));
}

function outsideCasts(expression: ts.Expression): ts.Node {
  let current = expression;
  while (current.parent && (
    ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent) ||
    ts.isTypeAssertionExpression(current.parent) || ts.isNonNullExpression(current.parent) ||
    ts.isSatisfiesExpression(current.parent)
  ) && current.parent.expression === current) current = current.parent;
  return current.parent;
}

type StoreAccess = { readonly kind: string; readonly member: string };

function storeMemberAccesses(
  source: ts.SourceFile,
  owner: { readonly module: string; readonly exportName: string },
  members: ReadonlySet<string>,
): StoreAccess[] {
  const output: StoreAccess[] = [];
  const constants = staticStrings(source);
  const namespaces = aliases(source, importedNamespaceLocalNames(source, owner.module));
  const isNamespaceStore = (expression: ts.Expression): boolean => {
    const current = unwrap(expression);
    if (!ts.isPropertyAccessExpression(current) && !ts.isElementAccessExpression(current)) return false;
    const receiver = unwrap(current.expression);
    return ts.isIdentifier(receiver) && namespaces.has(receiver.text) &&
      expressionMember(current, constants) === owner.exportName;
  };
  const storeSeeds = importedLocalNames(source, owner.module, owner.exportName);
  for (const declaration of descendants(source, ts.isVariableDeclaration)) {
    if (ts.isIdentifier(declaration.name) && declaration.initializer &&
      isNamespaceStore(declaration.initializer)) storeSeeds.add(declaration.name.text);
    const initializer = declaration.initializer && unwrap(declaration.initializer);
    if (!initializer || !ts.isIdentifier(initializer) || !namespaces.has(initializer.text) ||
      !ts.isObjectBindingPattern(declaration.name)) continue;
    for (const element of declaration.name.elements) {
      if (staticName(element.propertyName ?? element.name, constants) === owner.exportName &&
        ts.isIdentifier(element.name)) storeSeeds.add(element.name.text);
    }
  }
  const stores = aliases(source, storeSeeds);
  const isStore = (expression: ts.Expression): boolean => {
    const current = unwrap(expression);
    return (ts.isIdentifier(current) && stores.has(current.text)) || isNamespaceStore(current);
  };
  const getters = methodAliases(source, isStore, "getState", constants);
  const setters = methodAliases(source, isStore, "setState", constants);
  const isGet = (call: ts.CallExpression) => isMethodCall(call, isStore, getters, "getState", constants);
  const isSet = (call: ts.CallExpression) => isMethodCall(call, isStore, setters, "setState", constants);
  const isWholeHookCall = (call: ts.CallExpression) => call.arguments.length === 0 && isStore(call.expression);

  const declarations = descendants(source, ts.isVariableDeclaration)
    .filter((declaration) => ts.isIdentifier(declaration.name));
  const functionDeclarations = descendants(source, (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && !!node.name);
  const lexicalScope = (node: ts.Node): ts.Node => {
    let current = node.parent;
    while (current && !ts.isBlock(current) && !ts.isSourceFile(current)) current = current.parent;
    return current ?? source;
  };
  const declarationFor = (name: string, at: ts.Node): ts.VariableDeclaration | null => {
    const position = at.getStart(source);
    return declarations
      .filter((declaration) => {
        if ((declaration.name as ts.Identifier).text !== name || declaration.getStart(source) >= position) {
          return false;
        }
        const scope = lexicalScope(declaration);
        return scope.getStart(source) <= position && position < scope.end;
      })
      .sort((left, right) => right.getStart(source) - left.getStart(source))[0] ?? null;
  };
  const selectorFor = (
    expression: ts.Expression | undefined,
    at: ts.Node,
    seen = new Set<ts.Node>(),
  ): ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | null => {
    if (!expression) return null;
    const current = unwrap(expression);
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) return current;
    if (ts.isIdentifier(current)) {
      const declaration = declarationFor(current.text, at);
      if (declaration?.initializer && !seen.has(declaration)) {
        seen.add(declaration);
        const resolved = selectorFor(declaration.initializer, declaration, seen);
        if (resolved) return resolved;
      }
      return functionDeclarations.find((declaration) =>
        declaration.name?.text === current.text && !seen.has(declaration)) ?? null;
    }
    if (ts.isCallExpression(current)) {
      for (const argument of current.arguments) {
        const nested = selectorFor(argument, current, seen);
        if (nested) return nested;
      }
    }
    return null;
  };
  const resolvesToGet = (identifier: ts.Identifier, at: ts.Node, seen = new Set<ts.Node>()): boolean => {
    const declaration = declarationFor(identifier.text, at);
    if (!declaration || seen.has(declaration) || !declaration.initializer) return false;
    seen.add(declaration);
    const initializer = unwrap(declaration.initializer);
    if (ts.isCallExpression(initializer)) return isGet(initializer);
    return ts.isIdentifier(initializer) ? resolvesToGet(initializer, declaration, seen) : false;
  };
  const resolvesToWholeHook = (
    identifier: ts.Identifier,
    at: ts.Node,
    seen = new Set<ts.Node>(),
  ): boolean => {
    const declaration = declarationFor(identifier.text, at);
    if (!declaration || seen.has(declaration) || !declaration.initializer) return false;
    seen.add(declaration);
    const initializer = unwrap(declaration.initializer);
    if (ts.isCallExpression(initializer)) return isWholeHookCall(initializer);
    return ts.isIdentifier(initializer)
      ? resolvesToWholeHook(initializer, declaration, seen)
      : false;
  };

  for (const call of descendants(source, ts.isCallExpression)) {
    const callee = unwrap(call.expression);
    if (isStore(callee)) {
      const selector = selectorFor(call.arguments[0], call);
      if (selector?.parameters.length === 1) {
        const parameter = selector.parameters[0].name;
        for (const member of bindingMembers(parameter, constants, members)) output.push({ kind: "selector-parameter", member });
        if (ts.isIdentifier(parameter) && selector.body) {
          const stateAliases = aliases(selector.body, [parameter.text]);
          for (const access of descendants(selector.body, ts.isPropertyAccessExpression)) {
            const receiver = unwrap(access.expression);
            if (ts.isIdentifier(receiver) && stateAliases.has(receiver.text) && members.has(access.name.text)) {
              output.push({ kind: "selector", member: access.name.text });
            }
          }
          for (const access of descendants(selector.body, ts.isElementAccessExpression)) {
            const receiver = unwrap(access.expression);
            const member = elementName(access, constants);
            if (ts.isIdentifier(receiver) && stateAliases.has(receiver.text) && member && members.has(member)) {
              output.push({ kind: "selector-element", member });
            }
          }
        }
      } else if (call.arguments.length === 0) {
        const consumer = outsideCasts(call);
        if (ts.isVariableDeclaration(consumer)) {
          for (const member of bindingMembers(consumer.name, constants, members)) output.push({ kind: "hook-destructure", member });
        }
        if (ts.isPropertyAccessExpression(consumer) && members.has(consumer.name.text)) output.push({ kind: "hook-direct", member: consumer.name.text });
        if (ts.isElementAccessExpression(consumer)) {
          const member = elementName(consumer, constants);
          if (member && members.has(member)) output.push({ kind: "hook-direct-element", member });
        }
      }
    }

    if (isGet(call)) {
      const consumer = outsideCasts(call);
      if (ts.isVariableDeclaration(consumer)) {
        for (const member of bindingMembers(consumer.name, constants, members)) output.push({ kind: "getState-destructure", member });
      }
      if (ts.isPropertyAccessExpression(consumer) && members.has(consumer.name.text)) output.push({ kind: "getState-direct", member: consumer.name.text });
      if (ts.isElementAccessExpression(consumer)) {
        const member = elementName(consumer, constants);
        if (member && members.has(member)) output.push({ kind: "getState-direct-element", member });
      }
    }

    if (isSet(call) && call.arguments[0]) {
      for (const object of descendants(call.arguments[0], ts.isObjectLiteralExpression)) {
        for (const member of directObjectKeys(object, constants)) {
          if (members.has(member)) output.push({ kind: "setState", member });
        }
      }
    }
  }

  for (const access of descendants(source, ts.isPropertyAccessExpression)) {
    const receiver = unwrap(access.expression);
    if (ts.isIdentifier(receiver) && resolvesToGet(receiver, access) && members.has(access.name.text)) {
      output.push({ kind: "getState-alias", member: access.name.text });
    }
    if (ts.isIdentifier(receiver) && resolvesToWholeHook(receiver, access) && members.has(access.name.text)) {
      output.push({ kind: "hook-alias", member: access.name.text });
    }
  }
  for (const access of descendants(source, ts.isElementAccessExpression)) {
    const receiver = unwrap(access.expression);
    const member = elementName(access, constants);
    if (ts.isIdentifier(receiver) && resolvesToGet(receiver, access) && member && members.has(member)) {
      output.push({ kind: "getState-alias-element", member });
    }
    if (ts.isIdentifier(receiver) && resolvesToWholeHook(receiver, access) && member && members.has(member)) {
      output.push({ kind: "hook-alias-element", member });
    }
  }
  for (const declaration of descendants(source, ts.isVariableDeclaration)) {
    if (!declaration.initializer || !ts.isIdentifier(unwrap(declaration.initializer))) continue;
    const initializer = unwrap(declaration.initializer) as ts.Identifier;
    if (!resolvesToWholeHook(initializer, declaration)) continue;
    for (const member of bindingMembers(declaration.name, constants, members)) {
      output.push({ kind: "hook-alias-destructure", member });
    }
  }
  return output;
}

function findVariable(source: ts.SourceFile, name: string): ts.VariableDeclaration {
  const matches = descendants(source, (node): node is ts.VariableDeclaration =>
    ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name);
  expect(matches, `${name} declaration`).toHaveLength(1);
  return matches[0];
}

function findInterface(source: ts.SourceFile, name: string): ts.InterfaceDeclaration {
  const matches = descendants(source, (node): node is ts.InterfaceDeclaration =>
    ts.isInterfaceDeclaration(node) && node.name.text === name);
  expect(matches, `${name} interface`).toHaveLength(1);
  return matches[0];
}

function interfaceKeys(declaration: ts.InterfaceDeclaration): string[] {
  return declaration.members
    .map((member) => "name" in member ? staticName(member.name) : null)
    .filter((name): name is string => name !== null);
}

function findStoreObject(source: ts.SourceFile, name: string): ts.ObjectLiteralExpression {
  const declaration = findVariable(source, name);
  expect(declaration.initializer && ts.isCallExpression(declaration.initializer)).toBe(true);
  const factory = (declaration.initializer as ts.CallExpression).arguments[0];
  expect(factory && (ts.isArrowFunction(factory) || ts.isFunctionExpression(factory))).toBe(true);
  const body = (factory as ts.ArrowFunction | ts.FunctionExpression).body;
  const expression = ts.isExpression(body) ? unwrap(body) : body;
  expect(ts.isObjectLiteralExpression(expression)).toBe(true);
  return expression as ts.ObjectLiteralExpression;
}

function directProperty(object: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralElementLike {
  const matches = object.properties.filter((property) => "name" in property && staticName(property.name) === name);
  expect(matches, `${name} property`).toHaveLength(1);
  return matches[0];
}

function propertyInitializer(object: ts.ObjectLiteralExpression, name: string): ts.Expression {
  const property = directProperty(object, name);
  expect(ts.isPropertyAssignment(property), `${name} explicit default`).toBe(true);
  return (property as ts.PropertyAssignment).initializer;
}

function importedCallCount(source: ts.SourceFile, modules: readonly string[], importedName: string): number {
  const seeds = modules.flatMap((moduleName) => [...importedLocalNames(source, moduleName, importedName)]);
  const names = aliases(source, seeds);
  return descendants(source, ts.isCallExpression).filter((call) => {
    const expression = unwrap(call.expression);
    return ts.isIdentifier(expression) && names.has(expression.text);
  }).length;
}

function importedSelectorUseCount(
  source: ts.SourceFile,
  owner: { readonly module: string; readonly exportName: string },
  selectorModule: string,
  selectorName: string,
): number {
  const hooks = aliases(source, importedLocalNames(source, owner.module, owner.exportName));
  const selectors = aliases(source, importedLocalNames(source, selectorModule, selectorName));
  return descendants(source, ts.isCallExpression).filter((call) => {
    const callee = unwrap(call.expression);
    const selector = call.arguments[0] && unwrap(call.arguments[0]);
    return ts.isIdentifier(callee) && hooks.has(callee.text) &&
      !!selector && ts.isIdentifier(selector) && selectors.has(selector.text);
  }).length;
}

function callTopology(importedName: string): Record<string, number> {
  const modules = [VIEWER_OWNER.module, TOOL_OWNER.module];
  return Object.fromEntries(productionSourceFiles
    .filter((path) => modules.some((moduleName) => textOf(path).includes(moduleName)))
    .map((path) => [path, importedCallCount(parse(path), modules, importedName)] as const)
    .filter(([, count]) => count > 0));
}

function hookShape(name: string, firstMember: string, ownerFile: string): string[] {
  const declarations = descendants(parse(ownerFile), (node): node is ts.VariableDeclaration =>
    ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name)
    .map((declaration) => ({ source: parse(ownerFile), declaration }));
  expect(declarations, `${name} owner`).toHaveLength(1);
  const { source, declaration } = declarations[0];
  const objects = descendants(declaration, ts.isObjectLiteralExpression)
    .filter((object) => directObjectKeys(object).includes(firstMember));
  expect(objects, `${name} selector object`).toHaveLength(1);
  return directObjectKeys(objects[0]);
}

function primitiveSelectorMembers(
  source: ts.SourceFile,
  owner: { readonly module: string; readonly exportName: string },
): string[] {
  const hooks = aliases(source, importedLocalNames(source, owner.module, owner.exportName));
  const approvedImportedSelectors = aliases(
    source,
    importedLocalNames(source, ACTIVE_TOOL_STATE_MODULE, "selectActiveToolKey"),
  );
  const constants = staticStrings(source);
  const output: string[] = [];
  for (const call of descendants(source, ts.isCallExpression)) {
    const callee = unwrap(call.expression);
    if (!ts.isIdentifier(callee) || !hooks.has(callee.text)) continue;
    const selectorArg = call.arguments[0] && unwrap(call.arguments[0]);
    if (
      selectorArg && ts.isIdentifier(selectorArg) &&
      approvedImportedSelectors.has(selectorArg.text)
    ) continue;
    expect(call.arguments, `one selector at ${call.getStart(source)}`).toHaveLength(1);
    const selector = selectorFunction(source, call.arguments[0]);
    expect(selector, `resolvable selector at ${call.getStart(source)}`).not.toBeNull();
    if (!selector) continue;
    expect(selector.parameters, `one selector parameter at ${call.getStart(source)}`).toHaveLength(1);
    expect(ts.isIdentifier(selector.parameters[0].name)).toBe(true);
    if (selector.parameters.length !== 1 || !ts.isIdentifier(selector.parameters[0].name)) continue;
    if (!selector.body) throw new Error(`Selector at ${call.getStart(source)} has no body`);
    const selectorBody = selector.body;
    const stateAliases = aliases(selectorBody, [selector.parameters[0].name.text]);
    const selected = [
      ...descendants(selectorBody, ts.isPropertyAccessExpression)
        .filter((access) => {
          const receiver = unwrap(access.expression);
          return ts.isIdentifier(receiver) && stateAliases.has(receiver.text);
        }).map((access) => access.name.text),
      ...descendants(selectorBody, ts.isElementAccessExpression)
        .filter((access) => {
          const receiver = unwrap(access.expression);
          return ts.isIdentifier(receiver) && stateAliases.has(receiver.text);
        }).map((access) => elementName(access, constants)).filter((name): name is string => name !== null),
    ];
    expect(selected, `primitive selector at ${call.getStart(source)}`).toHaveLength(1);
    expect(selected[0], `whole activeTool selector at ${call.getStart(source)}`).not.toBe("activeTool");
    const returned = ts.isBlock(selectorBody)
      ? descendants(selectorBody, ts.isReturnStatement).map((statement) => statement.expression)
          .filter((value): value is ts.Expression => value !== undefined)
      : [selectorBody];
    expect(returned, `selector return at ${call.getStart(source)}`).not.toHaveLength(0);
    for (const expression of returned) {
      const value = unwrap(expression);
      expect(
        ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value),
        `non-primitive selector return at ${call.getStart(source)}`,
      ).toBe(false);
      expect(
        ts.isIdentifier(value) && stateAliases.has(value.text),
        `whole-state selector return at ${call.getStart(source)}`,
      ).toBe(false);
    }
    output.push(selected[0]);
  }
  return output;
}

function functionDeclaration(source: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const matches = descendants(source, (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === name);
  expect(matches, `${name} function`).toHaveLength(1);
  return matches[0];
}

describe("P2.3 T2 flat tool ownership", () => {
  const viewerSource = parse(VIEWER_STORE_FILE);
  const parseSource = parse(PARSE_STORE_FILE);
  const toolSource = parse(TOOL_STORE_FILE);
  const viewerInterfaceKeys = interfaceKeys(findInterface(viewerSource, "ViewerState"));
  const parseInterfaceKeys = interfaceKeys(findInterface(parseSource, "ParseFlowState"));
  const viewerObject = findStoreObject(viewerSource, "useViewerStore");
  const parseObject = findStoreObject(parseSource, "useParseFlowStore");
  const toolInterfaceKeys = [
    ...interfaceKeys(findInterface(toolSource, "ToolStoreData")),
    ...interfaceKeys(findInterface(toolSource, "ToolStoreActions")),
  ];
  const toolObject = findStoreObject(toolSource, "useToolStore");

  it("pins exactly 36 data fields, 43 commands plus one reset, and the active sole owner", () => {
    expect(Object.keys(TOOL_CONTRACT)).toHaveLength(36);
    expect(TOOL_ACTIONS).toHaveLength(44);
    expect(new Set(TOOL_ACTIONS).size).toBe(44);

    for (const [field, contract] of Object.entries(TOOL_CONTRACT)) {
      expect(toolInterfaceKeys, `${field} active interface owner`).toContain(field);
      expect(viewerInterfaceKeys, `${field} deleted viewer interface owner`).not.toContain(field);
      expect(compact(propertyInitializer(toolObject, field), toolSource), `${field} default`)
        .toBe(contract.default);
      expect(() => directProperty(viewerObject, field)).toThrow();
    }
    for (const action of TOOL_ACTIONS) {
      expect(toolInterfaceKeys, `${action} active interface owner`).toContain(action);
      expect(viewerInterfaceKeys, `${action} deleted viewer interface owner`).not.toContain(action);
      expect(() => directProperty(toolObject, action)).not.toThrow();
      expect(() => directProperty(viewerObject, action)).toThrow();
    }

    for (const field of LEGACY_ACTIVATION_FIELDS) {
      expect(toolInterfaceKeys, `${field} deleted stored field`).not.toContain(field);
      expect(() => directProperty(toolObject, field)).toThrow();
      expect(TOOL_CONTRACT).not.toHaveProperty(field);
    }
  });

  it("keeps every boundary exclusion out of toolStore and pins its exact S2 owner", () => {
    const exclusions = Object.values(BOUNDARY_EXCLUSIONS).flat();
    expect(new Set(exclusions).size).toBe(exclusions.length);
    for (const member of exclusions) {
      expect(TOOL_MEMBERS, `${member} excluded`).not.toContain(member);
    }

    const viewerOwned = [
      ...BOUNDARY_EXCLUSIONS.serverMetadata,
      ...BOUNDARY_EXCLUSIONS.mutableServerDraft,
      ...BOUNDARY_EXCLUSIONS.drawingQuarantine,
    ];
    for (const member of viewerOwned) {
      expect(viewerInterfaceKeys, `${member} remains residual viewer-owned`).toContain(member);
      expect(() => directProperty(viewerObject, member)).not.toThrow();
      expect(parseInterfaceKeys, `${member} excluded from parse owner`).not.toContain(member);
      expect(() => directProperty(parseObject, member)).toThrow();
    }

    for (const member of BOUNDARY_EXCLUSIONS.parseFlow) {
      expect(viewerInterfaceKeys, `${member} deleted from residual viewer`).not.toContain(member);
      expect(() => directProperty(viewerObject, member)).toThrow();
      expect(parseInterfaceKeys, `${member} present on parse owner`).toContain(member);
      expect(() => directProperty(parseObject, member)).not.toThrow();
    }

    for (const member of BOUNDARY_EXCLUSIONS.neutralReset) {
      expect(viewerInterfaceKeys, `${member} deleted from viewer`).not.toContain(member);
      expect(() => directProperty(viewerObject, member)).toThrow();
      expect(parseInterfaceKeys, `${member} excluded from parse leaf`).not.toContain(member);
      expect(() => directProperty(parseObject, member)).toThrow();
      expect(textOf("src/stores/viewerCommands.ts")).toMatch(/export function resetAllTools\(/);
    }
  });

  it("has active production toolStore consumers", () => {
    expect(productionSourceFiles.filter((path) => textOf(path).includes(TOOL_OWNER.module)).length)
      .toBeGreaterThan(0);
  });
});

describe("P2.3 T2 grouped tool surfaces", () => {
  it("pins the exact 23-member derived useSymbolSearch hook and its three callers", () => {
    expect(hookShape("useSymbolSearch", "symbolSearchActive", ACTIVE_TOOL_OWNER.file))
      .toEqual(SYMBOL_HOOK_SHAPE);
    expect(callTopology("useSymbolSearch")).toEqual(SYMBOL_HOOK_CALLERS);

    const source = parse(ACTIVE_TOOL_OWNER.file);
    const declaration = findVariable(source, "useSymbolSearch");
    const selectorObjects = descendants(declaration, ts.isObjectLiteralExpression)
      .filter((object) => directObjectKeys(object).includes("symbolSearchActive"));
    expect(selectorObjects).toHaveLength(1);
    expect(compact(propertyInitializer(selectorObjects[0], "symbolSearchActive"), source))
      .toBe('state.activeTool?.kind==="symbolTemplate"');
  });

  it("pins useYoloTags' exact six-member tool projection on the active owner", () => {
    const source = parse(YOLO_FACADE);
    const declaration = functionDeclaration(source, "useYoloTags");
    const objects = descendants(declaration, ts.isObjectLiteralExpression)
      .filter((object) => directObjectKeys(object).includes("yoloTagPickingMode"));
    expect(objects).toHaveLength(1);
    expect(directObjectKeys(objects[0])).toEqual(YOLO_TOOL_PROJECTION);
    expect(compact(propertyInitializer(objects[0], "yoloTagPickingMode"), source))
      .toBe('selectActiveToolKey(state)==="tagPick"');
    expect(compact(propertyInitializer(objects[0], "tagAddingMode"), source))
      .toBe("selectActiveTagId(state)");
    expect(storeMemberAccesses(source, ACTIVE_TOOL_OWNER, new Set(YOLO_TOOL_PROJECTION))
      .filter((access) => access.kind.startsWith("selector"))
      .map((access) => access.member)).toEqual(YOLO_DIRECT_TOOL_PROJECTION);
    expect(importedCallCount(source, [ACTIVE_TOOL_STATE_MODULE], "selectActiveToolKey")).toBe(1);
    expect(importedCallCount(source, [ACTIVE_TOOL_STATE_MODULE], "selectActiveTagId")).toBe(1);
  });

  it("keeps useDrawingState production-dead", () => {
    expect(callTopology("useDrawingState")).toEqual({});
    expect(hookShape("useDrawingState", "_drawing", VIEWER_STORE_FILE)).toEqual([
      "_drawing", "_drawStart", "_drawEnd", "_mousePos",
      "_setDrawing", "_setDrawStart", "_setDrawEnd", "_setMousePos",
    ]);
  });
});

describe("P2.3 T2 sacred canvas subscription topology", () => {
  it("pins AnnotationOverlay's 19 direct primitives plus one derived hot discriminator", () => {
    const source = parse(ANNOTATION_OVERLAY);
    const raw = primitiveSelectorMembers(source, ACTIVE_TOOL_OWNER)
      .filter((member) => TOOL_MEMBERS.has(member));
    expect(raw).toEqual(ANNOTATION_TOOL_PRIMITIVES);
    expect(importedCallCount(source, [VIEWER_OWNER.module, TOOL_OWNER.module], "useSymbolSearch")).toBe(0);
    expect(importedSelectorUseCount(
      source, ACTIVE_TOOL_OWNER, ACTIVE_TOOL_STATE_MODULE, "selectActiveToolKey",
    )).toBe(1);
  });

  it("pins DrawingPreviewLayer's 4 drawing + 17 tool + one hot key + 4 parse split", () => {
    const source = parse(DRAWING_PREVIEW);
    const toolRaw = primitiveSelectorMembers(source, ACTIVE_TOOL_OWNER);
    const viewerRaw = primitiveSelectorMembers(source, VIEWER_OWNER);
    const parseRaw = primitiveSelectorMembers(source, PARSE_OWNER);
    expect(toolRaw.filter((member) => TOOL_MEMBERS.has(member))).toEqual(PREVIEW_TOOL_PRIMITIVES);
    expect(importedSelectorUseCount(
      source, ACTIVE_TOOL_OWNER, ACTIVE_TOOL_STATE_MODULE, "selectActiveToolKey",
    )).toBe(1);
    expect(viewerRaw).toEqual(DRAWING_DATA);
    expect(parseRaw).toEqual(PREVIEW_PARSE_DATA);
    expect(importedCallCount(source, ["@/stores/uiStore"], "useUiStore")).toBe(0);

    const imperative = storeMemberAccesses(source, ACTIVE_TOOL_OWNER, TOOL_MEMBERS)
      .filter((access) => access.kind.startsWith("getState"))
      .map((access) => access.member)
      .sort();
    expect(imperative).toEqual([...PREVIEW_IMPERATIVE_TOOL_READS].sort());
  });
});

describe("P2.3 T2 owner access oracle", () => {
  it("self-calibrates aliases, casts, computed selectors, getState, and setState", () => {
    const fixture = ts.createSourceFile(
      "tool-owner-fixture.tsx",
      `
        import { ${ACTIVE_TOOL_OWNER.exportName} as importedStore } from "${ACTIVE_TOOL_OWNER.module}";
        import * as StoreNamespace from "${ACTIVE_TOOL_OWNER.module}";
        const storeAlias = importedStore as any;
        const computed = "symbolSearchConfig";
        const exportName = "${ACTIVE_TOOL_OWNER.exportName}";
        const selectPreset = (state: any) => state.symbolSearchPreset;
        function selectLoading(state: any) { return state.bucketFillLoading; }
        storeAlias(({ mode }: any) => mode);
        storeAlias(useShallow((state: any) => state[computed]));
        StoreNamespace[exportName](selectPreset);
        const { ${ACTIVE_TOOL_OWNER.exportName}: destructuredStore } = StoreNamespace;
        destructuredStore(selectLoading);
        const getter = storeAlias["getState"];
        const { setMode } = getter() as any;
        const snapshot = getter() as any;
        snapshot["activeTool"];
        const setter = importedStore.setState;
        setter({ [computed]: {} });
        (storeAlias() as any).clearSymbolSearch;
        const wholeHook = (StoreNamespace.${ACTIVE_TOOL_OWNER.exportName} as any)();
        const wholeHookAlias = wholeHook as any;
        wholeHookAlias.bucketFillError;
        const { symbolSearchSourcePage } = wholeHookAlias;
        const namespaceGetter = StoreNamespace.${ACTIVE_TOOL_OWNER.exportName}.getState;
        namespaceGetter().tempPanMode;
      `,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const accesses = storeMemberAccesses(fixture, ACTIVE_TOOL_OWNER, TOOL_MEMBERS)
      .map((access) => `${access.kind}:${access.member}`);
    expect(accesses).toEqual(expect.arrayContaining([
      "selector-parameter:mode", "selector-element:symbolSearchConfig",
      "selector:symbolSearchPreset", "selector:bucketFillLoading",
      "getState-destructure:setMode", "getState-alias-element:activeTool",
      "setState:symbolSearchConfig", "hook-direct:clearSymbolSearch",
      "hook-alias:bucketFillError", "hook-alias-destructure:symbolSearchSourcePage",
      "getState-direct:tempPanMode",
    ]));
  });

  it("finds every proposed member on the active owner and zero inactive-owner production/test escapes", () => {
    expect(ownerAuditSourceFiles).toContain("src/test/viewer-store-state.ts");
    const plausible = ownerAuditSourceFiles.filter((path) => {
      const text = textOf(path);
      return text.includes(VIEWER_OWNER.module) || text.includes(TOOL_OWNER.module);
    });
    const active = plausible.flatMap((path) =>
      storeMemberAccesses(parse(path), ACTIVE_TOOL_OWNER, TOOL_MEMBERS));
    const inactive = plausible.flatMap((path) =>
      storeMemberAccesses(parse(path), INACTIVE_TOOL_OWNER, TOOL_MEMBERS)
        .map((access) => `${path}:${access.kind}:${access.member}`));

    const directlyAccessed = new Set(active.map((access) => access.member));
    expect(new Set([...directlyAccessed, ...GROUPED_OR_UNUSED_TOOL_MEMBERS])).toEqual(TOOL_MEMBERS);
    expect(inactive).toEqual([]);
  }, 60_000);
});
