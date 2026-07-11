// @vitest-environment node
// [refactor jul11 P2.4 S2] Source-exact topology freeze for sole parse ownership.
//
// This suite is intentionally narrower than the fail-closed owner oracle. It pins the known
// grouped surfaces, canvas-adjacent subscriptions, cross-kind borrowers, neutral-command home,
// and mixed test-helper seam. S2 changes the active owner constants/import expectations; it must
// not broaden any projection or leave a viewerStore compatibility bridge behind.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useSessionStore } from "@/stores/sessionStore";
import { useParseFlowStore } from "@/stores/parseFlowStore";
import { useToolStore } from "@/stores/toolStore";
import { useUiStore } from "@/stores/uiStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { useViewerStore } from "@/stores/viewerStore";
import {
  PARSE_TEST_ACTION_KEYS,
  PARSE_TEST_STATE_KEYS,
  partitionViewerStoreTestState,
  setViewerStoreStateForTest,
} from "@/test/viewer-store-state";
import {
  formatStoreOwnerFinding,
  scanStoreOwnerSource,
  type StoreOwnerDescriptor,
  type StoreOwnerScanResult,
} from "@/test/store-owner-oracle";

const VIEWER_STORE_FILE = "src/stores/viewerStore.ts";
const PARSE_STORE_FILE = "src/stores/parseFlowStore.ts";
const VIEWER_COMMANDS_FILE = "src/stores/viewerCommands.ts";
const ANNOTATION_OVERLAY = "src/components/viewer/AnnotationOverlay.tsx";
const DRAWING_PREVIEW = "src/components/viewer/DrawingPreviewLayer.tsx";
const PDF_PAGE = "src/components/viewer/PDFPage.tsx";
const PARSE_REGION_LAYER = "src/components/viewer/ParseRegionLayer.tsx";
const SHAPE_INTERACTION = "src/hooks/useShapeParseInteraction.ts";
const GUIDED_PARSE_TAB = "src/components/viewer/GuidedParseTab.tsx";
const KEYNOTE_PANEL = "src/components/viewer/KeynotePanel.tsx";
const NOTES_PARSER = "src/components/viewer/NotesParser.tsx";
const SPEC_PARSER = "src/components/viewer/SpecParser.tsx";
const PARAGRAPH_OVERLAY = "src/components/viewer/ParagraphOverlay.tsx";
const PARSED_TABLE_ITEM = "src/components/viewer/ParsedTableItem.tsx";
const TABLE_COMPARE_MODAL = "src/components/viewer/TableCompareModal.tsx";

const VIEWER_OWNER = {
  file: VIEWER_STORE_FILE,
  module: "@/stores/viewerStore",
  exportName: "useViewerStore",
  interfaceName: "ViewerState",
  storeName: "useViewerStore",
} as const;
const PARSE_OWNER = {
  file: PARSE_STORE_FILE,
  module: "@/stores/parseFlowStore",
  exportName: "useParseFlowStore",
  interfaceName: "ParseFlowState",
  storeName: "useParseFlowStore",
} as const;

type ParseOwnershipPhase = "F0" | "S1" | "S2";
type OwnerDefinitionExpectation = "module-absent" | "exact-ledger" | "ledger-absent";
type OwnershipPhaseConfig = {
  readonly active: typeof VIEWER_OWNER | typeof PARSE_OWNER;
  readonly inactive: typeof VIEWER_OWNER | typeof PARSE_OWNER;
  readonly inactiveDefinition: OwnerDefinitionExpectation;
  readonly inactiveAccessAllowlist: readonly string[];
};

// This is the only phase switch. S1 keeps viewer active and permits only the dual-owner parity
// suite plus this topology/runtime witness to touch the production-dead candidate. S2 flips the
// owners, removes the parity exception, and retains only this file's explicit residual-runtime
// absence witness; the gate fails until manifest, reader, and imports move together.
const PARSE_OWNERSHIP_PHASE: ParseOwnershipPhase = "S2";
const OWNERSHIP_PHASES = {
  F0: {
    active: VIEWER_OWNER,
    inactive: PARSE_OWNER,
    inactiveDefinition: "module-absent",
    inactiveAccessAllowlist: [],
  },
  S1: {
    active: VIEWER_OWNER,
    inactive: PARSE_OWNER,
    inactiveDefinition: "exact-ledger",
    inactiveAccessAllowlist: [
      "src/stores/__tests__/parseFlowStoreFreeze.test.ts",
      "src/stores/__tests__/parseFlowTopologyFreeze.test.ts",
    ],
  },
  S2: {
    active: PARSE_OWNER,
    inactive: VIEWER_OWNER,
    inactiveDefinition: "ledger-absent",
    // This suite intentionally retains the residual Viewer runtime/drawing witness needed to prove
    // old-owner absence. No production file, other real test, or shared helper is exempt.
    inactiveAccessAllowlist: ["src/stores/__tests__/parseFlowTopologyFreeze.test.ts"],
  },
} as const satisfies Record<ParseOwnershipPhase, OwnershipPhaseConfig>;

function ownershipForPhase(phase: ParseOwnershipPhase): OwnershipPhaseConfig {
  return OWNERSHIP_PHASES[phase];
}

const OWNERSHIP = ownershipForPhase(PARSE_OWNERSHIP_PHASE);
const ACTIVE_PARSE_OWNER = OWNERSHIP.active;
const INACTIVE_PARSE_OWNER = OWNERSHIP.inactive;
// Drawing never joins parseFlowStore during P2.4. This independent owner is intentionally the same
// physical store as ACTIVE_PARSE_OWNER in F0/S1 and becomes distinct at the S2 phase flip.
const RESIDUAL_DRAWING_OWNER = VIEWER_OWNER;

const PARSE_DATA_KEYS = [
  "tableParseStep",
  "tableParseRegion",
  "tableParsedGrid",
  "tableParseMeta",
  "tableCellStructure",
  "showTableCellStructure",
  "tableParseColumnBBs",
  "tableParseColumnNames",
  "tableParseRowBBs",
  "tableParseTab",
  "tableParseOptions",
  "keynoteParseTab",
  "keynoteParseStep",
  "keynoteParseRegion",
  "keynoteColumnBBs",
  "keynoteRowBBs",
  "keynoteYoloClass",
  "parsedKeynoteData",
  "notesParseStep",
  "notesParseRegion",
  "guidedNotesRows",
  "guidedNotesCols",
  "notesFastManualActive",
  "notesFastManualGrid",
  "parseDraftRegion",
  "specParseStep",
  "specParseRegion",
  "guidedSpecSectionBBs",
  "paragraphOverlayActive",
  "paragraphBatch",
  "paragraphClipboard",
  "guidedParseActive",
  "guidedParseRegion",
  "guidedParseRows",
  "guidedParseCols",
] as const;

