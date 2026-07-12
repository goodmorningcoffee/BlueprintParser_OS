// @vitest-environment node
// [refactor jul11 P2.4 C2] Exact client-I/O topology after atomic save-tail convergence.
//
// This is deliberately an AST/provenance contract rather than a text-count test. A duplicate dead
// call in one handler must not compensate for a missing live call in another handler, imported
// aliases/namespaces must still resolve to their defining module, and endpoint strings must occur
// as the transport's first argument. Runtime tests own request ordering and cache behavior; this
// file owns the exact semantic caller roster.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const CLIENT_PERSIST_MODULE = "@/lib/client-persist";
const CLIENT_PERSIST_FILE = "src/lib/client-persist.ts";
const PARSED_REGIONS_MODULE = "@/queries/parsedRegions";
const PARSED_REGIONS_FILE = "src/queries/parsedRegions.ts";
const MAP_TRANSPORT_MODULE = "@/lib/client-map-tags";
const MAP_TRANSPORT_FILE = "src/lib/client-map-tags.ts";
const SPATIAL_TARGET_FILE = "src/lib/csi-spatial-refresh-target.ts";
const PROMOTE_ENDPOINT = "/api/regions/promote";
const MAP_TAGS_ENDPOINT = "/api/projects/${}/map-tags-batch";

type ClientIoPhase = "F1" | "C1" | "C2" | "C3";
// C3 atomically replaces all six raw map fetches. Both migrations are now converged; never accept
// a mixed old/new roster for either boundary.
const CLIENT_IO_PHASE: ClientIoPhase = "C3";

type ImportedProvenance = {
  kind: "imported";
  module: string;
  imported: string;
};

type NamespaceProvenance = {
  kind: "namespace";
  module: string;
};

type GlobalProvenance = {
  kind: "global";
  imported: "fetch";
};

type Provenance = ImportedProvenance | NamespaceProvenance | GlobalProvenance;

type StaticEndpoint = {
  pattern: string;
  interpolations: string[];
};

type CallRecord = {
  file: string;
  node: ts.CallExpression;
  owner: string;
  provenance: Provenance | null;
  endpoint: StaticEndpoint | null;
  calleeText: string;
};

type Site = {
  file: string;
  owner: string;
  transport: string;
};

type MapSite = Site & {
  projectExpression: string;
};

const EXPECTED_SAVE_COMMAND_SITES: Site[] = [
  {
    file: "src/components/viewer/KeynoteItem.tsx",
    owner: "saveName",
    transport: "@/queries/parsedRegions.saveParsedRegion",
  },
  {
    file: "src/components/viewer/KeynotePanel.tsx",
    owner: "parseFromGuidedGrid",
    transport: "@/queries/parsedRegions.saveParsedRegion",
  },
  {
    file: "src/components/viewer/KeynotePanel.tsx",
    owner: "saveKeynoteToIntelligence",
    transport: "@/queries/parsedRegions.saveParsedRegion",
  },
  {
    file: "src/components/viewer/NotesClassifier.tsx",
    owner: "handleAccept",
    transport: "@/queries/parsedRegions.saveParsedRegion",
  },
  {
    file: "src/components/viewer/NotesParser.tsx",
    owner: "persistPreviewGrid",
    transport: "@/queries/parsedRegions.saveParsedRegion",
  },
  {
    file: "src/components/viewer/NotesParser.tsx",
    owner: "saveFromParagraphBatch",
    transport: "@/queries/parsedRegions.saveParsedRegion",
  },
  {
    file: "src/components/viewer/ParsedTableItem.tsx",
    owner: "persistRegionEdit",
    transport: "@/queries/parsedRegions.saveParsedRegion",
  },
  {
    file: "src/components/viewer/SpecClassifier.tsx",
    owner: "handleAccept",
    transport: "@/queries/parsedRegions.saveParsedRegion",
  },
  {
    file: "src/components/viewer/SpecParser.tsx",
    owner: "persistPreview",
    transport: "@/queries/parsedRegions.saveParsedRegion",
  },
  {
    file: "src/components/viewer/SpecParser.tsx",
    owner: "saveFromBatch",
    transport: "@/queries/parsedRegions.saveParsedRegion",
  },
  {
    file: "src/components/viewer/TableCompareModal.tsx",
    owner: "handleDone",
    transport: "@/queries/parsedRegions.saveParsedRegion",
  },
  {
    file: "src/components/viewer/TableParsePanel.tsx",
    owner: "detectCsiAndPersist",
    transport: "@/queries/parsedRegions.saveParsedRegion",
  },
];

const EXPECTED_PARSED_REGION_IMPORT_FILES = [
  "src/components/viewer/KeynoteItem.tsx",
  "src/components/viewer/KeynotePanel.tsx",
  "src/components/viewer/NotesClassifier.tsx",
  "src/components/viewer/NotesParser.tsx",
  "src/components/viewer/ParsedTableItem.tsx",
  "src/components/viewer/SpecClassifier.tsx",
  "src/components/viewer/SpecParser.tsx",
  "src/components/viewer/TableCompareModal.tsx",
  "src/components/viewer/TableParsePanel.tsx",
] as const;

type CommandArguments = {
  queryClient: string;
  target: Record<string, string>;
  promotion: Record<string, string>;
};

