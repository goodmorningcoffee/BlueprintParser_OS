// @vitest-environment jsdom
//
// [refactor jul15 P3.1½] BEHAVIOR + TOPOLOGY freeze for the shared hit-test extraction.
// Lands GREEN as a test-only commit BEFORE any production movement (SPEC §"Test-first freeze").
// It does NOT import src/components/viewer/hitTest.ts (that module does not exist yet at the
// freeze commit). The pure-helper RED->GREEN test is a SEPARATE follow-on file landed with the
// implementation commit; it reuses the CASE TABLES below verbatim against the real exports.
//
// Three layers:
//   A. PURE-MATH truth table — inline byte-copies of the live formulas, asserted against
//      hand-computed + node-verified expected values. Freezes the numeric contract.
//   B. LIVE SOURCE topology pins — readFileSync snapshot of the POST-move topology (2 withHoles /
//      2 polyline / 3 bbox / 3 handle helper calls, old inline math absent, pure dependency-free
//      hitTest leaf). The freeze commit (e33642e) pinned the PRE-move inline math; the mechanical
//      move commit rewrote this block as planned. Layers A and C are UNCHANGED across the move.
//   C. REAL-OVERLAY witnesses — jsdom + the real AnnotationOverlay, entered through the production
//      mousedown handler, proving the legacy single-click bbox-fallback and double-click
//      shape-exclusive-miss behaviors that SPEC §"Legacy behavior" requires preserved.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { resetProjectData } from "@/stores/viewerCommands";
import { useUiStore } from "@/stores/uiStore";
import { seedAnnotations } from "@/test/seed-annotations";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";
import type { ClientAnnotation } from "@/types";

vi.mock("../DrawingPreviewLayer", () => ({ default: () => null }));
vi.mock("../MarkupDialog", () => ({ default: () => null }));

import AnnotationOverlay from "../AnnotationOverlay";

// ─────────────────────────────────────────────────────────────────────────────
// Inline byte-copies of the four live formulas (readonly types only). These are the
// authoritative expected-behavior oracle for layer A and the reusable table for the
// post-implementation pure-helper test.
// ─────────────────────────────────────────────────────────────────────────────
type Pt = Readonly<{ x: number; y: number }>;

// areaCalc.ts:82-99
function rayCastPointInPolygon(point: Pt, vertices: readonly Pt[]): boolean {
  const n = vertices.length;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = vertices[i].x, yi = vertices[i].y;
    const xj = vertices[j].x, yj = vertices[j].y;
    if (
      ((yi > point.y) !== (yj > point.y)) &&
      (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi)
    ) {
      inside = !inside;
    }
  }
  return inside;
}

// AnnotationOverlay.tsx:2005-2008 / 2228-2230
function pointInPolygonWithHoles(
  point: Pt,
  outer: readonly Pt[],
  holes?: readonly (readonly Pt[])[],
): boolean {
  if (!rayCastPointInPolygon(point, outer)) return false;
  return !(holes ?? []).some((h) => rayCastPointInPolygon(point, h));
}

// AnnotationOverlay.tsx:2242-2253
function pointNearPolyline(
  pointPx: Pt,
  vertices: readonly Pt[],
  pageWidth: number,
  pageHeight: number,
  thresholdPx = 8,
): boolean {
  for (let i = 0; i < vertices.length - 1; i++) {
    const ax = vertices[i].x * pageWidth;
    const ay = vertices[i].y * pageHeight;
    const bx = vertices[i + 1].x * pageWidth;
    const by = vertices[i + 1].y * pageHeight;
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((pointPx.x - ax) * dx + (pointPx.y - ay) * dy) / lenSq));
    const projX = ax + t * dx, projY = ay + t * dy;
    const dist = Math.sqrt((pointPx.x - projX) ** 2 + (pointPx.y - projY) ** 2);
    if (dist < thresholdPx) return true;
  }
  return false;
}