const PARSE_LEAF_ACTION_KEYS = [
  "setTableParseRegion",
  "setTableParsedGrid",
  "setTableParseMeta",
  "setTableCellStructure",
  "toggleCellHighlight",
  "setShowTableCellStructure",
  "addTableParseColumnBB",
  "setTableParseColumnNames",
  "addTableParseRowBB",
  "setTableParseRowBBs",
  "resetTableParse",
  "setTableParseTab",
  "setTableParseOptions",
  "setKeynoteParseTab",
  "setKeynoteParseRegion",
  "addKeynoteColumnBB",
  "addKeynoteRowBB",
  "setKeynoteYoloClass",
  "setParsedKeynoteData",
  "addParsedKeynote",
  "resetKeynoteParse",
  "setNotesParseRegion",
  "addGuidedNotesRow",
  "addGuidedNotesCol",
  "resetNotesParse",
  "setNotesFastManualActive",
  "setNotesFastManualGrid",
  "setParseDraftRegion",
  "setSpecParseRegion",
  "addGuidedSpecSectionBB",
  "resetSpecParse",
  "setParagraphOverlayActive",
  "setParagraphBatch",
  "upsertPendingParagraph",
  "removePendingParagraph",
  "setParagraphClipboard",
  "setGuidedParseActive",
  "setGuidedParseRegion",
  "setGuidedParseRows",
  "setGuidedParseCols",
  "resetGuidedParse",
] as const;

const NEUTRAL_STEP_COMMANDS = [
  "setTableParseStep",
  "setKeynoteParseStep",
  "setNotesParseStep",
  "setSpecParseStep",
] as const;

const TABLE_HOOK_SHAPE = [
  "tableParseStep",
  "tableParseRegion",
  "setTableParseRegion",
  "tableParsedGrid",
  "setTableParsedGrid",
  "tableParseColumnBBs",
  "addTableParseColumnBB",
  "tableParseRowBBs",
  "addTableParseRowBB",
  "setTableParseRowBBs",
  "tableParseColumnNames",
  "setTableParseColumnNames",
  "tableParseTab",
  "setTableParseTab",
  "tableParseOptions",
  "setTableParseOptions",
  "resetTableParse",
] as const;

const KEYNOTE_HOOK_SHAPE = [
  "keynoteParseStep",
  "keynoteParseRegion",
  "setKeynoteParseRegion",
  "keynoteColumnBBs",
  "addKeynoteColumnBB",
  "keynoteRowBBs",
  "addKeynoteRowBB",
  "keynoteParseTab",
  "setKeynoteParseTab",
  "keynoteYoloClass",
  "setKeynoteYoloClass",
  "resetKeynoteParse",
  "guidedParseActive",
  "setGuidedParseActive",
  "guidedParseRegion",
  "setGuidedParseRegion",
  "guidedParseRows",
  "setGuidedParseRows",
  "guidedParseCols",
  "setGuidedParseCols",
  "resetGuidedParse",
] as const;

const TABLE_HOOK_CALLERS = {
  "src/components/viewer/AnnotationOverlay.tsx": 1,
  "src/components/viewer/AutoParseTab.tsx": 2,
  "src/components/viewer/GuidedParseTab.tsx": 1,
  "src/components/viewer/ManualParseTab.tsx": 1,
} as const;

const KEYNOTE_HOOK_CALLERS = {
  "src/components/viewer/AnnotationOverlay.tsx": 1,
  "src/components/viewer/PDFPage.tsx": 1,
} as const;

const PARSE_MEMBERS = new Set<string>([
  ...PARSE_DATA_KEYS,
  ...PARSE_LEAF_ACTION_KEYS,
]);
const ALL_PARSE_KEYS = [...PARSE_DATA_KEYS, ...PARSE_LEAF_ACTION_KEYS] as const;
const PARSE_TYPE_NAMES = ["PendingParagraph", "ParagraphTemplate"] as const;
const DRAWING_KEYS = ["_drawing", "_drawStart", "_drawEnd", "_mousePos"] as const;

function ownerDescriptor(
  owner: typeof VIEWER_OWNER | typeof PARSE_OWNER,
  members: readonly string[],
): StoreOwnerDescriptor {
  return {
    moduleName: owner.module,
    exportName: owner.exportName,
    members,
  };
}

const ACTIVE_PARSE_DESCRIPTOR = ownerDescriptor(ACTIVE_PARSE_OWNER, ALL_PARSE_KEYS);
const INACTIVE_PARSE_DESCRIPTOR = ownerDescriptor(INACTIVE_PARSE_OWNER, ALL_PARSE_KEYS);
const RESIDUAL_DRAWING_DESCRIPTOR = ownerDescriptor(RESIDUAL_DRAWING_OWNER, DRAWING_KEYS);

type RuntimeStateReader = () => Readonly<Record<string, unknown>>;
const RUNTIME_OWNER_STATE_READERS: Partial<Record<string, RuntimeStateReader>> = {
  [VIEWER_OWNER.module]: () =>
    useViewerStore.getState() as unknown as Readonly<Record<string, unknown>>,
  [PARSE_OWNER.module]: () =>
    useParseFlowStore.getState() as unknown as Readonly<Record<string, unknown>>,
};

const textCache = new Map<string, string>();
const sourceCache = new Map<string, ts.SourceFile>();

function existsRelative(path: string): boolean {
  return existsSync(join(process.cwd(), path));
}

function textOf(path: string): string {
  const cached = textCache.get(path);
  if (cached !== undefined) return cached;
  const text = readFileSync(join(process.cwd(), path), "utf8");
  textCache.set(path, text);
  return text;
}

