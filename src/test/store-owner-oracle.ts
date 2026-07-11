import ts from "typescript";

/**
 * One Zustand owner that a topology test wants to audit.
 *
 * `members` must be an independent test ledger. The scanner intentionally does not inspect a
 * production store to discover its own contract: doing so would let a duplicate/wrong owner teach
 * the oracle that the mutation was valid.
 */
export interface StoreOwnerDescriptor {
  readonly moduleName: string;
  readonly exportName: string;
  readonly members: readonly string[] | ReadonlySet<string>;
  /** Support a default import as another spelling of `exportName`. Off unless requested. */
  readonly includeDefaultImport?: boolean;
}

export type StoreOwnerOperation =
  | "selector"
  | "wholeHook"
  | "getState"
  | "getInitialState"
  | "setState"
  | "subscribe";

export type StoreOwnerAccess = "read" | "write" | "broad";
export type StoreOwnerCertainty = "known" | "dynamic" | "opaque" | "broad";

/**
 * A known member access or an explicit reason why the scanner could not prove an access safe.
 * Consumers normally assert both their expected known findings and `uncertain.length === 0`.
 */
export interface StoreOwnerFinding {
  readonly operation: StoreOwnerOperation;
  readonly access: StoreOwnerAccess;
  readonly certainty: StoreOwnerCertainty;
  readonly member: string | null;
  readonly fileName: string;
  readonly start: number;
  readonly line: number;
  readonly column: number;
  readonly text: string;
  readonly detail?: string;
}

export interface StoreOwnerScanResult {
  readonly findings: readonly StoreOwnerFinding[];
  readonly known: readonly StoreOwnerFinding[];
  /** `dynamic`, `opaque`, and deliberately broad whole-state access. */
  readonly uncertain: readonly StoreOwnerFinding[];
}

type SnapshotOrigin = "wholeHook" | "getState" | "getInitialState";
type MethodName = "getState" | "getInitialState" | "setState" | "subscribe";

interface BindingAssignment {
  readonly name: string;
  readonly expression: ts.Expression;
}

interface Facts {
  readonly namespaces: Set<string>;
  readonly stores: Set<string>;
  readonly methods: Record<MethodName, Set<string>>;
  readonly snapshots: Record<SnapshotOrigin, Set<string>>;
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

function assignmentExpressions(source: ts.SourceFile): Map<string, ts.Expression[]> {
  const output = new Map<string, ts.Expression[]>();
  const add = (name: string, expression: ts.Expression): void => {
    const existing = output.get(name) ?? [];
    existing.push(expression);
    output.set(name, existing);
  };

  for (const declaration of descendants(source, ts.isVariableDeclaration)) {
    if (ts.isIdentifier(declaration.name) && declaration.initializer) {
      add(declaration.name.text, declaration.initializer);
    }
  }
  for (const binary of descendants(source, ts.isBinaryExpression)) {
    if (binary.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
    const left = unwrapExpression(binary.left as ts.Expression);
    if (ts.isIdentifier(left)) add(left.text, binary.right);
  }
  return output;
}

function bindingAssignments(source: ts.SourceFile): BindingAssignment[] {
  const output: BindingAssignment[] = [];
  for (const [name, expressions] of assignmentExpressions(source)) {
    for (const expression of expressions) output.push({ name, expression });
  }
  return output;
}

function staticStrings(
  source: ts.SourceFile,
  assignments: ReadonlyMap<string, readonly ts.Expression[]>,
): Map<string, string> {
  const cache = new Map<string, string | null>();
  const resolving = new Set<string>();

  const resolveExpression = (expression: ts.Expression): string | null => {
    const current = unwrapExpression(expression);
    if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
      return current.text;
    }
    if (ts.isIdentifier(current)) return resolveName(current.text);
    if (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const left = resolveExpression(current.left);
      const right = resolveExpression(current.right);
      return left !== null && right !== null ? left + right : null;
    }
    return null;
  };

  const resolveName = (name: string): string | null => {
    if (cache.has(name)) return cache.get(name) ?? null;
    if (resolving.has(name)) return null;
    resolving.add(name);
    const expressions = assignments.get(name) ?? [];
    const values = expressions.map(resolveExpression);
    resolving.delete(name);
    const value = values.length > 0 && values.every((candidate) => candidate === values[0])
      ? values[0]
      : null;
    cache.set(name, value);
    return value;
  };

  for (const name of assignments.keys()) resolveName(name);
  return new Map(
    [...cache.entries()].filter((entry): entry is [string, string] => entry[1] !== null),
  );
}

function staticPropertyName(
  name: ts.PropertyName | ts.BindingName | undefined,
  constants: ReadonlyMap<string, string>,
): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (!ts.isComputedPropertyName(name)) return null;
  const expression = unwrapExpression(name.expression);
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  return ts.isIdentifier(expression) ? constants.get(expression.text) ?? null : null;
}

function elementName(
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

function expressionPropertyName(
  expression: ts.Expression,
  constants: ReadonlyMap<string, string>,
): string | null {
  const current = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(current)) return current.name.text;
  return ts.isElementAccessExpression(current) ? elementName(current, constants) : null;
}

function namespaceImportNames(source: ts.SourceFile, moduleName: string): Set<string> {
  const output = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== moduleName
    ) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) output.add(bindings.name.text);
  }
  return output;
}

