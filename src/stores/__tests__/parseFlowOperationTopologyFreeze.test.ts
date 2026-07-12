// @vitest-environment node
// [refactor jul12 P2.4 A2a] Additive topology and mutation freeze for parse-operation authority.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  createParseOperationRegistry,
  invalidateParseOperationKinds,
  PARSE_KINDS,
} from "@/lib/parse-operation-state";

const OPERATION_STATE_FILE = "src/lib/parse-operation-state.ts";
const PARSE_STORE_FILE = "src/stores/parseFlowStore.ts";
const VIEWER_COMMANDS_FILE = "src/stores/viewerCommands.ts";
const OPERATION_HOOK_FILE = "src/hooks/useParseOperation.ts";
const OPERATION_HOOK_MODULE = "@/hooks/useParseOperation";
const LIFECYCLE_HOOK_FILE = "src/hooks/useParseFlow.ts";

const OPERATION_OWNER_KEYS = [
  "parseOperations",
  "beginParseOperation",
  "isParseOperationCurrent",
  "finishParseOperation",
  "invalidateParseOperation",
] as const;
const OPERATION_FACADE_KEYS = [
  "kind",
  "revision",
  "busy",
  "begin",
  "isCurrent",
  "finish",
  "invalidate",
] as const;
const LIFECYCLE_FACADE_KEYS = [
  "kind",
  "step",
  "region",
  "setStep",
  "setRegion",
  "reset",
] as const;
const KIND_RESETS = {
  resetTableParse: "table",
  resetKeynoteParse: "keynote",
  resetNotesParse: "notes",
  resetSpecParse: "spec",
} as const;
const STEP_COMMANDS = {
  setTableParseStep: { kind: "table", step: "tableParseStep" },
  setKeynoteParseStep: { kind: "keynote", step: "keynoteParseStep" },
  setNotesParseStep: { kind: "notes", step: "notesParseStep" },
  setSpecParseStep: { kind: "spec", step: "specParseStep" },
} as const;

const textCache = new Map<string, string>();
const sourceCache = new Map<string, ts.SourceFile>();

function textOf(path: string): string {
  const cached = textCache.get(path);
  if (cached !== undefined) return cached;
  const text = readFileSync(join(process.cwd(), path), "utf8");
  textCache.set(path, text);
  return text;
}

function sourceOf(path: string): ts.SourceFile {
  const cached = sourceCache.get(path);
  if (cached) return cached;
  const source = ts.createSourceFile(
    path,
    textOf(path),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  sourceCache.set(path, source);
  return source;
}

function parseFixture(name: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    name,
    text,
    ts.ScriptTarget.Latest,
    true,
    name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function descendants<T extends ts.Node>(
  root: ts.Node,
  predicate: (node: ts.Node) => node is T,
): T[] {
  const matches: T[] = [];
  const visit = (node: ts.Node): void => {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return matches;
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) current = current.expression;
  return current;
}

function compact(node: ts.Node, source: ts.SourceFile): string {
  return node.getText(source).replace(/\s+/g, "");
}

function staticName(name: ts.PropertyName | ts.BindingName | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) {
    const expression = unwrap(name.expression);
    return ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)
      ? expression.text
      : null;
  }
  return null;
}

