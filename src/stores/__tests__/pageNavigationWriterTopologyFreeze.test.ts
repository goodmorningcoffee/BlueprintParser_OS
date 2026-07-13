// @vitest-environment node
// [refactor jul13 P2.3 AT2] Fail-closed page and Tool authority for the current destination.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const VIEWER_COMMANDS_FILE = "src/stores/viewerCommands.ts";
const VIEWER_CORE_FILE = "src/stores/viewerCoreStore.ts";
const VIEWER_CORE_MODULE = "@/stores/viewerCoreStore";
const PAGE_WRITER_OWNERS = new Set([VIEWER_COMMANDS_FILE, VIEWER_CORE_FILE]);

function sourceOf(path: string, text = readFileSync(join(process.cwd(), path), "utf8")) {
  return ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
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

function accessedName(expression: ts.Expression): string | null {
  const candidate = unwrap(expression);
  if (ts.isPropertyAccessExpression(candidate)) return candidate.name.text;
  if (ts.isElementAccessExpression(candidate) && candidate.argumentExpression) {
    const argument = unwrap(candidate.argumentExpression);
    return ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)
      ? argument.text
      : null;
  }
  return null;
}

function normalizedModulePath(path: string): string {
  return normalize(path).replace(/\\/g, "/").replace(/\.(?:ts|tsx)$/, "").replace(/\/index$/, "");
}

function resolvesToViewerCore(importer: string, specifier: string): boolean {
  let candidate = "";
  if (specifier === VIEWER_CORE_MODULE) candidate = VIEWER_CORE_FILE;
  else if (specifier.startsWith("@/")) candidate = join("src", specifier.slice(2));
  else if (specifier.startsWith(".")) candidate = join(dirname(importer), specifier);
  return normalizedModulePath(candidate) === normalizedModulePath(VIEWER_CORE_FILE);
}

function containsIdentifier(node: ts.Node, names: ReadonlySet<string>): boolean {
  return descendants(node, ts.isIdentifier).some((identifier) => names.has(identifier.text));
}

function enclosingFunctionName(node: ts.Node): string {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      if (
        ts.isVariableDeclaration(current.parent) &&
        ts.isIdentifier(current.parent.name)
      ) return current.parent.name.text;
      if (
        ts.isPropertyAssignment(current.parent) &&
        current.parent.initializer === current
      ) return staticName(current.parent.name) ?? "anonymous-property";
    }
    current = current.parent;
  }
  return "module";
}

function declaredFunction(source: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const declaration = descendants(source, ts.isFunctionDeclaration)
    .find((candidate) => candidate.name?.text === name);
  if (!declaration?.body) throw new Error(`Missing function body: ${name}`);
  return declaration;
}

function compactText(node: ts.Node, source: ts.SourceFile): string {
  return node.getText(source).replace(/\s+/g, " ");
}

function productionFiles(directory = "src"): string[] {
  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(join(process.cwd(), current), { withFileTypes: true })) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (/\.(?:ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) files.push(child);
    }
  };
  visit(directory);
  return files.sort().filter((path) =>
    !path.includes("/__tests__/") &&
    !path.startsWith("src/test/") &&
    !/\.(?:test|spec)\.(?:ts|tsx)$/.test(path)
  );
}

