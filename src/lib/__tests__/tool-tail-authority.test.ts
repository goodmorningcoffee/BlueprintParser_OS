// @vitest-environment node
// [refactor jul13 P2.3 AT2] Shared non-reactive late-tool authority and closed borrower set.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  cancelToolTailExact,
  claimLatestToolOperation,
  claimParseToolAuthority,
  claimToolTailAuthority,
  consumeToolTailAuthority,
  invalidateLatestToolOperation,
  invalidateParseToolAuthority,
  invalidateToolTailAuthority,
  ownsLatestToolOperation,
  ownsParseToolAuthority,
  ownsToolTailAuthority,
  registerToolTailCancellation,
  releaseToolTailCancellation,
} from "@/lib/parse-tool-authority";

const MODULE_FILE = "src/lib/parse-tool-authority.ts";
const NEW_RUNTIME_APIS = new Set([
  "registerToolTailCancellation",
  "releaseToolTailCancellation",
  "cancelToolTailExact",
  "claimToolTailAuthority",
  "invalidateToolTailAuthority",
  "ownsToolTailAuthority",
  "consumeToolTailAuthority",
  "claimLatestToolOperation",
  "invalidateLatestToolOperation",
  "ownsLatestToolOperation",
]);

function parseSource(sourceText: string): ts.SourceFile {
  return ts.createSourceFile(
    MODULE_FILE,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function exportedNames(source: ts.SourceFile): string[] {
  return source.statements.flatMap((statement) => {
    const exported = ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported || !("name" in statement)) return [];
    const name = statement.name;
    return name && ts.isIdentifier(name) ? [name.text] : [];
  });
}

function compact(value: string): string {
  return value.replace(/\s+/g, "");
}

function typeAliasText(sourceText: string, name: string): string | null {
  const source = parseSource(sourceText);
  const alias = source.statements.find((statement): statement is ts.TypeAliasDeclaration =>
    ts.isTypeAliasDeclaration(statement) && statement.name.text === name
  );
  return alias ? compact(alias.type.getText(source)) : null;
}

function functionBody(sourceText: string, name: string): string | null {
  const source = parseSource(sourceText);
  const fn = source.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name
  );
  return fn?.body ? compact(fn.body.getText(source)) : null;
}

function functionSignature(sourceText: string, name: string): string | null {
  const source = parseSource(sourceText);
  const fn = source.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name
  );
  if (!fn) return null;
  const typeParameters = fn.typeParameters?.map((parameter) => parameter.getText(source)).join(",") ?? "";
  const parameters = fn.parameters.map((parameter) => parameter.getText(source)).join(",");
  return compact(`${typeParameters === "" ? "" : `<${typeParameters}>`}(${parameters})` +
    `${fn.type ? `:${fn.type.getText(source)}` : ""}`);
}

function laneMembers(sourceText: string): string[] {
  const source = parseSource(sourceText);
  const alias = source.statements.find((statement): statement is ts.TypeAliasDeclaration =>
    ts.isTypeAliasDeclaration(statement) && statement.name.text === "LatestToolLane"
  );
  if (!alias || !ts.isUnionTypeNode(alias.type)) return [];
  return alias.type.types.map((member) => compact(member.getText(source)));
}

function productionFiles(directory = join(process.cwd(), "src")): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) return productionFiles(absolute);
    if (!/\.tsx?$/.test(entry.name) || entry.name.endsWith(".d.ts")) return [];
    const path = relative(process.cwd(), absolute).replace(/\\/g, "/");
    if (path === MODULE_FILE || path.includes("/__tests__/") || /\.(?:test|spec)\./.test(path)) {
      return [];
    }
    return [path];
  });
}

function staticString(node: ts.Node): string | null {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (
    ts.isParenthesizedExpression(node) || ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) return staticString(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(node.left);
    const right = staticString(node.right);
    return left === null || right === null ? null : left + right;
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const expression = staticString(span.expression);
      if (expression === null) return null;
      value += expression + span.literal.text;
    }
    return value;
  }
  return null;
}