function directObjectKeys(object: ts.ObjectLiteralExpression): string[] {
  return object.properties.flatMap((property) => {
    if (ts.isShorthandPropertyAssignment(property)) return [property.name.text];
    if (!("name" in property)) return [];
    const name = staticName(property.name);
    return name === null ? [] : [name];
  });
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

function findFunction(source: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const matches = descendants(
    source,
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  expect(matches, `${name} function`).toHaveLength(1);
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

function findTypeAlias(source: ts.SourceFile, name: string): ts.TypeAliasDeclaration {
  const matches = descendants(
    source,
    (node): node is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(node) && node.name.text === name,
  );
  expect(matches, `${name} type alias`).toHaveLength(1);
  return matches[0];
}

function findStoreObject(source: ts.SourceFile): ts.ObjectLiteralExpression {
  const initializer = findVariable(source, "useParseFlowStore").initializer;
  expect(initializer && ts.isCallExpression(initializer), "parse store create call").toBe(true);
  const factory = (initializer as ts.CallExpression).arguments[0];
  expect(
    factory && (ts.isArrowFunction(factory) || ts.isFunctionExpression(factory)),
    "parse store factory",
  ).toBe(true);
  const body = (factory as ts.ArrowFunction | ts.FunctionExpression).body;
  const candidate = ts.isExpression(body) ? unwrap(body) : body;
  expect(ts.isObjectLiteralExpression(candidate), "parse store object literal").toBe(true);
  return candidate as ts.ObjectLiteralExpression;
}

function directProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.ObjectLiteralElementLike {
  const matches = object.properties.filter(
    (property) => "name" in property && staticName(property.name) === name,
  );
  expect(matches, `${name} direct property`).toHaveLength(1);
  return matches[0];
}

function propertyInitializer(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression {
  const property = directProperty(object, name);
  expect(ts.isPropertyAssignment(property), `${name} property assignment`).toBe(true);
  return (property as ts.PropertyAssignment).initializer;
}

function objectVariable(source: ts.SourceFile, name: string): ts.ObjectLiteralExpression {
  const initializer = findVariable(source, name).initializer;
  expect(initializer, `${name} initializer`).toBeDefined();
  const candidate = unwrap(initializer!);
  expect(ts.isObjectLiteralExpression(candidate), `${name} object`).toBe(true);
  return candidate as ts.ObjectLiteralExpression;
}

function returnedArrowObject(expression: ts.Expression): ts.ObjectLiteralExpression {
  const candidate = unwrap(expression);
  expect(ts.isArrowFunction(candidate), "arrow function").toBe(true);
  const body = (candidate as ts.ArrowFunction).body;
  expect(ts.isExpression(body), "expression-bodied arrow").toBe(true);
  const object = unwrap(body as ts.Expression);
  expect(ts.isObjectLiteralExpression(object), "returned object").toBe(true);
  return object as ts.ObjectLiteralExpression;
}

function terminalName(expression: ts.Expression): string | null {
  const candidate = unwrap(expression);
  if (ts.isIdentifier(candidate)) return candidate.text;
  if (ts.isPropertyAccessExpression(candidate)) return candidate.name.text;
  if (ts.isElementAccessExpression(candidate) && candidate.argumentExpression) {
    const argument = unwrap(candidate.argumentExpression);
    return ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)
      ? argument.text
      : null;
  }
  return null;
}

function callsNamed(root: ts.Node, name: string): ts.CallExpression[] {
  return descendants(root, ts.isCallExpression).filter(
    (call) => terminalName(call.expression) === name,
  );
}

function exportedNames(source: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      names.push(...statement.exportClause.elements.map((element) => element.name.text));
      continue;
    }
    const exported = ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(
      (modifier: ts.Modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (!exported) continue;
    if (
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      if (statement.name) names.push(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
      }
    }
  }
  return names.sort();
}

function importedNames(source: ts.SourceFile, moduleName: string): string[] {
  return source.statements.flatMap((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== moduleName ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) return [];
    return statement.importClause.namedBindings.elements.map(
      (element) => (element.propertyName ?? element.name).text,
    );
  });
}

type OwnerInvariantFeatures = Readonly<{
  beginSingleWrite: boolean;
  beginUsesKindLane: boolean;
  beginRejectsBusyWithState: boolean;
  beginIsMonotonicAndAtomic: boolean;
  currentUsesKindLane: boolean;
  currentRequiresBusyAndRevision: boolean;
  finishSingleWrite: boolean;
  finishUsesKindLane: boolean;
  finishGuardsBusyAndRevision: boolean;
  finishStaleReturnsState: boolean;
  finishClearsOnlyBusy: boolean;
  kindResetsUseMonotonicHelper: boolean;
  projectResetUsesAllKindsHelper: boolean;
}>;

function ownerInvariantFeatures(source: ts.SourceFile): OwnerInvariantFeatures {
  const object = findStoreObject(source);
  const begin = propertyInitializer(object, "beginParseOperation");
  const current = propertyInitializer(object, "isParseOperationCurrent");
  const finish = propertyInitializer(object, "finishParseOperation");
  const beginText = compact(begin, source);
  const currentText = compact(current, source);
  const finishText = compact(finish, source);
  const resets = Object.entries(KIND_RESETS).every(([action, kind]) => {
    const text = compact(propertyInitializer(object, action), source);
    return text.includes(
      `parseOperations:invalidateParseOperationKinds(state.parseOperations,["${kind}"])`,
    ) && !text.includes("createParseOperationRegistry()") && !text.includes("revision:0");
  });
  const project = compact(propertyInitializer(object, "resetProjectParseState"), source);

  return {
    beginSingleWrite: callsNamed(begin, "set").length === 1,
    beginUsesKindLane: beginText.includes("state.parseOperations[kind]"),
    beginRejectsBusyWithState:
      beginText.includes('current.busy&&policy==="reject"') && beginText.includes("returnstate"),
    beginIsMonotonicAndAtomic:
      beginText.includes("constrevision=current.revision+1") &&
      beginText.includes("[kind]:{revision,busy:true}") &&
      !beginText.includes("revision:0"),
    currentUsesKindLane: currentText.includes("get().parseOperations[token.kind]"),
    currentRequiresBusyAndRevision:
      currentText.includes("current.busy&&current.revision===token.revision"),
    finishSingleWrite: callsNamed(finish, "set").length === 1,
    finishUsesKindLane: finishText.includes("state.parseOperations[token.kind]"),
    finishGuardsBusyAndRevision:
      finishText.includes("!current.busy||current.revision!==token.revision"),
    finishStaleReturnsState: finishText.includes("returnstate"),
    finishClearsOnlyBusy:
      finishText.includes("[token.kind]:{revision:current.revision,busy:false}") &&
      !finishText.includes("revision:0"),
    kindResetsUseMonotonicHelper: resets,
    projectResetUsesAllKindsHelper:
      project.includes(
        "parseOperations:invalidateParseOperationKinds(state.parseOperations,PARSE_KINDS)",
      ) && !project.includes("createParseOperationRegistry()") && !project.includes("revision:0"),
  };
}

function mutateOnce(source: string, before: string, after: string): string {
  expect(source.split(before), `mutation anchor ${before}`).toHaveLength(2);
  return source.replace(before, after);
}

function unsafeHookAncestors(call: ts.CallExpression, boundary: ts.FunctionDeclaration): string[] {
  const labels: string[] = [];
  let current: ts.Node | undefined = call.parent;
  while (current && current !== boundary) {
    if (ts.isIfStatement(current)) labels.push("if");
    else if (ts.isConditionalExpression(current)) labels.push("conditional");
    else if (ts.isBinaryExpression(current) && (
      current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      current.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    )) labels.push("logical");
    else if (
      ts.isForStatement(current) ||
      ts.isForInStatement(current) ||
      ts.isForOfStatement(current) ||
      ts.isWhileStatement(current) ||
      ts.isDoStatement(current)
    ) labels.push("loop");
    else if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current) ||
        ts.isFunctionDeclaration(current)) && current !== boundary
    ) labels.push("nested-function");
    current = current.parent;
  }
  return labels;
}

