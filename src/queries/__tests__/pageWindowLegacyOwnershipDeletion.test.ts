// @vitest-environment node
// [refactor jul11 P2.2⑦ M6] Deletion tripwire for the retired viewerStore ownership path.
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
} as const;

function parse(relativePath: string): ts.SourceFile {
  const absolutePath = join(process.cwd(), relativePath);
  return ts.createSourceFile(
    absolutePath,
    readFileSync(absolutePath, "utf8"),
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

function staticName(name: ts.PropertyName | ts.BindingName | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) {
    const expression = unwrapExpression(name.expression);
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
      return expression.text;
    }
  }
  return null;
}

function directObjectKeys(object: ts.ObjectLiteralExpression): string[] {
  return object.properties
    .map((property) => ("name" in property ? staticName(property.name) : null))
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

function bindingLegacyNames(name: ts.BindingName): string[] {
  if (!ts.isObjectBindingPattern(name)) return [];
  return name.elements
    .map((element) => staticName(element.propertyName ?? element.name))
    .filter((candidate): candidate is string => !!candidate && legacyNames.has(candidate));
}

function isViewerStoreMethodCall(
  node: ts.CallExpression,
  method: "getState" | "setState",
): boolean {
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "useViewerStore" &&
    node.expression.name.text === method
  );
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

function elementAccessName(access: ts.ElementAccessExpression): string | null {
  const argument = access.argumentExpression && unwrapExpression(access.argumentExpression);
  return argument &&
    (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
    ? argument.text
    : null;
}

/**
 * Catch consumer-side resurrection as well as declarations. TypeScript normally catches a direct
 * stale member after deletion, but this source oracle also covers `as any`, handler-time aliases,
 * destructuring, and selector callbacks—the escape hatches most likely to compile during a rushed
 * future feature addition.
 */
function legacyConsumerAccesses(source: ts.SourceFile): string[] {
  const violations: string[] = [];
  const getStateAliases = new Set<string>();
  const calls = descendants(source, ts.isCallExpression);

  for (const call of calls) {
    if (ts.isIdentifier(call.expression) && call.expression.text === "useViewerStore") {
      const selector = call.arguments[0];
      if (
        selector &&
        (ts.isArrowFunction(selector) || ts.isFunctionExpression(selector)) &&
        selector.parameters.length === 1
      ) {
        const parameterBinding = selector.parameters[0].name;
        violations.push(
          ...bindingLegacyNames(parameterBinding).map((name) => `selector-parameter:${name}`),
        );
        if (ts.isIdentifier(parameterBinding)) {
          const parameter = parameterBinding.text;
          for (const access of descendants(selector.body, ts.isPropertyAccessExpression)) {
            const root = unwrapExpression(access.expression);
            if (
              ts.isIdentifier(root) &&
              root.text === parameter &&
              legacyNames.has(access.name.text)
            ) {
              violations.push(`selector:${access.name.text}`);
            }
          }
          for (const access of descendants(selector.body, ts.isElementAccessExpression)) {
            const root = unwrapExpression(access.expression);
            const name = elementAccessName(access);
            if (
              ts.isIdentifier(root) &&
              root.text === parameter &&
              name &&
              legacyNames.has(name)
            ) {
              violations.push(`selector-element:${name}`);
            }
          }
          for (const declaration of descendants(selector.body, ts.isVariableDeclaration)) {
            if (declaration.initializer) {
              const initializer = unwrapExpression(declaration.initializer);
              if (ts.isIdentifier(initializer) && initializer.text === parameter) {
                violations.push(
                  ...bindingLegacyNames(declaration.name).map(
                    (name) => `selector-destructure:${name}`,
                  ),
                );
              }
            }
          }
        }
      }
    }

    if (isViewerStoreMethodCall(call, "getState")) {
      const consumer = consumerOutsideTransparentCasts(call);
      if (ts.isPropertyAccessExpression(consumer) && legacyNames.has(consumer.name.text)) {
        violations.push(`getState-direct:${consumer.name.text}`);
      }
      if (ts.isElementAccessExpression(consumer)) {
        const name = elementAccessName(consumer);
        if (name && legacyNames.has(name)) violations.push(`getState-direct-element:${name}`);
      }
      if (ts.isVariableDeclaration(consumer)) {
        if (ts.isIdentifier(consumer.name)) getStateAliases.add(consumer.name.text);
        violations.push(
          ...bindingLegacyNames(consumer.name).map((name) => `getState-destructure:${name}`),
        );
      }
    }

    if (isViewerStoreMethodCall(call, "setState") && call.arguments[0]) {
      for (const object of descendants(call.arguments[0], ts.isObjectLiteralExpression)) {
        for (const key of directObjectKeys(object)) {
          if (legacyNames.has(key)) violations.push(`setState:${key}`);
        }
      }
    }

    if (ts.isIdentifier(call.expression) && call.expression.text === "usePageData") {
      const consumer = consumerOutsideTransparentCasts(call);
      if (ts.isVariableDeclaration(consumer)) {
        violations.push(
          ...bindingLegacyNames(consumer.name).map((name) => `usePageData:${name}`),
        );
      }
      if (ts.isPropertyAccessExpression(consumer) && legacyNames.has(consumer.name.text)) {
        violations.push(`usePageData-direct:${consumer.name.text}`);
      }
      if (ts.isElementAccessExpression(consumer)) {
        const name = elementAccessName(consumer);
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
  }
  for (const access of descendants(source, ts.isElementAccessExpression)) {
    const root = unwrapExpression(access.expression);
    const name = elementAccessName(access);
    if (
      ts.isIdentifier(root) &&
      getStateAliases.has(root.text) &&
      name &&
      legacyNames.has(name)
    ) {
      violations.push(`getState-alias-element:${root.text}[${name}]`);
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
    expect(interfaceKeys).toEqual(expect.arrayContaining(["pageNumber", "setPage"]));
    expectNoLegacyMembers(interfaceKeys);

    const storeKeys = directObjectKeys(findViewerStoreObject(viewerStore));
    expect(storeKeys).toEqual(expect.arrayContaining(["pageNumber", "setPage"]));
    expectNoLegacyMembers(storeKeys);
  });

  it("keeps resetProjectData and usePageData from republishing legacy ownership", () => {
    const storeObject = findViewerStoreObject(viewerStore);
    const resetProperty = directProperty(storeObject, "resetProjectData");
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
    expect(resetKeys).toEqual(expect.arrayContaining(["pageNumber", "publicId"]));
    expectNoLegacyMembers(resetKeys);

    const pageData = findVariable(viewerStore, "usePageData");
    const selectorObjects = descendants(pageData, ts.isObjectLiteralExpression).filter((object) => {
      const keys = directObjectKeys(object);
      return keys.includes("textractData") && keys.includes("setTextractData");
    });
    expect(selectorObjects, "usePageData selector result").toHaveLength(1);
    const selectorObject = selectorObjects[0];
    expect(directObjectKeys(selectorObject)).toEqual([
      "textractData",
      "setTextractData",
      "allCsiCodes",
      "activeCsiFilter",
      "setCsiFilter",
    ]);

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
        useViewerStore(({ pageIntelligence }: any) => pageIntelligence);
        useViewerStore((state: any) => state["keynotes"]);
        const { csiCodes } = useViewerStore.getState() as any;
        const store = useViewerStore.getState() as any;
        store["textAnnotations"];
        (usePageData() as any)["loadedPageRange"];
        useViewerStore.setState({ ["chunkLoading"]: true });
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
      ]),
    );
  });

  it("keeps every client production/test consumer off direct, aliased, and casted store access", () => {
    const violations = sourceFilesUnder("src")
      .filter((relativePath) => relativePath !== "src/stores/viewerStore.ts")
      .flatMap((relativePath) =>
        legacyConsumerAccesses(parse(relativePath)).map(
          (violation) => `${relativePath}:${violation}`,
        ),
      );
    expect(violations).toEqual([]);
  }, 15_000);

  it("pins whole-map observers to the approved scan-all product surfaces", () => {
    const productionSources = sourceFilesUnder("src").filter(
      (relativePath) => !relativePath.includes("/__tests__/") && !relativePath.endsWith(".test.tsx"),
    );
    const actual = Object.fromEntries(
      Object.keys(WHOLE_MAP_HOOK_WHITELIST).map((hookName) => [hookName, [] as string[]]),
    ) as Record<keyof typeof WHOLE_MAP_HOOK_WHITELIST, string[]>;

    for (const relativePath of productionSources) {
      const source = parse(relativePath);
      for (const call of descendants(source, ts.isCallExpression)) {
        if (
          ts.isIdentifier(call.expression) &&
          call.expression.text in WHOLE_MAP_HOOK_WHITELIST
        ) {
          actual[call.expression.text as keyof typeof WHOLE_MAP_HOOK_WHITELIST].push(
            relativePath,
          );
        }
      }
    }

    for (const [hookName, expectedFiles] of Object.entries(WHOLE_MAP_HOOK_WHITELIST)) {
      expect([...new Set(actual[hookName as keyof typeof actual])].sort(), hookName).toEqual(
        [...expectedFiles].sort(),
      );
    }
  }, 15_000);
});
