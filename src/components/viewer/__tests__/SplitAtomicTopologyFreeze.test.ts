// @vitest-environment node
//
// [refactor jul19 P3.2] Atomic Split transport topology. Split acceptance remains a sacred
// AnnotationOverlay terminal, but durable I/O belongs to one plain Query command. Endpoint
// inventories may name the route; no second production caller, hook, or top-level pending owner
// may grow around that seam.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const ENDPOINT = "/api/annotations/split";
const QUERY_COMMAND = "src/queries/annotationSplit.ts";
const ROUTE = "src/app/api/annotations/split/route.ts";
const OVERLAY = "src/components/viewer/AnnotationOverlay.tsx";
const INVENTORIES = [
  "scripts/project-security-policy-manifest.mjs",
  "src/app/docs/_components/demos/ApiEndpointList.tsx",
  "src/lib/admin-logs/feature-map.ts",
  "src/lib/middleware-rate-limit.ts",
] as const;
const ALLOWED_ENDPOINT_OWNERS = new Set<string>([
  QUERY_COMMAND,
  ROUTE,
  ...INVENTORIES,
]);

function normalizedRelative(path: string): string {
  return relative(ROOT, path).split(sep).join("/");
}

function productionSourceFiles(relativeRoot: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") visit(path);
        continue;
      }
      if (
        entry.isFile() &&
        /\.(?:[cm]?[jt]sx?)$/u.test(entry.name) &&
        !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(entry.name)
      ) {
        files.push(path);
      }
    }
  };
  visit(join(ROOT, relativeRoot));
  return files;
}

function source(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

function parsed(relativePath: string): ts.SourceFile {
  const text = source(relativePath);
  return ts.createSourceFile(
    relativePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function namedImportsFrom(file: ts.SourceFile, moduleName: string): string[] {
  const names: string[] = [];
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== moduleName
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    names.push(...bindings.elements.map((element) => element.name.text));
  }
  return names;
}

function directInterfaceProperties(
  file: ts.SourceFile,
  interfaceName: string,
): ts.PropertySignature[] {
  const declaration = file.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) &&
      statement.name.text === interfaceName,
  );
  if (!declaration) throw new Error(`Expected interface ${interfaceName}`);
  return declaration.members.filter(ts.isPropertySignature);
}