function parse(path: string): ts.SourceFile {
  const cached = sourceCache.get(path);
  if (cached) return cached;
  const source = ts.createSourceFile(
    path,
    textOf(path),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  sourceCache.set(path, source);
  return source;
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

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function compact(node: ts.Node, source: ts.SourceFile): string {
  return node.getText(source).replace(/\s+/g, "");
}

function staticName(name: ts.PropertyName | ts.BindingName | undefined): string | null {
  if (!name) return null;
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
    ? name.text
    : null;
}

function directObjectKeys(object: ts.ObjectLiteralExpression): string[] {
  return object.properties
    .map((property) => ("name" in property ? staticName(property.name) : null))
    .filter((name): name is string => name !== null);
}

function findVariable(source: ts.SourceFile, name: string): ts.VariableDeclaration {
  const matches = descendants(
    source,
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name,
  );
  expect(matches, `${name} declaration`).toHaveLength(1);
  return matches[0];
}

function findInterface(source: ts.SourceFile, name: string): ts.InterfaceDeclaration {
  const matches = descendants(
    source,
    (node): node is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(node) && node.name.text === name,
  );
  expect(matches, `${name} interface`).toHaveLength(1);
  return matches[0];
}

function interfaceKeys(declaration: ts.InterfaceDeclaration): string[] {
  return declaration.members
    .map((member) => ("name" in member ? staticName(member.name) : null))
    .filter((name): name is string => name !== null);
}

function findStoreObject(source: ts.SourceFile, storeName: string): ts.ObjectLiteralExpression {
  const declaration = findVariable(source, storeName);
  const initializer = declaration.initializer;
  expect(initializer && ts.isCallExpression(initializer), `${storeName} create call`).toBe(true);
  const factory = (initializer as ts.CallExpression).arguments[0];
  expect(
    factory && (ts.isArrowFunction(factory) || ts.isFunctionExpression(factory)),
    `${storeName} factory`,
  ).toBe(true);
  const body = (factory as ts.ArrowFunction | ts.FunctionExpression).body;
  const expression = ts.isExpression(body) ? unwrap(body) : body;
  expect(ts.isObjectLiteralExpression(expression), `${storeName} object`).toBe(true);
  return expression as ts.ObjectLiteralExpression;
}

function directProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.ObjectLiteralElementLike {
  const matches = object.properties.filter(
    (property) => "name" in property && staticName(property.name) === name,
  );
  expect(matches, `${name} property`).toHaveLength(1);
  return matches[0];
}

function ownerDefinitionKeys(owner: typeof VIEWER_OWNER | typeof PARSE_OWNER): {
  interfaceKeys: string[];
  objectKeys: string[];
} {
  const source = parse(owner.file);
  return {
    interfaceKeys: interfaceKeys(findInterface(source, owner.interfaceName)),
    objectKeys: directObjectKeys(findStoreObject(source, owner.storeName)),
  };
}

function expectOwnerLedgerDefinition(
  owner: typeof VIEWER_OWNER | typeof PARSE_OWNER,
  expectation: Exclude<OwnerDefinitionExpectation, "module-absent">,
): void {
  const definitions = ownerDefinitionKeys(owner);
  const runtimeReader = RUNTIME_OWNER_STATE_READERS[owner.module];
  expect(runtimeReader, `${owner.exportName} runtime reader for ${PARSE_OWNERSHIP_PHASE}`).toBeDefined();
  const runtimeState = runtimeReader!();
  for (const member of ALL_PARSE_KEYS) {
    const present = expectation === "exact-ledger";
    expect(definitions.interfaceKeys.includes(member), `${member} interface ownership`).toBe(present);
    expect(definitions.objectKeys.includes(member), `${member} implementation ownership`).toBe(present);
    expect(
      Object.prototype.hasOwnProperty.call(runtimeState, member),
      `${member} runtime ownership`,
    ).toBe(present);
  }
  for (const typeName of PARSE_TYPE_NAMES) {
    const present = expectation === "exact-ledger";
    const declarations = descendants(
      parse(owner.file),
      (node): node is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(node) && node.name.text === typeName,
    );
    expect(declarations, `${typeName} definition ownership`).toHaveLength(present ? 1 : 0);
  }
  if (owner.module === PARSE_OWNER.module && expectation === "exact-ledger") {
    const expected = [...ALL_PARSE_KEYS, "resetProjectParseState"].sort();
    const candidateSource = parse(owner.file);
    const candidateInterface = findInterface(candidateSource, owner.interfaceName);
    const candidateObject = findStoreObject(candidateSource, owner.storeName);
    expect(candidateInterface.heritageClauses ?? [], "candidate interface has no inherited surface")
      .toEqual([]);
    expect(candidateInterface.members, "candidate raw interface member count")
      .toHaveLength(expected.length);
    expect(candidateInterface.members.every((member) =>
      ts.isPropertySignature(member) && staticName(member.name) !== null
    ), "candidate interface uses only named property signatures").toBe(true);
    expect(candidateObject.properties, "candidate raw implementation member count")
      .toHaveLength(expected.length);
    expect(candidateObject.properties.every((property) =>
      ts.isPropertyAssignment(property) && staticName(property.name) !== null
    ), "candidate store uses only named property assignments").toBe(true);
    expect(new Set(definitions.interfaceKeys).size, "candidate interface keys unique")
      .toBe(definitions.interfaceKeys.length);
    expect(new Set(definitions.objectKeys).size, "candidate store keys unique")
      .toBe(definitions.objectKeys.length);
    expect([...definitions.interfaceKeys].sort(), "candidate exact interface ledger")
      .toEqual(expected);
    expect([...definitions.objectKeys].sort(), "candidate exact implementation ledger")
      .toEqual(expected);
    expect(Object.keys(runtimeState).sort(), "candidate exact runtime ledger").toEqual(expected);
  }
}

function typeScriptSourceFiles(directory = "src"): string[] {
  const output: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(join(process.cwd(), current), { withFileTypes: true })) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(child);
      } else if (
        /\.(?:ts|tsx)$/.test(entry.name) &&
        !entry.name.endsWith(".d.ts")
      ) {
        output.push(child);
      }
    }
  };
  visit(directory);
  return output.sort();
}

function isRealTestSource(path: string): boolean {
  return path.includes("/__tests__/") || /\.(?:test|spec)\.(?:ts|tsx)$/.test(path);
}

const everyTypeScriptSourceFile = typeScriptSourceFiles();
const srcTestSourceFiles = everyTypeScriptSourceFile.filter((path) => path.startsWith("src/test/"));
const realTestSourceFiles = everyTypeScriptSourceFile.filter(
  (path) => !path.startsWith("src/test/") && isRealTestSource(path),
);
const productionSourceFiles = everyTypeScriptSourceFile.filter(
  (path) => !path.startsWith("src/test/") && !isRealTestSource(path),
);
// Keep the composition explicit: future phase gates must not silently scan only production while
// stale test helpers retain the old owner. The Set both documents and enforces de-duplication.
const allSourceCorpus = [...new Set([
  ...productionSourceFiles,
  ...realTestSourceFiles,
  ...srcTestSourceFiles,
])].sort();

function importedLocalNames(
  source: ts.SourceFile,
  moduleNames: readonly string[],
  importedName: string,
): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !moduleNames.includes(statement.moduleSpecifier.text)
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === importedName) {
        names.add(element.name.text);
      }
    }
  }
  return names;
}

function identifierAliases(root: ts.Node, seeds: Iterable<string>): Set<string> {
  const aliases = new Set(seeds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of descendants(root, ts.isVariableDeclaration)) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const initializer = unwrap(declaration.initializer);
      if (
        ts.isIdentifier(initializer) &&
        aliases.has(initializer.text) &&
        !aliases.has(declaration.name.text)
      ) {
        aliases.add(declaration.name.text);
        changed = true;
      }
    }
  }
  return aliases;
}

function importedCalls(
  source: ts.SourceFile,
  moduleNames: readonly string[],
  importedName: string,
): ts.CallExpression[] {
  const aliases = identifierAliases(
    source,
    importedLocalNames(source, moduleNames, importedName),
  );
  return descendants(source, ts.isCallExpression).filter((call) => {
    const expression = unwrap(call.expression);
    return ts.isIdentifier(expression) && aliases.has(expression.text);
  });
}

function importedCallTopology(
  importedName: string,
  owner: typeof VIEWER_OWNER | typeof PARSE_OWNER,
): Record<string, number> {
  return Object.fromEntries(
    productionSourceFiles
      .map((path) => [
        path,
        importedCalls(parse(path), [owner.module], importedName).length,
      ] as const)
      .filter(([, count]) => count > 0),
  );
}