function normalizedLocalModule(importerPath: string, specifier: string): string | null {
  const withoutExtension = (value: string) =>
    value.replace(/\\/g, "/").replace(/\.(?:[cm]?[jt]sx?)$/, "").replace(/\/index$/, "");
  if (specifier.startsWith("@/")) {
    return withoutExtension(join("src", specifier.slice(2)));
  }
  if (specifier.startsWith(".")) {
    return withoutExtension(join(dirname(importerPath), specifier));
  }
  return null;
}

function moduleDependencyKinds(sourceText: string): string[] {
  const source = parseSource(sourceText);
  const hits = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      hits.add("import");
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      hits.add("export");
    } else if (
      ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
    ) {
      hits.add("import-equals");
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) hits.add("dynamic-import");
      if (ts.isIdentifier(node.expression) && node.expression.text === "require") hits.add("require");
    } else if (ts.isImportTypeNode(node)) {
      hits.add("import-type");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...hits].sort();
}

function referencesAuthorityModule(
  path: string,
  source: ts.SourceFile,
  expression: ts.Node,
): boolean {
  const specifier = staticString(expression);
  if (specifier !== null) return normalizedLocalModule(path, specifier) === MODULE_FILE.replace(/\.ts$/, "");
  // A visibly target-derived but runtime-opaque load must fail closed.
  return expression.getText(source).includes("parse-tool-authority");
}

function newAuthorityBorrowers(path: string, sourceText: string): string[] {
  if (
    !sourceText.includes("parse-tool-authority") &&
    !/\b(?:import|require)\s*\(/.test(sourceText)
  ) return [];
  const source = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const hits = new Set<string>();
  const addBroad = (kind: string) => hits.add(`broad:${kind}`);
  const addNamed = (name: string) => {
    if (NEW_RUNTIME_APIS.has(name)) hits.add(name);
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      referencesAuthorityModule(path, source, node.moduleSpecifier)
    ) {
      const clause = node.importClause;
      if (clause?.name) addBroad("import");
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) addBroad("import");
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          addNamed(element.propertyName?.text ?? element.name.text);
        }
      }
    } else if (
      ts.isExportDeclaration(node) && node.moduleSpecifier &&
      referencesAuthorityModule(path, source, node.moduleSpecifier)
    ) {
      if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) {
        addBroad("export");
      } else {
        for (const element of node.exportClause.elements) {
          addNamed(element.propertyName?.text ?? element.name.text);
        }
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression &&
      referencesAuthorityModule(path, source, node.moduleReference.expression)
    ) {
      addBroad("import-equals");
    } else if (ts.isCallExpression(node) && node.arguments[0]) {
      const kind = node.expression.kind === ts.SyntaxKind.ImportKeyword
        ? "dynamic-import"
        : ts.isIdentifier(node.expression) && node.expression.text === "require"
        ? "require"
        : null;
      if (
        kind &&
        (staticString(node.arguments[0]) === null ||
          referencesAuthorityModule(path, source, node.arguments[0]))
      ) addBroad(kind);
    } else if (
      ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) &&
      referencesAuthorityModule(path, source, node.argument.literal)
    ) {
      addBroad("import-type");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...hits].sort().map((name) => `${path}:${name}`);
}

beforeEach(async () => {
  invalidateToolTailAuthority();
  await Promise.resolve();
  invalidateLatestToolOperation("bucketFill");
  invalidateLatestToolOperation("symbolSession");
});