// AnnotationOverlay.tsx:2022-2024 / 2263-2268 / 2362-2367 (MIN-PLUS-EXTENT)
function pointInNormalizedBbox(
  pointPx: Pt,
  bbox: readonly [number, number, number, number],
  pageWidth: number,
  pageHeight: number,
): boolean {
  const [minX, minY, maxX, maxY] = bbox;
  const ax = minX * pageWidth;
  const ay = minY * pageHeight;
  return (
    pointPx.x >= ax &&
    pointPx.x <= ax + (maxX - minX) * pageWidth &&
    pointPx.y >= ay &&
    pointPx.y <= ay + (maxY - minY) * pageHeight
  );
}

// AnnotationOverlay.tsx:2155 / 2176 / 2341 (HANDLE=8, AO:1465)
function pointInHandle(pointPx: Pt, centerPx: Pt, halfExtentPx = 8): boolean {
  return (
    Math.abs(pointPx.x - centerPx.x) < halfExtentPx &&
    Math.abs(pointPx.y - centerPx.y) < halfExtentPx
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// LAYER A — PURE-MATH truth table (node-verified expected values)
// ═════════════════════════════════════════════════════════════════════════════
describe("A. polygon ray-cast (inline copy of areaCalc.ts:82-99)", () => {
  // Vertex order fixes the boundary tie-break; freeze uses this exact order.
  const UNIT_SQ: readonly Pt[] = [
    { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 },
  ];

  it("interior hits, exterior misses", () => {
    expect(rayCastPointInPolygon({ x: 0.5, y: 0.5 }, UNIT_SQ)).toBe(true);
    expect(rayCastPointInPolygon({ x: 2, y: 0.5 }, UNIT_SQ)).toBe(false);
  });

  it("freezes the asymmetric square-edge rule: left/top IN, right/bottom OUT", () => {
    expect(rayCastPointInPolygon({ x: 0, y: 0.5 }, UNIT_SQ)).toBe(true); // left edge IN
    expect(rayCastPointInPolygon({ x: 0.5, y: 0 }, UNIT_SQ)).toBe(true); // top edge IN
    expect(rayCastPointInPolygon({ x: 1, y: 0.5 }, UNIT_SQ)).toBe(false); // right edge OUT
    expect(rayCastPointInPolygon({ x: 0.5, y: 1 }, UNIT_SQ)).toBe(false); // bottom edge OUT
  });

  it("freezes corner asymmetry: only the top-left corner is IN", () => {
    expect(rayCastPointInPolygon({ x: 0, y: 0 }, UNIT_SQ)).toBe(true); // TL IN
    expect(rayCastPointInPolygon({ x: 1, y: 0 }, UNIT_SQ)).toBe(false); // TR OUT
    expect(rayCastPointInPolygon({ x: 0, y: 1 }, UNIT_SQ)).toBe(false); // BL OUT
    expect(rayCastPointInPolygon({ x: 1, y: 1 }, UNIT_SQ)).toBe(false); // BR OUT
  });

  it("handles concavity: notch point OUT, solid point IN", () => {
    const CONCAVE: readonly Pt[] = [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 5, y: 5 }, { x: 0, y: 10 },
    ];
    expect(rayCastPointInPolygon({ x: 5, y: 2 }, CONCAVE)).toBe(true); // solid
    expect(rayCastPointInPolygon({ x: 5, y: 8 }, CONCAVE)).toBe(false); // inside the V-notch
  });

  it("degenerate 0/1/2-vertex polygons always return false", () => {
    expect(rayCastPointInPolygon({ x: 0.5, y: 0.5 }, [])).toBe(false);
    expect(rayCastPointInPolygon({ x: 0.5, y: 0.5 }, [{ x: 0.5, y: 0.5 }])).toBe(false);
    const seg: readonly Pt[] = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    expect(rayCastPointInPolygon({ x: 0.5, y: 0.5 }, seg)).toBe(false); // on the segment
    expect(rayCastPointInPolygon({ x: 0.4, y: 0.5 }, seg)).toBe(false); // off the segment
  });

  it("with-holes = outer AND no hole", () => {
    const outer: readonly Pt[] = [
      { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 },
    ];
    const hole: readonly Pt[] = [
      { x: 0.4, y: 0.4 }, { x: 0.6, y: 0.4 }, { x: 0.6, y: 0.6 }, { x: 0.4, y: 0.6 },
    ];
    expect(pointInPolygonWithHoles({ x: 0.5, y: 0.5 }, outer, [hole])).toBe(false); // in hole
    expect(pointInPolygonWithHoles({ x: 0.2, y: 0.5 }, outer, [hole])).toBe(true); // outer, not hole
    expect(pointInPolygonWithHoles({ x: 0.5, y: 0.5 }, outer)).toBe(true); // no holes arg
    expect(pointInPolygonWithHoles({ x: 0.5, y: 0.5 }, outer, [])).toBe(true); // empty holes
    expect(pointInPolygonWithHoles({ x: 2, y: 0.5 }, outer, [hole])).toBe(false); // outside outer
  });
});

describe("A. polyline point-near (inline copy of AnnotationOverlay.tsx:2242-2253)", () => {
  const HORZ: readonly Pt[] = [{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }]; // px (20,50)-(80,50)

  it("strict < 8 hits, exactly 8 misses", () => {
    expect(pointNearPolyline({ x: 50, y: 50 }, HORZ, 100, 100)).toBe(true); // dist 0
    expect(pointNearPolyline({ x: 50, y: 57 }, HORZ, 100, 100)).toBe(true); // dist 7 < 8
    expect(pointNearPolyline({ x: 50, y: 58 }, HORZ, 100, 100)).toBe(false); // dist 8 (not <)
  });

  it("clamps the projection beyond BOTH endpoints", () => {
    expect(pointNearPolyline({ x: 14, y: 50 }, HORZ, 100, 100)).toBe(true); // 6px past start
    expect(pointNearPolyline({ x: 10, y: 50 }, HORZ, 100, 100)).toBe(false); // 10px past start
    expect(pointNearPolyline({ x: 86, y: 50 }, HORZ, 100, 100)).toBe(true); // 6px past end
  });

  it("zero-length segment uses t=0 and still measures distance to that point", () => {
    const ZERO: readonly Pt[] = [{ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }]; // px (50,50)-(50,50)
    expect(pointNearPolyline({ x: 53, y: 54 }, ZERO, 100, 100)).toBe(true); // dist 5
    expect(pointNearPolyline({ x: 58, y: 50 }, ZERO, 100, 100)).toBe(false); // dist 8
  });

  it("scales x by pageWidth and y by pageHeight independently (anisotropic)", () => {
    // px (50,50)-(100,50); y measured against page HEIGHT, not width.
    const seg: readonly Pt[] = [{ x: 0.25, y: 0.5 }, { x: 0.5, y: 0.5 }];
    expect(pointNearPolyline({ x: 75, y: 54 }, seg, 200, 100)).toBe(true); // dist 4 to y=50
    // If y were scaled by pageWidth (200), the line would sit at y=100 and this would miss.
  });

  it("iterates to a later segment", () => {
    const L: readonly Pt[] = [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.1 }, { x: 0.2, y: 0.9 }];
    expect(pointNearPolyline({ x: 24, y: 50 }, L, 100, 100)).toBe(true); // hits segment i=1
  });

  it("fewer than two vertices never hits", () => {
    expect(pointNearPolyline({ x: 50, y: 50 }, [], 100, 100)).toBe(false);
    expect(pointNearPolyline({ x: 50, y: 50 }, [{ x: 0.5, y: 0.5 }], 100, 100)).toBe(false);
  });
});