function exportedVariableCount(source: ts.SourceFile, name: string): number {
  return source.statements.filter((statement) =>
    ts.isVariableStatement(statement) &&
    statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
    statement.declarationList.declarations.some(
      (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name,
    )
  ).length + source.statements.filter((statement) =>
    ts.isExportDeclaration(statement) &&
    statement.exportClause &&
    ts.isNamedExports(statement.exportClause) &&
    statement.exportClause.elements.some(
      (element) => (element.propertyName ?? element.name).text === name,
    )
  ).length;
}

function hookShape(
  name: string,
  expectedShape: readonly string[],
  owner: typeof VIEWER_OWNER | typeof PARSE_OWNER = ACTIVE_PARSE_OWNER,
): string[] {
  const source = parse(owner.file);
  const declaration = findVariable(source, name);
  const initializer = declaration.initializer && unwrap(declaration.initializer);
  expect(initializer && ts.isArrowFunction(initializer), `${name} hook arrow`).toBe(true);
  const body = unwrap((initializer as ts.ArrowFunction).body as ts.Expression);
  expect(ts.isCallExpression(body), `${name} active-owner call`).toBe(true);
  const ownerCall = body as ts.CallExpression;
  expect(compact(ownerCall.expression, source), `${name} active owner`).toBe(
    owner.exportName,
  );
  expect(ownerCall.arguments, `${name} active-owner arguments`).toHaveLength(1);

  const shallowCall = unwrap(ownerCall.arguments[0]);
  expect(ts.isCallExpression(shallowCall), `${name} useShallow call`).toBe(true);
  const shallowNames = importedLocalNames(
    source,
    ["zustand/react/shallow"],
    "useShallow",
  );
  expect(shallowNames.size, `${name} useShallow import provenance`).toBe(1);
  expect(
    ts.isIdentifier((shallowCall as ts.CallExpression).expression) &&
      shallowNames.has(((shallowCall as ts.CallExpression).expression as ts.Identifier).text),
    `${name} must wrap its selector with imported useShallow`,
  ).toBe(true);
  expect((shallowCall as ts.CallExpression).arguments, `${name} useShallow arguments`)
    .toHaveLength(1);

  const selector = unwrap((shallowCall as ts.CallExpression).arguments[0]);
  expect(selector && ts.isArrowFunction(selector), `${name} selector arrow`).toBe(true);
  expect((selector as ts.ArrowFunction).parameters, `${name} selector parameters`).toHaveLength(1);
  const parameter = (selector as ts.ArrowFunction).parameters[0]?.name;
  expect(parameter && ts.isIdentifier(parameter), `${name} selector state parameter`).toBe(true);
  const object = unwrap((selector as ts.ArrowFunction).body as ts.Expression);
  expect(ts.isObjectLiteralExpression(object), `${name} selector object`).toBe(true);
  const properties = (object as ts.ObjectLiteralExpression).properties;
  expect(properties, `${name} selector property count`).toHaveLength(expectedShape.length);

  const mappings = properties.map((property) => {
    expect(ts.isPropertyAssignment(property), `${name} plain key mapping`).toBe(true);
    const assignment = property as ts.PropertyAssignment;
    const key = staticName(assignment.name);
    const value = unwrap(assignment.initializer);
    expect(key, `${name} static selector key`).not.toBeNull();
    expect(ts.isPropertyAccessExpression(value), `${name}.${key} direct state read`).toBe(true);
    const access = value as ts.PropertyAccessExpression;
    expect(
      ts.isIdentifier(access.expression) &&
        (access.expression as ts.Identifier).text === (parameter as ts.Identifier).text,
      `${name}.${key} receiver`,
    ).toBe(true);
    expect(access.name.text, `${name}.${key} exact mapping`)
      .toBe(key);
    return key!;
  });
  return mappings;
}

function selectorFunction(
  expression: ts.Expression | undefined,
): ts.ArrowFunction | ts.FunctionExpression | null {
  if (!expression) return null;
  const current = unwrap(expression);
  if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) return current;
  if (ts.isCallExpression(current)) {
    for (const argument of current.arguments) {
      const nested = selectorFunction(argument);
      if (nested) return nested;
    }
  }
  return null;
}

function primitiveSelectorMembers(
  source: ts.SourceFile,
  owner: { readonly module: string; readonly exportName: string },
): string[] {
  const hooks = identifierAliases(
    source,
    importedLocalNames(source, [owner.module], owner.exportName),
  );
  const output: string[] = [];
  for (const call of descendants(source, ts.isCallExpression)) {
    const callee = unwrap(call.expression);
    if (!ts.isIdentifier(callee) || !hooks.has(callee.text)) continue;
    const selector = selectorFunction(call.arguments[0]);
    if (
      !selector ||
      selector.parameters.length !== 1 ||
      !ts.isIdentifier(selector.parameters[0].name)
    ) {
      continue;
    }
    const parameter = selector.parameters[0].name.text;
    const selected = descendants(
      selector.body,
      (node): node is ts.PropertyAccessExpression =>
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(unwrap(node.expression)) &&
        (unwrap(node.expression) as ts.Identifier).text === parameter,
    ).map((access) => access.name.text);
    expect(selected, `primitive selector at ${call.getStart(source)}`).toHaveLength(1);
    output.push(selected[0]);
  }
  return output;
}

function bindingNames(name: ts.BindingName): string[] {
  if (!ts.isObjectBindingPattern(name)) return [];
  return name.elements
    .map((element) => staticName(element.propertyName ?? element.name))
    .filter((member): member is string => member !== null);
}

function groupedDestructure(source: ts.SourceFile, hookName: string): string[] {
  const calls = importedCalls(
    source,
    [ACTIVE_PARSE_OWNER.module],
    hookName,
  );
  expect(calls, `${hookName} call`).toHaveLength(1);
  let current: ts.Node = calls[0];
  while (
    current.parent &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isNonNullExpression(current.parent))
  ) {
    current = current.parent;
  }
  expect(ts.isVariableDeclaration(current.parent), `${hookName} binding`).toBe(true);
  return bindingNames((current.parent as ts.VariableDeclaration).name);
}

function ownerScan(
  source: ts.SourceFile,
  descriptor: StoreOwnerDescriptor = ACTIVE_PARSE_DESCRIPTOR,
): StoreOwnerScanResult {
  return scanStoreOwnerSource(source, descriptor);
}

function findingLabels(result: StoreOwnerScanResult): string[] {
  return result.uncertain.map((finding) =>
    `${finding.fileName}:${finding.line}:${finding.column} ${formatStoreOwnerFinding(finding)}`
  );
}

function expectFailClosedOwnerScan(
  source: ts.SourceFile,
  descriptor: StoreOwnerDescriptor = ACTIVE_PARSE_DESCRIPTOR,
): StoreOwnerScanResult {
  const result = ownerScan(source, descriptor);
  expect(findingLabels(result), `${source.fileName} broad/opaque owner access`).toEqual([]);
  return result;
}

function knownMembers(
  result: StoreOwnerScanResult,
  operation?: StoreOwnerScanResult["known"][number]["operation"],
): string[] {
  return result.known
    .filter((finding) => !operation || finding.operation === operation)
    .map((finding) => finding.member)
    .filter((member): member is string => member !== null);
}

