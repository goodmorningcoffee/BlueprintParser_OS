// @vitest-environment node
// [refactor jul11 P2.3 U0] PRE-carve ownership/topology freeze for the pure display slice.
// This is deliberately a source contract: runtime store tests cover setter behavior, while this
// file makes the upcoming additive uiStore + atomic flip reviewable and prevents a compatibility
// shortcut from widening subscriptions on the hot viewer path.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const VIEWER_STORE_FILE = "src/stores/viewerStore.ts";
const FUTURE_UI_STORE_FILE = "src/stores/uiStore.ts";
const ANNOTATION_OVERLAY = "src/components/viewer/AnnotationOverlay.tsx";
const YOLO_FACADE = "src/queries/useYoloTags.ts";

// Flip-ready ownership switch. U0 intentionally points at the PRE-carve owner. At the atomic U2
// flip this one tuple changes to UI_OWNER and the same alias/cast/computed-key oracle rejects every
// remaining legacy viewerStore access instead of relying on grep or TypeScript's `any` behavior.
const VIEWER_OWNER = {
  file: VIEWER_STORE_FILE,
  module: "@/stores/viewerStore",
  exportName: "useViewerStore",
} as const;
const UI_OWNER = {
  file: FUTURE_UI_STORE_FILE,
  module: "@/stores/uiStore",
  exportName: "useUiStore",
} as const;
const ACTIVE_UI_OWNER = VIEWER_OWNER;
const INACTIVE_UI_OWNER = UI_OWNER;

type UiFieldContract = {
  readonly default: string;
  readonly actions: readonly string[];
};

// Exact U0 pure-display ledger: 60 state fields. Defaults are compact AST source text so Sets and
// literal assertions remain distinguishable. Actions are ownership companions, not a claim that
// every action is a one-field setter (the compound exceptions are frozen separately below).
const PURE_UI_CONTRACT = {
  searchQuery: { default: '""', actions: ["setSearch"] },
  searchResults: { default: "[]", actions: ["setSearchResults"] },
  searchMatches: { default: "{}", actions: ["setSearchMatches"] },
  searchLoading: { default: "false", actions: ["setSearchLoading"] },
  focusAnnotationId: { default: "null", actions: ["setFocusAnnotationId"] },
  selectedAnnotationIds: {
    default: "newSet<number>()",
    actions: [
      "setSelectedAnnotationIds",
      "addToSelection",
      "removeFromSelection",
      "toggleSelection",
      "clearSelection",
    ],
  },
  showTextAnnotations: { default: "false", actions: ["toggleTextAnnotations"] },
  activeTextAnnotationTypes: {
    default: "{}",
    actions: ["setTextAnnotationType", "setAllTextAnnotationTypes"],
  },
  hiddenTextAnnotations: {
    default: "newSet<string>()",
    actions: ["toggleTextAnnotationVisibility"],
  },
  textAnnotationColors: { default: "{}", actions: ["setTextAnnotationColor"] },
  activeTextAnnotationFilter: { default: "null", actions: ["setTextAnnotationFilter"] },
  activeTakeoffFilter: { default: "null", actions: ["setTakeoffFilter"] },
  textPanelTab: { default: '"annotations"', actions: ["setTextPanelTab"] },
  activeMarkupId: { default: "null", actions: ["setActiveMarkupId"] },

  showTextPanel: { default: "false", actions: ["toggleTextPanel"] },
  showChatPanel: { default: "true", actions: ["toggleChatPanel"] },
  showDetectionPanel: { default: "false", actions: ["toggleDetectionPanel"] },
  showViewAllPanel: { default: "false", actions: ["toggleViewAllPanel"] },
  showCsiPanel: { default: "false", actions: ["toggleCsiPanel"] },
  showPageIntelPanel: { default: "false", actions: ["togglePageIntelPanel"] },
  showTakeoffPanel: { default: "false", actions: ["toggleTakeoffPanel"] },
  showTableParsePanel: { default: "false", actions: ["toggleTableParsePanel"] },
  showKeynoteParsePanel: { default: "false", actions: ["toggleKeynoteParsePanel"] },
  showSpecsNotesPanel: { default: "false", actions: ["toggleSpecsNotesPanel"] },
  showParsePanel: { default: "false", actions: ["toggleParsePanel"] },
  showToolsPanel: { default: "false", actions: ["toggleToolsPanel"] },
  showTips: { default: "false", actions: ["toggleTips"] },
  helpMode: { default: "false", actions: ["toggleHelpMode"] },
  sidebarCollapsed: { default: "false", actions: ["toggleSidebar"] },
  annotationPanelCollapsed: { default: "false", actions: ["toggleAnnotationPanel"] },
  specsNotesTab: { default: '"spec-parse"', actions: ["setSpecsNotesTab"] },
  parsePanelTab: { default: '"shape"', actions: ["setParsePanelTab"] },
  toolsPanelTab: { default: '"csi"', actions: ["setToolsPanelTab"] },

  showDetections: { default: "false", actions: ["toggleDetections"] },
  activeModels: { default: "{}", actions: ["setModelActive", "initDetectionModels"] },
  confidenceThreshold: { default: "0.10", actions: ["setConfidenceThreshold"] },
  confidenceThresholds: {
    default: "{}",
    actions: ["setModelConfidence", "initDetectionModels"],
  },
  hiddenAnnotationIds: {
    default: "newSet<number>()",
    actions: ["toggleAnnotationVisibility"],
  },
  hiddenClasses: { default: "{}", actions: ["toggleClassVisibility"] },
  showKeynotes: { default: "false", actions: ["toggleKeynotes"] },
  activeKeynoteFilter: { default: "null", actions: ["setKeynoteFilter"] },
  activeAnnotationFilter: { default: "null", actions: ["setAnnotationFilter"] },
  activeTradeFilter: { default: "null", actions: ["setTradeFilter"] },
  activeCsiFilter: { default: "null", actions: ["setCsiFilter"] },

  hiddenTakeoffItemIds: {
    default: "newSet<number>()",
    actions: ["toggleTakeoffItemVisibility"],
  },
  takeoffTab: { default: '"count"', actions: ["setTakeoffTab"] },
  activeYoloTagId: { default: "null", actions: ["setActiveYoloTagId"] },
  yoloTagVisibility: { default: "{}", actions: ["setYoloTagVisibility"] },
  activeYoloTagFilter: { default: "null", actions: ["setYoloTagFilter"] },
  activeTableTagViews: { default: "{}", actions: ["setTableTagView"] },
  llmHighlight: { default: "null", actions: ["setLlmHighlight"] },
  // These two are published by the data-dependent navigateYoloTag command and intentionally have
  // no leaf setter today. That mixed Query/UI/core publication is characterized later in this file.
  tagBrowseId: { default: "null", actions: [] },
  tagBrowseIndex: { default: "0", actions: [] },
  showParsedRegions: { default: "true", actions: ["toggleParsedRegions"] },
  parsedRegionColorMode: { default: '"striped"asconst', actions: ["setParsedRegionColorMode"] },
  hiddenParsedRegionIds: {
    default: "newSet<string>()",
    actions: ["toggleParsedRegionVisibility"],
  },
  focusedParsedRegionId: { default: "null", actions: ["setFocusedParsedRegionId"] },
  chatScope: { default: '"page"', actions: ["setChatScope"] },
  activeKeynoteHighlight: { default: "null", actions: ["setActiveKeynoteHighlight"] },
  showTableCompareModal: { default: "false", actions: ["toggleTableCompareModal"] },
} as const satisfies Record<string, UiFieldContract>;

