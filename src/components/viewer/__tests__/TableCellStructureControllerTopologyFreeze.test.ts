// @vitest-environment node
// [refactor jul12 P2.4 A2e] One shared cell-structure controller above every Table row.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const CONTROLLER_MODULE = "@/hooks/useTableCellStructureOperation";
const PANEL = "src/components/viewer/TableParsePanel.tsx";
const AUTO = "src/components/viewer/AutoParseTab.tsx";
const RETAINED_ROW = "src/components/viewer/ParsedTableItem.tsx";

type ControllerImport = Readonly<{
  imported: string;
  local: string;
  typeOnly: boolean;
}>;

type ControllerAnalysis = Readonly<{
  imports: ControllerImport[];
  hookCalls: number;
  sharedPropPasses: string[];
}>;

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

function analyze(path: string, override?: string): ControllerAnalysis {
  const text = override ?? readFileSync(join(process.cwd(), path), "utf8");
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const imports = source.statements.flatMap((statement): ControllerImport[] => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== CONTROLLER_MODULE ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) return [];
    return statement.importClause.namedBindings.elements.map((element) => ({
      imported: (element.propertyName ?? element.name).text,
      local: element.name.text,
      typeOnly: statement.importClause!.isTypeOnly || element.isTypeOnly,
    }));
  });
  const hookCalls = descendants(source, ts.isCallExpression).filter((call) =>
    ts.isIdentifier(call.expression) && call.expression.text === "useTableCellStructureOperation"
  ).length;
  const sharedPropPasses = descendants(
    source,
    (node): node is ts.JsxAttribute =>
      ts.isJsxAttribute(node) && node.name.getText(source) === "cellStructureOperation",
  ).flatMap((attribute) => {
    const opening = attribute.parent.parent;
    if (!ts.isJsxOpeningElement(opening) && !ts.isJsxSelfClosingElement(opening)) return [];
    const initializer = attribute.initializer;
    if (
      !initializer || !ts.isJsxExpression(initializer) ||
      !initializer.expression || !ts.isIdentifier(initializer.expression)
    ) return [`${opening.tagName.getText(source)}:<non-identifier>`];
    return [`${opening.tagName.getText(source)}:${initializer.expression.text}`];
  }).sort();
  return { imports, hookCalls, sharedPropPasses };
}

describe("Table cell-structure controller topology", () => {
  it("creates one controller in TableParsePanel and passes it to both cold consumers", () => {
    expect(analyze(PANEL)).toEqual({
      imports: [{
        imported: "useTableCellStructureOperation",
        local: "useTableCellStructureOperation",
        typeOnly: false,
      }],
      hookCalls: 1,
      sharedPropPasses: [
        "AutoParseTab:cellStructureOperation",
        "ParsedTableItem:cellStructureOperation",
      ],
    });
  });

  it.each([AUTO, RETAINED_ROW])("keeps %s type-only and free of controller subscriptions", (path) => {
    expect(analyze(path)).toEqual({
      imports: [{
        imported: "TableCellStructureOperation",
        local: "TableCellStructureOperation",
        typeOnly: true,
      }],
      hookCalls: 0,
      sharedPropPasses: [],
    });
  });

  it("kills a retained-row controller subscription", () => {
    const original = readFileSync(join(process.cwd(), RETAINED_ROW), "utf8");
    const mutant = `${original}\nfunction RogueRowSubscription() { useTableCellStructureOperation(); }\n`;
    expect(analyze(RETAINED_ROW, mutant).hookCalls).toBe(1);
  });
});