function pageWriterViolations(source: ts.SourceFile): string[] {
  const violations: Array<{ position: number; label: string }> = [];
  const record = (node: ts.Node, kind: string): void => {
    violations.push({
      position: node.getStart(source),
      label: `${enclosingFunctionName(node)}:${kind}`,
    });
  };

  // Track the two public entry surfaces and simple aliases so `const nav = useNavigation()` and
  // `const core = useViewerCoreStore.getState()` cannot disguise a borrowed raw destination.
  const ownerAliases = new Set(["useViewerCoreStore", "useNavigation"]);
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
      !resolvesToViewerCore(source.fileName, statement.moduleSpecifier.text) ||
      !statement.importClause?.namedBindings
    ) continue;
    const bindings = statement.importClause.namedBindings;
    if (ts.isNamespaceImport(bindings)) ownerAliases.add(bindings.name.text);
    else {
      for (const element of bindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        if (imported === "useViewerCoreStore" || imported === "useNavigation") {
          ownerAliases.add(element.name.text);
        }
      }
    }
  }
  const declarations = descendants(source, ts.isVariableDeclaration);
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      if (
        !ownerAliases.has(declaration.name.text) &&
        containsIdentifier(declaration.initializer, ownerAliases)
      ) {
        ownerAliases.add(declaration.name.text);
        changed = true;
      }
    }
  }

  const belongsToPageOwner = (node: ts.Node): boolean => containsIdentifier(node, ownerAliases);
  const isInsideViewerCoreSelector = (node: ts.Node): boolean => {
    let current: ts.Node | undefined = node.parent;
    while (current && !ts.isSourceFile(current)) {
      if (
        ts.isCallExpression(current) &&
        ts.isIdentifier(unwrap(current.expression)) &&
        unwrap(current.expression).getText(source) === "useViewerCoreStore"
      ) return true;
      current = current.parent;
    }
    return false;
  };

  const patchDeclarations = new Map<string, ts.Expression>();
  for (const declaration of declarations) {
    if (ts.isIdentifier(declaration.name) && declaration.initializer) {
      patchDeclarations.set(declaration.name.text, declaration.initializer);
    }
  }
  const patchContainsPageNumber = (
    expression: ts.Expression,
    seen = new Set<string>(),
  ): boolean => {
    const candidate = unwrap(expression);
    if (ts.isIdentifier(candidate)) {
      if (seen.has(candidate.text)) return false;
      const initializer = patchDeclarations.get(candidate.text);
      if (!initializer) return false;
      seen.add(candidate.text);
      return patchContainsPageNumber(initializer, seen);
    }
    return descendants(
      candidate,
      (node): node is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
        ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node),
    ).some((property) => {
      const name = ts.isShorthandPropertyAssignment(property)
        ? property.name.text
        : staticName(property.name);
      return name === "pageNumber";
    });
  };

  if (normalizedModulePath(source.fileName) === normalizedModulePath(VIEWER_CORE_FILE)) {
    for (const property of descendants(source, ts.isPropertyAssignment)) {
      if (staticName(property.name) !== "setPage") continue;
      const initializer = unwrap(property.initializer);
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
        record(property, "raw-setPage-definition");
      }
    }
  }

  // Calling or merely borrowing the raw leaf setter bypasses the Parse-first command boundary.
  for (const access of descendants(
    source,
    (node): node is ts.PropertyAccessExpression | ts.ElementAccessExpression =>
      ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node),
  )) {
    if (accessedName(access) !== "setPage") continue;
    if (belongsToPageOwner(access.expression) || isInsideViewerCoreSelector(access)) {
      record(access, "raw-setPage");
    }
  }

  // Destructuring is itself a forbidden borrow, including renaming the leaf before later use.
  for (const binding of descendants(source, ts.isBindingElement)) {
    if (staticName(binding.propertyName ?? binding.name) !== "setPage") continue;
    const pattern = binding.parent;
    const declaration = ts.isObjectBindingPattern(pattern) && ts.isVariableDeclaration(pattern.parent)
      ? pattern.parent
      : null;
    if (declaration?.initializer && belongsToPageOwner(declaration.initializer)) {
      record(binding, "raw-setPage-binding");
    }
  }

  // Raw Zustand publications of pageNumber are the other way to bypass the central command.
  for (const call of descendants(source, ts.isCallExpression)) {
    const callee = unwrap(call.expression);
    const ownerSetState =
      (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
      accessedName(callee) === "setState" && belongsToPageOwner(callee.expression);
    const coreFactorySet = normalizedModulePath(source.fileName) === normalizedModulePath(VIEWER_CORE_FILE) &&
      ts.isIdentifier(callee) && callee.text === "set";
    if (!ownerSetState && !coreFactorySet) continue;
    const patch = call.arguments[0];
    if (!patch) continue;
    if (ts.isIdentifier(unwrap(patch)) && patchContainsPageNumber(patch)) {
      record(call, "raw-pageNumber-aliased-patch");
      continue;
    }
    for (const property of descendants(
      patch,
      (node): node is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
        ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node),
    )) {
      const name = ts.isShorthandPropertyAssignment(property)
        ? property.name.text
        : staticName(property.name);
      if (name === "pageNumber") record(property, "raw-pageNumber-patch");
    }
  }


  for (const call of descendants(source, ts.isCallExpression)) {
    const callee = unwrap(call.expression);
    if (
      !(ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) ||
      accessedName(callee) !== "assign" ||
      !ts.isIdentifier(unwrap(callee.expression)) ||
      (unwrap(callee.expression) as ts.Identifier).text !== "Object"
    ) continue;
    const [target, ...patches] = call.arguments;
    if (!target || !belongsToPageOwner(target) ||
        !patches.some((patch) => patchContainsPageNumber(patch))) continue;
    record(call, "raw-pageNumber-object-assign");
  }

  // Close the imperative mutation spelling as well as the normal Zustand publication spelling.
  for (const binary of descendants(source, ts.isBinaryExpression)) {
    if (
      binary.operatorToken.kind < ts.SyntaxKind.FirstAssignment ||
      binary.operatorToken.kind > ts.SyntaxKind.LastAssignment
    ) continue;
    const left = unwrap(binary.left);
    if (
      (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) &&
      accessedName(left) === "pageNumber" &&
      belongsToPageOwner(left.expression)
    ) record(binary, "raw-pageNumber-assignment");
  }
  for (const unary of descendants(
    source,
    (node): node is ts.PrefixUnaryExpression | ts.PostfixUnaryExpression =>
      ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node),
  )) {
    if (unary.operator !== ts.SyntaxKind.PlusPlusToken &&
        unary.operator !== ts.SyntaxKind.MinusMinusToken) continue;
    const operand = unwrap(unary.operand);
    if (
      (ts.isPropertyAccessExpression(operand) || ts.isElementAccessExpression(operand)) &&
      accessedName(operand) === "pageNumber" && belongsToPageOwner(operand.expression)
    ) record(unary, "raw-pageNumber-update");
  }
  for (const deletion of descendants(source, ts.isDeleteExpression)) {
    const expression = unwrap(deletion.expression);
    if (
      (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) &&
      accessedName(expression) === "pageNumber" && belongsToPageOwner(expression.expression)
    ) record(deletion, "raw-pageNumber-delete");
  }

  return violations
    .sort((left, right) => left.position - right.position)
    .map(({ label }) => label);
}