function namedImportNames(
  source: ts.SourceFile,
  descriptor: StoreOwnerDescriptor,
): Set<string> {
  const output = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== descriptor.moduleName
    ) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    if (descriptor.includeDefaultImport && clause.name) output.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === descriptor.exportName) {
        output.add(element.name.text);
      }
    }
  }
  return output;
}

function addAll(target: Set<string>, values: Iterable<string>): boolean {
  let changed = false;
  for (const value of values) {
    if (target.has(value)) continue;
    target.add(value);
    changed = true;
  }
  return changed;
}

function bindingElements(
  name: ts.BindingName,
  constants: ReadonlyMap<string, string>,
): Array<{ key: string | null; local: string; rest: boolean }> {
  if (!ts.isObjectBindingPattern(name)) return [];
  return name.elements.flatMap((element) => {
    if (!ts.isIdentifier(element.name)) return [];
    return [{
      key: staticPropertyName(element.propertyName ?? element.name, constants),
      local: element.name.text,
      rest: !!element.dotDotDotToken,
    }];
  });
}

function objectAssignmentElements(
  expression: ts.Expression,
  constants: ReadonlyMap<string, string>,
): Array<{ key: string | null; local: string; rest: boolean }> {
  const current = unwrapExpression(expression);
  if (!ts.isObjectLiteralExpression(current)) return [];
  const output: Array<{ key: string | null; local: string; rest: boolean }> = [];
  for (const property of current.properties) {
    if (ts.isSpreadAssignment(property)) {
      const target = unwrapExpression(property.expression);
      if (ts.isIdentifier(target)) output.push({ key: null, local: target.text, rest: true });
      continue;
    }
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
    const initializer = ts.isShorthandPropertyAssignment(property)
      ? property.name
      : unwrapExpression(property.initializer);
    if (!ts.isIdentifier(initializer)) continue;
    output.push({
      key: staticPropertyName(property.name, constants),
      local: initializer.text,
      rest: false,
    });
  }
  return output;
}

