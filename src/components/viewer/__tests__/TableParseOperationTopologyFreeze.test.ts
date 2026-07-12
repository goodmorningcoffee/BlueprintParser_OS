// [refactor jul12 P2.4 A2b] Exact Table operation-root, composition, and invalidation topology.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const HOOK_MODULE = "@/hooks/useParseOperation";
const TABLE_PANEL = "src/components/viewer/TableParsePanel.tsx";
const AUTO = "src/components/viewer/AutoParseTab.tsx";
const MANUAL = "src/components/viewer/ManualParseTab.tsx";
const GUIDED = "src/components/viewer/GuidedParseTab.tsx";
const MODAL = "src/components/viewer/TableCompareModal.tsx";

function source(path: string): ts.SourceFile {
  const text = readFileSync(join(process.cwd(), path), "utf8");
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
  const output: T[] = [];
  const visit = (node: ts.Node): void => {
    if (predicate(node)) output.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return output;
}

function functionLikeInitializer(
  initializer: ts.Expression | undefined,
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  if (!initializer) return undefined;
  if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) return initializer;
  if (!ts.isCallExpression(initializer)) return undefined;
  const callback = initializer.arguments[0];
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
    return undefined;
  }
  const callee = initializer.expression;
  const calleeName = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : null;
  return calleeName === "useCallback" ? callback : undefined;
}

function namedRoot(path: string, name: string): ts.FunctionLikeDeclaration {
  const file = source(path);
  const declaration = descendants(file, ts.isVariableDeclaration).find((candidate) =>
    ts.isIdentifier(candidate.name) && candidate.name.text === name &&
    functionLikeInitializer(candidate.initializer) !== undefined
  );
  const initializer = declaration && functionLikeInitializer(declaration.initializer);
  if (initializer) return initializer;
  const fn = descendants(file, ts.isFunctionDeclaration).find((candidate) =>
    candidate.name?.text === name
  );
  if (!fn) throw new Error(`Missing ${path}:${name}`);
  return fn;
}

function compact(node: ts.Node): string {
  return node.getText(node.getSourceFile()).replace(/\s+/g, "");
}

function importCount(path: string, moduleName: string): number {
  return source(path).statements.filter((statement): statement is ts.ImportDeclaration =>
    ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) &&
    statement.moduleSpecifier.text === moduleName
  ).length;
}

function hookCallCount(path: string): number {
  return descendants(source(path), ts.isCallExpression).filter((call) => {
    const expression = call.expression;
    return ts.isIdentifier(expression) && expression.text === "useParseOperation" &&
      call.arguments[0]?.getText() === '"table"';
  }).length;
}

function tableBeginCallCount(root: ts.Node): number {
  return descendants(root, ts.isCallExpression).filter((call) =>
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === "tableOperation" &&
    call.expression.name.text === "begin"
  ).length;
}

function tableOperationCalls(root: ts.Node, method: "begin" | "finish"): ts.CallExpression[] {
  return descendants(root, ts.isCallExpression).filter((call) =>
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === "tableOperation" &&
    call.expression.name.text === method
  );
}

function terminalCallName(call: ts.CallExpression): string | null {
  if (ts.isIdentifier(call.expression)) return call.expression.text;
  if (ts.isPropertyAccessExpression(call.expression)) return call.expression.name.text;
  return null;
}

function isInsideFinally(node: ts.Node, boundary: ts.Node): boolean {
  return descendants(boundary, ts.isTryStatement).some((statement) => {
    const block = statement.finallyBlock;
    return Boolean(block && node.getStart() >= block!.getStart() && node.getEnd() <= block!.getEnd());
  });
}

function identifierCall(root: ts.Node, name: string): ts.CallExpression {
  const call = descendants(root, ts.isCallExpression).find((candidate) =>
    ts.isIdentifier(candidate.expression) && candidate.expression.text === name
  );
  if (!call) throw new Error(`Missing ${name} call in ${root.getSourceFile().fileName}`);
  return call;
}

function hasIdentifierCallAncestor(
  node: ts.Node,
  name: string,
  boundary: ts.Node,
): boolean {
  let current = node.parent;
  while (current && current !== boundary) {
    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression) &&
        current.expression.text === name) return true;
    current = current.parent;
  }
  return false;
}

