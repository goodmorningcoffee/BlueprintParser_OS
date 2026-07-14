// @vitest-environment node
// [refactor jul12 P2.4 A2e] Cross-family close net for the exact 20 async owners.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

type OperationKind = "table" | "keynote" | "notes" | "spec";
type AdmissionPolicy = "reject" | "supersede";

type RootLedgerEntry = Readonly<{
  kind: OperationKind;
  path: string;
  owner: string;
  policy: AdmissionPolicy;
}>;

type HookBindingLedgerEntry = Readonly<{
  kind: OperationKind;
  path: string;
  owner: string;
  binding: string;
}>;

type OperationBinding = HookBindingLedgerEntry & Readonly<{
  declaration: ts.VariableDeclaration;
  scope: ts.Node;
  directHookBinding: boolean;
}>;

type AuthorityAnalysis = Readonly<{
  bindings: HookBindingLedgerEntry[];
  begins: RootLedgerEntry[];
  finishes: RootLedgerEntry[];
  violations: string[];
}>;

const OPERATION_HOOK_FILE = "src/hooks/useParseOperation.ts";
const OPERATION_HOOK_MODULE = "@/hooks/useParseOperation";
const PARSE_OWNER_FILE = "src/stores/parseFlowStore.ts";
const CELL_STRUCTURE_HOOK_FILE = "src/hooks/useTableCellStructureOperation.ts";
const CELL_STRUCTURE_HOOK_MODULE = "@/hooks/useTableCellStructureOperation";
const CELL_STRUCTURE_ENDPOINT = "/api/table-structure";

const EXPECTED_ROOTS = [
  { kind: "table", path: "src/hooks/useTableCellStructureOperation.ts", owner: "detect", policy: "reject" },
  { kind: "table", path: "src/components/viewer/AutoParseTab.tsx", owner: "handleReviewSave", policy: "reject" },
  { kind: "table", path: "src/components/viewer/AutoParseTab.tsx", owner: "processRegions", policy: "reject" },
  { kind: "table", path: "src/components/viewer/GuidedParseTab.tsx", owner: "handleParse", policy: "reject" },
  { kind: "table", path: "src/components/viewer/GuidedParseTab.tsx", owner: "proposeGrid", policy: "supersede" },
  { kind: "table", path: "src/components/viewer/ManualParseTab.tsx", owner: "parseFromIntersections", policy: "reject" },
  { kind: "table", path: "src/components/viewer/TableCompareModal.tsx", owner: "handleDone", policy: "reject" },
  { kind: "table", path: "src/components/viewer/TableParsePanel.tsx", owner: "detectCsiAndPersist", policy: "reject" },
  { kind: "table", path: "src/components/viewer/TableParsePanel.tsx", owner: "handleMapTags", policy: "reject" },
  { kind: "keynote", path: "src/components/viewer/KeynotePanel.tsx", owner: "autoParseKeynote", policy: "reject" },
  { kind: "keynote", path: "src/components/viewer/KeynotePanel.tsx", owner: "parseFromGuidedGrid", policy: "reject" },
  { kind: "keynote", path: "src/components/viewer/KeynotePanel.tsx", owner: "parseKeynotes", policy: "reject" },
  { kind: "keynote", path: "src/components/viewer/KeynotePanel.tsx", owner: "proposeGrid", policy: "supersede" },
  { kind: "notes", path: "src/components/viewer/NotesParser.tsx", owner: "persistPreviewGrid", policy: "reject" },
  { kind: "notes", path: "src/components/viewer/NotesParser.tsx", owner: "runAuto", policy: "reject" },
  { kind: "notes", path: "src/components/viewer/NotesParser.tsx", owner: "runProposeGuided", policy: "supersede" },
  { kind: "notes", path: "src/components/viewer/NotesParser.tsx", owner: "saveFromParagraphBatch", policy: "reject" },
  { kind: "spec", path: "src/components/viewer/SpecParser.tsx", owner: "persistPreview", policy: "reject" },
  { kind: "spec", path: "src/components/viewer/SpecParser.tsx", owner: "runAuto", policy: "reject" },
  { kind: "spec", path: "src/components/viewer/SpecParser.tsx", owner: "saveFromBatch", policy: "reject" },
] as const satisfies readonly RootLedgerEntry[];

// These nine roots gained project-generation fencing in P2.5. Their exact finally predicate is
// part of the authority contract: a retired A may not clear B's live busy lane, while openProject's
// synchronous reset has already invalidated A's token. Roots absent from this map retain the prior
// direct/ownsToken-only finish contract.
const EXPECTED_LIFECYCLE_FINISH_GUARDS = {
  "src/components/viewer/KeynotePanel.tsx:autoParseKeynote":
    "isRenderedLifecycleCurrent()",
  "src/components/viewer/KeynotePanel.tsx:parseFromGuidedGrid":
    "isRenderedLifecycleCurrent()",
  "src/components/viewer/KeynotePanel.tsx:parseKeynotes":
    "isRenderedLifecycleCurrent()",
  "src/components/viewer/NotesParser.tsx:persistPreviewGrid":
    "ownsToken&&canPublishCompletion()",
  "src/components/viewer/NotesParser.tsx:saveFromParagraphBatch":
    "canPublishCompletion()",
  "src/components/viewer/SpecParser.tsx:persistPreview":
    "ownsToken&&canPublishCompletion()",
  "src/components/viewer/SpecParser.tsx:saveFromBatch":
    "canPublishCompletion()",
  "src/components/viewer/TableCompareModal.tsx:handleDone":
    "canPublishCompletion()",
  "src/components/viewer/TableParsePanel.tsx:detectCsiAndPersist":
    "ownsToken&&canPublishCompletion()",
} as const satisfies Record<string, string>;

const EXPECTED_HOOK_BINDINGS = [
  { kind: "table", path: "src/components/viewer/AutoParseTab.tsx", owner: "AutoParseTab", binding: "tableOperation" },
  { kind: "table", path: "src/hooks/useTableCellStructureOperation.ts", owner: "useTableCellStructureOperation", binding: "tableOperation" },
  { kind: "table", path: "src/components/viewer/GuidedParseTab.tsx", owner: "GuidedParseTab", binding: "tableOperation" },
  { kind: "table", path: "src/components/viewer/ManualParseTab.tsx", owner: "ManualParseTab", binding: "tableOperation" },
  { kind: "table", path: "src/components/viewer/TableCompareModal.tsx", owner: "TableCompareModal", binding: "tableOperation" },
  { kind: "table", path: "src/components/viewer/TableParsePanel.tsx", owner: "TableParsePanel", binding: "tableOperation" },
  { kind: "keynote", path: "src/components/viewer/KeynotePanel.tsx", owner: "KeynotePanel", binding: "keynoteOperation" },
  { kind: "notes", path: "src/components/viewer/NotesParser.tsx", owner: "NotesParser", binding: "notesOperation" },
  { kind: "spec", path: "src/components/viewer/SpecParser.tsx", owner: "SpecParser", binding: "specOperation" },
] as const satisfies readonly HookBindingLedgerEntry[];

const EXPECTED_LIVE_TAIL_GUARDS = {
  "table:src/hooks/useTableCellStructureOperation.ts:detect": [
    "commit:setLocalError",
    "commit:setTableCellStructure",
    "commit:setLocalError",
  ],
  "table:src/components/viewer/AutoParseTab.tsx:handleReviewSave": [
    "continuation:detectCsiAndPersist:token",
    "commit:setAutoParseError",
  ],
  "table:src/components/viewer/AutoParseTab.tsx:processRegions": [
    "command:publishTableReviewForOperation",
    "commit:setAutoParseMethodInfo",
    "commit:setAutoParseMethodResults",
    "commit:setAutoParseInfraErrors",
    "commit:setProposedRegions",
    "continuation:detectCsiAndPersist:token",
    "commit:setAutoParseError",
    "command:publishTableReviewForOperation",
    "commit:setAutoParseError",
  ],
  "table:src/components/viewer/GuidedParseTab.tsx:handleParse": [
    "continuation:detectCsiAndPersist:token",
    "inherited-success:setParsedRevision",
    "commit:setError",
  ],
  "table:src/components/viewer/GuidedParseTab.tsx:proposeGrid": [
    "command:publishGuidedProposalForOperation",
    "commit:setProposalInfo",
    "commit:setError",
    "commit:setProposalInfo",
  ],
  "table:src/components/viewer/ManualParseTab.tsx:parseFromIntersections": [
    "continuation:detectCsiAndPersist:token",
    "commit:setSaveError",
  ],
  "table:src/components/viewer/TableCompareModal.tsx:handleDone": [
    "commit-callback:closeModal",
    "commit:setSaveError",
  ],
  "table:src/components/viewer/TableParsePanel.tsx:detectCsiAndPersist": [
    "command:completeTableParseOperation",
    "command:setTagMappingDone",
    "command:setTagMappingCount",
    "command:setLastDropCounts",
    "command:setTagYoloClassState",
    "command:onLocalSuccess",
    "commit:onLocalSuccess",
  ],
  "table:src/components/viewer/TableParsePanel.tsx:handleMapTags": [
    "commit:setTagMappingCount",
    "commit:setLastDropCounts",
    "commit:setTagMappingDone",
  ],
  "keynote:src/components/viewer/KeynotePanel.tsx:autoParseKeynote": [
    "commit:setKeynoteSaveError",
    "commit:addParsedKeynote",
    "command:completeKeynoteParseOperation",
    "commit:setKeynoteSaveError",
  ],
  "keynote:src/components/viewer/KeynotePanel.tsx:parseFromGuidedGrid": [
    "commit:addParsedKeynote",
    "command:completeKeynoteParseOperation",
    "commit:setKeynoteSaveError",
  ],
  "keynote:src/components/viewer/KeynotePanel.tsx:parseKeynotes": [
    "command:completeKeynoteParseOperation",
    "commit:setKeynoteSaveError",
  ],
  "keynote:src/components/viewer/KeynotePanel.tsx:proposeGrid": [
    "command:publishGuidedProposalForOperation",
    "commit:setGuidedError",
  ],
  "notes:src/components/viewer/NotesParser.tsx:persistPreviewGrid": [
    "commit:setPreview",
    "commit:completeNotesParseOperation",
    "commit:setError",
  ],
  "notes:src/components/viewer/NotesParser.tsx:runAuto": [
    "commit:setError",
    "commit:setPreview",
    "commit:setParseDraftRegion",
    "commit:setPreview",
    "commit:setLoadingRevision",
    "commit:setSavingRevision",
    "commit:setError",
    "commit:setParseDraftRegion",
    "continuation:persistPreviewGrid:token",
    "commit:setError",
  ],
  "notes:src/components/viewer/NotesParser.tsx:runProposeGuided": [
    "command:publishGuidedProposalForOperation",
    "commit:setError",
  ],
  "notes:src/components/viewer/NotesParser.tsx:saveFromParagraphBatch": [
    "commit:setPreview",
    "commit:completeNotesParseOperation",
    "commit:setError",
  ],
  "spec:src/components/viewer/SpecParser.tsx:persistPreview": [
    "commit:setPreview",
    "commit:completeSpecParseOperation",
    "commit:setError",
  ],
  "spec:src/components/viewer/SpecParser.tsx:runAuto": [
    "commit:setError",
    "commit:setPreview",
    "commit:setParseDraftRegion",
    "commit:setPreview",
    "commit:setLoadingRevision",
    "commit:setSavingRevision",
    "commit:setError",
    "commit:setParseDraftRegion",
    "continuation:persistPreview:token",
    "commit:setError",
  ],
  "spec:src/components/viewer/SpecParser.tsx:saveFromBatch": [
    "commit:setPreview",
    "commit:completeSpecParseOperation",
    "commit:setError",
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;

function isTestFile(path: string): boolean {
  return path.includes("/__tests__/") || path.startsWith("src/test/") ||
    /\.(?:test|spec)\.(?:ts|tsx)$/.test(path);
}

function productionFiles(directory = join(process.cwd(), "src")): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) return productionFiles(absolute);
    if (!/\.tsx?$/.test(entry.name) || entry.name.endsWith(".d.ts")) return [];
    const path = relative(process.cwd(), absolute).replace(/\\/g, "/");
    return isTestFile(path) ? [] : [path];
  }).sort();
}

