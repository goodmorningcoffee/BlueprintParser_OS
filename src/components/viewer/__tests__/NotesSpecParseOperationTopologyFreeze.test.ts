// @vitest-environment node
// [refactor jul12 P2.4 A2d] Exact Notes/Spec root, inheritance, and boundary topology.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const HOOK_MODULE = "@/hooks/useParseOperation";
const NOTES = "src/components/viewer/NotesParser.tsx";
const SPEC = "src/components/viewer/SpecParser.tsx";
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

function operationCalls(
  root: ts.Node,
  owner: "notesOperation" | "specOperation",
  method: "begin" | "finish",
): ts.CallExpression[] {
  return descendants(root, ts.isCallExpression).filter((call) =>
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === owner &&
    call.expression.name.text === method
  );
}

function isInsideFinally(node: ts.Node, boundary: ts.Node): boolean {
  return descendants(boundary, ts.isTryStatement).some((statement) => {
    const block = statement.finallyBlock;
    return Boolean(block && node.getStart() >= block.getStart() && node.getEnd() <= block.getEnd());
  });
}

function isInsideCommit(node: ts.Node, boundary: ts.Node): boolean {
  let current = node.parent;
  while (current && current !== boundary) {
    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression) &&
        current.expression.text === "commitParseOperation") return true;
    current = current.parent;
  }
  return false;
}

function terminalCallName(call: ts.CallExpression): string | null {
  if (ts.isIdentifier(call.expression)) return call.expression.text;
  if (ts.isPropertyAccessExpression(call.expression)) return call.expression.name.text;
  return null;
}

function importCount(path: string, moduleName: string): number {
  return source(path).statements.filter((statement): statement is ts.ImportDeclaration =>
    ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) &&
    statement.moduleSpecifier.text === moduleName
  ).length;
}