function groupedBorrowedMembers(source: ts.SourceFile): string[] {
  return ["useTableParse", "useKeynoteParse"].flatMap((hookName) =>
    importedCalls(source, [ACTIVE_PARSE_OWNER.module], hookName).flatMap((call) => {
      let current: ts.Node = call;
      while (
        current.parent &&
        (ts.isParenthesizedExpression(current.parent) ||
          ts.isAsExpression(current.parent) ||
          ts.isNonNullExpression(current.parent))
      ) current = current.parent;
      return ts.isVariableDeclaration(current.parent)
        ? bindingNames(current.parent.name).filter((member) => PARSE_MEMBERS.has(member))
        : [];
    })
  );
}

const provenBorrowerCache = new Map<string, Set<string>>();

function provenBorrowerMembers(path: string): Set<string> {
  const cached = provenBorrowerCache.get(path);
  if (cached) return cached;
  const source = parse(path);
  const result = expectFailClosedOwnerScan(source);
  const members = new Set([...knownMembers(result), ...groupedBorrowedMembers(source)]);
  for (const typeName of PARSE_TYPE_NAMES) {
    if (importedLocalNames(source, [ACTIVE_PARSE_OWNER.module], typeName).size > 0) {
      members.add(typeName);
    }
  }
  provenBorrowerCache.set(path, members);
  return members;
}

function importsModule(source: ts.SourceFile, moduleName: string): boolean {
  return source.statements.some((statement) =>
    ts.isImportDeclaration(statement) &&
    ts.isStringLiteral(statement.moduleSpecifier) &&
    statement.moduleSpecifier.text === moduleName
  );
}

function resolvesToParseOwner(importerPath: string, specifier: string): boolean {
  const unresolved = specifier === PARSE_OWNER.module
    ? PARSE_OWNER.file.slice(0, -3)
    : specifier.startsWith("@/")
      ? `src/${specifier.slice(2)}`
      : specifier.startsWith(".")
        ? join(dirname(importerPath), specifier)
        : "";
  const withoutExtension = unresolved.replace(/\.(?:ts|tsx)$/, "");
  return withoutExtension === PARSE_OWNER.file.replace(/\.ts$/, "");
}

function parseOwnerLoadKinds(path: string, source = parse(path)): string[] {
  const loads: string[] = [];
  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      resolvesToParseOwner(path, statement.moduleSpecifier.text)
    ) loads.push("import");
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      resolvesToParseOwner(path, statement.moduleSpecifier.text)
    ) loads.push("re-export");
  }
  for (const call of descendants(source, ts.isCallExpression)) {
    const specifier = call.arguments[0];
    if (!specifier || !ts.isStringLiteralLike(specifier)) continue;
    const callee = unwrap(call.expression);
    if (!resolvesToParseOwner(path, specifier.text)) continue;
    if (callee.kind === ts.SyntaxKind.ImportKeyword) loads.push("dynamic-import");
    if (ts.isIdentifier(callee) && callee.text === "require") loads.push("require");
  }
  for (const importType of descendants(source, ts.isImportTypeNode)) {
    const argument = importType.argument;
    if (
      ts.isLiteralTypeNode(argument) &&
      ts.isStringLiteral(argument.literal) &&
      resolvesToParseOwner(path, argument.literal.text)
    ) loads.push("import-type");
  }
  return loads;
}

function activeOwnerBorrowerFiles(members: readonly string[]): string[] {
  return productionSourceFiles
    .filter((path) => path !== ACTIVE_PARSE_OWNER.file && path !== VIEWER_COMMANDS_FILE)
    // The oracle is deliberately deep; do not run it over unrelated route/service files. Every
    // supported provenance begins at an exact owner import, while the corpus-wide inactive gate
    // below still audits every production/test/helper source for stale imports and escapes.
    .filter((path) => importsModule(parse(path), ACTIVE_PARSE_OWNER.module))
    .filter((path) => members.some((member) => provenBorrowerMembers(path).has(member)));
}

function functionDefinitions(name: string): Array<{ path: string; node: ts.FunctionDeclaration }> {
  return productionSourceFiles.flatMap((path) =>
    descendants(
      parse(path),
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === name,
    ).map((node) => ({ path, node })),
  );
}

function callLabels(root: ts.Node, source: ts.SourceFile): string[] {
  return descendants(root, ts.isCallExpression).map((call) => compact(call.expression, source));
}

function restoreStores(): void {
  useSessionStore.setState(useSessionStore.getInitialState(), true);
  useUiStore.setState(useUiStore.getInitialState(), true);
  useViewerCoreStore.setState(useViewerCoreStore.getInitialState(), true);
  useToolStore.setState(useToolStore.getInitialState(), true);
  useParseFlowStore.setState(useParseFlowStore.getInitialState(), true);
  useViewerStore.setState(useViewerStore.getInitialState(), true);
}

beforeEach(restoreStores);