function parse(path: string, sourceText: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function descendants<T extends ts.Node>(
  root: ts.Node,
  predicate: (node: ts.Node) => node is T,
): T[] {
  const matches: T[] = [];
  const visit = (node: ts.Node): void => {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return matches;
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) || ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) current = current.expression;
  return current;
}

function staticName(name: ts.PropertyName | ts.BindingName | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) {
    const expression = unwrap(name.expression);
    return ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)
      ? expression.text
      : null;
  }
  return null;
}

function terminalName(expression: ts.Expression): string | null {
  const candidate = unwrap(expression);
  if (ts.isIdentifier(candidate)) return candidate.text;
  if (ts.isPropertyAccessExpression(candidate)) return candidate.name.text;
  if (ts.isElementAccessExpression(candidate) && candidate.argumentExpression) {
    const argument = unwrap(candidate.argumentExpression);
    return ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)
      ? argument.text
      : null;
  }
  return null;
}

function normalizedModulePath(path: string): string {
  return normalize(path).replace(/\\/g, "/").replace(/\.(?:ts|tsx)$/, "").replace(/\/index$/, "");
}

function resolvesToOperationHook(importer: string, specifier: string): boolean {
  let candidate = "";
  if (specifier === OPERATION_HOOK_MODULE) candidate = OPERATION_HOOK_FILE;
  else if (specifier.startsWith("@/")) candidate = join("src", specifier.slice(2));
  else if (specifier.startsWith(".")) candidate = join(dirname(importer), specifier);
  return normalizedModulePath(candidate) === normalizedModulePath(OPERATION_HOOK_FILE);
}

function resolvesToCellStructureHook(importer: string, specifier: string): boolean {
  let candidate = "";
  if (specifier === CELL_STRUCTURE_HOOK_MODULE) candidate = CELL_STRUCTURE_HOOK_FILE;
  else if (specifier.startsWith("@/")) candidate = join("src", specifier.slice(2));
  else if (specifier.startsWith(".")) candidate = join(dirname(importer), specifier);
  return normalizedModulePath(candidate) === normalizedModulePath(CELL_STRUCTURE_HOOK_FILE);
}

function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | ts.SourceFile {
  let current: ts.Node | undefined = node;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) || ts.isMethodDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) || ts.isSetAccessorDeclaration(current) ||
      ts.isConstructorDeclaration(current)
    ) return current;
    current = current.parent;
  }
  return node.getSourceFile();
}

function staticOwner(node: ts.Node): string {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isVariableDeclaration(current.parent?.parent) &&
      ts.isIdentifier(current.parent.parent.name)
    ) return current.parent.parent.name.text;
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) return current.parent.name.text;
    current = current.parent;
  }
  return "<module>";
}

function collectHookCallees(path: string, source: ts.SourceFile): {
  direct: Set<string>;
  namespaces: Set<string>;
} {
  const direct = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
      !resolvesToOperationHook(path, statement.moduleSpecifier.text) ||
      !statement.importClause?.namedBindings
    ) continue;
    const bindings = statement.importClause.namedBindings;
    if (ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    else {
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text === "useParseOperation") {
          direct.add(element.name.text);
        }
      }
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of descendants(source, ts.isVariableDeclaration)) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const initializer = unwrap(declaration.initializer);
      if (ts.isIdentifier(initializer) && direct.has(initializer.text) &&
          !direct.has(declaration.name.text)) {
        direct.add(declaration.name.text);
        changed = true;
      }
      if (ts.isIdentifier(initializer) && namespaces.has(initializer.text) &&
          !namespaces.has(declaration.name.text)) {
        namespaces.add(declaration.name.text);
        changed = true;
      }
      if (
        (ts.isPropertyAccessExpression(initializer) || ts.isElementAccessExpression(initializer)) &&
        terminalName(initializer) === "useParseOperation" &&
        ts.isIdentifier(unwrap(initializer.expression)) &&
        namespaces.has((unwrap(initializer.expression) as ts.Identifier).text) &&
        !direct.has(declaration.name.text)
      ) {
        direct.add(declaration.name.text);
        changed = true;
      }
    }
  }
  return { direct, namespaces };
}

function isHookCall(
  call: ts.CallExpression,
  callees: ReturnType<typeof collectHookCallees>,
): boolean {
  const expression = unwrap(call.expression);
  if (ts.isIdentifier(expression)) return callees.direct.has(expression.text);
  if (
    (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) &&
    terminalName(expression) === "useParseOperation" &&
    ts.isIdentifier(unwrap(expression.expression))
  ) return callees.namespaces.has((unwrap(expression.expression) as ts.Identifier).text);
  return false;
}

function ancestorDistance(node: ts.Node, ancestor: ts.Node): number | null {
  let distance = 0;
  let current: ts.Node | undefined = node;
  while (current) {
    if (current === ancestor) return distance;
    current = current.parent;
    distance += 1;
  }
  return null;
}

function resolveBinding(
  name: string,
  node: ts.Node,
  bindings: readonly OperationBinding[],
): OperationBinding | null {
  return bindings
    .filter((binding) => binding.binding === name && binding.declaration.getStart() <= node.getStart())
    .flatMap((binding) => {
      const distance = ancestorDistance(node, binding.scope);
      return distance === null ? [] : [{ binding, distance }];
    })
    .sort((left, right) => left.distance - right.distance)[0]?.binding ?? null;
}

function operationReceiverBinding(
  expression: ts.Expression,
  node: ts.Node,
  bindings: readonly OperationBinding[],
): OperationBinding | null {
  const receiver = unwrap(expression);
  return ts.isIdentifier(receiver) ? resolveBinding(receiver.text, node, bindings) : null;
}

function directCallForMember(
  member: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): ts.CallExpression | null {
  let current: ts.Node = member;
  while (
    current.parent &&
    (ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent) || ts.isNonNullExpression(current.parent))
  ) current = current.parent;
  return current.parent && ts.isCallExpression(current.parent) && current.parent.expression === current
    ? current.parent
    : null;
}

function isReactHookDependencyReference(
  member: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): boolean {
  let current: ts.Node = member;
  while (
    current.parent &&
    (ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent) || ts.isNonNullExpression(current.parent))
  ) current = current.parent;
  const dependencyArray = current.parent;
  if (!dependencyArray || !ts.isArrayLiteralExpression(dependencyArray)) return false;
  const hookCall = dependencyArray.parent;
  if (!ts.isCallExpression(hookCall) || !hookCall.arguments.includes(dependencyArray)) return false;
  return ["useCallback", "useEffect", "useLayoutEffect", "useMemo"].includes(
    terminalName(hookCall.expression) ?? "",
  );
}

function nearestFinally(node: ts.Node): ts.Block | null {
  let current: ts.Node | undefined = node;
  while (current) {
    if (
      ts.isTryStatement(current) && current.finallyBlock &&
      node.getStart() >= current.finallyBlock.getStart() &&
      node.getEnd() <= current.finallyBlock.getEnd()
    ) return current.finallyBlock;
    current = current.parent;
  }
  return null;
}

function isDirectFinishStatement(statement: ts.Statement, call: ts.CallExpression): boolean {
  return ts.isExpressionStatement(statement) && unwrap(statement.expression) === call;
}