const PURE_UI_MEMBER_NAMES = new Set<string>([
  ...Object.keys(PURE_UI_CONTRACT),
  ...Object.values(PURE_UI_CONTRACT).flatMap((contract) => [...contract.actions]),
]);

// Explicit non-UI seams found in the U0 census. They stay visible here so a future mechanical
// carve cannot silently sweep server metadata, active tools, core geometry, parse drafts, or a
// mutable server-row draft into a store merely because the current UI happens to display them.
const UI_BOUNDARY_EXCLUSIONS = {
  serverMetadata: ["allTrades", "allCsiCodes"],
  viewerCore: ["pageDimensions"],
  toolInteraction: [
    "mode",
    "tempPanMode",
    "activeTakeoffItemId",
    "scaleCalibrations",
    "yoloTagPickingMode",
    "tagScanResults",
    "tagAddingMode",
  ],
  parseFlow: [
    "paragraphClipboard",
    "tableCellStructure",
    "showTableCellStructure",
    "tableParseTab",
    "keynoteParseTab",
  ],
  mutableServerDraft: ["activeQtoWorkflow"],
} as const;

const COMPOUND_COMMAND_MEMBERS = {
  toggleDetectionPanel: ["showDetectionPanel", "showParsePanel", "resetAllTools"],
  toggleTakeoffPanel: ["activeTakeoffItemId", "showChatPanel", "showTakeoffPanel"],
  toggleTableParsePanel: [
    "guidedParseActive",
    "guidedParseCols",
    "guidedParseRegion",
    "guidedParseRows",
    "mode",
    "showTableParsePanel",
    "tableParseColumnBBs",
    "tableParseColumnNames",
    "tableParseMeta",
    "tableParseRegion",
    "tableParseRowBBs",
    "tableParseStep",
    "tableParseTab",
    "tableParsedGrid",
  ],
  toggleParsePanel: ["resetAllTools", "showDetectionPanel", "showParsePanel"],
  toggleKeynoteParsePanel: [
    "guidedParseActive",
    "guidedParseCols",
    "guidedParseRegion",
    "guidedParseRows",
    "keynoteColumnBBs",
    "keynoteParseRegion",
    "keynoteParseStep",
    "keynoteParseTab",
    "keynoteRowBBs",
    "keynoteYoloClass",
    "mode",
    "showKeynoteParsePanel",
  ],
  resetAllTools: [
    "clearSymbolSearch",
    "resetGuidedParse",
    "resetKeynoteParse",
    "resetNotesParse",
    "resetSpecParse",
    "resetTableParse",
    "setMode",
  ],
} as const;