describe("AT2 one exact global tool-tail authority", () => {
  it("pins the zero-dependency additive API with no reactive or numeric authority", () => {
    const sourceText = readFileSync(join(process.cwd(), MODULE_FILE), "utf8");
    const source = parseSource(sourceText);
    expect(source.statements.filter(ts.isImportDeclaration)).toEqual([]);
    expect(moduleDependencyKinds(sourceText)).toEqual([]);
    expect(exportedNames(source)).toEqual([
      "ToolTailToken",
      "LatestToolLane",
      "registerToolTailCancellation",
      "releaseToolTailCancellation",
      "cancelToolTailExact",
      "claimToolTailAuthority",
      "invalidateToolTailAuthority",
      "ownsToolTailAuthority",
      "consumeToolTailAuthority",
      "claimLatestToolOperation",
      "invalidateLatestToolOperation",
      "ownsLatestToolOperation",
      "claimParseToolAuthority",
      "invalidateParseToolAuthority",
      "ownsParseToolAuthority",
    ]);
    expect(sourceText).not.toMatch(/\brevision\b|\bnumber\b/);
    expect(typeAliasText(sourceText, "ToolTailToken")).toBe("Readonly<object>");
    expect(laneMembers(sourceText)).toEqual(['"bucketFill"', '"symbolSession"']);
    expect(functionSignature(sourceText, "claimToolTailAuthority"))
      .toBe("<Textendsobject>(token:T):T");
    expect(functionSignature(sourceText, "registerToolTailCancellation"))
      .toBe("(token:ToolTailToken,cancel:()=>void):void");
    expect(functionSignature(sourceText, "releaseToolTailCancellation"))
      .toBe("(token:ToolTailToken):boolean");
    expect(functionSignature(sourceText, "cancelToolTailExact"))
      .toBe("(token:ToolTailToken):boolean");
    expect(functionSignature(sourceText, "invalidateToolTailAuthority")).toBe("():void");
    expect(functionSignature(sourceText, "ownsToolTailAuthority"))
      .toBe("(token:ToolTailToken):boolean");
    expect(functionSignature(sourceText, "consumeToolTailAuthority"))
      .toBe("(token:ToolTailToken,publish:()=>void):boolean");
    expect(functionSignature(sourceText, "claimLatestToolOperation"))
      .toBe("<Textendsobject>(lane:LatestToolLane,token:T):T");
    expect(functionSignature(sourceText, "invalidateLatestToolOperation"))
      .toBe("(lane:LatestToolLane):void");
    expect(functionSignature(sourceText, "ownsLatestToolOperation"))
      .toBe("(lane:LatestToolLane,token:ToolTailToken):boolean");
    expect(functionBody(sourceText, "claimParseToolAuthority"))
      .toBe("{returnclaimToolTailAuthority(token);}");
    expect(functionBody(sourceText, "invalidateParseToolAuthority"))
      .toBe("{invalidateToolTailAuthority();}");
    expect(functionBody(sourceText, "ownsParseToolAuthority"))
      .toBe("{returnownsToolTailAuthority(token);}");
    expect(functionSignature(sourceText, "claimParseToolAuthority"))
      .toBe("<Textendsobject>(token:T):T");
    expect(functionSignature(sourceText, "invalidateParseToolAuthority")).toBe("():void");
    expect(functionSignature(sourceText, "ownsParseToolAuthority"))
      .toBe("(token:object):boolean");

    const moduleState = source.statements.filter(ts.isVariableStatement).flatMap((statement) =>
      statement.declarationList.declarations.map((declaration) => ({
        binding: statement.declarationList.flags & ts.NodeFlags.Const ? "const" : "let",
        name: ts.isIdentifier(declaration.name) ? declaration.name.text : "non-identifier",
        type: declaration.type ? compact(declaration.type.getText(source)) : null,
        initializer: declaration.initializer ? compact(declaration.initializer.getText(source)) : null,
      }))
    );
    expect(moduleState).toEqual([
      {
        binding: "let",
        name: "currentToolTailOwner",
        type: "ToolTailToken|null",
        initializer: "null",
      },
      {
        binding: "let",
        name: "currentToolTailCancellation",
        type: "ToolTailCancellation|null",
        initializer: "null",
      },
      {
        binding: "const",
        name: "latestToolOperations",
        type: "Record<LatestToolLane,ToolTailToken|null>",
        initializer: "{bucketFill:null,symbolSession:null,}",
      },
    ]);

    // Mutation witness: any differently named split global slot violates the exact module topology.
    const splitSlotMutant = sourceText.replace(
      "let currentToolTailOwner: ToolTailToken | null = null;",
      "let currentToolTailOwner: ToolTailToken | null = null;\n" +
        "let alternateToolTailOwner: ToolTailToken | null = null;",
    );
    expect(splitSlotMutant).not.toBe(sourceText);
    expect(parseSource(splitSlotMutant).statements.filter(ts.isVariableStatement).flatMap(
      (statement) => statement.declarationList.declarations,
    )).toHaveLength(4);

    const laneMutant = sourceText.replace(
      '"bucketFill" | "symbolSession"',
      '"bucketFill" | "symbolSession" | "thirdLane"',
    );
    expect(laneMutant).not.toBe(sourceText);
    expect(laneMembers(laneMutant)).not.toEqual(['"bucketFill"', '"symbolSession"']);

    const wrapperMutant = sourceText.replace(
      "return claimToolTailAuthority(token);",
      "return token;",
    );
    expect(wrapperMutant).not.toBe(sourceText);
    expect(functionBody(wrapperMutant, "claimParseToolAuthority"))
      .not.toBe("{returnclaimToolTailAuthority(token);}");
  });

  it("pins every generic/lane runtime borrower after the atomic AT2 flip", () => {
    const borrowers = productionFiles().flatMap((path) =>
      newAuthorityBorrowers(path, readFileSync(join(process.cwd(), path), "utf8"))
    );
    expect(borrowers.sort()).toEqual([
      "src/components/viewer/AnnotationOverlay.tsx:cancelToolTailExact",
      "src/components/viewer/AnnotationOverlay.tsx:claimToolTailAuthority",
      "src/components/viewer/AnnotationOverlay.tsx:consumeToolTailAuthority",
      "src/components/viewer/AnnotationOverlay.tsx:invalidateLatestToolOperation",
      "src/components/viewer/AnnotationOverlay.tsx:invalidateToolTailAuthority",
      "src/components/viewer/AnnotationOverlay.tsx:ownsToolTailAuthority",
      "src/components/viewer/AnnotationOverlay.tsx:registerToolTailCancellation",
      "src/components/viewer/AnnotationOverlay.tsx:releaseToolTailCancellation",
      "src/components/viewer/AreaTab.tsx:claimToolTailAuthority",
      "src/components/viewer/AreaTab.tsx:consumeToolTailAuthority",
      "src/components/viewer/AreaTab.tsx:invalidateToolTailAuthority",
      "src/components/viewer/AreaTab.tsx:ownsToolTailAuthority",
      "src/components/viewer/BucketFillAssignDialog.tsx:invalidateToolTailAuthority",
      "src/components/viewer/CalibrationInput.tsx:claimToolTailAuthority",
      "src/components/viewer/CalibrationInput.tsx:consumeToolTailAuthority",
      "src/components/viewer/CalibrationInput.tsx:ownsToolTailAuthority",
      "src/components/viewer/CountTab.tsx:claimToolTailAuthority",
      "src/components/viewer/CountTab.tsx:consumeToolTailAuthority",
      "src/components/viewer/CountTab.tsx:invalidateToolTailAuthority",
      "src/components/viewer/CountTab.tsx:ownsToolTailAuthority",
      "src/components/viewer/DetectionPanel.tsx:claimToolTailAuthority",
      "src/components/viewer/DetectionPanel.tsx:consumeToolTailAuthority",
      "src/components/viewer/DetectionPanel.tsx:ownsToolTailAuthority",
      "src/components/viewer/DrawingPreviewLayer.tsx:invalidateToolTailAuthority",
      "src/components/viewer/LinearTab.tsx:claimToolTailAuthority",
      "src/components/viewer/LinearTab.tsx:consumeToolTailAuthority",
      "src/components/viewer/LinearTab.tsx:invalidateToolTailAuthority",
      "src/components/viewer/LinearTab.tsx:ownsToolTailAuthority",
      "src/components/viewer/SplitPreviewActions.tsx:invalidateToolTailAuthority",
      "src/components/viewer/SymbolSearchPanel.tsx:claimLatestToolOperation",
      "src/components/viewer/SymbolSearchPanel.tsx:invalidateLatestToolOperation",
      "src/components/viewer/SymbolSearchPanel.tsx:invalidateToolTailAuthority",
      "src/components/viewer/SymbolSearchPanel.tsx:ownsLatestToolOperation",
      "src/components/viewer/TakeoffPanel.tsx:invalidateToolTailAuthority",
      // [refactor jul19 P3.2] BucketFill mechanically carries the legacy branch's dual claims,
      // barrier invalidations, exact cancellation, and release-before-consume settlement.
      "src/components/viewer/tools/bucketFill.ts:claimLatestToolOperation",
      "src/components/viewer/tools/bucketFill.ts:claimToolTailAuthority",
      "src/components/viewer/tools/bucketFill.ts:consumeToolTailAuthority",
      "src/components/viewer/tools/bucketFill.ts:invalidateLatestToolOperation",
      "src/components/viewer/tools/bucketFill.ts:invalidateToolTailAuthority",
      "src/components/viewer/tools/bucketFill.ts:ownsLatestToolOperation",
      "src/components/viewer/tools/bucketFill.ts:ownsToolTailAuthority",
      "src/components/viewer/tools/bucketFill.ts:registerToolTailCancellation",
      "src/components/viewer/tools/bucketFill.ts:releaseToolTailCancellation",
      // [refactor jul18 P3.2] Keynote picking inherited the legacy hit-only invalidation. Its
      // eligible miss has zero effects and delegates to parseRect; parseRect is deliberately
      // absent because deferredDrawing.start remains the sole lease/authority owner.
      "src/components/viewer/tools/keynotePick.ts:invalidateToolTailAuthority",
      // [refactor jul16 P3.2] The markup controller inherited the overlay's pre-dispatch
      // invalidation for claimed markup-mode presses (pre-move AO:1957 semantics).
      "src/components/viewer/tools/markup.ts:invalidateToolTailAuthority",
      // [refactor jul18 P3.2] PointerGroup inherited the overlay's eligible-press invalidation.
      // Ineligible presses remain zero-side-effect so a surviving owner is never retired twice.
      "src/components/viewer/tools/pointerGroup.ts:invalidateToolTailAuthority",
      // [refactor jul19 P3.2] Split inherited the legacy branch's first/second-click invalidation.
      // Its preview-open terminal remains deliberately cold and retains the current tail owner.
      "src/components/viewer/tools/split.ts:invalidateToolTailAuthority",
      // [refactor jul17 P3.2] The takeoffCount controller inherited the takeoffPlacement branch
      // prelude's invalidation for claimed count presses (pre-move AO:1750 semantics); declines
      // stay effect-cold and converge on the common non-null-owner guard.
      "src/components/viewer/tools/takeoffCount.ts:invalidateToolTailAuthority",
      // [refactor jul17 P3.2] The takeoffLinear controller inherited the same branch prelude for
      // claimed linear presses (pre-move AO:1756 semantics); its declines are zero-side-effect,
      // so exactly one borrower invalidates per press.
      "src/components/viewer/tools/takeoffLinear.ts:invalidateToolTailAuthority",
      // [refactor jul17 P3.2] The takeoffPolygon controller inherited the same branch prelude for
      // claimed polygon presses (pre-move AO:1759 semantics); its declines are zero-side-effect,
      // so exactly one borrower invalidates per press.
      "src/components/viewer/tools/takeoffPolygon.ts:invalidateToolTailAuthority",
      "src/queries/useAnnotations.ts:invalidateToolTailAuthority",
      "src/stores/toolStore.ts:invalidateLatestToolOperation",
      "src/stores/toolStore.ts:invalidateToolTailAuthority",
      "src/stores/viewerCommands.ts:claimLatestToolOperation",
      "src/stores/viewerCommands.ts:claimToolTailAuthority",
      "src/stores/viewerCommands.ts:consumeToolTailAuthority",
      "src/stores/viewerCommands.ts:invalidateLatestToolOperation",
      "src/stores/viewerCommands.ts:invalidateToolTailAuthority",
      "src/stores/viewerCommands.ts:ownsLatestToolOperation",
      "src/stores/viewerCommands.ts:ownsToolTailAuthority",
    ]);
    expect(borrowers).not.toContain(
      "src/components/viewer/tools/parseRect.ts:invalidateToolTailAuthority",
    );
    // [refactor jul18 P3.2 tagPick] Hit and miss deactivate through the canonical tool-store
    // action, which already retires tail authority before publication. A direct controller
    // invalidation would duplicate cancellation and must not enter the closed borrower roster.
    expect(borrowers).not.toContain(
      "src/components/viewer/tools/tagPick.ts:invalidateToolTailAuthority",
    );

    expect(newAuthorityBorrowers("src/lib/borrower-mutant.ts", `
      import {
        claimToolTailAuthority as claim,
        claimParseToolAuthority,
      } from "@/lib/parse-tool-authority";
      void claim;
      void claimParseToolAuthority;
    `)).toEqual(["src/lib/borrower-mutant.ts:claimToolTailAuthority"]);
    expect(newAuthorityBorrowers("src/lib/computed-mutant.ts", `
      const key = "claimTool" + "TailAuthority";
      void import("./parse-tool-authority").then((authority) => authority[key]);
    `)).toEqual(["src/lib/computed-mutant.ts:broad:dynamic-import"]);

    const broadMutants = [
      `import * as authority from "../lib/parse-tool-authority"; void authority;`,
      `import authority = require("@/lib/parse-tool-authority"); void authority;`,
      `const authority = require("@/lib/" + "parse-tool-authority"); void authority;`,
      `void import("../lib/parse-tool-authority");`,
      `export * from "../lib/parse-tool-authority";`,
      `const suffix = runtimeSuffix(); void import("../lib/parse-tool-authority" + suffix);`,
      `const target = "../lib/parse-tool-authority"; void import(target);`,
    ];
    for (const sourceText of broadMutants) {
      expect(
        newAuthorityBorrowers("src/components/authority-bypass-mutant.ts", sourceText),
        sourceText,
      ).not.toEqual([]);
    }
    expect(newAuthorityBorrowers("src/components/reexport-mutant.ts", `
      export { claimLatestToolOperation as latest } from "../lib/parse-tool-authority";
    `)).toEqual(["src/components/reexport-mutant.ts:claimLatestToolOperation"]);
  }, 15_000);

  it("uses exact object identity across claim, replacement, invalidation, and forged clones", () => {
    const tokenA = { operation: "A" };
    const tokenB = { operation: "B" };
    expect(claimToolTailAuthority(tokenA)).toBe(tokenA);
    expect(ownsToolTailAuthority(tokenA)).toBe(true);
    expect(ownsToolTailAuthority({ ...tokenA })).toBe(false);
    expect(claimToolTailAuthority(tokenB)).toBe(tokenB);
    expect(ownsToolTailAuthority(tokenA)).toBe(false);
    expect(ownsToolTailAuthority(tokenB)).toBe(true);
    invalidateToolTailAuthority();
    expect(ownsToolTailAuthority(tokenA)).toBe(false);
    expect(ownsToolTailAuthority(tokenB)).toBe(false);
  });

  it("retires only the exact displaced local tail before paint", async () => {
    const tokenA = {};
    const tokenB = {};
    const cancelA = vi.fn();
    const cancelB = vi.fn();

    claimToolTailAuthority(tokenA);
    registerToolTailCancellation(tokenA, cancelA);
    claimToolTailAuthority(tokenB);
    await Promise.resolve();
    expect(cancelA).toHaveBeenCalledTimes(1);
    expect(ownsToolTailAuthority(tokenB)).toBe(true);

    registerToolTailCancellation(tokenB, cancelB);
    expect(cancelToolTailExact(tokenA)).toBe(false);
    expect(cancelB).not.toHaveBeenCalled();
    expect(releaseToolTailCancellation(tokenB)).toBe(true);
    invalidateToolTailAuthority();
    await Promise.resolve();
    expect(cancelB).not.toHaveBeenCalled();
  });

  it("lets a replacement registration survive queued A cancellation", async () => {
    const tokenA = {};
    const tokenB = {};
    const cancelA = vi.fn();
    const cancelB = vi.fn();
    claimToolTailAuthority(tokenA);
    registerToolTailCancellation(tokenA, cancelA);
    claimToolTailAuthority(tokenB);
    registerToolTailCancellation(tokenB, cancelB);

    await Promise.resolve();
    expect(cancelA).not.toHaveBeenCalled();
    expect(cancelB).not.toHaveBeenCalled();
    expect(cancelToolTailExact(tokenB)).toBe(true);
    expect(cancelB).toHaveBeenCalledTimes(1);
    expect(ownsToolTailAuthority(tokenB)).toBe(true);
  });

  it("consumes before synchronous publication and never erases reentrant B", () => {
    const tokenA = {};
    const tokenB = {};
    const bucketToken = {};
    const symbolToken = {};
    const trace: string[] = [];
    claimToolTailAuthority(tokenA);
    claimLatestToolOperation("bucketFill", bucketToken);
    claimLatestToolOperation("symbolSession", symbolToken);

    expect(consumeToolTailAuthority(tokenA, () => {
      trace.push(`A:${ownsToolTailAuthority(tokenA)}`);
      claimToolTailAuthority(tokenB);
      trace.push(`B:${ownsToolTailAuthority(tokenB)}`);
    })).toBe(true);

    expect(trace).toEqual(["A:false", "B:true"]);
    expect(ownsToolTailAuthority(tokenA)).toBe(false);
    expect(ownsToolTailAuthority(tokenB)).toBe(true);
    expect(ownsLatestToolOperation("bucketFill", bucketToken)).toBe(true);
    expect(ownsLatestToolOperation("symbolSession", symbolToken)).toBe(true);

    const tokenC = {};
    claimToolTailAuthority(tokenC);
    expect(() => consumeToolTailAuthority(tokenC, () => {
      throw new Error("plain publication failure");
    })).toThrow("plain publication failure");
    expect(ownsToolTailAuthority(tokenC)).toBe(false);
    expect(ownsLatestToolOperation("bucketFill", bucketToken)).toBe(true);
    expect(ownsLatestToolOperation("symbolSession", symbolToken)).toBe(true);
  });

  it("rejects stale consume without calling publication or disturbing B", () => {
    const tokenA = {};
    const tokenB = {};
    const publish = vi.fn();
    claimToolTailAuthority(tokenA);
    claimToolTailAuthority(tokenB);
    expect(consumeToolTailAuthority(tokenA, publish)).toBe(false);
    expect(publish).not.toHaveBeenCalled();
    expect(ownsToolTailAuthority(tokenB)).toBe(true);
  });

  it("stays consumed when the synchronous publication throws", () => {
    const tokenA = {};
    const tokenB = {};
    const bucketToken = {};
    const symbolToken = {};
    claimToolTailAuthority(tokenA);
    claimLatestToolOperation("bucketFill", bucketToken);
    claimLatestToolOperation("symbolSession", symbolToken);
    expect(() => consumeToolTailAuthority(tokenA, () => {
      claimToolTailAuthority(tokenB);
      throw new Error("publication failed");
    })).toThrow("publication failed");
    expect(ownsToolTailAuthority(tokenA)).toBe(false);
    expect(ownsToolTailAuthority(tokenB)).toBe(true);
    expect(ownsLatestToolOperation("bucketFill", bucketToken)).toBe(true);
    expect(ownsLatestToolOperation("symbolSession", symbolToken)).toBe(true);
  });

  it("keeps the exact legacy parse wrappers on the same global slot", () => {
    const parseToken = { kind: "table", revision: 1 };
    const toolToken = { kind: "bucket" };

    expect(claimParseToolAuthority(parseToken)).toBe(parseToken);
    expect(ownsParseToolAuthority(parseToken)).toBe(true);
    expect(ownsToolTailAuthority(parseToken)).toBe(true);
    expect(claimToolTailAuthority(toolToken)).toBe(toolToken);
    expect(ownsParseToolAuthority(parseToken)).toBe(false);
    expect(ownsParseToolAuthority(toolToken)).toBe(true);
    invalidateParseToolAuthority();
    expect(ownsToolTailAuthority(toolToken)).toBe(false);
  });
});

