// @vitest-environment node
// [refactor jul11 P2.2⑥ DETECTOR] Bootstrap call-surface tripwire.
//
// WHY SOURCE CONTRACT INSTEAD OF MOUNTING BOTH PAGES:
// These two client pages orchestrate Next routing, auth/demo metadata, several parallel fetches,
// PDF viewer state, and many unrelated cache domains. Mounting either solely to observe three
// annotation seed statements would make this narrow invariant depend on most of the application.
// The project already treats unmountable sacred surfaces as source-reviewed boundaries. This test
// uses the TypeScript AST (not line snapshots or formatting regexes) to pin only the six facts that
// mutation testing proved were otherwise invisible:
//   1. exactly one success seed and two failure clears per page;
//   2. every seed receives queryClient + server-canonical data.id;
//   3. the success seed receives chunk;
//   4. one null clear is inside !chunkRes.ok and one is inside the JSON catch;
//   5. success cache publication precedes useViewerStore.setState in the same block;
//   6. no await splits those two publications.
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

function isSeedCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "seedAnnotationsFromBootstrap"
  );
}

function isPagesWindowPublication(node: ts.Node): node is ts.CallExpression {
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

describe.each(LOADERS)("$label annotation bootstrap call surface", ({ path }) => {
  it("has one canonical success seed plus HTTP and JSON failure clears", () => {
    const source = parseLoader(path);
    const calls = descendants(source, isSeedCall);

    // Exact count kills a deleted success/failure call as well as accidental duplicate publication.
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.arguments).toHaveLength(3);
      expect(isQueryClient(call.arguments[0])).toBe(true);
      expect(isCanonicalPublicId(call.arguments[1])).toBe(true);
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

  it("publishes cache before Zustand in the same block with no await between", () => {
    const source = parseLoader(path);
    const successCalls = descendants(source, isSeedCall).filter((call) =>
      isChunk(call.arguments[2]),
    );
    expect(successCalls).toHaveLength(1);

    const seedStatement = seedExpressionStatement(successCalls[0]);
    expect(ts.isBlock(seedStatement.parent)).toBe(true);
    const block = seedStatement.parent as ts.Block;
    const seedIndex = block.statements.indexOf(seedStatement);
    const storeIndexes = block.statements
      .map((statement, index) =>
        descendants(statement, isPagesWindowPublication).length > 0 ? index : -1,
      )
      .filter((index) => index >= 0);

    expect(storeIndexes).toHaveLength(1);
    const storeIndex = storeIndexes[0];
    expect(seedIndex).toBeGreaterThanOrEqual(0);
    expect(storeIndex).toBeGreaterThan(seedIndex);

    // Include the seed statement itself so `await seedAnnotationsFromBootstrap(...)` also fails.
    const cacheToStoreSegment = block.statements.slice(seedIndex, storeIndex);
    expect(cacheToStoreSegment.some(containsAwait)).toBe(false);
  });
});
