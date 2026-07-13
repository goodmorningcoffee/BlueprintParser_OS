// @vitest-environment node
// [refactor jul12 P2.4 A2e] Fail-closed Guided workspace writer ownership.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const GUIDED_STATE_KEYS = new Set([
  "guidedParseOwner",
  "guidedParseActive",
  "guidedParseRegion",
  "guidedParseRows",
  "guidedParseCols",
]);
const GUIDED_LEAF_WRITERS = new Set([
  "setGuidedParseActive",
  "setGuidedParseRegion",
  "setGuidedParseRows",
  "setGuidedParseCols",
  "resetGuidedParse",
]);
const GUIDED_WRITER_OWNERS = new Set([
  "src/stores/parseFlowStore.ts",
  "src/stores/viewerCommands.ts",
]);
const GUIDED_WRITER_MANIFEST: Readonly<Record<string, readonly string[]>> = {
  "src/stores/parseFlowStore.ts": [
    "module:guidedParseOwner:state-property",
    "module:guidedParseActive:state-property",
    "module:guidedParseRegion:state-property",
    "module:guidedParseRows:state-property",
    "module:guidedParseCols:state-property",
    "setGuidedParseActive:guidedParseActive:state-shorthand",
    "setGuidedParseRegion:guidedParseRegion:state-shorthand",
    "setGuidedParseRows:guidedParseRows:state-shorthand",
    "setGuidedParseCols:guidedParseCols:state-shorthand",
    "resetGuidedParse:guidedParseOwner:state-property",
    "resetGuidedParse:guidedParseActive:state-property",
    "resetGuidedParse:guidedParseRegion:state-property",
    "resetGuidedParse:guidedParseRows:state-property",
    "resetGuidedParse:guidedParseCols:state-property",
    "resetProjectParseState:guidedParseOwner:state-property",
    "resetProjectParseState:guidedParseActive:state-property",
    "resetProjectParseState:guidedParseRegion:state-property",
    "resetProjectParseState:guidedParseRows:state-property",
    "resetProjectParseState:guidedParseCols:state-property",
    "useKeynoteParse:guidedParseActive:state-property",
    "useKeynoteParse:setGuidedParseActive:leaf-writer",
    "useKeynoteParse:guidedParseRegion:state-property",
    "useKeynoteParse:setGuidedParseRegion:leaf-writer",
    "useKeynoteParse:guidedParseRows:state-property",
    "useKeynoteParse:setGuidedParseRows:leaf-writer",
    "useKeynoteParse:guidedParseCols:state-property",
    "useKeynoteParse:setGuidedParseCols:leaf-writer",
    "useKeynoteParse:resetGuidedParse:leaf-writer",
    "useGuidedParseExtensions:guidedParseOwner:state-property",
    "useGuidedParseExtensions:guidedParseActive:state-property",
    "useGuidedParseExtensions:setGuidedParseActive:leaf-writer",
    "useGuidedParseExtensions:guidedParseRegion:state-property",
    "useGuidedParseExtensions:setGuidedParseRegion:leaf-writer",
    "useGuidedParseExtensions:guidedParseRows:state-property",
    "useGuidedParseExtensions:setGuidedParseRows:leaf-writer",
    "useGuidedParseExtensions:guidedParseCols:state-property",
    "useGuidedParseExtensions:setGuidedParseCols:leaf-writer",
    "useGuidedParseExtensions:resetGuidedParse:leaf-writer",
  ],
  "src/stores/viewerCommands.ts": [
    "claimGuidedParseWorkspaceForOperation:guidedParseOwner:state-property",
    "claimGuidedParseWorkspaceForOperation:guidedParseRegion:state-shorthand",
    "claimGuidedParseWorkspaceForOperation:guidedParseActive:state-property",
    "claimGuidedParseWorkspaceForOperation:guidedParseRows:state-property",
    "claimGuidedParseWorkspaceForOperation:guidedParseCols:state-property",
    "publishGuidedProposalForOperation:guidedParseRows:state-shorthand",
    "publishGuidedProposalForOperation:guidedParseCols:state-shorthand",
    "publishGuidedProposalForOperation:guidedParseActive:state-property",
    "publish:guidedParseOwner:state-property",
    "publish:guidedParseActive:state-property",
    "publish:guidedParseRegion:state-property",
    "publish:guidedParseRows:state-property",
    "publish:guidedParseCols:state-property",
    "resetTableParseWorkspace:guidedParseOwner:state-property",
    "resetTableParseWorkspace:guidedParseActive:state-property",
    "resetTableParseWorkspace:guidedParseRegion:state-property",
    "resetTableParseWorkspace:guidedParseRows:state-property",
    "resetTableParseWorkspace:guidedParseCols:state-property",
    "resetKeynoteGuidedParse:guidedParseOwner:state-property",
    "resetKeynoteGuidedParse:guidedParseActive:state-property",
    "resetKeynoteGuidedParse:guidedParseRegion:state-property",
    "resetKeynoteGuidedParse:guidedParseRows:state-property",
    "resetKeynoteGuidedParse:guidedParseCols:state-property",
    "transitionTableParseTab:guidedParseOwner:state-property",
    "transitionTableParseTab:guidedParseActive:state-property",
    "transitionTableParseTab:guidedParseRegion:state-property",
    "transitionTableParseTab:guidedParseRows:state-property",
    "transitionTableParseTab:guidedParseCols:state-property",
    "transitionKeynoteParseTab:guidedParseOwner:state-property",
    "transitionKeynoteParseTab:guidedParseActive:state-property",
    "transitionKeynoteParseTab:guidedParseRegion:state-property",
    "transitionKeynoteParseTab:guidedParseRows:state-property",
    "transitionKeynoteParseTab:guidedParseCols:state-property",
    "setGuidedParseRowsForLease:guidedParseRows:state-shorthand",
    "setGuidedParseColsForLease:guidedParseCols:state-shorthand",
    "acceptNotesParseRegion:guidedParseOwner:state-property",
    "acceptNotesParseRegion:guidedParseActive:state-property",
    "acceptNotesParseRegion:guidedParseRegion:state-property",
    "acceptNotesParseRegion:guidedParseRows:state-property",
    "acceptNotesParseRegion:guidedParseCols:state-property",
    "openNotesParseTarget:guidedParseOwner:state-property",
    "openNotesParseTarget:guidedParseActive:state-property",
    "openNotesParseTarget:guidedParseRegion:state-property",
    "openNotesParseTarget:guidedParseRows:state-property",
    "openNotesParseTarget:guidedParseCols:state-property",
    "completeNotesParseOperation:guidedParseOwner:state-property",
    "completeNotesParseOperation:guidedParseActive:state-property",
    "completeNotesParseOperation:guidedParseRegion:state-property",
    "completeNotesParseOperation:guidedParseRows:state-property",
    "completeNotesParseOperation:guidedParseCols:state-property",
    "resetNotesParseWorkspace:guidedParseOwner:state-property",
    "resetNotesParseWorkspace:guidedParseActive:state-property",
    "resetNotesParseWorkspace:guidedParseRegion:state-property",
    "resetNotesParseWorkspace:guidedParseRows:state-property",
    "resetNotesParseWorkspace:guidedParseCols:state-property",
    "leaveNotesParserWorkspace:guidedParseOwner:state-property",
    "leaveNotesParserWorkspace:guidedParseActive:state-property",
    "leaveNotesParserWorkspace:guidedParseRegion:state-property",
    "leaveNotesParserWorkspace:guidedParseRows:state-property",
    "leaveNotesParserWorkspace:guidedParseCols:state-property",
    "transitionNotesParserMode:guidedParseOwner:state-shorthand",
    "transitionNotesParserMode:guidedParseActive:state-property",
    "transitionNotesParserMode:guidedParseRegion:state-property",
    "transitionNotesParserMode:guidedParseRows:state-property",
    "transitionNotesParserMode:guidedParseCols:state-property",
    "completeTableParseOperation:guidedParseOwner:state-property",
    "completeTableParseOperation:guidedParseActive:state-property",
    "completeTableParseOperation:guidedParseRegion:state-property",
    "completeTableParseOperation:guidedParseRows:state-property",
    "completeTableParseOperation:guidedParseCols:state-property",
    "completeKeynoteParseOperation:guidedParseOwner:state-property",
    "completeKeynoteParseOperation:guidedParseActive:state-property",
    "completeKeynoteParseOperation:guidedParseRegion:state-property",
    "completeKeynoteParseOperation:guidedParseRows:state-property",
    "completeKeynoteParseOperation:guidedParseCols:state-property",
    "resetAllTools:resetGuidedParse:leaf-writer",
    "leaveSpecsNotesParseTab:guidedParseOwner:state-property",
    "leaveSpecsNotesParseTab:guidedParseActive:state-property",
    "leaveSpecsNotesParseTab:guidedParseRegion:state-property",
    "leaveSpecsNotesParseTab:guidedParseRows:state-property",
    "leaveSpecsNotesParseTab:guidedParseCols:state-property",
    "leaveSpecsNotesParseTab:guidedParseOwner:state-property",
    "leaveSpecsNotesParseTab:guidedParseActive:state-property",
    "leaveSpecsNotesParseTab:guidedParseRegion:state-property",
    "leaveSpecsNotesParseTab:guidedParseRows:state-property",
    "leaveSpecsNotesParseTab:guidedParseCols:state-property",
    "toggleTableParsePanel:guidedParseOwner:state-property",
    "toggleTableParsePanel:guidedParseActive:state-property",
    "toggleTableParsePanel:guidedParseRegion:state-property",
    "toggleTableParsePanel:guidedParseRows:state-property",
    "toggleTableParsePanel:guidedParseCols:state-property",
    "toggleKeynoteParsePanel:guidedParseOwner:state-property",
    "toggleKeynoteParsePanel:guidedParseActive:state-property",
    "toggleKeynoteParsePanel:guidedParseRegion:state-property",
    "toggleKeynoteParsePanel:guidedParseRows:state-property",
    "toggleKeynoteParsePanel:guidedParseCols:state-property",
  ],
};