function hasExclusiveFinally(call: ts.CallExpression): boolean {
  const block = nearestFinally(call);
  if (!block || block.statements.length !== 1) return false;
  const statement = block.statements[0];
  const source = statement.getSourceFile();
  const root = `${source.fileName}:${staticOwner(call)}`;
  const lifecycleGuard = EXPECTED_LIFECYCLE_FINISH_GUARDS[
    root as keyof typeof EXPECTED_LIFECYCLE_FINISH_GUARDS
  ];
  if (lifecycleGuard === undefined) {
    if (isDirectFinishStatement(statement, call)) return true;
    if (!ts.isIfStatement(statement) || statement.elseStatement ||
        statement.expression.getText(source) !== "ownsToken") return false;
  } else if (
    !ts.isIfStatement(statement) || statement.elseStatement ||
    statement.expression.getText(source).replace(/\s+/g, "") !== lifecycleGuard
  ) {
    return false;
  }
  const thenStatement = statement.thenStatement;
  if (ts.isBlock(thenStatement)) {
    return thenStatement.statements.length === 1 &&
      isDirectFinishStatement(thenStatement.statements[0], call);
  }
  return isDirectFinishStatement(thenStatement, call);
}

function sortedRoots(entries: readonly RootLedgerEntry[]): RootLedgerEntry[] {
  return [...entries].sort((left, right) =>
    `${left.kind}:${left.path}:${left.owner}:${left.policy}`
      .localeCompare(`${right.kind}:${right.path}:${right.owner}:${right.policy}`)
  );
}

function sortedBindings(entries: readonly HookBindingLedgerEntry[]): HookBindingLedgerEntry[] {
  return [...entries].sort((left, right) =>
    `${left.kind}:${left.path}:${left.owner}:${left.binding}`
      .localeCompare(`${right.kind}:${right.path}:${right.owner}:${right.binding}`)
  );
}

function analyzeSource(path: string, sourceText: string): AuthorityAnalysis {
  const source = parse(path, sourceText);
  const violations: string[] = [];
  const operationBindings: OperationBinding[] = [];
  const callees = collectHookCallees(path, source);

  for (const call of descendants(source, ts.isCallExpression).filter((candidate) =>
    isHookCall(candidate, callees)
  )) {
    const argument = call.arguments[0];
    const kind = argument && ts.isStringLiteral(argument) &&
      ["table", "keynote", "notes", "spec"].includes(argument.text)
      ? argument.text as OperationKind
      : null;
    let current: ts.Node = call;
    while (
      current.parent &&
      (ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent) ||
        ts.isTypeAssertionExpression(current.parent) || ts.isNonNullExpression(current.parent) ||
        ts.isSatisfiesExpression(current.parent))
    ) current = current.parent;
    const declaration = current.parent && ts.isVariableDeclaration(current.parent)
      ? current.parent
      : null;
    if (!kind || call.arguments.length !== 1 || !declaration || !ts.isIdentifier(declaration.name)) {
      violations.push(`${path}:${staticOwner(call)}:unsupported-useParseOperation-binding`);
      continue;
    }
    operationBindings.push({
      kind,
      path,
      owner: staticOwner(call),
      binding: declaration.name.text,
      declaration,
      scope: enclosingFunction(call),
      directHookBinding: true,
    });
  }

  // Follow ordinary object aliases so `const alias = tableOperation; alias.begin()` cannot hide a
  // 21st root. Assignment aliases are rejected below instead of being treated as stable bindings.
  let aliasesChanged = true;
  while (aliasesChanged) {
    aliasesChanged = false;
    for (const declaration of descendants(source, ts.isVariableDeclaration)) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      if (operationBindings.some((binding) => binding.declaration === declaration)) continue;
      const initializer = unwrap(declaration.initializer);
      if (!ts.isIdentifier(initializer)) continue;
      const sourceBinding = resolveBinding(initializer.text, declaration, operationBindings);
      if (!sourceBinding) continue;
      operationBindings.push({
        ...sourceBinding,
        owner: staticOwner(declaration),
        binding: declaration.name.text,
        declaration,
        scope: enclosingFunction(declaration),
        directHookBinding: false,
      });
      aliasesChanged = true;
    }
  }

  for (const declaration of descendants(source, ts.isVariableDeclaration)) {
    if (!ts.isObjectBindingPattern(declaration.name) || !declaration.initializer) continue;
    const initializer = unwrap(declaration.initializer);
    if (!ts.isIdentifier(initializer) ||
        !resolveBinding(initializer.text, declaration, operationBindings)) continue;
    for (const element of declaration.name.elements) {
      const name = staticName(element.propertyName ?? element.name);
      if (name === "begin" || name === "finish") {
        violations.push(`${path}:${staticOwner(declaration)}:destructured-${name}`);
      }
    }
  }

  for (const binary of descendants(source, ts.isBinaryExpression)) {
    if (binary.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
    const right = unwrap(binary.right);
    if (ts.isIdentifier(right) && resolveBinding(right.text, binary, operationBindings)) {
      violations.push(`${path}:${staticOwner(binary)}:assigned-operation-object-alias`);
    }
  }

  if (path !== OPERATION_HOOK_FILE && path !== PARSE_OWNER_FILE) {
    for (const identifier of descendants(source, ts.isIdentifier)) {
      if (identifier.text === "beginParseOperation" || identifier.text === "finishParseOperation") {
        violations.push(`${path}:${staticOwner(identifier)}:direct-${identifier.text}`);
      }
    }
    for (const access of descendants(source, ts.isElementAccessExpression)) {
      const name = terminalName(access);
      if (name === "beginParseOperation" || name === "finishParseOperation") {
        violations.push(`${path}:${staticOwner(access)}:direct-${name}`);
      }
    }
  }

  const begins: RootLedgerEntry[] = [];
  const finishes: RootLedgerEntry[] = [];
  const members = descendants(
    source,
    (node): node is ts.PropertyAccessExpression | ts.ElementAccessExpression =>
      ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node),
  );
  for (const member of members) {
    const method = terminalName(member);
    const receiverBinding = operationReceiverBinding(member.expression, member, operationBindings);
    const directCall = directCallForMember(member);

    if (ts.isElementAccessExpression(member) && receiverBinding && directCall) {
      violations.push(`${path}:${staticOwner(member)}:computed-operation-member`);
      continue;
    }
    if (method !== "begin" && method !== "finish") continue;
    if (!receiverBinding) {
      violations.push(`${path}:${staticOwner(member)}:rogue-${method}-receiver`);
      continue;
    }
    if (!directCall) {
      if (isReactHookDependencyReference(member)) continue;
      violations.push(`${path}:${staticOwner(member)}:aliased-${method}-reference`);
      continue;
    }

    if (method === "begin") {
      const first = directCall.arguments[0];
      const policy: AdmissionPolicy | null = first === undefined
        ? "reject"
        : ts.isStringLiteral(first) && first.text === "supersede" && directCall.arguments.length === 1
          ? "supersede"
          : null;
      if (!policy) {
        violations.push(`${path}:${staticOwner(directCall)}:invalid-begin-policy`);
        continue;
      }
      begins.push({
        kind: receiverBinding.kind,
        path,
        owner: staticOwner(directCall),
        policy,
      });
      continue;
    }

    if (directCall.arguments.length !== 1 || directCall.arguments[0].getText(source) !== "token") {
      violations.push(`${path}:${staticOwner(directCall)}:finish-not-token`);
    }
    if (!nearestFinally(directCall)) {
      violations.push(`${path}:${staticOwner(directCall)}:finish-outside-finally`);
    } else if (!hasExclusiveFinally(directCall)) {
      violations.push(`${path}:${staticOwner(directCall)}:non-exclusive-finally`);
    }
    finishes.push({
      kind: receiverBinding.kind,
      path,
      owner: staticOwner(directCall),
      policy: "reject",
    });
  }

  return {
    bindings: sortedBindings(operationBindings
      .filter((binding) => binding.directHookBinding)
      .map(({ kind, path: bindingPath, owner, binding }) => ({
        kind,
        path: bindingPath,
        owner,
        binding,
      }))),
    begins: sortedRoots(begins),
    finishes: sortedRoots(finishes),
    violations: [...new Set(violations)].sort(),
  };
}

const PRODUCTION_SOURCES = new Map(productionFiles().map((path) => [
  path,
  readFileSync(join(process.cwd(), path), "utf8"),
]));
const PRODUCTION_AUTHORITY_ANALYSES = new Map([...PRODUCTION_SOURCES].map(([path, source]) => [
  path,
  analyzeSource(path, source),
]));

type CellStructureLoad = Readonly<{
  path: string;
  kind: "value" | "type";
  imported: "useTableCellStructureOperation" | "TableCellStructureOperation";
}>;

function cellStructureTopology(
  overrides: ReadonlyMap<string, string> = new Map(),
): {
  endpoints: Array<{ path: string; owner: string }>;
  loads: CellStructureLoad[];
  hookCalls: Array<{ path: string; owner: string }>;
} {
  const endpoints: Array<{ path: string; owner: string }> = [];
  const loads: CellStructureLoad[] = [];
  const hookCalls: Array<{ path: string; owner: string }> = [];

  for (const [path, originalSource] of PRODUCTION_SOURCES) {
    const sourceText = overrides.get(path) ?? originalSource;
    const source = parse(path, sourceText);
    const hookCallees = new Set<string>();

    for (const statement of source.statements) {
      if (
        !ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
        !resolvesToCellStructureHook(path, statement.moduleSpecifier.text) ||
        !statement.importClause?.namedBindings ||
        !ts.isNamedImports(statement.importClause.namedBindings)
      ) continue;
      for (const element of statement.importClause.namedBindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        if (imported !== "useTableCellStructureOperation" &&
            imported !== "TableCellStructureOperation") continue;
        const kind = statement.importClause.isTypeOnly || element.isTypeOnly ? "type" : "value";
        loads.push({ path, kind, imported });
        if (imported === "useTableCellStructureOperation" && kind === "value") {
          hookCallees.add(element.name.text);
        }
      }
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (const declaration of descendants(source, ts.isVariableDeclaration)) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        const initializer = unwrap(declaration.initializer);
        if (ts.isIdentifier(initializer) && hookCallees.has(initializer.text) &&
            !hookCallees.has(declaration.name.text)) {
          hookCallees.add(declaration.name.text);
          changed = true;
        }
      }
    }

    for (const literal of descendants(
      source,
      (node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
        ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node),
    )) {
      if (literal.text === CELL_STRUCTURE_ENDPOINT) {
        endpoints.push({ path, owner: staticOwner(literal) });
      }
    }

    for (const call of descendants(source, ts.isCallExpression)) {
      const callee = unwrap(call.expression);
      if (ts.isIdentifier(callee) && hookCallees.has(callee.text)) {
        hookCalls.push({ path, owner: staticOwner(call) });
      }
    }
  }

  const byPath = <T extends { path: string }>(left: T, right: T): number =>
    JSON.stringify(left).localeCompare(JSON.stringify(right));
  return {
    endpoints: endpoints.sort(byPath),
    loads: loads.sort(byPath),
    hookCalls: hookCalls.sort(byPath),
  };
}

