// @vitest-environment node
// [refactor jul11 P2.2⑦ C1] Source-level contract for the two eager project bootstraps.
//
// These pages are intentionally not mounted here: doing so would couple this narrow contract to Next
// routing, auth, PDF rendering, and every other bootstrap domain. The TypeScript AST pins only the
// load-bearing caller facts that the pure pageWindowCore tests cannot observe while that core remains
// production-dead: eager Promise.all membership, reset/failure routing, canonical annotation keying,
// paired publication adjacency, and auth/demo scale/fallback asymmetry.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const LOADERS = [
  {
    label: "authenticated",
    path: "src/app/(dashboard)/project/[id]/page.tsx",
    promiseBindings: ["res", "chunkRes", "groupsRes"],
    fetchArguments: [
      "`/api/projects/${id}`",
      "`/api/projects/${id}/pages?from=1&to=15`",
      "`/api/annotation-groups?projectId=${id}`",
    ],
    hydratesScale: true,
  },
  {
    label: "demo",
    path: "src/app/demo/project/[id]/page.tsx",
    promiseBindings: ["res", "chunkRes"],
    fetchArguments: [
      "`/api/demo/projects/${id}`",
      "`/api/demo/projects/${id}/pages?from=1&to=15`",
    ],
    hydratesScale: false,
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

function ancestors(node: ts.Node): ts.Node[] {
  const result: ts.Node[] = [];
  let current = node.parent;
  while (current) {
    result.push(current);
    current = current.parent;
  }
  return result;
}

function compact(node: ts.Node, source: ts.SourceFile): string {
  return node.getText(source).replace(/\s+/g, "");
}

function isIdentifierCall(node: ts.Node, name: string): node is ts.CallExpression {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name;
}

function isPromiseAllAwait(node: ts.Node): node is ts.AwaitExpression {
  if (!ts.isAwaitExpression(node) || !ts.isCallExpression(node.expression)) return false;
  const callee = node.expression.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "Promise" &&
    callee.name.text === "all"
  );
}

function isSeedCall(node: ts.Node): node is ts.CallExpression {
  return isIdentifierCall(node, "seedAnnotationsFromBootstrap");
}

function isCanonicalPublicId(node: ts.Node | undefined): boolean {
  return (
    !!node &&
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "data" &&
    node.name.text === "id"
  );
}

function isPagesWindowPublication(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  if (
    !ts.isIdentifier(node.expression.expression) ||
    node.expression.expression.text !== "useViewerStore" ||
    node.expression.name.text !== "setState"
  ) {
    return false;
  }

  return descendants(
    node,
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) &&
      ts.isIdentifier(candidate.name) &&
      candidate.name.text === "loadedPageRange",
  ).length > 0;
}

function directStatement(node: ts.Node, block: ts.Block): ts.Statement {
  let current = node;
  while (current.parent && current.parent !== block) current = current.parent;
  expect(current.parent).toBe(block);
  expect(block.statements.includes(current as ts.Statement)).toBe(true);
  return current as ts.Statement;
}

function findLoadBody(source: ts.SourceFile): ts.Block {
  const declarations = descendants(
    source,
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "load",
  );
  expect(declarations).toHaveLength(1);
  const initializer = declarations[0].initializer;
  expect(initializer && ts.isCallExpression(initializer)).toBe(true);
  const callback = (initializer as ts.CallExpression).arguments[0];
  expect(callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))).toBe(true);
  const body = (callback as ts.ArrowFunction | ts.FunctionExpression).body;
  expect(ts.isBlock(body)).toBe(true);
  return body as ts.Block;
}

function findOuterTry(source: ts.SourceFile): ts.TryStatement {
  const loadBody = findLoadBody(source);
  const tries = loadBody.statements.filter(ts.isTryStatement);
  expect(tries).toHaveLength(1);
  return tries[0];
}

function findPromiseAll(source: ts.SourceFile, outerTry: ts.TryStatement): ts.AwaitExpression {
  const awaits = descendants(outerTry.tryBlock, isPromiseAllAwait);
  expect(awaits).toHaveLength(1);
  return awaits[0];
}

function bindingNames(awaitExpression: ts.AwaitExpression): string[] {
  const declaration = ancestors(awaitExpression).find(ts.isVariableDeclaration);
  expect(declaration).toBeDefined();
  expect(ts.isArrayBindingPattern(declaration!.name)).toBe(true);
  return (declaration!.name as ts.ArrayBindingPattern).elements.map((element) => {
    expect(ts.isBindingElement(element) && ts.isIdentifier(element.name)).toBe(true);
    return (element as ts.BindingElement).name.getText();
  });
}