function sourceOf(path: string, text = readFileSync(join(process.cwd(), path), "utf8")) {
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
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
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

function accessedName(expression: ts.Expression): string | null {
  const candidate = unwrap(expression);
  if (ts.isPropertyAccessExpression(candidate)) return candidate.name.text;
  if (ts.isElementAccessExpression(candidate) && candidate.argumentExpression) {
    const argument = unwrap(candidate.argumentExpression);
    return ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)
      ? argument.text
      : null;
  }
  return null;
}

function containsGuidedStateAccess(node: ts.Node): boolean {
  return descendants(
    node,
    (candidate): candidate is ts.PropertyAccessExpression | ts.ElementAccessExpression =>
      (ts.isPropertyAccessExpression(candidate) || ts.isElementAccessExpression(candidate)) &&
      GUIDED_STATE_KEYS.has(accessedName(candidate) ?? ""),
  ).length > 0;
}

function enclosingFunctionName(node: ts.Node): string {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (
      ts.isArrowFunction(current) || ts.isFunctionExpression(current)
    ) {
      if (
        ts.isVariableDeclaration(current.parent) &&
        ts.isIdentifier(current.parent.name)
      ) return current.parent.name.text;
      if (
        ts.isPropertyAssignment(current.parent) &&
        current.parent.initializer === current
      ) return staticName(current.parent.name) ?? "anonymous-property";
    }
    current = current.parent;
  }
  return "module";
}