function adapterShape(
  source: ts.SourceFile,
  registryName: string,
): Readonly<Record<string, readonly string[]>> {
  const registry = objectVariable(source, registryName);
  return Object.fromEntries(registry.properties.map((property) => {
    expect(ts.isPropertyAssignment(property), `${registryName} static property`).toBe(true);
    const assignment = property as ts.PropertyAssignment;
    const name = staticName(assignment.name);
    expect(name, `${registryName} static name`).not.toBeNull();
    const object = returnedArrowObject(assignment.initializer);
    return [name!, object.properties.map((entry) => {
      if (ts.isSpreadAssignment(entry)) return `...${compact(entry.expression, source)}`;
      return "name" in entry ? staticName(entry.name) : null;
    }).filter((entry): entry is string => entry !== null)];
  }));
}

function arrowReturnedObjectFromCall(call: ts.CallExpression): ts.ObjectLiteralExpression {
  const callback = call.arguments[0] && unwrap(call.arguments[0]);
  expect(callback && ts.isArrowFunction(callback), "setState callback").toBe(true);
  const body = (callback as ts.ArrowFunction).body;
  expect(ts.isExpression(body), "setState expression body").toBe(true);
  const object = unwrap(body as ts.Expression);
  expect(ts.isObjectLiteralExpression(object), "setState returned object").toBe(true);
  return object as ts.ObjectLiteralExpression;
}

function allTypeScriptFiles(directory = "src"): string[] {
  const output: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(join(process.cwd(), current), { withFileTypes: true })) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (/\.(?:ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        output.push(child);
      }
    }
  };
  visit(directory);
  return output.sort();
}

function isTestFile(path: string): boolean {
  return path.includes("/__tests__/") || path.startsWith("src/test/") ||
    /\.(?:test|spec)\.(?:ts|tsx)$/.test(path);
}

function productionFiles(): string[] {
  return allTypeScriptFiles().filter((path) => !isTestFile(path));
}

function normalizedModulePath(path: string): string {
  return normalize(path).replace(/\\/g, "/").replace(/\.(?:ts|tsx)$/, "").replace(/\/index$/, "");
}

function resolvesToCandidate(
  importer: string,
  specifier: string,
  moduleName: string,
  fileName: string,
): boolean {
  let candidate = "";
  if (specifier === moduleName) candidate = fileName;
  else if (specifier.startsWith("@/")) candidate = join("src", specifier.slice(2));
  else if (specifier.startsWith(".")) candidate = join(dirname(importer), specifier);
  return normalizedModulePath(candidate) === normalizedModulePath(fileName);
}

type ModuleLoadKind = "import" | "re-export" | "dynamic-import" | "require" | "import-type";

function candidateLoadKinds(
  importer: string,
  source: ts.SourceFile,
  moduleName: string,
  fileName: string,
): ModuleLoadKind[] {
  const output: Array<{ position: number; kind: ModuleLoadKind }> = [];
  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      resolvesToCandidate(importer, statement.moduleSpecifier.text, moduleName, fileName)
    ) output.push({ position: statement.getStart(source), kind: "import" });
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      resolvesToCandidate(importer, statement.moduleSpecifier.text, moduleName, fileName)
    ) output.push({ position: statement.getStart(source), kind: "re-export" });
  }
  for (const call of descendants(source, ts.isCallExpression)) {
    const argument = call.arguments[0];
    if (!argument || !ts.isStringLiteral(argument)) continue;
    const isImport = call.expression.kind === ts.SyntaxKind.ImportKeyword;
    const isRequire = ts.isIdentifier(call.expression) && call.expression.text === "require";
    if (
      (isImport || isRequire) &&
      resolvesToCandidate(importer, argument.text, moduleName, fileName)
    ) {
      output.push({
        position: call.getStart(source),
        kind: isImport ? "dynamic-import" : "require",
      });
    }
  }
  for (const importType of descendants(source, ts.isImportTypeNode)) {
    const argument = importType.argument;
    if (
      ts.isLiteralTypeNode(argument) &&
      ts.isStringLiteral(argument.literal) &&
      resolvesToCandidate(importer, argument.literal.text, moduleName, fileName)
    ) output.push({ position: importType.getStart(source), kind: "import-type" });
  }
  return output.sort((left, right) => left.position - right.position).map(({ kind }) => kind);
}

