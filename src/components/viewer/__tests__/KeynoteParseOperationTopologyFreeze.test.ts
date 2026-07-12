// [refactor jul12 P2.4 A2c] Exact Keynote operation-root, composition, and invalidation topology.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const HOOK_MODULE = "@/hooks/useParseOperation";
const KEYNOTE = "src/components/viewer/KeynotePanel.tsx";
const TABLE_GUIDED = "src/components/viewer/GuidedParseTab.tsx";
const TABLE_PANEL = "src/components/viewer/TableParsePanel.tsx";
const COMPARE_TAB = "src/components/viewer/CompareEditTab.tsx";
const KEYNOTE_ITEM = "src/components/viewer/KeynoteItem.tsx";
const SPECS_NOTES = "src/components/viewer/SpecsNotesPanel.tsx";
const ANNOTATION_OVERLAY = "src/components/viewer/AnnotationOverlay.tsx";
const PDF_PAGE = "src/components/viewer/PDFPage.tsx";
const GUIDED_OVERLAY = "src/components/viewer/GuidedParseOverlay.tsx";
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

function text(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
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
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : null;
  return name === "useCallback" ? callback : undefined;
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

function compact(node: ts.Node | string): string {
  return (typeof node === "string" ? node : node.getText(node.getSourceFile())).replace(/\s+/g, "");
}

function importCount(path: string, moduleName: string): number {
  return source(path).statements.filter((statement): statement is ts.ImportDeclaration =>
    ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) &&
    statement.moduleSpecifier.text === moduleName
  ).length;
}

function operationCalls(
  root: ts.Node,
  method: "begin" | "finish",
): ts.CallExpression[] {
  return descendants(root, ts.isCallExpression).filter((call) =>
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === "keynoteOperation" &&
    call.expression.name.text === method
  );
}

function isInsideFinally(node: ts.Node, boundary: ts.Node): boolean {
  return descendants(boundary, ts.isTryStatement).some((statement) => {
    const block = statement.finallyBlock;
    return Boolean(block && node.getStart() >= block.getStart() && node.getEnd() <= block.getEnd());
  });
}

function terminalCallName(call: ts.CallExpression): string | null {
  if (ts.isIdentifier(call.expression)) return call.expression.text;
  if (ts.isPropertyAccessExpression(call.expression)) return call.expression.name.text;
  return null;
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
  const body = compact(namedRoot(path, owner));
  expect(body, `${path}:${owner} contains ${before}`).toContain(before);
  expect(body, `${path}:${owner} contains ${after}`).toContain(after);
  expect(body.indexOf(before), `${path}:${owner} ordering`).toBeLessThan(body.indexOf(after));
}