describe("AT1 independent latest-result lanes", () => {
  it("keeps Bucket and Symbol exact, independent, and non-reactive from the global slot", () => {
    const bucketA = {};
    const bucketB = {};
    const symbolA = {};
    const global = {};

    expect(claimLatestToolOperation("bucketFill", bucketA)).toBe(bucketA);
    expect(claimLatestToolOperation("symbolSession", symbolA)).toBe(symbolA);
    expect(ownsLatestToolOperation("bucketFill", bucketA)).toBe(true);
    expect(ownsLatestToolOperation("symbolSession", symbolA)).toBe(true);
    expect(ownsLatestToolOperation("bucketFill", { ...bucketA })).toBe(false);

    claimToolTailAuthority(global);
    expect(ownsLatestToolOperation("bucketFill", bucketA)).toBe(true);
    expect(ownsLatestToolOperation("symbolSession", symbolA)).toBe(true);
    invalidateToolTailAuthority();
    expect(ownsLatestToolOperation("bucketFill", bucketA)).toBe(true);

    claimLatestToolOperation("bucketFill", bucketB);
    expect(ownsLatestToolOperation("bucketFill", bucketA)).toBe(false);
    expect(ownsLatestToolOperation("bucketFill", bucketB)).toBe(true);
    expect(ownsLatestToolOperation("symbolSession", symbolA)).toBe(true);
    invalidateLatestToolOperation("bucketFill");
    expect(ownsLatestToolOperation("bucketFill", bucketB)).toBe(false);
    expect(ownsLatestToolOperation("symbolSession", symbolA)).toBe(true);

    claimLatestToolOperation("bucketFill", bucketB);
    invalidateLatestToolOperation("symbolSession");
    expect(ownsLatestToolOperation("bucketFill", bucketB)).toBe(true);
    expect(ownsLatestToolOperation("symbolSession", symbolA)).toBe(false);

    claimToolTailAuthority(bucketB);
    claimLatestToolOperation("bucketFill", bucketB);
    expect(ownsToolTailAuthority(bucketB)).toBe(true);
    expect(ownsLatestToolOperation("bucketFill", bucketB)).toBe(true);

    const laneCases = [
      ["bucketFill", "symbolSession"],
      ["symbolSession", "bucketFill"],
    ] as const;
    for (const [lane, peer] of laneCases) {
      const laneTokenA = {};
      const laneTokenB = {};
      const peerToken = {};
      const globalToken = {};
      invalidateLatestToolOperation("bucketFill");
      invalidateLatestToolOperation("symbolSession");
      claimToolTailAuthority(globalToken);
      claimLatestToolOperation(peer, peerToken);

      expect(claimLatestToolOperation(lane, laneTokenA)).toBe(laneTokenA);
      expect(ownsLatestToolOperation(lane, laneTokenA), `${lane}:claim:A`).toBe(true);
      expect(ownsLatestToolOperation(lane, { ...laneTokenA }), `${lane}:claim:clone`).toBe(false);
      expect(ownsToolTailAuthority(globalToken), `${lane}:claim:global`).toBe(true);
      expect(ownsLatestToolOperation(peer, peerToken), `${lane}:claim:peer`).toBe(true);
      expect(claimLatestToolOperation(lane, laneTokenB)).toBe(laneTokenB);
      expect(ownsLatestToolOperation(lane, laneTokenA), `${lane}:replace:A`).toBe(false);
      expect(ownsLatestToolOperation(lane, laneTokenB), `${lane}:replace:B`).toBe(true);
      expect(ownsToolTailAuthority(globalToken), `${lane}:replace:global`).toBe(true);
      expect(ownsLatestToolOperation(peer, peerToken), `${lane}:replace:peer`).toBe(true);
      invalidateLatestToolOperation(lane);
      expect(ownsLatestToolOperation(lane, laneTokenA), `${lane}:invalidate:A`).toBe(false);
      expect(ownsLatestToolOperation(lane, laneTokenB), `${lane}:invalidate:B`).toBe(false);
      expect(ownsLatestToolOperation(peer, peerToken), `${lane}:invalidate:peer`).toBe(true);
      expect(ownsToolTailAuthority(globalToken), `${lane}:invalidate:global`).toBe(true);
    }
  });
});