function importedOperationHookBindings(
  importer: string,
  source: ts.SourceFile,
): { direct: Set<string>; namespaces: Set<string> } {
  const direct = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !resolvesToCandidate(
        importer,
        statement.moduleSpecifier.text,
        OPERATION_HOOK_MODULE,
        OPERATION_HOOK_FILE,
      ) ||
      !statement.importClause?.namedBindings
    ) continue;
    const bindings = statement.importClause.namedBindings;
    if (ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    else {
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text === "useParseOperation") {
          direct.add(element.name.text);
        }
      }
    }
  }
  return { direct, namespaces };
}

function namespaceHookReference(expression: ts.Expression, namespaces: Set<string>): boolean {
  const candidate = unwrap(expression);
  if (ts.isPropertyAccessExpression(candidate)) {
    return ts.isIdentifier(unwrap(candidate.expression)) &&
      namespaces.has((unwrap(candidate.expression) as ts.Identifier).text) &&
      candidate.name.text === "useParseOperation";
  }
  if (ts.isElementAccessExpression(candidate) && candidate.argumentExpression) {
    const root = unwrap(candidate.expression);
    const argument = unwrap(candidate.argumentExpression);
    return ts.isIdentifier(root) && namespaces.has(root.text) &&
      (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) &&
      argument.text === "useParseOperation";
  }
  return false;
}

function operationHookInvocationKinds(importer: string, source: ts.SourceFile): string[] {
  const bindings = importedOperationHookBindings(importer, source);
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of descendants(source, ts.isVariableDeclaration)) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const initializer = unwrap(declaration.initializer);
      if (
        ts.isIdentifier(initializer) && bindings.direct.has(initializer.text) &&
        !bindings.direct.has(declaration.name.text)
      ) {
        bindings.direct.add(declaration.name.text);
        changed = true;
      }
      if (
        ts.isIdentifier(initializer) && bindings.namespaces.has(initializer.text) &&
        !bindings.namespaces.has(declaration.name.text)
      ) {
        bindings.namespaces.add(declaration.name.text);
        changed = true;
      }
      if (
        namespaceHookReference(initializer, bindings.namespaces) &&
        !bindings.direct.has(declaration.name.text)
      ) {
        bindings.direct.add(declaration.name.text);
        changed = true;
      }
    }
  }

  return descendants(source, ts.isCallExpression).flatMap((call) => {
    const callee = unwrap(call.expression);
    if (ts.isIdentifier(callee) && bindings.direct.has(callee.text)) return ["direct-or-alias"];
    if (
      (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
      ts.isIdentifier(unwrap(callee.expression)) &&
      bindings.direct.has((unwrap(callee.expression) as ts.Identifier).text)
    ) {
      const method = terminalName(callee);
      return method === "call" || method === "apply" || method === "bind"
        ? [`function-${method}`]
        : [];
    }
    return namespaceHookReference(callee, bindings.namespaces) ? ["namespace"] : [];
  });
}

function containsParseOperationsAccess(node: ts.Node): boolean {
  return descendants(node, (candidate): candidate is ts.PropertyAccessExpression | ts.ElementAccessExpression => {
    if (ts.isPropertyAccessExpression(candidate)) return candidate.name.text === "parseOperations";
    if (!ts.isElementAccessExpression(candidate) || !candidate.argumentExpression) return false;
    const argument = unwrap(candidate.argumentExpression);
    return (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) &&
      argument.text === "parseOperations";
  }).length > 0;
}

function enclosingFunctionName(node: ts.Node): string {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isPropertyAssignment(current.parent)
    ) return staticName(current.parent.name) ?? "anonymous";
    current = current.parent;
  }
  return "module";
}

function rawParseOperationWrites(source: ts.SourceFile): string[] {
  const writes: Array<{ position: number; label: string }> = [];
  for (const property of descendants(
    source,
    (node): node is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
      ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node),
  )) {
    const name = ts.isShorthandPropertyAssignment(property)
      ? property.name.text
      : staticName(property.name);
    if (name === "parseOperations") {
      writes.push({
        position: property.getStart(source),
        label: `${enclosingFunctionName(property)}:${
          ts.isShorthandPropertyAssignment(property) ? "shorthand" : "property"
        }`,
      });
    }
  }
  for (const binary of descendants(source, ts.isBinaryExpression)) {
    if (
      binary.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      binary.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      containsParseOperationsAccess(binary.left)
    ) writes.push({ position: binary.getStart(source), label: `${enclosingFunctionName(binary)}:assignment` });
  }
  for (const unary of descendants(
    source,
    (node): node is ts.PrefixUnaryExpression | ts.PostfixUnaryExpression =>
      ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node),
  )) {
    const mutates = unary.operator === ts.SyntaxKind.PlusPlusToken ||
      unary.operator === ts.SyntaxKind.MinusMinusToken;
    if (mutates && containsParseOperationsAccess(unary.operand)) {
      writes.push({ position: unary.getStart(source), label: `${enclosingFunctionName(unary)}:update` });
    }
  }
  for (const deletion of descendants(source, ts.isDeleteExpression)) {
    if (containsParseOperationsAccess(deletion.expression)) {
      writes.push({ position: deletion.getStart(source), label: `${enclosingFunctionName(deletion)}:delete` });
    }
  }
  return writes.sort((left, right) => left.position - right.position).map(({ label }) => label);
}