describe("A2c exact Keynote operation topology", () => {
  it("adds one cold Keynote operation hook and keeps canvas/row surfaces hook-free", () => {
    expect(importCount(KEYNOTE, HOOK_MODULE)).toBe(1);
    const calls = descendants(source(KEYNOTE), ts.isCallExpression).filter((call) =>
      ts.isIdentifier(call.expression) && call.expression.text === "useParseOperation" &&
      call.arguments[0]?.getText() === '"keynote"'
    );
    expect(calls).toHaveLength(1);

    for (const path of [
      "src/components/viewer/AnnotationOverlay.tsx",
      PDF_PAGE,
      GUIDED_OVERLAY,
      KEYNOTE_ITEM,
      "src/components/viewer/ParseRegionLayer.tsx",
    ]) expect(importCount(path, HOOK_MODULE), `${path} remains operation-hook-free`).toBe(0);
  });

  it("pins exactly four outer roots, admission policies, and finally-owned cleanup", () => {
    const roots = [
      ["parseKeynotes", "keynoteOperation.begin()"],
      ["autoParseKeynote", "keynoteOperation.begin()"],
      ["proposeGrid", 'keynoteOperation.begin("supersede")'],
      ["parseFromGuidedGrid", "keynoteOperation.begin()"],
    ] as const;
    expect(roots).toHaveLength(4);
    expect(operationCalls(source(KEYNOTE), "begin")).toHaveLength(4);

    for (const [owner, admission] of roots) {
      const root = namedRoot(KEYNOTE, owner);
      const begins = operationCalls(root, "begin");
      const awaits = descendants(root, ts.isAwaitExpression);
      expect(begins, `${owner} owns exactly one begin`).toHaveLength(1);
      expect(awaits.length, `${owner} remains async`).toBeGreaterThan(0);
      expect(begins[0].getStart(), `${owner} begins before first await`)
        .toBeLessThan(Math.min(...awaits.map((node) => node.getStart())));
      expect(compact(root), `${owner} policy`).toContain(admission);
      const finishes = operationCalls(root, "finish");
      expect(finishes, `${owner} owns exactly one finish`).toHaveLength(1);
      expect(isInsideFinally(finishes[0], root), `${owner} finish stays in finally`).toBe(true);

      for (const clause of descendants(root, ts.isCatchClause)) {
        const setters = descendants(clause.block, ts.isCallExpression)
          .filter((call) => /^set[A-Z]/.test(terminalCallName(call) ?? ""));
        for (const setter of setters) {
          expect(
            hasIdentifierCallAncestor(setter, "commitParseOperation", clause),
            `${owner} catch setter ${terminalCallName(setter)} stays authorized`,
          ).toBe(true);
        }
      }
    }
  });

  it("threads the outer token into both leaves and forbids nested ownership", () => {
    const helperNames = ["saveKeynoteToIntelligence", "mapKeynoteKeysToYoloTags"] as const;
    for (const helperName of helperNames) {
      const helper = namedRoot(KEYNOTE, helperName);
      expect(operationCalls(helper, "begin"), `${helperName} never begins`).toEqual([]);
      expect(operationCalls(helper, "finish"), `${helperName} never finishes`).toEqual([]);
      expect(compact(helper), `${helperName} validates inherited authority`)
        .toContain("keynoteOperation.isCurrent(token)");
    }

    for (const owner of ["parseKeynotes", "autoParseKeynote"] as const) {
      const root = compact(namedRoot(KEYNOTE, owner));
      expect(root).toMatch(/saveKeynoteToIntelligence\([^;]+,token\)/);
      expect(root).toMatch(/mapKeynoteKeysToYoloTags\([^;]+,token\)/);
    }
    expect(compact(namedRoot(KEYNOTE, "parseFromGuidedGrid")))
      .toMatch(/mapKeynoteKeysToYoloTags\([^;]+,token\)/);

    const file = text(KEYNOTE);
    for (const retired of [
      "isSavingRef",
      "setAutoParsing(false)",
      "setGuidedLoading(false)",
    ]) expect(file).not.toContain(retired);
    expect(file).toContain("autoParsingRevision === keynoteOperation.revision");
    expect(file).toContain("proposalRevision === keynoteOperation.revision");
  });

  it("keeps captured Query/durable work outside commit and live append/reset tails authorized", () => {
    for (const owner of ["saveKeynoteToIntelligence", "parseFromGuidedGrid"] as const) {
      const root = namedRoot(KEYNOTE, owner);
      for (const call of descendants(root, ts.isCallExpression).filter((candidate) =>
        [
          "updatePageIntelligenceForPage",
          "saveParsedRegion",
          "refreshPageCsiSpatialMap",
        ].includes(terminalCallName(candidate) ?? "")
      )) {
        expect(
          hasIdentifierCallAncestor(call, "commitParseOperation", root),
          `${owner}:${terminalCallName(call)} stays outside commit`,
        ).toBe(false);
      }
    }
    const map = namedRoot(KEYNOTE, "mapKeynoteKeysToYoloTags");
    const adoption = descendants(map, ts.isCallExpression).find((call) =>
      terminalCallName(call) === "addYoloTagsBulk"
    );
    expect(adoption).toBeDefined();
    expect(hasIdentifierCallAncestor(adoption!, "commitParseOperation", map)).toBe(false);

    for (const owner of ["parseKeynotes", "autoParseKeynote", "parseFromGuidedGrid"] as const) {
      const body = compact(namedRoot(KEYNOTE, owner));
      expect(body).toContain("commitParseOperation(token,");
      expect(body).toContain("completeKeynoteParseOperation(token");
    }
  });
});