describe("P2.4 phase-aware parse owner and compatibility surfaces", () => {
  const activeSource = parse(ACTIVE_PARSE_OWNER.file);
  const activeInterfaceKeys = interfaceKeys(findInterface(activeSource, ACTIVE_PARSE_OWNER.interfaceName));
  const activeObjectKeys = directObjectKeys(findStoreObject(activeSource, ACTIVE_PARSE_OWNER.storeName));

  it("pins the phase-owned 35/41 definition and independent inactive definition/runtime absence", () => {
    expect(PARSE_DATA_KEYS).toHaveLength(35);
    expect(PARSE_LEAF_ACTION_KEYS).toHaveLength(41);
    expect(PARSE_TEST_STATE_KEYS).toEqual(PARSE_DATA_KEYS);
    expect(PARSE_TEST_ACTION_KEYS).toEqual(PARSE_LEAF_ACTION_KEYS);
    expectOwnerLedgerDefinition(ACTIVE_PARSE_OWNER, "exact-ledger");

    if (OWNERSHIP.inactiveDefinition === "module-absent") {
      expect(existsRelative(INACTIVE_PARSE_OWNER.file)).toBe(false);
      expect(RUNTIME_OWNER_STATE_READERS[INACTIVE_PARSE_OWNER.module]).toBeUndefined();
    } else {
      expect(existsRelative(INACTIVE_PARSE_OWNER.file)).toBe(true);
      expectOwnerLedgerDefinition(INACTIVE_PARSE_OWNER, OWNERSHIP.inactiveDefinition);
    }

    if (existsRelative(PARSE_OWNER.file)) {
      const candidateDefinitions = ownerDefinitionKeys(PARSE_OWNER);
      const candidateRuntime = RUNTIME_OWNER_STATE_READERS[PARSE_OWNER.module]!();
      expect(candidateDefinitions.interfaceKeys.includes("resetProjectParseState")).toBe(true);
      expect(candidateDefinitions.objectKeys.includes("resetProjectParseState")).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(candidateRuntime, "resetProjectParseState"))
        .toBe(true);
    }
    const viewerDefinitions = ownerDefinitionKeys(VIEWER_OWNER);
    expect(viewerDefinitions.interfaceKeys.includes("resetProjectParseState")).toBe(false);
    expect(viewerDefinitions.objectKeys.includes("resetProjectParseState")).toBe(false);
  });

  it("keeps the sole parse owner dependency-free and self-calibrates load detection", () => {
    const source = parse(PARSE_OWNER.file);
    const imports = source.statements
      .filter(ts.isImportDeclaration)
      .map((statement) => ({
        module: (statement.moduleSpecifier as ts.StringLiteral).text,
        typeOnly: !!statement.importClause?.isTypeOnly,
      }))
      .sort((left, right) => left.module.localeCompare(right.module));
    expect(imports).toEqual([
      { module: "@/types", typeOnly: true },
      { module: "zustand", typeOnly: false },
      { module: "zustand/react/shallow", typeOnly: false },
    ]);
    const dynamicLoads = descendants(source, ts.isCallExpression).filter((call) => {
      const callee = unwrap(call.expression);
      return callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === "require");
    });
    expect(dynamicLoads).toEqual([]);
    const loadFixturePath = "src/components/parse-owner-load-fixture.ts";
    const loadFixture = ts.createSourceFile(
      loadFixturePath,
      `
        import { useParseFlowStore } from "@/stores/parseFlowStore";
        import { useParseFlowStore as relativeStore } from "../stores/parseFlowStore";
        export { ParseFlowState } from "@/stores/parseFlowStore";
        const lazy = import("@/stores/parseFlowStore");
        const commonJs = require("../stores/parseFlowStore");
        type InlineState = import("@/stores/parseFlowStore").ParseFlowState;
      `,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    expect(parseOwnerLoadKinds(loadFixturePath, loadFixture)).toEqual([
      "import",
      "import",
      "re-export",
      "dynamic-import",
      "require",
      "import-type",
    ]);
    expect(productionSourceFiles.some((path) => parseOwnerLoadKinds(path).length > 0)).toBe(true);
  });

  it("keeps the four step writers out of the leaf and defined only by the neutral command module", () => {
    for (const command of NEUTRAL_STEP_COMMANDS) {
      expect(PARSE_LEAF_ACTION_KEYS).not.toContain(command);
      expect(activeInterfaceKeys, `${command} absent from active interface`).not.toContain(command);
      expect(activeObjectKeys, `${command} absent from active defaults`).not.toContain(command);

      const definitions = functionDefinitions(command);
      expect(definitions.map(({ path }) => path), `${command} provenance`).toEqual([
        VIEWER_COMMANDS_FILE,
      ]);
      const source = parse(VIEWER_COMMANDS_FILE);
      expect(callLabels(definitions[0].node, source)).toEqual([
        "prepareParseEntry",
        "useParseFlowStore.getState",
        "useParseFlowStore.setState",
      ]);
    }
  }, 15_000);
});

describe("P2.4 phase-aware grouped parse hook contract", () => {
  it("pins useTableParse's exact 17-member shape and six calls across four files", () => {
    expect(hookShape("useTableParse", TABLE_HOOK_SHAPE)).toEqual(TABLE_HOOK_SHAPE);
    expect(exportedVariableCount(parse(ACTIVE_PARSE_OWNER.file), "useTableParse")).toBe(1);
    if (OWNERSHIP.inactiveDefinition === "exact-ledger") {
      expect(hookShape("useTableParse", TABLE_HOOK_SHAPE, INACTIVE_PARSE_OWNER))
        .toEqual(TABLE_HOOK_SHAPE);
      expect(exportedVariableCount(parse(INACTIVE_PARSE_OWNER.file), "useTableParse")).toBe(1);
    } else if (existsRelative(INACTIVE_PARSE_OWNER.file)) {
      expect(exportedVariableCount(parse(INACTIVE_PARSE_OWNER.file), "useTableParse")).toBe(0);
    }
    expect(importedCallTopology("useTableParse", ACTIVE_PARSE_OWNER)).toEqual(TABLE_HOOK_CALLERS);
    expect(importedCallTopology("useTableParse", INACTIVE_PARSE_OWNER)).toEqual({});
  });

  it("pins useKeynoteParse's exact 21-member shape and two calls", () => {
    expect(hookShape("useKeynoteParse", KEYNOTE_HOOK_SHAPE)).toEqual(KEYNOTE_HOOK_SHAPE);
    expect(exportedVariableCount(parse(ACTIVE_PARSE_OWNER.file), "useKeynoteParse")).toBe(1);
    if (OWNERSHIP.inactiveDefinition === "exact-ledger") {
      expect(hookShape("useKeynoteParse", KEYNOTE_HOOK_SHAPE, INACTIVE_PARSE_OWNER))
        .toEqual(KEYNOTE_HOOK_SHAPE);
      expect(exportedVariableCount(parse(INACTIVE_PARSE_OWNER.file), "useKeynoteParse")).toBe(1);
    } else if (existsRelative(INACTIVE_PARSE_OWNER.file)) {
      expect(exportedVariableCount(parse(INACTIVE_PARSE_OWNER.file), "useKeynoteParse")).toBe(0);
    }
    expect(importedCallTopology("useKeynoteParse", ACTIVE_PARSE_OWNER)).toEqual(KEYNOTE_HOOK_CALLERS);
    expect(importedCallTopology("useKeynoteParse", INACTIVE_PARSE_OWNER)).toEqual({});
  });
});

