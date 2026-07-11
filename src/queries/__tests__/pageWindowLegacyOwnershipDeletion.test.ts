// @vitest-environment node
// [refactor jul11 P2.2⑦/⑧] Deletion tripwire for retired viewerStore server-data ownership paths.
//
// Runtime hook tests prove the new page-window facade works. This focused AST contract proves the
// inverse: the old fields/actions cannot quietly return through a store default, reset, selector,
// or the summaries compatibility facade and recreate two writable owners for the same data.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const LEGACY_PAGE_WINDOW_MEMBERS = [
  "loadedPageRange",
  "chunkLoading",
  "keynotes",
  "csiCodes",
  "textAnnotations",
  "pageIntelligence",
  "setLoadedPageRange",
  "setChunkLoading",
  "setKeynotes",
  "setBatchKeynotes",
  "setCsiCodes",
  "setTextAnnotations",
  "setPageIntelligence",
  // ⑧ Textract is a separate per-page Query domain, but shares this self-calibrating store-access
  // oracle so casts/aliases cannot recreate either retired owner through the same escape hatches.
  "textractData",
  "setTextractData",
  // ⑨ yoloTags is the final server collection retired from viewerStore. Keep it in the same
  // alias/cast/computed-key oracle so a compatibility shortcut cannot recreate dual ownership.
  "yoloTags",
  "setYoloTags",
  "addYoloTag",
  "addYoloTagsBulk",
  "removeYoloTag",
  "updateYoloTag",
  "tagBrowseNavigate",
  // P2.3 session ownership moved as one unit. Keep identity, demo policy, page metadata, labeling
  // workflow state, and the retired PI blob inside the same alias/cast/computed-key oracle.
  "projectId",
  "setProjectId",
  "publicId",
  "setPublicId",
  "dataUrl",
  "setDataUrl",
  "isDemo",
  "setIsDemo",
  "demoFeatureConfig",
  "setDemoFeatureConfig",
  "pageNames",
  "setPageNames",
  "setPageName",
  "pageDrawingNumbers",
  "setPageDrawingNumbers",
  "showLabelingWizard",
  "setShowLabelingWizard",
  "labelingWizardStep",
  "setLabelingWizardStep",
  "labelingSessions",
  "setLabelingSessions",
  "labelingCredentials",
  "setLabelingCredentials",
  "projectIntelligenceData",
  "setProjectIntelligenceData",
] as const;

const WHOLE_MAP_HOOK_WHITELIST = {
  useKeynotesByPage: [
    "src/components/viewer/DetectionPanel.tsx",
    "src/components/viewer/PageSidebar.tsx",
  ],
  useCsiCodesByPage: [
    "src/components/viewer/PageSidebar.tsx",
    "src/components/viewer/ViewAllPanel.tsx",
  ],
  useTextAnnotationsByPage: [
    "src/components/viewer/PageSidebar.tsx",
    "src/components/viewer/TextPanel.tsx",
    "src/components/viewer/ViewAllPanel.tsx",
  ],
  usePageIntelligenceByPage: [
    "src/components/viewer/AutoQtoTab.tsx",
    "src/components/viewer/KeynotePanel.tsx",
    "src/components/viewer/TableParsePanel.tsx",
    "src/components/viewer/ViewAllPanel.tsx",
  ],
  useCachedTextractForPages: [
    "src/components/viewer/PageSidebar.tsx",
  ],
} as const;

// Exact ⑧ topology. Counts are deliberate: PDFPage has two independently memoized slots and
// TextPanel has a parent OCR reader plus the directly mountable TextractTab reader.
const TEXTRACT_PAGE_HOOK_TOPOLOGY: Record<string, number> = {
  "src/components/viewer/KeynotePanel.tsx": 1,
  "src/components/viewer/ManualParseTab.tsx": 1,
  "src/components/viewer/NotesParser.tsx": 1,
  "src/components/viewer/PDFPage.tsx": 2,
  "src/components/viewer/SearchHighlightOverlay.tsx": 1,
  "src/components/viewer/TableCompareModal.tsx": 1,
  "src/components/viewer/TextAnnotationOverlay.tsx": 1,
  "src/components/viewer/TextPanel.tsx": 2,
};

const TEXTRACT_ACTION_READ_TOPOLOGY: Record<string, number> = {
  "src/components/viewer/AnnotationOverlay.tsx": 2,
  "src/components/viewer/GuidedParseTab.tsx": 1,
  "src/components/viewer/KeynotePanel.tsx": 1,
};

const TEXTRACT_BOOTSTRAP_OR_LOADER_FILES = [
  "src/app/(dashboard)/project/[id]/page.tsx",
  "src/app/demo/project/[id]/page.tsx",
  "src/hooks/useTextractLoader.ts",
] as const;

const parsedSourceCache = new Map<string, ts.SourceFile>();

