// @vitest-environment node
//
// [refactor jul20 P3.3] ACCEPT/DEFER witness for the legacy YOLO confidence precedence.
// A top-level annotation threshold remains a latent runtime branch, but the normal viewer domain
// and its authed/demo/create-response serializers omit that DB field while retaining
// data.confidence. Keep comparison semantics unchanged unless a normal-wire defect is reproduced.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

interface RuntimeYoloAnnotation {
  readonly threshold?: number | null;
  readonly data?: { readonly confidence?: number | null } | null;
}

function legacyConfidence(annotation: RuntimeYoloAnnotation): number {
  return annotation.threshold || annotation.data?.confidence || 0;
}

function parse(relativePath: string): ts.SourceFile {
  const text = readFileSync(join(process.cwd(), relativePath), "utf8");
  return ts.createSourceFile(
    relativePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
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

function propertyName(property: ts.ObjectLiteralElementLike | ts.TypeElement): string {
  const name = property.name;
  if (!name) return "";
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return name.getText();
}

function namedProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment {
  const property = object.properties.find((candidate) => propertyName(candidate) === name);
  if (!property || !ts.isPropertyAssignment(property)) {
    throw new Error(`Expected property ${name}`);
  }
  return property;
}

function returnedObject(functionNode: ts.FunctionDeclaration): ts.ObjectLiteralExpression {
  const returns = collect(functionNode, ts.isReturnStatement);
  if (returns.length !== 1 || !returns[0].expression) {
    throw new Error("Expected one returned object");
  }
  let expression = returns[0].expression;
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  if (!ts.isObjectLiteralExpression(expression)) throw new Error("Expected object return");
  return expression;
}

function mapperObject(call: ts.CallExpression): ts.ObjectLiteralExpression {
  const mapper = call.arguments[0];
  if (!mapper || !ts.isArrowFunction(mapper) || ts.isBlock(mapper.body)) {
    throw new Error("Expected expression-bodied mapper");
  }
  let expression = mapper.body;
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  if (!ts.isObjectLiteralExpression(expression)) throw new Error("Expected mapper object");
  return expression;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const OVERLAY = parse("src/components/viewer/AnnotationOverlay.tsx");
const TYPES = parse("src/types/index.ts");
const PAGES = parse("src/server/services/pages.ts");
const ANNOTATIONS_SERVICE = parse("src/server/services/annotations.ts");
const YOLO_SERVICE = parse("src/server/services/yolo.ts");
const ANNOTATIONS_FACADE = parse("src/queries/useAnnotations.ts");

const CLIENT_KEYS = ["id", "pageNumber", "name", "bbox", "note", "source", "data"];

describe("AnnotationOverlay YOLO threshold reachability freeze", () => {
  it("keeps the legacy top-level threshold as a latent runtime precedence branch", () => {
    const confDeclarations = collect(OVERLAY, ts.isVariableDeclaration).filter(
      (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "conf",
    );
    expect(confDeclarations).toHaveLength(1);
    const initializer = confDeclarations[0].initializer;
    if (!initializer) throw new Error("Expected confidence initializer");
    const expression = initializer.getText(OVERLAY);
    expect(expression).toBe("(a as any).threshold || (a as any).data?.confidence || 0");
    expect(Buffer.byteLength(expression, "utf8")).toBe(56);
    expect(sha256(expression)).toBe(
      "6822d176bdeb37c22530b2ad9dc0a377ee48f956cd8c4439d235ef4777bf3bb5",
    );

    const persistedZero = { threshold: 0, data: { confidence: 0.83 } } as const;
    expect(legacyConfidence(persistedZero)).toBe(0.83);
    expect(legacyConfidence({ threshold: 0.21, data: { confidence: 0.83 } })).toBe(0.21);
    expect(legacyConfidence({ data: { confidence: 0 } })).toBe(0);

    const normalWire = { data: persistedZero.data } as const;
    expect(Object.hasOwn(normalWire, "threshold")).toBe(false);
    expect(legacyConfidence(normalWire)).toBe(0.83);
  });

  it("omits persisted threshold from every normal viewer projection and retains data.confidence", () => {
    const annotationData = collect(TYPES, ts.isTypeAliasDeclaration).filter(
      (declaration) => declaration.name.text === "AnnotationData",
    );
    expect(annotationData).toHaveLength(1);
    const annotationDataText = annotationData[0].getText(TYPES);
    expect(annotationDataText).toContain("confidence?: number;");
    expect(Buffer.byteLength(annotationDataText, "utf8")).toBe(405);
    expect(sha256(annotationDataText)).toBe(
      "bc167cea35f19da6320113a693124178d93a92685cd7afe2d2ce2587a8e828d8",
    );

    const clientAnnotations = collect(TYPES, ts.isInterfaceDeclaration).filter(
      (declaration) => declaration.name.text === "ClientAnnotation",
    );
    expect(clientAnnotations).toHaveLength(1);
    expect(clientAnnotations[0].members.map(propertyName)).toEqual(CLIENT_KEYS);
    const clientText = clientAnnotations[0].getText(TYPES);
    expect(Buffer.byteLength(clientText, "utf8")).toBe(346);
    expect(sha256(clientText)).toBe(
      "55f88f688a989f25d2383bcc1e0270bbef0031fe7d0bf224942814b6ded3dd74",
    );

    const drafts = collect(ANNOTATIONS_FACADE, ts.isTypeAliasDeclaration).filter(
      (declaration) => declaration.name.text === "NewAnnotationDraft",
    );
    expect(drafts).toHaveLength(1);
    const draftText = drafts[0].getText(ANNOTATIONS_FACADE);
    expect(draftText).not.toContain("threshold");
    expect(Buffer.byteLength(draftText, "utf8")).toBe(152);
    expect(sha256(draftText)).toBe(
      "25a24fc2c139b7fc9fac07e4049791e6e168174ad3cb59333829171cba98b3dd",
    );

    const persistedPushes = collect(YOLO_SERVICE, ts.isCallExpression).filter((call) =>
      ts.isPropertyAccessExpression(call.expression) &&
      call.expression.expression.getText(YOLO_SERVICE) === "allValues" &&
      call.expression.name.text === "push"
    );
    expect(persistedPushes).toHaveLength(1);
    const persisted = persistedPushes[0].arguments[0];
    if (!persisted || !ts.isObjectLiteralExpression(persisted)) {
      throw new Error("Expected persisted YOLO object");
    }
    expect(namedProperty(persisted, "threshold").initializer.getText(YOLO_SERVICE)).toBe(
      "det.confidence",
    );
    const data = namedProperty(persisted, "data").initializer;
    if (!ts.isObjectLiteralExpression(data)) throw new Error("Expected YOLO data object");
    expect(namedProperty(data, "confidence").initializer.getText(YOLO_SERVICE)).toBe(
      "det.confidence",
    );
    const persistedText = persisted.getText(YOLO_SERVICE);
    expect(Buffer.byteLength(persistedText, "utf8")).toBe(586);
    expect(sha256(persistedText)).toBe(
      "4d13c8c0ec8079c92178b9f8adecfdc26f76a1635e68509f8e80cff739c5fa4d",
    );

    const windowMappers = collect(PAGES, ts.isCallExpression)
      .filter((call) =>
        ts.isPropertyAccessExpression(call.expression) &&
        call.expression.expression.getText(PAGES) === "rangeAnnotations" &&
        call.expression.name.text === "map"
      )
      .map(mapperObject);
    expect(windowMappers).toHaveLength(2);
    for (const projection of windowMappers) {
      expect(projection.properties.map(propertyName)).toEqual(CLIENT_KEYS);
      expect(namedProperty(projection, "data").initializer.getText(PAGES)).toBe("a.data ?? null");
      const projectionText = projection.getText(PAGES);
      expect(Buffer.byteLength(projectionText, "utf8")).toBe(223);
      expect(sha256(projectionText)).toBe(
        "f954f6768b49c05dc188369b828dd42859e9be4eb548888a477f29308352cecc",
      );
    }

    const responseMappers = collect(ANNOTATIONS_SERVICE, ts.isFunctionDeclaration).filter(
      (declaration) => declaration.name?.text === "toClientAnnotation",
    );
    expect(responseMappers).toHaveLength(1);
    const responseProjection = returnedObject(responseMappers[0]);
    expect(responseProjection.properties.map(propertyName)).toEqual(CLIENT_KEYS);
    expect(namedProperty(responseProjection, "data").initializer.getText(ANNOTATIONS_SERVICE)).toBe(
      "a.data ?? null",
    );
    const responseText = responseMappers[0].getText(ANNOTATIONS_SERVICE);
    expect(Buffer.byteLength(responseText, "utf8")).toBe(308);
    expect(sha256(responseText)).toBe(
      "02f9b21dfd2272f660d564ade0fd494fd5d3914d6b3f73b5d1e0f1582f3bf7ee",
    );
  });
});