const EXPECTED_COMMAND_ARGUMENTS: Record<string, CommandArguments> = {
  "src/components/viewer/KeynoteItem.tsx:saveName": {
    queryClient: "queryClient",
    target: { publicId: "publicId", isDemo: "session.isDemo", pageNumber: "keynote.pageNumber" },
    promotion: {
      via: '"parser"', type: '"keynote"', regionId: "matchedId", bboxMinMax: "matchedBbox",
      data: "matchedData", category: "trimmed", csiTags: "matchedCsiTags",
    },
  },
  "src/components/viewer/KeynotePanel.tsx:parseFromGuidedGrid": {
    queryClient: "queryClient",
    target: {
      publicId: "target.publicId",
      isDemo: "target.isDemo",
      pageNumber: "target.pageNumber",
    },
    promotion: {
      via: '"parser"', type: '"keynote"', regionId: "regionId", bboxMinMax: "target.bbox",
      data: "data", category: '"keynote-table"', csiTags: "csiTags",
    },
  },
  "src/components/viewer/KeynotePanel.tsx:saveKeynoteToIntelligence": {
    queryClient: "queryClient",
    target: {
      publicId: "target.publicId",
      isDemo: "target.isDemo",
      pageNumber: "target.pageNumber",
    },
    promotion: {
      via: '"parser"', type: '"keynote"', regionId: "regionId", bboxMinMax: "bbox",
      data: "data", category: '"keynote-table"', csiTags: "csiTags",
    },
  },
  "src/components/viewer/NotesClassifier.tsx:handleAccept": {
    queryClient: "queryClient",
    target: { publicId: "publicId", isDemo: "isDemo", pageNumber: "pageNumber" },
    promotion: {
      via: '"classifier"', type: '"notes"', sourceTextRegionId: "tr.id",
    },
  },
  "src/components/viewer/NotesParser.tsx:persistPreviewGrid": {
    queryClient: "queryClient",
    target: {
      publicId: "target.publicId", isDemo: "target.isDemo", pageNumber: "target.pageNumber",
    },
    promotion: {
      via: '"parser"', type: '"notes"', regionId: "regionIdFor(target.pageNumber,target.region)",
      bboxMinMax: "target.region", data: "data", category: '"notes"', csiTags: "input.csiTags??[]",
    },
  },
  "src/components/viewer/NotesParser.tsx:saveFromParagraphBatch": {
    queryClient: "queryClient",
    target: {
      publicId: "target.publicId", isDemo: "target.isDemo", pageNumber: "target.pageNumber",
    },
    promotion: {
      via: '"parser"', type: '"notes"', regionId: "regionIdFor(target.pageNumber,unionBbox)",
      bboxMinMax: "unionBbox", data: "data", category: '"notes"',
    },
  },
  "src/components/viewer/ParsedTableItem.tsx:persistRegionEdit": {
    queryClient: "queryClient",
    target: { publicId: "publicId", isDemo: "isDemo", pageNumber: "table.pageNum" },
    promotion: {
      via: '"parser"', type: 'table.region.type==="keynote"?"keynote":"schedule"',
      regionId: "table.region.id", bboxMinMax: "bbox", data: "nextData", category: "category",
      csiTags: "table.region.csiTags??[]",
    },
  },
  "src/components/viewer/SpecClassifier.tsx:handleAccept": {
    queryClient: "queryClient",
    target: { publicId: "publicId", isDemo: "isDemo", pageNumber: "pageNumber" },
    promotion: {
      via: '"classifier"', type: '"spec"', sourceTextRegionId: "tr.id",
    },
  },
  "src/components/viewer/SpecParser.tsx:persistPreview": {
    queryClient: "queryClient",
    target: {
      publicId: "target.publicId", isDemo: "target.isDemo", pageNumber: "target.pageNumber",
    },
    promotion: {
      via: '"parser"', type: '"spec"', regionId: "regionIdFor(target.pageNumber,target.region)",
      bboxMinMax: "target.region", data: "data", category: '"spec-dense-columns"',
      csiTags: "input.csiTags??[]",
    },
  },
  "src/components/viewer/SpecParser.tsx:saveFromBatch": {
    queryClient: "queryClient",
    target: {
      publicId: "target.publicId", isDemo: "target.isDemo", pageNumber: "target.pageNumber",
    },
    promotion: {
      via: '"parser"', type: '"spec"', regionId: "regionIdFor(target.pageNumber,unionBbox)",
      bboxMinMax: "unionBbox", data: "data", category: '"spec-dense-columns"',
    },
  },
  "src/components/viewer/TableCompareModal.tsx:handleDone": {
    queryClient: "queryClient",
    target: { publicId: "publicId", isDemo: "isDemo", pageNumber: "pageNumber" },
    promotion: {
      via: '"parser"', type: "matchedType", regionId: "matchedId", bboxMinMax: "matchedBbox",
      data: "edited?.data??{}", csiTags: "matchedCsiTags",
    },
  },
  "src/components/viewer/TableParsePanel.tsx:detectCsiAndPersist": {
    queryClient: "queryClient",
    target: {
      publicId: "target.publicId", isDemo: "target.isDemo", pageNumber: "target.pageNumber",
    },
    promotion: {
      via: '"parser"', type: '"schedule"',
      regionId: "regionIdFor(target.pageNumber,target.bbox)", bboxMinMax: "target.bbox",
      data: "object:headers,rows,tagColumn,tableName,rowCount,columnCount,...,...",
      category: "commitGrid.tableName||undefined", csiTags: "commitGrid.csiTags||[]",
    },
  },
};

const EXPECTED_COMMAND_HELPER_SITE: Site = {
  file: PARSED_REGIONS_FILE,
  owner: "saveParsedRegion",
  transport: "@/lib/client-persist.promoteParsedRegion",
};

const EXPECTED_MAP_TRANSPORT_SITES: MapSite[] = [
  {
    file: "src/components/viewer/AnnotationOverlay.tsx",
    owner: "handleMouseDown",
    transport: "@/lib/client-map-tags.requestMapTagsBatch",
    projectExpression: "pid",
  },
  {
    file: "src/components/viewer/AutoQtoTab.tsx",
    owner: "MappingStep",
    transport: "@/lib/client-map-tags.requestMapTagsBatch",
    projectExpression: "input.publicId",
  },
  {
    file: "src/components/viewer/KeynoteItem.tsx",
    owner: "KeynoteItem:onClick[Run Mapping]",
    transport: "@/lib/client-map-tags.requestMapTagsBatch",
    projectExpression: "identityPublicId",
  },
  {
    file: "src/components/viewer/KeynotePanel.tsx",
    owner: "mapKeynoteKeysToYoloTags",
    transport: "@/lib/client-map-tags.requestMapTagsBatch",
    projectExpression: "publicId",
  },
  {
    file: "src/components/viewer/ParsedTableItem.tsx",
    owner: "ParsedTableItem:onClick[Run Mapping]",
    transport: "@/lib/client-map-tags.requestMapTagsBatch",
    projectExpression: "publicId",
  },
  {
    file: "src/components/viewer/TableParsePanel.tsx",
    owner: "handleMapTags",
    transport: "@/lib/client-map-tags.requestMapTagsBatch",
    projectExpression: "target.publicId",
  },
];

const EXPECTED_LOW_LEVEL_MAP_TRANSPORT_SITE: MapSite = {
  file: MAP_TRANSPORT_FILE,
  owner: "requestMapTagsBatch",
  transport: "global.fetch",
  projectExpression: "publicId",
};

const EXPECTED_MAP_TRANSPORT_IMPORT_FILES = [
  "src/components/viewer/AnnotationOverlay.tsx",
  "src/components/viewer/AutoQtoTab.tsx",
  "src/components/viewer/KeynoteItem.tsx",
  "src/components/viewer/KeynotePanel.tsx",
  "src/components/viewer/ParsedTableItem.tsx",
  "src/components/viewer/TableParsePanel.tsx",
] as const;