function parse(relativePath: string): ts.SourceFile {
  const cached = parsedSourceCache.get(relativePath);
  if (cached) return cached;
  const absolutePath = join(process.cwd(), relativePath);
  const source = ts.createSourceFile(
    absolutePath,
    readFileSync(absolutePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  parsedSourceCache.set(relativePath, source);
  return source;
}

function canContainViewerStoreAccess(relativePath: string): boolean {
  if (relativePath === "src/stores/viewerStore.ts") return true;
  // Every sanctioned hook/getState path is defined by or imported from viewerStore. Pre-filtering
  // the ~700-file tree by raw module/name text keeps this AST tripwire below its full-suite timeout
  // without weakening aliases/casts/computed-key analysis inside any plausible consumer.
  return readFileSync(join(process.cwd(), relativePath), "utf8").includes("viewerStore");
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

function staticName(
  name: ts.PropertyName | ts.BindingName | undefined,
  stringConstants: ReadonlyMap<string, string> = new Map(),
): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) {
    const expression = unwrapExpression(name.expression);
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
      return expression.text;
    }
    if (ts.isIdentifier(expression)) return stringConstants.get(expression.text) ?? null;
  }
  return null;
}

function directObjectKeys(
  object: ts.ObjectLiteralExpression,
  stringConstants: ReadonlyMap<string, string> = new Map(),
): string[] {
  return object.properties
    .map((property) =>
      "name" in property ? staticName(property.name, stringConstants) : null,
    )
    .filter((name): name is string => name !== null);
}

function expectNoLegacyMembers(names: readonly string[]): void {
  for (const legacyName of LEGACY_PAGE_WINDOW_MEMBERS) {
    expect(names, `${legacyName} must remain query-owned`).not.toContain(legacyName);
  }
}

function findVariable(source: ts.SourceFile, name: string): ts.VariableDeclaration {
  const declarations = descendants(
    source,
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name,
  );
  expect(declarations, `${name} declaration`).toHaveLength(1);
  return declarations[0];
}

function findFunction(source: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const declarations = descendants(
    source,
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  expect(declarations, `${name} declaration`).toHaveLength(1);
  return declarations[0];
}

function findViewerStoreObject(source: ts.SourceFile): ts.ObjectLiteralExpression {
  const declaration = findVariable(source, "useViewerStore");
  expect(declaration.initializer && ts.isCallExpression(declaration.initializer)).toBe(true);
  const factory = (declaration.initializer as ts.CallExpression).arguments[0];
  expect(factory && ts.isArrowFunction(factory)).toBe(true);
  const body = (factory as ts.ArrowFunction).body;
  expect(ts.isParenthesizedExpression(body) || ts.isObjectLiteralExpression(body)).toBe(true);
  const unwrapped = ts.isParenthesizedExpression(body) ? body.expression : body;
  expect(ts.isObjectLiteralExpression(unwrapped)).toBe(true);
  return unwrapped as ts.ObjectLiteralExpression;
}

function sourceFilesUnder(relativeDirectory: string): string[] {
  const absoluteDirectory = join(process.cwd(), relativeDirectory);
  const files: string[] = [];
  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const relativePath = join(relativeDirectory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFilesUnder(relativePath));
    if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)) files.push(relativePath);
  }
  return files;
}

const legacyNames = new Set<string>(LEGACY_PAGE_WINDOW_MEMBERS);

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

function staticStringConstants(root: ts.Node): Map<string, string> {
  const constants = new Map<string, string>();
  // This lightweight source oracle is intentionally scope-insensitive. The same local identifier
  // can therefore appear with different literal values in unrelated functions. Treat that name as
  // ambiguous instead of oscillating forever between its values during fixed-point propagation.
  const ambiguous = new Set<string>();
  const declarations = descendants(root, ts.isVariableDeclaration);
  const publish = (name: string, value: string): boolean => {
    if (ambiguous.has(name)) return false;
    const existing = constants.get(name);
    if (existing === value) return false;
    if (existing !== undefined) {
      constants.delete(name);
      ambiguous.add(name);
      return true;
    }
    constants.set(name, value);
    return true;
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const initializer = unwrapExpression(declaration.initializer);
      let value: string | undefined;
      if (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)) {
        value = initializer.text;
      } else if (ts.isIdentifier(initializer)) {
        value = constants.get(initializer.text);
      }
      if (value !== undefined) changed = publish(declaration.name.text, value) || changed;
    }
  }
  return constants;
}

function elementAccessName(
  access: ts.ElementAccessExpression,
  stringConstants: ReadonlyMap<string, string>,
): string | null {
  const argument = access.argumentExpression && unwrapExpression(access.argumentExpression);
  if (!argument) return null;
  if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
    return argument.text;
  }
  return ts.isIdentifier(argument) ? stringConstants.get(argument.text) ?? null : null;
}

