// @vitest-environment node
// [refactor jul11 P2.2⑨ C3] Exact migration topology. Runtime tests prove behavior; this source
// contract prevents a future "convenient" whole-array observer or direct loader/store write from
// quietly undoing the narrow ownership split on the sacred viewer path.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const FACADE = "src/queries/useYoloTags.ts";
const AUTH_LOADER = "src/app/(dashboard)/project/[id]/page.tsx";
const DEMO_LOADER = "src/app/demo/project/[id]/page.tsx";
const sourceText = new Map<string, string>();

function sourceFiles(directory = "src"): string[] {
  const output: string[] = [];
  const visit = (relative: string) => {
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

const parsed = new Map<string, ts.SourceFile>();
const productionFiles = sourceFiles();
function textOf(relativePath: string): string {
  const cached = sourceText.get(relativePath);
  if (cached !== undefined) return cached;
  const text = readFileSync(join(process.cwd(), relativePath), "utf8");
  sourceText.set(relativePath, text);
  return text;
}

function parse(relativePath: string): ts.SourceFile {
  const cached = parsed.get(relativePath);
  if (cached) return cached;
  const text = textOf(relativePath);
  const result = ts.createSourceFile(
    relativePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  parsed.set(relativePath, result);
  return result;
}

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

function callCount(relativePath: string, name: string): number {
  return descendants(
    parse(relativePath),
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name,
  ).length;
}

function topology(name: string): Record<string, number> {
  return Object.fromEntries(
    productionFiles
      .filter((path) => path !== FACADE)
      // Parse only plausible owners. This keeps the oracle well below the 5s full-suite timeout
      // while preserving exact AST call counting (aliases would also make the expected call vanish).
      .filter((path) => textOf(path).includes(name))
      .map((path) => [path, callCount(path, name)] as const)
      .filter(([, count]) => count > 0),
  );
}

function propertyAccesses(relativePath: string, name: string): number {
  return descendants(
    parse(relativePath),
    (node): node is ts.PropertyAccessExpression | ts.ElementAccessExpression => {
      if (ts.isPropertyAccessExpression(node)) return node.name.text === name;
      if (!ts.isElementAccessExpression(node) || !node.argumentExpression) return false;
      return ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === name;
    },
  ).length;
}

describe("P2.2⑨ yoloTags migration topology", () => {
  it("pins the narrow observer graph and keeps the whole-list facade off sacred/action-only paths", () => {
    expect(topology("useYoloTags")).toEqual({
      "src/components/viewer/DetectionPanel.tsx": 1,
    });
    expect(topology("useYoloTagRows")).toEqual({
      "src/components/viewer/KeynotePanel.tsx": 1,
      "src/components/viewer/TableParsePanel.tsx": 1,
    });
    expect(topology("useYoloTagsForPage")).toEqual({
      "src/components/viewer/AnnotationOverlay.tsx": 1,
    });
    expect(topology("useYoloTagCatalog")).toEqual({
      "src/components/viewer/ParsedTableCellOverlay.tsx": 1,
    });
    expect(topology("useYoloTagById")).toEqual({
      "src/components/viewer/PageSidebar.tsx": 1,
      "src/components/viewer/TagBrowseBar.tsx": 1,
    });
  });

  it("pins action-only hooks and synchronous live readers", () => {
    expect(topology("useYoloTagActions")).toEqual({
      "src/components/viewer/AnnotationOverlay.tsx": 1,
      "src/components/viewer/AutoQtoTab.tsx": 1,
      "src/components/viewer/KeynoteItem.tsx": 1,
      "src/components/viewer/KeynotePanel.tsx": 1,
      "src/components/viewer/ParsedTableItem.tsx": 1,
      "src/components/viewer/TableParsePanel.tsx": 1,
      "src/components/viewer/TagBrowseBar.tsx": 1,
    });
    expect(topology("readYoloTags")).toEqual({
      "src/components/viewer/AnnotationOverlay.tsx": 1,
      "src/components/viewer/AutoQtoTab.tsx": 1,
      "src/components/viewer/DetectionPanel.tsx": 1,
      "src/components/viewer/KeynoteItem.tsx": 3,
      "src/components/viewer/ParsedTableItem.tsx": 2,
      "src/components/viewer/TableCompareModal.tsx": 1,
      "src/lib/csi-spatial-refresh-target.ts": 1,
    });
    expect(topology("navigateYoloTag")).toEqual({
      "src/components/viewer/KeynoteItem.tsx": 1,
      "src/components/viewer/TableCompareModal.tsx": 1,
      "src/hooks/useKeyboardShortcuts.ts": 1,
    });
  });

  it("requires both loaders to clear exactly and seed through the PI-splitting adapter", () => {
    expect(topology("seedYoloTagsFromBootstrap")).toEqual({
      [AUTH_LOADER]: 1,
      [DEMO_LOADER]: 1,
    });
    expect(topology("clearYoloTagsProject")).toEqual({
      [AUTH_LOADER]: 1,
      [DEMO_LOADER]: 1,
    });
    for (const loader of [AUTH_LOADER, DEMO_LOADER]) {
      expect(propertyAccesses(loader, "yoloTags"), loader).toBe(0);
      expect(readFileSync(join(process.cwd(), loader), "utf8")).not.toContain("setYoloTags");
    }
  });

  it("keeps the full-array persistence endpoint owned by the facade alone", () => {
    const owners = productionFiles
      .filter((path) => textOf(path)
        .includes("{ yoloTags: snapshot }"));
    expect(owners).toEqual([FACADE]);
    const legacyDirectWriters = productionFiles
      .filter((path) => textOf(path)
        .includes("JSON.stringify({ yoloTags"));
    expect(legacyDirectWriters).toEqual([]);
  });
});
