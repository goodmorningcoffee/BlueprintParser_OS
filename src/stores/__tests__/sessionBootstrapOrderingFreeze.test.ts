// @vitest-environment node
// P2.5 topology: route pages delegate bootstrap; the lifecycle prepares core/cache state and
// publishes session identity last.

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

const auth = source("src/app/(dashboard)/project/[id]/page.tsx");
const demo = source("src/app/demo/project/[id]/page.tsx");
const lifecycle = source("src/lib/project-lifecycle.ts");

function productionSources(directory = join(process.cwd(), "src")): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    const projectRelative = relative(process.cwd(), absolute).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || projectRelative === "src/test") continue;
      files.push(...productionSources(absolute));
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.(test|spec)\.(ts|tsx)$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
    ) {
      files.push(projectRelative);
    }
  }
  return files;
}

function resetCallerTopology(): Record<string, number> {
  const topology: Record<string, number> = {};
  for (const path of productionSources()) {
    const text = source(path);
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const localNames = new Set<string>();
    const namespaceNames = new Set<string>();
    let exposesReset = false;

    for (const statement of file.statements) {
      if (!ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        statement.moduleSpecifier.text !== "@/stores/viewerCommands") continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        // Namespace imports are deliberately fail-closed: they could acquire reset authority
        // without changing this topology's named-import surface.
        namespaceNames.add(bindings.name.text);
        exposesReset = true;
      } else if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if ((element.propertyName ?? element.name).text !== "resetProjectData") continue;
          localNames.add(element.name.text);
          exposesReset = true;
        }
      }
    }
    if (!exposesReset) continue;

    let calls = 0;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        if (ts.isIdentifier(expression) && localNames.has(expression.text)) calls += 1;
        if (ts.isPropertyAccessExpression(expression) &&
          ts.isIdentifier(expression.expression) &&
          namespaceNames.has(expression.expression.text) &&
          expression.name.text === "resetProjectData") calls += 1;
        if (ts.isElementAccessExpression(expression) &&
          ts.isIdentifier(expression.expression) &&
          namespaceNames.has(expression.expression.text) &&
          ts.isStringLiteral(expression.argumentExpression) &&
          expression.argumentExpression.text === "resetProjectData") calls += 1;
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    topology[path] = calls;
  }
  return topology;
}

describe("P2.5 project bootstrap ownership", () => {
  it("leaves each route with one mode-specific openProject call and no bootstrap writes", () => {
    expect(auth.match(/openProject\(/g)).toHaveLength(1);
    expect(demo.match(/openProject\(/g)).toHaveLength(1);
    expect(auth).toContain("demo: false");
    expect(demo).toContain("demo: true");

    for (const route of [auth, demo]) {
      expect(route).not.toMatch(/\bfetch\(/);
      expect(route).not.toContain("resetProjectData");
      expect(route).not.toContain("useSessionStore.setState");
      expect(route).not.toContain("useViewerCoreStore.setState");
    }
  });

  it("keeps resetProjectData behind the sole production lifecycle authority", () => {
    expect(resetCallerTopology()).toEqual({
      "src/lib/project-lifecycle.ts": 1,
    });
  }, 15_000);

  it("makes authenticated route cleanup dispose the latest retry or polling generation", () => {
    expect(auth).toContain("const current = activeOpenRef.current;");
    expect(auth).toContain("current?.dispose();");
    expect(auth).toContain("if (activeOpenRef.current === current)");
    expect(auth).not.toContain("handle.dispose();");
  });

  it("installs core page count before the one non-empty session activation", () => {
    const core = lifecycle.indexOf("useViewerCoreStore.setState({ numPages:");
    const session = lifecycle.indexOf("useSessionStore.setState({", core);
    expect(core).toBeGreaterThan(-1);
    expect(session).toBeGreaterThan(core);
    expect(lifecycle.slice(core, session)).not.toContain("await ");
  });

  it("includes identity, access policy, labels, and config in that activation", () => {
    const activation = lifecycle.slice(lifecycle.indexOf("useSessionStore.setState({"));
    for (const field of [
      "projectId:",
      "publicId,",
      "dataUrl:",
      "isDemo:",
      "demoFeatureConfig:",
      "pageNames:",
      "pageDrawingNumbers:",
    ]) {
      expect(activation).toContain(field);
    }
  });
});