function expectOrder(path: string, owner: string, before: string, after: string): void {
  const text = compact(namedRoot(path, owner));
  expect(text, `${path}:${owner} contains ${before}`).toContain(before);
  expect(text, `${path}:${owner} contains ${after}`).toContain(after);
  expect(text.indexOf(before), `${path}:${owner} invalidates before publication`)
    .toBeLessThan(text.indexOf(after));
}

describe("A2b exact Table operation topology", () => {
  it("loads the operation hook only in five cold Table surfaces and keeps hot canvas files hook-free", () => {
    expect(Object.fromEntries([
      AUTO,
      GUIDED,
      MANUAL,
      MODAL,
      TABLE_PANEL,
    ].map((path) => [path, { imports: importCount(path, HOOK_MODULE), calls: hookCallCount(path) }])))
      .toEqual({
        [AUTO]: { imports: 1, calls: 2 },
        [GUIDED]: { imports: 1, calls: 1 },
        [MANUAL]: { imports: 1, calls: 1 },
        [MODAL]: { imports: 1, calls: 1 },
        [TABLE_PANEL]: { imports: 1, calls: 1 },
      });

    for (const path of [
      "src/components/viewer/AnnotationOverlay.tsx",
      "src/components/viewer/PDFPage.tsx",
      "src/components/viewer/ParseRegionLayer.tsx",
      "src/components/viewer/DrawingPreviewLayer.tsx",
      "src/hooks/useShapeParseInteraction.ts",
    ]) {
      expect(importCount(path, HOOK_MODULE), `${path} stays operation-hook-free`).toBe(0);
    }
  });

  it("pins all nine roots to the required admission policy and synchronous authorization seam", () => {
    const roots = [
      [TABLE_PANEL, "detectCsiAndPersist", "tableOperation.begin()"],
      [TABLE_PANEL, "handleMapTags", "tableOperation.begin()"],
      [AUTO, "processRegions", "tableOperation.begin()"],
      [AUTO, "handleReviewSave", "tableOperation.begin()"],
      [AUTO, "handleDetect", "tableOperation.begin()"],
      [MANUAL, "parseFromIntersections", "tableOperation.begin()"],
      [GUIDED, "proposeGrid", 'tableOperation.begin("supersede")'],
      [GUIDED, "handleParse", "tableOperation.begin()"],
      [MODAL, "handleDone", "tableOperation.begin()"],
    ] as const;
    expect(roots).toHaveLength(9);

    expect(Object.fromEntries([TABLE_PANEL, AUTO, MANUAL, GUIDED, MODAL]
      .map((path) => [path, tableBeginCallCount(source(path))])))
      .toEqual({
        [TABLE_PANEL]: 2,
        [AUTO]: 3,
        [MANUAL]: 1,
        [GUIDED]: 2,
        [MODAL]: 1,
      });

    for (const [path, owner, begin] of roots) {
      const root = namedRoot(path, owner);
      const text = compact(root);
      expect(tableBeginCallCount(root), `${path}:${owner} owns exactly one admission`).toBe(1);
      const beginCall = tableOperationCalls(root, "begin")[0];
      const awaits = descendants(root, ts.isAwaitExpression);
      expect(awaits.length, `${path}:${owner} remains async`).toBeGreaterThan(0);
      expect(beginCall.getStart(), `${path}:${owner} admits before its first await`)
        .toBeLessThan(Math.min(...awaits.map((node) => node.getStart())));
      expect(text, `${path}:${owner} admission`).toContain(begin);
      expect(text, `${path}:${owner} authorization`).toContain("commitParseOperation(token,");
      const finishes = tableOperationCalls(root, "finish");
      expect(finishes, `${path}:${owner} has one token cleanup`).toHaveLength(1);
      expect(isInsideFinally(finishes[0], root), `${path}:${owner} cleanup stays in finally`).toBe(true);

      for (const clause of descendants(root, ts.isCatchClause)) {
        const setters = descendants(clause.block, ts.isCallExpression)
          .filter((call) => /^set[A-Z]/.test(terminalCallName(call) ?? ""));
        for (const setter of setters) {
          expect(
            hasIdentifierCallAncestor(setter, "commitParseOperation", clause),
            `${path}:${owner} catch setter ${terminalCallName(setter)} stays authorized`,
          ).toBe(true);
        }
      }
    }
  });

  it("pins one outer token through every nested Table save and forbids legacy blind clears", () => {
    expect(compact(namedRoot(AUTO, "processRegions")))
      .toContain("detectCsiAndPersist(grid,{resetAfter:false},token)");
    expect(compact(namedRoot(AUTO, "handleReviewSave")))
      .toMatch(/detectCsiAndPersist\(tableParsedGrid,\{onAuthorizedSuccess:.*\},token\)/);
    expect(compact(namedRoot(MANUAL, "parseFromIntersections")))
      .toContain("detectCsiAndPersist(grid,{resetAfter:false},token)");
    expect(compact(namedRoot(GUIDED, "handleParse")))
      .toMatch(/detectCsiAndPersist\(\{headers:result\.headers,rows:result\.rows,tableName:`Tablep\.\$\{pageNumber\}`,\},\{onAuthorizedSuccess:.*\},token\)/);

    const helper = compact(namedRoot(TABLE_PANEL, "detectCsiAndPersist"));
    expect(helper).toContain("constownsToken=inheritedToken===undefined");
    expect(helper).toContain("conststarted=ownsToken?tableOperation.begin():null");
    expect(helper).toContain("if(ownsToken)tableOperation.finish(token)");

    const combined = [TABLE_PANEL, AUTO, MANUAL, GUIDED, MODAL]
      .map((path) => readFileSync(join(process.cwd(), path), "utf8"))
      .join("\n");
    for (const retired of [
      "isSavingRef",
      "setAutoParsing(false)",
      "setProposing(false)",
      "setSavingDone(false)",
    ]) expect(combined).not.toContain(retired);
  });

  it("pins token-authorized idle-to-review transitions for Auto, Manual, and Guided", () => {
    const auto = compact(namedRoot(AUTO, "processRegions"));
    expect(auto).toContain('reviewCommitted=setTableParseStepForOperation(token,"review")');
    expect(auto).toContain("if(!completionPublished||!reviewCommitted)return");
    expect(auto)
      .not.toContain('setTableParseStep("review")');
    for (const [path, owner] of [
      [MANUAL, "parseFromIntersections"],
      [GUIDED, "handleParse"],
    ] as const) {
      const text = compact(namedRoot(path, owner));
      expect(text).toContain('reviewCommitted=setTableParseStepForOperation(token,"review")');
      expect(text).toContain("if(!completionPublished||!reviewCommitted)");
    }
  });

  it("keeps captured Query work outside the synchronous commit seam", () => {
    const root = namedRoot(MODAL, "handleDone");
    const queryWrite = identifierCall(root, "setPageIntelligenceForPage");
    expect(hasIdentifierCallAncestor(queryWrite, "commitParseOperation", root)).toBe(false);

    const text = compact(root);
    expect(text).toContain("if(!tableOperation.isCurrent(token))return;setPageIntelligenceForPage(");
    expect(text.indexOf("tableOperation.begin()"))
      .toBeLessThan(text.indexOf("setPageIntelligenceForPage("));
  });
});

