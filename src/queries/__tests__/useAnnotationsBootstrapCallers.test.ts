// @vitest-environment node
// [refactor jul11 P2.2⑦ DETECTOR] Paired bootstrap call-surface tripwire.
//
// WHY SOURCE CONTRACT INSTEAD OF MOUNTING BOTH PAGES:
// These two client pages orchestrate Next routing, auth/demo metadata, several parallel fetches,
// PDF viewer state, and many unrelated cache domains. Mounting either solely to observe three
// publication statements would make this narrow invariant depend on most of the application. The
// TypeScript AST pins the paired helper as the sole annotation/window owner: one success + two clear
// calls, canonical identity/range arguments, correct failure placement, no direct annotation write,
// and no legacy pages-window Zustand publication.
// Formatting, comments, and unrelated loader statements are intentionally ignored.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const LOADERS = [
  {
    label: "authenticated",
    path: "src/app/(dashboard)/project/[id]/page.tsx",
  },
  {
    label: "demo",
    path: "src/app/demo/project/[id]/page.tsx",
  },
] as const;

function parseLoader(relativePath: string): ts.SourceFile {
  const absolutePath = join(process.cwd(), relativePath);
  return ts.createSourceFile(
    absolutePath,
    readFileSync(absolutePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
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

function isPublishCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "publishBootstrapPageWindow"
  );
}

function isOldPagesWindowPublication(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  const isViewerSetState = (
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "useViewerStore" &&
    node.expression.name.text === "setState"
  );
  if (!isViewerSetState) return false;

  // Match the related pages-window publication, not every future setState the loader may gain.
  return node.arguments.some(
    (argument) =>
      descendants(
        argument,
        (candidate): candidate is ts.PropertyAssignment =>
          ts.isPropertyAssignment(candidate) &&
          ts.isIdentifier(candidate.name) &&
          candidate.name.text === "loadedPageRange",
      ).length > 0,
  );
}

function isCanonicalNumPages(node: ts.Node | undefined): boolean {
  return (
    !!node &&
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "data" &&
    node.name.text === "numPages"
  );
}

function isDirectAnnotationWrite(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  if (
    !ts.isIdentifier(node.expression.expression) ||
    node.expression.expression.text !== "queryClient" ||
    node.expression.name.text !== "setQueryData"
  ) {
    return false;
  }
  const firstArgument = node.arguments[0];
  return !!firstArgument && firstArgument.getText().includes("queryKeys.annotations");
}

function isQueryClient(node: ts.Node | undefined): boolean {
  return !!node && ts.isIdentifier(node) && node.text === "queryClient";
}

function isCanonicalPublicId(node: ts.Node | undefined): boolean {
  if (!node) return false;
  if (ts.isPropertyAccessExpression(node)) {
    return ts.isIdentifier(node.expression) && node.expression.text === "data" && node.name.text === "id";
  }
  return (
    ts.isElementAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "data" &&
    !!node.argumentExpression &&
    ts.isStringLiteral(node.argumentExpression) &&
    node.argumentExpression.text === "id"
  );
}

function isChunk(node: ts.Node | undefined): boolean {
  return !!node && ts.isIdentifier(node) && node.text === "chunk";
}

function isNull(node: ts.Node | undefined): boolean {
  return !!node && node.kind === ts.SyntaxKind.NullKeyword;
}

function ancestors(node: ts.Node): ts.Node[] {
  const result: ts.Node[] = [];
  let current = node.parent;
  while (current) {
    result.push(current);
    current = current.parent;
  }
  return result;
}

function isChunkFailureIf(node: ts.Node): node is ts.IfStatement {
  if (!ts.isIfStatement(node) || !ts.isPrefixUnaryExpression(node.expression)) return false;
  const operand = node.expression.operand;
  return (
    node.expression.operator === ts.SyntaxKind.ExclamationToken &&
    ts.isPropertyAccessExpression(operand) &&
    ts.isIdentifier(operand.expression) &&
    operand.expression.text === "chunkRes" &&
    operand.name.text === "ok"
  );
}

function seedExpressionStatement(call: ts.CallExpression): ts.ExpressionStatement {
  let current: ts.Node = call;
  while (current.parent && !ts.isExpressionStatement(current)) current = current.parent;
  expect(ts.isExpressionStatement(current)).toBe(true);
  return current as ts.ExpressionStatement;
}

function containsAwait(node: ts.Node): boolean {
  return descendants(node, ts.isAwaitExpression).length > 0;
}

describe.each(LOADERS)("$label paired bootstrap call surface", ({ path }) => {
  it("has one canonical success publication plus HTTP and JSON paired clears", () => {
    const source = parseLoader(path);
    const calls = descendants(source, isPublishCall);

    // Exact count kills a deleted success/failure call as well as accidental duplicate publication.
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.arguments).toHaveLength(4);
      expect(isQueryClient(call.arguments[0])).toBe(true);
      expect(isCanonicalPublicId(call.arguments[1])).toBe(true);
      expect(isCanonicalNumPages(call.arguments[3])).toBe(true);
    }

    const successCalls = calls.filter((call) => isChunk(call.arguments[2]));
    const clearCalls = calls.filter((call) => isNull(call.arguments[2]));
    expect(successCalls).toHaveLength(1);
    expect(clearCalls).toHaveLength(2);

    const httpClears = clearCalls.filter((call) => ancestors(call).some(isChunkFailureIf));
    const jsonClears = clearCalls.filter((call) =>
      ancestors(call).some((node) => ts.isCatchClause(node)),
    );
    expect(httpClears).toHaveLength(1);
    expect(jsonClears).toHaveLength(1);
  });

  it("leaves no split annotation write or legacy window-store publication", () => {
    const source = parseLoader(path);
    expect(descendants(source, isDirectAnnotationWrite)).toHaveLength(0);
    expect(descendants(source, isOldPagesWindowPublication)).toHaveLength(0);
    expect(
      descendants(
        source,
        (node): node is ts.CallExpression =>
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "seedAnnotationsFromBootstrap",
      ),
    ).toHaveLength(0);

    for (const publication of descendants(source, isPublishCall)) {
      const statement = seedExpressionStatement(publication);
      expect(containsAwait(statement)).toBe(false);
    }
  });
});
