// @vitest-environment node
//
// [refactor jul18 P3 draw #5] Exact two-gate TATR canvas reachability seam. Normalizing only the
// sanctioned inline predicates back to the accepted parent freezes the complete pre-group driver,
// dependency, pass, and canvas gate; the companion group-ring suite pins the extracted final pass.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const AO = readFileSync(
  join(process.cwd(), "src/components/viewer/AnnotationOverlay.tsx"),
  "utf8",
);
const PREDICATE =
  "showTableCellStructure && tableCellStructure?.pageNumber === pageNumber";
const NEGATED = ` && !(${PREDICATE})`;
const POSITIVE = ` || (${PREDICATE})`;

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function exactSlice(source: string, startAnchor: string, endAnchor: string): string {
  expect(count(source, startAnchor)).toBe(1);
  expect(count(source, endAnchor)).toBe(1);
  const start = source.indexOf(startAnchor);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

const DRAW = exactSlice(AO, "  // Draw annotations\n", "  const getPos");
const GATES = exactSlice(
  AO,
  "  // Canvas gates — single source of truth",
  "  let canvasCursor",
);

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

describe("AnnotationOverlay TATR draw/mount gate topology", () => {
  it("places the exact page-aware predicate once in each sanctioned gate", () => {
    expect(count(AO, PREDICATE)).toBe(2);
    expect(count(DRAW, NEGATED)).toBe(1);
    expect(count(DRAW, POSITIVE)).toBe(0);
    expect(count(GATES, NEGATED)).toBe(0);
    expect(count(GATES, POSITIVE)).toBe(1);

    expect(DRAW).toContain(
      `        && !symbolSearchResults && !llmHighlight${NEGATED}) {\n` +
      "      return;",
    );
    expect(GATES).toContain(
      "    pendingMarkup !== null ||\n" +
      `    canvasWantsEvents${POSITIVE}\n` +
      "  );\n" +
      "  if (!canvasShouldRender) return null;",
    );
  });

  it("keeps the complete pre-group driver byte-exact through the first pure extraction", () => {
    const prefix = exactSlice(
      AO,
      "  // Draw annotations\n",
      "    // Group-membership outlines",
    );
    expect(count(prefix, NEGATED)).toBe(1);
    expect(Buffer.byteLength(prefix, "utf8")).toBe(20_544);
    expect(sha256(prefix)).toBe(
      "0aeebfb7aa93775e40467341edd958e38f9dc0a6413ee07982e59644b1cfc9e1",
    );
  });

  it("normalizes the whole canvas gate to the exact accepted parent bytes", () => {
    expect(count(GATES, POSITIVE)).toBe(1);
    const normalized = GATES.replace(POSITIVE, "");
    expect(Buffer.byteLength(normalized, "utf8")).toBe(538);
    expect(sha256(normalized)).toBe(
      "75992a223bb98a4c1bd340b1c75b7385ff3ad916921089bceb8a4f8a1124c40d",
    );
  });

  it("keeps AnnotationOverlay at the exact 2,122-line architecture ceiling", () => {
    expect(count(AO, "\n")).toBe(2_122);
  });
});