describe("A2e current-page writer ownership", () => {
  it("pins every raw page destination to an exact command/core owner manifest", () => {
    const violations = productionFiles()
      .filter((path) => !PAGE_WRITER_OWNERS.has(path))
      .flatMap((path) => pageWriterViolations(sourceOf(path)).map((write) => ({ path, write })));

    expect(violations).toEqual([]);
    expect(Object.fromEntries([...PAGE_WRITER_OWNERS].map((path) => [
      path,
      pageWriterViolations(sourceOf(path)),
    ]))).toEqual({
      [VIEWER_COMMANDS_FILE]: [
        "navigateViewerPage:raw-setPage",
        "navigateViewerPageUnclamped:raw-pageNumber-patch",
        "openNotesParseTarget:raw-setPage",
        "openSpecParseTarget:raw-setPage",
        "openTableReviewTarget:raw-setPage",
      ],
      [VIEWER_CORE_FILE]: [
        "module:raw-setPage-definition",
        "setPage:raw-pageNumber-patch",
        "useNavigation:raw-setPage",
      ],
    });
  }, 120_000);

  it("pins Viewer -> Tool -> conditional Parse -> Core -> exact Tool closer -> operation Parse", () => {
    const source = sourceOf(VIEWER_COMMANDS_FILE);
    const boundary = declaredFunction(source, "publishViewerPageBoundary");
    expect(boundary.body!.statements.map((statement) => compactText(statement, source))).toEqual([
      "invalidateToolTailAuthority();",
      "useViewerStore.setState({ _drawing: false, _mousePos: null });",
      "const installedPageTool = publishToolPageExit();",
      "useParseFlowStore.setState((state) => legacyParsePageExitPatch(state) ?? state);",
      "const preCoreToolState = useToolStore.getState();",
      "const cleanupSubscriberTool = preCoreToolState.activeTool;",
      "const cleanupSubscriberChangedTool = cleanupSubscriberTool !== installedPageTool || hasUnsettledPageLocalToolState(preCoreToolState);",
      "invalidateToolTailAuthority();",
      "installCorePage();",
      "if (cleanupSubscriberChangedTool) publishToolPageExitExact(cleanupSubscriberTool);",
      "publishPageOperationBoundary();",
    ]);

    const toolExit = compactText(declaredFunction(source, "publishToolPageExit"), source);
    expect(toolExit).toContain("installedActiveTool = activeToolAfterPageChange(state)");
    expect(toolExit).toContain("return toolPageExitPatch(installedActiveTool)");
    expect(toolExit).not.toMatch(/\bmode\s*:/);
    const exactToolExit = compactText(declaredFunction(source, "publishToolPageExitExact"), source);
    expect(exactToolExit).toContain("state.activeTool === expectedActiveTool");
    expect(exactToolExit).toContain("toolPageExitPatch(activeToolAfterPageChange(state))");

    for (const [name, terminalMarker] of [
      ["openNotesParseTarget", "publishUserParseTransition"],
      ["openSpecParseTarget", "publishUserParseTransition"],
      ["openTableReviewTarget", "openTableReviewWorkspace"],
    ] as const) {
      const target = compactText(declaredFunction(source, name), source);
      const boundaryOffset = target.indexOf("publishViewerPageBoundary");
      const terminalOffset = target.lastIndexOf(terminalMarker);
      expect(boundaryOffset, `${name} page boundary`).toBeGreaterThan(-1);
      expect(terminalOffset, `${name} target transition`).toBeGreaterThan(boundaryOffset);
    }
  });

  it("self-calibrates against direct/computed/aliased setters, raw patches, assignments, and hook borrows", () => {
    const fixture = sourceOf("page-writer-mutation-fixture.ts", `
      import {
        useViewerCoreStore as renamedStore,
        useNavigation as renamedNavigation,
      } from "@/stores/viewerCoreStore";
      declare const useViewerCoreStore: any;
      declare function useNavigation(): any;
      function mutate(pageNumber: number) {
        useViewerCoreStore.getState().setPage(2);
        useViewerCoreStore.getState()["setPage"](3);
        useViewerCoreStore.setState({ pageNumber: 4 });
        useViewerCoreStore.setState(() => ({ ["pageNumber"]: 5 }));
        const core = useViewerCoreStore.getState();
        core.setPage(6);
        core.pageNumber = 7;
        const { setPage } = useNavigation();
        const { setPage: renamed } = useNavigation();
        const nav = useNavigation();
        const borrowed = nav.setPage;
        const selected = useViewerCoreStore((state: any) => state.setPage);
        const patch = { pageNumber: 8 };
        useViewerCoreStore.setState(patch);
        Object.assign(core, { pageNumber: 9 });
        core.pageNumber++;
        delete core.pageNumber;
        renamedStore.getState().setPage(10);
        const { setPage: importedRenamed } = renamedNavigation();
        return [pageNumber, setPage, renamed, borrowed, selected, importedRenamed];
      }
    `);

    expect(pageWriterViolations(fixture)).toEqual([
      "mutate:raw-setPage",
      "mutate:raw-setPage",
      "mutate:raw-pageNumber-patch",
      "mutate:raw-pageNumber-patch",
      "mutate:raw-setPage",
      "mutate:raw-pageNumber-assignment",
      "mutate:raw-setPage-binding",
      "mutate:raw-setPage-binding",
      "mutate:raw-setPage",
      "mutate:raw-setPage",
      "mutate:raw-pageNumber-aliased-patch",
      "mutate:raw-pageNumber-object-assign",
      "mutate:raw-pageNumber-update",
      "mutate:raw-pageNumber-delete",
      "mutate:raw-setPage",
      "mutate:raw-setPage-binding",
    ]);
  });

  it("pins the sidebar click to the rendered thumbnail destination", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/viewer/PageSidebar.tsx"),
      "utf8",
    ).replace(/\s+/g, "");
    expect(source).toContain(
      "onClick={()=>{sidebarClickRef.current=true;navigateViewerPage(n);}}",
    );
    expect(source).not.toContain("navigateViewerPage(pageNumber)");
  });
});