const GROUPED_HOOK_SHAPES = {
  usePanels: [
    "showTextPanel", "toggleTextPanel", "showChatPanel", "toggleChatPanel",
    "showTakeoffPanel", "toggleTakeoffPanel", "showDetectionPanel", "toggleDetectionPanel",
    "showViewAllPanel", "toggleViewAllPanel", "showCsiPanel", "toggleCsiPanel",
    "showPageIntelPanel", "togglePageIntelPanel", "showTableParsePanel", "toggleTableParsePanel",
    "showKeynoteParsePanel", "toggleKeynoteParsePanel", "showSpecsNotesPanel", "toggleSpecsNotesPanel",
    "specsNotesTab", "setSpecsNotesTab", "showParsePanel", "toggleParsePanel",
    "parsePanelTab", "setParsePanelTab", "showToolsPanel", "toggleToolsPanel",
    "toolsPanelTab", "setToolsPanelTab", "sidebarCollapsed", "toggleSidebar",
    "textPanelTab", "setTextPanelTab",
  ],
  useDetection: [
    "activeModels", "setModelActive", "confidenceThreshold", "setConfidenceThreshold",
    "activeAnnotationFilter", "setAnnotationFilter", "searchQuery", "setSearch",
    "hiddenAnnotationIds", "toggleAnnotationVisibility", "hiddenClasses", "toggleClassVisibility",
  ],
  useSelection: [
    "selectedAnnotationIds", "setSelectedAnnotationIds", "addToSelection",
    "removeFromSelection", "toggleSelection", "clearSelection",
  ],
  // Existing hot-path facade: keep this exact eight-value projection; it is not permission to add
  // a whole-ui hook when the leaf moves.
  useAnnotationFilters: [
    "showDetections", "confidenceThreshold", "activeModels", "hiddenClasses",
    "confidenceThresholds", "activeAnnotationFilter", "activeCsiFilter", "hiddenAnnotationIds",
  ],
} as const;

const GROUPED_HOOK_CALL_TOPOLOGY = {
  usePanels: {
    "src/components/viewer/CsiPanel.tsx": 1,
    "src/components/viewer/DetectionPanel.tsx": 1,
    "src/components/viewer/PageIntelligencePanel.tsx": 1,
    "src/components/viewer/PDFViewer.tsx": 2,
    "src/components/viewer/ParsePanel.tsx": 1,
    "src/components/viewer/SpecsNotesPanel.tsx": 1,
    "src/components/viewer/TextPanel.tsx": 1,
    "src/components/viewer/ToolsPanel.tsx": 1,
    "src/components/viewer/ViewAllPanel.tsx": 1,
    "src/components/viewer/ViewerToolbar.tsx": 1,
  },
  useDetection: {
    "src/components/viewer/CsiPanel.tsx": 1,
    "src/components/viewer/DetectionPanel.tsx": 1,
    "src/components/viewer/PageSidebar.tsx": 1,
    "src/components/viewer/TextPanel.tsx": 2,
    "src/components/viewer/ViewAllPanel.tsx": 1,
    "src/components/viewer/ViewerToolbar.tsx": 1,
  },
  useSelection: {
    "src/components/viewer/GroupActionsBar.tsx": 1,
    "src/components/viewer/ViewAllPanel.tsx": 1,
    "src/hooks/useMultiSelectInteraction.ts": 1,
  },
  useAnnotationFilters: {
    "src/components/viewer/AnnotationOverlay.tsx": 1,
  },
} as const;

const HOT_OVERLAY_UI_SELECTORS = [
  "activeTableTagViews",
  "activeYoloTagId",
  "focusAnnotationId",
  "hiddenTakeoffItemIds",
  "llmHighlight",
  "setActiveYoloTagId",
  "setAnnotationFilter",
  "setKeynoteFilter",
  "setSearch",
  "setTakeoffFilter",
  "setYoloTagFilter",
  "showTakeoffPanel",
  "yoloTagVisibility",
] as const;

const sourceTextCache = new Map<string, string>();
const parsedSourceCache = new Map<string, ts.SourceFile>();

function textOf(relativePath: string): string {
  const cached = sourceTextCache.get(relativePath);
  if (cached !== undefined) return cached;
  const value = readFileSync(join(process.cwd(), relativePath), "utf8");
  sourceTextCache.set(relativePath, value);
  return value;
}

function parse(relativePath: string): ts.SourceFile {
  const cached = parsedSourceCache.get(relativePath);
  if (cached) return cached;
  const result = ts.createSourceFile(
    relativePath,
    textOf(relativePath),
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  parsedSourceCache.set(relativePath, result);
  return result;
}

function productionFiles(relativeDirectory = "src"): string[] {
  const output: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(join(process.cwd(), directory), { withFileTypes: true })) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") visit(child);
      } else if (
        /\.(?:ts|tsx)$/.test(entry.name) &&
        !/\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name) &&
        !entry.name.endsWith(".d.ts") &&
        !child.startsWith("src/test/")
      ) {
        output.push(child);
      }
    }
  };
  visit(relativeDirectory);
  return output.sort();
}

const productionSourceFiles = productionFiles();

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

