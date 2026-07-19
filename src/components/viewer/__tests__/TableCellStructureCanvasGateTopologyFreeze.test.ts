// @vitest-environment node
//
// [refactor jul18 P3 draw #5] Exact two-gate TATR canvas reachability seam. Normalizing only the
// sanctioned inline predicates back to the accepted parent freezes every other draw-effect byte,
// dependency, pass, and canvas gate while following AO's exact ratcheted architecture ceiling.

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

  it("normalizes the whole draw effect to the exact accepted parent bytes", () => {
    expect(count(DRAW, NEGATED)).toBe(1);
    const normalized = DRAW.replace(NEGATED, "");
    expect(Buffer.byteLength(normalized, "utf8")).toBe(21_678);
    expect(sha256(normalized)).toBe(
      "c474fa79180707320dddc0245dabb35d4553970fe49bfb6b57c8b95c06c24603",
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

  it("keeps AnnotationOverlay at the exact 2,734-line architecture ceiling", () => {
    expect(count(AO, "\n")).toBe(2_734);
  });
});