describe("A2b Table invalidation topology", () => {
  it("invalidates stored tab and retained-row handoffs before their first B publication", () => {
    expectOrder(TABLE_PANEL, "handleTableTabChange", "invalidateTableOperation()", "setTableParseTab(tab)");
    expect(compact(namedRoot(TABLE_PANEL, "loadExistingParsed")))
      .not.toContain("invalidateTableOperation()");
    expect(compact(source(TABLE_PANEL))).toContain(
      "beforeHandoff={invalidateTableOperation}",
    );
    expect(compact(namedRoot("src/components/viewer/KeynotePanel.tsx", "loadExistingKeynote")))
      .not.toContain("invalidateParseOperation(");

    const keynoteItem = readFileSync(
      join(process.cwd(), "src/components/viewer/KeynoteItem.tsx"),
      "utf8",
    ).replace(/\s+/g, "");
    expect(keynoteItem).toMatch(
      /invalidateKeynoteTableOperations\(\).*setTableParsedGrid\(/,
    );

    for (const path of [
      "src/components/viewer/ParsedTableItem.tsx",
      "src/components/viewer/AnnotationOverlay.tsx",
    ]) {
      const text = readFileSync(join(process.cwd(), path), "utf8").replace(/\s+/g, "");
      const invalidate = text.indexOf('invalidateParseOperation("table")');
      const firstSeed = path.endsWith("AnnotationOverlay.tsx")
        ? text.indexOf('setTableParseTab("all")', invalidate)
        : text.indexOf("setTableParsedGrid(", invalidate);
      expect(invalidate, `${path} handoff invalidator`).toBeGreaterThanOrEqual(0);
      expect(firstSeed, `${path} first B seed`).toBeGreaterThan(invalidate);
    }

    const compactAuto = compact(source(AUTO));
    expect(compactAuto).toContain(
      "onClick={()=>{invalidateTableOperation();loadExistingParsed(p);}}",
    );
    expect(compactAuto).toContain(
      "onClick={()=>{invalidateTableOperation();toggleTableCompareModal();}}",
    );
    const autoSource = readFileSync(join(process.cwd(), AUTO), "utf8");
    const reparseMarker = autoSource.indexOf("// Go back to idle with the existing region");
    const reparseInvalidation = autoSource.lastIndexOf("invalidateTableOperation()", reparseMarker);
    const reparsePublication = autoSource.indexOf("setProposedRegions(", reparseMarker);
    expect(reparseInvalidation).toBeGreaterThanOrEqual(0);
    expect(reparseInvalidation).toBeLessThan(reparseMarker);
    expect(reparsePublication).toBeGreaterThan(reparseMarker);
    expect(compact(source(MANUAL))).toContain(
      "onClick={()=>{tableOperation.invalidate();setTableParseRegion(null);setTableParseStep(\"idle\")",
    );
  });

  it("pins page/unmount, map-input, Guided tuning, and modal-edit invalidators", () => {
    const panel = readFileSync(join(process.cwd(), TABLE_PANEL), "utf8");
    expect(panel).toContain("operationPageRef.current === pageNumber");
    expect(panel).toContain("useEffect(() => () => invalidateTableOperation()");
    for (const owner of [
      "handleTagColumnChange",
      "handleTagYoloClassChange",
      "handleMapTagsStrictnessChange",
      "handleDrawingNumberPrefixesChange",
    ]) expect(compact(namedRoot(TABLE_PANEL, owner))).toContain("invalidateTableOperation()");

    const guided = readFileSync(join(process.cwd(), GUIDED), "utf8");
    expect(guided.match(/invalidateGuidedParseOperations\(\)/g)?.length).toBe(8);
    expect(guided.match(/invalidateGuidedParseOperations\("table"\)/g)?.length).toBe(2);
    expect(compact(namedRoot(GUIDED, "proposeGrid")))
      .toContain('tableOperation.begin("supersede")');
    expectOrder(GUIDED, "repeatRowDown", "invalidateGuidedParseOperations()", "setGuidedParseRows(");
    expectOrder(GUIDED, "repeatColRight", "invalidateGuidedParseOperations()", "setGuidedParseCols(");
    expectOrder(GUIDED, "handleCancel", "invalidateGuidedParseOperations()", "resetGuidedParse()");
    const compactGuided = compact(source(GUIDED));
    for (const setter of [
      "setRowTolerance",
      "setColGap",
      "setColConfidence",
      "setExpectedCols",
    ]) expect(compactGuided).toContain(`invalidateGuidedParseOperations();${setter}(`);
    expect(compactGuided).toContain("return()=>{invalidateGuidedParseOperations();resetGuidedParse()");

    expectOrder(MODAL, "handleCellChange", "tableOperation.invalidate()", "setTableParsedGrid(");
    expectOrder(MODAL, "handleHeaderRename", "tableOperation.invalidate()", "setTableParsedGrid(");
    expectOrder(MODAL, "handleSourceChange", "tableOperation.invalidate()", "setSelectedSource(");
    expect(compact(namedRoot(MODAL, "closeModal"))).toContain("tableOperation.invalidate()");
  });
});
