// @vitest-environment node
//
// [refactor jul15 P3.1½] Pure-helper contract test for src/components/viewer/hitTest.ts.
// SPEC §"Test-first freeze": this file is RED when it first imports the missing module, GREEN
// after the implementation lands. It REUSES the frozen case table from
// HitTestBehaviorFreeze.test.tsx Layer A verbatim (same inputs, same expected values) against the
// real exports — no new policy is invented here. If a case value here ever disagrees with the
// freeze file, that is a defect in whichever file was edited, not a judgment call.
//
// One sanctioned API deviation from SPEC §"Pure API" (DR010 bind (c), zero-new-allocation):
// pointInPolygonWithHoles takes the live `{ vertices }[]` hole shape structurally, so call sites
// pass `data.holes` directly instead of allocating `data.holes?.map(h => h.vertices)` per click.

import { describe, expect, it } from "vitest";
import {
  pointInHandle,
  pointInNormalizedBbox,
  pointInPolygon,
  pointInPolygonWithHoles,
  pointNearPolyline,
  type HitPoint,
} from "../hitTest";

describe("hitTest.pointInPolygon (ray cast lifted verbatim from areaCalc.ts)", () => {
  const UNIT_SQ: readonly HitPoint[] = [
    { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 },
  ];

  it("interior hits, exterior misses", () => {
    expect(pointInPolygon({ x: 0.5, y: 0.5 }, UNIT_SQ)).toBe(true);
    expect(pointInPolygon({ x: 2, y: 0.5 }, UNIT_SQ)).toBe(false);
  });

  it("keeps the asymmetric square-edge rule: left/top IN, right/bottom OUT", () => {
    expect(pointInPolygon({ x: 0, y: 0.5 }, UNIT_SQ)).toBe(true); // left edge IN
    expect(pointInPolygon({ x: 0.5, y: 0 }, UNIT_SQ)).toBe(true); // top edge IN
    expect(pointInPolygon({ x: 1, y: 0.5 }, UNIT_SQ)).toBe(false); // right edge OUT
    expect(pointInPolygon({ x: 0.5, y: 1 }, UNIT_SQ)).toBe(false); // bottom edge OUT
  });

  it("keeps corner asymmetry: only the top-left corner is IN", () => {
    expect(pointInPolygon({ x: 0, y: 0 }, UNIT_SQ)).toBe(true); // TL IN
    expect(pointInPolygon({ x: 1, y: 0 }, UNIT_SQ)).toBe(false); // TR OUT
    expect(pointInPolygon({ x: 0, y: 1 }, UNIT_SQ)).toBe(false); // BL OUT
    expect(pointInPolygon({ x: 1, y: 1 }, UNIT_SQ)).toBe(false); // BR OUT
  });

  it("handles concavity: notch point OUT, solid point IN", () => {
    const CONCAVE: readonly HitPoint[] = [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 5, y: 5 }, { x: 0, y: 10 },
    ];
    expect(pointInPolygon({ x: 5, y: 2 }, CONCAVE)).toBe(true); // solid
    expect(pointInPolygon({ x: 5, y: 8 }, CONCAVE)).toBe(false); // inside the V-notch
  });

  it("degenerate 0/1/2-vertex polygons always return false", () => {
    expect(pointInPolygon({ x: 0.5, y: 0.5 }, [])).toBe(false);
    expect(pointInPolygon({ x: 0.5, y: 0.5 }, [{ x: 0.5, y: 0.5 }])).toBe(false);
    const seg: readonly HitPoint[] = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    expect(pointInPolygon({ x: 0.5, y: 0.5 }, seg)).toBe(false); // on the segment
    expect(pointInPolygon({ x: 0.4, y: 0.5 }, seg)).toBe(false); // off the segment
  });
});