function unwrapExpression(expression: ts.Expression): ts.Expression {
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

function staticStringConstants(root: ts.Node): Map<string, string> {
  const constants = new Map<string, string>();
  const ambiguous = new Set<string>();
  const declarations = descendants(root, ts.isVariableDeclaration);
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const initializer = unwrapExpression(declaration.initializer);
      const value = ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)
        ? initializer.text
        : ts.isIdentifier(initializer)
          ? constants.get(initializer.text)
          : undefined;
      if (value === undefined || ambiguous.has(declaration.name.text)) continue;
      const previous = constants.get(declaration.name.text);
      if (previous === value) continue;
      if (previous !== undefined) {
        constants.delete(declaration.name.text);
        ambiguous.add(declaration.name.text);
      } else {
        constants.set(declaration.name.text, value);
      }
      changed = true;
    }
  }
  return constants;
}

function staticName(
  name: ts.PropertyName | ts.BindingName | undefined,
  constants: ReadonlyMap<string, string> = new Map(),
): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (!ts.isComputedPropertyName(name)) return null;
  const expression = unwrapExpression(name.expression);
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  return ts.isIdentifier(expression) ? constants.get(expression.text) ?? null : null;
}

function elementAccessName(
  access: ts.ElementAccessExpression,
  constants: ReadonlyMap<string, string>,
): string | null {
  const argument = access.argumentExpression && unwrapExpression(access.argumentExpression);
  if (!argument) return null;
  if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
    return argument.text;
  }
  return ts.isIdentifier(argument) ? constants.get(argument.text) ?? null : null;
}

function expressionMemberName(
  expression: ts.Expression,
  constants: ReadonlyMap<string, string>,
): string | null {
  const unwrapped = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(unwrapped)) return unwrapped.name.text;
  return ts.isElementAccessExpression(unwrapped) ? elementAccessName(unwrapped, constants) : null;
}

function directObjectKeys(
  object: ts.ObjectLiteralExpression,
  constants: ReadonlyMap<string, string> = new Map(),
): string[] {
  return object.properties
    .map((property) => ("name" in property ? staticName(property.name, constants) : null))
    .filter((name): name is string => name !== null);
}

function importedLocalNames(
  source: ts.SourceFile,
  moduleName: string,
  importedName: string,
): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== moduleName
    ) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === importedName) names.add(element.name.text);
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
      const initializer = unwrapExpression(declaration.initializer);
      if (ts.isIdentifier(initializer) && aliases.has(initializer.text) && !aliases.has(declaration.name.text)) {
        aliases.add(declaration.name.text);
        changed = true;
      }
    }
    for (const assignment of descendants(
      root,
      (node): node is ts.BinaryExpression =>
        ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken,
    )) {
      const left = unwrapExpression(assignment.left);
      const right = unwrapExpression(assignment.right);
      if (ts.isIdentifier(left) && ts.isIdentifier(right) && aliases.has(right.text) && !aliases.has(left.text)) {
        aliases.add(left.text);
        changed = true;
      }
    }
  }
  return aliases;
}

function methodAliases(
  root: ts.Node,
  objectAliases: ReadonlySet<string>,
  method: "getState" | "setState",
  constants: ReadonlyMap<string, string>,
): Set<string> {
  const aliases = new Set<string>();
  for (const declaration of descendants(root, ts.isVariableDeclaration)) {
    if (!declaration.initializer) continue;
    const initializer = unwrapExpression(declaration.initializer);
    if (ts.isIdentifier(declaration.name)) {
      if (
        (ts.isPropertyAccessExpression(initializer) || ts.isElementAccessExpression(initializer)) &&
        ts.isIdentifier(unwrapExpression(initializer.expression)) &&
        objectAliases.has((unwrapExpression(initializer.expression) as ts.Identifier).text) &&
        expressionMemberName(initializer, constants) === method
      ) aliases.add(declaration.name.text);
    } else if (ts.isObjectBindingPattern(declaration.name)) {
      if (!ts.isIdentifier(initializer) || !objectAliases.has(initializer.text)) continue;
      for (const element of declaration.name.elements) {
        if (staticName(element.propertyName ?? element.name, constants) === method && ts.isIdentifier(element.name)) {
          aliases.add(element.name.text);
        }
      }
    }
  }
  return identifierAliases(root, aliases);
}

function isMethodCall(
  call: ts.CallExpression,
  objectAliases: ReadonlySet<string>,
  functionAliases: ReadonlySet<string>,
  method: "getState" | "setState",
  constants: ReadonlyMap<string, string>,
): boolean {
  const expression = unwrapExpression(call.expression);
  if (ts.isIdentifier(expression)) return functionAliases.has(expression.text);
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) return false;
  const receiver = unwrapExpression(expression.expression);
  return ts.isIdentifier(receiver) &&
    objectAliases.has(receiver.text) &&
    expressionMemberName(expression, constants) === method;
}