function propertyName(
  property: ts.PropertySignature,
  file: ts.SourceFile,
): string {
  return property.name.getText(file).replace(/^['"]|['"]$/gu, "");
}

function identifierCount(node: ts.Node, name: string): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(node);
  return count;
}

function namedFunction(
  file: ts.SourceFile,
  name: string,
): ts.FunctionDeclaration {
  const declaration = file.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (!declaration) throw new Error(`Expected function ${name}`);
  return declaration;
}

function directCallback(
  node: ts.Node,
  callName: string,
  argumentIndex: number,
): ts.ArrowFunction | ts.FunctionExpression {
  let callback: ts.ArrowFunction | ts.FunctionExpression | undefined;
  const visit = (current: ts.Node): void => {
    if (
      ts.isCallExpression(current) &&
      ts.isIdentifier(current.expression) &&
      current.expression.text === callName
    ) {
      const candidate = current.arguments[argumentIndex];
      if (
        candidate &&
        (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate))
      ) {
        callback = candidate;
      }
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  if (!callback) throw new Error(`Expected ${callName} callback`);
  return callback;
}

function directCallCount(file: ts.SourceFile, name: string): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return count;
}

describe("atomic annotation Split topology", () => {
  it("keeps the endpoint literal in the sole Query command, route, and explicit inventories", () => {
    const owners = [
      ...productionSourceFiles("src"),
      ...productionSourceFiles("scripts"),
    ]
      .filter((path) => readFileSync(path, "utf8").includes(ENDPOINT))
      .map(normalizedRelative)
      .sort();

    expect(owners).toEqual(
      expect.arrayContaining([QUERY_COMMAND, ...INVENTORIES]),
    );
    expect(
      owners.filter((owner) => !ALLOWED_ENDPOINT_OWNERS.has(owner)),
    ).toEqual([]);
    expect(source(QUERY_COMMAND).split(ENDPOINT)).toHaveLength(2);
  });

  it("keeps AnnotationOverlay mutation-hook-free and delegates persistence to the plain command", () => {
    const overlayText = source(OVERLAY);
    const overlay = parsed(OVERLAY);
    const command = parsed(QUERY_COMMAND);
    const acceptance = parsed("src/components/viewer/splitAcceptance.ts");

    expect(overlayText).not.toContain(ENDPOINT);
    expect(identifierCount(overlay, "useMutation")).toBe(0);
    expect(namedImportsFrom(overlay, "@/queries/annotationSplit")).toContain(
      "commitAnnotationSplit",
    );
    expect(namedImportsFrom(overlay, "./splitAcceptance")).toContain(
      "admitAnnotationSplit",
    );
    expect(directCallCount(overlay, "admitAnnotationSplit")).toBe(1);
    expect(directCallCount(overlay, "commitAnnotationSplit")).toBe(1);
    expect(identifierCount(command, "useMutation")).toBe(0);
    expect(identifierCount(command, "useQuery")).toBe(0);
    expect(identifierCount(acceptance, "useMutation")).toBe(0);
    expect(identifierCount(acceptance, "useQuery")).toBe(0);
    expect(directCallCount(acceptance, "commitAnnotationSplit")).toBe(0);

    const commandOwners = productionSourceFiles("src")
      .filter((path) =>
        readFileSync(path, "utf8").includes("commitAnnotationSplit"),
      )
      .map(normalizedRelative)
      .sort();
    expect(commandOwners).toEqual([OVERLAY, QUERY_COMMAND].sort());
  });

  it("keeps durable admission nested in splitPreview with no parallel top-level owner", () => {
    const storePath = "src/stores/toolStore.ts";
    const store = parsed(storePath);
    const dataProperties = directInterfaceProperties(store, "ToolStoreData");
    const actionProperties = directInterfaceProperties(
      store,
      "ToolStoreActions",
    );
    const topLevelSplitPending = [...dataProperties, ...actionProperties]
      .map((property) => propertyName(property, store))
      .filter((name) => /split/iu.test(name) && /pending/iu.test(name));
    const splitPreview = dataProperties.find(
      (property) => propertyName(property, store) === "splitPreview",
    );

    expect(topLevelSplitPending).toEqual([]);
    expect(
      dataProperties
        .map((property) => propertyName(property, store))
        .filter((name) => name.startsWith("split")),
    ).toEqual(["splitLineA", "splitLineB", "splitPreview", "splitError"]);
    expect(splitPreview?.type?.getText(store)).toContain(
      "commitPending?: true",
    );
  });

  it("pins physical source CAS and output-conservation calls at the service sink", () => {
    const servicePath = "src/server/services/annotations.ts";
    const service = source(servicePath);
    const serviceAst = parsed(servicePath);
    const splitService = namedFunction(serviceAst, "splitAnnotation");
    const transaction = directCallback(splitService, "withProjectWrite", 2);
    expect(
      service.match(/splitSourceCasWhere\(project\.id, body\)/gu),
    ).toHaveLength(2);
    expect(service.match(/splitAreasConserve\(/gu)).toHaveLength(1);
    expect(service).toMatch(
      /\.update\(annotations\)[\s\S]*?\.where\(splitSourceCasWhere\(project\.id, body\)\)[\s\S]*?\.returning\(\)/u,
    );
    expect(identifierCount(transaction, "db")).toBe(0);
    expect(identifierCount(transaction, "tx")).toBeGreaterThan(0);
  });

  it("keeps the thin route bound to the shared-guard service sink", () => {
    const route = parsed(ROUTE);
    expect(namedImportsFrom(route, "@/server/services/annotations")).toContain(
      "splitAnnotation",
    );
    expect(source("scripts/project-security-policy-manifest.mjs")).toMatch(
      /mutation\(\s*"annotations-split",\s*"\/api\/annotations\/split",\s*"POST",\s*"shared-guard",\s*\[\["src\/server\/services\/annotations\.ts",\s*"splitAnnotation"\]\]/u,
    );
  });
});