describe("P2.4 phase-aware sacred parse subscription topology", () => {
  it("keeps AnnotationOverlay on both grouped hooks plus exactly three direct parse primitives and zero drawing subscriptions", () => {
    const source = parse(ANNOTATION_OVERLAY);
    expect(importedCalls(source, [ACTIVE_PARSE_OWNER.module], "useTableParse"))
      .toHaveLength(1);
    expect(importedCalls(source, [ACTIVE_PARSE_OWNER.module], "useKeynoteParse"))
      .toHaveLength(1);
    expect(importedCalls(source, [INACTIVE_PARSE_OWNER.module], "useTableParse")).toHaveLength(0);
    expect(importedCalls(source, [INACTIVE_PARSE_OWNER.module], "useKeynoteParse")).toHaveLength(0);
    expect(groupedDestructure(source, "useTableParse")).toEqual([
      "tableParseStep",
      "tableParseRegion",
      "setTableParseRegion",
      "tableParseColumnBBs",
      "tableParseRowBBs",
    ]);
    expect(groupedDestructure(source, "useKeynoteParse")).toEqual([
      "keynoteParseStep",
      "keynoteParseRegion",
      "keynoteColumnBBs",
      "keynoteRowBBs",
      "setKeynoteYoloClass",
    ]);

    const parseScan = expectFailClosedOwnerScan(source);
    expect(knownMembers(parseScan, "selector")).toEqual([
      "tableCellStructure",
      "showTableCellStructure",
      "toggleCellHighlight",
    ]);
    const drawingScan = expectFailClosedOwnerScan(source, RESIDUAL_DRAWING_DESCRIPTOR);
    expect(knownMembers(drawingScan, "selector")).toEqual([]);
  });

  it("keeps DrawingPreviewLayer's residual drawing and table-then-keynote parse projections separate", () => {
    const source = parse(DRAWING_PREVIEW);
    const parseScan = expectFailClosedOwnerScan(source);
    expect(knownMembers(parseScan, "selector")).toEqual([
      "tableParseStep",
      "keynoteParseStep",
    ]);
    const drawingScan = expectFailClosedOwnerScan(source, RESIDUAL_DRAWING_DESCRIPTOR);
    expect(knownMembers(drawingScan, "selector")).toEqual([
      "_drawing",
      "_drawStart",
      "_drawEnd",
      "_mousePos",
    ]);
    expect(importedCalls(source, [ACTIVE_PARSE_OWNER.module], "useTableParse"))
      .toHaveLength(0);
    expect(importedCalls(source, [ACTIVE_PARSE_OWNER.module], "useKeynoteParse"))
      .toHaveLength(0);
  });

  it("pins PDFPage's guided grouped projection and both memo-slot direct projections", () => {
    const source = parse(PDF_PAGE);
    expect(groupedDestructure(source, "useKeynoteParse")).toEqual([
      "guidedParseActive",
      "guidedParseRegion",
      "guidedParseRows",
      "guidedParseCols",
      "setGuidedParseRows",
      "setGuidedParseCols",
    ]);
    expect(importedCalls(source, [ACTIVE_PARSE_OWNER.module], "useTableParse"))
      .toHaveLength(0);
    expect(knownMembers(expectFailClosedOwnerScan(source), "selector")).toEqual([
      "notesFastManualActive",
      "notesParseRegion",
      "setNotesFastManualGrid",
      "paragraphOverlayActive",
      "specParseRegion",
      "notesParseRegion",
      "paragraphBatch",
      "paragraphClipboard",
      "upsertPendingParagraph",
      "removePendingParagraph",
      "setParagraphClipboard",
      "resetNotesParse",
      "resetSpecParse",
    ]);
  });

  it("pins ParseRegionLayer's seven primitive parse projections", () => {
    const source = parse(PARSE_REGION_LAYER);
    expect(knownMembers(expectFailClosedOwnerScan(source), "selector")).toEqual([
      "tableParseRegion",
      "tableParseColumnBBs",
      "tableParseRowBBs",
      "keynoteParseRegion",
      "keynoteColumnBBs",
      "keynoteRowBBs",
      "parseDraftRegion",
    ]);
    expect(importedCalls(source, [ACTIVE_PARSE_OWNER.module], "useTableParse"))
      .toHaveLength(0);
    expect(importedCalls(source, [ACTIVE_PARSE_OWNER.module], "useKeynoteParse"))
      .toHaveLength(0);
  });
});

describe("P2.4 phase-aware mixed test-helper parse ledger", () => {
  it("partitions one logical patch into the exact six domains", () => {
    const resetTableParse = vi.fn();
    expect(partitionViewerStoreTestState({
      publicId: "P",
      searchQuery: "needle",
      pageNumber: 7,
      mode: "markup",
      tableParseStep: "review",
      resetTableParse,
      allTrades: ["Electrical"],
    })).toEqual({
      session: { publicId: "P" },
      ui: { searchQuery: "needle" },
      core: { pageNumber: 7 },
      tool: { mode: "markup" },
      parse: { tableParseStep: "review", resetTableParse },
      viewer: { allTrades: ["Electrical"] },
    });
  });

  it("publishes session -> UI -> core -> tool -> parse -> residual viewer", () => {
    const trace: string[] = [];
    const parseSnapshots: string[] = [];
    const viewerSnapshots: string[][] = [];
    const unsubscribers = [
      useSessionStore.subscribe(() => trace.push("session")),
      useUiStore.subscribe(() => trace.push("ui")),
      useViewerCoreStore.subscribe(() => trace.push("core")),
      useToolStore.subscribe(() => trace.push("tool")),
      useParseFlowStore.subscribe((state) => {
        trace.push("parse");
        parseSnapshots.push(state.tableParseStep);
      }),
      useViewerStore.subscribe((state) => {
        trace.push("viewer");
        viewerSnapshots.push(state.allTrades);
      }),
    ];

    setViewerStoreStateForTest({
      publicId: "P",
      searchQuery: "needle",
      pageNumber: 7,
      mode: "markup",
      tableParseStep: "review",
      allTrades: ["Electrical"],
    });

    expect(trace).toEqual(["session", "ui", "core", "tool", "parse", "viewer"]);
    expect(parseSnapshots).toEqual(["review"]);
    expect(viewerSnapshots).toEqual([["Electrical"]]);
    unsubscribers.forEach((unsubscribe) => unsubscribe());
  });

  it("skips every empty sibling partition for a parse-only setup", () => {
    const listeners = {
      session: vi.fn(),
      ui: vi.fn(),
      core: vi.fn(),
      tool: vi.fn(),
      parse: vi.fn(),
      viewer: vi.fn(),
    };
    const unsubscribers = [
      useSessionStore.subscribe(listeners.session),
      useUiStore.subscribe(listeners.ui),
      useViewerCoreStore.subscribe(listeners.core),
      useToolStore.subscribe(listeners.tool),
      useParseFlowStore.subscribe(listeners.parse),
      useViewerStore.subscribe(listeners.viewer),
    ];

    setViewerStoreStateForTest({ tableParseStep: "review" });

    expect(listeners.parse).toHaveBeenCalledTimes(1);
    expect(listeners.viewer).not.toHaveBeenCalled();
    expect(listeners.session).not.toHaveBeenCalled();
    expect(listeners.ui).not.toHaveBeenCalled();
    expect(listeners.core).not.toHaveBeenCalled();
    expect(listeners.tool).not.toHaveBeenCalled();
    unsubscribers.forEach((unsubscribe) => unsubscribe());
  });
});

