import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";

import {
  useParseFlowStore,
  type ParsedKeynoteEntry,
  type ParsedKeynoteKey,
  type ParseFlowState,
} from "@/stores/parseFlowStore";
import type { KeynoteData } from "@/types";

const ROOT = process.cwd();

function source(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function parsedSource(relativePath: string): ts.SourceFile {
  return ts.createSourceFile(
    relativePath,
    source(relativePath),
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function collect<T extends ts.Node>(
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

function callsByText(sourceFile: ts.SourceFile, expressionText: string): ts.CallExpression[] {
  return collect(
    sourceFile,
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) && node.expression.getText(sourceFile) === expressionText,
  );
}

function containsEscape(node: ts.Node): boolean {
  let found = false;
  const visit = (current: ts.Node): void => {
    if (
      current.kind === ts.SyntaxKind.AnyKeyword ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

beforeEach(() => {
  useParseFlowStore.setState(useParseFlowStore.getInitialState(), true);
});

describe("P2.4 D1 parsed-keynote type repair", () => {
  it("declares the exact optional nested-key metadata without narrowing minimal rows", () => {
    type StoredEntry = NonNullable<ParseFlowState["parsedKeynoteData"]>[number];
    type StoredKey = StoredEntry["keys"][number];

    expectTypeOf<StoredEntry>().toEqualTypeOf<ParsedKeynoteEntry>();
    expectTypeOf<StoredKey>().toEqualTypeOf<ParsedKeynoteKey>();
    expectTypeOf<StoredKey["csiCodes"]>().toEqualTypeOf<string[] | undefined>();
    expectTypeOf<StoredKey["note"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<KeynoteData["keynotes"][number]>().toEqualTypeOf<{
      key: string;
      description: string;
      shapeClass?: string;
    }>();

    const minimal: ParsedKeynoteKey = { key: "1", description: "Door" };
    expect(minimal).toEqual({ key: "1", description: "Door" });
  });

  it("preserves metadata values and nested references through replace and append", () => {
    const keyA: ParsedKeynoteKey = {
      key: "A",
      description: "Aluminum door",
      csiCodes: ["08 11 13"],
      note: "Verify finish",
    };
    const entryA: ParsedKeynoteEntry = {
      pageNumber: 2,
      keys: [keyA],
      tableName: "KEYNOTES",
      yoloClass: "door_single",
    };
    const replacement = [entryA];

    useParseFlowStore.getState().setParsedKeynoteData(replacement);
    const replaced = useParseFlowStore.getState().parsedKeynoteData;
    expect(replaced).toBe(replacement);
    expect(replaced?.[0]).toBe(entryA);
    expect(replaced?.[0].keys[0]).toBe(keyA);
    expect(replaced?.[0].keys[0]).toEqual(keyA);

    const csiCodesB = ["09 91 00"];
    const keyB: ParsedKeynoteKey = {
      key: "B",
      description: "Metadata-bearing append",
      csiCodes: csiCodesB,
      note: "Preserve nested references",
    };
    const entryB: ParsedKeynoteEntry = { pageNumber: 3, keys: [keyB] };
    useParseFlowStore.getState().addParsedKeynote(entryB);

    const appended = useParseFlowStore.getState().parsedKeynoteData;
    expect(appended).not.toBe(replacement);
    expect(appended?.[0]).toBe(entryA);
    expect(appended?.[0].keys[0]).toBe(keyA);
    expect(appended?.[1]).toBe(entryB);
    expect(appended?.[1].keys[0]).toBe(keyB);
    expect(appended?.[1].keys[0].csiCodes).toBe(csiCodesB);
    expect(appended?.[1].keys[0].note).toBe("Preserve nested references");
  });

  it("keeps transient editors inference-only and the persisted KeynoteData wire exact", () => {
    const keynoteItem = parsedSource("src/components/viewer/KeynoteItem.tsx");
    const keynotePanel = parsedSource("src/components/viewer/KeynotePanel.tsx");
    const compare = parsedSource("src/components/viewer/TableCompareModal.tsx");
    const persistedTypes = parsedSource("src/types/index.ts");

    const itemMaps = callsByText(keynoteItem, "allKeynotes.map");
    const compareMaps = callsByText(compare, "knData.map");
    const metadataFinds = callsByText(compare, "kn.keys?.find");
    expect(itemMaps).toHaveLength(2);
    expect(compareMaps).toHaveLength(1);
    expect(metadataFinds).toHaveLength(1);

    for (const call of [...itemMaps, ...compareMaps, ...metadataFinds]) {
      const callback = call.arguments[0];
      expect(ts.isArrowFunction(callback)).toBe(true);
      if (!ts.isArrowFunction(callback)) continue;
      expect(callback.parameters.every((parameter) => parameter.type === undefined)).toBe(true);
      expect(containsEscape(callback)).toBe(false);
    }

    for (const call of itemMaps) {
      expect(ts.isVariableDeclaration(call.parent)).toBe(true);
      if (!ts.isVariableDeclaration(call.parent)) continue;
      expect(call.parent.name.getText(keynoteItem)).toBe("updated");
      expect(call.parent.type).toBeUndefined();
      expect(call.parent.initializer).toBe(call);
    }

    expect(ts.isBinaryExpression(compareMaps[0].parent)).toBe(true);
    if (ts.isBinaryExpression(compareMaps[0].parent)) {
      expect(compareMaps[0].parent.left.getText(compare)).toBe("updatedKeynoteData");
      expect(compareMaps[0].parent.operatorToken.kind).toBe(ts.SyntaxKind.EqualsToken);
      expect(compareMaps[0].parent.right).toBe(compareMaps[0]);
    }

    expect(ts.isVariableDeclaration(metadataFinds[0].parent)).toBe(true);
    if (ts.isVariableDeclaration(metadataFinds[0].parent)) {
      expect(metadataFinds[0].parent.name.getText(compare)).toBe("existing");
      expect(metadataFinds[0].parent.type).toBeUndefined();
      expect(metadataFinds[0].parent.initializer).toBe(metadataFinds[0]);
    }

    const snapshotBindings = [
      ...collect(
        keynoteItem,
        (node): node is ts.VariableDeclaration =>
          ts.isVariableDeclaration(node) && node.name.getText(keynoteItem) === "allKeynotes",
      ),
      ...collect(
        compare,
        (node): node is ts.VariableDeclaration =>
          ts.isVariableDeclaration(node) && node.name.getText(compare) === "knData",
      ),
    ];
    expect(snapshotBindings).toHaveLength(3);
    for (const binding of snapshotBindings) {
      expect(binding.type).toBeUndefined();
      expect(binding.initializer && containsEscape(binding.initializer)).toBe(false);
    }

    const setters = [keynoteItem, keynotePanel, compare].flatMap((sourceFile) =>
      collect(
        sourceFile,
        (node): node is ts.CallExpression =>
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "setParsedKeynoteData",
      ),
    );
    expect(setters).toHaveLength(4);
    expect(setters.every((call) => call.arguments.length === 1)).toBe(true);
    expect(setters.every((call) => !containsEscape(call.arguments[0]))).toBe(true);

    const updatedKeynoteData = collect(
      compare,
      (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) && node.name.getText(compare) === "updatedKeynoteData",
    );
    expect(updatedKeynoteData).toHaveLength(1);
    expect(updatedKeynoteData[0].type?.getText(compare)).toBe("typeof knData");

    const keynoteData = collect(
      persistedTypes,
      (node): node is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(node) && node.name.text === "KeynoteData",
    );
    expect(keynoteData).toHaveLength(1);
    const keynoteMembers = Object.fromEntries(
      keynoteData[0].members.filter(ts.isPropertySignature).map((member) => [
        member.name?.getText(persistedTypes),
        member.type?.getText(persistedTypes).replace(/\s+/g, ""),
      ]),
    );
    expect(keynoteMembers).toEqual({
      keynotes: "{key:string;description:string;shapeClass?:string}[]",
      isPageSpecific: "boolean",
    });
  });
});
