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
const CELL_STRUCTURE_HOOK = "src/hooks/useTableCellStructureOperation.ts";
const COMMANDS = "src/stores/viewerCommands.ts";

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
  it("loads the operation hook only in six cold Table surfaces and keeps hot canvas files hook-free", () => {
    expect(Object.fromEntries([
      AUTO,
      GUIDED,
      MANUAL,
      MODAL,
      TABLE_PANEL,
      CELL_STRUCTURE_HOOK,
    ].map((path) => [path, { imports: importCount(path, HOOK_MODULE), calls: hookCallCount(path) }])))
      .toEqual({
        [AUTO]: { imports: 1, calls: 1 },
        [GUIDED]: { imports: 1, calls: 1 },
        [MANUAL]: { imports: 1, calls: 1 },
        [MODAL]: { imports: 1, calls: 1 },
        [TABLE_PANEL]: { imports: 1, calls: 1 },
        [CELL_STRUCTURE_HOOK]: { imports: 1, calls: 1 },
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
  }, 30_000);

  it("pins all nine roots to the required admission policy and synchronous authorization seam", () => {
    const roots = [
      [TABLE_PANEL, "detectCsiAndPersist", "tableOperation.begin()"],
      [TABLE_PANEL, "handleMapTags", "tableOperation.begin()"],
      [AUTO, "processRegions", "tableOperation.begin()"],
      [AUTO, "handleReviewSave", "tableOperation.begin()"],
      [CELL_STRUCTURE_HOOK, "detect", "tableOperation.begin()"],
      [MANUAL, "parseFromIntersections", "tableOperation.begin()"],
      [GUIDED, "proposeGrid", 'tableOperation.begin("supersede")'],
      [GUIDED, "handleParse", "tableOperation.begin()"],
      [MODAL, "handleDone", "tableOperation.begin()"],
    ] as const;
    expect(roots).toHaveLength(9);

    expect(Object.fromEntries([TABLE_PANEL, AUTO, MANUAL, GUIDED, MODAL, CELL_STRUCTURE_HOOK]
      .map((path) => [path, tableBeginCallCount(source(path))])))
      .toEqual({
        [TABLE_PANEL]: 2,
        [AUTO]: 2,
        [MANUAL]: 1,
        [GUIDED]: 2,
        [MODAL]: 1,
        [CELL_STRUCTURE_HOOK]: 1,
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
      .toContain("detectCsiAndPersist(tableParsedGrid,undefined,token)");
    expect(compact(namedRoot(MANUAL, "parseFromIntersections")))
      .toContain("detectCsiAndPersist(grid,{resetAfter:false},token)");
    const guidedSave = compact(namedRoot(GUIDED, "handleParse"));
    expect(guidedSave).toContain("awaitdetectCsiAndPersist({");
    expect(guidedSave).toContain("resetGuided:true");
    expect(guidedSave).toContain("setParsedRevision(token.revision+1)");
    expect(guidedSave.lastIndexOf("token)"))
      .toBeGreaterThan(guidedSave.indexOf("setParsedRevision(token.revision+1)"));

    const helper = compact(namedRoot(TABLE_PANEL, "detectCsiAndPersist"));
    expect(helper).toContain("constownsToken=inheritedToken===undefined");
    expect(helper).toContain("conststarted=ownsToken?tableOperation.begin():null");
    expect(helper).toContain("completeTableParseOperation(token,{resetGuided:opts?.resetGuided,afterTerminal:");
    expect(helper).toContain("opts?.onLocalSuccess?.()");
    expect(helper).toContain("if(ownsToken)tableOperation.finish(token)");

    const combined = [TABLE_PANEL, AUTO, MANUAL, GUIDED, MODAL, CELL_STRUCTURE_HOOK]
      .map((path) => readFileSync(join(process.cwd(), path), "utf8"))
      .join("\n");
    for (const retired of [
      "isSavingRef",
      "setAutoParsing(false)",
      "setProposing(false)",
      "setSavingDone(false)",
      "onAuthorizedSuccess",
    ]) expect(combined).not.toContain(retired);
  });

  it("pins atomic owner-authorized review and terminal publications", () => {
    for (const [path, owner] of [
      [AUTO, "processRegions"],
      [MANUAL, "parseFromIntersections"],
      [GUIDED, "handleParse"],
    ] as const) {
      const body = compact(namedRoot(path, owner));
      expect(body, `${path}:${owner} publishes one review snapshot`)
        .toContain("constreviewCommitted=publishTableReviewForOperation(token,{");
      expect(body, `${path}:${owner} stops when review ownership was lost`)
        .toContain("if(!reviewCommitted)return");
      expect(body).not.toContain("setTableParseStepForOperation(");
      expect(body).not.toMatch(/\bsetTableParsedGrid\(/);
      expect(body).not.toMatch(/\bsetTableParseMeta\(/);
    }
    expect(compact(namedRoot(AUTO, "processRegions")))
      .toContain("grid,meta:reviewMeta,region:reviewRegion");
    expect(compact(namedRoot(MANUAL, "parseFromIntersections")))
      .toContain("constgrid={headers,rows,tagColumn}");
    expect(compact(namedRoot(MANUAL, "parseFromIntersections")))
      .toContain("meta:null");
    expect(compact(namedRoot(GUIDED, "handleParse")))
      .toContain("grid:{headers:result.headers,rows:result.rows}");
    expect(compact(namedRoot(GUIDED, "handleParse")))
      .toContain("meta:null");

    const review = compact(namedRoot(COMMANDS, "publishTableReviewForOperation"));
    expect(review).toContain('prepareParseEntry(before.tableParseStep,"review",token)');
    expect(review).toContain("if(!useParseFlowStore.getState().isParseOperationCurrent(token))returnfalse");
    expect(review.match(/useParseFlowStore\.setState/g)).toHaveLength(1);
    expect(review).toContain("tableParsedGrid:publication.grid");
    expect(review).toContain("tableParseMeta:publication.meta");
    expect(review).toContain('tableParseStep:"review"');
    expect(review).toContain("returncommitted&&useParseFlowStore.getState().isParseOperationCurrent(token)");

    const terminal = compact(namedRoot(COMMANDS, "completeTableParseOperation"));
    expect(terminal).toContain("options.afterTerminal?.()");
    expect(terminal).toContain("terminalOperations=parseOperations");
    expect(terminal).toContain(
      "currentOperations.table===expectedOperations.table",
    );
    expect(terminal.match(/useParseFlowStore\.setState/g)).toHaveLength(1);
    expect(terminal).toContain(
      'constclearsGuided=options.resetGuided&&state.guidedParseOwner==="table"',
    );
    expect(terminal).toContain(
      'clearsGuided?["table","keynote","notes"]:["table"]',
    );
    expect(terminal).toContain("returncompleted");
    expect(terminal).not.toMatch(/\bresetTableParse\(/);
    expect(terminal).not.toMatch(/\bresetGuidedParse\(/);
    expect(terminal).toContain(
      'if(ownsParseToolAuthority(token)){useToolStore.getState().setMode("move");}',
    );
    expect(terminal.indexOf('setMode("move")'))
      .toBeLessThan(terminal.indexOf("useParseFlowStore.setState"));
    expect(terminal.indexOf("useParseFlowStore.setState"))
      .toBeLessThan(terminal.indexOf("options.afterTerminal?.()"));
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
  it("keeps stored-tab and retained-row handoffs in one terminal Parse publication", () => {
    const tabHandler = compact(namedRoot(TABLE_PANEL, "handleTableTabChange"));
    expect(tabHandler).toContain("transitionTableParseTab(tab)");
    expect(tabHandler).not.toContain("invalidateTableOperation()");
    expect(tabHandler).not.toContain("setTableParseTab(tab)");

    const tabCommand = compact(namedRoot(COMMANDS, "transitionTableParseTab"));
    expect(tabCommand).toContain("if(before.tableParseTab===tableParseTab)return");
    expect(tabCommand.match(/useParseFlowStore\.setState/g)).toHaveLength(1);
    expect(tabCommand).toContain('constownsGuided=state.guidedParseOwner==="table"');
    expect(tabCommand).toContain("guidedParseOwner:null");
    expect(tabCommand).toContain(
      'ownsGuided?["table","keynote","notes"]:["table"]',
    );
    expect(tabCommand.indexOf("useToolStore.setState"))
      .toBeLessThan(tabCommand.indexOf("useParseFlowStore.setState"));
    const tableLoad = compact(namedRoot(TABLE_PANEL, "loadExistingParsed"));
    expect(tableLoad).toContain("openTableReviewTarget(targetPage,publication)");
    expect(tableLoad).toContain("openTableReviewWorkspace(publication)");
    expect(tableLoad).not.toContain("invalidateTableOperation()");

    const keynoteLoad = compact(namedRoot(
      "src/components/viewer/KeynotePanel.tsx",
      "loadExistingKeynote",
    ));
    expect(keynoteLoad).toContain('openTableReviewTarget(targetPage,publication,"keynote")');
    expect(keynoteLoad).toContain('openTableReviewWorkspace(publication,"keynote")');
    expect(keynoteLoad).not.toContain("invalidateParseOperation(");

    const compare = compact(source("src/components/viewer/CompareEditTab.tsx"));
    expect(compare).not.toContain("beforeHandoff");
    expect(compare).not.toContain("setPage(");
    expect(compare).toContain("toggleTableCompareModal();loadExistingParsed(t.region)");
    expect(compare).toContain(
      "toggleTableCompareModal();loadExistingParsed(t.region,t.pageNum)",
    );

    for (const [path, sourceKind] of [
      ["src/components/viewer/ParsedTableItem.tsx", "table"],
      ["src/components/viewer/KeynoteItem.tsx", "keynote"],
    ] as const) {
      const item = readFileSync(join(process.cwd(), path), "utf8").replace(/\s+/g, "");
      expect(item).toContain("toggleTableCompareModal();openTableReviewTarget(");
      expect(item).not.toContain("invalidateKeynoteTableOperations()");
      expect(item).not.toContain('invalidateParseOperation("table")');
      if (sourceKind === "keynote") expect(item).toContain('},"keynote")');
    }

    const annotation = compact(source("src/components/viewer/AnnotationOverlay.tsx"));
    expect(annotation).toContain(
      "acceptTableParseRegion([minX,minY,maxX,maxY])",
    );

    const compactAuto = compact(source(AUTO));
    expect(compactAuto).toContain(
      "onClick={()=>{loadExistingParsed(p);}}",
    );
    expect(compactAuto).toContain(
      "onClick={()=>{toggleTableCompareModal();invalidateTableOperation();}}",
    );
    const restart = compactAuto.indexOf("restartTableParseFromCurrentRegion()");
    const reparseMarker = compactAuto.lastIndexOf("/*Reparsewithadjustedoptions*/", restart);
    const localSeed = compactAuto.lastIndexOf("setProposedRegions", restart);
    const reparse = compactAuto.slice(reparseMarker, restart);
    expect(restart).toBeGreaterThanOrEqual(0);
    expect(reparseMarker).toBeGreaterThanOrEqual(0);
    expect(localSeed).toBeGreaterThanOrEqual(0);
    expect(reparse).not.toContain("invalidateTableOperation()");
    expect(localSeed).toBeLessThan(restart);
    expect(compact(source(MANUAL))).toContain("resetTableParseWorkspace()");
    expect(compact(source(MANUAL))).not.toContain(
      "tableOperation.invalidate();setTableParseRegion(null)",
    );
  });

  it("pins owner-aware Guided claim, publication, controls, and cleanup seams", () => {
    const panel = readFileSync(join(process.cwd(), TABLE_PANEL), "utf8");
    expect(panel).toContain(
      'invalidateParseOperationAtRevision("table", tableOperation.revision)',
    );
    expect(panel).not.toContain("operationPageRef");
    expect(panel).not.toContain("useEffect(() => () => invalidateTableOperation()");
    const tagColumn = compact(namedRoot(TABLE_PANEL, "handleTagColumnChange"));
    expect(tagColumn).toContain("abortMapTags();setTableParsedGridForUser(");
    expect(tagColumn).not.toContain("invalidateTableOperation()");
    for (const [owner, localSetter] of [
      ["handleTagYoloClassChange", "setTagYoloClassState"],
      ["handleMapTagsStrictnessChange", "setMapTagsStrictnessState"],
      ["handleDrawingNumberPrefixesChange", "setDrawingNumberPrefixesState"],
    ] as const) {
      const body = compact(namedRoot(TABLE_PANEL, owner));
      expect(body).toContain(`${localSetter}(`);
      expect(body).toContain("invalidateTableOperation()");
      expect(body.indexOf(`${localSetter}(`)).toBeLessThan(body.indexOf("invalidateTableOperation()"));
    }

    const guided = readFileSync(join(process.cwd(), GUIDED), "utf8");
    const compactGuided = compact(source(GUIDED));
    expect(compactGuided).toContain('constownsGuidedWorkspace=guidedParseOwner==="table"');
    expect(compactGuided).toContain(
      "constguidedParseRows=ownsGuidedWorkspace?sharedGuidedParseRows:EMPTY_GUIDED_LINES",
    );
    expect(compactGuided).toContain(
      "constguidedParseCols=ownsGuidedWorkspace?sharedGuidedParseCols:EMPTY_GUIDED_LINES",
    );

    const proposal = compact(namedRoot(GUIDED, "proposeGrid"));
    expect(proposal).toContain('tableOperation.begin("supersede")');
    expect(proposal).toContain(
      "claimGuidedParseWorkspaceForOperation(token,target.regionBbox)",
    );
    expect(proposal).toContain("publishGuidedProposalForOperation(token,");
    expect(proposal.indexOf("claimGuidedParseWorkspaceForOperation"))
      .toBeLessThan(proposal.indexOf("await"));
    expect(proposal.indexOf("await"))
      .toBeLessThan(proposal.indexOf("publishGuidedProposalForOperation"));

    const parse = compact(namedRoot(GUIDED, "handleParse"));
    expect(parse).toContain("if(!ownsGuidedWorkspace||!pageTextract?.words||");
    expect(parse).toContain('invalidateGuidedParseOperations("table")');
    expect(parse).toContain("publishTableReviewForOperation(token,");

    const repeatRow = compact(namedRoot(GUIDED, "repeatRowDown"));
    expect(repeatRow).toContain(
      'constlease=beginGuidedGridEdit("table",sharedGuidedParseRegion)',
    );
    expect(repeatRow).toContain("if(!lease)return");
    expect(repeatRow).toContain("setGuidedParseRowsForLease(newRows,lease)");
    const repeatCol = compact(namedRoot(GUIDED, "repeatColRight"));
    expect(repeatCol).toContain(
      'constlease=beginGuidedGridEdit("table",sharedGuidedParseRegion)',
    );
    expect(repeatCol).toContain("if(!lease)return");
    expect(repeatCol).toContain("setGuidedParseColsForLease(newCols,lease)");
    expect(compact(namedRoot(GUIDED, "handleCancel")))
      .toContain('resetGuidedParseWorkspace("table")');

    for (const rawPublication of [
      /\bsetGuidedParseRows\(/,
      /\bsetGuidedParseCols\(/,
      /\bsetGuidedParseActive\(/,
      /\bsetGuidedParseRegion\(/,
      /\bresetGuidedParse\(/,
    ]) expect(guided, `Guided Table has no raw shared publication ${rawPublication}`)
      .not.toMatch(rawPublication);
    for (const setter of [
      "setRowTolerance",
      "setColGap",
      "setColConfidence",
      "setExpectedCols",
    ]) expect(compactGuided).toMatch(
      new RegExp(`if\\(!authorizeTuningChange\\(\\)\\)return;${setter}\\(`),
    );
    const authorizeTune = compact(namedRoot(GUIDED, "authorizeTuningChange"));
    expect(authorizeTune).toContain(
      'beginGuidedGridEdit("table",sharedGuidedParseRegion)!==null',
    );
    expect(proposal).toContain("before.guidedParseOwner!==expectation.owner");
    expect(proposal).toContain(
      "before.parseOperations.table.revision!==expectation.tableRevision",
    );
    expect(proposal).toContain("before.tableParseRegion!==expectation.region");
    expect(compactGuided).toContain(
      "proposeGrid(tableParseRegion,expectation)",
    );
    expect(compactGuided).not.toContain(
      "return()=>{invalidateGuidedParseOperations();resetGuidedParse",
    );

    const claim = compact(namedRoot(COMMANDS, "claimGuidedParseWorkspaceForOperation"));
    expect(claim).toContain("constlive=state.parseOperations[token.kind]");
    expect(claim).toContain("if(!live.busy||live.revision!==token.revision)returnstate");
    expect(claim).toContain("lease=workspaceLease(parseOperations,token.kind)");
    expect(claim).toContain("guidedParseOwner:token.kind");
    const publish = compact(namedRoot(COMMANDS, "publishGuidedProposalForOperation"));
    expect(publish).toContain("state.guidedParseOwner!==token.kind");
    expect(publish).toContain("return{guidedParseRows,guidedParseCols,guidedParseActive:true,}");

    for (const owner of ["handleCellChange", "handleHeaderRename", "handleSourceChange"] as const) {
      const body = compact(namedRoot(MODAL, owner));
      expect(body).toContain("setTableParsedGridForUser(");
      expect(body).not.toContain("tableOperation.invalidate()");
      expect(body).not.toMatch(/\bsetTableParsedGrid\(/);
    }
    expectOrder(MODAL, "handleSourceChange", "setSelectedSource(", "setTableParsedGridForUser(");

    const manual = compact(source(MANUAL));
    expect(manual).toContain("setTableManualGeometryForUser({tableParseRowBBs:rowBBsBackup})");
    expect(manual).toContain("setTableManualGeometryForUser({tableParseColumnBBs:tableParseColumnBBsNext})");
    expect(manual).toContain("setTableManualGeometryForUser({tableParseRowBBs:tableParseRowBBsNext})");
    expect(manual).not.toMatch(/\baddTableParseColumn\(/);
    expect(manual).not.toMatch(/\baddTableParseRow\(/);

    const annotation = compact(source("src/components/viewer/AnnotationOverlay.tsx"));
    expect(annotation).toContain("addTableParseColumnForUser([minX,minY,maxX,maxY])");
    expect(annotation).toContain("addTableParseRowForUser([minX,minY,maxX,maxY])");
    expect(annotation).not.toMatch(/\baddTableParseColumn\(/);
    expect(annotation).not.toMatch(/\baddTableParseRow\(/);
    const closeModal = compact(namedRoot(MODAL, "closeModal"));
    expect(closeModal).toContain(
      "constexpectedRevision=useParseFlowStore.getState().parseOperations.table.revision",
    );
    expect(closeModal).toContain(
      'toggleModal();invalidateParseOperationAtRevision("table",expectedRevision)',
    );
    expect(closeModal).not.toContain("tableOperation.invalidate()");
  });
});