describe("A. normalized bbox min-plus-extent (inline copy of AnnotationOverlay.tsx:2263-2268)", () => {
  const BOX = [0.2, 0.3, 0.6, 0.7] as const; // px (20,30)-(60,70)

  it("inclusive edges and corners", () => {
    expect(pointInNormalizedBbox({ x: 40, y: 50 }, BOX, 100, 100)).toBe(true); // interior
    expect(pointInNormalizedBbox({ x: 20, y: 50 }, BOX, 100, 100)).toBe(true); // left edge
    expect(pointInNormalizedBbox({ x: 60, y: 50 }, BOX, 100, 100)).toBe(true); // right edge
    expect(pointInNormalizedBbox({ x: 40, y: 30 }, BOX, 100, 100)).toBe(true); // top edge
    expect(pointInNormalizedBbox({ x: 40, y: 70 }, BOX, 100, 100)).toBe(true); // bottom edge
    expect(pointInNormalizedBbox({ x: 20, y: 30 }, BOX, 100, 100)).toBe(true); // TL corner
    expect(pointInNormalizedBbox({ x: 60, y: 70 }, BOX, 100, 100)).toBe(true); // BR corner
  });

  it("just-outside misses", () => {
    expect(pointInNormalizedBbox({ x: 19.9, y: 50 }, BOX, 100, 100)).toBe(false);
    expect(pointInNormalizedBbox({ x: 60.1, y: 50 }, BOX, 100, 100)).toBe(false);
  });

  it("scales width/height anisotropically", () => {
    const B = [0.1, 0.1, 0.2, 0.2] as const; // pw=200,ph=100 => px (20,10)-(40,20)
    expect(pointInNormalizedBbox({ x: 30, y: 15 }, B, 200, 100)).toBe(true);
    expect(pointInNormalizedBbox({ x: 30, y: 25 }, B, 200, 100)).toBe(false); // y beyond 20
    expect(pointInNormalizedBbox({ x: 45, y: 15 }, B, 200, 100)).toBe(false); // x beyond 40
  });

  it("zero-size box hits its exact point only", () => {
    const Z = [0.5, 0.5, 0.5, 0.5] as const; // px point (50,50)
    expect(pointInNormalizedBbox({ x: 50, y: 50 }, Z, 100, 100)).toBe(true);
    expect(pointInNormalizedBbox({ x: 50.001, y: 50 }, Z, 100, 100)).toBe(false);
  });

  it("inverted box (max<min) yields an empty range => never hits", () => {
    const INV = [0.6, 0.7, 0.2, 0.3] as const; // negative extents
    expect(pointInNormalizedBbox({ x: 40, y: 50 }, INV, 100, 100)).toBe(false);
    expect(pointInNormalizedBbox({ x: 60, y: 70 }, INV, 100, 100)).toBe(false); // even at the min
    // A reorder-MinMax implementation would (wrongly) treat this as a valid [0.2,0.6]x[0.3,0.7]
    // box and hit (40,50). Min-plus-extent must MISS. This case is the discriminator.
  });
});

