// @vitest-environment node
// [refactor jul11 P2.3 S0] Source-level characterization for the session/core hand-off in both
// project loaders. Existing page-window/Textract oracles already pin previous-publicId capture,
// cache cleanup before reset, eager Promise.all membership, and canonical cache publication. This
// file covers the two missing cross-store hazards: demo policy must publish before transport starts,
// and identity plus numPages must hydrate synchronously from the same server response.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const AUTH_LOADER = "src/app/(dashboard)/project/[id]/page.tsx";
const DEMO_LOADER = "src/app/demo/project/[id]/page.tsx";

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

function compact(node: ts.Node, source: ts.SourceFile): string {
  return node.getText(source).replace(/\s+/g, "");
}

function isIdentifierCall(node: ts.Node, name: string): node is ts.CallExpression {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name;
}

function findLoadTryBlock(source: ts.SourceFile): ts.Block {
  const loadDeclarations = descendants(
    source,
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "load",
  );
  expect(loadDeclarations).toHaveLength(1);
  const initializer = loadDeclarations[0].initializer;
  expect(initializer && ts.isCallExpression(initializer)).toBe(true);
  const callback = (initializer as ts.CallExpression).arguments[0];
  expect(callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))).toBe(true);
  const body = (callback as ts.ArrowFunction | ts.FunctionExpression).body;
  expect(ts.isBlock(body)).toBe(true);
  const outerTries = (body as ts.Block).statements.filter(ts.isTryStatement);
  expect(outerTries).toHaveLength(1);
  return outerTries[0].tryBlock;
}

function directStatement(node: ts.Node, block: ts.Block): ts.Statement {
  let current = node;
  while (current.parent && current.parent !== block) current = current.parent;
  expect(current.parent).toBe(block);
  expect(block.statements.includes(current as ts.Statement)).toBe(true);
  return current as ts.Statement;
}

function statementIndex(node: ts.Node, block: ts.Block): number {
  return block.statements.indexOf(directStatement(node, block));
}

function promiseAllAwait(node: ts.Node): node is ts.AwaitExpression {
  if (!ts.isAwaitExpression(node) || !ts.isCallExpression(node.expression)) return false;
  const callee = node.expression.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "Promise" &&
    callee.name.text === "all"
  );
}

function viewerSetStateCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "useViewerStore" &&
    node.expression.name.text === "setState"
  );
}

function objectPropertyMap(
  object: ts.ObjectLiteralExpression,
  source: ts.SourceFile,
): Record<string, string> {
  return Object.fromEntries(
    object.properties.map((property) => {
      expect(ts.isPropertyAssignment(property)).toBe(true);
      const assignment = property as ts.PropertyAssignment;
      expect(ts.isIdentifier(assignment.name)).toBe(true);
      return [assignment.name.getText(source), compact(assignment.initializer, source)];
    }),
  );
}