describe("hitTest.pointInPolygonWithHoles (live {vertices}[] hole shape)", () => {
  const outer: readonly HitPoint[] = [
    { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 },
  ];
  const hole = {
    vertices: [
      { x: 0.4, y: 0.4 }, { x: 0.6, y: 0.4 }, { x: 0.6, y: 0.6 }, { x: 0.4, y: 0.6 },
    ] as readonly HitPoint[],
  };

  it("with-holes = outer AND no hole", () => {
    expect(pointInPolygonWithHoles({ x: 0.5, y: 0.5 }, outer, [hole])).toBe(false); // in hole
    expect(pointInPolygonWithHoles({ x: 0.2, y: 0.5 }, outer, [hole])).toBe(true); // outer, not hole
    expect(pointInPolygonWithHoles({ x: 0.5, y: 0.5 }, outer)).toBe(true); // no holes arg
    expect(pointInPolygonWithHoles({ x: 0.5, y: 0.5 }, outer, [])).toBe(true); // empty holes
    expect(pointInPolygonWithHoles({ x: 2, y: 0.5 }, outer, [hole])).toBe(false); // outside outer
  });
});

describe("hitTest.pointNearPolyline", () => {
  const HORZ: readonly HitPoint[] = [{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }]; // px (20,50)-(80,50)

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
    const ZERO: readonly HitPoint[] = [{ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }];
    expect(pointNearPolyline({ x: 53, y: 54 }, ZERO, 100, 100)).toBe(true); // dist 5
    expect(pointNearPolyline({ x: 58, y: 50 }, ZERO, 100, 100)).toBe(false); // dist 8
  });

  it("scales x by pageWidth and y by pageHeight independently (anisotropic)", () => {
    const seg: readonly HitPoint[] = [{ x: 0.25, y: 0.5 }, { x: 0.5, y: 0.5 }];
    expect(pointNearPolyline({ x: 75, y: 54 }, seg, 200, 100)).toBe(true); // dist 4 to y=50
  });

  it("iterates to a later segment", () => {
    const L: readonly HitPoint[] = [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.1 }, { x: 0.2, y: 0.9 }];
    expect(pointNearPolyline({ x: 24, y: 50 }, L, 100, 100)).toBe(true); // hits segment i=1
  });

  it("fewer than two vertices never hits", () => {
    expect(pointNearPolyline({ x: 50, y: 50 }, [], 100, 100)).toBe(false);
    expect(pointNearPolyline({ x: 50, y: 50 }, [{ x: 0.5, y: 0.5 }], 100, 100)).toBe(false);
  });
});

describe("hitTest.pointInNormalizedBbox (min-plus-extent)", () => {
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
    const Z = [0.5, 0.5, 0.5, 0.5] as const;
    expect(pointInNormalizedBbox({ x: 50, y: 50 }, Z, 100, 100)).toBe(true);
    expect(pointInNormalizedBbox({ x: 50.001, y: 50 }, Z, 100, 100)).toBe(false);
  });

  it("inverted box (max<min) yields an empty range => never hits", () => {
    const INV = [0.6, 0.7, 0.2, 0.3] as const;
    expect(pointInNormalizedBbox({ x: 40, y: 50 }, INV, 100, 100)).toBe(false);
    expect(pointInNormalizedBbox({ x: 60, y: 70 }, INV, 100, 100)).toBe(false); // even at the min
    // This case guards against reorder/normalize implementations; the min-plus-extent float
    // FORM itself is pinned by the ULP cases below (an inverted box misses under both forms).
  });

  it("pins the exact min-plus-extent float form at ULP granularity (not maxX*pageWidth)", () => {
    // Node-verified: minX*pw + (maxX-minX)*pw differs from maxX*pw on non-round coords.
    // [0.01,0.15]@pw100: extent upper = 14.999999999999998, max-form = 15
    //   => x=15 MISSES under the live extent form, would HIT under maxX*pw.
    expect(pointInNormalizedBbox({ x: 15, y: 50 }, [0.01, 0, 0.15, 1], 100, 100)).toBe(false);
    // [0.01,0.1]@pw100: extent upper = 10.000000000000002, max-form = 10
    //   => x=10.000000000000002 HITS under the live extent form, would MISS under maxX*pw.
    expect(pointInNormalizedBbox({ x: 10.000000000000002, y: 50 }, [0.01, 0, 0.1, 1], 100, 100)).toBe(true);
  });
});

describe("hitTest.pointInHandle (open axis-aligned square)", () => {
  const C: HitPoint = { x: 50, y: 50 };

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

  it("explicit halfExtent overrides the default", () => {
    expect(pointInHandle({ x: 57.9, y: 50 }, C, 8)).toBe(true); // same as live HANDLE=8
    expect(pointInHandle({ x: 57.9, y: 50 }, C, 4)).toBe(false);
  });
});