describe("P2.4 phase-aware shared borrower manifests", () => {
  it("pins the direct shared-guided borrower set", () => {
    expect(activeOwnerBorrowerFiles([
      "guidedParseActive",
      "setGuidedParseActive",
      "guidedParseRegion",
      "setGuidedParseRegion",
      "guidedParseRows",
      "setGuidedParseRows",
      "guidedParseCols",
      "setGuidedParseCols",
      "resetGuidedParse",
    ])).toEqual([
      GUIDED_PARSE_TAB,
      KEYNOTE_PANEL,
      NOTES_PARSER,
      PDF_PAGE,
    ]);
  });

  it("pins the shared draft and paragraph workspace borrower sets, including moved owner types", () => {
    expect(activeOwnerBorrowerFiles(["parseDraftRegion", "setParseDraftRegion"]))
      .toEqual([NOTES_PARSER, PARSE_REGION_LAYER, SPEC_PARSER]);
    expect(activeOwnerBorrowerFiles([
      "paragraphOverlayActive",
      "setParagraphOverlayActive",
      "paragraphBatch",
      "setParagraphBatch",
      "upsertPendingParagraph",
      "removePendingParagraph",
      "paragraphClipboard",
      "setParagraphClipboard",
      "PendingParagraph",
      "ParagraphTemplate",
    ])).toEqual([
      NOTES_PARSER,
      PDF_PAGE,
      PARAGRAPH_OVERLAY,
      SPEC_PARSER,
    ]);
  });

  it("pins Shape's Table-region borrowing and consume-then-clear sequence", () => {
    const source = parse(SHAPE_INTERACTION);
    expect(knownMembers(expectFailClosedOwnerScan(source), "selector")).toEqual([
      "tableParseRegion",
      "setTableParseRegion",
    ]);
    expect(importedCalls(source, ["@/stores/viewerCommands"], "setTableParseStep"))
      .toHaveLength(3);
    const consumeEffects = descendants(source, ts.isCallExpression).filter((call) => {
      const callee = unwrap(call.expression);
      if (!ts.isIdentifier(callee) || callee.text !== "useEffect" || !call.arguments[0]) {
        return false;
      }
      const labels = callLabels(call.arguments[0], source);
      return labels.includes("setRegion") && labels.includes("setTableParseRegion");
    });
    expect(consumeEffects, "Shape shared-region consume effect").toHaveLength(1);
    expect(callLabels(consumeEffects[0].arguments[0], source)).toEqual([
      "setRegion",
      "setTableParseRegion",
    ]);
    const consumeCalls = descendants(consumeEffects[0].arguments[0], ts.isCallExpression);
    expect(compact(consumeCalls[0].arguments[0], source)).toBe(
      "tableParseRegionas[number,number,number,number]",
    );
    expect(compact(consumeCalls[1].arguments[0], source)).toBe("null");
  });

  it("pins keynote/schedule compare borrowing of the Table grid and region workspace", () => {
    const keynoteSource = parse(KEYNOTE_PANEL);
    const loadExisting = findVariable(keynoteSource, "loadExistingKeynote");
    const keynoteText = compact(loadExisting, keynoteSource);
    expect(keynoteText.indexOf("setTableParseRegion(")).toBeLessThan(
      keynoteText.indexOf("setTableParsedGrid("),
    );
    expect(keynoteText.indexOf("setTableParsedGrid(")).toBeLessThan(
      keynoteText.indexOf('setTableParseStep("review")'),
    );
    expect(keynoteText).toContain("useToolStore.getState().setMode(\"move\")");

    const parsedItemSource = parse(PARSED_TABLE_ITEM);
    const editCallbacks = descendants(parsedItemSource, ts.isArrowFunction).filter((callback) => {
      const text = compact(callback, parsedItemSource);
      return text.includes("store.setTableParsedGrid(") &&
        text.includes("store.setTableParseRegion(") &&
        text.includes("toggleTableCompareModal()");
    });
    expect(editCallbacks, "ParsedTableItem View/Edit callback").toHaveLength(1);
    const parsedItemText = compact(editCallbacks[0], parsedItemSource);
    expect(parsedItemText.indexOf("store.setTableParsedGrid(")).toBeLessThan(
      parsedItemText.indexOf("store.setTableParseRegion("),
    );
    expect(parsedItemText.indexOf("store.setTableParseRegion(")).toBeLessThan(
      parsedItemText.indexOf("toggleTableCompareModal()"),
    );

    const compareSource = parse(TABLE_COMPARE_MODAL);
    const handleDone = findVariable(compareSource, "handleDone");
    const compareText = compact(handleDone, compareSource);
    expect(compareText).toContain("useParseFlowStore.getState().tableParsedGrid");
    expect(compareText).toContain("store.parsedKeynoteData");
    expect(compareText).toContain("store.setParsedKeynoteData(updated)");
  });

  it("pins PDF paragraph precedence and kind-specific exit", () => {
    const source = parse(PDF_PAGE);
    const outerBbox = findVariable(source, "outerBbox");
    const isSpec = findVariable(source, "isSpec");
    const onExit = findVariable(source, "onExit");
    expect(compact(outerBbox.initializer!, source)).toBe("specParseRegion??notesParseRegion");
    expect(compact(isSpec.initializer!, source)).toBe("!!specParseRegion");
    expect(compact(onExit, source)).toContain("if(isSpec)resetSpecParse();elseresetNotesParse();");
  });
});

describe("P2.4 phase-aware guided-Spec tombstone", () => {
  it("keeps the dead field/action in the exact owner/reset while proving zero external production borrowers", () => {
    const source = parse(ACTIVE_PARSE_OWNER.file);
    const store = findStoreObject(source, ACTIVE_PARSE_OWNER.storeName);
    const reset = directProperty(store, "resetSpecParse");
    const resetObjects = descendants(reset, ts.isObjectLiteralExpression).filter((object) =>
      directObjectKeys(object).includes("specParseStep"),
    );
    expect(resetObjects).toHaveLength(1);
    expect(directObjectKeys(resetObjects[0])).toEqual([
      "specParseStep",
      "specParseRegion",
      "guidedSpecSectionBBs",
      "parseDraftRegion",
      "paragraphOverlayActive",
      "paragraphBatch",
    ]);
    expect(activeOwnerBorrowerFiles([
      "guidedSpecSectionBBs",
      "addGuidedSpecSectionBB",
    ])).toEqual([]);
  });
});

describe("P2.4 phase-aware shared owner-oracle integration", () => {
  it("uses one deduped production + real-test + src/test corpus for the inactive owner", () => {
    expect(allSourceCorpus).toEqual(everyTypeScriptSourceFile);
    expect(new Set(allSourceCorpus).size).toBe(allSourceCorpus.length);
    expect(allSourceCorpus).toEqual([
      ...new Set([...productionSourceFiles, ...realTestSourceFiles, ...srcTestSourceFiles]),
    ].sort());
  });

  it("sees live active consumers and rejects every non-allowlisted inactive-owner access", () => {
    const activeKnown = productionSourceFiles.flatMap((path) =>
      ownerScan(parse(path), ACTIVE_PARSE_DESCRIPTOR).known,
    );
    const inactiveByFile = allSourceCorpus.map((path) => ({
      path,
      result: ownerScan(parse(path), INACTIVE_PARSE_DESCRIPTOR),
    })).filter(({ result }) => result.findings.length > 0);
    const allowlist = new Set<string>(OWNERSHIP.inactiveAccessAllowlist);
    const unexpected = inactiveByFile.filter(({ path }) => !allowlist.has(path));
    const allowed = inactiveByFile.filter(({ path }) => allowlist.has(path));
    const observedAllowlist = allowed.map(({ path }) => path);

    const accessed = new Set(activeKnown.map((finding) => finding.member));
    for (const representative of [
      "tableParseRegion",
      "keynoteParseRegion",
      "notesParseRegion",
      "specParseRegion",
      "guidedParseRows",
      "paragraphBatch",
    ]) {
      expect(accessed, `${representative} live parse consumer`).toContain(representative);
    }
    expect(unexpected.flatMap(({ result }) => [
      ...result.known.map((finding) =>
        `${finding.fileName}:${finding.line}:${finding.column} ${formatStoreOwnerFinding(finding)}`),
      ...findingLabels(result),
    ])).toEqual([]);
    // The sole S2 exception exists only because this topology file deliberately snapshots the
    // residual owner to prove runtime absence. It may never hide a statically known parse access.
    expect(allowed.flatMap(({ result }) => result.known.map((finding) =>
      `${finding.fileName}:${finding.line}:${finding.column} ${formatStoreOwnerFinding(finding)}`,
    ))).toEqual([]);
    expect(observedAllowlist).toEqual([...allowlist].sort());
  }, 60_000);
});