function authorityAnalysis(
  overrides: ReadonlyMap<string, string> = new Map(),
): AuthorityAnalysis {
  const combined = {
    bindings: [] as HookBindingLedgerEntry[],
    begins: [] as RootLedgerEntry[],
    finishes: [] as RootLedgerEntry[],
    violations: [] as string[],
  };
  for (const [path, originalSource] of PRODUCTION_SOURCES) {
    const replacement = overrides.get(path);
    const analysis = replacement === undefined
      ? PRODUCTION_AUTHORITY_ANALYSES.get(path)!
      : analyzeSource(path, replacement ?? originalSource);
    combined.bindings.push(...analysis.bindings);
    combined.begins.push(...analysis.begins);
    combined.finishes.push(...analysis.finishes);
    combined.violations.push(...analysis.violations);
  }
  return {
    bindings: sortedBindings(combined.bindings),
    begins: sortedRoots(combined.begins),
    finishes: sortedRoots(combined.finishes),
    violations: [...new Set(combined.violations)].sort(),
  };
}

function functionLikeInitializer(
  initializer: ts.Expression | undefined,
): ts.ArrowFunction | ts.FunctionExpression | null {
  if (!initializer) return null;
  const candidate = unwrap(initializer);
  if (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate)) return candidate;
  if (!ts.isCallExpression(candidate)) return null;
  const callback = candidate.arguments[0];
  return callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
    ? callback
    : null;
}

function namedRoot(source: ts.SourceFile, name: string): ts.FunctionLikeDeclaration | null {
  for (const declaration of descendants(source, ts.isVariableDeclaration)) {
    if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
    const initializer = functionLikeInitializer(declaration.initializer);
    if (initializer) return initializer;
  }
  return descendants(source, ts.isFunctionDeclaration).find((candidate) =>
    candidate.name?.text === name
  ) ?? null;
}

function belongsDirectlyToRoot(node: ts.Node, root: ts.FunctionLikeDeclaration): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current && current !== root) {
    if (ts.isFunctionLike(current)) return false;
    current = current.parent;
  }
  return current === root;
}

function hasCommitAncestor(node: ts.Node, root: ts.FunctionLikeDeclaration): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current && current !== root) {
    if (
      ts.isCallExpression(current) && ts.isIdentifier(unwrap(current.expression)) &&
      (unwrap(current.expression) as ts.Identifier).text === "commitParseOperation"
    ) return true;
    current = current.parent;
  }
  return false;
}

function hasGuardedCommandAncestor(node: ts.Node, root: ts.FunctionLikeDeclaration): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current && current !== root) {
    if (
      ts.isCallExpression(current) &&
      GUARDED_COMPLETION_COMMANDS.has(terminalName(current.expression) ?? "")
    ) return true;
    current = current.parent;
  }
  return false;
}

function isInheritedSuccessTail(node: ts.Node, root: ts.FunctionLikeDeclaration): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current && current !== root) {
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isPropertyAssignment(current.parent) &&
      staticName(current.parent.name) === "onLocalSuccess"
    ) {
      let container: ts.Node | undefined = current.parent.parent;
      while (container && container !== root) {
        if (ts.isCallExpression(container) && terminalName(container.expression) === "detectCsiAndPersist") {
          return true;
        }
        container = container.parent;
      }
    }
    current = current.parent;
  }
  return false;
}

const DURABLE_LIVE_TAIL_EXCEPTIONS = new Set([
  "addYoloTagsBulk",
  "setPageIntelligenceForPage",
  "updatePageIntelligenceForPage",
]);
const GUARDED_COMPLETION_COMMANDS = new Set([
  "claimGuidedParseWorkspaceForOperation",
  "claimParagraphWorkspaceForOperation",
  "completeTableParseOperation",
  "completeKeynoteParseOperation",
  "completeNotesParseOperation",
  "completeSpecParseOperation",
  "publishGuidedProposalForOperation",
  "publishTableReviewForOperation",
  "setTableParseStepForOperation",
  "invalidateNotesWorkspaceOperationsForOperation",
  "invalidateParagraphParseOperationsForOperation",
]);
const INHERITED_ASYNC_CONTINUATIONS = new Set([
  "detectCsiAndPersist",
  "persistPreview",
  "persistPreviewGrid",
]);

function isLiveTailCall(name: string | null): name is string {
  return name !== null && !DURABLE_LIVE_TAIL_EXCEPTIONS.has(name) &&
    (GUARDED_COMPLETION_COMMANDS.has(name) ||
      /^(?:set|reset|complete|add|toggle)[A-Z]/.test(name) || name === "onLocalSuccess");
}

function liveTailGuard(
  call: ts.CallExpression,
  root: ts.FunctionLikeDeclaration,
): "commit" | "inherited-success" | "command" | null {
  if (hasCommitAncestor(call, root)) return "commit";
  if (isInheritedSuccessTail(call, root)) return "inherited-success";
  if (hasGuardedCommandAncestor(call, root)) return "command";
  const name = terminalName(call.expression);
  return name && GUARDED_COMPLETION_COMMANDS.has(name) ? "command" : null;
}

function liveTailNodeGuard(
  node: ts.Node,
  root: ts.FunctionLikeDeclaration,
): "commit" | "inherited-success" | "command" | null {
  if (hasCommitAncestor(node, root)) return "commit";
  if (isInheritedSuccessTail(node, root)) return "inherited-success";
  if (hasGuardedCommandAncestor(node, root)) return "command";
  return null;
}

function refCurrentTarget(node: ts.Expression): boolean {
  const target = unwrap(node);
  return (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) &&
    terminalName(target) === "current";
}

function rootId(root: RootLedgerEntry): string {
  return `${root.kind}:${root.path}:${root.owner}`;
}

function liveTailAnalysis(
  overrides: ReadonlyMap<string, string> = new Map(),
): { manifest: Record<string, string[]>; violations: string[] } {
  const manifest: Record<string, string[]> = {};
  const violations: string[] = [];
  for (const expected of sortedRoots(EXPECTED_ROOTS)) {
    const sourceText = overrides.get(expected.path) ?? PRODUCTION_SOURCES.get(expected.path);
    if (sourceText === undefined) {
      violations.push(`${rootId(expected)}:missing-source`);
      manifest[rootId(expected)] = [];
      continue;
    }
    const source = parse(expected.path, sourceText);
    const root = namedRoot(source, expected.owner);
    if (!root) {
      violations.push(`${rootId(expected)}:missing-root`);
      manifest[rootId(expected)] = [];
      continue;
    }
    const awaits = descendants(root, ts.isAwaitExpression).filter((node) =>
      belongsDirectlyToRoot(node, root)
    );
    if (awaits.length === 0) {
      violations.push(`${rootId(expected)}:no-direct-await`);
      manifest[rootId(expected)] = [];
      continue;
    }
    const firstAwait = Math.min(...awaits.map((node) => node.getStart(source)));
    const records: Array<{ position: number; label: string }> = [];
    for (const call of descendants(root, ts.isCallExpression).filter((candidate) =>
      candidate.getStart(source) > firstAwait
    )) {
      const name = terminalName(call.expression);
      if (name && INHERITED_ASYNC_CONTINUATIONS.has(name)) {
        const carriesExactToken = call.arguments.some((argument) => {
          const candidate = unwrap(argument);
          return ts.isIdentifier(candidate) && candidate.text === "token";
        });
        if (!carriesExactToken) {
          violations.push(`${rootId(expected)}:${name}:continuation-without-exact-token`);
        }
        records.push({
          position: call.getStart(source),
          label: `continuation:${name}:${carriesExactToken ? "token" : "missing-token"}`,
        });
      }
      if (isLiveTailCall(name)) {
        const guard = liveTailGuard(call, root);
        if (!guard) violations.push(`${rootId(expected)}:${name}:unguarded-live-tail`);
        records.push({ position: call.getStart(source), label: `${guard ?? "unguarded"}:${name}` });
      }
      if (
        name === "commitParseOperation" && call.arguments[1] &&
        ts.isIdentifier(unwrap(call.arguments[1]))
      ) {
        records.push({
          position: call.getStart(source),
          label: `commit-callback:${(unwrap(call.arguments[1]) as ts.Identifier).text}`,
        });
      }
    }
    for (const binary of descendants(root, ts.isBinaryExpression)) {
      if (
        binary.getStart(source) <= firstAwait ||
        binary.operatorToken.kind < ts.SyntaxKind.FirstAssignment ||
        binary.operatorToken.kind > ts.SyntaxKind.LastAssignment ||
        !refCurrentTarget(binary.left)
      ) continue;
      const guard = liveTailNodeGuard(binary, root);
      if (!guard) violations.push(`${rootId(expected)}:current:unguarded-post-await-ref-write`);
      records.push({
        position: binary.getStart(source),
        label: `${guard ?? "unguarded"}:current-ref-write`,
      });
    }
    for (const deletion of descendants(root, ts.isDeleteExpression)) {
      if (deletion.getStart(source) <= firstAwait || !refCurrentTarget(deletion.expression)) continue;
      const guard = liveTailNodeGuard(deletion, root);
      if (!guard) violations.push(`${rootId(expected)}:current:unguarded-post-await-ref-delete`);
      records.push({
        position: deletion.getStart(source),
        label: `${guard ?? "unguarded"}:current-ref-delete`,
      });
    }
    for (const update of descendants(
      root,
      (node): node is ts.PrefixUnaryExpression | ts.PostfixUnaryExpression =>
        ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node),
    )) {
      if (
        update.getStart(source) <= firstAwait ||
        (update.operator !== ts.SyntaxKind.PlusPlusToken &&
          update.operator !== ts.SyntaxKind.MinusMinusToken) ||
        !refCurrentTarget(update.operand)
      ) continue;
      const guard = liveTailNodeGuard(update, root);
      if (!guard) violations.push(`${rootId(expected)}:current:unguarded-post-await-ref-update`);
      records.push({
        position: update.getStart(source),
        label: `${guard ?? "unguarded"}:current-ref-update`,
      });
    }
    manifest[rootId(expected)] = records
      .sort((left, right) => left.position - right.position)
      .map(({ label }) => label);
  }
  return { manifest, violations: [...new Set(violations)].sort() };
}

