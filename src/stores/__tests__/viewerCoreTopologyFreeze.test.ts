// @vitest-environment node
// [refactor jul11 P2.3 V2] Post-flip ownership/topology gate for pure viewer geometry.
// Runtime parity lives in viewerCoreFreeze/viewerCoreStore.test; this source contract keeps the
// live ownership auditable through aliases, casts, computed keys, and imperative access.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const VIEWER_STORE_FILE = "src/stores/viewerStore.ts";
const CORE_STORE_FILE = "src/stores/viewerCoreStore.ts";
const TOOL_STORE_FILE = "src/stores/toolStore.ts";

const VIEWER_OWNER = {
  file: VIEWER_STORE_FILE,
  module: "@/stores/viewerStore",
  exportName: "useViewerStore",
} as const;
const CORE_OWNER = {
  file: CORE_STORE_FILE,
  module: "@/stores/viewerCoreStore",
  exportName: "useViewerCoreStore",
} as const;
const TOOL_OWNER = {
  file: TOOL_STORE_FILE,
  module: "@/stores/toolStore",
  exportName: "useToolStore",
} as const;

const ACTIVE_CORE_OWNER = CORE_OWNER;
const INACTIVE_CORE_OWNER = VIEWER_OWNER;

const CORE_DATA_CONTRACT = {
  pageNumber: "1",
  numPages: "0",
  scale: "1",
  pendingCenter: "false",
  pageDimensions: "{}",
} as const;

const CORE_ACTIONS = [
  "setPage",
  "setNumPages",
  "zoomIn",
  "zoomOut",
  "zoomFit",
  "clearPendingCenter",
  "setScale",
  "setPageDimensions",
] as const;

const CORE_MEMBER_NAMES = new Set<string>([
  ...Object.keys(CORE_DATA_CONTRACT),
  ...CORE_ACTIONS,
]);

const CORE_BOUNDARY_EXCLUSIONS = [
  "mode",
  "setMode",
  "tempPanMode",
  "setTempPanMode",
  "scaleCalibrations",
  "setScaleCalibration",
] as const;

const CURRENT_NAVIGATION_SHAPE = [
  "pageNumber",
  "numPages",
  "setPage",
  "setNumPages",
] as const;

const CURRENT_NAVIGATION_CALL_TOPOLOGY: Record<string, number> = {
  "src/components/viewer/AutoParseTab.tsx": 2,
  "src/components/viewer/ChatPanel.tsx": 1,
  "src/components/viewer/CompareEditTab.tsx": 1,
  "src/components/viewer/CsiPanel.tsx": 1,
  "src/components/viewer/DetectionPanel.tsx": 1,
  "src/components/viewer/GuidedParseTab.tsx": 1,
  "src/components/viewer/KeynoteOverlay.tsx": 1,
  "src/components/viewer/ManualParseTab.tsx": 1,
  "src/components/viewer/PDFViewer.tsx": 1,
  "src/components/viewer/PageIntelligencePanel.tsx": 1,
  "src/components/viewer/PageSidebar.tsx": 1,
  "src/components/viewer/SymbolSearchPanel.tsx": 1,
  "src/components/viewer/TextPanel.tsx": 2,
  "src/components/viewer/ViewerToolbar.tsx": 1,
  "src/hooks/useShapeParseInteraction.ts": 1,
};

const textCache = new Map<string, string>();
const sourceCache = new Map<string, ts.SourceFile>();

function textOf(relativePath: string): string {
  const cached = textCache.get(relativePath);
  if (cached !== undefined) return cached;
  const text = readFileSync(join(process.cwd(), relativePath), "utf8");
  textCache.set(relativePath, text);
  return text;
}

function parse(relativePath: string): ts.SourceFile {
  const cached = sourceCache.get(relativePath);
  if (cached) return cached;
  const source = ts.createSourceFile(
    relativePath,
    textOf(relativePath),
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  sourceCache.set(relativePath, source);
  return source;
}

function productionFiles(relativeDirectory = "src"): string[] {
  const output: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(join(process.cwd(), directory), { withFileTypes: true })) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") visit(child);
      } else if (
        /\.(?:ts|tsx)$/.test(entry.name) &&
        !/\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name) &&
        !entry.name.endsWith(".d.ts") &&
        !child.startsWith("src/test/")
      ) {
        output.push(child);
      }
    }
  };
  visit(relativeDirectory);
  return output.sort();
}

