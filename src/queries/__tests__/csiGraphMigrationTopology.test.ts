// @vitest-environment node
// [refactor jul11 P2.3] Source topology for the residual project-intelligence split. Runtime tests
// own Query behavior; this gate prevents the full PI blob or a second bootstrap writer returning.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const AUTH_LOADER = "src/app/(dashboard)/project/[id]/page.tsx";
const DEMO_LOADER = "src/app/demo/project/[id]/page.tsx";
const CSI_PANEL = "src/components/viewer/CsiPanel.tsx";
const CSI_FACADE = "@/queries/useCsiGraph";
const QUERY_KEYS_MODULE = "@/queries/queryKeys";
const VIEWER_COMMANDS = "@/stores/viewerCommands";
const VIEWER_STORE = "@/stores/viewerStore";

function sourceFiles(directory = "src"): string[] {
  const output: string[] = [];
  const visit = (relative: string) => {
    for (const entry of readdirSync(join(process.cwd(), relative), { withFileTypes: true })) {
      const child = join(relative, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") visit(child);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        output.push(child);
      }
    }
  };
  visit(directory);
  return output.sort();
}

const PRODUCTION_SOURCE_FILES = sourceFiles();

const cache = new Map<string, ts.SourceFile>();
function parse(relativePath: string): ts.SourceFile {
  const cached = cache.get(relativePath);
  if (cached) return cached;
  const source = ts.createSourceFile(
    relativePath,
    readFileSync(join(process.cwd(), relativePath), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  cache.set(relativePath, source);
  return source;
}

function descendants<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
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

function staticStringConstants(root: ts.Node): Map<string, string> {
  const constants = new Map<string, string>();
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
      const value =
        ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)
          ? initializer.text
          : ts.isIdentifier(initializer)
            ? constants.get(initializer.text)
            : undefined;
      if (value !== undefined) changed = publish(declaration.name.text, value) || changed;
    }
  }
  return constants;
}

function memberName(
  expression: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  constants: ReadonlyMap<string, string>,
): string | null {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  const argument = expression.argumentExpression && unwrapExpression(expression.argumentExpression);
  if (!argument) return null;
  if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
    return argument.text;
  }
  return ts.isIdentifier(argument) ? constants.get(argument.text) ?? null : null;
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

function importSeeds(
  source: ts.SourceFile,
  moduleName: string,
  importedName: string,
): { identifiers: Set<string>; namespaces: Set<string> } {
  const identifiers = new Set<string>();
  const namespaces = new Set<string>();
  for (const declaration of source.statements) {
    if (
      !ts.isImportDeclaration(declaration) ||
      !ts.isStringLiteral(declaration.moduleSpecifier) ||
      declaration.moduleSpecifier.text !== moduleName
    ) {
      continue;
    }
    const bindings = declaration.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text === importedName) {
          identifiers.add(element.name.text);
        }
      }
    }
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
  }
  return { identifiers, namespaces };
}

function importedSymbolBindings(
  source: ts.SourceFile,
  moduleName: string,
  importedName: string,
): { identifiers: Set<string>; namespaces: Set<string> } {
  const constants = staticStringConstants(source);
  const seeds = importSeeds(source, moduleName, importedName);
  const namespaces = identifierAliases(source, seeds.namespaces);
  const identifiers = new Set(seeds.identifiers);

  // Namespace-property aliases and namespace destructuring are both common ways a topology check
  // can be accidentally bypassed. Resolve them before following ordinary identifier aliases.
  for (const declaration of descendants(source, ts.isVariableDeclaration)) {
    if (!declaration.initializer) continue;
    const initializer = unwrapExpression(declaration.initializer);
    if (ts.isIdentifier(declaration.name)) {
      if (
        (ts.isPropertyAccessExpression(initializer) || ts.isElementAccessExpression(initializer)) &&
        ts.isIdentifier(unwrapExpression(initializer.expression)) &&
        namespaces.has((unwrapExpression(initializer.expression) as ts.Identifier).text) &&
        memberName(initializer, constants) === importedName
      ) {
        identifiers.add(declaration.name.text);
      }
      continue;
    }
    if (!ts.isObjectBindingPattern(declaration.name) || !ts.isIdentifier(initializer)) continue;
    if (!namespaces.has(initializer.text)) continue;
    for (const element of declaration.name.elements) {
      const sourceName = element.propertyName ?? element.name;
      const staticName =
        ts.isIdentifier(sourceName) || ts.isStringLiteral(sourceName)
          ? sourceName.text
          : null;
      if (staticName === importedName && ts.isIdentifier(element.name)) {
        identifiers.add(element.name.text);
      }
    }
  }

  return { identifiers: identifierAliases(source, identifiers), namespaces };
}