function isSynchronousPublicationCall(name: string | null): name is string {
  return name !== null && (
    name === "abort" || name === "setState" || name === "onLocalSuccess" ||
    /^(?:set|reset|invalidate|complete|add|toggle|publish|claim|open|accept)[A-Z]/.test(name)
  );
}

/**
 * A successful Zustand begin has already notified synchronous subscribers before it returns.
 * Therefore the pre-request portion of a root needs the same token authorization as its
 * post-await tail. Pure capture/computation is allowed; publications, aborts, and ref writes are
 * allowed only through the exact commit seam or an intrinsically token-guarded command.
 */
function preAwaitSynchronousTailAnalysis(
  overrides: ReadonlyMap<string, string> = new Map(),
): string[] {
  const violations: string[] = [];
  for (const expected of sortedRoots(EXPECTED_ROOTS)) {
    const id = rootId(expected);
    const sourceText = overrides.get(expected.path) ?? PRODUCTION_SOURCES.get(expected.path);
    if (sourceText === undefined) {
      violations.push(`${id}:missing-source`);
      continue;
    }
    const source = parse(expected.path, sourceText);
    const root = namedRoot(source, expected.owner);
    if (!root) {
      violations.push(`${id}:missing-root`);
      continue;
    }
    const begins = descendants(root, ts.isCallExpression).filter((call) =>
      belongsDirectlyToRoot(call, root) && terminalName(call.expression) === "begin"
    );
    const awaits = descendants(root, ts.isAwaitExpression).filter((awaitExpression) =>
      belongsDirectlyToRoot(awaitExpression, root)
    );
    if (begins.length !== 1 || awaits.length === 0) {
      violations.push(`${id}:missing-single-begin-or-await`);
      continue;
    }
    const beginEnd = begins[0].getEnd();
    const firstAwait = Math.min(...awaits.map((awaitExpression) => awaitExpression.getStart(source)));

    for (const call of descendants(root, ts.isCallExpression)) {
      if (!belongsDirectlyToRoot(call, root) || call.getStart(source) <= beginEnd ||
          call.getStart(source) >= firstAwait) continue;
      const name = terminalName(call.expression);
      if (!isSynchronousPublicationCall(name)) continue;
      if (name === "commitParseOperation" || DURABLE_LIVE_TAIL_EXCEPTIONS.has(name) ||
          GUARDED_COMPLETION_COMMANDS.has(name)) continue;
      violations.push(`${id}:${name}:unguarded-pre-await-call`);
    }

    for (const binary of descendants(root, ts.isBinaryExpression)) {
      if (!belongsDirectlyToRoot(binary, root) || binary.getStart(source) <= beginEnd ||
          binary.getStart(source) >= firstAwait ||
          binary.operatorToken.kind < ts.SyntaxKind.FirstAssignment ||
          binary.operatorToken.kind > ts.SyntaxKind.LastAssignment) continue;
      const left = unwrap(binary.left);
      if (
        (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) &&
        terminalName(left) === "current"
      ) violations.push(`${id}:current:unguarded-pre-await-ref-write`);
    }
    for (const deletion of descendants(root, ts.isDeleteExpression)) {
      if (!belongsDirectlyToRoot(deletion, root) || deletion.getStart(source) <= beginEnd ||
          deletion.getStart(source) >= firstAwait) continue;
      const expression = unwrap(deletion.expression);
      if (
        (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) &&
        terminalName(expression) === "current"
      ) violations.push(`${id}:current:unguarded-pre-await-ref-delete`);
    }
  }
  return [...new Set(violations)].sort();
}

function directStatementInBlock(node: ts.Node, block: ts.Block): ts.Statement | null {
  let current: ts.Node = node;
  while (current.parent && current.parent !== block) current = current.parent;
  return current.parent === block && ts.isStatement(current) ? current : null;
}

function isReturnOnly(statement: ts.Statement): boolean {
  if (ts.isReturnStatement(statement)) return true;
  return ts.isBlock(statement) && statement.statements.length === 1 &&
    ts.isReturnStatement(statement.statements[0]);
}

function isAdmissionStatusGuard(statement: ts.Statement): boolean {
  if (!ts.isIfStatement(statement) || statement.elseStatement ||
      !isReturnOnly(statement.thenStatement)) return false;
  const expression = statement.expression;
  const referencesStarted = descendants(expression, ts.isIdentifier).some((identifier) =>
    identifier.text === "started"
  );
  const referencesStatus = descendants(
    expression,
    (node): node is ts.PropertyAccessExpression | ts.ElementAccessExpression =>
      ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node),
  ).some((access) => terminalName(access) === "status");
  const hasSideEffect = descendants(expression, ts.isCallExpression).length > 0 ||
    descendants(expression, ts.isAwaitExpression).length > 0 ||
    descendants(expression, ts.isYieldExpression).length > 0 ||
    descendants(expression, ts.isBinaryExpression).some((binary) =>
      binary.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      binary.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    );
  return referencesStarted && referencesStatus && !hasSideEffect;
}

function isNullTokenGuard(statement: ts.Statement): boolean {
  if (!ts.isIfStatement(statement) || statement.elseStatement ||
      !isReturnOnly(statement.thenStatement)) return false;
  const expression = unwrap(statement.expression);
  if (!ts.isPrefixUnaryExpression(expression) ||
      expression.operator !== ts.SyntaxKind.ExclamationToken) return false;
  const operand = unwrap(expression.operand);
  return ts.isIdentifier(operand) && operand.text === "token";
}

function isActiveTokenAlias(statement: ts.Statement): boolean {
  if (!ts.isVariableStatement(statement) ||
      !(statement.declarationList.flags & ts.NodeFlags.Const) ||
      statement.declarationList.declarations.length !== 1) return false;
  const declaration = statement.declarationList.declarations[0];
  return ts.isIdentifier(declaration.name) && declaration.name.text === "activeToken" &&
    !!declaration.initializer && ts.isIdentifier(unwrap(declaration.initializer)) &&
    (unwrap(declaration.initializer) as ts.Identifier).text === "token";
}

function isDeferredLifecycleAuthority(
  statement: ts.Statement,
  kind: OperationKind,
): boolean {
  if (!ts.isVariableStatement(statement) ||
      !(statement.declarationList.flags & ts.NodeFlags.Const) ||
      statement.declarationList.declarations.length !== 1) return false;
  const declaration = statement.declarationList.declarations[0];
  if (!ts.isIdentifier(declaration.name) ||
      (declaration.name.text !== "canPublish" &&
        declaration.name.text !== "canPublishCompletion") ||
      !declaration.initializer) return false;
  const initializer = unwrap(declaration.initializer);
  if (!ts.isArrowFunction(initializer) || initializer.parameters.length !== 0 ||
      ts.isBlock(initializer.body)) return false;
  const body = initializer.body.getText(statement.getSourceFile()).replace(/\s+/g, "");
  return body ===
    `isRenderedLifecycleCurrent()&&${kind}Operation.isCurrent(token)` ||
    body ===
    `isRenderedLifecycleCurrent()&&${kind}Operation.isCurrent(activeToken)`;
}

function isSafePreTryTail(
  statements: readonly ts.Statement[],
  expected: RootLedgerEntry,
): boolean {
  const expectsLifecycleAuthority = EXPECTED_LIFECYCLE_FINISH_GUARDS[
    `${expected.path}:${expected.owner}` as keyof typeof EXPECTED_LIFECYCLE_FINISH_GUARDS
  ] !== undefined;
  let index = 0;
  if (statements[index] && isNullTokenGuard(statements[index])) index += 1;
  if (expectsLifecycleAuthority && statements[index] &&
      isActiveTokenAlias(statements[index])) index += 1;
  let sawLifecycleAuthority = false;
  if (expectsLifecycleAuthority && statements[index] &&
      isDeferredLifecycleAuthority(statements[index], expected.kind)) {
    index += 1;
    sawLifecycleAuthority = true;
  }
  return index === statements.length &&
    (!expectsLifecycleAuthority || sawLifecycleAuthority);
}

function directlyOwnedTryWithFinish(
  root: ts.FunctionLikeDeclaration,
): ts.TryStatement[] {
  return descendants(root, ts.isTryStatement).filter((statement) => {
    if (!belongsDirectlyToRoot(statement, root) || !statement.finallyBlock) return false;
    return descendants(statement.finallyBlock, ts.isCallExpression).some((call) =>
      terminalName(call.expression) === "finish" && call.arguments.length === 1 &&
      ts.isIdentifier(call.arguments[0]) && call.arguments[0].text === "token"
    );
  });
}