type MapTransportArguments = {
  project: string;
  request: Record<string, string>;
  options: Record<string, string>;
  awaited: boolean;
};

const EXPECTED_MAP_TRANSPORT_ARGUMENTS: Record<string, MapTransportArguments> = {
  "src/components/viewer/AnnotationOverlay.tsx:handleMouseDown": {
    project: "pid",
    request: {
      action: '"scanClass"', yoloClass: "yoloClass", yoloModel: "yoloModel",
    },
    options: { signal: "controller.signal" },
    awaited: false,
  },
  "src/components/viewer/AutoQtoTab.tsx:MappingStep": {
    project: "input.publicId",
    request: { __expression: "input.request" },
    options: { signal: "controller.signal" },
    awaited: false,
  },
  "src/components/viewer/KeynoteItem.tsx:KeynoteItem:onClick[Run Mapping]": {
    project: "identityPublicId",
    request: {
      tags: "tags",
      yoloClass: 'mapTagType==="yolo"?mapYoloClass?.className:undefined',
      yoloModel: 'mapTagType==="yolo"?mapYoloClass?.model:undefined',
      itemType: 'mapTagType==="yolo"?"yolo-with-inner-text":"text-only"',
      strictnessMode: "mapStrictness",
      drawingNumberPrefixes: "mapPrefixes",
    },
    options: {},
    awaited: true,
  },
  "src/components/viewer/KeynotePanel.tsx:mapKeynoteKeysToYoloTags": {
    project: "publicId",
    request: {
      tags: "uniqueKeys", yoloClass: "yoloClass||undefined",
      yoloModel: "yoloModel||undefined", itemType: "itemType",
      selectedPages: "[pageNumber]",
    },
    options: {},
    awaited: true,
  },
  "src/components/viewer/ParsedTableItem.tsx:ParsedTableItem:onClick[Run Mapping]": {
    project: "publicId",
    request: {
      tags: "tags",
      yoloClass: 'mapTagType==="yolo"?mapYoloClass?.className:undefined',
      yoloModel: 'mapTagType==="yolo"?mapYoloClass?.model:undefined',
      itemType: 'mapTagType==="yolo"?"yolo-with-inner-text":"text-only"',
      strictnessMode: "mapStrictness",
      drawingNumberPrefixes: "mapPrefixes",
    },
    options: {},
    awaited: true,
  },
  "src/components/viewer/TableParsePanel.tsx:handleMapTags": {
    project: "target.publicId",
    request: {
      tags: "uniqueTags", yoloClass: "target.tagYoloClass?.className||undefined",
      yoloModel: "target.tagYoloClass?.model||undefined", itemType: "itemType",
      strictnessMode: "target.mapTagsStrictness",
      drawingNumberPrefixes: "target.drawingNumberPrefixes",
    },
    options: { signal: "controller.signal" },
    awaited: true,
  },
};

const sourceTextCache = new Map<string, string>();
const sourceCache = new Map<string, ts.SourceFile>();

function productionFiles(directory = "src"): string[] {
  const output: string[] = [];
  const visit = (relative: string): void => {
    for (const entry of readdirSync(join(process.cwd(), relative), { withFileTypes: true })) {
      const child = join(relative, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") visit(child);
      } else if (
        /\.(ts|tsx)$/.test(entry.name) &&
        !entry.name.includes(".test.") &&
        !entry.name.includes(".spec.") &&
        !entry.name.endsWith(".d.ts")
      ) {
        output.push(child);
      }
    }
  };
  visit(directory);
  return output.sort();
}

function resolvesToCandidate(
  importer: string,
  specifier: string,
  moduleName: string,
  file: string,
): boolean {
  const unresolved = specifier === moduleName
    ? file
    : specifier.startsWith("@/")
      ? `src/${specifier.slice(2)}`
      : specifier.startsWith(".")
        ? join(dirname(importer), specifier)
        : "";
  const withoutExtension = (value: string) => normalize(value).replace(/\.(?:ts|tsx)$/, "");
  return withoutExtension(unresolved) === withoutExtension(file);
}

function candidateLoadKinds(
  path: string,
  moduleName: string,
  file: string,
  source = parse(path),
): string[] {
  const loads: string[] = [];
  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      resolvesToCandidate(path, statement.moduleSpecifier.text, moduleName, file)
    ) loads.push("import");
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      resolvesToCandidate(path, statement.moduleSpecifier.text, moduleName, file)
    ) loads.push("re-export");
  }
  for (const call of descendants(source, ts.isCallExpression)) {
    const specifier = call.arguments[0];
    if (!specifier || !ts.isStringLiteralLike(specifier)) continue;
    if (!resolvesToCandidate(path, specifier.text, moduleName, file)) continue;
    const callee = unwrap(call.expression);
    if (callee.kind === ts.SyntaxKind.ImportKeyword) loads.push("dynamic-import");
    if (ts.isIdentifier(callee) && callee.text === "require") loads.push("require");
  }
  for (const importType of descendants(source, ts.isImportTypeNode)) {
    if (
      ts.isLiteralTypeNode(importType.argument) &&
      ts.isStringLiteral(importType.argument.literal) &&
      resolvesToCandidate(path, importType.argument.literal.text, moduleName, file)
    ) loads.push("import-type");
  }
  return loads;
}

function textOf(file: string): string {
  const cached = sourceTextCache.get(file);
  if (cached !== undefined) return cached;
  const text = readFileSync(join(process.cwd(), file), "utf8");
  sourceTextCache.set(file, text);
  return text;
}

function parse(file: string): ts.SourceFile {
  const cached = sourceCache.get(file);
  if (cached) return cached;
  const source = ts.createSourceFile(
    file,
    textOf(file),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  sourceCache.set(file, source);
  return source;
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
  while (true) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

function compactExpression(expression: ts.Expression): string {
  const current = unwrap(expression);
  if (ts.isObjectLiteralExpression(current)) {
    const keys = current.properties.map((property) => {
      if (ts.isSpreadAssignment(property)) return "...";
      return property.name?.getText(current.getSourceFile()) ?? "unknown";
    });
    return `object:${keys.join(",")}`;
  }
  return current.getText(current.getSourceFile()).replace(/\s+/g, "");
}

function objectArgumentContract(expression: ts.Expression | undefined): Record<string, string> {
  if (!expression) return { __error: "missing" };
  const current = unwrap(expression);
  if (!ts.isObjectLiteralExpression(current)) {
    return { __error: `non-literal:${compactExpression(current)}` };
  }
  return Object.fromEntries(current.properties.map((property) => {
    if (ts.isShorthandPropertyAssignment(property)) {
      return [property.name.text, property.name.text];
    }
    if (ts.isPropertyAssignment(property)) {
      return [property.name.getText(current.getSourceFile()), compactExpression(property.initializer)];
    }
    return [`__unsupported_${property.pos}`, property.getText(current.getSourceFile())];
  }));
}

function expressionOrObjectContract(expression: ts.Expression | undefined): Record<string, string> {
  if (!expression) return {};
  const current = unwrap(expression);
  return ts.isObjectLiteralExpression(current)
    ? objectArgumentContract(current)
    : { __expression: compactExpression(current) };
}

function nearestCanPersistBranch(node: ts.Node): ts.IfStatement | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isIfStatement(current) &&
      compactExpression(current.expression).startsWith("canPersist(")
    ) return current;
    current = current.parent;
  }
  return null;
}