function guidedWriterViolations(source: ts.SourceFile): string[] {
  const violations: Array<{ position: number; label: string }> = [];
  const record = (node: ts.Node, property: string, kind: string): void => {
    violations.push({
      position: node.getStart(source),
      label: `${enclosingFunctionName(node)}:${property}:${kind}`,
    });
  };

  // A Guided-named property in an object returned to set/setState is the common raw-store write.
  // Scanning the property itself also closes aliases and functional callbacks without having to
  // recognize every possible spelling of the Zustand owner.
  for (const property of descendants(
    source,
    (node): node is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
      ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node),
  )) {
    const name = ts.isShorthandPropertyAssignment(property)
      ? property.name.text
      : staticName(property.name);
    if (name && GUIDED_STATE_KEYS.has(name)) {
      record(
        property,
        name,
        ts.isShorthandPropertyAssignment(property) ? "state-shorthand" : "state-property",
      );
    }
  }

  for (const binary of descendants(source, ts.isBinaryExpression)) {
    if (
      binary.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      binary.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      containsGuidedStateAccess(binary.left)
    ) record(binary, accessedName(binary.left) ?? "guided-state", "state-assignment");
  }
  for (const unary of descendants(
    source,
    (node): node is ts.PrefixUnaryExpression | ts.PostfixUnaryExpression =>
      ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node),
  )) {
    if (
      (unary.operator === ts.SyntaxKind.PlusPlusToken ||
        unary.operator === ts.SyntaxKind.MinusMinusToken) &&
      containsGuidedStateAccess(unary.operand)
    ) record(unary, accessedName(unary.operand) ?? "guided-state", "state-update");
  }
  for (const deletion of descendants(source, ts.isDeleteExpression)) {
    if (containsGuidedStateAccess(deletion.expression)) {
      record(
        deletion,
        accessedName(deletion.expression) ?? "guided-state",
        "state-delete",
      );
    }
  }

  // Borrowing a raw leaf writer is forbidden as well as calling one. That fail-closed rule catches
  // direct members, computed members, destructuring/renaming, and standalone imported aliases.
  for (const access of descendants(
    source,
    (node): node is ts.PropertyAccessExpression | ts.ElementAccessExpression =>
      ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node),
  )) {
    const name = accessedName(access);
    if (name && GUIDED_LEAF_WRITERS.has(name)) record(access, name, "leaf-writer");
  }
  for (const binding of descendants(source, ts.isBindingElement)) {
    const name = staticName(binding.propertyName ?? binding.name);
    if (name && GUIDED_LEAF_WRITERS.has(name)) {
      record(binding, name, "leaf-writer-binding");
    }
  }
  for (const call of descendants(source, ts.isCallExpression)) {
    const callee = unwrap(call.expression);
    if (ts.isIdentifier(callee) && GUIDED_LEAF_WRITERS.has(callee.text)) {
      record(callee, callee.text, "leaf-writer-identifier");
    }
  }

  return violations
    .sort((left, right) => left.position - right.position)
    .map(({ label }) => label);
}