function buildFacts(
  source: ts.SourceFile,
  descriptor: StoreOwnerDescriptor,
  constants: ReadonlyMap<string, string>,
  assignments: readonly BindingAssignment[],
): Facts {
  const facts: Facts = {
    namespaces: namespaceImportNames(source, descriptor.moduleName),
    stores: namedImportNames(source, descriptor),
    methods: {
      getState: new Set<string>(),
      getInitialState: new Set<string>(),
      setState: new Set<string>(),
      subscribe: new Set<string>(),
    },
    snapshots: {
      wholeHook: new Set<string>(),
      getState: new Set<string>(),
      getInitialState: new Set<string>(),
    },
  };

  const isNamespace = (expression: ts.Expression): boolean => {
    const current = unwrapExpression(expression);
    return ts.isIdentifier(current) && facts.namespaces.has(current.text);
  };
  const isStore = (expression: ts.Expression): boolean => {
    const current = unwrapExpression(expression);
    if (ts.isIdentifier(current)) return facts.stores.has(current.text);
    if (!ts.isPropertyAccessExpression(current) && !ts.isElementAccessExpression(current)) {
      return false;
    }
    return isNamespace(current.expression) &&
      expressionPropertyName(current, constants) === descriptor.exportName;
  };
  const isDynamicNamespaceAccess = (expression: ts.Expression): boolean => {
    const current = unwrapExpression(expression);
    return ts.isElementAccessExpression(current) &&
      isNamespace(current.expression) &&
      expressionPropertyName(current, constants) === null;
  };
  const boundMethod = (expression: ts.Expression): MethodName | null => {
    const current = unwrapExpression(expression);
    if (!ts.isCallExpression(current)) return null;
    const callee = unwrapExpression(current.expression);
    if (
      !ts.isPropertyAccessExpression(callee) &&
      !ts.isElementAccessExpression(callee)
    ) return null;
    if (expressionPropertyName(callee, constants) !== "bind") return null;
    const target = unwrapExpression(callee.expression);
    if (ts.isIdentifier(target)) {
      return (Object.keys(facts.methods) as MethodName[])
        .find((method) => facts.methods[method].has(target.text)) ?? null;
    }
    if (!ts.isPropertyAccessExpression(target) && !ts.isElementAccessExpression(target)) {
      return null;
    }
    const method = expressionPropertyName(target, constants) as MethodName | null;
    return method && method in facts.methods && isStore(target.expression) ? method : null;
  };
  const isMethodCall = (call: ts.CallExpression, method: MethodName): boolean => {
    const callee = unwrapExpression(call.expression);
    if (ts.isIdentifier(callee)) return facts.methods[method].has(callee.text);
    if (ts.isCallExpression(callee)) return boundMethod(callee) === method;
    if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) {
      return false;
    }
    return isStore(callee.expression) && expressionPropertyName(callee, constants) === method;
  };
  const expressionOrigins = (expression: ts.Expression): SnapshotOrigin[] => {
    const current = unwrapExpression(expression);
    if (ts.isIdentifier(current)) {
      return (Object.keys(facts.snapshots) as SnapshotOrigin[])
        .filter((origin) => facts.snapshots[origin].has(current.text));
    }
    if (ts.isCallExpression(current)) {
      if (isStore(current.expression) && current.arguments.length === 0) return ["wholeHook"];
      if (isMethodCall(current, "getState")) return ["getState"];
      if (isMethodCall(current, "getInitialState")) return ["getInitialState"];
    }
    if (
      ts.isNewExpression(current) &&
      ts.isIdentifier(unwrapExpression(current.expression)) &&
      (unwrapExpression(current.expression) as ts.Identifier).text === "Proxy" &&
      current.arguments?.[0]
    ) {
      return expressionOrigins(current.arguments[0]);
    }
    return [];
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const { name, expression } of assignments) {
      const current = unwrapExpression(expression);
      if (isNamespace(current)) changed = addAll(facts.namespaces, [name]) || changed;
      if (isStore(current)) changed = addAll(facts.stores, [name]) || changed;
      if (isDynamicNamespaceAccess(current)) {
        changed = addAll(facts.stores, [name]) || changed;
      }
      if (
        ts.isNewExpression(current) &&
        ts.isIdentifier(unwrapExpression(current.expression)) &&
        (unwrapExpression(current.expression) as ts.Identifier).text === "Proxy" &&
        current.arguments?.[0]
      ) {
        if (isStore(current.arguments[0])) changed = addAll(facts.stores, [name]) || changed;
        if (isNamespace(current.arguments[0])) {
          changed = addAll(facts.namespaces, [name]) || changed;
        }
      }
      if (ts.isCallExpression(current) && !isStore(current.expression)) {
        if (current.arguments.some((argument) => isStore(argument))) {
          changed = addAll(facts.stores, [name]) || changed;
        }
        if (current.arguments.some((argument) => isNamespace(argument))) {
          changed = addAll(facts.namespaces, [name]) || changed;
        }
      }

      if (ts.isIdentifier(current)) {
        for (const method of Object.keys(facts.methods) as MethodName[]) {
          if (facts.methods[method].has(current.text)) {
            changed = addAll(facts.methods[method], [name]) || changed;
          }
        }
      }
      if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
        const method = expressionPropertyName(current, constants) as MethodName | null;
        if (method && method in facts.methods && isStore(current.expression)) {
          changed = addAll(facts.methods[method], [name]) || changed;
        }
      }
      if (ts.isCallExpression(current)) {
        const method = boundMethod(current);
        if (method) changed = addAll(facts.methods[method], [name]) || changed;
      }
      for (const origin of expressionOrigins(current)) {
        changed = addAll(facts.snapshots[origin], [name]) || changed;
      }
    }

    for (const declaration of descendants(source, ts.isVariableDeclaration)) {
      if (!declaration.initializer) continue;
      const initializer = unwrapExpression(declaration.initializer);
      const elements = bindingElements(declaration.name, constants);
      if (elements.length === 0) continue;
      if (isNamespace(initializer)) {
        for (const element of elements) {
          if (element.key === descriptor.exportName) {
            changed = addAll(facts.stores, [element.local]) || changed;
          }
        }
      }
      if (isStore(initializer)) {
        for (const element of elements) {
          const method = element.key as MethodName | null;
          if (method && method in facts.methods) {
            changed = addAll(facts.methods[method], [element.local]) || changed;
          }
        }
      }
    }

    for (const binary of descendants(source, ts.isBinaryExpression)) {
      if (binary.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
      const elements = objectAssignmentElements(binary.left as ts.Expression, constants);
      if (elements.length === 0) continue;
      const right = unwrapExpression(binary.right);
      if (isNamespace(right)) {
        for (const element of elements) {
          if (element.key === descriptor.exportName) {
            changed = addAll(facts.stores, [element.local]) || changed;
          }
        }
      }
      if (isStore(right)) {
        for (const element of elements) {
          const method = element.key as MethodName | null;
          if (method && method in facts.methods) {
            changed = addAll(facts.methods[method], [element.local]) || changed;
          }
        }
      }
    }
  }
  return facts;
}

function functionDeclarations(source: ts.SourceFile): Map<string, ts.FunctionLikeDeclaration[]> {
  const output = new Map<string, ts.FunctionLikeDeclaration[]>();
  for (const declaration of descendants(source, ts.isFunctionDeclaration)) {
    if (!declaration.name) continue;
    const existing = output.get(declaration.name.text) ?? [];
    existing.push(declaration);
    output.set(declaration.name.text, existing);
  }
  return output;
}