describe("P2.4 A2a pure operation registry topology", () => {
  it("pins the dependency-free exports and the identity-preserving deduplicated transform", () => {
    const source = sourceOf(OPERATION_STATE_FILE);
    expect(source.statements.filter(ts.isImportDeclaration)).toEqual([]);
    expect(exportedNames(source)).toEqual([
      "BeginParseOperationPolicy",
      "BeginParseOperationResult",
      "PARSE_KINDS",
      "ParseKind",
      "ParseOperationRegistry",
      "ParseOperationStatus",
      "ParseOperationToken",
      "createParseOperationRegistry",
      "invalidateParseOperationKinds",
    ]);
    expect(PARSE_KINDS).toEqual(["table", "keynote", "notes", "spec"]);

    const initial = createParseOperationRegistry();
    expect(initial).toEqual({
      table: { revision: 0, busy: false },
      keynote: { revision: 0, busy: false },
      notes: { revision: 0, busy: false },
      spec: { revision: 0, busy: false },
    });
    expect(new Set(Object.values(initial))).toHaveLength(4);
    expect(invalidateParseOperationKinds(initial, [])).toBe(initial);

    const changed = invalidateParseOperationKinds(initial, ["table", "table", "spec"]);
    expect(changed).not.toBe(initial);
    expect(changed.table).toEqual({ revision: 1, busy: false });
    expect(changed.spec).toEqual({ revision: 1, busy: false });
    expect(changed.keynote).toBe(initial.keynote);
    expect(changed.notes).toBe(initial.notes);

    const registryReturn = findFunction(source, "createParseOperationRegistry").body!.statements
      .filter(ts.isReturnStatement);
    expect(registryReturn).toHaveLength(1);
    const registryObject = registryReturn[0].expression && unwrap(registryReturn[0].expression);
    expect(registryObject && ts.isObjectLiteralExpression(registryObject)).toBe(true);
    expect(directObjectKeys(registryObject as ts.ObjectLiteralExpression)).toEqual(PARSE_KINDS);
  });
});

describe("P2.4 A2a parse owner additive topology", () => {
  it("adds exactly one registry and four owner actions, with reset invalidation in the same writes", () => {
    const source = sourceOf(PARSE_STORE_FILE);
    const state = findInterface(source, "ParseFlowState");
    const interfaceKeys = state.members.flatMap((member) => {
      if (!("name" in member)) return [];
      const name = staticName(member.name);
      return name === null ? [] : [name];
    });
    const object = findStoreObject(source);
    const objectKeys = directObjectKeys(object);
    const isOperationOwnerKey = (key: string): boolean =>
      key === "parseOperations" || key.includes("ParseOperation");
    expect(interfaceKeys.filter(isOperationOwnerKey), "exact additive interface ledger")
      .toEqual(OPERATION_OWNER_KEYS);
    expect(objectKeys.filter(isOperationOwnerKey), "exact additive implementation ledger")
      .toEqual(OPERATION_OWNER_KEYS);
    for (const key of OPERATION_OWNER_KEYS) {
      expect(interfaceKeys.filter((candidate) => candidate === key), `${key} interface`).toHaveLength(1);
      expect(objectKeys.filter((candidate) => candidate === key), `${key} implementation`).toHaveLength(1);
    }
    expect(compact(propertyInitializer(object, "parseOperations"), source))
      .toBe("createParseOperationRegistry()");
    expect(importedNames(source, "@/lib/parse-operation-state")).toEqual([
      "createParseOperationRegistry",
      "invalidateParseOperationKinds",
      "PARSE_KINDS",
      "BeginParseOperationPolicy",
      "BeginParseOperationResult",
      "ParseKind",
      "ParseOperationRegistry",
      "ParseOperationToken",
    ]);

    const features = ownerInvariantFeatures(source);
    expect(features).toEqual(Object.fromEntries(
      Object.keys(features).map((key) => [key, true]),
    ));
  });

  it("self-calibrates the owner oracle against the five highest-risk state-machine mutations", () => {
    const sourceText = textOf(PARSE_STORE_FILE);
    const original = ownerInvariantFeatures(sourceOf(PARSE_STORE_FILE));
    expect(Object.values(original).every(Boolean)).toBe(true);

    const resetToZero = parseFixture(PARSE_STORE_FILE, mutateOnce(
      sourceText,
      'invalidateParseOperationKinds(state.parseOperations, ["table"])',
      "createParseOperationRegistry()",
    ));
    expect(ownerInvariantFeatures(resetToZero).kindResetsUseMonotonicHelper).toBe(false);

    const globalLane = parseFixture(PARSE_STORE_FILE, mutateOnce(
      sourceText,
      "const current = state.parseOperations[kind];",
      "const current = state.parseOperations.table;",
    ));
    expect(ownerInvariantFeatures(globalLane).beginUsesKindLane).toBe(false);

    const revisionOnly = parseFixture(PARSE_STORE_FILE, mutateOnce(
      sourceText,
      "return current.busy && current.revision === token.revision;",
      "return current.revision === token.revision;",
    ));
    expect(ownerInvariantFeatures(revisionOnly).currentRequiresBusyAndRevision).toBe(false);

    const unconditionalFinish = parseFixture(PARSE_STORE_FILE, mutateOnce(
      sourceText,
      "if (!current.busy || current.revision !== token.revision) return state;",
      "void current;",
    ));
    const unconditionalFeatures = ownerInvariantFeatures(unconditionalFinish);
    expect(unconditionalFeatures.finishGuardsBusyAndRevision).toBe(false);
    expect(unconditionalFeatures.finishStaleReturnsState).toBe(false);

    const twoWriteBegin = parseFixture(PARSE_STORE_FILE, mutateOnce(
      sourceText,
      'let result: BeginParseOperationResult<K> = { status: "busy" };',
      'set(() => ({}));\n    let result: BeginParseOperationResult<K> = { status: "busy" };',
    ));
    expect(ownerInvariantFeatures(twoWriteBegin).beginSingleWrite).toBe(false);
  });
});

