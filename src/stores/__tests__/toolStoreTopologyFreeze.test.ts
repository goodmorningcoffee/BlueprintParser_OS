// @vitest-environment node
// [refactor jul11 P2.3 T2] Active-owner topology: the exact leaf is now the sole tool owner and the
// legacy viewerStore declarations/implementation are deletion targets.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const TOOL_FILE = "src/stores/toolStore.ts";
const VIEWER_FILE = "src/stores/viewerStore.ts";
const TOOL_MODULE = "@/stores/toolStore";

const DATA_KEYS = [
  "mode", "tempPanMode", "activeTakeoffItemId", "scaleCalibrations", "calibrationMode",
  "calibrationPoints", "polygonDrawingMode", "polygonVertices", "bucketFillActive",
  "bucketFillPreview", "bucketFillLoading", "bucketFillError", "bucketFillTolerance",
  "bucketFillDilatePx", "bucketFillResolution", "bucketFillPendingPolygon", "splitAreaActive",
  "splitLineA", "splitLineB", "splitPreview", "splitError", "bucketFillBarriers",
  "bucketFillBarrierMode", "barrierPendingPoint", "takeoffUndoStack", "takeoffRedoStack",
  "yoloTagPickingMode", "tagScanResults", "tagAddingMode", "symbolSearchActive",
  "symbolSearchLoading", "symbolSearchProgress", "symbolSearchResults",
  "symbolSearchConfidence", "dismissedSymbolMatches", "symbolSearchError",
  "symbolSearchTemplateBbox", "symbolSearchSourcePage", "symbolSearchConfig",
  "symbolSearchPreset",
] as const;

const LEGACY_ACTION_KEYS = [
  "setMode", "setTempPanMode", "setActiveTakeoffItemId", "setScaleCalibration",
  "setCalibrationMode", "setCalibrationPoint", "resetCalibration", "setPolygonDrawingMode",
  "addPolygonVertex", "undoLastVertex", "resetPolygonDrawing", "setBucketFillActive",
  "setBucketFillPreview", "setBucketFillLoading", "setBucketFillError",
  "setBucketFillTolerance", "setBucketFillDilatePx", "setBucketFillResolution",
  "setBucketFillPendingPolygon", "setSplitAreaActive", "setSplitLineEndpoint",
  "setSplitPreview", "setSplitError", "addBucketFillBarrier", "undoLastBarrier",
  "clearBucketFillBarriers", "setBucketFillBarrierMode", "setBarrierPendingPoint",
  "setYoloTagPickingMode", "setTagScanResults", "setTagAddingMode", "setSymbolSearchActive",
  "setSymbolSearchLoading", "setSymbolSearchProgress", "setSymbolSearchResults",
  "setSymbolSearchConfidence", "dismissSymbolMatch", "setSymbolSearchError",
  "setSymbolSearchTemplateBbox", "setSymbolSearchSourcePage", "setSymbolSearchConfig",
  "setSymbolSearchPreset", "clearSymbolSearch",
] as const;

const RESET_KEYS = [
  "tempPanMode", "activeTakeoffItemId", "scaleCalibrations", "calibrationMode",
  "calibrationPoints", "polygonDrawingMode", "polygonVertices", "bucketFillResolution",
  "yoloTagPickingMode", "tagScanResults", "tagAddingMode", "symbolSearchActive",
  "symbolSearchLoading", "symbolSearchProgress", "symbolSearchResults",
  "symbolSearchConfidence", "dismissedSymbolMatches", "symbolSearchError",
  "symbolSearchTemplateBbox", "symbolSearchSourcePage", "symbolSearchConfig",
  "symbolSearchPreset",
] as const;

const SYMBOL_HOOK_KEYS = [
  "symbolSearchActive", "setSymbolSearchActive", "symbolSearchLoading", "setSymbolSearchLoading",
  "symbolSearchProgress", "setSymbolSearchProgress", "symbolSearchResults",
  "setSymbolSearchResults", "symbolSearchConfidence", "setSymbolSearchConfidence",
  "symbolSearchError", "setSymbolSearchError", "symbolSearchTemplateBbox",
  "setSymbolSearchTemplateBbox", "symbolSearchSourcePage", "setSymbolSearchSourcePage",
  "dismissedSymbolMatches", "dismissSymbolMatch", "clearSymbolSearch", "symbolSearchConfig",
  "setSymbolSearchConfig", "symbolSearchPreset", "setSymbolSearchPreset",
] as const;