describe("A2c Keynote invalidation and shared-workspace topology", () => {
  it("pins page/unmount, tab, clear, input, and retained-row boundaries", () => {
    const keynote = text(KEYNOTE);
    expect(keynote).toContain("operationPageRef.current === pageNumber");
    expect(keynote).toContain("useEffect(() => () => keynoteOperation.invalidate()");
    expectOrder(KEYNOTE, "handleKeynoteTabChange", "resetKeynoteGuidedParse()", "setKeynoteParseTab(tab)");
    expectOrder(KEYNOTE, "repeatRowDown", "keynoteOperation.invalidate()", "addKeynoteRowBB(");
    expectOrder(KEYNOTE, "repeatColumnRight", "keynoteOperation.invalidate()", "addKeynoteColumnBB(");
    expectOrder(KEYNOTE, "handleKeynoteYoloClassChange", "keynoteOperation.invalidate()", "setKeynoteYoloClass(");

    expect(compact(namedRoot(KEYNOTE, "loadExistingKeynote")))
      .not.toContain("invalidateParseOperation(");
    expect(compact(text(KEYNOTE_ITEM))).toMatch(
      /invalidateKeynoteTableOperations\(\).*setTableParsedGrid\(/,
    );
    expect(compact(text(KEYNOTE)))
      .toContain("beforeHandoff={invalidateKeynoteTableOperations}");
    expect(compact(text(COMPARE_TAB)))
      .toContain("beforeHandoff();setPage(t.pageNum);loadExistingParsed(t.region)");
    expect(compact(namedRoot(SPECS_NOTES, "handleClose")))
      .toContain("toggleSpecsNotesParsePanel()");
    expect(compact(namedRoot(SPECS_NOTES, "handleTabChange")))
      .toContain("setSpecsNotesParseTab(tab)");

    const panel = compact(text(KEYNOTE));
    expect(panel).not.toContain("keynoteOperation.invalidate();resetKeynoteParse()");
    expect(panel.match(/onClick={resetKeynoteParse}/g)).toHaveLength(4);
    expect(panel.match(/resetKeynoteGuidedParse\(\)/g)).toHaveLength(3);

    expectOrder(
      ANNOTATION_OVERLAY,
      "handleMouseDown",
      'invalidateParseOperation("keynote")',
      "setKeynoteYoloClass(",
    );
    const mouseUp = compact(namedRoot(ANNOTATION_OVERLAY, "handleMouseUp"));
    expect(mouseUp).toContain("acceptKeynoteParseRegion([minX,minY,maxX,maxY])");
    expect(mouseUp.match(/invalidateParseOperation\("keynote"\)/g)).toHaveLength(2);
    expect(mouseUp).toMatch(
      /invalidateParseOperation\("keynote"\);parse\.addKeynoteColumnBB\(/,
    );
    expect(mouseUp).toMatch(
      /invalidateParseOperation\("keynote"\);parse\.addKeynoteRowBB\(/,
    );
  });

  it("begins one shared Guided lease per canvas gesture and guards every leased write", () => {
    const command = compact(namedRoot(COMMANDS, "invalidateGuidedParseOperations"));
    expect(command).toContain('invalidateParseOperationKinds(state.parseOperations,kinds)');
    expect(command).toContain('["table","keynote","notes"]');

    const begin = compact(namedRoot(COMMANDS, "beginGuidedGridEdit"));
    expect(begin).toMatch(
      /invalidateParseOperationKinds\(state\.parseOperations,\["table","keynote","notes"\],?\)/,
    );
    expect(begin).toContain("lease=workspaceLease(parseOperations)");
    expect(begin).toContain("returnlease");

    for (const [setter, field] of [
      ["setGuidedParseRowsForLease", "guidedParseRows"],
      ["setGuidedParseColsForLease", "guidedParseCols"],
    ] as const) {
      const guarded = compact(namedRoot(COMMANDS, setter));
      expect(guarded).toContain(
        "if(!matchesGuidedLease(state.parseOperations,lease))returnstate",
      );
      expect(guarded).toContain(`return{${field}}`);
    }

    // PDFPage stays hook-free and owns only a module-stable imperative wrapper. The overlay receives
    // the guarded commands directly, so no closure/subscription enters the canvas pointer path.
    const slot = compact(namedRoot(PDF_PAGE, "beginGuidedGridOperations"));
    expect(slot).toContain("returnbeginGuidedGridEdit()");
    const pdfPage = compact(text(PDF_PAGE));
    expect(pdfPage).toContain("setRows={setGuidedParseRowsForLease}");
    expect(pdfPage).toContain("setCols={setGuidedParseColsForLease}");
    expect(pdfPage).toContain("onGridEditStart={beginGuidedGridOperations}");
    expect(pdfPage.match(/beginGuidedGridEdit\(\)/g)).toHaveLength(1);

    const mouseDown = compact(namedRoot(GUIDED_OVERLAY, "handleMouseDown"));
    expect(mouseDown).toContain("dragLeaseRef.current=onGridEditStart()");
    expect(mouseDown.match(/onGridEditStart\(\)/g)).toHaveLength(1);

    const mouseMove = compact(namedRoot(GUIDED_OVERLAY, "handleMouseMove"));
    expect(mouseMove).toContain("constlease=dragLeaseRef.current");
    expect(mouseMove).toContain("setRows(next,lease)");
    expect(mouseMove).toContain("setCols(next,lease)");
    expect(mouseMove).not.toContain("onGridEditStart()");

    const doubleClick = compact(namedRoot(GUIDED_OVERLAY, "handleDoubleClick"));
    expect(doubleClick).toContain("constlease=onGridEditStart();setRows([...rows,ny],lease)");
    expect(doubleClick).toContain("constlease=onGridEditStart();setCols([...cols,nx],lease)");
    expect(doubleClick.match(/onGridEditStart\(\)/g)).toHaveLength(2);

    const overlay = compact(source(GUIDED_OVERLAY));
    expect(overlay.match(/onGridEditStart\(\)/g)).toHaveLength(3);
    expect(overlay).toContain("if(active)return;dragRef.current=null;dragLeaseRef.current=null");
    expect(overlay).toContain("if(!active||!dragging)return");

    for (const [path, owner, excludedKind] of [
      [KEYNOTE, "proposeGrid", "keynote"],
      [KEYNOTE, "parseFromGuidedGrid", "keynote"],
      [TABLE_GUIDED, "proposeGrid", "table"],
      [TABLE_GUIDED, "handleParse", "table"],
    ] as const) {
      const body = compact(namedRoot(path, owner));
      const invalidation = `invalidateGuidedParseOperations("${excludedKind}")`;
      expect(body).toContain(invalidation);
      expect(body.indexOf(invalidation)).toBeLessThan(body.indexOf("await"));
    }
    expect(compact(namedRoot(TABLE_PANEL, "handleTableTabChange")))
      .toContain('invalidateGuidedParseOperations("table")');
  });

  it("pins latest-value proposal tuning and reentrant-safe completion ordering", () => {
    const proposal = compact(namedRoot(KEYNOTE, "proposeGrid"));
    for (const field of ["rowTolerance", "minColGap", "minHitsRatio", "columns"]) {
      expect(proposal, `proposal captures ${field}`).toContain(field);
    }
    const keynote = compact(text(KEYNOTE));
    for (const setter of [
      "setGuidedRowTol",
      "setGuidedColGap",
      "setGuidedColConf",
      "setGuidedExpCols",
    ]) {
      expect(keynote).toMatch(new RegExp(`${setter}\\([^;]+\\);proposeGrid\\(`));
      expect(keynote).not.toMatch(
        new RegExp(`invalidateGuidedParseOperations\\(\\);${setter}\\(`),
      );
    }

    const completion = compact(namedRoot(COMMANDS, "completeKeynoteParseOperation"));
    expect(completion).toContain("setMode(\"move\")");
    expect(completion).toContain("isParseOperationCurrent(token)");
    expect(completion).toContain("resetGuidedParse()");
    expect(completion).toContain("resetKeynoteParse()");
    expect(completion.indexOf('setMode("move")')).toBeLessThan(completion.indexOf("resetKeynoteParse()"));
    expect(completion.lastIndexOf("isParseOperationCurrent(token)"))
      .toBeLessThan(completion.indexOf("resetKeynoteParse()"));
  });
});