describe("A2d exact Notes/Spec operation topology", () => {
  it("adds exactly one cold operation hook per parser and none to canvas primitives", () => {
    expect(importCount(NOTES, HOOK_MODULE)).toBe(1);
    expect(importCount(SPEC, HOOK_MODULE)).toBe(1);
    expect(compact(source(NOTES))).toContain('useParseOperation("notes")');
    expect(compact(source(SPEC))).toContain('useParseOperation("spec")');

    for (const path of [
      "src/components/viewer/PDFPage.tsx",
      "src/components/viewer/AnnotationOverlay.tsx",
      "src/components/viewer/ParagraphOverlay.tsx",
      "src/components/viewer/FastManualParseOverlay.tsx",
    ]) expect(importCount(path, HOOK_MODULE), `${path} stays operation-hook-free`).toBe(0);
  });

  it("pins the exact four Notes roots and three Spec roots with their policies", () => {
    const fixtures = [
      [NOTES, "notesOperation", "runAuto", "notesOperation.begin()"],
      [NOTES, "notesOperation", "runProposeGuided", 'notesOperation.begin("supersede")'],
      [NOTES, "notesOperation", "saveFromParagraphBatch", "notesOperation.begin()"],
      [NOTES, "notesOperation", "persistPreviewGrid", "notesOperation.begin()"],
      [SPEC, "specOperation", "runAuto", "specOperation.begin()"],
      [SPEC, "specOperation", "persistPreview", "specOperation.begin()"],
      [SPEC, "specOperation", "saveFromBatch", "specOperation.begin()"],
    ] as const;
    expect(fixtures).toHaveLength(7);

    for (const [path, owner, name, admission] of fixtures) {
      const root = namedRoot(path, name);
      const begins = operationCalls(root, owner, "begin");
      const finishes = operationCalls(root, owner, "finish");
      const awaits = descendants(root, ts.isAwaitExpression);
      expect(begins, `${name} owns exactly one begin`).toHaveLength(1);
      expect(compact(root), `${name} policy`).toContain(admission);
      expect(begins[0].getStart(), `${name} begins before first await`)
        .toBeLessThan(Math.min(...awaits.map((entry) => entry.getStart())));
      expect(finishes, `${name} owns exactly one finish site`).toHaveLength(1);
      expect(isInsideFinally(finishes[0], root), `${name} finish stays in finally`).toBe(true);
    }

    expect(operationCalls(source(NOTES), "notesOperation", "begin")).toHaveLength(4);
    expect(operationCalls(source(SPEC), "specOperation", "begin")).toHaveLength(3);
  });

  it("keeps Auto authority alive through inherited persistence without a nested owner", () => {
    const notesAuto = compact(namedRoot(NOTES, "runAuto"));
    const specAuto = compact(namedRoot(SPEC, "runAuto"));
    expect(notesAuto).toMatch(/awaitpersistPreviewGrid\([^;]+token/);
    expect(specAuto).toMatch(/awaitpersistPreview\([^;]+token/);

    for (const [path, helper, owner] of [
      [NOTES, "persistPreviewGrid", "notesOperation"],
      [SPEC, "persistPreview", "specOperation"],
    ] as const) {
      const body = compact(namedRoot(path, helper));
      expect(body).toContain("inheritedToken");
      expect(body).toContain("ownsToken");
      expect(body).toContain(`${owner}.isCurrent(token)`);
      expect(body).toMatch(new RegExp(`if\\(ownsToken\\)${owner}\\.finish\\(token\\)`));
    }

    for (const retired of ["isSavingRef", "setLoading(false)", "setSaving(false)"]) {
      expect(text(NOTES)).not.toContain(retired);
      expect(text(SPEC)).not.toContain(retired);
    }
    expect(text(NOTES)).toContain("loadingRevision === notesOperation.revision");
    expect(text(NOTES)).toContain("savingRevision === notesOperation.revision");
    expect(text(SPEC)).toContain("loadingRevision === specOperation.revision");
    expect(text(SPEC)).toContain("savingRevision === specOperation.revision");
  });

  it("keeps durable Query work outside commits and guards live catch publications", () => {
    for (const [path, roots] of [
      [NOTES, ["runAuto", "runProposeGuided", "saveFromParagraphBatch", "persistPreviewGrid"]],
      [SPEC, ["runAuto", "persistPreview", "saveFromBatch"]],
    ] as const) {
      for (const name of roots) {
        const root = namedRoot(path, name);
        for (const call of descendants(root, ts.isCallExpression)) {
          const callName = terminalCallName(call);
          if (callName === "saveParsedRegion" || callName === "fetch") {
            expect(isInsideCommit(call, root), `${path}:${name}:${callName} stays durable`).toBe(false);
          }
        }
        for (const clause of descendants(root, ts.isCatchClause)) {
          for (const call of descendants(clause.block, ts.isCallExpression).filter((candidate) =>
            /^set[A-Z]/.test(terminalCallName(candidate) ?? "")
          )) {
            expect(isInsideCommit(call, clause), `${path}:${name} catch setter is authorized`).toBe(true);
          }
        }
      }
    }
  });

  it("pins owner-aware Guided claim, publication, completion, and tab seams", () => {
    const commands = text(COMMANDS);
    for (const name of [
      "claimGuidedParseWorkspaceForOperation",
      "publishGuidedProposalForOperation",
      "invalidateParagraphParseOperations",
      "invalidateNotesWorkspaceOperations",
      "acceptNotesParseRegion",
      "acceptSpecParseRegion",
      "completeNotesParseOperation",
      "completeSpecParseOperation",
      "setSpecsNotesParseTab",
      "toggleSpecsNotesParsePanel",
    ]) expect(commands, `missing ${name}`).toContain(`function ${name}`);

    const proposal = compact(namedRoot(NOTES, "runProposeGuided"));
    expect(proposal).toContain(
      "claimGuidedParseWorkspaceForOperation(token,target.region)",
    );
    expect(proposal).toContain("if(!workspaceLease)return");
    expect(proposal).toContain("cleanupLeaseRef.current=workspaceLease");
    expect(proposal).toContain("publishGuidedProposalForOperation(token,");
    expect(proposal.indexOf("claimGuidedParseWorkspaceForOperation"))
      .toBeLessThan(proposal.indexOf("await"));
    expect(proposal.indexOf("await"))
      .toBeLessThan(proposal.indexOf("publishGuidedProposalForOperation"));
    expect(proposal).not.toContain("invalidateGuidedParseOperations(");

    const build = compact(namedRoot(NOTES, "buildGridFromGuided"));
    expect(build).toContain('if(store.guidedParseOwner!=="notes")returnnull');
    expect(build.indexOf('guidedParseOwner!=="notes"'))
      .toBeLessThan(build.indexOf("constrows=store.guidedParseRows"));

    const notesSource = text(NOTES);
    for (const rawPublication of [
      /\bsetGuidedParseRows\(/,
      /\bsetGuidedParseCols\(/,
      /\bsetGuidedParseActive\(/,
      /\bsetGuidedParseRegion\(/,
      /\bresetGuidedParse\(/,
    ]) expect(notesSource, `Notes has no raw shared publication ${rawPublication}`)
      .not.toMatch(rawPublication);

    const claim = compact(namedRoot(COMMANDS, "claimGuidedParseWorkspaceForOperation"));
    expect(claim).toContain("if(!live.busy||live.revision!==token.revision)returnstate");
    expect(claim).toContain("lease=workspaceLease(parseOperations,token.kind)");
    expect(claim).toContain("guidedParseOwner:token.kind");
    const publish = compact(namedRoot(COMMANDS, "publishGuidedProposalForOperation"));
    expect(publish).toContain("state.guidedParseOwner!==token.kind");
    expect(publish).toContain("return{guidedParseRows,guidedParseCols,guidedParseActive:true,}");

    const invalidateNotes = compact(namedRoot(COMMANDS, "invalidateNotesWorkspaceOperations"));
    expect(invalidateNotes).toContain(
      'constmayRetainGuided=except!=="notes"||state.guidedParseOwner==="notes"',
    );
    expect(invalidateNotes).toContain(
      'except==="notes"&&!mayRetainGuided?(["notes","spec"]asconst)',
    );
    expect(invalidateNotes).toContain(
      "lease=workspaceLease(parseOperations,state.guidedParseOwner)",
    );
    expect(invalidateNotes).not.toContain('guidedParseOwner:"notes"');

    const mode = compact(namedRoot(COMMANDS, "transitionNotesParserMode"));
    expect(mode).toContain(
      'constentersGuided=nextMode==="guided"&&notesParseRegion!==null',
    );
    expect(mode).toContain('constclearsGuided=state.guidedParseOwner==="notes"');
    expect(mode).toContain(
      'constguidedParseOwner=entersGuided?"notes":clearsGuided?null:state.guidedParseOwner',
    );

    const completion = compact(namedRoot(COMMANDS, "completeNotesParseOperation"));
    expect(completion).toContain(
      'if(options.guided&&state.guidedParseOwner!=="notes")returnstate',
    );
    expect(completion.match(/useParseFlowStore\.setState/g)).toHaveLength(1);
    expect(completion).toContain(
      'constkinds:ParseKind[]=options.guided?["table","keynote","notes","spec"]:["notes","spec"]',
    );
    expect(completion).toContain("guidedParseOwner:null");
    expect(completion).toContain(
      'consttransitioned=publishParseOwnedTransition(token,"notes","idle",()=>{',
    );
    expect(completion).toContain("returntransitioned&&completed");
    expect(completion).not.toMatch(/\bresetGuidedParse\(/);

    const tab = compact(namedRoot(COMMANDS, "setSpecsNotesParseTab"));
    expect(tab).toContain("leaveSpecsNotesParseTab(ui.specsNotesTab)");
    expect(tab).toContain("useUiStore.getState().setSpecsNotesTab(specsNotesTab)");
    expect(tab.indexOf("leaveSpecsNotesParseTab"))
      .toBeLessThan(tab.indexOf("setSpecsNotesTab"));
    const leaveTab = compact(namedRoot(COMMANDS, "leaveSpecsNotesParseTab"));
    expect(leaveTab).toContain('if(tab==="notes-parse")');
    expect(leaveTab).toContain('constownsGuided=state.guidedParseOwner==="notes"');
    expect(leaveTab).toContain(
      'ownsGuided?["table","keynote","notes","spec"]:["notes","spec"]',
    );

    expect(compact(namedRoot(NOTES, "saveFromParagraphBatch")))
      .toContain('claimParagraphWorkspaceForOperation(token,"notes",notesParseRegion,)');
    expect(compact(namedRoot(SPEC, "saveFromBatch")))
      .toContain('claimParagraphWorkspaceForOperation(token,"spec",specParseRegion,)');
  });
});