function selectorFunction(expression: ts.Expression | undefined): ts.FunctionExpression | ts.ArrowFunction | null {
  if (!expression) return null;
  const unwrapped = unwrapExpression(expression);
  if (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)) return unwrapped;
  // Handles useShallow((state) => ...), including a casted/aliased outer call. The inner callback
  // is the only argument that can select store state; deeper wrappers are followed recursively.
  if (ts.isCallExpression(unwrapped)) {
    for (const argument of unwrapped.arguments) {
      const nested = selectorFunction(argument);
      if (nested) return nested;
    }
  }
  return null;
}

function bindingMemberNames(
  name: ts.BindingName,
  constants: ReadonlyMap<string, string>,
  members: ReadonlySet<string>,
): string[] {
  if (!ts.isObjectBindingPattern(name)) return [];
  return name.elements
    .map((element) => staticName(element.propertyName ?? element.name, constants))
    .filter((candidate): candidate is string => !!candidate && members.has(candidate));
}

function consumerOutsideCasts(expression: ts.Expression): ts.Node {
  let current: ts.Expression = expression;
  while (
    current.parent &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent)) &&
    current.parent.expression === current
  ) current = current.parent;
  return current.parent;
}

type StoreAccess = { readonly kind: string; readonly member: string };

/** Alias/cast/computed-aware access census used as both PRE baseline and post-flip escape gate. */
function storeMemberAccesses(
  source: ts.SourceFile,
  owner: { readonly module: string; readonly exportName: string },
  members: ReadonlySet<string>,
): StoreAccess[] {
  const output: StoreAccess[] = [];
  const constants = staticStringConstants(source);
  const hooks = identifierAliases(
    source,
    importedLocalNames(source, owner.module, owner.exportName),
  );
  const getters = methodAliases(source, hooks, "getState", constants);
  const setters = methodAliases(source, hooks, "setState", constants);
  const calls = descendants(source, ts.isCallExpression);
  const isGet = (call: ts.CallExpression) => isMethodCall(call, hooks, getters, "getState", constants);
  const isSet = (call: ts.CallExpression) => isMethodCall(call, hooks, setters, "setState", constants);

  const resultNames = new Set<string>();
  for (const declaration of descendants(source, ts.isVariableDeclaration)) {
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
    const initializer = unwrapExpression(declaration.initializer);
    if (ts.isCallExpression(initializer) && isGet(initializer)) resultNames.add(declaration.name.text);
  }
  const resultAliases = identifierAliases(source, resultNames);

  for (const call of calls) {
    const callee = unwrapExpression(call.expression);
    if (ts.isIdentifier(callee) && hooks.has(callee.text)) {
      const selector = selectorFunction(call.arguments[0]);
      if (selector?.parameters.length === 1) {
        const parameter = selector.parameters[0].name;
        for (const member of bindingMemberNames(parameter, constants, members)) {
          output.push({ kind: "selector-parameter", member });
        }
        if (ts.isIdentifier(parameter)) {
          const stateAliases = identifierAliases(selector.body, [parameter.text]);
          for (const access of descendants(selector.body, ts.isPropertyAccessExpression)) {
            const receiver = unwrapExpression(access.expression);
            if (ts.isIdentifier(receiver) && stateAliases.has(receiver.text) && members.has(access.name.text)) {
              output.push({ kind: "selector", member: access.name.text });
            }
          }
          for (const access of descendants(selector.body, ts.isElementAccessExpression)) {
            const receiver = unwrapExpression(access.expression);
            const member = elementAccessName(access, constants);
            if (ts.isIdentifier(receiver) && stateAliases.has(receiver.text) && member && members.has(member)) {
              output.push({ kind: "selector-element", member });
            }
          }
          for (const declaration of descendants(selector.body, ts.isVariableDeclaration)) {
            if (!declaration.initializer) continue;
            const initializer = unwrapExpression(declaration.initializer);
            if (!ts.isIdentifier(initializer) || !stateAliases.has(initializer.text)) continue;
            for (const member of bindingMemberNames(declaration.name, constants, members)) {
              output.push({ kind: "selector-destructure", member });
            }
          }
        }
      } else {
        const consumer = consumerOutsideCasts(call);
        if (ts.isVariableDeclaration(consumer)) {
          for (const member of bindingMemberNames(consumer.name, constants, members)) {
            output.push({ kind: "hook-destructure", member });
          }
        }
        if (ts.isPropertyAccessExpression(consumer) && members.has(consumer.name.text)) {
          output.push({ kind: "hook-direct", member: consumer.name.text });
        }
        if (ts.isElementAccessExpression(consumer)) {
          const member = elementAccessName(consumer, constants);
          if (member && members.has(member)) output.push({ kind: "hook-direct-element", member });
        }
      }
    }

    if (isGet(call)) {
      const consumer = consumerOutsideCasts(call);
      if (ts.isVariableDeclaration(consumer)) {
        for (const member of bindingMemberNames(consumer.name, constants, members)) {
          output.push({ kind: "getState-destructure", member });
        }
      }
      if (ts.isPropertyAccessExpression(consumer) && members.has(consumer.name.text)) {
        output.push({ kind: "getState-direct", member: consumer.name.text });
      }
      if (ts.isElementAccessExpression(consumer)) {
        const member = elementAccessName(consumer, constants);
        if (member && members.has(member)) output.push({ kind: "getState-direct-element", member });
      }
    }

    if (isSet(call) && call.arguments[0]) {
      for (const object of descendants(call.arguments[0], ts.isObjectLiteralExpression)) {
        for (const member of directObjectKeys(object, constants)) {
          if (members.has(member)) output.push({ kind: "setState", member });
        }
      }
    }
  }

  for (const access of descendants(source, ts.isPropertyAccessExpression)) {
    const receiver = unwrapExpression(access.expression);
    if (ts.isIdentifier(receiver) && resultAliases.has(receiver.text) && members.has(access.name.text)) {
      output.push({ kind: "getState-alias", member: access.name.text });
    }
  }
  for (const access of descendants(source, ts.isElementAccessExpression)) {
    const receiver = unwrapExpression(access.expression);
    const member = elementAccessName(access, constants);
    if (ts.isIdentifier(receiver) && resultAliases.has(receiver.text) && member && members.has(member)) {
      output.push({ kind: "getState-alias-element", member });
    }
  }
  return output;
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

function findViewerState(source: ts.SourceFile): ts.InterfaceDeclaration {
  const matches = descendants(
    source,
    (node): node is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(node) && node.name.text === "ViewerState",
  );
  expect(matches).toHaveLength(1);
  return matches[0];
}

function findStoreObject(source: ts.SourceFile, storeName: string): ts.ObjectLiteralExpression {
  const declaration = findVariable(source, storeName);
  expect(declaration.initializer && ts.isCallExpression(declaration.initializer)).toBe(true);
  const factory = (declaration.initializer as ts.CallExpression).arguments[0];
  expect(factory && (ts.isArrowFunction(factory) || ts.isFunctionExpression(factory))).toBe(true);
  const body = (factory as ts.ArrowFunction | ts.FunctionExpression).body;
  const unwrapped = ts.isExpression(body) ? unwrapExpression(body) : body;
  expect(ts.isObjectLiteralExpression(unwrapped)).toBe(true);
  return unwrapped as ts.ObjectLiteralExpression;
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

function propertyInitializer(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression {
  const property = directProperty(object, name);
  expect(ts.isPropertyAssignment(property), `${name} must remain an explicit property`).toBe(true);
  return (property as ts.PropertyAssignment).initializer;
}

function groupedHookShape(name: keyof typeof GROUPED_HOOK_SHAPES): string[] {
  const ownerFiles = [VIEWER_STORE_FILE, FUTURE_UI_STORE_FILE].filter(existsRelative);
  const declarations = ownerFiles.flatMap((path) => {
    const source = parse(path);
    return descendants(
      source,
      (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name,
    ).map((declaration) => ({ source, declaration }));
  });
  expect(declarations, `${name} has one compatibility owner`).toHaveLength(1);
  const { source, declaration } = declarations[0];
  const expectedFirst = GROUPED_HOOK_SHAPES[name][0];
  const selectorObjects = descendants(declaration, ts.isObjectLiteralExpression).filter((object) =>
    directObjectKeys(object).includes(expectedFirst),
  );
  expect(selectorObjects, `${name} selector object`).toHaveLength(1);
  return directObjectKeys(selectorObjects[0]);
}

function existsRelative(relativePath: string): boolean {
  return existsSync(join(process.cwd(), relativePath));
}

function importedCallCount(
  source: ts.SourceFile,
  modules: readonly string[],
  importedName: string,
): number {
  const seeds = modules.flatMap((moduleName) =>
    [...importedLocalNames(source, moduleName, importedName)],
  );
  const aliases = identifierAliases(source, seeds);
  return descendants(source, ts.isCallExpression).filter((call) => {
    const expression = unwrapExpression(call.expression);
    return ts.isIdentifier(expression) && aliases.has(expression.text);
  }).length;
}

function importedCallTopology(importedName: string): Record<string, number> {
  const modules = [VIEWER_OWNER.module, UI_OWNER.module];
  return Object.fromEntries(
    productionSourceFiles
      // Import/module prefilter avoids parsing the full tree for three small compatibility hooks.
      .filter((path) => modules.some((moduleName) => textOf(path).includes(moduleName)))
      .map((path) => [path, importedCallCount(parse(path), modules, importedName)] as const)
      .filter(([, count]) => count > 0),
  );
}

function rawSelectorMembers(
  source: ts.SourceFile,
  owner: { readonly module: string; readonly exportName: string },
): string[] {
  const hooks = identifierAliases(source, importedLocalNames(source, owner.module, owner.exportName));
  const constants = staticStringConstants(source);
  const output: string[] = [];
  for (const call of descendants(source, ts.isCallExpression)) {
    const callee = unwrapExpression(call.expression);
    if (!ts.isIdentifier(callee) || !hooks.has(callee.text)) continue;
    const selector = selectorFunction(call.arguments[0]);
    if (!selector || selector.parameters.length !== 1 || !ts.isIdentifier(selector.parameters[0].name)) continue;
    const stateAliases = identifierAliases(selector.body, [selector.parameters[0].name.text]);
    const selected = [
      ...descendants(selector.body, ts.isPropertyAccessExpression)
        .filter((access) => {
          const receiver = unwrapExpression(access.expression);
          return ts.isIdentifier(receiver) && stateAliases.has(receiver.text);
        })
        .map((access) => access.name.text),
      ...descendants(selector.body, ts.isElementAccessExpression)
        .filter((access) => {
          const receiver = unwrapExpression(access.expression);
          return ts.isIdentifier(receiver) && stateAliases.has(receiver.text);
        })
        .map((access) => elementAccessName(access, constants))
        .filter((name): name is string => name !== null),
    ];
    // Every raw AnnotationOverlay subscription is intentionally primitive. If a future selector
    // returns a whole slice/object, this cardinality assertion fails before render regressions land.
    expect(selected, `raw selector at ${call.getStart(source)}`).toHaveLength(1);
    output.push(selected[0]);
  }
  return output;
}

describe("P2.3 U0 pure UI ownership contract", () => {
  const viewerSource = parse(VIEWER_STORE_FILE);
  const viewerState = findViewerState(viewerSource);
  const storeObject = findStoreObject(viewerSource, "useViewerStore");
  const interfaceKeys = viewerState.members
    .map((member) => ("name" in member ? staticName(member.name) : null))
    .filter((name): name is string => name !== null);

  it("enumerates exactly 60 pure UI fields with their defaults and companion actions", () => {
    const entries = Object.entries(PURE_UI_CONTRACT);
    expect(entries).toHaveLength(60);
    expect(new Set(entries.map(([field]) => field)).size).toBe(60);

    for (const [field, contract] of entries) {
      expect(interfaceKeys, `${field} interface owner`).toContain(field);
      const initializer = propertyInitializer(storeObject, field);
      expect(compact(initializer, viewerSource), `${field} PRE default`).toBe(contract.default);
      for (const action of contract.actions) {
        expect(interfaceKeys, `${field} companion ${action}`).toContain(action);
        expect(() => directProperty(storeObject, action)).not.toThrow();
      }
    }
  });

  it("records the server/core/tool/parse/draft fields excluded from uiStore", () => {
    const pureFields = new Set(Object.keys(PURE_UI_CONTRACT));
    const exclusions = Object.values(UI_BOUNDARY_EXCLUSIONS).flat();
    expect(new Set(exclusions).size).toBe(exclusions.length);
    for (const field of exclusions) {
      expect(pureFields, `${field} must not enter pure UI ledger`).not.toContain(field);
      expect(interfaceKeys, `${field} boundary still exists pre-carve`).toContain(field);
      expect(() => directProperty(storeObject, field)).not.toThrow();
    }
  });

  it("pins compound panel/tool commands until neutral coordination is extracted", () => {
    const interfaceMembers = new Set(interfaceKeys);
    for (const [command, expected] of Object.entries(COMPOUND_COMMAND_MEMBERS)) {
      const initializer = propertyInitializer(storeObject, command);
      const referenced = new Set<string>();
      for (const object of descendants(initializer, ts.isObjectLiteralExpression)) {
        for (const name of directObjectKeys(object)) {
          if (interfaceMembers.has(name)) referenced.add(name);
        }
      }
      for (const access of descendants(initializer, ts.isPropertyAccessExpression)) {
        if (interfaceMembers.has(access.name.text)) referenced.add(access.name.text);
      }
      expect([...referenced].sort(), command).toEqual([...expected].sort());
    }
  });
});

describe("P2.3 U0 subscription topology", () => {
  it("pins the broad compatibility hook shapes and their current call graph", () => {
    for (const name of Object.keys(GROUPED_HOOK_SHAPES) as Array<keyof typeof GROUPED_HOOK_SHAPES>) {
      expect(groupedHookShape(name), `${name} shape`).toEqual(GROUPED_HOOK_SHAPES[name]);
      expect(importedCallTopology(name), `${name} callers`).toEqual(GROUPED_HOOK_CALL_TOPOLOGY[name]);
    }
  });

  it("keeps AnnotationOverlay UI subscriptions primitive and avoids broad UI facades", () => {
    const source = parse(ANNOTATION_OVERLAY);
    const activeMembers = rawSelectorMembers(source, ACTIVE_UI_OWNER)
      .filter((member) => PURE_UI_MEMBER_NAMES.has(member))
      .sort();
    expect(activeMembers).toEqual([...HOT_OVERLAY_UI_SELECTORS].sort());

    for (const hook of ["usePanels", "useDetection", "useSelection"]) {
      expect(importedCallCount(source, [VIEWER_OWNER.module, UI_OWNER.module], hook), hook).toBe(0);
    }

    const ownerFiles = [VIEWER_STORE_FILE, FUTURE_UI_STORE_FILE].filter(existsRelative);
    for (const path of ownerFiles) {
      const ownerSource = parse(path);
      for (const declaration of descendants(ownerSource, ts.isVariableDeclaration)) {
        if (!ts.isIdentifier(declaration.name) || !declaration.name.text.startsWith("use")) continue;
        if (["useViewerStore", "useUiStore"].includes(declaration.name.text)) continue;
        for (const object of descendants(declaration, ts.isObjectLiteralExpression)) {
          const selectedUiFields = directObjectKeys(object)
            .filter((name) => name in PURE_UI_CONTRACT);
          expect(
            selectedUiFields.length,
            `${path}:${declaration.name.text} must not become a whole-UI compatibility hook`,
          ).toBeLessThanOrEqual(GROUPED_HOOK_SHAPES.usePanels.length);
        }
      }
    }
  });
});

describe("P2.3 U0 flip-ready ownership escape oracle", () => {
  const uiMembers = PURE_UI_MEMBER_NAMES;

  it("self-calibrates aliases, casts, destructuring, useShallow, and computed keys", () => {
    const fixture = ts.createSourceFile(
      "ui-owner-escape-fixture.tsx",
      `
        import { useViewerStore as importedHook } from "@/stores/viewerStore";
        const hookAlias = importedHook as any;
        const computed = "activeYoloTagId";
        hookAlias(({ searchQuery }: any) => searchQuery);
        hookAlias(useShallow((state: any) => {
          const selectorAlias = state as any;
          return selectorAlias[computed];
        }));
        const getter = importedHook["getState"];
        const { setSearch } = getter() as any;
        const snapshot = getter() as any;
        snapshot["showTakeoffPanel"];
        const setter = importedHook.setState;
        setter({ [computed]: "tag-1" });
        (hookAlias() as any).toggleTips;
      `,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const accesses = storeMemberAccesses(fixture, VIEWER_OWNER, uiMembers)
      .map(({ kind, member }) => `${kind}:${member}`);
    expect(accesses).toEqual(expect.arrayContaining([
      "selector-parameter:searchQuery",
      "selector-element:activeYoloTagId",
      "getState-destructure:setSearch",
      "getState-alias-element:showTakeoffPanel",
      "setState:activeYoloTagId",
      "hook-direct:toggleTips",
    ]));
  });

  it("keeps every current access on the PRE owner and the future owner empty", () => {
    const plausible = productionSourceFiles.filter((path) => {
      const text = textOf(path);
      return text.includes(VIEWER_OWNER.module) || text.includes(UI_OWNER.module);
    });
    const active = plausible.flatMap((path) =>
      storeMemberAccesses(parse(path), ACTIVE_UI_OWNER, uiMembers)
        .map((access) => `${path}:${access.kind}:${access.member}`),
    );
    const inactive = plausible.flatMap((path) =>
      storeMemberAccesses(parse(path), INACTIVE_UI_OWNER, uiMembers)
        .map((access) => `${path}:${access.kind}:${access.member}`),
    );
    expect(active.length, "PRE ui members must have real production consumers").toBeGreaterThan(100);
    expect(inactive).toEqual([]);
  }, 15_000);

  it("keeps viewerStore and the future uiStore as dependency-free leaf stores", () => {
    for (const path of [VIEWER_STORE_FILE, FUTURE_UI_STORE_FILE].filter(existsRelative)) {
      const source = parse(path);
      const imports = source.statements
        .filter(ts.isImportDeclaration)
        .map((statement) => statement.moduleSpecifier)
        .filter(ts.isStringLiteral)
        .map((module) => module.text);
      expect(imports, path).toEqual(expect.arrayContaining(["zustand"]));
      for (const moduleName of imports) {
        expect(
          ["zustand", "zustand/react/shallow", "@/types"],
          `${path} leaf import ${moduleName}`,
        ).toContain(moduleName);
      }
    }
  });
});

describe("P2.3 U0 yolo browse cross-store command", () => {
  it("keeps navigateYoloTag solely in the Query facade with its two mixed publications", () => {
    const definitions = productionSourceFiles
      .filter((path) => textOf(path).includes("navigateYoloTag"))
      .flatMap((path) =>
        descendants(
          parse(path),
          (node): node is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(node) && node.name?.text === "navigateYoloTag",
        ).map((definition) => ({ path, definition })),
      );
    expect(definitions.map(({ path }) => path)).toEqual([YOLO_FACADE]);

    const source = parse(YOLO_FACADE);
    const body = definitions[0].definition.body;
    expect(body).toBeTruthy();
    const constants = staticStringConstants(source);
    const storeHooks = identifierAliases(
      source,
      importedLocalNames(source, VIEWER_OWNER.module, VIEWER_OWNER.exportName),
    );
    const setters = methodAliases(source, storeHooks, "setState", constants);
    const publications = descendants(body!, ts.isCallExpression)
      .filter((call) => isMethodCall(call, storeHooks, setters, "setState", constants))
      .map((call) => call.arguments[0])
      .filter((argument): argument is ts.ObjectLiteralExpression => ts.isObjectLiteralExpression(argument))
      .map((object) => directObjectKeys(object, constants));

    expect(publications).toEqual([
      ["tagBrowseId", "tagBrowseIndex", "activeYoloTagId", "llmHighlight"],
      ["tagBrowseId", "tagBrowseIndex", "activeYoloTagId", "pageNumber", "llmHighlight"],
    ]);
    const uiFields = new Set(Object.keys(PURE_UI_CONTRACT));
    expect(publications.flat().filter((name) => !uiFields.has(name))).toEqual(["pageNumber"]);
  });
});