function expressionMemberName(
  expression: ts.Expression,
  stringConstants: ReadonlyMap<string, string>,
): string | null {
  const unwrapped = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(unwrapped)) return unwrapped.name.text;
  if (ts.isElementAccessExpression(unwrapped)) {
    return elementAccessName(unwrapped, stringConstants);
  }
  return null;
}

function importedLocalNames(
  source: ts.SourceFile,
  moduleName: string,
  importedName: string,
): Set<string> {
  const names = new Set<string>();
  for (const declaration of source.statements) {
    if (
      !ts.isImportDeclaration(declaration) ||
      !ts.isStringLiteral(declaration.moduleSpecifier) ||
      declaration.moduleSpecifier.text !== moduleName
    ) {
      continue;
    }
    const bindings = declaration.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === importedName) {
        names.add(element.name.text);
      }
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
      const initializer = unwrapExpression(declaration.initializer);
      if (
        ts.isIdentifier(initializer) &&
        aliases.has(initializer.text) &&
        !aliases.has(declaration.name.text)
      ) {
        aliases.add(declaration.name.text);
        changed = true;
      }
    }
    for (const assignment of descendants(
      root,
      (node): node is ts.BinaryExpression =>
        ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken,
    )) {
      const left = unwrapExpression(assignment.left);
      const right = unwrapExpression(assignment.right);
      if (
        ts.isIdentifier(left) &&
        ts.isIdentifier(right) &&
        aliases.has(right.text) &&
        !aliases.has(left.text)
      ) {
        aliases.add(left.text);
        changed = true;
      }
    }
  }
  return aliases;
}

function methodAliases(
  root: ts.Node,
  objectAliases: ReadonlySet<string>,
  method: "getState" | "setState",
  stringConstants: ReadonlyMap<string, string>,
): Set<string> {
  const aliases = new Set<string>();
  for (const declaration of descendants(root, ts.isVariableDeclaration)) {
    if (!declaration.initializer) continue;
    const initializer = unwrapExpression(declaration.initializer);
    if (ts.isIdentifier(declaration.name)) {
      if (
        (ts.isPropertyAccessExpression(initializer) ||
          ts.isElementAccessExpression(initializer)) &&
        ts.isIdentifier(unwrapExpression(initializer.expression)) &&
        objectAliases.has((unwrapExpression(initializer.expression) as ts.Identifier).text) &&
        expressionMemberName(initializer, stringConstants) === method
      ) {
        aliases.add(declaration.name.text);
      }
    } else if (ts.isObjectBindingPattern(declaration.name)) {
      const sourceObject = unwrapExpression(declaration.initializer);
      if (!ts.isIdentifier(sourceObject) || !objectAliases.has(sourceObject.text)) continue;
      for (const element of declaration.name.elements) {
        if (
          staticName(element.propertyName ?? element.name, stringConstants) === method &&
          ts.isIdentifier(element.name)
        ) {
          aliases.add(element.name.text);
        }
      }
    }
  }
  return identifierAliases(root, aliases);
}

function isMethodCall(
  call: ts.CallExpression,
  objectAliases: ReadonlySet<string>,
  functionAliases: ReadonlySet<string>,
  method: "getState" | "setState",
  stringConstants: ReadonlyMap<string, string>,
): boolean {
  const expression = unwrapExpression(call.expression);
  if (ts.isIdentifier(expression)) return functionAliases.has(expression.text);
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) {
    return false;
  }
  const receiver = unwrapExpression(expression.expression);
  return (
    ts.isIdentifier(receiver) &&
    objectAliases.has(receiver.text) &&
    expressionMemberName(expression, stringConstants) === method
  );
}

function bindingLegacyNames(
  name: ts.BindingName,
  stringConstants: ReadonlyMap<string, string>,
): string[] {
  if (!ts.isObjectBindingPattern(name)) return [];
  return name.elements
    .map((element) => staticName(element.propertyName ?? element.name, stringConstants))
    .filter((candidate): candidate is string => !!candidate && legacyNames.has(candidate));
}

function consumerOutsideTransparentCasts(expression: ts.Expression): ts.Node {
  let current: ts.Expression = expression;
  while (
    current.parent &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent)) &&
    current.parent.expression === current
  ) {
    current = current.parent;
  }
  return current.parent;
}

/**
 * Catch consumer-side resurrection as well as declarations. TypeScript normally catches a direct
 * stale member after deletion, but this source oracle also covers `as any`, handler-time aliases,
 * destructuring, and selector callbacks—the escape hatches most likely to compile during a rushed
 * future feature addition.
 */