function isWithin(node: ts.Node, container: ts.Node | undefined): boolean {
  return !!container && container.pos <= node.pos && node.end <= container.end;
}

type LexicalBinding = {
  name: string;
  declaration: ts.Node;
  scope: ts.Node;
  provenance?: ImportedProvenance | NamespaceProvenance;
  initializer?: ts.Expression;
};

function bindingIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingIdentifiers(element.name),
  );
}

function nearestAncestor(
  node: ts.Node,
  predicate: (candidate: ts.Node) => boolean,
): ts.Node {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (predicate(current)) return current;
    current = current.parent;
  }
  throw new Error(`No lexical scope for ${node.kind}`);
}

function isBlockScope(node: ts.Node): boolean {
  return (
    ts.isBlock(node) ||
    ts.isCaseBlock(node) ||
    ts.isCatchClause(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isSourceFile(node)
  );
}

function isFunctionScope(node: ts.Node): boolean {
  return ts.isFunctionLike(node) || ts.isSourceFile(node);
}

function variableScope(declaration: ts.VariableDeclaration): ts.Node {
  if (ts.isCatchClause(declaration.parent)) return declaration.parent;
  const list = ts.isVariableDeclarationList(declaration.parent) ? declaration.parent : null;
  const blockScoped = !!list && (list.flags & ts.NodeFlags.BlockScoped) !== 0;
  return nearestAncestor(declaration, blockScoped ? isBlockScope : isFunctionScope);
}

function distanceToAncestor(node: ts.Node, ancestor: ts.Node): number | null {
  let distance = 0;
  let current: ts.Node | undefined = node;
  while (current) {
    if (current === ancestor) return distance;
    current = current.parent;
    distance += 1;
  }
  return null;
}

class SourceBindings {
  readonly bindings: LexicalBinding[] = [];

  constructor(readonly source: ts.SourceFile) {
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
        continue;
      }
      const moduleName = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (!clause) continue;
      if (clause.name) {
        this.bindings.push({
          name: clause.name.text,
          declaration: clause.name,
          scope: source,
          provenance: { kind: "imported", module: moduleName, imported: "default" },
        });
      }
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          this.bindings.push({
            name: element.name.text,
            declaration: element.name,
            scope: source,
            provenance: {
              kind: "imported",
              module: moduleName,
              imported: element.propertyName?.text ?? element.name.text,
            },
          });
        }
      } else if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        this.bindings.push({
          name: clause.namedBindings.name.text,
          declaration: clause.namedBindings.name,
          scope: source,
          provenance: { kind: "namespace", module: moduleName },
        });
      }
    }

    for (const declaration of descendants(
      source,
      (node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node),
    )) {
      for (const identifier of bindingIdentifiers(declaration.name)) {
        this.bindings.push({
          name: identifier.text,
          declaration: identifier,
          scope: variableScope(declaration),
          initializer: ts.isIdentifier(declaration.name) ? declaration.initializer : undefined,
        });
      }
    }
    for (const parameter of descendants(
      source,
      (node): node is ts.ParameterDeclaration => ts.isParameter(node),
    )) {
      const scope = nearestAncestor(parameter, (candidate) => ts.isFunctionLike(candidate));
      for (const identifier of bindingIdentifiers(parameter.name)) {
        this.bindings.push({
          name: identifier.text,
          declaration: identifier,
          scope,
        });
      }
    }
    for (const declaration of descendants(
      source,
      (node): node is ts.FunctionDeclaration | ts.ClassDeclaration =>
        ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node),
    )) {
      if (declaration.name) {
        this.bindings.push({
          name: declaration.name.text,
          declaration: declaration.name,
          scope: nearestAncestor(declaration, isBlockScope),
        });
      }
    }
    for (const expression of descendants(
      source,
      (node): node is ts.FunctionExpression => ts.isFunctionExpression(node) && !!node.name,
    )) {
      this.bindings.push({
        name: expression.name!.text,
        declaration: expression.name!,
        scope: expression,
      });
    }
  }

  visibleBinding(name: string, usage: ts.Node): LexicalBinding | null {
    const candidates = this.bindings
      .map((binding) => ({
        binding,
        distance: distanceToAncestor(usage, binding.scope),
      }))
      .filter((entry): entry is { binding: LexicalBinding; distance: number } =>
        entry.binding.name === name && entry.distance !== null,
      )
      .sort((left, right) =>
        left.distance - right.distance ||
        right.binding.declaration.getStart(this.source) -
          left.binding.declaration.getStart(this.source),
      );
    return candidates[0]?.binding ?? null;
  }

  resolve(expression: ts.Expression, seen = new Set<ts.Node>()): Provenance | null {
    const current = unwrap(expression);
    if (ts.isIdentifier(current)) {
      const binding = this.visibleBinding(current.text, current);
      if (!binding) {
        return current.text === "fetch" ? { kind: "global", imported: "fetch" } : null;
      }
      if (binding.provenance) return binding.provenance;
      if (binding.initializer && !seen.has(binding.declaration)) {
        return this.resolve(
          binding.initializer,
          new Set(seen).add(binding.declaration),
        );
      }
      return null;
    }

    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      const property = ts.isPropertyAccessExpression(current)
        ? current.name.text
        : current.argumentExpression &&
            (ts.isStringLiteral(current.argumentExpression) ||
              ts.isNoSubstitutionTemplateLiteral(current.argumentExpression))
          ? current.argumentExpression.text
          : null;
      if (!property) return null;
      const base = unwrap(current.expression);
      if (
        ts.isIdentifier(base) &&
        (base.text === "globalThis" || base.text === "window") &&
        property === "fetch" &&
        !this.visibleBinding(base.text, base)
      ) {
        return { kind: "global", imported: "fetch" };
      }
      const resolvedBase = this.resolve(base, seen);
      if (resolvedBase?.kind === "namespace") {
        return {
          kind: "imported",
          module: resolvedBase.module,
          imported: property,
        };
      }
    }
    return null;
  }

  staticEndpoint(expression: ts.Expression, seen = new Set<ts.Node>()): StaticEndpoint | null {
    const current = unwrap(expression);
    if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
      return { pattern: current.text, interpolations: [] };
    }
    if (ts.isTemplateExpression(current)) {
      return {
        pattern: current.head.text + current.templateSpans
          .map((span) => "${}" + span.literal.text)
          .join(""),
        interpolations: current.templateSpans.map((span) =>
          span.expression.getText(this.source).replace(/\s+/g, ""),
        ),
      };
    }
    if (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const left = this.staticEndpoint(current.left, seen);
      const right = this.staticEndpoint(current.right, seen);
      return left === null || right === null
        ? null
        : {
            pattern: left.pattern + right.pattern,
            interpolations: [...left.interpolations, ...right.interpolations],
          };
    }
    if (ts.isIdentifier(current)) {
      const binding = this.visibleBinding(current.text, current);
      if (binding?.initializer && !seen.has(binding.declaration)) {
        return this.staticEndpoint(
          binding.initializer,
          new Set(seen).add(binding.declaration),
        );
      }
    }
    return null;
  }
}