function promiseFetchArguments(
  source: ts.SourceFile,
  awaitExpression: ts.AwaitExpression,
): string[] {
  const promiseCall = awaitExpression.expression as ts.CallExpression;
  expect(promiseCall.arguments).toHaveLength(1);
  const members = promiseCall.arguments[0];
  expect(ts.isArrayLiteralExpression(members)).toBe(true);
  return (members as ts.ArrayLiteralExpression).elements.map((member) => {
    expect(isIdentifierCall(member, "fetch")).toBe(true);
    const fetchCall = member as ts.CallExpression;
    expect(fetchCall.arguments).toHaveLength(1);
    return compact(fetchCall.arguments[0], source);
  });
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

function isChunkSuccessIf(node: ts.Node): node is ts.IfStatement {
  return (
    ts.isIfStatement(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "chunkRes" &&
    node.expression.name.text === "ok"
  );
}

function isSummariesFallback(node: ts.Node): node is ts.IfStatement {
  if (!ts.isIfStatement(node) || !ts.isPrefixUnaryExpression(node.expression)) return false;
  const operand = node.expression.operand;
  return (
    node.expression.operator === ts.SyntaxKind.ExclamationToken &&
    ts.isPropertyAccessExpression(operand) &&
    ts.isIdentifier(operand.expression) &&
    operand.expression.text === "data" &&
    operand.name.text === "summaries"
  );
}

function containsAwait(node: ts.Node): boolean {
  return descendants(node, ts.isAwaitExpression).length > 0;
}

describe.each(LOADERS)("$label page-window bootstrap caller", (loader) => {
  it("B1: keeps the exact eager Promise.all membership after reset", () => {
    const source = parseLoader(loader.path);
    const outerTry = findOuterTry(source);
    const promiseAll = findPromiseAll(source, outerTry);

    expect(bindingNames(promiseAll)).toEqual([...loader.promiseBindings]);
    expect(promiseFetchArguments(source, promiseAll)).toEqual([...loader.fetchArguments]);

    const resetCalls = descendants(outerTry.tryBlock, (node): node is ts.CallExpression =>
      isIdentifierCall(node, "resetProjectData"),
    );
    expect(resetCalls).toHaveLength(1);
    const resetIndex = outerTry.tryBlock.statements.indexOf(
      directStatement(resetCalls[0], outerTry.tryBlock),
    );
    const promiseIndex = outerTry.tryBlock.statements.indexOf(
      directStatement(promiseAll, outerTry.tryBlock),
    );
    expect(resetIndex).toBeGreaterThanOrEqual(0);
    expect(promiseIndex).toBeGreaterThan(resetIndex);

    // The Promise.all rejection is handled only by the load() outer catch: no per-request or inner
    // catch may make eager network failure optional before §2.5 replaces the whole orchestrator.
    expect(ancestors(promiseAll).filter(ts.isTryStatement)).toEqual([outerTry]);
  });

  it("B2: publishes canonical annotations immediately before the current window and then piggybacks", () => {
    const source = parseLoader(loader.path);
    const outerTry = findOuterTry(source);
    const successIfs = outerTry.tryBlock.statements.filter(isChunkSuccessIf);
    expect(successIfs).toHaveLength(1);
    expect(ts.isBlock(successIfs[0].thenStatement)).toBe(true);
    const successBlock = successIfs[0].thenStatement as ts.Block;

    const successSeeds = descendants(successBlock, isSeedCall).filter(
      (call) => ts.isIdentifier(call.arguments[2]) && call.arguments[2].text === "chunk",
    );
    expect(successSeeds).toHaveLength(1);
    expect(successSeeds[0].arguments).toHaveLength(3);
    expect(ts.isIdentifier(successSeeds[0].arguments[0])).toBe(true);
    expect((successSeeds[0].arguments[0] as ts.Identifier).text).toBe("queryClient");
    expect(isCanonicalPublicId(successSeeds[0].arguments[1])).toBe(true);

    const publications = descendants(successBlock, isPagesWindowPublication);
    expect(publications).toHaveLength(1);
    const seedStatement = directStatement(successSeeds[0], successBlock);
    const publicationStatement = directStatement(publications[0], successBlock);
    const seedIndex = successBlock.statements.indexOf(seedStatement);
    const publicationIndex = successBlock.statements.indexOf(publicationStatement);
    expect(publicationIndex).toBe(seedIndex + 1);
    expect(successBlock.statements.slice(seedIndex, publicationIndex).some(containsAwait)).toBe(false);

    const rangeProperties = descendants(
      publications[0],
      (node): node is ts.PropertyAssignment =>
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "loadedPageRange",
    );
    expect(rangeProperties).toHaveLength(1);
    expect(compact(rangeProperties[0].initializer, source)).toBe(
      "{from:1,to:chunk.pages.length>0?Math.max(...chunk.pages.map((p:any)=>p.pageNumber)):Math.min(data.numPages||1,15)}",
    );

    const scaleCalls = descendants(successBlock, (node): node is ts.CallExpression =>
      isIdentifierCall(node, "setScaleCalibration"),
    );
    expect(scaleCalls).toHaveLength(loader.hydratesScale ? 1 : 0);

    const fallbacks = successBlock.statements.filter(isSummariesFallback);
    expect(fallbacks).toHaveLength(1);
    const fallbackIndex = successBlock.statements.indexOf(fallbacks[0]);
    expect(fallbackIndex).toBeGreaterThan(publicationIndex);
    if (loader.hydratesScale) {
      const scaleStatement = directStatement(scaleCalls[0], successBlock);
      const scaleIndex = successBlock.statements.indexOf(scaleStatement);
      expect(scaleIndex).toBeGreaterThan(publicationIndex);
      expect(fallbackIndex).toBeGreaterThan(scaleIndex);
      expect(ts.isForOfStatement(scaleStatement)).toBe(true);
      expect(compact((scaleStatement as ts.ForOfStatement).expression, source)).toBe(
        "chunk.annotations",
      );
    }
  });

  it("B3: keeps HTTP optional-empty, JSON clear-then-fatal, and eager failures fatal", () => {
    const source = parseLoader(loader.path);
    const outerTry = findOuterTry(source);
    expect(outerTry.catchClause).toBeDefined();
    expect(outerTry.finallyBlock).toBeDefined();

    const failureIfs = outerTry.tryBlock.statements.filter(isChunkFailureIf);
    expect(failureIfs).toHaveLength(1);
    const httpFailure = failureIfs[0].thenStatement;
    const httpClears = descendants(httpFailure, isSeedCall).filter(
      (call) => call.arguments[2]?.kind === ts.SyntaxKind.NullKeyword,
    );
    expect(httpClears).toHaveLength(1);
    expect(isCanonicalPublicId(httpClears[0].arguments[1])).toBe(true);
    expect(descendants(httpFailure, ts.isThrowStatement)).toHaveLength(0);

    const jsonAwaits = descendants(
      outerTry.tryBlock,
      (node): node is ts.AwaitExpression =>
        ts.isAwaitExpression(node) &&
        ts.isCallExpression(node.expression) &&
        ts.isPropertyAccessExpression(node.expression.expression) &&
        ts.isIdentifier(node.expression.expression.expression) &&
        node.expression.expression.expression.text === "chunkRes" &&
        node.expression.expression.name.text === "json",
    );
    expect(jsonAwaits).toHaveLength(1);
    const jsonTry = ancestors(jsonAwaits[0]).find(ts.isTryStatement);
    expect(jsonTry).toBeDefined();
    expect(jsonTry).not.toBe(outerTry);
    expect(jsonTry!.catchClause).toBeDefined();
    const catchBlock = jsonTry!.catchClause!.block;
    const jsonClears = descendants(catchBlock, isSeedCall).filter(
      (call) => call.arguments[2]?.kind === ts.SyntaxKind.NullKeyword,
    );
    const throws = descendants(catchBlock, ts.isThrowStatement);
    expect(jsonClears).toHaveLength(1);
    expect(throws).toHaveLength(1);
    expect(isCanonicalPublicId(jsonClears[0].arguments[1])).toBe(true);
    expect(catchBlock.statements.indexOf(directStatement(jsonClears[0], catchBlock))).toBeLessThan(
      catchBlock.statements.indexOf(directStatement(throws[0], catchBlock)),
    );
    expect(compact(throws[0].expression!, source)).toBe("parseError");

    const errorCalls = descendants(outerTry.catchClause!.block, (node): node is ts.CallExpression =>
      isIdentifierCall(node, "setError"),
    );
    expect(errorCalls).toHaveLength(1);
    const loadingCalls = descendants(outerTry.finallyBlock!, (node): node is ts.CallExpression =>
      isIdentifierCall(node, "setLoading"),
    );
    expect(loadingCalls).toHaveLength(1);
    expect(compact(loadingCalls[0].arguments[0], source)).toBe("false");
  });
});