function tryFinallyDominanceAnalysis(
  overrides: ReadonlyMap<string, string> = new Map(),
): string[] {
  const violations: string[] = [];
  for (const expected of sortedRoots(EXPECTED_ROOTS)) {
    const id = rootId(expected);
    const sourceText = overrides.get(expected.path) ?? PRODUCTION_SOURCES.get(expected.path);
    if (sourceText === undefined) {
      violations.push(`${id}:missing-source`);
      continue;
    }
    const source = parse(expected.path, sourceText);
    const root = namedRoot(source, expected.owner);
    if (!root || !root.body || !ts.isBlock(root.body)) {
      violations.push(`${id}:missing-block-root`);
      continue;
    }

    const begins = descendants(root, ts.isCallExpression).filter((call) =>
      belongsDirectlyToRoot(call, root) && terminalName(call.expression) === "begin"
    );
    const tries = directlyOwnedTryWithFinish(root);
    if (begins.length !== 1) {
      violations.push(`${id}:expected-one-begin-for-dominance`);
      continue;
    }
    if (tries.length !== 1) {
      violations.push(`${id}:expected-one-finished-try`);
      continue;
    }
    const begin = begins[0];
    const finishedTry = tries[0];
    if (begin.getStart(source) >= finishedTry.getStart(source)) {
      violations.push(`${id}:begin-not-before-try`);
      continue;
    }

    let operationBlock: ts.Block | null = null;
    let operationParent: ts.Node | undefined = finishedTry.parent;
    while (operationParent && operationParent !== root) {
      if (
        ts.isBlock(operationParent) && begin.getStart(source) >= operationParent.getStart(source) &&
        begin.getEnd() <= operationParent.getEnd()
      ) {
        operationBlock = operationParent;
        break;
      }
      operationParent = operationParent.parent;
    }
    if (!operationBlock && root.body && ts.isBlock(root.body)) operationBlock = root.body;
    if (!operationBlock) {
      violations.push(`${id}:begin-try-not-in-common-block`);
      continue;
    }

    const acquisitions: ts.Node[] = [
      ...descendants(root, ts.isVariableDeclaration).filter((declaration) =>
        ts.isIdentifier(declaration.name) && declaration.name.text === "token" &&
        declaration.initializer !== undefined && declaration.getStart(source) > begin.getStart(source) &&
        declaration.getStart(source) < finishedTry.getStart(source)
      ),
      ...descendants(root, ts.isBinaryExpression).filter((binary) => {
        const left = unwrap(binary.left);
        return binary.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(left) && left.text === "token" &&
          binary.getStart(source) > begin.getStart(source) &&
          binary.getStart(source) < finishedTry.getStart(source);
      }),
    ].sort((left, right) => left.getStart(source) - right.getStart(source));
    const acquisition = acquisitions.at(-1);
    if (!acquisition) {
      violations.push(`${id}:missing-token-acquisition`);
      continue;
    }

    let admissionBlock: ts.Block | null = null;
    let current: ts.Node | undefined = acquisition.parent;
    while (current && current !== root) {
      if (
        ts.isBlock(current) && begin.getStart(source) >= current.getStart(source) &&
        begin.getEnd() <= current.getEnd()
      ) {
        admissionBlock = current;
        break;
      }
      current = current.parent;
    }
    if (!admissionBlock) {
      violations.push(`${id}:begin-token-not-in-common-block`);
      continue;
    }

    const beginStatement = directStatementInBlock(begin, admissionBlock);
    const acquisitionStatement = directStatementInBlock(acquisition, admissionBlock);
    if (!beginStatement || !acquisitionStatement) {
      violations.push(`${id}:opaque-admission-statements`);
      continue;
    }
    const beginIndex = admissionBlock.statements.indexOf(beginStatement);
    const acquisitionIndex = admissionBlock.statements.indexOf(acquisitionStatement);
    if (beginIndex < 0 || acquisitionIndex <= beginIndex) {
      violations.push(`${id}:token-not-after-begin`);
      continue;
    }
    const admissionTail = admissionBlock.statements.slice(beginIndex + 1, acquisitionIndex);
    if (admissionTail.length !== 1 || !isAdmissionStatusGuard(admissionTail[0])) {
      violations.push(`${id}:non-admission-work-before-token`);
    }
    if (admissionBlock !== operationBlock &&
        acquisitionIndex !== admissionBlock.statements.length - 1) {
      violations.push(`${id}:work-after-token-before-admission-exit`);
    }

    const anchor = directStatementInBlock(acquisition, operationBlock);
    const tryStatement = directStatementInBlock(finishedTry, operationBlock);
    if (!anchor || !tryStatement || tryStatement !== finishedTry) {
      violations.push(`${id}:try-not-at-operation-block`);
      continue;
    }
    const anchorIndex = operationBlock.statements.indexOf(anchor);
    const tryIndex = operationBlock.statements.indexOf(tryStatement);
    if (anchorIndex < 0 || tryIndex <= anchorIndex) {
      violations.push(`${id}:try-not-after-token`);
      continue;
    }
    const preTryTail = operationBlock.statements.slice(anchorIndex + 1, tryIndex);
    if (!isSafePreTryTail(preTryTail, expected)) {
      violations.push(`${id}:unguarded-work-before-try`);
    }
  }
  return [...new Set(violations)].sort();
}

type CommitCallback = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration;

function resolveCommitCallback(
  source: ts.SourceFile,
  expression: ts.Expression,
  call: ts.CallExpression,
): CommitCallback | null {
  const candidate = unwrap(expression);
  if (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate)) return candidate;
  if (!ts.isIdentifier(candidate)) return null;

  const variableCandidates = descendants(source, ts.isVariableDeclaration)
    .filter((declaration) =>
      ts.isIdentifier(declaration.name) && declaration.name.text === candidate.text &&
      declaration.getStart(source) < call.getStart(source)
    )
    .flatMap((declaration) => {
      const initializer = functionLikeInitializer(declaration.initializer);
      if (!initializer) return [];
      const scope = enclosingFunction(declaration);
      const distance = ancestorDistance(call, scope);
      return distance === null ? [] : [{ callback: initializer, distance, position: declaration.getStart(source) }];
    })
    .sort((left, right) => left.distance - right.distance || right.position - left.position);
  if (variableCandidates[0]) return variableCandidates[0].callback;

  const declarations = descendants(source, ts.isFunctionDeclaration)
    .filter((declaration): declaration is ts.FunctionDeclaration & { name: ts.Identifier } =>
      declaration.name?.text === candidate.text && declaration.getStart(source) < call.getStart(source)
    )
    .flatMap((declaration) => {
      const scope = enclosingFunction(declaration.parent);
      const distance = ancestorDistance(call, scope);
      return distance === null ? [] : [{ callback: declaration, distance }];
    })
    .sort((left, right) => left.distance - right.distance);
  return declarations[0]?.callback ?? null;
}

function directAsyncBoundaries(callback: CommitCallback): Array<ts.AwaitExpression | ts.YieldExpression> {
  const boundaries: Array<ts.AwaitExpression | ts.YieldExpression> = [];
  const visit = (node: ts.Node): void => {
    if (node !== callback && ts.isFunctionLike(node)) return;
    if (ts.isAwaitExpression(node) || ts.isYieldExpression(node)) boundaries.push(node);
    ts.forEachChild(node, visit);
  };
  visit(callback);
  return boundaries;
}

function explicitAsyncEscapes(callback: CommitCallback): string[] {
  const escapes = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (node !== callback && ts.isFunctionLike(node)) {
      const async = (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.some((modifier) =>
        modifier.kind === ts.SyntaxKind.AsyncKeyword
      ) ?? false;
      if (async) escapes.add("nested-async");
      if (
        (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ||
          ts.isMethodDeclaration(node)) && node.asteriskToken
      ) escapes.add("nested-generator");
    }
    if (ts.isCallExpression(node)) {
      const name = terminalName(node.expression);
      if (name === "then" || name === "catch" || name === "finally") {
        escapes.add("promise-chain");
      }
    }
    if (ts.isVoidExpression(node) && ts.isCallExpression(unwrap(node.expression))) {
      escapes.add("void-launch");
    }
    if (
      ts.isNewExpression(node) && ts.isIdentifier(unwrap(node.expression)) &&
      (unwrap(node.expression) as ts.Identifier).text === "Promise"
    ) escapes.add("new-promise");
    ts.forEachChild(node, visit);
  };
  visit(callback);
  return [...escapes].sort();
}

function analyzeCommitCallbacks(path: string, sourceText: string): { calls: number; violations: string[] } {
  const source = parse(path, sourceText);
  const violations: string[] = [];
  const directCallees = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
      !resolvesToOperationHook(path, statement.moduleSpecifier.text) ||
      !statement.importClause?.namedBindings
    ) continue;
    const bindings = statement.importClause.namedBindings;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text !== "commitParseOperation") continue;
      directCallees.add(element.name.text);
      if (element.name.text !== "commitParseOperation") {
        violations.push(`${path}:aliased-commitParseOperation-import`);
      }
    }
  }

  let aliasesChanged = true;
  while (aliasesChanged) {
    aliasesChanged = false;
    for (const declaration of descendants(source, ts.isVariableDeclaration)) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer ||
          directCallees.has(declaration.name.text)) continue;
      const initializer = unwrap(declaration.initializer);
      const aliasesDirect = ts.isIdentifier(initializer) && directCallees.has(initializer.text);
      const aliasesNamespace =
        (ts.isPropertyAccessExpression(initializer) || ts.isElementAccessExpression(initializer)) &&
        terminalName(initializer) === "commitParseOperation" &&
        ts.isIdentifier(unwrap(initializer.expression)) &&
        namespaces.has((unwrap(initializer.expression) as ts.Identifier).text);
      if (!aliasesDirect && !aliasesNamespace) continue;
      directCallees.add(declaration.name.text);
      aliasesChanged = true;
      violations.push(`${path}:${staticOwner(declaration)}:aliased-commitParseOperation-reference`);
    }
  }

  let calls = 0;
  for (const call of descendants(source, ts.isCallExpression)) {
    const expression = unwrap(call.expression);
    const directName = ts.isIdentifier(expression) ? expression.text : null;
    const namespaceCall =
      (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) &&
      terminalName(expression) === "commitParseOperation" &&
      ts.isIdentifier(unwrap(expression.expression)) &&
      namespaces.has((unwrap(expression.expression) as ts.Identifier).text);
    if (!(directName && directCallees.has(directName)) && !namespaceCall) continue;
    calls += 1;
    const owner = staticOwner(call);
    if (namespaceCall || directName !== "commitParseOperation") {
      violations.push(`${path}:${owner}:non-direct-commitParseOperation-call`);
    }
    if (
      call.arguments.length !== 2 || !ts.isIdentifier(call.arguments[0]) ||
      call.arguments[0].text !== "token"
    ) {
      violations.push(`${path}:${owner}:commit-not-exact-token`);
    }
    const callbackArgument = call.arguments[1];
    const callback = callbackArgument
      ? resolveCommitCallback(source, callbackArgument, call)
      : null;
    if (!callback) {
      violations.push(`${path}:${owner}:opaque-commit-callback`);
      continue;
    }
    const isAsync = callback.modifiers?.some((modifier) =>
      modifier.kind === ts.SyntaxKind.AsyncKeyword
    ) ?? false;
    if (isAsync) violations.push(`${path}:${owner}:async-commit-callback`);
    if (callback.asteriskToken || directAsyncBoundaries(callback).length > 0) {
      violations.push(`${path}:${owner}:yielding-commit-callback`);
    }
    for (const escape of explicitAsyncEscapes(callback)) {
      violations.push(`${path}:${owner}:${escape}-commit-callback`);
    }
  }
  return { calls, violations: [...new Set(violations)].sort() };
}