describe("P2.4 A2a operation hook and A1 lifecycle topology", () => {
  it("pins module-bound actions, four static adapters, and one unconditional shallow hook", () => {
    const source = sourceOf(OPERATION_HOOK_FILE);
    expect(directObjectKeys(objectVariable(source, "PARSE_OPERATION_ACTIONS"))).toEqual(PARSE_KINDS);
    for (const kind of PARSE_KINDS) {
      expect(compact(
        propertyInitializer(objectVariable(source, "PARSE_OPERATION_ACTIONS"), kind),
        source,
      )).toBe(`bindParseOperationActions("${kind}")`);
    }
    expect(adapterShape(source, "PARSE_OPERATION_ADAPTERS")).toEqual({
      table: ["kind", "revision", "busy", "...PARSE_OPERATION_ACTIONS.table"],
      keynote: ["kind", "revision", "busy", "...PARSE_OPERATION_ACTIONS.keynote"],
      notes: ["kind", "revision", "busy", "...PARSE_OPERATION_ACTIONS.notes"],
      spec: ["kind", "revision", "busy", "...PARSE_OPERATION_ACTIONS.spec"],
    });
    const bind = findFunction(source, "bindParseOperationActions");
    const bindReturn = bind.body!.statements.filter(ts.isReturnStatement);
    expect(bindReturn).toHaveLength(1);
    const boundObject = unwrap(bindReturn[0].expression!);
    expect(ts.isObjectLiteralExpression(boundObject)).toBe(true);
    expect(directObjectKeys(boundObject as ts.ObjectLiteralExpression)).toEqual([
      "begin", "isCurrent", "finish", "invalidate",
    ]);

    const hook = findFunction(source, "useParseOperation");
    const storeCalls = callsNamed(hook, "useParseFlowStore");
    expect(storeCalls, "one Zustand hook").toHaveLength(1);
    expect(unsafeHookAncestors(storeCalls[0], hook)).toEqual([]);
    const shallow = storeCalls[0].arguments[0] && unwrap(storeCalls[0].arguments[0]);
    expect(shallow && ts.isCallExpression(shallow)).toBe(true);
    expect(terminalName((shallow as ts.CallExpression).expression)).toBe("useShallow");
    expect(compact((shallow as ts.CallExpression).arguments[0], source)).toBe("selector");
    expect(hook.body?.statements).toHaveLength(2);
    const selector = findVariable(hook.getSourceFile(), "selector");
    expect(compact(selector.initializer!, source)).toBe(
      'kind==="table"?PARSE_OPERATION_ADAPTERS.table:kind==="keynote"?' +
      'PARSE_OPERATION_ADAPTERS.keynote:kind==="notes"?' +
      "PARSE_OPERATION_ADAPTERS.notes:PARSE_OPERATION_ADAPTERS.spec",
    );
  });

  it("keeps the A1 lifecycle at six fields with no operation subscription or adapter spread", () => {
    const source = sourceOf(LIFECYCLE_HOOK_FILE);
    const lifecycle = findTypeAlias(source, "ParseFlowLifecycle").type;
    expect(ts.isTypeLiteralNode(lifecycle), "lifecycle type literal").toBe(true);
    expect((lifecycle as ts.TypeLiteralNode).members.flatMap((member) => {
      if (!("name" in member)) return [];
      const name = staticName(member.name);
      return name === null ? [] : [name];
    })).toEqual(LIFECYCLE_FACADE_KEYS);
    expect(adapterShape(source, "PARSE_FLOW_ADAPTERS")).toEqual({
      table: LIFECYCLE_FACADE_KEYS,
      keynote: LIFECYCLE_FACADE_KEYS,
      notes: LIFECYCLE_FACADE_KEYS,
      spec: LIFECYCLE_FACADE_KEYS,
    });
    const forbidden = new Set([...OPERATION_FACADE_KEYS.slice(1), "parseOperations", "useParseOperation"]);
    expect(descendants(source, ts.isIdentifier)
      .map((identifier) => identifier.text)
      .filter((name) => forbidden.has(name))).toEqual([]);
  });
});