function variableOwnerForFunction(node: ts.FunctionLikeDeclaration): string | null {
  let current: ts.Node = node;
  while (
    current.parent &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent))
  ) {
    current = current.parent;
  }
  if (current.parent && ts.isVariableDeclaration(current.parent)) {
    return ts.isIdentifier(current.parent.name) ? current.parent.name.text : null;
  }
  if (
    current.parent &&
    ts.isCallExpression(current.parent) &&
    current.parent.arguments.includes(current as ts.Expression)
  ) {
    const wrapper = unwrap(current.parent.expression);
    if (ts.isIdentifier(wrapper) && wrapper.text === "useCallback") {
      let call: ts.Node = current.parent;
      while (
        call.parent &&
        (ts.isParenthesizedExpression(call.parent) ||
          ts.isAsExpression(call.parent) ||
          ts.isSatisfiesExpression(call.parent))
      ) {
        call = call.parent;
      }
      if (call.parent && ts.isVariableDeclaration(call.parent) && ts.isIdentifier(call.parent.name)) {
        return call.parent.name.text;
      }
    }
  }
  return null;
}

function jsxHandlerOwner(call: ts.CallExpression): string | null {
  let current: ts.Node | undefined = call.parent;
  let attribute: ts.JsxAttribute | null = null;
  while (current) {
    if (ts.isJsxAttribute(current)) {
      attribute = current;
      break;
    }
    current = current.parent;
  }
  if (!attribute) return null;

  current = attribute.parent;
  let element: ts.JsxElement | null = null;
  while (current) {
    if (ts.isJsxElement(current)) {
      element = current;
      break;
    }
    current = current.parent;
  }
  if (!element) return null;

  const labels = element.children.flatMap((child) => {
    if (ts.isJsxText(child)) {
      const value = child.text.trim();
      return value ? [value] : [];
    }
    if (!ts.isJsxExpression(child) || !child.expression) return [];
    return descendants(
      child.expression,
      (node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
        ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node),
    ).map((literal) => literal.text);
  });
  const label = labels.includes("Run Mapping")
    ? "Run Mapping"
    : labels[0] ?? element.openingElement.tagName.getText();

  current = attribute.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) {
      return `${current.name.text}:${attribute.name.getText()}[${label}]`;
    }
    if (ts.isFunctionExpression(current) && current.name) {
      return `${current.name.text}:${attribute.name.getText()}[${label}]`;
    }
    current = current.parent;
  }
  return null;
}

function enclosingOwner(call: ts.CallExpression): string {
  const jsxOwner = jsxHandlerOwner(call);
  if (jsxOwner) return jsxOwner;
  let current: ts.Node | undefined = call.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isFunctionExpression(current) && current.name) return current.name.text;
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const variableOwner = variableOwnerForFunction(current);
      if (variableOwner) return variableOwner;
    }
    current = current.parent;
  }
  return "<module>";
}

function provenanceLabel(provenance: Provenance | null, fallback: string): string {
  if (provenance?.kind === "imported") {
    return `${provenance.module}.${provenance.imported}`;
  }
  if (provenance?.kind === "global") return `global.${provenance.imported}`;
  if (provenance?.kind === "namespace") return `${provenance.module}.*`;
  return `local:${fallback}`;
}

function candidateFile(file: string): boolean {
  const text = textOf(file);
  return (
    text.includes("client-persist") ||
    text.includes("regions/promote") ||
    text.includes("map-tags-batch") ||
    // Keep the future owners inside the scan when the strict phase expectations flip at C2/C3.
    text.includes("queries/parsedRegions") ||
    text.includes("client-map-tags") ||
    text.includes("requestMapTagsBatch")
  );
}

function callRecordsFromSource(file: string, source: ts.SourceFile): CallRecord[] {
  const bindings = new SourceBindings(source);
  return descendants(
    source,
    (node): node is ts.CallExpression => ts.isCallExpression(node),
  ).map((node) => ({
    file,
    node,
    owner: enclosingOwner(node),
    provenance: bindings.resolve(node.expression),
    endpoint: node.arguments[0] ? bindings.staticEndpoint(node.arguments[0]) : null,
    calleeText: node.expression.getText(source),
  }));
}

function callRecords(file: string): CallRecord[] {
  return callRecordsFromSource(file, parse(file));
}

const allCalls = productionFiles()
  .filter(candidateFile)
  .flatMap(callRecords);

function isImported(
  record: CallRecord,
  module: string,
  imported: string,
): boolean {
  return (
    record.provenance?.kind === "imported" &&
    record.provenance.module === module &&
    record.provenance.imported === imported
  );
}

function site(record: CallRecord): Site {
  return {
    file: record.file,
    owner: record.owner,
    transport: provenanceLabel(record.provenance, record.calleeText),
  };
}

function sortedSites(records: CallRecord[]): Site[] {
  return records.map(site).sort((left, right) =>
    left.file.localeCompare(right.file) ||
    left.owner.localeCompare(right.owner) ||
    left.transport.localeCompare(right.transport),
  );
}

function mapSite(record: CallRecord): MapSite {
  return {
    ...site(record),
    projectExpression: isImported(record, MAP_TRANSPORT_MODULE, "requestMapTagsBatch") &&
      record.node.arguments[0]
      ? compactExpression(record.node.arguments[0])
      : record.endpoint?.interpolations.join(",") ?? "",
  };
}