function legacyConsumerAccesses(source: ts.SourceFile): string[] {
  const violations: string[] = [];
  const stringConstants = staticStringConstants(source);
  const viewerStoreHooks = identifierAliases(source, [
    "useViewerStore",
    ...importedLocalNames(source, "@/stores/viewerStore", "useViewerStore"),
  ]);
  const pageDataHooks = identifierAliases(source, [
    "usePageData",
    ...importedLocalNames(source, "@/stores/viewerStore", "usePageData"),
  ]);
  const getStateFunctions = methodAliases(
    source,
    viewerStoreHooks,
    "getState",
    stringConstants,
  );
  const setStateFunctions = methodAliases(
    source,
    viewerStoreHooks,
    "setState",
    stringConstants,
  );
  const calls = descendants(source, ts.isCallExpression);
  const isGetStateCall = (call: ts.CallExpression) =>
    isMethodCall(
      call,
      viewerStoreHooks,
      getStateFunctions,
      "getState",
      stringConstants,
    );
  const isSetStateCall = (call: ts.CallExpression) =>
    isMethodCall(
      call,
      viewerStoreHooks,
      setStateFunctions,
      "setState",
      stringConstants,
    );
  const isPageDataCall = (call: ts.CallExpression) => {
    const expression = unwrapExpression(call.expression);
    return ts.isIdentifier(expression) && pageDataHooks.has(expression.text);
  };

  const getStateResults = new Set<string>();
  const pageDataResults = new Set<string>();
  for (const declaration of descendants(source, ts.isVariableDeclaration)) {
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
    const initializer = unwrapExpression(declaration.initializer);
    if (ts.isCallExpression(initializer) && isGetStateCall(initializer)) {
      getStateResults.add(declaration.name.text);
    }
    if (ts.isCallExpression(initializer) && isPageDataCall(initializer)) {
      pageDataResults.add(declaration.name.text);
    }
  }
  const getStateAliases = identifierAliases(source, getStateResults);
  const pageDataAliases = identifierAliases(source, pageDataResults);

  for (const call of calls) {
    const callExpression = unwrapExpression(call.expression);
    if (ts.isIdentifier(callExpression) && viewerStoreHooks.has(callExpression.text)) {
      const selector = call.arguments[0];
      if (
        selector &&
        (ts.isArrowFunction(selector) || ts.isFunctionExpression(selector)) &&
        selector.parameters.length === 1
      ) {
        const parameterBinding = selector.parameters[0].name;
        violations.push(
          ...bindingLegacyNames(parameterBinding, stringConstants).map(
            (name) => `selector-parameter:${name}`,
          ),
        );
        if (ts.isIdentifier(parameterBinding)) {
          const stateAliases = identifierAliases(selector.body, [parameterBinding.text]);
          for (const access of descendants(selector.body, ts.isPropertyAccessExpression)) {
            const root = unwrapExpression(access.expression);
            if (
              ts.isIdentifier(root) &&
              stateAliases.has(root.text) &&
              legacyNames.has(access.name.text)
            ) {
              violations.push(`selector:${access.name.text}`);
            }
          }
          for (const access of descendants(selector.body, ts.isElementAccessExpression)) {
            const root = unwrapExpression(access.expression);
            const name = elementAccessName(access, stringConstants);
            if (
              ts.isIdentifier(root) &&
              stateAliases.has(root.text) &&
              name &&
              legacyNames.has(name)
            ) {
              violations.push(`selector-element:${name}`);
            }
          }
          for (const declaration of descendants(selector.body, ts.isVariableDeclaration)) {
            if (declaration.initializer) {
              const initializer = unwrapExpression(declaration.initializer);
              if (ts.isIdentifier(initializer) && stateAliases.has(initializer.text)) {
                violations.push(
                  ...bindingLegacyNames(declaration.name, stringConstants).map(
                    (name) => `selector-destructure:${name}`,
                  ),
                );
              }
            }
          }
        }
      }
    }

    if (isGetStateCall(call)) {
      const consumer = consumerOutsideTransparentCasts(call);
      if (ts.isPropertyAccessExpression(consumer) && legacyNames.has(consumer.name.text)) {
        violations.push(`getState-direct:${consumer.name.text}`);
      }
      if (ts.isElementAccessExpression(consumer)) {
        const name = elementAccessName(consumer, stringConstants);
        if (name && legacyNames.has(name)) violations.push(`getState-direct-element:${name}`);
      }
      if (ts.isVariableDeclaration(consumer)) {
        violations.push(
          ...bindingLegacyNames(consumer.name, stringConstants).map(
            (name) => `getState-destructure:${name}`,
          ),
        );
      }
    }

    if (isSetStateCall(call) && call.arguments[0]) {
      for (const object of descendants(call.arguments[0], ts.isObjectLiteralExpression)) {
        for (const key of directObjectKeys(object, stringConstants)) {
          if (legacyNames.has(key)) violations.push(`setState:${key}`);
        }
      }
    }

    if (isPageDataCall(call)) {
      const consumer = consumerOutsideTransparentCasts(call);
      if (ts.isVariableDeclaration(consumer)) {
        violations.push(
          ...bindingLegacyNames(consumer.name, stringConstants).map(
            (name) => `usePageData:${name}`,
          ),
        );
      }
      if (ts.isPropertyAccessExpression(consumer) && legacyNames.has(consumer.name.text)) {
        violations.push(`usePageData-direct:${consumer.name.text}`);
      }
      if (ts.isElementAccessExpression(consumer)) {
        const name = elementAccessName(consumer, stringConstants);
        if (name && legacyNames.has(name)) violations.push(`usePageData-element:${name}`);
      }
    }
  }

  for (const access of descendants(source, ts.isPropertyAccessExpression)) {
    const root = unwrapExpression(access.expression);
    if (
      ts.isIdentifier(root) &&
      getStateAliases.has(root.text) &&
      legacyNames.has(access.name.text)
    ) {
      violations.push(`getState-alias:${root.text}.${access.name.text}`);
    }
    if (
      ts.isIdentifier(root) &&
      pageDataAliases.has(root.text) &&
      legacyNames.has(access.name.text)
    ) {
      violations.push(`usePageData-alias:${root.text}.${access.name.text}`);
    }
  }
  for (const access of descendants(source, ts.isElementAccessExpression)) {
    const root = unwrapExpression(access.expression);
    const name = elementAccessName(access, stringConstants);
    if (
      ts.isIdentifier(root) &&
      getStateAliases.has(root.text) &&
      name &&
      legacyNames.has(name)
    ) {
      violations.push(`getState-alias-element:${root.text}[${name}]`);
    }
    if (
      ts.isIdentifier(root) &&
      pageDataAliases.has(root.text) &&
      name &&
      legacyNames.has(name)
    ) {
      violations.push(`usePageData-alias-element:${root.text}[${name}]`);
    }
  }
  return violations;
}

function directProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.ObjectLiteralElementLike {
  const matches = object.properties.filter(
    (property) => "name" in property && staticName(property.name) === name,
  );
  expect(matches, `${name} property`).toHaveLength(1);
  return matches[0];
}

function isProductionSource(relativePath: string): boolean {
  return (
    !relativePath.includes("/__tests__/") &&
    !/\.test\.(?:ts|tsx)$/.test(relativePath) &&
    !relativePath.startsWith("src/test/")
  );
}

function importedSymbolCalls(
  root: ts.Node,
  source: ts.SourceFile,
  moduleName: string,
  importedName: string,
): ts.CallExpression[] {
  const importedNames = importedLocalNames(source, moduleName, importedName);
  const aliases = identifierAliases(root, importedNames);
  return descendants(root, ts.isCallExpression).filter((call) => {
    const expression = unwrapExpression(call.expression);
    return ts.isIdentifier(expression) && aliases.has(expression.text);
  });
}

function importedSymbolCallCount(
  root: ts.Node,
  source: ts.SourceFile,
  moduleName: string,
  importedName: string,
): number {
  return importedSymbolCalls(root, source, moduleName, importedName).length;
}

function importedCallTopology(
  relativePaths: readonly string[],
  moduleName: string,
  importedName: string,
): Record<string, number> {
  const topology: Record<string, number> = {};
  for (const relativePath of relativePaths) {
    const source = parse(relativePath);
    const count = importedSymbolCallCount(source, source, moduleName, importedName);
    if (count > 0) topology[relativePath] = count;
  }
  return topology;
}

function callMemberNames(root: ts.Node): string[] {
  const constants = staticStringConstants(root);
  return descendants(root, ts.isCallExpression)
    .map((call) => expressionMemberName(call.expression, constants))
    .filter((name): name is string => name !== null);
}

function textractKeyReferenceCount(source: ts.SourceFile): number {
  const constants = staticStringConstants(source);
  const queryKeyNames = identifierAliases(
    source,
    importedLocalNames(source, "@/queries/queryKeys", "queryKeys"),
  );
  let count = 0;
  for (const access of [
    ...descendants(source, ts.isPropertyAccessExpression),
    ...descendants(source, ts.isElementAccessExpression),
  ]) {
    const receiver = unwrapExpression(access.expression);
    if (
      ts.isIdentifier(receiver) &&
      queryKeyNames.has(receiver.text) &&
      expressionMemberName(access, constants) === "textract"
    ) {
      count += 1;
    }
  }
  for (const array of descendants(source, ts.isArrayLiteralExpression)) {
    if (
      array.elements.some((element) => {
        const value = unwrapExpression(element);
        return (
          (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) &&
          value.text === "textract"
        );
      })
    ) {
      count += 1;
    }
  }
  return count;
}

function routeLiteralCount(source: ts.SourceFile, route: string): number {
  return descendants(
    source,
    (node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression =>
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node),
  ).filter((node) => node.getText(source).includes(route)).length;
}