describe("P2.4 A2a viewer command ownership boundaries", () => {
  it("pins four neutral boundaries and both raw panel closes to the pure invalidation helper", () => {
    const source = sourceOf(VIEWER_COMMANDS_FILE);
    expect(importedNames(source, "@/lib/parse-operation-state")).toEqual([
      "invalidateParseOperationKinds",
      "ParseKind",
      "ParseOperationRegistry",
      "ParseOperationToken",
    ]);
    expect(compact(findFunction(source, "crossesParseOperationBoundary").body!, source)).toBe(
      '{return(currentStep==="idle")!==(nextStep==="idle");}',
    );
    const patch = findFunction(source, "operationBoundaryPatch");
    expect(callsNamed(patch, "crossesParseOperationBoundary")).toHaveLength(1);
    const invalidate = callsNamed(patch, "invalidateParseOperationKinds");
    expect(invalidate).toHaveLength(1);
    expect(invalidate[0].arguments.map((argument) => compact(argument, source)))
      .toEqual(["parseOperations", "[kind]"]);

    for (const [commandName, contract] of Object.entries(STEP_COMMANDS)) {
      const command = findFunction(source, commandName);
      const prepare = callsNamed(command, "prepareParseEntry");
      const writes = callsNamed(command, "setState").filter(
        (call) => compact(call.expression, source).includes("useParseFlowStore"),
      );
      expect(prepare, `${commandName} prepares tools`).toHaveLength(1);
      expect(writes, `${commandName} one parse write`).toHaveLength(1);
      expect(prepare[0].getStart(source)).toBeLessThan(writes[0].getStart(source));
      const object = arrowReturnedObjectFromCall(writes[0]);
      expect(directObjectKeys(object)).toEqual([contract.step]);
      const spreads = object.properties.filter(ts.isSpreadAssignment);
      expect(spreads, `${commandName} boundary spread`).toHaveLength(1);
      const boundaryCall = unwrap(spreads[0].expression);
      expect(ts.isCallExpression(boundaryCall), `${commandName} boundary call`).toBe(true);
      expect(terminalName((boundaryCall as ts.CallExpression).expression))
        .toBe("operationBoundaryPatch");
      expect((boundaryCall as ts.CallExpression).arguments.map((argument) =>
        compact(argument, source)
      )).toEqual([
        "state.parseOperations",
        `"${contract.kind}"`,
        `state.${contract.step}`,
        contract.step,
      ]);
    }

    for (const commandName of [
      "toggleTableParsePanel",
      "toggleKeynoteParsePanel",
    ] as const) {
      const command = findFunction(source, commandName);
      const writes = callsNamed(command, "setState").filter(
        (call) => compact(call.expression, source).includes("useParseFlowStore"),
      );
      expect(writes, `${commandName} one raw close write`).toHaveLength(1);
      const object = arrowReturnedObjectFromCall(writes[0]);
      const operationPatch = propertyInitializer(object, "parseOperations");
      expect(compact(operationPatch, source)).toBe(
        'invalidateParseOperationKinds(state.parseOperations,["table","keynote","notes"],)',
      );
    }
    expect(rawParseOperationWrites(source)).toEqual([
      "operationBoundaryPatch:property",
      "invalidateGuidedParseOperations:shorthand",
      "invalidateKeynoteTableOperations:property",
      "resetKeynoteGuidedParse:property",
      "invalidateParagraphParseOperations:shorthand",
      "invalidateNotesWorkspaceOperations:shorthand",
      "invalidateParseOperationForWorkspace:shorthand",
      "beginGuidedGridEdit:shorthand",
      "beginParagraphWorkspaceEdit:shorthand",
      "acceptNotesParseRegion:property",
      "acceptSpecParseRegion:property",
      "openNotesParseTarget:property",
      "openNotesParseTarget:property",
      "openSpecParseTarget:property",
      "completeNotesParseOperation:property",
      "completeSpecParseOperation:property",
      "resetNotesParseWorkspace:property",
      "resetSpecParseWorkspace:property",
      "leaveNotesParserWorkspace:property",
      "leaveSpecParserWorkspace:property",
      "transitionNotesParserMode:shorthand",
      "transitionSpecParserMode:shorthand",
      "setParagraphBatchForUser:property",
      "upsertParagraphForUser:property",
      "removeParagraphForUser:property",
      "addGuidedNotesColumnForUser:property",
      "addGuidedNotesRowForUser:property",
      "acceptKeynoteParseRegion:property",
      "leaveSpecsNotesParseTab:property",
      "leaveSpecsNotesParseTab:property",
      "leaveSpecsNotesParseTab:property",
      "toggleTableParsePanel:property",
      "toggleKeynoteParsePanel:property",
    ]);
  });
});