const PRODUCTION_COMMIT_CALLBACK_ANALYSES = new Map([...PRODUCTION_SOURCES].map(([path, source]) => [
  path,
  analyzeCommitCallbacks(path, source),
]));

function commitCallbackAnalysis(
  overrides: ReadonlyMap<string, string> = new Map(),
): { calls: number; violations: string[] } {
  let calls = 0;
  const violations: string[] = [];
  for (const [path, originalSource] of PRODUCTION_SOURCES) {
    const replacement = overrides.get(path);
    const analysis = replacement === undefined
      ? PRODUCTION_COMMIT_CALLBACK_ANALYSES.get(path)!
      : analyzeCommitCallbacks(path, replacement ?? originalSource);
    calls += analysis.calls;
    violations.push(...analysis.violations);
  }
  return { calls, violations: [...new Set(violations)].sort() };
}

function replaceOnce(sourceText: string, before: string, after: string): string {
  expect(sourceText.split(before)).toHaveLength(2);
  return sourceText.replace(before, after);
}

const SORTED_EXPECTED_ROOTS = sortedRoots(EXPECTED_ROOTS);
const SORTED_EXPECTED_BINDINGS = sortedBindings(EXPECTED_HOOK_BINDINGS);

describe("P2.4 A2e exact cross-family operation authority close", () => {
  it("pins the sole cell-structure transport root and one hoisted controller consumer", () => {
    expect(cellStructureTopology()).toEqual({
      endpoints: [
        { path: "src/app/docs/_components/demos/ApiEndpointList.tsx", owner: "<module>" },
        { path: CELL_STRUCTURE_HOOK_FILE, owner: "detect" },
        { path: "src/middleware.ts", owner: "<module>" },
      ],
      loads: [
        {
          path: "src/components/viewer/AutoParseTab.tsx",
          kind: "type",
          imported: "TableCellStructureOperation",
        },
        {
          path: "src/components/viewer/ParsedTableItem.tsx",
          kind: "type",
          imported: "TableCellStructureOperation",
        },
        {
          path: "src/components/viewer/TableParsePanel.tsx",
          kind: "value",
          imported: "useTableCellStructureOperation",
        },
      ],
      hookCalls: [{ path: "src/components/viewer/TableParsePanel.tsx", owner: "TableParsePanel" }],
    });

    const rowPath = "src/components/viewer/ParsedTableItem.tsx";
    const row = PRODUCTION_SOURCES.get(rowPath)!;
    const duplicateEndpoint = new Map([[rowPath, replaceOnce(
      row,
      "  // Context-only handle for optimistic page writes and the C2 shared save command (zero observer).",
      `  void fetch("${CELL_STRUCTURE_ENDPOINT}");\n  // Context-only handle for optimistic page writes and the C2 shared save command (zero observer).`,
    )]]);
    expect(cellStructureTopology(duplicateEndpoint).endpoints).toHaveLength(4);

    const duplicateHook = new Map([[rowPath, replaceOnce(
      row,
      'import type { TableCellStructureOperation } from "@/hooks/useTableCellStructureOperation";',
      'import { useTableCellStructureOperation, type TableCellStructureOperation } from "@/hooks/useTableCellStructureOperation";',
    ).replace(
      "  // Context-only handle for optimistic page writes and the C2 shared save command (zero observer).",
      "  useTableCellStructureOperation();\n  // Context-only handle for optimistic page writes and the C2 shared save command (zero observer).",
    )]]);
    expect(cellStructureTopology(duplicateHook).hookCalls).toHaveLength(2);
  }, 120_000);

  it("discovers the exact hook-binding topology, including aliased imports and object bindings", () => {
    const analysis = authorityAnalysis();
    expect(analysis.violations).toEqual([]);
    expect(analysis.bindings).toEqual(SORTED_EXPECTED_BINDINGS);

    const fixturePath = "src/components/operation-binding-fixture.tsx";
    const fixture = analyzeSource(fixturePath, `
      import { useParseOperation as useAuthority } from "@/hooks/useParseOperation";
      export function Fixture() {
        const primary = useAuthority("table");
        const alias = primary;
        async function hiddenRoot() {
          const started = alias.begin();
          if (started.status !== "started") return;
          const token = started.token;
          try { await Promise.resolve(); } finally { alias.finish(token); }
        }
        return hiddenRoot;
      }
    `);
    expect(fixture.violations).toEqual([]);
    expect(fixture.bindings).toEqual([
      { kind: "table", path: fixturePath, owner: "Fixture", binding: "primary" },
    ]);
    expect(fixture.begins).toEqual([
      { kind: "table", path: fixturePath, owner: "hiddenRoot", policy: "reject" },
    ]);
  });

  it("pins the sole production begin ledger to Table9 + Keynote4 + Notes4 + Spec3", () => {
    const begins = authorityAnalysis().begins;
    expect(begins).toEqual(SORTED_EXPECTED_ROOTS);
    expect(Object.fromEntries(["table", "keynote", "notes", "spec"].map((kind) => [
      kind,
      begins.filter((entry) => entry.kind === kind).length,
    ]))).toEqual({ table: 9, keynote: 4, notes: 4, spec: 3 });
    expect(begins.filter((entry) => entry.policy === "supersede").map((entry) =>
      `${entry.kind}:${entry.owner}`
    )).toEqual([
      "keynote:proposeGrid",
      "notes:runProposeGuided",
      "table:proposeGrid",
    ]);
  });

  it("pins one exclusive-finally finish site to every root and no other production owner", () => {
    const finishes = authorityAnalysis().finishes;
    const expected = SORTED_EXPECTED_ROOTS.map((entry) => ({ ...entry, policy: "reject" as const }))
      .sort((left, right) => `${left.kind}:${left.path}:${left.owner}`
        .localeCompare(`${right.kind}:${right.path}:${right.owner}`));
    expect(finishes).toEqual(expected);
    expect(finishes).toHaveLength(20);
  });

  it("requires every successful admission to enter its exclusive try/finally without live work", () => {
    expect(tryFinallyDominanceAnalysis()).toEqual([]);

    const tablePath = "src/components/viewer/TableCompareModal.tsx";
    const table = PRODUCTION_SOURCES.get(tablePath)!;
    const postTokenWork = new Map([[tablePath, replaceOnce(
      table,
      "    const token = started.token;\n    const canPublishCompletion = () =>\n" +
        "      isRenderedLifecycleCurrent() && tableOperation.isCurrent(token);\n\n    try {",
      "    const token = started.token;\n    const canPublishCompletion = () =>\n" +
        "      isRenderedLifecycleCurrent() && tableOperation.isCurrent(token);\n" +
        "    setSaveError(null);\n\n    try {",
    )]]);
    expect(tryFinallyDominanceAnalysis(postTokenWork)).toContain(
      `table:${tablePath}:handleDone:unguarded-work-before-try`,
    );
  });

  it("authorizes every synchronous publication/ref mutation after begin and before first await", () => {
    expect(preAwaitSynchronousTailAnalysis()).toEqual([]);

    const autoPath = "src/components/viewer/AutoParseTab.tsx";
    const auto = PRODUCTION_SOURCES.get(autoPath)!;
    const autoWithoutCommit = new Map([[autoPath, replaceOnce(
      auto,
      "        const phasePublished = commitParseOperation(token, () => {\n          setAutoParsingRevision(token.revision);",
      "        setAutoParsingRevision(token.revision);\n        const phasePublished = true;\n        (() => {",
    )]]);
    expect(preAwaitSynchronousTailAnalysis(autoWithoutCommit)).toContain(
      `table:${autoPath}:processRegions:setAutoParsingRevision:unguarded-pre-await-call`,
    );

    const mapPath = "src/components/viewer/TableParsePanel.tsx";
    const map = PRODUCTION_SOURCES.get(mapPath)!;
    const mapWithoutCommit = new Map([[mapPath, replaceOnce(
      map,
      "      const transportAdmitted = commitParseOperation(token, () => {",
      "      mapTagsAbortRef.current?.abort();\n      mapTagsAbortRef.current = controller;\n      const transportAdmitted = commitParseOperation(token, () => {",
    )]]);
    expect(preAwaitSynchronousTailAnalysis(mapWithoutCommit)).toEqual(expect.arrayContaining([
      `table:${mapPath}:handleMapTags:abort:unguarded-pre-await-call`,
      `table:${mapPath}:handleMapTags:current:unguarded-pre-await-ref-write`,
    ]));

    const guidedPath = "src/components/viewer/GuidedParseTab.tsx";
    const guided = PRODUCTION_SOURCES.get(guidedPath)!;
    const guidedWithoutCommit = new Map([[guidedPath, replaceOnce(
      guided,
      "      const workspaceAdmitted = commitParseOperation(token, () => {\n        invalidateGuidedParseOperations(\"table\");",
      "      invalidateGuidedParseOperations(\"table\");\n      const workspaceAdmitted = (() => {",
    )]]);
    expect(preAwaitSynchronousTailAnalysis(guidedWithoutCommit)).toContain(
      `table:${guidedPath}:handleParse:invalidateGuidedParseOperations:unguarded-pre-await-call`,
    );

    const notesPath = "src/components/viewer/NotesParser.tsx";
    const notes = PRODUCTION_SOURCES.get(notesPath)!;
    const notesWithoutParagraphClaim = new Map([[notesPath, replaceOnce(
      notes,
      "      const workspaceLease = claimParagraphWorkspaceForOperation(\n        token,\n        \"notes\",\n        notesParseRegion,\n      );",
      "      useParseFlowStore.setState({ paragraphWorkspaceOwner: \"notes\" });\n      const workspaceLease = null;",
    )]]);
    expect(preAwaitSynchronousTailAnalysis(notesWithoutParagraphClaim)).toContain(
      `notes:${notesPath}:saveFromParagraphBatch:setState:unguarded-pre-await-call`,
    );
  });

  it("keeps every commit on the exact token with a synchronous non-yielding callback", () => {
    expect(commitCallbackAnalysis()).toEqual({ calls: 62, violations: [] });

    const hookPath = "src/hooks/useTableCellStructureOperation.ts";
    const hook = PRODUCTION_SOURCES.get(hookPath)!;
    const wrongToken = new Map([[hookPath, replaceOnce(
      hook,
      "      const admitted = commitParseOperation(token, () => {\n        setLocalPhase({ key, revision: token.revision });",
      "      const admitted = commitParseOperation({ ...token }, () => {\n        setLocalPhase({ key, revision: token.revision });",
    )]]);
    expect(commitCallbackAnalysis(wrongToken).violations).toContain(
      `${hookPath}:detect:commit-not-exact-token`,
    );

    const asyncCallback = new Map([[hookPath, replaceOnce(
      hook,
      "      const admitted = commitParseOperation(token, () => {\n        setLocalPhase({ key, revision: token.revision });",
      "      const admitted = commitParseOperation(token, async () => {\n        setLocalPhase({ key, revision: token.revision });",
    )]]);
    expect(commitCallbackAnalysis(asyncCallback).violations).toContain(
      `${hookPath}:detect:async-commit-callback`,
    );

    const yieldingFixture = analyzeCommitCallbacks("src/components/commit-fixture.tsx", `
      import { commitParseOperation } from "@/hooks/useParseOperation";
      function Fixture(token: never) {
        commitParseOperation(token, function* () { yield token; });
      }
    `);
    expect(yieldingFixture).toEqual({
      calls: 1,
      violations: ["src/components/commit-fixture.tsx:Fixture:yielding-commit-callback"],
    });

    const escapeFixture = analyzeCommitCallbacks("src/components/commit-escape-fixture.tsx", `
      import { commitParseOperation } from "@/hooks/useParseOperation";
      declare function request(): Promise<void>;
      function Fixture(token: never) {
        commitParseOperation(token, () => {
          void request();
          request().then(() => undefined);
          void (async () => { await request(); })();
          new Promise((resolve) => resolve(undefined));
        });
      }
    `);
    expect(escapeFixture).toEqual({
      calls: 1,
      violations: [
        "src/components/commit-escape-fixture.tsx:Fixture:nested-async-commit-callback",
        "src/components/commit-escape-fixture.tsx:Fixture:new-promise-commit-callback",
        "src/components/commit-escape-fixture.tsx:Fixture:promise-chain-commit-callback",
        "src/components/commit-escape-fixture.tsx:Fixture:void-launch-commit-callback",
      ],
    });
  });

  it("pins every post-await live mutation tail to its authorization seam", () => {
    const analysis = liveTailAnalysis();
    expect(analysis.violations).toEqual([]);
    expect(analysis.manifest).toEqual(EXPECTED_LIVE_TAIL_GUARDS);
    expect(Object.keys(analysis.manifest)).toHaveLength(20);

    const hookPath = "src/hooks/useTableCellStructureOperation.ts";
    const hook = PRODUCTION_SOURCES.get(hookPath)!;
    const staleRefWrite = new Map([[hookPath, replaceOnce(
      hook,
      "      const data = await response.json();",
      "      const data = await response.json();\n      rogueCleanupRef.current = token.revision;",
    )]]);
    expect(liveTailAnalysis(staleRefWrite).violations).toContain(
      `table:${hookPath}:detect:current:unguarded-post-await-ref-write`,
    );
  });

  it("self-calibrates policy, duplicate, finish, hook-binding, and opaque authority drift", () => {
    const notesPath = "src/components/viewer/NotesParser.tsx";
    const notes = PRODUCTION_SOURCES.get(notesPath)!;
    const policyDrift = new Map([[notesPath, replaceOnce(
      notes,
      'notesOperation.begin("supersede")',
      "notesOperation.begin()",
    )]]);
    expect(authorityAnalysis(policyDrift).begins).not.toEqual(SORTED_EXPECTED_ROOTS);

    const tablePath = "src/components/viewer/TableCompareModal.tsx";
    const table = PRODUCTION_SOURCES.get(tablePath)!;
    const duplicateAdmission = new Map([[tablePath, replaceOnce(
      table,
      "const started = tableOperation.begin();",
      "tableOperation.begin();\n    const started = tableOperation.begin();",
    )]]);
    expect(authorityAnalysis(duplicateAdmission).begins).toHaveLength(21);

    const missingFinish = new Map([[tablePath, replaceOnce(
      table,
      "tableOperation.finish(token);",
      "void token;",
    )]]);
    expect(authorityAnalysis(missingFinish).finishes).toHaveLength(19);

    const lifecycleBlindFinish = new Map([[tablePath, replaceOnce(
      table,
      "if (canPublishCompletion()) tableOperation.finish(token);",
      "tableOperation.finish(token);",
    )]]);
    expect(authorityAnalysis(lifecycleBlindFinish).violations).toContain(
      `${tablePath}:handleDone:non-exclusive-finally`,
    );

    const extraBinding = new Map([[tablePath, replaceOnce(
      table,
      'const tableOperation = useParseOperation("table");',
      'const tableOperation = useParseOperation("table");\n  const extraOperation = useParseOperation("table");',
    )]]);
    expect(authorityAnalysis(extraBinding).bindings).toHaveLength(10);

    const rogueReceiver = new Map([[tablePath, replaceOnce(
      table,
      "const started = tableOperation.begin();",
      "rogueOperation.begin();\n    const started = tableOperation.begin();",
    )]]);
    expect(authorityAnalysis(rogueReceiver).violations).toContain(
      `${tablePath}:handleDone:rogue-begin-receiver`,
    );

    const directOwner = new Map([[tablePath, replaceOnce(
      table,
      "const started = tableOperation.begin();",
      'useParseFlowStore.getState().beginParseOperation("table");\n    const started = tableOperation.begin();',
    )]]);
    expect(authorityAnalysis(directOwner).violations).toContain(
      `${tablePath}:handleDone:direct-beginParseOperation`,
    );
  });

  it("rejects computed/destructured/assigned operation methods", () => {
    const tablePath = "src/components/viewer/TableCompareModal.tsx";
    const table = PRODUCTION_SOURCES.get(tablePath)!;
    const computed = new Map([[tablePath, replaceOnce(
      table,
      "tableOperation.begin()",
      'tableOperation["begin"]()',
    )]]);
    expect(authorityAnalysis(computed).violations).toContain(
      `${tablePath}:handleDone:computed-operation-member`,
    );

    const destructured = new Map([[tablePath, replaceOnce(
      table,
      "const started = tableOperation.begin();",
      "const { finish } = tableOperation;\n    const started = tableOperation.begin();",
    )]]);
    expect(authorityAnalysis(destructured).violations).toContain(
      `${tablePath}:handleDone:destructured-finish`,
    );

    const assigned = new Map([[tablePath, replaceOnce(
      table,
      "const started = tableOperation.begin();",
      "const hiddenBegin = tableOperation.begin;\n    const started = tableOperation.begin();",
    )]]);
    expect(authorityAnalysis(assigned).violations).toContain(
      `${tablePath}:handleDone:aliased-begin-reference`,
    );
  });

  it("kills a Guided parsed tail moved out of authorization and a blind finally clear", () => {
    const guidedPath = "src/components/viewer/GuidedParseTab.tsx";
    const guided = PRODUCTION_SOURCES.get(guidedPath)!;
    const withoutGuardedParsed = replaceOnce(
      guided,
      "          setParsedRevision(token.revision + 1);\n",
      "",
    );
    const movedParsed = new Map([[guidedPath, replaceOnce(
      withoutGuardedParsed,
      "      }, token);\n    } catch (err) {",
      "      }, token);\n      setParsedRevision(token.revision + 1);\n    } catch (err) {",
    )]]);
    expect(liveTailAnalysis(movedParsed).violations).toContain(
      `table:${guidedPath}:handleParse:setParsedRevision:unguarded-live-tail`,
    );

    const tablePath = "src/components/viewer/TableCompareModal.tsx";
    const table = PRODUCTION_SOURCES.get(tablePath)!;
    const blindFinally = new Map([[tablePath, replaceOnce(
      table,
      "    } finally {\n      if (canPublishCompletion()) tableOperation.finish(token);\n    }",
      "    } finally {\n      setSavingRevision(null);\n" +
        "      if (canPublishCompletion()) tableOperation.finish(token);\n    }",
    )]]);
    expect(authorityAnalysis(blindFinally).violations).toContain(
      `${tablePath}:handleDone:non-exclusive-finally`,
    );
    expect(liveTailAnalysis(blindFinally).violations).toContain(
      `table:${tablePath}:handleDone:setSavingRevision:unguarded-live-tail`,
    );
  });
});