const productionSourceFiles = productionFiles();

function descendants<T extends ts.Node>(
  root: ts.Node,
  predicate: (node: ts.Node) => node is T,
): T[] {
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
        : ts.isIdentifier(initializer)
          ? constants.get(initializer.text)
          : undefined;
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
  constants: ReadonlyMap<string, string> = new Map(),
): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (!ts.isComputedPropertyName(name)) return null;
  const expression = unwrap(name.expression);
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  return ts.isIdentifier(expression) ? constants.get(expression.text) ?? null : null;
}

function elementName(
  access: ts.ElementAccessExpression,
  constants: ReadonlyMap<string, string>,
): string | null {
  const argument = access.argumentExpression && unwrap(access.argumentExpression);
  if (!argument) return null;
  if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
    return argument.text;
  }
  return ts.isIdentifier(argument) ? constants.get(argument.text) ?? null : null;
}

function directObjectKeys(
  object: ts.ObjectLiteralExpression,
  constants: ReadonlyMap<string, string> = new Map(),
): string[] {
  return object.properties
    .map((property) => ("name" in property ? staticName(property.name, constants) : null))
    .filter((name): name is string => name !== null);
}

function importedLocalNames(
  source: ts.SourceFile,
  moduleName: string,
  importedName: string,
): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== moduleName
    ) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === importedName) names.add(element.name.text);
    }
  }
  return names;
}

function identifierAliases(root: ts.Node, seeds: Iterable<string>): Set<string> {
  const aliases = new Set(seeds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of descendants(root, ts.isVariableDeclaration)) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const initializer = unwrap(declaration.initializer);
      if (ts.isIdentifier(initializer) && aliases.has(initializer.text) && !aliases.has(declaration.name.text)) {
        aliases.add(declaration.name.text);
        changed = true;
      }
    }
  }
  return aliases;
}

function memberName(
  expression: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  constants: ReadonlyMap<string, string>,
): string | null {
  return ts.isPropertyAccessExpression(expression)
    ? expression.name.text
    : elementName(expression, constants);
}

function methodAliases(
  source: ts.SourceFile,
  stores: ReadonlySet<string>,
  method: "getState" | "setState",
  constants: ReadonlyMap<string, string>,
): Set<string> {
  const seeds = new Set<string>();
  for (const declaration of descendants(source, ts.isVariableDeclaration)) {
    if (!declaration.initializer) continue;
    const initializer = unwrap(declaration.initializer);
    if (
      ts.isIdentifier(declaration.name) &&
      (ts.isPropertyAccessExpression(initializer) || ts.isElementAccessExpression(initializer))
    ) {
      const receiver = unwrap(initializer.expression);
      if (ts.isIdentifier(receiver) && stores.has(receiver.text) && memberName(initializer, constants) === method) {
        seeds.add(declaration.name.text);
      }
    }
  }
  return identifierAliases(source, seeds);
}

function isStoreMethodCall(
  call: ts.CallExpression,
  stores: ReadonlySet<string>,
  functions: ReadonlySet<string>,
  method: "getState" | "setState",
  constants: ReadonlyMap<string, string>,
): boolean {
  const expression = unwrap(call.expression);
  if (ts.isIdentifier(expression)) return functions.has(expression.text);
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) return false;
  const receiver = unwrap(expression.expression);
  return ts.isIdentifier(receiver) &&
    stores.has(receiver.text) &&
    memberName(expression, constants) === method;
}

function selectorFunction(
  expression: ts.Expression | undefined,
): ts.ArrowFunction | ts.FunctionExpression | null {
  if (!expression) return null;
  const current = unwrap(expression);
  if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) return current;
  if (ts.isCallExpression(current)) {
    for (const argument of current.arguments) {
      const nested = selectorFunction(argument);
      if (nested) return nested;
    }
  }
  return null;
}