describe("P2.2⑦ legacy page-window ownership deletion", () => {
  const viewerStore = parse("src/stores/viewerStore.ts");
  const summaries = parse("src/queries/useSummaries.ts");

  it("keeps legacy data and actions out of ViewerState and store defaults", () => {
    const interfaces = descendants(
      viewerStore,
      (node): node is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(node) && node.name.text === "ViewerState",
    );
    expect(interfaces).toHaveLength(1);

    const interfaceKeys = interfaces[0].members
      .map((member) => ("name" in member ? staticName(member.name) : null))
      .filter((name): name is string => name !== null);
    // P2.3 moved page navigation and tools to leaf owners; keep a residual metadata sentinel so this test still
    // proves it parsed the live ViewerState rather than an empty/wrong interface.
    expect(interfaceKeys).toEqual(expect.arrayContaining(["allTrades", "setAllTrades"]));
    expectNoLegacyMembers(interfaceKeys);

    const storeKeys = directObjectKeys(findViewerStoreObject(viewerStore));
    expect(storeKeys).toEqual(expect.arrayContaining(["allTrades", "setAllTrades"]));
    expectNoLegacyMembers(storeKeys);
  });

  it("keeps resetViewerState and usePageData from republishing legacy ownership", () => {
    const storeObject = findViewerStoreObject(viewerStore);
    const resetProperty = directProperty(storeObject, "resetViewerState");
    expect(ts.isPropertyAssignment(resetProperty)).toBe(true);
    const resetInitializer = (resetProperty as ts.PropertyAssignment).initializer;
    const resetSetCalls = descendants(
      resetInitializer,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "set" &&
        !!node.arguments[0] &&
        ts.isObjectLiteralExpression(node.arguments[0]),
    );
    expect(resetSetCalls).toHaveLength(1);
    const resetObject = resetSetCalls[0].arguments[0] as ts.ObjectLiteralExpression;
    const resetKeys = directObjectKeys(resetObject);
    expect(resetKeys).toEqual(expect.arrayContaining(["allTrades"]));
    expectNoLegacyMembers(resetKeys);

    const pageData = findVariable(viewerStore, "usePageData");
    const selectorObjects = descendants(pageData, ts.isObjectLiteralExpression).filter((object) => {
      const keys = directObjectKeys(object);
      return keys.includes("allCsiCodes");
    });
    expect(selectorObjects, "usePageData selector result").toHaveLength(1);
    const selectorObject = selectorObjects[0];
    // P2.3 moves the CSI presentation filter/action to uiStore; this residual viewer facade is
    // bootstrap-derived catalog data only.
    expect(directObjectKeys(selectorObject)).toEqual(["allCsiCodes"]);

    const selectedStoreMembers = descendants(
      selectorObject,
      (node): node is ts.PropertyAccessExpression =>
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "s",
    ).map((access) => access.name.text);
    expectNoLegacyMembers(selectedStoreMembers);
  });

  it("keeps useSummaries an exact cache-only two-field delegate", () => {
    const narrowHook = findFunction(summaries, "useSummariesData");
    expect(narrowHook.type && ts.isTypeLiteralNode(narrowHook.type)).toBe(true);
    const returnTypeKeys = (narrowHook.type as ts.TypeLiteralNode).members
      .map((member) => ("name" in member ? staticName(member.name) : null))
      .filter((name): name is string => name !== null);
    expect(returnTypeKeys).toEqual(["summaries", "setSummaries"]);

    const narrowReturnObjects = descendants(narrowHook.body!, ts.isReturnStatement)
      .map((statement) => statement.expression)
      .filter((expression): expression is ts.ObjectLiteralExpression =>
        !!expression && ts.isObjectLiteralExpression(expression),
      );
    expect(narrowReturnObjects).toHaveLength(1);
    expect(directObjectKeys(narrowReturnObjects[0])).toEqual(["summaries", "setSummaries"]);

    const compatibilityHook = findFunction(summaries, "useSummaries");
    expect(compatibilityHook.body?.statements).toHaveLength(1);
    const onlyStatement = compatibilityHook.body!.statements[0];
    expect(ts.isReturnStatement(onlyStatement) && onlyStatement.expression).toBeTruthy();
    const returnExpression = (onlyStatement as ts.ReturnStatement).expression!;
    expect(ts.isCallExpression(returnExpression)).toBe(true);
    const delegateCall = returnExpression as ts.CallExpression;
    expect(ts.isIdentifier(delegateCall.expression) && delegateCall.expression.text).toBe(
      "useSummariesData",
    );
    expect(delegateCall.arguments).toHaveLength(0);

    const referencedNames = descendants(
      compatibilityHook.body!,
      (node): node is ts.Identifier => ts.isIdentifier(node),
    ).map((identifier) => identifier.text);
    expectNoLegacyMembers(referencedNames);
  });

  it("self-calibrates the consumer oracle against cast, destructure, alias, and element escapes", () => {
    const fixture = ts.createSourceFile(
      "legacy-escape-fixture.tsx",
      `
        import {
          useViewerStore as importedStoreHook,
          usePageData as importedPageData,
        } from "@/stores/viewerStore";
        useViewerStore(({ pageIntelligence }: any) => pageIntelligence);
        useViewerStore((state: any) => state["keynotes"]);
        const { csiCodes } = useViewerStore.getState() as any;
        const store = useViewerStore.getState() as any;
        store["textAnnotations"];
        (usePageData() as any)["loadedPageRange"];
        useViewerStore.setState({ ["chunkLoading"]: true });
        useViewerStore((state: any) => state.textractData);
        const { setTextractData } = useViewerStore.getState() as any;

        const hookAlias = importedStoreHook;
        const computedTextract = "textractData";
        hookAlias((state: any) => {
          const selectorAlias = state as any;
          return selectorAlias[computedTextract];
        });
        const getStateAlias = importedStoreHook.getState;
        getStateAlias().setTextractData;
        const storeAlias = getStateAlias() as any;
        storeAlias[computedTextract];
        const pageHookAlias = importedPageData;
        const pageResultAlias = pageHookAlias() as any;
        pageResultAlias.setTextractData;
        const setStateAlias = importedStoreHook.setState;
        setStateAlias({ [computedTextract]: {} });
      `,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    expect(legacyConsumerAccesses(fixture)).toEqual(
      expect.arrayContaining([
        "selector-parameter:pageIntelligence",
        "selector-element:keynotes",
        "getState-destructure:csiCodes",
        "getState-alias-element:store[textAnnotations]",
        "usePageData-element:loadedPageRange",
        "setState:chunkLoading",
        "selector:textractData",
        "getState-destructure:setTextractData",
        "selector-element:textractData",
        "getState-direct:setTextractData",
        "getState-alias-element:storeAlias[textractData]",
        "usePageData-alias:pageResultAlias.setTextractData",
        "setState:textractData",
      ]),
    );
  });

  it("keeps store declarations and every client consumer off direct, aliased, and casted access", () => {
    const violations = sourceFilesUnder("src")
      .filter(canContainViewerStoreAccess)
      .flatMap((relativePath) =>
        legacyConsumerAccesses(parse(relativePath)).map(
          (violation) => `${relativePath}:${violation}`,
        ),
      );
    expect(violations).toEqual([]);
  }, 15_000);

  it.each([
    "src/app/(dashboard)/project/[id]/page.tsx",
    "src/app/demo/project/[id]/page.tsx",
  ])("clears only the previous Textract prefix before %s resets UI state", (relativePath) => {
    const source = parse(relativePath);
    const clearCalls = importedSymbolCalls(
      source,
      source,
      "@/queries/textractCache",
      "clearTextractProject",
    );
    const resetCalls = descendants(source, ts.isCallExpression).filter(
      (call) => ts.isIdentifier(call.expression) && call.expression.text === "resetProjectData",
    );

    expect(clearCalls).toHaveLength(1);
    expect(resetCalls).toHaveLength(1);
    expect(clearCalls[0].getStart(source)).toBeLessThan(resetCalls[0].getStart(source));
    expect(ts.isAwaitExpression(clearCalls[0].parent), "clear must finish before reset").toBe(true);
    expect(clearCalls[0].arguments).toHaveLength(2);
    expect(
      ts.isIdentifier(clearCalls[0].arguments[0]) && clearCalls[0].arguments[0].text,
    ).toBe("queryClient");
    expect(
      ts.isIdentifier(clearCalls[0].arguments[1]) && clearCalls[0].arguments[1].text,
    ).toBe("previousPublicId");

    const previousPublicId = findVariable(source, "previousPublicId");
    expect(previousPublicId.initializer).toBeTruthy();
    const capture = unwrapExpression(previousPublicId.initializer!);
    expect(ts.isPropertyAccessExpression(capture) && capture.name.text).toBe("publicId");
    const getStateCall = ts.isPropertyAccessExpression(capture)
      ? unwrapExpression(capture.expression)
      : undefined;
    expect(getStateCall && ts.isCallExpression(getStateCall)).toBe(true);
    const stringConstants = staticStringConstants(source);
    const sessionHooks = identifierAliases(source, [
      ...importedLocalNames(source, "@/stores/sessionStore", "useSessionStore"),
    ]);
    const getStateFunctions = methodAliases(
      source,
      sessionHooks,
      "getState",
      stringConstants,
    );
    expect(
      getStateCall &&
        ts.isCallExpression(getStateCall) &&
        isMethodCall(
          getStateCall,
          sessionHooks,
          getStateFunctions,
          "getState",
          stringConstants,
        ),
      "previousPublicId must capture live sessionStore publicId",
    ).toBe(true);

    // OCR has no bootstrap payload. A helper seed here would both widen the response and create a
    // second automatic transport owner beside the preserved 200 ms controller.
    expect(
      importedSymbolCallCount(source, source, "@/test/seed-textract", "seedTextract"),
    ).toBe(0);
    expect(
      importedSymbolCallCount(
        source,
        source,
        "@/queries/textractCache",
        "replaceTextractForPage",
      ),
    ).toBe(0);
    expect(textractKeyReferenceCount(source)).toBe(0);
    expect(callMemberNames(source)).not.toContain("setQueryData");
  });

  it("pins exact per-page, action-only, and passive Textract consumer topology", () => {
    const productionSources = sourceFilesUnder("src").filter(isProductionSource);
    expect(
      importedCallTopology(
        productionSources,
        "@/queries/useTextract",
        "useTextractForPage",
      ),
    ).toEqual(TEXTRACT_PAGE_HOOK_TOPOLOGY);
    expect(
      importedCallTopology(
        productionSources,
        "@/queries/textractCache",
        "readTextractForPage",
      ),
    ).toEqual(TEXTRACT_ACTION_READ_TOPOLOGY);
    expect(
      importedCallTopology(
        productionSources,
        "@/queries/useTextract",
        "useCachedTextractForPages",
      ),
    ).toEqual({ "src/components/viewer/PageSidebar.tsx": 1 });
  }, 15_000);

  it("pins the sole GET owner and the facade-only rerun writer", () => {
    const productionSources = sourceFilesUnder("src").filter(isProductionSource);
    const getOwners = productionSources.flatMap((relativePath) => {
      const source = parse(relativePath);
      return Array.from(
        { length: routeLiteralCount(source, "/api/pages/textract?") },
        () => relativePath,
      );
    });
    expect(getOwners).toEqual(["src/queries/textractCache.ts"]);

    expect(
      importedCallTopology(
        productionSources,
        "@/queries/textractCache",
        "replaceTextractForPage",
      ),
    ).toEqual({ "src/components/viewer/TextPanel.tsx": 1 });
    expect(
      importedCallTopology(
        productionSources,
        "@/queries/textractCache",
        "ensureTextractPage",
      ),
    ).toEqual({ "src/hooks/useTextractLoader.ts": 1 });

    const textPanel = parse("src/components/viewer/TextPanel.tsx");
    const textractTab = findFunction(textPanel, "TextractTab");
    expect(
      importedSymbolCallCount(
        textractTab,
        textPanel,
        "@/queries/textractCache",
        "cancelTextractPage",
      ),
    ).toBe(1);
    expect(
      importedSymbolCallCount(
        textractTab,
        textPanel,
        "@/queries/textractCache",
        "replaceTextractForPage",
      ),
    ).toBe(1);
    const rerunMemberCalls = callMemberNames(textractTab);
    for (const forbidden of ["invalidateQueries", "setQueryData", "removeQueries", "setData"]) {
      expect(rerunMemberCalls, forbidden).not.toContain(forbidden);
    }
  }, 15_000);

  it("keeps controller and project bootstraps free of direct Textract cache writers", () => {
    for (const relativePath of TEXTRACT_BOOTSTRAP_OR_LOADER_FILES) {
      const source = parse(relativePath);
      expect(
        importedSymbolCallCount(
          source,
          source,
          "@/test/seed-textract",
          "seedTextract",
        ),
        relativePath,
      ).toBe(0);
      expect(
        importedSymbolCallCount(
          source,
          source,
          "@/queries/textractCache",
          "replaceTextractForPage",
        ),
        relativePath,
      ).toBe(0);
      expect(textractKeyReferenceCount(source), relativePath).toBe(0);
      expect(callMemberNames(source), relativePath).not.toContain("setQueryData");
    }
  });

  // This intentionally parses every production source. The suite can run several equivalent
  // topology scans concurrently, so use a contention-safe local budget rather than Vitest's
  // default/15s unit-test envelope; assertions remain source-exact and finish ~6s in isolation.
  it("pins whole-map observers to the approved scan-all product surfaces", () => {
    const productionSources = sourceFilesUnder("src").filter(isProductionSource);
    const actual = Object.fromEntries(
      Object.keys(WHOLE_MAP_HOOK_WHITELIST).map((hookName) => [hookName, [] as string[]]),
    ) as Record<keyof typeof WHOLE_MAP_HOOK_WHITELIST, string[]>;

    for (const relativePath of productionSources) {
      const source = parse(relativePath);
      for (const hookName of Object.keys(WHOLE_MAP_HOOK_WHITELIST) as Array<
        keyof typeof WHOLE_MAP_HOOK_WHITELIST
      >) {
        const moduleName = hookName === "useCachedTextractForPages"
          ? "@/queries/useTextract"
          : "@/queries/usePageWindow";
        const count = importedSymbolCallCount(source, source, moduleName, hookName);
        for (let index = 0; index < count; index += 1) {
          actual[hookName].push(relativePath);
        }
      }
    }

    for (const [hookName, expectedFiles] of Object.entries(WHOLE_MAP_HOOK_WHITELIST)) {
      expect([...new Set(actual[hookName as keyof typeof actual])].sort(), hookName).toEqual(
        [...expectedFiles].sort(),
      );
    }
  }, 60_000);
});