function sortedMapSites(records: CallRecord[]): MapSite[] {
  return records.map(mapSite).sort((left, right) =>
    left.file.localeCompare(right.file) ||
    left.owner.localeCompare(right.owner) ||
    left.transport.localeCompare(right.transport) ||
    left.projectExpression.localeCompare(right.projectExpression),
  );
}

function fixtureRecords(sourceText: string): CallRecord[] {
  const file = "client-io-topology-self-calibration.ts";
  const source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  return callRecordsFromSource(file, source);
}

describe("P2.4 C3 parse client-I/O topology", () => {
  it("pins the atomic twelve-owner command roster and sole internal helper transport", () => {
    expect(CLIENT_IO_PHASE).toBe("C3");
    const helperCalls = allCalls.filter((record) =>
      isImported(record, CLIENT_PERSIST_MODULE, "promoteParsedRegion"),
    );
    expect(sortedSites(helperCalls.filter((record) => record.file !== PARSED_REGIONS_FILE)))
      .toEqual([]);
    expect(sortedSites(helperCalls.filter((record) => record.file === PARSED_REGIONS_FILE)))
      .toEqual([EXPECTED_COMMAND_HELPER_SITE]);

    const commandBorrowers = allCalls.filter((record) =>
      isImported(record, PARSED_REGIONS_MODULE, "saveParsedRegion"),
    );
    expect(sortedSites(commandBorrowers)).toEqual(EXPECTED_SAVE_COMMAND_SITES);
    expect(commandBorrowers.every((record) => ts.isAwaitExpression(record.node.parent))).toBe(true);

    const commandArguments = Object.fromEntries(commandBorrowers.map((record) => [
      `${record.file}:${record.owner}`,
      {
        queryClient: record.node.arguments[0]
          ? compactExpression(record.node.arguments[0])
          : "missing",
        target: objectArgumentContract(record.node.arguments[1]),
        promotion: objectArgumentContract(record.node.arguments[2]),
      },
    ]));
    expect(commandArguments).toEqual(EXPECTED_COMMAND_ARGUMENTS);

    const promotionKinds = commandBorrowers.map((record) => {
      const argument = record.node.arguments[2];
      if (!argument) return "missing";
      const promotion = unwrap(argument);
      if (!ts.isObjectLiteralExpression(promotion)) return "non-literal";
      const via = promotion.properties.find((property): property is ts.PropertyAssignment =>
        ts.isPropertyAssignment(property) && property.name.getText() === "via"
      );
      return via && ts.isStringLiteralLike(via.initializer) ? via.initializer.text : "missing-via";
    }).sort();
    expect(promotionKinds).toEqual([
      "classifier",
      "classifier",
      ...Array.from({ length: 10 }, () => "parser"),
    ]);
  });

  it("removes every raw component promotion endpoint call", () => {
    const rawPromotionCalls = allCalls.filter((record) =>
      record.file !== CLIENT_PERSIST_FILE && record.endpoint?.pattern === PROMOTE_ENDPOINT,
    );
    expect(sortedSites(rawPromotionCalls)).toEqual([]);
  });

  it("keeps the low-level promote URL inside promoteParsedRegion alone", () => {
    const lowLevelCalls = allCalls.filter((record) =>
      record.file === CLIENT_PERSIST_FILE && record.endpoint?.pattern === PROMOTE_ENDPOINT,
    );
    expect(lowLevelCalls.map((record) => ({
      file: record.file,
      owner: record.owner,
      callee: record.calleeText,
    }))).toEqual([{
      file: CLIENT_PERSIST_FILE,
      owner: "promoteParsedRegion",
      callee: "persistFetch",
    }]);
  });

  it("pins six typed map callers, zero raw component fetches, and one low-level fetch", () => {
    const mapCalls = allCalls.filter((record) => record.endpoint?.pattern === MAP_TAGS_ENDPOINT);
    expect(sortedMapSites(mapCalls.filter((record) => record.file !== MAP_TRANSPORT_FILE)))
      .toEqual([]);
    expect(sortedMapSites(mapCalls.filter((record) => record.file === MAP_TRANSPORT_FILE)))
      .toEqual([EXPECTED_LOW_LEVEL_MAP_TRANSPORT_SITE]);
    expect(mapCalls.every((record) =>
      record.provenance?.kind === "global" && record.provenance.imported === "fetch",
    )).toBe(true);

    const transportBorrowers = allCalls.filter((record) =>
      isImported(record, MAP_TRANSPORT_MODULE, "requestMapTagsBatch"),
    );
    expect(sortedMapSites(transportBorrowers)).toEqual(EXPECTED_MAP_TRANSPORT_SITES);
    const transportArguments = Object.fromEntries(transportBorrowers.map((record) => [
      `${record.file}:${record.owner}`,
      {
        project: record.node.arguments[0]
          ? compactExpression(record.node.arguments[0])
          : "missing",
        request: expressionOrObjectContract(record.node.arguments[1]),
        options: expressionOrObjectContract(record.node.arguments[2]),
        awaited: ts.isAwaitExpression(record.node.parent),
      },
    ]));
    expect(transportArguments).toEqual(EXPECTED_MAP_TRANSPORT_ARGUMENTS);
  });

  it("keeps both I/O leaves on their exact dependency boundaries", () => {
    const imports = (file: string) => parse(file).statements
      .filter(ts.isImportDeclaration)
      .map((statement) => ({
        module: (statement.moduleSpecifier as ts.StringLiteral).text,
        typeOnly: !!statement.importClause?.isTypeOnly,
      }))
      .sort((left, right) => left.module.localeCompare(right.module));

    expect(imports(MAP_TRANSPORT_FILE)).toEqual([
      { module: "@/lib/tag-mapping", typeOnly: true },
      { module: "@/types", typeOnly: true },
    ]);
    expect(imports(PARSED_REGIONS_FILE)).toEqual([
      { module: "@/lib/client-persist", typeOnly: false },
      { module: "@/lib/csi-spatial-refresh-target", typeOnly: false },
      { module: "@/queries/usePageWindow", typeOnly: false },
      { module: "@/queries/useSummaries", typeOnly: false },
      { module: "@/types", typeOnly: true },
      { module: "@tanstack/react-query", typeOnly: true },
    ]);
    expect(imports(SPATIAL_TARGET_FILE)).toEqual([
      { module: "@/lib/csi-spatial", typeOnly: false },
      { module: "@/queries/useAnnotations", typeOnly: false },
      { module: "@/queries/usePageWindow", typeOnly: false },
      { module: "@/queries/useYoloTags", typeOnly: false },
      { module: "@tanstack/react-query", typeOnly: true },
    ]);

    const mapSource = parse(MAP_TRANSPORT_FILE);
    expect(descendants(mapSource, ts.isTryStatement)).toEqual([]);
    expect(descendants(mapSource, ts.isNewExpression).filter((expression) =>
      ts.isIdentifier(expression.expression) && expression.expression.text === "AbortController"
    )).toEqual([]);
    // Error reporting belongs to each caller. Ban every direct console dependency so a transport
    // mutation cannot log and rethrow the same error while still satisfying identity assertions.
    expect(descendants(mapSource, ts.isIdentifier).filter((identifier) =>
      identifier.text === "console"
    )).toEqual([]);
  });

  it("removes legacy A/S/X tails while retaining only explicit optimistic/local publications", () => {
    const saveOwnerKeys = new Set(EXPECTED_SAVE_COMMAND_SITES.map((entry) =>
      `${entry.file}:${entry.owner}`
    ));
    const inSaveOwner = (record: CallRecord) => saveOwnerKeys.has(`${record.file}:${record.owner}`);

    const directAdoptions = allCalls.filter((record) =>
      inSaveOwner(record) &&
      isImported(record, "@/queries/usePageWindow", "setPageIntelligenceForPage"),
    );
    expect(sortedSites(directAdoptions)).toEqual([
      {
        file: "src/components/viewer/KeynoteItem.tsx",
        owner: "saveName",
        transport: "@/queries/usePageWindow.setPageIntelligenceForPage",
      },
      {
        file: "src/components/viewer/ParsedTableItem.tsx",
        owner: "persistRegionEdit",
        transport: "@/queries/usePageWindow.setPageIntelligenceForPage",
      },
      {
        file: "src/components/viewer/TableCompareModal.tsx",
        owner: "handleDone",
        transport: "@/queries/usePageWindow.setPageIntelligenceForPage",
      },
    ]);

    const directOptimisticUpdates = allCalls.filter((record) =>
      inSaveOwner(record) &&
      isImported(record, "@/queries/usePageWindow", "updatePageIntelligenceForPage"),
    );
    expect(sortedSites(directOptimisticUpdates)).toEqual([
      {
        file: "src/components/viewer/KeynotePanel.tsx",
        owner: "parseFromGuidedGrid",
        transport: "@/queries/usePageWindow.updatePageIntelligenceForPage",
      },
      {
        file: "src/components/viewer/KeynotePanel.tsx",
        owner: "saveKeynoteToIntelligence",
        transport: "@/queries/usePageWindow.updatePageIntelligenceForPage",
      },
    ]);

    // Every persistent optimistic write must precede its command. Otherwise a late local write
    // could overwrite authoritative A while retaining the same call-count topology.
    for (const optimistic of [...directAdoptions, ...directOptimisticUpdates]) {
      const command = allCalls.find((record) =>
        record.file === optimistic.file &&
        record.owner === optimistic.owner &&
        isImported(record, PARSED_REGIONS_MODULE, "saveParsedRegion")
      );
      expect(command, `${optimistic.file}:${optimistic.owner} command`).toBeDefined();
      expect(optimistic.node.getStart()).toBeLessThan(command!.node.getStart());
    }

    const directSummaries = allCalls.filter((record) =>
      inSaveOwner(record) && isImported(record, "@/queries/useSummaries", "seedSummariesCache"),
    );
    expect(sortedSites(directSummaries)).toEqual([]);

    const directSpatial = allCalls.filter((record) =>
      inSaveOwner(record) &&
      isImported(record, "@/lib/csi-spatial-refresh", "refreshPageCsiSpatialMap"),
    );
    expect(sortedSites(directSpatial)).toEqual([
      {
        file: "src/components/viewer/KeynotePanel.tsx",
        owner: "parseFromGuidedGrid",
        transport: "@/lib/csi-spatial-refresh.refreshPageCsiSpatialMap",
      },
      {
        file: "src/components/viewer/KeynotePanel.tsx",
        owner: "saveKeynoteToIntelligence",
        transport: "@/lib/csi-spatial-refresh.refreshPageCsiSpatialMap",
      },
      {
        file: "src/components/viewer/TableParsePanel.tsx",
        owner: "detectCsiAndPersist",
        transport: "@/lib/csi-spatial-refresh.refreshPageCsiSpatialMap",
      },
    ]);

    const spatialBranchContracts = directSpatial.map((refresh) => {
      const branch = nearestCanPersistBranch(refresh.node);
      const command = allCalls.find((record) =>
        record.file === refresh.file &&
        record.owner === refresh.owner &&
        isImported(record, PARSED_REGIONS_MODULE, "saveParsedRegion")
      );
      return {
        file: refresh.file,
        owner: refresh.owner,
        condition: branch ? compactExpression(branch.expression) : "missing",
        commandInConsequent: !!command && isWithin(command.node, branch?.thenStatement),
        refreshInAlternative: isWithin(refresh.node, branch?.elseStatement),
        refreshInConsequent: isWithin(refresh.node, branch?.thenStatement),
      };
    }).sort((left, right) =>
      left.file.localeCompare(right.file) || left.owner.localeCompare(right.owner)
    );
    expect(spatialBranchContracts).toEqual([
      {
        file: "src/components/viewer/KeynotePanel.tsx",
        owner: "parseFromGuidedGrid",
        condition: "canPersist(target.publicId,target.isDemo)",
        commandInConsequent: true,
        refreshInAlternative: true,
        refreshInConsequent: false,
      },
      {
        file: "src/components/viewer/KeynotePanel.tsx",
        owner: "saveKeynoteToIntelligence",
        condition: "canPersist(target.publicId,target.isDemo)",
        commandInConsequent: true,
        refreshInAlternative: true,
        refreshInConsequent: false,
      },
      {
        file: "src/components/viewer/TableParsePanel.tsx",
        owner: "detectCsiAndPersist",
        condition: "canPersist(target.publicId,target.isDemo)",
        commandInConsequent: true,
        refreshInAlternative: true,
        refreshInConsequent: false,
      },
    ]);

    const tableLocalWrites = allCalls.filter((record) =>
      record.file === "src/components/viewer/TableParsePanel.tsx" &&
      record.owner === "detectCsiAndPersist" &&
      record.calleeText === "saveParsedToIntelligence"
    );
    expect(tableLocalWrites).toHaveLength(1);
    const tableSpatial = directSpatial.find((record) =>
      record.file === "src/components/viewer/TableParsePanel.tsx"
    );
    const tableBranch = tableSpatial ? nearestCanPersistBranch(tableSpatial.node) : null;
    expect(isWithin(tableLocalWrites[0].node, tableBranch?.elseStatement)).toBe(true);
    expect(tableLocalWrites[0].node.getStart()).toBeLessThan(tableSpatial!.node.getStart());
  });

  // This deliberately parses every production TS/TSX file. Keep a local budget above Vitest's
  // 5s default so parallel full-suite load cannot turn the architecture scan into a timing flake.
  it("pins the exact nine command and six map-transport value-import files", () => {
    const parsedRegionLoads = productionFiles()
      .filter((path) => path !== PARSED_REGIONS_FILE)
      .flatMap((path) => candidateLoadKinds(
        path,
        PARSED_REGIONS_MODULE,
        PARSED_REGIONS_FILE,
      ).map((kind) => ({ path, kind })));
    expect(parsedRegionLoads).toEqual(EXPECTED_PARSED_REGION_IMPORT_FILES.map((path) => ({
      path,
      kind: "import",
    })));

    const parsedRegionImports = EXPECTED_PARSED_REGION_IMPORT_FILES.map((path) => {
      const declaration = parse(path).statements.find((statement): statement is ts.ImportDeclaration =>
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        resolvesToCandidate(path, statement.moduleSpecifier.text, PARSED_REGIONS_MODULE, PARSED_REGIONS_FILE)
      );
      return {
        path,
        typeOnly: declaration?.importClause?.isTypeOnly ?? null,
      };
    });
    expect(parsedRegionImports).toEqual(EXPECTED_PARSED_REGION_IMPORT_FILES.map((path) => ({
      path,
      typeOnly: false,
    })));

    const mapLoads = productionFiles()
      .filter((path) => path !== MAP_TRANSPORT_FILE)
      .flatMap((path) => candidateLoadKinds(path, MAP_TRANSPORT_MODULE, MAP_TRANSPORT_FILE)
        .map((kind) => ({ path, kind })));
    expect(mapLoads).toEqual(EXPECTED_MAP_TRANSPORT_IMPORT_FILES.map((path) => ({
      path,
      kind: "import",
    })));
    const mapImports = EXPECTED_MAP_TRANSPORT_IMPORT_FILES.map((path) => {
      const declaration = parse(path).statements.find((statement): statement is ts.ImportDeclaration =>
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        resolvesToCandidate(path, statement.moduleSpecifier.text, MAP_TRANSPORT_MODULE, MAP_TRANSPORT_FILE)
      );
      return { path, typeOnly: declaration?.importClause?.isTypeOnly ?? null };
    });
    expect(mapImports).toEqual(EXPECTED_MAP_TRANSPORT_IMPORT_FILES.map((path) => ({
      path,
      typeOnly: false,
    })));

    const fixturePath = "src/components/c2-load-fixture.ts";
    const fixture = ts.createSourceFile(
      fixturePath,
      `
        import { saveParsedRegion } from "@/queries/parsedRegions";
        import { saveParsedRegion as relativeSave } from "../queries/parsedRegions";
        export { SaveParsedRegionResult } from "@/queries/parsedRegions";
        const lazy = import("@/queries/parsedRegions");
        const commonJs = require("../queries/parsedRegions");
        type Inline = import("@/queries/parsedRegions").SaveParsedRegionResult;
      `,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    expect(candidateLoadKinds(
      fixturePath,
      PARSED_REGIONS_MODULE,
      PARSED_REGIONS_FILE,
      fixture,
    )).toEqual([
      "import",
      "import",
      "re-export",
      "dynamic-import",
      "require",
      "import-type",
    ]);
  }, 15_000);

  it("self-calibrates lexical aliases, namespace provenance, and shadowed fetch", () => {
    const records = fixtureRecords(`
      import { promoteParsedRegion as importedPromote } from "@/lib/client-persist";
      import * as PersistNamespace from "@/lib/client-persist";

      function namedAliasOwner() {
        const operation = importedPromote;
        operation({});
      }
      function namespaceOwner() {
        PersistNamespace.promoteParsedRegion({});
        PersistNamespace["persistFetch"]("/api/regions/promote", {});
      }
      function shadowedFetchOwner(fetch: (url: string) => void) {
        fetch(\`/api/projects/\${shadowProject}/map-tags-batch\`);
      }
      function globalFetchOwner() {
        fetch(\`/api/projects/\${pid}/map-tags-batch\`);
      }
      function globalAliasOwner() {
        const transport = fetch;
        transport(\`/api/projects/\${input.publicId}/map-tags-batch\`);
      }
      function unrelatedLocalAliasOwner() {
        const transport = (_url: string) => undefined;
        transport(\`/api/projects/\${localProject}/map-tags-batch\`);
      }
    `);

    expect(sortedSites(records.filter((record) =>
      isImported(record, CLIENT_PERSIST_MODULE, "promoteParsedRegion"),
    ))).toEqual([
      {
        file: "client-io-topology-self-calibration.ts",
        owner: "namedAliasOwner",
        transport: "@/lib/client-persist.promoteParsedRegion",
      },
      {
        file: "client-io-topology-self-calibration.ts",
        owner: "namespaceOwner",
        transport: "@/lib/client-persist.promoteParsedRegion",
      },
    ]);

    const fixtureMapCalls = records.filter((record) =>
      record.endpoint?.pattern === MAP_TAGS_ENDPOINT,
    );
    expect(sortedMapSites(fixtureMapCalls.filter((record) =>
      record.provenance?.kind === "global",
    ))).toEqual([
      {
        file: "client-io-topology-self-calibration.ts",
        owner: "globalAliasOwner",
        transport: "global.fetch",
        projectExpression: "input.publicId",
      },
      {
        file: "client-io-topology-self-calibration.ts",
        owner: "globalFetchOwner",
        transport: "global.fetch",
        projectExpression: "pid",
      },
    ]);
    expect(fixtureMapCalls.filter((record) => record.provenance === null)
      .map((record) => `${record.owner}:${record.endpoint?.interpolations[0]}`)
      .sort()).toEqual([
      "shadowedFetchOwner:shadowProject",
      "unrelatedLocalAliasOwner:localProject",
    ]);
  });

  // Migration discipline at the completed C3 boundary:
  // - the first manifests stay atomically fixed at twelve `@/queries/parsedRegions` calls with
  //   zero component promoteParsedRegion/raw endpoint calls;
  // - the six-owner map manifest stays atomically fixed at `requestMapTagsBatch`, with zero raw
  //   component fetches. Do not weaken these assertions to accept a union of old and new phases;
  //   such a union would let a partial migration ship while appearing green.
});