function isFunctionLikeExpression(node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

interface FunctionResolution {
  readonly functions: readonly ts.FunctionLikeDeclaration[];
  readonly opaque: boolean;
}

function resolveFunctions(
  expression: ts.Expression,
  assignments: ReadonlyMap<string, readonly ts.Expression[]>,
  declarations: ReadonlyMap<string, readonly ts.FunctionLikeDeclaration[]>,
  seen = new Set<string>(),
): FunctionResolution {
  const current = unwrapExpression(expression);
  if (isFunctionLikeExpression(current)) return { functions: [current], opaque: false };
  if (ts.isIdentifier(current)) {
    if (seen.has(current.text)) return { functions: [], opaque: true };
    const nextSeen = new Set(seen).add(current.text);
    const direct = declarations.get(current.text) ?? [];
    const assigned = assignments.get(current.text) ?? [];
    const nested = assigned.map((candidate) =>
      resolveFunctions(candidate, assignments, declarations, nextSeen));
    const functions = [...direct, ...nested.flatMap((entry) => entry.functions)];
    return {
      functions,
      opaque: functions.length === 0 || nested.some((entry) => entry.opaque),
    };
  }
  if (ts.isCallExpression(current)) {
    const callee = unwrapExpression(current.expression);
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
    if (name === "useShallow" && current.arguments[0]) {
      return resolveFunctions(current.arguments[0], assignments, declarations, seen);
    }
  }
  if (ts.isConditionalExpression(current)) {
    const left = resolveFunctions(current.whenTrue, assignments, declarations, seen);
    const right = resolveFunctions(current.whenFalse, assignments, declarations, seen);
    return {
      functions: [...left.functions, ...right.functions],
      opaque: left.opaque || right.opaque,
    };
  }
  return { functions: [], opaque: true };
}

function snapshotOperation(origin: SnapshotOrigin): StoreOwnerOperation {
  return origin;
}

/** Compact stable representation useful in topology assertions and diagnostics. */
export function formatStoreOwnerFinding(finding: StoreOwnerFinding): string {
  return [
    finding.operation,
    finding.access,
    finding.certainty,
    finding.member ?? "*",
  ].join(":");
}

/** Parse text and scan it in one call. */
export function scanStoreOwnerText(
  fileName: string,
  sourceText: string,
  descriptor: StoreOwnerDescriptor,
): StoreOwnerScanResult {
  const source = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  return scanStoreOwnerSource(source, descriptor);
}

/**
 * Scan one parsed source file for reads/writes through the configured store owner.
 *
 * This is intentionally conservative. A topology gate should reject `uncertain` findings unless a
 * narrowly documented seam has an independent runtime/type proof. Silence is never used to mean
 * that an unresolved selector, patch, spread, or computed key is safe.
 */
export function scanStoreOwnerSource(
  source: ts.SourceFile,
  descriptor: StoreOwnerDescriptor,
): StoreOwnerScanResult {
  const members = descriptor.members instanceof Set
    ? descriptor.members
    : new Set(descriptor.members);
  const expressionAssignments = assignmentExpressions(source);
  const assignments = bindingAssignments(source);
  const constants = staticStrings(source, expressionAssignments);
  const facts = buildFacts(source, descriptor, constants, assignments);
  const declarations = functionDeclarations(source);
  const findings: StoreOwnerFinding[] = [];
  const findingKeys = new Set<string>();

  const addFinding = (
    node: ts.Node,
    operation: StoreOwnerOperation,
    access: StoreOwnerAccess,
    certainty: StoreOwnerCertainty,
    member: string | null,
    detail?: string,
  ): void => {
    const start = node.getStart(source);
    const key = [start, operation, access, certainty, member ?? "", detail ?? ""].join("|");
    if (findingKeys.has(key)) return;
    findingKeys.add(key);
    const location = source.getLineAndCharacterOfPosition(start);
    findings.push({
      operation,
      access,
      certainty,
      member,
      fileName: source.fileName,
      start,
      line: location.line + 1,
      column: location.character + 1,
      text: node.getText(source),
      ...(detail ? { detail } : {}),
    });
  };

  const isNamespace = (expression: ts.Expression): boolean => {
    const current = unwrapExpression(expression);
    return ts.isIdentifier(current) && facts.namespaces.has(current.text);
  };
  const isStore = (expression: ts.Expression): boolean => {
    const current = unwrapExpression(expression);
    if (ts.isIdentifier(current)) return facts.stores.has(current.text);
    if (!ts.isPropertyAccessExpression(current) && !ts.isElementAccessExpression(current)) {
      return false;
    }
    return isNamespace(current.expression) &&
      expressionPropertyName(current, constants) === descriptor.exportName;
  };
  const isDynamicNamespaceAccess = (expression: ts.Expression): boolean => {
    const current = unwrapExpression(expression);
    return ts.isElementAccessExpression(current) &&
      isNamespace(current.expression) &&
      expressionPropertyName(current, constants) === null;
  };
  const boundMethod = (expression: ts.Expression): MethodName | null => {
    const current = unwrapExpression(expression);
    if (!ts.isCallExpression(current)) return null;
    const callee = unwrapExpression(current.expression);
    if (
      !ts.isPropertyAccessExpression(callee) &&
      !ts.isElementAccessExpression(callee)
    ) return null;
    if (expressionPropertyName(callee, constants) !== "bind") return null;
    const target = unwrapExpression(callee.expression);
    if (ts.isIdentifier(target)) {
      return (Object.keys(facts.methods) as MethodName[])
        .find((method) => facts.methods[method].has(target.text)) ?? null;
    }
    if (!ts.isPropertyAccessExpression(target) && !ts.isElementAccessExpression(target)) {
      return null;
    }
    const method = expressionPropertyName(target, constants) as MethodName | null;
    return method && method in facts.methods && isStore(target.expression) ? method : null;
  };
  const isMethodCall = (call: ts.CallExpression, method: MethodName): boolean => {
    const callee = unwrapExpression(call.expression);
    if (ts.isIdentifier(callee)) return facts.methods[method].has(callee.text);
    if (ts.isCallExpression(callee)) return boundMethod(callee) === method;
    if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) {
      return false;
    }
    return isStore(callee.expression) && expressionPropertyName(callee, constants) === method;
  };
  const originsOf = (expression: ts.Expression): SnapshotOrigin[] => {
    const current = unwrapExpression(expression);
    if (ts.isIdentifier(current)) {
      return (Object.keys(facts.snapshots) as SnapshotOrigin[])
        .filter((origin) => facts.snapshots[origin].has(current.text));
    }
    if (ts.isCallExpression(current)) {
      if (isStore(current.expression) && current.arguments.length === 0) return ["wholeHook"];
      if (isMethodCall(current, "getState")) return ["getState"];
      if (isMethodCall(current, "getInitialState")) return ["getInitialState"];
    }
    if (
      ts.isNewExpression(current) &&
      ts.isIdentifier(unwrapExpression(current.expression)) &&
      (unwrapExpression(current.expression) as ts.Identifier).text === "Proxy" &&
      current.arguments?.[0]
    ) {
      return originsOf(current.arguments[0]);
    }
    return [];
  };

  const addMemberFinding = (
    node: ts.Node,
    operation: StoreOwnerOperation,
    access: StoreOwnerAccess,
    member: string | null,
  ): void => {
    if (member === null) {
      addFinding(node, operation, access, "dynamic", null, "computed member is not statically known");
    } else if (members.has(member)) {
      addFinding(node, operation, access, "known", member);
    }
  };

  const addBindingReads = (
    name: ts.BindingName,
    node: ts.Node,
    operation: StoreOwnerOperation,
  ): void => {
    if (!ts.isObjectBindingPattern(name)) {
      addFinding(node, operation, "read", "opaque", null, "non-object snapshot destructuring");
      return;
    }
    for (const element of name.elements) {
      if (element.dotDotDotToken) {
        addFinding(element, operation, "read", "opaque", null, "rest binding can retain any owner member");
        continue;
      }
      addMemberFinding(
        element,
        operation,
        "read",
        staticPropertyName(element.propertyName ?? element.name, constants),
      );
    }
  };

  const analyzeStateFunction = (
    fn: ts.FunctionLikeDeclaration,
    operation: StoreOwnerOperation,
    options: {
      readonly allowNoStateParameters?: boolean;
      readonly stateParameterCount?: number;
    } = {},
  ): void => {
    const stateParameters = fn.parameters.slice(0, options.stateParameterCount ?? 1);
    if (stateParameters.length === 0) {
      // A one-argument Zustand subscribe listener may deliberately ignore both state arguments.
      // Selectors (including subscribeWithSelector's first callback) still require a state
      // parameter, so keep their missing parameter fail-closed.
      if (!options.allowNoStateParameters) {
        addFinding(fn, operation, "read", "opaque", null, "state callback has no parameter");
      }
      return;
    }

    const stateAliases = new Set<string>();
    for (const parameter of stateParameters) {
      if (parameter.dotDotDotToken) {
        addFinding(parameter, operation, "read", "opaque", null, "unsupported rest state parameter");
      } else if (ts.isObjectBindingPattern(parameter.name)) {
        addBindingReads(parameter.name, parameter, operation);
      } else if (ts.isIdentifier(parameter.name)) {
        stateAliases.add(parameter.name.text);
      } else {
        addFinding(parameter, operation, "read", "opaque", null, "unsupported state parameter binding");
      }
    }
    if (stateAliases.size === 0) return;

    let changed = true;
    while (changed) {
      changed = false;
      for (const declaration of descendants(fn, ts.isVariableDeclaration)) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        const initializer = unwrapExpression(declaration.initializer);
        const isAlias = ts.isIdentifier(initializer) && stateAliases.has(initializer.text);
        const isProxy = ts.isNewExpression(initializer) &&
          ts.isIdentifier(unwrapExpression(initializer.expression)) &&
          (unwrapExpression(initializer.expression) as ts.Identifier).text === "Proxy" &&
          !!initializer.arguments?.[0] &&
          ts.isIdentifier(unwrapExpression(initializer.arguments[0])) &&
          stateAliases.has((unwrapExpression(initializer.arguments[0]) as ts.Identifier).text);
        if ((isAlias || isProxy) && !stateAliases.has(declaration.name.text)) {
          stateAliases.add(declaration.name.text);
          changed = true;
        }
      }
      for (const binary of descendants(fn, ts.isBinaryExpression)) {
        if (binary.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
        const left = unwrapExpression(binary.left as ts.Expression);
        const right = unwrapExpression(binary.right);
        if (
          ts.isIdentifier(left) && ts.isIdentifier(right) &&
          stateAliases.has(right.text) && !stateAliases.has(left.text)
        ) {
          stateAliases.add(left.text);
          changed = true;
        }
      }
    }

    for (const access of descendants(fn, ts.isPropertyAccessExpression)) {
      const receiver = unwrapExpression(access.expression);
      if (ts.isIdentifier(receiver) && stateAliases.has(receiver.text)) {
        addMemberFinding(access, operation, "read", access.name.text);
      }
    }
    for (const access of descendants(fn, ts.isElementAccessExpression)) {
      const receiver = unwrapExpression(access.expression);
      if (ts.isIdentifier(receiver) && stateAliases.has(receiver.text)) {
        addMemberFinding(access, operation, "read", elementName(access, constants));
      }
    }
    for (const call of descendants(fn, ts.isCallExpression)) {
      for (const argument of call.arguments) {
        const current = unwrapExpression(argument);
        if (ts.isIdentifier(current) && stateAliases.has(current.text)) {
          addFinding(
            argument,
            operation,
            "read",
            "opaque",
            null,
            "state is passed to an opaque helper",
          );
        }
      }
    }
    for (const property of descendants(fn, ts.isPropertyAssignment)) {
      const initializer = unwrapExpression(property.initializer);
      if (ts.isIdentifier(initializer) && stateAliases.has(initializer.text)) {
        addFinding(
          property,
          operation,
          "read",
          "opaque",
          null,
          "state escapes through an object property",
        );
      }
    }
    for (const declaration of descendants(fn, ts.isVariableDeclaration)) {
      if (!declaration.initializer) continue;
      const initializer = unwrapExpression(declaration.initializer);
      if (ts.isIdentifier(initializer) && stateAliases.has(initializer.text) &&
        ts.isObjectBindingPattern(declaration.name)) {
        addBindingReads(declaration.name, declaration, operation);
      }
    }
    for (const spread of descendants(fn, ts.isSpreadAssignment)) {
      const expression = unwrapExpression(spread.expression);
      if (ts.isIdentifier(expression) && stateAliases.has(expression.text)) {
        addFinding(spread, operation, "read", "broad", null, "spreading the state observes every member");
      }
    }
    for (const spread of descendants(fn, ts.isSpreadElement)) {
      const expression = unwrapExpression(spread.expression);
      if (ts.isIdentifier(expression) && stateAliases.has(expression.text)) {
        addFinding(spread, operation, "read", "broad", null, "spreading the state observes every member");
      }
    }
    for (const returnStatement of descendants(fn, ts.isReturnStatement)) {
      const expression = returnStatement.expression && unwrapExpression(returnStatement.expression);
      if (expression && ts.isIdentifier(expression) && stateAliases.has(expression.text)) {
        addFinding(returnStatement, operation, "broad", "broad", null, "callback returns the whole state");
      }
    }
    if (ts.isArrowFunction(fn) && ts.isIdentifier(unwrapExpression(fn.body as ts.Expression)) &&
      stateAliases.has((unwrapExpression(fn.body as ts.Expression) as ts.Identifier).text)) {
      addFinding(fn.body, operation, "broad", "broad", null, "callback returns the whole state");
    }
  };

  const analyzePatch = (
    expression: ts.Expression,
    call: ts.CallExpression,
    seenNames = new Set<string>(),
    seenNodes = new Set<ts.Node>(),
  ): boolean => {
    const current = unwrapExpression(expression);
    if (seenNodes.has(current)) {
      addFinding(current, "setState", "write", "opaque", null, "cyclic patch expression");
      return false;
    }
    const nextNodes = new Set(seenNodes).add(current);

    if (ts.isObjectLiteralExpression(current)) {
      let resolved = true;
      for (const property of current.properties) {
        if (ts.isSpreadAssignment(property)) {
          const spreadResolved = analyzePatch(
            property.expression,
            call,
            new Set(seenNames),
            nextNodes,
          );
          if (!spreadResolved) {
            addFinding(property, "setState", "write", "opaque", null, "spread patch could not be resolved");
            resolved = false;
          }
          continue;
        }
        if (
          ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property) ||
          ts.isMethodDeclaration(property) || ts.isGetAccessorDeclaration(property) ||
          ts.isSetAccessorDeclaration(property)
        ) {
          addMemberFinding(
            property,
            "setState",
            "write",
            staticPropertyName(property.name, constants),
          );
        }
      }
      return resolved;
    }

    if (isFunctionLikeExpression(current)) {
      analyzeStateFunction(current, "setState");
      const returns = ts.isArrowFunction(current) && ts.isExpression(current.body)
        ? [current.body]
        : descendants(current.body, ts.isReturnStatement)
          .map((statement) => statement.expression)
          .filter((value): value is ts.Expression => !!value);
      if (returns.length === 0) {
        addFinding(current, "setState", "write", "opaque", null, "updater return patch is not statically known");
        return false;
      }
      return returns.every((returned) =>
        analyzePatch(returned, call, new Set(seenNames), nextNodes));
    }

    if (ts.isIdentifier(current)) {
      if (seenNames.has(current.text)) {
        addFinding(current, "setState", "write", "opaque", null, "cyclic patch alias");
        return false;
      }
      const nextSeen = new Set(seenNames).add(current.text);
      const functionMatches = declarations.get(current.text) ?? [];
      const valueMatches = expressionAssignments.get(current.text) ?? [];
      if (functionMatches.length === 0 && valueMatches.length === 0) {
        addFinding(current, "setState", "write", "opaque", null, "patch identifier has no local definition");
        return false;
      }
      let resolved = true;
      for (const fn of functionMatches) {
        analyzeStateFunction(fn, "setState");
        const returns = descendants(fn, ts.isReturnStatement)
          .map((statement) => statement.expression)
          .filter((value): value is ts.Expression => !!value);
        if (returns.length === 0) {
          addFinding(fn, "setState", "write", "opaque", null, "named updater has no resolvable return");
          resolved = false;
        }
        for (const returned of returns) {
          resolved = analyzePatch(returned, call, nextSeen, nextNodes) && resolved;
        }
      }
      for (const value of valueMatches) {
        resolved = analyzePatch(value, call, nextSeen, nextNodes) && resolved;
      }
      return resolved;
    }

    if (ts.isConditionalExpression(current)) {
      const whenTrue = analyzePatch(current.whenTrue, call, new Set(seenNames), nextNodes);
      const whenFalse = analyzePatch(current.whenFalse, call, new Set(seenNames), nextNodes);
      return whenTrue && whenFalse;
    }

    addFinding(current, "setState", "write", "opaque", null, "patch expression could not be resolved");
    return false;
  };

  // Hook selectors and deliberately broad whole-hook calls.
  for (const call of descendants(source, ts.isCallExpression)) {
    if (!isStore(call.expression)) continue;
    if (call.arguments.length === 0) {
      addFinding(call, "wholeHook", "broad", "broad", null, "zero-argument store hook subscribes to the whole state");
      continue;
    }
    const resolved = resolveFunctions(call.arguments[0], expressionAssignments, declarations);
    for (const fn of resolved.functions) analyzeStateFunction(fn, "selector");
    if (resolved.opaque) {
      addFinding(call.arguments[0], "selector", "read", "opaque", null, "selector could not be resolved locally");
    }
  }

  // Losing the store/namespace behind an arbitrary expression is itself an ownership escape. Taint
  // common identity/Proxy results in buildFacts so later accesses remain visible, and also report
  // the escape here so an unmodelled wrapper can never be mistaken for proof of absence.
  for (const access of descendants(source, ts.isElementAccessExpression)) {
    if (isDynamicNamespaceAccess(access)) {
      addFinding(
        access,
        "wholeHook",
        "broad",
        "dynamic",
        null,
        "dynamic owner namespace export could resolve to the audited store",
      );
    }
  }
  for (const call of descendants(source, ts.isCallExpression)) {
    // A recognized Function.prototype.bind on a known owner method is followed as that method;
    // its thisArg is not an ownership escape to an unknown callee.
    if (boundMethod(call)) continue;
    for (const argument of call.arguments) {
      if (isStore(argument) || isNamespace(argument)) {
        addFinding(
          argument,
          "wholeHook",
          "broad",
          "opaque",
          null,
          "store/owner namespace is passed to an opaque call",
        );
      } else if (isDynamicNamespaceAccess(argument)) {
        addFinding(
          argument,
          "wholeHook",
          "broad",
          "dynamic",
          null,
          "dynamic owner namespace export escapes through a call",
        );
      }
    }
  }
  for (const proxy of descendants(source, ts.isNewExpression)) {
    const callee = unwrapExpression(proxy.expression);
    if (!ts.isIdentifier(callee) || callee.text !== "Proxy" || !proxy.arguments?.[0]) continue;
    const target = proxy.arguments[0];
    if (isStore(target) || isNamespace(target)) {
      addFinding(
        target,
        "wholeHook",
        "broad",
        "opaque",
        null,
        "Proxy can remap any store/owner member",
      );
    }
  }
  for (const returnStatement of descendants(source, ts.isReturnStatement)) {
    if (!returnStatement.expression) continue;
    const expression = unwrapExpression(returnStatement.expression);
    if (isStore(expression) || isNamespace(expression)) {
      addFinding(
        returnStatement,
        "wholeHook",
        "broad",
        "opaque",
        null,
        "store/owner namespace escapes through a return",
      );
    } else if (isDynamicNamespaceAccess(expression)) {
      addFinding(
        returnStatement,
        "wholeHook",
        "broad",
        "dynamic",
        null,
        "dynamic owner namespace export escapes through a return",
      );
    }
  }
  for (const arrow of descendants(source, ts.isArrowFunction)) {
    if (ts.isBlock(arrow.body)) continue;
    const expression = unwrapExpression(arrow.body);
    if (isStore(expression) || isNamespace(expression)) {
      addFinding(
        arrow.body,
        "wholeHook",
        "broad",
        "opaque",
        null,
        "store/owner namespace escapes through an expression return",
      );
    } else if (isDynamicNamespaceAccess(expression)) {
      addFinding(
        arrow.body,
        "wholeHook",
        "broad",
        "dynamic",
        null,
        "dynamic owner namespace export escapes through an expression return",
      );
    }
  }
  for (const spread of [
    ...descendants(source, ts.isSpreadAssignment),
    ...descendants(source, ts.isSpreadElement),
  ]) {
    const expression = unwrapExpression(spread.expression);
    if (isStore(expression) || isNamespace(expression)) {
      addFinding(
        spread,
        "wholeHook",
        "broad",
        "opaque",
        null,
        "spreading a store/owner namespace exposes its complete surface",
      );
    } else if (isDynamicNamespaceAccess(expression)) {
      addFinding(
        spread,
        "wholeHook",
        "broad",
        "dynamic",
        null,
        "dynamic owner namespace export is spread",
      );
    }
  }

  // Imperative snapshots, whole-hook results, Proxy-derived snapshots, and destructuring.
  for (const access of descendants(source, ts.isPropertyAccessExpression)) {
    for (const origin of originsOf(access.expression)) {
      addMemberFinding(access, snapshotOperation(origin), "read", access.name.text);
    }
  }
  for (const access of descendants(source, ts.isElementAccessExpression)) {
    for (const origin of originsOf(access.expression)) {
      addMemberFinding(access, snapshotOperation(origin), "read", elementName(access, constants));
    }
  }
  for (const declaration of descendants(source, ts.isVariableDeclaration)) {
    if (!declaration.initializer || !ts.isObjectBindingPattern(declaration.name)) continue;
    for (const origin of originsOf(declaration.initializer)) {
      addBindingReads(declaration.name, declaration, snapshotOperation(origin));
    }
  }
  for (const binary of descendants(source, ts.isBinaryExpression)) {
    if (binary.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
    const left = unwrapExpression(binary.left as ts.Expression);
    if (!ts.isObjectLiteralExpression(left)) continue;
    for (const origin of originsOf(binary.right)) {
      for (const element of objectAssignmentElements(left, constants)) {
        if (element.rest) {
          addFinding(left, snapshotOperation(origin), "read", "opaque", null, "rest assignment can retain any owner member");
        } else {
          addMemberFinding(left, snapshotOperation(origin), "read", element.key);
        }
      }
    }
  }

  // Snapshot aliases are safe while their member use remains visible. Passing, returning, or
  // spreading the entire snapshot crosses the scanner's local data-flow boundary, so report that
  // boundary explicitly instead of silently losing provenance.
  for (const call of descendants(source, ts.isCallExpression)) {
    for (const argument of call.arguments) {
      for (const origin of originsOf(argument)) {
        addFinding(
          argument,
          snapshotOperation(origin),
          "read",
          "opaque",
          null,
          "whole snapshot is passed to an opaque call",
        );
      }
    }
  }
  for (const returnStatement of descendants(source, ts.isReturnStatement)) {
    if (!returnStatement.expression) continue;
    for (const origin of originsOf(returnStatement.expression)) {
      addFinding(
        returnStatement,
        snapshotOperation(origin),
        "read",
        "opaque",
        null,
        "whole snapshot escapes through a return",
      );
    }
  }
  for (const arrow of descendants(source, ts.isArrowFunction)) {
    if (ts.isBlock(arrow.body)) continue;
    for (const origin of originsOf(arrow.body)) {
      addFinding(
        arrow.body,
        snapshotOperation(origin),
        "read",
        "opaque",
        null,
        "whole snapshot escapes through an expression return",
      );
    }
  }
  for (const spread of [
    ...descendants(source, ts.isSpreadAssignment),
    ...descendants(source, ts.isSpreadElement),
  ]) {
    for (const origin of originsOf(spread.expression)) {
      addFinding(
        spread,
        snapshotOperation(origin),
        "broad",
        "broad",
        null,
        "spreading a snapshot observes every member",
      );
    }
  }
  for (const property of descendants(source, ts.isPropertyAssignment)) {
    for (const origin of originsOf(property.initializer)) {
      addFinding(
        property,
        snapshotOperation(origin),
        "read",
        "opaque",
        null,
        "whole snapshot escapes through an object property",
      );
    }
  }
  for (const property of descendants(source, ts.isShorthandPropertyAssignment)) {
    for (const origin of originsOf(property.name)) {
      addFinding(
        property,
        snapshotOperation(origin),
        "read",
        "opaque",
        null,
        "whole snapshot escapes through a shorthand object property",
      );
    }
  }

  // Writes through direct, bracketed, destructured, or assigned setState aliases.
  for (const call of descendants(source, ts.isCallExpression)) {
    if (!isMethodCall(call, "setState")) continue;
    if (!call.arguments[0]) {
      addFinding(call, "setState", "write", "opaque", null, "setState has no patch argument");
      continue;
    }
    analyzePatch(call.arguments[0], call);
  }

  // subscribe(selector, listener) is selector-based; subscribe(listener) receives the whole state,
  // but receipt alone is not an ownership read. Resolve a local listener and classify only its
  // actual state uses. Unresolved listeners and whole-state escapes remain fail-closed.
  for (const call of descendants(source, ts.isCallExpression)) {
    if (!isMethodCall(call, "subscribe")) continue;
    if (!call.arguments[0]) {
      addFinding(call, "subscribe", "read", "opaque", null, "subscribe has no analyzable callback");
      continue;
    }
    const resolved = resolveFunctions(call.arguments[0], expressionAssignments, declarations);
    const singleArgumentListener = call.arguments.length === 1;
    for (const fn of resolved.functions) {
      analyzeStateFunction(
        fn,
        "subscribe",
        singleArgumentListener
          ? { allowNoStateParameters: true, stateParameterCount: 2 }
          : undefined,
      );
    }
    if (resolved.opaque) {
      addFinding(call.arguments[0], "subscribe", "read", "opaque", null, "subscribe callback/selector could not be resolved locally");
    }
  }

  findings.sort((left, right) => left.start - right.start ||
    formatStoreOwnerFinding(left).localeCompare(formatStoreOwnerFinding(right)));
  return {
    findings,
    known: findings.filter((finding) => finding.certainty === "known"),
    uncertain: findings.filter((finding) => finding.certainty !== "known"),
  };
}