describe("A. handle open-square (inline copy of AnnotationOverlay.tsx:2155)", () => {
  const C: Pt = { x: 50, y: 50 };

  it("diagonal (7.9,7.9) hits though its Euclidean distance ~11.17 > 8", () => {
    expect(pointInHandle({ x: 57.9, y: 57.9 }, C)).toBe(true);
    expect(Math.hypot(7.9, 7.9)).toBeGreaterThan(8);
  });

  it("exactly 8 on either axis misses (strict, independent axes)", () => {
    expect(pointInHandle({ x: 58, y: 50 }, C)).toBe(false); // dx=8
    expect(pointInHandle({ x: 50, y: 58 }, C)).toBe(false); // dy=8
    expect(pointInHandle({ x: 57.9, y: 50 }, C)).toBe(true); // dx=7.9
    expect(pointInHandle({ x: 58, y: 58 }, C)).toBe(false); // both = 8
  });

  it("first-hit order is CALLER-owned: pointInHandle is order-agnostic per candidate", () => {
    // The live corner loops iterate a fixed tl->tr->bl->br object and return the FIRST match;
    // the predicate itself owns no order. Two overlapping handles both match => the caller's
    // enumeration order decides. Reproduce the caller's contract here.
    const corners = {
      tl: { x: 50, y: 50 }, tr: { x: 55, y: 50 }, bl: { x: 50, y: 55 }, br: { x: 55, y: 55 },
    };
    const p: Pt = { x: 52.5, y: 52.5 }; // within 8px of all four centers
    expect(Object.values(corners).every((c) => pointInHandle(p, c))).toBe(true);
    const firstHit = Object.entries(corners).find(([, c]) => pointInHandle(p, c))?.[0];
    expect(firstHit).toBe("tl"); // caller loop order, not the predicate
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// LAYER B — LIVE SOURCE topology pins (PRE-move snapshot).
// The mechanical-move commit REWRITES this describe block to the POST-move topology.
// ═════════════════════════════════════════════════════════════════════════════
describe("B. live-source topology pins (post-move: pure hitTest leaf + rewired call sites)", () => {
  const AO = readFileSync(
    join(process.cwd(), "src/components/viewer/AnnotationOverlay.tsx"),
    "utf8",
  );
  const AREACALC = readFileSync(
    join(process.cwd(), "src/lib/areaCalc.ts"),
    "utf8",
  );
  const HITTEST = readFileSync(
    join(process.cwd(), "src/components/viewer/hitTest.ts"),
    "utf8",
  );
  const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;
  const squish = (s: string): string => s.replace(/\s+/g, " ").trim();

  it("pins the pure dependency-free hitTest leaf and the rewired AO imports", () => {
    expect(HITTEST).not.toMatch(/^import /m); // no imports at all: pure leaf
    expect(AO).toContain(
      'import { pointInPolygonWithHoles, pointNearPolyline, pointInNormalizedBbox, pointInHandle } from "./hitTest";',
    );
    // areaCalc no longer exports the ray cast; AO no longer imports it from there
    expect(AREACALC).not.toContain("export function pointInPolygon(");
    expect(AO).toContain(
      'import { polygonCentroid, computeRealArea, computePolylineLength, computePixelsPerUnit } from "@/lib/areaCalc";',
    );
  });

  it("pins helper call counts 2 withHoles / 2 polyline / 3 bbox / 3 handle", () => {
    expect(count(AO, "pointInPolygonWithHoles(")).toBe(2); // double-click + single area loop
    expect(count(AO, "pointNearPolyline(")).toBe(2); // double-click + single line loop
    expect(count(AO, "pointInNormalizedBbox(")).toBe(3); // double-click else + generic + markup
    expect(count(AO, "pointInHandle(")).toBe(3); // vertices + pointer corners + markup corners
  });

  it("pins the old inline math ABSENT from the targeted branches", () => {
    expect(count(AO, "pointInPolygon(clickNorm")).toBe(0);
    expect(count(AO, "if (dist2 < 8) { hit = true; break; }")).toBe(0);
    expect(count(AO, "const threshold = 8; // pixels")).toBe(0);
    expect(count(AO, "if (dist < threshold) { hit = true; break; }")).toBe(0);
    expect(count(AO, "pos.x <= ax + (maxX - minX) * width")).toBe(0);
    expect(count(AO, "ax + aw")).toBe(0);
    expect(count(AO, "< HANDLE && Math.abs(")).toBe(0);
  });

  it("pins exactly THREE residual mousedown Math.sqrt sites (polygon close / linear finish / count marker)", () => {
    // Census §"Explicitly excluded": these are draw-placement thresholds, NOT hit-test targets.
    expect(count(AO, "Math.sqrt")).toBe(3);
  });

  it("pins the corner handle enumeration order tl -> tr -> bl -> br at both sites", () => {
    expect(count(AO, "tl: { x: minX * width, y: minY * height },")).toBe(2);
  });

  it("pins the distinct double-click (one else-if loop) vs single-click (three ordered loops) shape", () => {
    const idxDouble = AO.indexOf("// Double-click: universal annotation filter");
    const idxArea = AO.indexOf("// Check area polygons first");
    const idxLine = AO.indexOf("// Check linear polylines (point-near-line test)");
    const idxBbox = AO.indexOf("// Check annotations (bbox-based) — select and start drag");
    expect(idxDouble).toBeGreaterThan(-1);
    // Single-click order: area -> linear -> generic bbox, three SEPARATE loops.
    expect(idxArea).toBeGreaterThan(idxDouble);
    expect(idxLine).toBeGreaterThan(idxArea);
    expect(idxBbox).toBeGreaterThan(idxLine);
    // Double-click is one loop with an else-if chain (shape-exclusive).
    const dblBlock = AO.slice(idxDouble, idxArea);
    expect(count(dblBlock, "for (const ann of pageAnnotations)")).toBe(1);
    expect(dblBlock).toContain('} else if (ann.source === "takeoff" && (ann.data as any)?.type === "linear-polyline") {');
    expect(dblBlock).toContain("if (!hit) continue;");
  });

  it("pins the exact handleMouseDown callback dependency list (must survive the move unchanged)", () => {
    const deps = squish(
      "[addBucketFillBarrier, addPolygonVertex, canAdoptProjectLifecycle, cancelDeferredDrawing, getPos, height, " +
      "isKeynoteYoloPicking, multiSelect, pageAnnotations, pageKeynotes, pageNumber, persistCreate, " +
      "projectDbId, publicId, publishTransientBucketFillError, publishTransientSplitError, qc, " +
      "saveLinearPolyline, savePolygon, selectedId, setActiveYoloTagId, setAnnotationFilter, " +
      "setKeynoteFilter, setPolygonDrawingMode, setSearch, setSplitLineEndpoint, " +
      "setSplitPreview, setTakeoffFilter, setYoloTagFilter, setYoloTagPickingMode, " +
      "showTableCellStructure, startDeferredDrawing, tableCellStructure, takeoffItems, " +
      "toggleCellHighlight, width, yoloTags]",
    );
    expect(squish(AO)).toContain(deps);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// LAYER C — REAL-OVERLAY legacy-behavior witnesses (jsdom + real AnnotationOverlay).
// Enter through the production mousedown handler; observe the store write it performs.
// Selection is LOCAL React state (setSelectedId), so the witness observes setSearch/
// setTakeoffFilter — the store writes on the bbox-fallback / double-click paths.
// ═════════════════════════════════════════════════════════════════════════════
const PUBLIC_ID = "hittest-fixture";

let queryClient: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function noopContext(): CanvasRenderingContext2D {
  const target = { measureText: () => ({ width: 0 }) };
  return new Proxy(target, {
    get(object, property) {
      if (property in object) return object[property as keyof typeof object];
      return () => {};
    },
    set(object, property, value) {
      Reflect.set(object, property, value);
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function canvasRect(): DOMRect {
  return {
    x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 100, width: 100, height: 100,
    toJSON: () => ({}),
  } as DOMRect;
}

// area-polygon covering px (10,10)-(90,90) with a central hole px (40,40)-(60,60).
const POLYGON_WITH_HOLE = {
  id: 1,
  pageNumber: 1,
  name: "Room 101",
  bbox: [0.1, 0.1, 0.9, 0.9],
  note: null,
  source: "takeoff",
  data: {
    type: "area-polygon",
    takeoffItemId: 7,
    color: "#ef4444",
    vertices: [
      { x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 },
    ],
    holes: [
      { vertices: [
        { x: 0.4, y: 0.4 }, { x: 0.6, y: 0.4 }, { x: 0.6, y: 0.6 }, { x: 0.4, y: 0.6 },
      ] },
    ],
    areaSqUnits: 0,
    unit: "sqft",
  },
} as unknown as ClientAnnotation;

// linear-polyline "⌐": px (20,20)-(80,20)-(80,80). Stored bbox is the bounding rect,
// whose interior (40,60) is >8px from BOTH segments.
const POLYLINE_L = {
  id: 2,
  pageNumber: 1,
  name: "Wall A",
  bbox: [0.2, 0.2, 0.8, 0.8],
  note: null,
  source: "takeoff",
  data: {
    type: "linear-polyline",
    takeoffItemId: 9,
    color: "#3b82f6",
    vertices: [
      { x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.8, y: 0.8 },
    ],
    totalLength: 0,
    unit: "ft",
    segmentLengths: [],
  },
} as unknown as ClientAnnotation;

function seedRealOverlay(rows: ClientAnnotation[]): void {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  resetProjectData();
  setViewerStoreStateForTest({
    projectId: 41,
    publicId: PUBLIC_ID,
    isDemo: true,
    pageNumber: 1,
    numPages: 1,
    pageNames: { 1: "A-101" },
    mode: "pointer", // the single/double-click selection loops are gated on pointer|group
    activeTool: null,
    _drawing: false,
    _drawStart: { x: 0, y: 0 },
    _drawEnd: { x: 0, y: 0 },
  });
  seedAnnotations(queryClient, rows);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(noopContext());
}

async function mountCanvas() {
  const { container } = render(
    <AnnotationOverlay width={100} height={100} cssScale={1} />,
    { wrapper },
  );
  const canvas = await waitFor(() => {
    const candidate = container.querySelector("canvas");
    if (!(candidate instanceof HTMLCanvasElement)) {
      throw new Error("Expected AnnotationOverlay canvas");
    }
    return candidate;
  });
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(canvasRect());
  return canvas;
}

function press(canvas: HTMLCanvasElement, clientX: number, clientY: number, detail = 1): void {
  act(() => {
    fireEvent.mouseDown(canvas, { clientX, clientY, button: 0, detail });
  });
}

describe("C. real-overlay legacy hit-test witnesses", () => {
  afterEach(() => {
    cleanup();
    queryClient?.clear();
    vi.restoreAllMocks();
  });

  it("(a) single-click INSIDE a polygon hole still selects the polygon via bbox fallback", async () => {
    seedRealOverlay([POLYGON_WITH_HOLE]);
    const canvas = await mountCanvas();
    // Sanity: not selected yet (bbox path writes searchQuery; the area loop would NOT).
    expect(useUiStore.getState().searchQuery).toBe("");
    press(canvas, 50, 50); // px (50,50) => inside the hole
    // Area loop: outer HIT but insideHole => continue (no setSearch). Line loop: skipped.
    // Generic bbox loop: (50,50) is inside stored bbox => setSelectedId + setSearch(name).
    // searchQuery is set ONLY by the bbox path, so this uniquely proves the fallback fired.
    expect(useUiStore.getState().searchQuery).toBe("Room 101");
  });

  it("(b) single-click AWAY from a polyline but inside its stored bbox selects it", async () => {
    seedRealOverlay([POLYLINE_L]);
    const canvas = await mountCanvas();
    press(canvas, 40, 60); // >8px from both segments, inside bounding bbox
    expect(useUiStore.getState().searchQuery).toBe("Wall A");
  });

  it("(c) double-click inside a polygon hole does NOT trigger the polygon's double-click action", async () => {
    seedRealOverlay([POLYGON_WITH_HOLE]);
    const canvas = await mountCanvas();

    // Shape-exclusive MISS: the area-polygon branch computes hit=false (hole) and the else-if
    // chain never retries the bbox. No takeoff filter / search is set.
    press(canvas, 50, 50, 2); // px (50,50) inside hole, detail=2
    expect(useUiStore.getState().searchQuery).toBe("");
    expect(useUiStore.getState().activeTakeoffFilter).toBe(null);

    // Contrast: a double-click on the polygon BODY (not the hole) DOES fire the action,
    // proving the miss above is genuine shape-exclusion, not a dead handler.
    press(canvas, 20, 50, 2); // px (20,50) inside outer, outside hole
    expect(useUiStore.getState().searchQuery).toBe("Room 101");
    expect(useUiStore.getState().activeTakeoffFilter).toBe(7);
  });
});