function productionFiles(directory = "src"): string[] {
  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(join(process.cwd(), current), { withFileTypes: true })) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (/\.(?:ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) files.push(child);
    }
  };
  visit(directory);
  return files.sort().filter((path) =>
    !path.includes("/__tests__/") &&
    !path.startsWith("src/test/") &&
    !/\.(?:test|spec)\.(?:ts|tsx)$/.test(path)
  );
}

describe("A2e Guided workspace writer ownership", () => {
  it("pins every permitted raw shared-grid byte and leaf-writer occurrence to an exact owner/function/property manifest", () => {
    const violations = productionFiles()
      .filter((path) => !GUIDED_WRITER_OWNERS.has(path))
      .flatMap((path) => guidedWriterViolations(sourceOf(path)).map((write) => ({ path, write })));

    expect(violations).toEqual([]);

    for (const path of GUIDED_WRITER_OWNERS) {
      expect(guidedWriterViolations(sourceOf(path)), path).toEqual(
        GUIDED_WRITER_MANIFEST[path],
      );
    }
  }, 120_000);

  it("self-calibrates against direct, computed, shorthand, assignment, and borrowed-setter mutations", () => {
    const fixture = sourceOf("guided-writer-mutation-fixture.ts", `
      declare const state: any;
      declare const guidedParseRows: number[];
      function mutate() {
        const direct = { guidedParseOwner: "notes" };
        const computed = { ["guidedParseActive"]: true };
        const shorthand = { guidedParseRows };
        state.guidedParseRegion = null;
        state["guidedParseCols"]++;
        delete state.guidedParseOwner;
        state.setGuidedParseCols([]);
        const borrowed = state["setGuidedParseRegion"];
        const { setGuidedParseRows: renamed } = state;
        setGuidedParseActive(false);
        return [direct, computed, shorthand, borrowed, renamed];
      }
    `);

    expect(guidedWriterViolations(fixture)).toEqual([
      "mutate:guidedParseOwner:state-property",
      "mutate:guidedParseActive:state-property",
      "mutate:guidedParseRows:state-shorthand",
      "mutate:guidedParseRegion:state-assignment",
      "mutate:guidedParseCols:state-update",
      "mutate:guidedParseOwner:state-delete",
      "mutate:setGuidedParseCols:leaf-writer",
      "mutate:setGuidedParseRegion:leaf-writer",
      "mutate:setGuidedParseRows:leaf-writer-binding",
      "mutate:setGuidedParseActive:leaf-writer-identifier",
    ]);
  });
});