function textOf(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    textOf(path),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function descendants<T extends ts.Node>(
  root: ts.Node,
  predicate: (node: ts.Node) => node is T,
): T[] {
  const output: T[] = [];
  const visit = (node: ts.Node) => {
    if (predicate(node)) output.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return output;
}

function propertyName(name: ts.PropertyName | ts.BindingName | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function interfaceKeys(source: ts.SourceFile, name: string): string[] {
  const matches = source.statements.filter(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === name,
  );
  expect(matches, `${name} interface`).toHaveLength(1);
  return matches[0].members
    .map((member) => propertyName(member.name))
    .filter((key): key is string => key !== null);
}

function storeObject(source: ts.SourceFile, storeName: string): ts.ObjectLiteralExpression {
  const declaration = descendants(source, (node): node is ts.VariableDeclaration =>
    ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === storeName,
  );
  expect(declaration, `${storeName} declaration`).toHaveLength(1);
  const call = declaration[0].initializer;
  expect(call && ts.isCallExpression(call), `${storeName} create call`).toBe(true);
  const factory = (call as ts.CallExpression).arguments[0];
  expect(factory && ts.isArrowFunction(factory), `${storeName} factory`).toBe(true);
  const body = (factory as ts.ArrowFunction).body;
  expect(ts.isParenthesizedExpression(body), `${storeName} parenthesized object`).toBe(true);
  const object = (body as ts.ParenthesizedExpression).expression;
  expect(ts.isObjectLiteralExpression(object), `${storeName} object`).toBe(true);
  return object as ts.ObjectLiteralExpression;
}

function objectKeys(object: ts.ObjectLiteralExpression): string[] {
  return object.properties
    .map((property) => propertyName(property.name))
    .filter((key): key is string => key !== null);
}

function directProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment {
  const matches = object.properties.filter(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) && propertyName(property.name) === name,
  );
  expect(matches, `${name} direct property`).toHaveLength(1);
  return matches[0];
}

function sourceFiles(directory = "src"): string[] {
  const output: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(join(process.cwd(), current), { withFileTypes: true })) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (/\.(?:ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) output.push(child);
    }
  };
  visit(directory);
  return output.sort();
}

function importsFrom(source: ts.SourceFile, moduleName: string): boolean {
  return source.statements.some(
    (statement) => ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === moduleName,
  );
}

describe("toolStore T2 — active source contract", () => {
  const toolSource = parse(TOOL_FILE);
  const viewerSource = parse(VIEWER_FILE);
  const toolObject = storeObject(toolSource, "useToolStore");
  const viewerObject = storeObject(viewerSource, "useViewerStore");

  it("has an exact dependency allowlist", () => {
    const modules = toolSource.statements
      .filter(ts.isImportDeclaration)
      .map((statement) => (statement.moduleSpecifier as ts.StringLiteral).text)
      .sort();
    expect(modules).toEqual(["@/types", "zustand", "zustand/react/shallow"]);
    expect(textOf(TOOL_FILE)).not.toMatch(/@\/stores\/(?:viewer|session|ui|viewerCore)/);
    expect(textOf(TOOL_FILE)).not.toMatch(/@\/(?:queries|components)\//);
  });

  it("declares exactly 40 data fields, 43 legacy actions, and one reset action", () => {
    expect(interfaceKeys(toolSource, "ToolStoreData")).toEqual(DATA_KEYS);
    expect(interfaceKeys(toolSource, "ToolStoreActions")).toEqual([
      ...LEGACY_ACTION_KEYS,
      "resetProjectToolState",
    ]);
    expect(objectKeys(toolObject).sort()).toEqual([
      ...DATA_KEYS,
      ...LEGACY_ACTION_KEYS,
      "resetProjectToolState",
    ].sort());
  });

  it("keeps the reset source-owned by exactly the frozen 22-field partial ledger", () => {
    const reset = directProperty(toolObject, "resetProjectToolState");
    const objects = descendants(reset.initializer, ts.isObjectLiteralExpression)
      .filter((object) => objectKeys(object).includes("tempPanMode"));
    expect(objects).toHaveLength(1);
    expect(objectKeys(objects[0])).toEqual(RESET_KEYS);
  });

  it("copies the exact legacy 23-member useSymbolSearch projection", () => {
    const declarations = descendants(toolSource, (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
      node.name.text === "useSymbolSearch",
    );
    expect(declarations).toHaveLength(1);
    const objects = descendants(declarations[0], ts.isObjectLiteralExpression)
      .filter((object) => objectKeys(object).includes("symbolSearchActive"));
    expect(objects).toHaveLength(1);
    expect(objectKeys(objects[0])).toEqual(SYMBOL_HOOK_KEYS);
  });

  it("makes toolStore the sole owner and deletes the complete legacy viewer contract", () => {
    const viewerInterface = new Set(interfaceKeys(viewerSource, "ViewerState"));
    const viewerKeys = new Set(objectKeys(viewerObject));
    for (const key of [...DATA_KEYS, ...LEGACY_ACTION_KEYS]) {
      expect(viewerInterface, `${key} deleted legacy interface owner`).not.toContain(key);
      expect(viewerKeys, `${key} deleted legacy implementation owner`).not.toContain(key);
    }
    expect(viewerInterface).not.toContain("resetProjectToolState");
    expect(viewerKeys).not.toContain("resetProjectToolState");
  });

  it("is active in production and has no legacy viewerStore alias import", () => {
    const imports = sourceFiles()
      .filter((path) => path !== TOOL_FILE)
      .filter((path) => importsFrom(parse(path), TOOL_MODULE));
    const productionImports = imports.filter(
      (path) => !path.includes("/__tests__/") && !/\.(?:test|spec)\.(?:ts|tsx)$/.test(path),
    );
    expect(productionImports.length).toBeGreaterThan(0);
    expect(imports).toContain("src/stores/viewerCommands.ts");
    expect(sourceFiles().filter((path) =>
      /import\s*\{\s*useViewerStore\s+as\s+useToolStore\s*\}\s*from\s*["']@\/stores\/viewerStore["']/.test(textOf(path)),
    )).toEqual([]);
  }, 15_000);
});