function bindingNames(
  binding: ts.BindingName,
  constants: ReadonlyMap<string, string>,
  members: ReadonlySet<string>,
): string[] {
  if (!ts.isObjectBindingPattern(binding)) return [];
  return binding.elements
    .map((element) => staticName(element.propertyName ?? element.name, constants))
    .filter((name): name is string => !!name && members.has(name));
}

function outsideCasts(expression: ts.Expression): ts.Node {
  let current: ts.Expression = expression;
  while (
    current.parent &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent)) &&
    current.parent.expression === current
  ) current = current.parent;
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
  const stores = identifierAliases(
    source,
    importedLocalNames(source, owner.module, owner.exportName),
  );
  const getters = methodAliases(source, stores, "getState", constants);
  const setters = methodAliases(source, stores, "setState", constants);
  const isGet = (call: ts.CallExpression) =>
    isStoreMethodCall(call, stores, getters, "getState", constants);
  const isSet = (call: ts.CallExpression) =>
    isStoreMethodCall(call, stores, setters, "setState", constants);

  const declarations = descendants(source, ts.isVariableDeclaration)
    .filter((declaration) => ts.isIdentifier(declaration.name));
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
  const resolvesToGet = (identifier: ts.Identifier, at: ts.Node, seen = new Set<ts.Node>()): boolean => {
    const declaration = declarationFor(identifier.text, at);
    if (!declaration || seen.has(declaration) || !declaration.initializer) return false;
    seen.add(declaration);
    const initializer = unwrap(declaration.initializer);
    if (ts.isCallExpression(initializer)) return isGet(initializer);
    return ts.isIdentifier(initializer) ? resolvesToGet(initializer, declaration, seen) : false;
  };

  for (const call of descendants(source, ts.isCallExpression)) {
    const callee = unwrap(call.expression);
    if (ts.isIdentifier(callee) && stores.has(callee.text)) {
      const selector = selectorFunction(call.arguments[0]);
      if (selector?.parameters.length === 1) {
        const parameter = selector.parameters[0].name;
        for (const member of bindingNames(parameter, constants, members)) {
          output.push({ kind: "selector-parameter", member });
        }
        if (ts.isIdentifier(parameter)) {
          const stateAliases = identifierAliases(selector.body, [parameter.text]);
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
      } else {
        const consumer = outsideCasts(call);
        if (ts.isVariableDeclaration(consumer)) {
          for (const member of bindingNames(consumer.name, constants, members)) {
            output.push({ kind: "hook-destructure", member });
          }
        }
        if (ts.isPropertyAccessExpression(consumer) && members.has(consumer.name.text)) {
          output.push({ kind: "hook-direct", member: consumer.name.text });
        }
      }
    }

    if (isGet(call)) {
      const consumer = outsideCasts(call);
      if (ts.isVariableDeclaration(consumer)) {
        for (const member of bindingNames(consumer.name, constants, members)) {
          output.push({ kind: "getState-destructure", member });
        }
      }
      if (ts.isPropertyAccessExpression(consumer) && members.has(consumer.name.text)) {
        output.push({ kind: "getState-direct", member: consumer.name.text });
      }
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
  }
  for (const access of descendants(source, ts.isElementAccessExpression)) {
    const receiver = unwrap(access.expression);
    const member = elementName(access, constants);
    if (ts.isIdentifier(receiver) && resolvesToGet(receiver, access) && member && members.has(member)) {
      output.push({ kind: "getState-alias-element", member });
    }
  }
  return output;
}

function findVariable(source: ts.SourceFile, name: string): ts.VariableDeclaration {
  const matches = descendants(
    source,
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name,
  );
  expect(matches, `${name} declaration`).toHaveLength(1);
  return matches[0];
}

function findInterface(source: ts.SourceFile, name: string): ts.InterfaceDeclaration {
  const matches = descendants(
    source,
    (node): node is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(node) && node.name.text === name,
  );
  expect(matches, `${name} interface`).toHaveLength(1);
  return matches[0];
}

function interfaceKeys(declaration: ts.InterfaceDeclaration): string[] {
  return declaration.members
    .map((member) => ("name" in member ? staticName(member.name) : null))
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

function findFunctionReturnObject(source: ts.SourceFile, name: string): ts.ObjectLiteralExpression {
  const functions = descendants(
    source,
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  expect(functions, `${name} function`).toHaveLength(1);
  const objects = descendants(functions[0], ts.isReturnStatement)
    .map((statement) => statement.expression && unwrap(statement.expression))
    .filter((expression): expression is ts.ObjectLiteralExpression =>
      !!expression && ts.isObjectLiteralExpression(expression),
    );
  expect(objects, `${name} return object`).toHaveLength(1);
  return objects[0];
}

function directProperty(object: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralElementLike {
  const matches = object.properties.filter(
    (property) => "name" in property && staticName(property.name) === name,
  );
  expect(matches, `${name} property`).toHaveLength(1);
  return matches[0];
}

function propertyInitializer(object: ts.ObjectLiteralExpression, name: string): ts.Expression {
  const property = directProperty(object, name);
  expect(ts.isPropertyAssignment(property), `${name} explicit default`).toBe(true);
  return (property as ts.PropertyAssignment).initializer;
}

function importedCallCount(
  source: ts.SourceFile,
  modules: readonly string[],
  importedName: string,
): number {
  const seeds = modules.flatMap((moduleName) => [
    ...importedLocalNames(source, moduleName, importedName),
  ]);
  const aliases = identifierAliases(source, seeds);
  return descendants(source, ts.isCallExpression).filter((call) => {
    const expression = unwrap(call.expression);
    return ts.isIdentifier(expression) && aliases.has(expression.text);
  }).length;
}

describe("P2.3 V2 viewerCore ownership", () => {
  const viewerSource = parse(VIEWER_STORE_FILE);
  const coreSource = parse(CORE_STORE_FILE);
  const toolSource = parse(TOOL_STORE_FILE);
  const viewerInterface = findInterface(viewerSource, "ViewerState");
  const coreData = findInterface(coreSource, "ViewerCoreData");
  const coreActions = findInterface(coreSource, "ViewerCoreActions");
  const toolData = findInterface(toolSource, "ToolStoreData");
  const toolActions = findInterface(toolSource, "ToolStoreActions");
  const viewerKeys = interfaceKeys(viewerInterface);
  const coreDataKeys = interfaceKeys(coreData);
  const coreActionKeys = interfaceKeys(coreActions);
  const toolKeys = [...interfaceKeys(toolData), ...interfaceKeys(toolActions)];
  const viewerObject = findStoreObject(viewerSource, "useViewerStore");
  const coreObject = findStoreObject(coreSource, "useViewerCoreStore");
  const toolObject = findStoreObject(toolSource, "useToolStore");
  const coreDefaults = findFunctionReturnObject(coreSource, "freshViewerCoreState");
  const coreReset = findFunctionReturnObject(coreSource, "freshViewerCoreReset");

  it("pins the exact five data fields, eight actions, reset, and deleted viewer definitions", () => {
    expect(coreDataKeys).toEqual(Object.keys(CORE_DATA_CONTRACT));
    expect(coreActionKeys).toEqual([...CORE_ACTIONS, "resetViewerCoreState"]);

    for (const [field, expected] of Object.entries(CORE_DATA_CONTRACT)) {
      expect(viewerKeys, `${field} deleted viewer interface`).not.toContain(field);
      expect(directObjectKeys(viewerObject), `${field} deleted viewer default`).not.toContain(field);
      expect(compact(propertyInitializer(coreDefaults, field), coreSource), `${field} core default`)
        .toBe(expected);
    }
    for (const action of CORE_ACTIONS) {
      expect(viewerKeys, `${action} deleted viewer interface`).not.toContain(action);
      expect(directObjectKeys(viewerObject), `${action} deleted viewer action`).not.toContain(action);
      expect(() => directProperty(coreObject, action)).not.toThrow();
    }
    expect(() => directProperty(coreObject, "resetViewerCoreState")).not.toThrow();
  });

  it("pins the four-field core reset and rejects core keys in residual viewer reset", () => {
    expect(directObjectKeys(coreReset)).toEqual([
      "pageNumber",
      "numPages",
      "scale",
      "pageDimensions",
    ]);
    expect(compact(propertyInitializer(coreReset, "pageNumber"), coreSource)).toBe("1");
    expect(compact(propertyInitializer(coreReset, "numPages"), coreSource)).toBe("0");
    expect(compact(propertyInitializer(coreReset, "scale"), coreSource)).toBe("1");
    expect(compact(propertyInitializer(coreReset, "pageDimensions"), coreSource)).toBe("{}");
    expect(directObjectKeys(coreReset)).not.toContain("pendingCenter");

    const resetProperty = directProperty(viewerObject, "resetViewerState");
    expect(ts.isPropertyAssignment(resetProperty)).toBe(true);
    const patches = descendants(
      (resetProperty as ts.PropertyAssignment).initializer,
      ts.isObjectLiteralExpression,
    );
    const resetKeys = patches.flatMap((object) => directObjectKeys(object));
    for (const member of Object.keys(CORE_DATA_CONTRACT)) {
      expect(resetKeys, `${member} absent from residual viewer reset`).not.toContain(member);
    }
  });

  it("keeps tool interaction and calibration state outside the live core", () => {
    const coreKeys = new Set([...coreDataKeys, ...coreActionKeys]);
    for (const member of CORE_BOUNDARY_EXCLUSIONS) {
      expect(toolKeys, `${member} remains on tool owner`).toContain(member);
      expect(() => directProperty(toolObject, member)).not.toThrow();
      expect(viewerKeys, `${member} deleted viewer owner`).not.toContain(member);
      expect(directObjectKeys(viewerObject), `${member} deleted viewer implementation`).not.toContain(member);
      expect(coreKeys, `${member} excluded from viewerCore`).not.toContain(member);
      expect(directObjectKeys(coreDefaults), `${member} absent from core defaults`).not.toContain(member);
      expect(directObjectKeys(coreObject), `${member} absent from core actions`).not.toContain(member);
    }
  });

  it("keeps viewerCore a dependency-free leaf", () => {
    const imports = coreSource.statements
      .filter(ts.isImportDeclaration)
      .map((statement) => statement.moduleSpecifier)
      .filter(ts.isStringLiteral)
      .map((module) => module.text);
    expect(imports).toContain("zustand");
    for (const moduleName of imports) {
      expect(["zustand", "zustand/react/shallow", "@/types"], `core leaf import ${moduleName}`)
        .toContain(moduleName);
    }
  });
});

describe("P2.3 V2 split useNavigation topology", () => {
  it("pins its sole core owner, exact four-member shape, and production call graph", () => {
    const declarations = [VIEWER_STORE_FILE, CORE_STORE_FILE].flatMap((path) => {
      const source = parse(path);
      return descendants(
        source,
        (node): node is ts.VariableDeclaration =>
          ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "useNavigation",
      ).map((declaration) => ({ source, declaration }));
    });
    expect(declarations, "one useNavigation compatibility owner").toHaveLength(1);
    const { source, declaration } = declarations[0];
    const selectorObjects = descendants(declaration, ts.isObjectLiteralExpression)
      .filter((object) => directObjectKeys(object).includes("pageNumber"));
    expect(selectorObjects, "useNavigation selector").toHaveLength(1);
    expect(directObjectKeys(selectorObjects[0])).toEqual(CURRENT_NAVIGATION_SHAPE);

    const topology = Object.fromEntries(
      productionSourceFiles
        .filter((path) =>
          textOf(path).includes(VIEWER_OWNER.module) || textOf(path).includes(CORE_OWNER.module),
        )
        .map((path) => [
          path,
          importedCallCount(
            parse(path),
            [VIEWER_OWNER.module, CORE_OWNER.module],
            "useNavigation",
          ),
        ] as const)
        .filter(([, count]) => count > 0),
    );
    expect(topology).toEqual(CURRENT_NAVIGATION_CALL_TOPOLOGY);
  });

  it("keeps AnnotationOverlay on primitive page/tool-mode selectors plus exact event snapshots", () => {
    const path = "src/components/viewer/AnnotationOverlay.tsx";
    const source = parse(path);
    expect(
      importedCallCount(
        source,
        [VIEWER_OWNER.module, CORE_OWNER.module, TOOL_OWNER.module],
        "useNavigation",
      ),
    ).toBe(0);
    const coreAccesses = storeMemberAccesses(
      source,
      CORE_OWNER,
      new Set(["pageNumber"]),
    );
    expect(coreAccesses).toEqual([
      { kind: "getState-direct", member: "pageNumber" },
      { kind: "selector", member: "pageNumber" },
      { kind: "getState-direct", member: "pageNumber" },
      { kind: "getState-direct", member: "pageNumber" },
      { kind: "getState-direct", member: "pageNumber" },
      { kind: "getState-direct", member: "pageNumber" },
    ]);
    const modeAccesses = storeMemberAccesses(
      source,
      TOOL_OWNER,
      new Set(["mode"]),
    );
    expect(modeAccesses).toEqual([
      { kind: "selector", member: "mode" },
      { kind: "getState-alias", member: "mode" },
      { kind: "getState-alias", member: "mode" },
      { kind: "getState-alias", member: "mode" },
      { kind: "getState-alias", member: "mode" },
      { kind: "getState-alias", member: "mode" },
      { kind: "getState-alias", member: "mode" },
      { kind: "getState-alias", member: "mode" },
    ]);
  });
});

describe("P2.3 V2 post-flip core access oracle", () => {
  it("self-calibrates aliases, casts, computed keys, getState, and setState", () => {
    const fixture = ts.createSourceFile(
      "viewer-core-owner-fixture.tsx",
      `
        import { ${ACTIVE_CORE_OWNER.exportName} as importedStore } from "${ACTIVE_CORE_OWNER.module}";
        const storeAlias = importedStore as any;
        const computed = "scale";
        storeAlias(({ pageNumber }: any) => pageNumber);
        storeAlias(useShallow((state: any) => state[computed]));
        const getter = storeAlias["getState"];
        const { setPage } = getter() as any;
        const snapshot = getter() as any;
        snapshot["pageDimensions"];
        const setter = importedStore.setState;
        setter({ ["pendingCenter"]: true });
        (storeAlias() as any).zoomFit;
      `,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const accesses = storeMemberAccesses(fixture, ACTIVE_CORE_OWNER, CORE_MEMBER_NAMES)
      .map(({ kind, member }) => `${kind}:${member}`);
    expect(accesses).toEqual(expect.arrayContaining([
      "selector-parameter:pageNumber",
      "selector-element:scale",
      "getState-destructure:setPage",
      "getState-alias-element:pageDimensions",
      "setState:pendingCenter",
      "hook-direct:zoomFit",
    ]));
  });

  it("keeps every production core access on viewerCore and the viewer escape owner empty", () => {
    const plausible = productionSourceFiles.filter((path) => {
      const text = textOf(path);
      return text.includes(VIEWER_OWNER.module) || text.includes(CORE_OWNER.module);
    });
    const active = plausible.flatMap((path) =>
      storeMemberAccesses(parse(path), ACTIVE_CORE_OWNER, CORE_MEMBER_NAMES)
        .map((access) => `${path}:${access.kind}:${access.member}`),
    );
    const inactive = plausible.flatMap((path) =>
      storeMemberAccesses(parse(path), INACTIVE_CORE_OWNER, CORE_MEMBER_NAMES)
        .map((access) => `${path}:${access.kind}:${access.member}`),
    );

    expect(active.length, "viewerCore members have real consumers").toBeGreaterThan(50);
    expect(inactive).toEqual([]);
  }, 15_000);
});