function importedSymbolCalls(
  source: ts.SourceFile,
  moduleName: string,
  importedName: string,
): ts.CallExpression[] {
  const constants = staticStringConstants(source);
  const bindings = importedSymbolBindings(source, moduleName, importedName);
  return descendants(source, ts.isCallExpression).filter((call) => {
    const expression = unwrapExpression(call.expression);
    if (ts.isIdentifier(expression)) return bindings.identifiers.has(expression.text);
    if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) {
      return false;
    }
    const receiver = unwrapExpression(expression.expression);
    return (
      ts.isIdentifier(receiver) &&
      bindings.namespaces.has(receiver.text) &&
      memberName(expression, constants) === importedName
    );
  });
}

function callTopology(moduleName: string, importedName: string): Record<string, number> {
  return Object.fromEntries(
    PRODUCTION_SOURCE_FILES
      // An aliased/namespace import still contains the canonical module literal. Avoid parsing the
      // entire application repeatedly while retaining every supported call escape path.
      .filter((path) => readFileSync(join(process.cwd(), path), "utf8").includes(moduleName))
      .map((path) => [path, importedSymbolCalls(parse(path), moduleName, importedName).length] as const)
      .filter(([, count]) => count > 0),
  );
}

function isImportedSymbolExpression(
  expression: ts.Expression,
  importedName: string,
  bindings: { identifiers: ReadonlySet<string>; namespaces: ReadonlySet<string> },
  constants: ReadonlyMap<string, string>,
): boolean {
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) return bindings.identifiers.has(unwrapped.text);
  if (!ts.isPropertyAccessExpression(unwrapped) && !ts.isElementAccessExpression(unwrapped)) {
    return false;
  }
  const receiver = unwrapExpression(unwrapped.expression);
  return (
    ts.isIdentifier(receiver) &&
    bindings.namespaces.has(receiver.text) &&
    memberName(unwrapped, constants) === importedName
  );
}

function csiQueryKeyReferenceCount(source: ts.SourceFile): number {
  const constants = staticStringConstants(source);
  const bindings = importedSymbolBindings(source, QUERY_KEYS_MODULE, "queryKeys");
  return [
    ...descendants(source, ts.isPropertyAccessExpression),
    ...descendants(source, ts.isElementAccessExpression),
  ].filter(
    (access) =>
      memberName(access, constants) === "csiGraph" &&
      isImportedSymbolExpression(access.expression, "queryKeys", bindings, constants),
  ).length;
}

function csiQueryKeyTopology(): Record<string, number> {
  return Object.fromEntries(
    PRODUCTION_SOURCE_FILES
      .filter((path) =>
        readFileSync(join(process.cwd(), path), "utf8").includes(QUERY_KEYS_MODULE),
      )
      .map((path) => [path, csiQueryKeyReferenceCount(parse(path))] as const)
      .filter(([, count]) => count > 0),
  );
}

function staticTokenTopology(names: ReadonlySet<string>): Record<string, number> {
  return Object.fromEntries(
    PRODUCTION_SOURCE_FILES
      .filter((path) => {
        const text = readFileSync(join(process.cwd(), path), "utf8");
        return [...names].some((name) => text.includes(name));
      })
      .map((path) => {
        const count = descendants(
          parse(path),
          (
            node,
          ): node is ts.Identifier | ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
            (ts.isIdentifier(node) ||
              ts.isStringLiteral(node) ||
              ts.isNoSubstitutionTemplateLiteral(node)) &&
            names.has(node.text),
        ).length;
        return [path, count] as const;
      })
      .filter(([, count]) => count > 0),
  );
}