describe("P2.4 A2b/A2c/A2d fail-closed caller and writer topology", () => {
  it("activates the operation facade only in the cold Table, Keynote, Notes, and Spec surfaces", () => {
    const production = productionFiles();
    const loads = production
      .filter((path) => path !== OPERATION_HOOK_FILE)
      .flatMap((path) => candidateLoadKinds(
        path,
        sourceOf(path),
        OPERATION_HOOK_MODULE,
        OPERATION_HOOK_FILE,
      ).map((kind) => ({ path, kind })));
    expect(loads).toEqual([
      { path: "src/components/viewer/AutoParseTab.tsx", kind: "import" },
      { path: "src/components/viewer/GuidedParseTab.tsx", kind: "import" },
      { path: "src/components/viewer/KeynotePanel.tsx", kind: "import" },
      { path: "src/components/viewer/ManualParseTab.tsx", kind: "import" },
      { path: "src/components/viewer/NotesParser.tsx", kind: "import" },
      { path: "src/components/viewer/SpecParser.tsx", kind: "import" },
      { path: "src/components/viewer/TableCompareModal.tsx", kind: "import" },
      { path: "src/components/viewer/TableParsePanel.tsx", kind: "import" },
    ]);

    const hotFiles = [
      "src/components/viewer/AnnotationOverlay.tsx",
      "src/components/viewer/PDFPage.tsx",
      "src/components/viewer/ParseRegionLayer.tsx",
      "src/components/viewer/DrawingPreviewLayer.tsx",
      "src/hooks/useShapeParseInteraction.ts",
    ];
    for (const path of hotFiles) {
      expect(candidateLoadKinds(
        path,
        sourceOf(path),
        OPERATION_HOOK_MODULE,
        OPERATION_HOOK_FILE,
      ), `${path} operation hook loads`).toEqual([]);
    }

    const fixturePath = "src/components/operation-hook-mutation-fixture.tsx";
    const fixture = parseFixture(fixturePath, `
      import { useParseOperation as direct } from "@/hooks/useParseOperation";
      import * as Operations from "../hooks/useParseOperation";
      export { useParseOperation } from "@/hooks/./useParseOperation";
      const lazy = import("@/hooks/useParseOperation");
      const commonJs = require("../hooks/useParseOperation");
      type HookType = import("@/hooks/useParseOperation").ParseOperationLifecycle<"table">;
      declare function consume(value: unknown): void;
      const alias = direct;
      const aliasAgain = alias;
      const namespaceAlias = Operations;
      const extracted = Operations.useParseOperation;
      direct("table");
      aliasAgain("notes");
      direct.call(null, "spec");
      direct.bind(null, "table")();
      Operations.useParseOperation("keynote");
      namespaceAlias["useParseOperation"]("spec");
      extracted("table");
      consume(direct);
      void lazy;
      void commonJs;
    `);
    expect(candidateLoadKinds(
      fixturePath,
      fixture,
      OPERATION_HOOK_MODULE,
      OPERATION_HOOK_FILE,
    )).toEqual([
      "import",
      "import",
      "re-export",
      "dynamic-import",
      "require",
      "import-type",
    ]);
    expect(operationHookInvocationKinds(fixturePath, fixture)).toEqual([
      "direct-or-alias",
      "direct-or-alias",
      "function-call",
      "function-bind",
      "namespace",
      "namespace",
      "direct-or-alias",
    ]);
  }, 30_000);

  it("forbids raw parseOperations writes outside its owner, coordinator, and tests", () => {
    const violations = productionFiles()
      .filter((path) => path !== PARSE_STORE_FILE && path !== VIEWER_COMMANDS_FILE)
      .flatMap((path) => rawParseOperationWrites(sourceOf(path)).map((write) => ({ path, write })));
    expect(violations).toEqual([]);

    const fixture = parseFixture("raw-operation-write-mutation-fixture.ts", `
      declare const state: any;
      declare const next: any;
      declare const parseOperations: any;
      function mutate() {
        const direct = { parseOperations: next };
        const computed = { ["parseOperations"]: next };
        const shorthand = { parseOperations };
        state.parseOperations = next;
        state["parseOperations"] = next;
        state.parseOperations.table = next;
        state.parseOperations.table.revision++;
        delete state.parseOperations.table;
        Object.assign(state, { parseOperations: next });
        return [direct, computed, shorthand];
      }
    `);
    expect(rawParseOperationWrites(fixture)).toEqual([
      "mutate:property",
      "mutate:property",
      "mutate:shorthand",
      "mutate:assignment",
      "mutate:assignment",
      "mutate:assignment",
      "mutate:update",
      "mutate:delete",
      "mutate:property",
    ]);
  }, 30_000);
});
