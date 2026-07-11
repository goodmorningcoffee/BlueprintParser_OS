// @vitest-environment node
// [refactor jul11 P2.4 F1] Exact client-I/O migration topology before C1-C3 convergence.
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
// C1 is additive and production-dead: old callers stay exact while each future owner has exactly
// one internal transport call and zero external production borrowers. C2/C3 must flip these
// assertions atomically rather than accepting an old/new union.
const CLIENT_IO_PHASE: ClientIoPhase = "C1";

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

const EXPECTED_PROMOTE_HELPER_SITES: Site[] = [
  {
    file: "src/components/viewer/KeynoteItem.tsx",
    owner: "saveName",
    transport: "@/lib/client-persist.promoteParsedRegion",
  },
  {
    file: "src/components/viewer/KeynotePanel.tsx",
    owner: "parseFromGuidedGrid",
    transport: "@/lib/client-persist.promoteParsedRegion",
  },
  {
    file: "src/components/viewer/KeynotePanel.tsx",
    owner: "saveKeynoteToIntelligence",
    transport: "@/lib/client-persist.promoteParsedRegion",
  },
  {
    file: "src/components/viewer/NotesParser.tsx",
    owner: "persistPreviewGrid",
    transport: "@/lib/client-persist.promoteParsedRegion",
  },
  {
    file: "src/components/viewer/NotesParser.tsx",
    owner: "saveFromParagraphBatch",
    transport: "@/lib/client-persist.promoteParsedRegion",
  },
  {
    file: "src/components/viewer/ParsedTableItem.tsx",
    owner: "persistRegionEdit",
    transport: "@/lib/client-persist.promoteParsedRegion",
  },
  {
    file: "src/components/viewer/SpecParser.tsx",
    owner: "persistPreview",
    transport: "@/lib/client-persist.promoteParsedRegion",
  },
  {
    file: "src/components/viewer/SpecParser.tsx",
    owner: "saveFromBatch",
    transport: "@/lib/client-persist.promoteParsedRegion",
  },
  {
    file: "src/components/viewer/TableCompareModal.tsx",
    owner: "handleDone",
    transport: "@/lib/client-persist.promoteParsedRegion",
  },
  {
    file: "src/components/viewer/TableParsePanel.tsx",
    owner: "detectCsiAndPersist",
    transport: "@/lib/client-persist.promoteParsedRegion",
  },
];

const EXPECTED_RAW_CLASSIFIER_SITES: Site[] = [
  {
    file: "src/components/viewer/NotesClassifier.tsx",
    owner: "handleAccept",
    transport: "@/lib/client-persist.persistFetch",
  },
  {
    file: "src/components/viewer/SpecClassifier.tsx",
    owner: "handleAccept",
    transport: "@/lib/client-persist.persistFetch",
  },
];

const EXPECTED_DEAD_PARSED_REGION_SITE: Site = {
  file: PARSED_REGIONS_FILE,
  owner: "saveParsedRegion",
  transport: "@/lib/client-persist.promoteParsedRegion",
};

const EXPECTED_RAW_MAP_TAGS_SITES: MapSite[] = [
  {
    file: "src/components/viewer/AnnotationOverlay.tsx",
    owner: "handleMouseDown",
    transport: "global.fetch",
    projectExpression: "pid",
  },
  {
    file: "src/components/viewer/AutoQtoTab.tsx",
    owner: "MappingStep",
    transport: "global.fetch",
    projectExpression: "input.publicId",
  },
  {
    file: "src/components/viewer/KeynoteItem.tsx",
    owner: "KeynoteItem:onClick[Run Mapping]",
    transport: "global.fetch",
    projectExpression: "identityPublicId",
  },
  {
    file: "src/components/viewer/KeynotePanel.tsx",
    owner: "mapKeynoteKeysToYoloTags",
    transport: "global.fetch",
    projectExpression: "publicId",
  },
  {
    file: "src/components/viewer/ParsedTableItem.tsx",
    owner: "ParsedTableItem:onClick[Run Mapping]",
    transport: "global.fetch",
    projectExpression: "publicId",
  },
  {
    file: "src/components/viewer/TableParsePanel.tsx",
    owner: "handleMapTags",
    transport: "global.fetch",
    projectExpression: "publicId",
  },
];