describe("P2.3 authenticated session bootstrap ordering", () => {
  it("hydrates identity and numPages in one synchronous canonical response publication", () => {
    const source = parseLoader(AUTH_LOADER);
    const tryBlock = findLoadTryBlock(source);
    const hydrationCalls = descendants(tryBlock, viewerSetStateCall).filter((call) => {
      const argument = call.arguments[0];
      return (
        !!argument &&
        ts.isObjectLiteralExpression(argument) &&
        argument.properties.some(
          (property) =>
            ts.isPropertyAssignment(property) &&
            ts.isIdentifier(property.name) &&
            property.name.text === "publicId",
        )
      );
    });
    expect(hydrationCalls).toHaveLength(1);

    const hydration = hydrationCalls[0];
    expect(hydration.arguments).toHaveLength(1);
    expect(ts.isObjectLiteralExpression(hydration.arguments[0])).toBe(true);
    expect(objectPropertyMap(hydration.arguments[0] as ts.ObjectLiteralExpression, source)).toEqual({
      projectId: "data.dbId",
      publicId: "data.id",
      dataUrl: "data.dataUrl",
      numPages: "data.numPages||0",
    });
    expect(descendants(directStatement(hydration, tryBlock), ts.isAwaitExpression)).toHaveLength(0);

    const resets = descendants(tryBlock, (node): node is ts.CallExpression =>
      isIdentifierCall(node, "resetProjectData"),
    );
    const dataDeclarations = descendants(
      tryBlock,
      (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "data",
    );
    const yoloSeeds = descendants(tryBlock, (node): node is ts.CallExpression =>
      isIdentifierCall(node, "seedYoloTagsFromBootstrap"),
    );
    expect(resets).toHaveLength(1);
    expect(dataDeclarations).toHaveLength(1);
    expect(yoloSeeds).toHaveLength(1);
    expect(statementIndex(resets[0], tryBlock)).toBeLessThan(statementIndex(dataDeclarations[0], tryBlock));
    expect(statementIndex(dataDeclarations[0], tryBlock)).toBeLessThan(statementIndex(hydration, tryBlock));
    expect(statementIndex(hydration, tryBlock)).toBeLessThan(statementIndex(yoloSeeds[0], tryBlock));
    expect(compact(yoloSeeds[0].arguments[1], source)).toBe("data.id");
  });
});

describe("P2.3 demo session bootstrap ordering", () => {
  it("publishes the demo write-policy gate immediately after reset and before fetch starts", () => {
    const source = parseLoader(DEMO_LOADER);
    const tryBlock = findLoadTryBlock(source);
    const resets = descendants(tryBlock, (node): node is ts.CallExpression =>
      isIdentifierCall(node, "resetProjectData"),
    );
    const demoGates = descendants(tryBlock, (node): node is ts.CallExpression =>
      isIdentifierCall(node, "setIsDemo"),
    );
    const promiseAlls = descendants(tryBlock, promiseAllAwait);
    expect(resets).toHaveLength(1);
    expect(demoGates).toHaveLength(1);
    expect(promiseAlls).toHaveLength(1);
    expect(compact(demoGates[0].arguments[0], source)).toBe("true");

    const resetIndex = statementIndex(resets[0], tryBlock);
    const demoIndex = statementIndex(demoGates[0], tryBlock);
    const fetchIndex = statementIndex(promiseAlls[0], tryBlock);
    expect(demoIndex).toBe(resetIndex + 1);
    expect(fetchIndex).toBeGreaterThan(demoIndex);
    expect(descendants(directStatement(demoGates[0], tryBlock), ts.isAwaitExpression)).toHaveLength(0);
  });

  it("hydrates canonical identity then core page count as one adjacent no-await block", () => {
    const source = parseLoader(DEMO_LOADER);
    const tryBlock = findLoadTryBlock(source);
    const setters = ["setProjectId", "setPublicId", "setDataUrl", "setNumPages"] as const;
    const expectedArguments = ["data.dbId", "data.id", "data.dataUrl", "data.numPages||0"];
    const calls = setters.map((name) => {
      const matches = descendants(tryBlock, (node): node is ts.CallExpression =>
        isIdentifierCall(node, name),
      );
      expect(matches).toHaveLength(1);
      return matches[0];
    });

    expect(calls.map((call) => compact(call.arguments[0], source))).toEqual(expectedArguments);
    const indexes = calls.map((call) => statementIndex(call, tryBlock));
    expect(indexes).toEqual([indexes[0], indexes[0] + 1, indexes[0] + 2, indexes[0] + 3]);
    for (const call of calls) {
      expect(descendants(directStatement(call, tryBlock), ts.isAwaitExpression)).toHaveLength(0);
    }

    const dataDeclarations = descendants(
      tryBlock,
      (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "data",
    );
    const yoloSeeds = descendants(tryBlock, (node): node is ts.CallExpression =>
      isIdentifierCall(node, "seedYoloTagsFromBootstrap"),
    );
    expect(dataDeclarations).toHaveLength(1);
    expect(yoloSeeds).toHaveLength(1);
    expect(statementIndex(dataDeclarations[0], tryBlock)).toBeLessThan(indexes[0]);
    expect(indexes[3]).toBeLessThan(statementIndex(yoloSeeds[0], tryBlock));
    expect(compact(yoloSeeds[0].arguments[1], source)).toBe("data.id");
  });
});