describe("P2.3 csiGraph migration topology", () => {
  it("self-calibrates named, namespace, local-alias, cast, and computed access detection", () => {
    const fixture = ts.createSourceFile(
      "csi-topology-escape-fixture.tsx",
      `
        import {
          useCsiGraph as importedGraph,
          seedCsiGraphFromBootstrap as importedSeed,
        } from "@/queries/useCsiGraph";
        import * as csiFacade from "@/queries/useCsiGraph";
        import { queryKeys as importedKeys } from "@/queries/queryKeys";
        import * as keyModule from "@/queries/queryKeys";

        const graphAlias = importedGraph as any;
        graphAlias();
        const hookName = "useCsiGraph";
        (csiFacade as any)[hookName]();
        const seedAlias = importedSeed;
        seedAlias(null, "P", null);
        const { clearCsiGraphProject: clearAlias } = csiFacade;
        clearAlias(null, "P");

        const keysAlias = importedKeys as any;
        const domainName = "csiGraph";
        keysAlias[domainName].all("P");
        keyModule.queryKeys[domainName].all("P");
      `,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );

    expect(importedSymbolCalls(fixture, CSI_FACADE, "useCsiGraph")).toHaveLength(2);
    expect(importedSymbolCalls(fixture, CSI_FACADE, "seedCsiGraphFromBootstrap")).toHaveLength(1);
    expect(importedSymbolCalls(fixture, CSI_FACADE, "clearCsiGraphProject")).toHaveLength(1);
    expect(csiQueryKeyReferenceCount(fixture)).toBe(2);
  });

  it("pins exactly one observer and two canonical bootstrap seeds", () => {
    expect(callTopology(CSI_FACADE, "useCsiGraph")).toEqual({ [CSI_PANEL]: 1 });
    expect(callTopology(CSI_FACADE, "seedCsiGraphFromBootstrap")).toEqual({
      [AUTH_LOADER]: 1,
      [DEMO_LOADER]: 1,
    });

    for (const loader of [AUTH_LOADER, DEMO_LOADER]) {
      const source = parse(loader);
      const call = importedSymbolCalls(source, CSI_FACADE, "seedCsiGraphFromBootstrap")[0];
      expect(call.arguments).toHaveLength(3);
      expect(call.arguments[0].getText(source)).toBe("queryClient");
      expect(call.arguments[1].getText(source)).toBe("data.id");
      expect(call.arguments[2].getText(source)).toBe("projectIntelligenceWithoutYoloTags");
    }
  });

  it("pins exact prior-project cleanup before the neutral reset command", () => {
    expect(callTopology(CSI_FACADE, "clearCsiGraphProject")).toEqual({
      [AUTH_LOADER]: 1,
      [DEMO_LOADER]: 1,
    });
    for (const loader of [AUTH_LOADER, DEMO_LOADER]) {
      const source = parse(loader);
      const clear = importedSymbolCalls(source, CSI_FACADE, "clearCsiGraphProject")[0];
      const reset = importedSymbolCalls(source, VIEWER_COMMANDS, "resetProjectData")[0];
      expect(clear.arguments[1].getText(source)).toBe("previousPublicId");
      expect(clear.getStart(source)).toBeLessThan(reset.getStart(source));
    }
  });

  it("keeps all direct csiGraph Query-key ownership inside the facade", () => {
    // This rejects a second setQueryData/useQuery/removeQueries path even when it bypasses the
    // exported helpers. Aliased queryKeys objects and computed `csiGraph` access are included.
    expect(csiQueryKeyTopology()).toEqual({
      "src/queries/useCsiGraph.ts": 3,
    });
  });

  it("keeps the full PI blob out of every production owner and CsiPanel off useProject", () => {
    // Inspect syntax rather than raw text so explanatory comments can retain migration context.
    // String-literal properties are included, preventing a computed-key compatibility copy.
    expect(
      staticTokenTopology(
        new Set(["projectIntelligenceData", "setProjectIntelligenceData"]),
      ),
    ).toEqual({});
    expect(importedSymbolCalls(parse(CSI_PANEL), VIEWER_STORE, "useProject")).toHaveLength(0);
  });
});