const EXPECTED_DEAD_MAP_TRANSPORT_SITE: MapSite = {
  file: MAP_TRANSPORT_FILE,
  owner: "requestMapTagsBatch",
  transport: "global.fetch",
  projectExpression: "publicId",
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
    projectExpression: record.endpoint?.interpolations.join(",") ?? "",
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

describe("P2.4 C1 parse client-I/O topology", () => {
  it("pins C1 as additive: ten legacy promote owners plus one dead command transport", () => {
    expect(CLIENT_IO_PHASE).toBe("C1");
    const helperCalls = allCalls.filter((record) =>
      isImported(record, CLIENT_PERSIST_MODULE, "promoteParsedRegion"),
    );
    expect(sortedSites(helperCalls.filter((record) => record.file !== PARSED_REGIONS_FILE)))
      .toEqual(EXPECTED_PROMOTE_HELPER_SITES);
    expect(sortedSites(helperCalls.filter((record) => record.file === PARSED_REGIONS_FILE)))
      .toEqual([EXPECTED_DEAD_PARSED_REGION_SITE]);

    const commandBorrowers = allCalls.filter((record) =>
      isImported(record, PARSED_REGIONS_MODULE, "saveParsedRegion"),
    );
    expect(sortedSites(commandBorrowers), "C1 command must remain production-dead").toEqual([]);
  });

  it("pins the two classifier endpoint calls and their persistFetch provenance", () => {
    const rawPromotionCalls = allCalls.filter((record) =>
      record.file !== CLIENT_PERSIST_FILE && record.endpoint?.pattern === PROMOTE_ENDPOINT,
    );
    expect(sortedSites(rawPromotionCalls)).toEqual(EXPECTED_RAW_CLASSIFIER_SITES);
    expect(rawPromotionCalls.every((record) =>
      isImported(record, CLIENT_PERSIST_MODULE, "persistFetch"),
    )).toBe(true);
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

  it("pins six raw map callers plus one dead low-level transport fetch", () => {
    const mapCalls = allCalls.filter((record) => record.endpoint?.pattern === MAP_TAGS_ENDPOINT);
    expect(sortedMapSites(mapCalls.filter((record) => record.file !== MAP_TRANSPORT_FILE)))
      .toEqual(EXPECTED_RAW_MAP_TAGS_SITES);
    expect(sortedMapSites(mapCalls.filter((record) => record.file === MAP_TRANSPORT_FILE)))
      .toEqual([EXPECTED_DEAD_MAP_TRANSPORT_SITE]);
    expect(mapCalls.every((record) =>
      record.provenance?.kind === "global" && record.provenance.imported === "fetch",
    )).toBe(true);

    const transportBorrowers = allCalls.filter((record) =>
      isImported(record, MAP_TRANSPORT_MODULE, "requestMapTagsBatch"),
    );
    expect(sortedSites(transportBorrowers), "C1 map transport must remain production-dead")
      .toEqual([]);
  });

  it("keeps both C1 leaves on their exact dependency boundaries", () => {
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

  it("proves both C1 candidates have zero external production loads", () => {
    const candidates = [
      { module: PARSED_REGIONS_MODULE, file: PARSED_REGIONS_FILE },
      { module: MAP_TRANSPORT_MODULE, file: MAP_TRANSPORT_FILE },
    ] as const;
    const loads = candidates.flatMap((candidate) =>
      productionFiles()
        .filter((path) => path !== candidate.file)
        .flatMap((path) => candidateLoadKinds(path, candidate.module, candidate.file)
          .map((kind) => ({ path, module: candidate.module, kind }))),
    );
    expect(loads).toEqual([]);

    const fixturePath = "src/components/c1-load-fixture.ts";
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
  });

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

  // Migration discipline after this C1 additive phase:
  // - C2 flips the first two manifests atomically to twelve calls imported from
  //   `@/queries/parsedRegions`, with zero component promoteParsedRegion/raw endpoint calls.
  // - C3 flips the six-owner map manifest atomically to `requestMapTagsBatch`, with zero raw
  //   component fetches. Do not weaken these assertions to accept a union of old and new phases;
  //   such a union would let a partial migration ship while appearing green.
});
