// @vitest-environment node
/**
 * `polygonCentroid` — the area centroid used to anchor every square-footage label.
 *
 * It was a vertex mean until this suite landed. The defect is not cosmetic: a vertex mean
 * weights by how many points describe an edge rather than by area, so it moves when a tracer
 * changes vertex distribution even though the region it describes has not moved at all.
 *
 * ── WHAT THIS SUITE IS ACTUALLY DEFENDING ───────────────────────────────────────────────
 * The load-bearing property is **invariance to vertex density**, not "the label is inside the
 * room". Those are different claims and only the first one is true — see the last describe
 * block, which pins the false one as false so a future reader cannot quietly assume it.
 *
 * Where a value is asserted, it is derived independently (decomposition into rectangles,
 * area-weighted) rather than by running the function and recording what came out. A test that
 * pins the implementation's own output cannot detect the implementation being wrong.
 */

import { describe, it, expect } from "vitest";
import { polygonCentroid } from "@/lib/areaCalc";

type P = { x: number; y: number };
const pt = (x: number, y: number): P => ({ x, y });

/** Area-weighted centre of a set of disjoint rectangles — the independent oracle. */
function rectDecompositionCentroid(rects: { x0: number; y0: number; x1: number; y1: number }[]): P {
  let a = 0, sx = 0, sy = 0;
  for (const r of rects) {
    const w = r.x1 - r.x0, h = r.y1 - r.y0, ra = w * h;
    a += ra;
    sx += ra * (r.x0 + r.x1) / 2;
    sy += ra * (r.y0 + r.y1) / 2;
  }
  return { x: sx / a, y: sy / a };
}

/** Split edge `edgeIndex` into `k` collinear pieces. Adds vertices; changes NO geometry. */
function subdivideEdge(vs: P[], edgeIndex: number, k: number): P[] {
  const out: P[] = [];
  for (let i = 0; i < vs.length; i++) {
    const p = vs[i], q = vs[(i + 1) % vs.length];
    out.push(p);
    if (i === edgeIndex) {
      for (let t = 1; t < k; t++) out.push(pt(p.x + (q.x - p.x) * t / k, p.y + (q.y - p.y) * t / k));
    }
  }
  return out;
}

/** Ray-cast point-in-polygon, for the honesty block at the bottom. */
function pointInPolygon(p: P, vs: P[]): boolean {
  let inside = false;
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    const xi = vs[i].x, yi = vs[i].y, xj = vs[j].x, yj = vs[j].y;
    if ((yi > p.y) !== (yj > p.y) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const RECT: P[] = [pt(0.1, 0.1), pt(0.6, 0.1), pt(0.6, 0.5), pt(0.1, 0.5)];

/**
 * An L-shaped room: 490 x 290 with a 160 x 150 bite out of one corner, normalised onto a
 * 1224 x 792 sheet — the arc's own `l-niche` fixture geometry.
 */
const L_ROOM: P[] = [
  pt(100 / 1224, 100 / 792), pt(590 / 1224, 100 / 792), pt(590 / 1224, 240 / 792),
  pt(430 / 1224, 240 / 792), pt(430 / 1224, 390 / 792), pt(100 / 1224, 390 / 792),
];

describe("polygonCentroid — correctness against independent derivations", () => {
  it("puts a rectangle's centroid at its geometric centre", () => {
    const c = polygonCentroid(RECT);
    expect(c.x).toBeCloseTo(0.35, 12);
    expect(c.y).toBeCloseTo(0.3, 12);
  });

  it("matches a rectangle-decomposition oracle on an L-shaped room", () => {
    // The L, cut into two disjoint rectangles. Computed from the geometry, never from the
    // function under test — so a wrong formula fails here rather than agreeing with itself.
    const oracle = rectDecompositionCentroid([
      { x0: 100 / 1224, y0: 100 / 792, x1: 590 / 1224, y1: 240 / 792 }, // full-width top band
      { x0: 100 / 1224, y0: 240 / 792, x1: 430 / 1224, y1: 390 / 792 }, // narrower bottom band
    ]);
    const c = polygonCentroid(L_ROOM);
    expect(c.x).toBeCloseTo(oracle.x, 12);
    expect(c.y).toBeCloseTo(oracle.y, 12);

    // And it is genuinely NOT the vertex mean — otherwise this suite would pass under the old
    // implementation and defend nothing.
    const meanX = L_ROOM.reduce((s, v) => s + v.x, 0) / L_ROOM.length;
    expect(Math.abs(c.x - meanX) * 1224).toBeGreaterThan(50); // > 50 pt apart on this sheet
  });

  it("is independent of winding order", () => {
    const cw = polygonCentroid(L_ROOM);
    const ccw = polygonCentroid([...L_ROOM].reverse());
    expect(ccw.x).toBeCloseTo(cw.x, 12);
    expect(ccw.y).toBeCloseTo(cw.y, 12);
  });

  it("is independent of which vertex the ring starts at", () => {
    const base = polygonCentroid(L_ROOM);
    for (let r = 1; r < L_ROOM.length; r++) {
      const rotated = [...L_ROOM.slice(r), ...L_ROOM.slice(0, r)];
      const c = polygonCentroid(rotated);
      expect(c.x).toBeCloseTo(base.x, 12);
      expect(c.y).toBeCloseTo(base.y, 12);
    }
  });

  it("translates with the polygon", () => {
    const base = polygonCentroid(L_ROOM);
    const moved = polygonCentroid(L_ROOM.map((v) => pt(v.x + 0.13, v.y + 0.07)));
    expect(moved.x).toBeCloseTo(base.x + 0.13, 12);
    expect(moved.y).toBeCloseTo(base.y + 0.07, 12);
  });
});

describe("polygonCentroid — the property that actually motivated the change", () => {
  it("does not move when an edge is subdivided, at any density", () => {
    // Subdividing an edge inserts collinear vertices. The region is bit-for-bit the same
    // region. A centroid must not notice. THIS is what a changed tracer does to a polygon.
    const base = polygonCentroid(RECT);
    for (const k of [2, 4, 8, 16, 64, 256]) {
      const c = polygonCentroid(subdivideEdge(RECT, 0, k));
      expect(c.x).toBeCloseTo(base.x, 12);
      expect(c.y).toBeCloseTo(base.y, 12);
    }
  });

  it("survives subdivision of EVERY edge simultaneously", () => {
    let dense = RECT;
    for (let e = 0; e < 4; e++) dense = subdivideEdge(dense, e === 0 ? 0 : dense.length - 1, 8);
    const c = polygonCentroid(dense);
    expect(dense.length).toBeGreaterThan(RECT.length);
    expect(c.x).toBeCloseTo(0.35, 12);
    expect(c.y).toBeCloseTo(0.3, 12);
  });

  it("NEGATIVE CONTROL: a vertex mean fails this test badly, so the test can fail", () => {
    // Guards against the suite passing for the wrong reason. If someone reverts the body to a
    // vertex mean, the assertions above must go red — this proves they would.
    const vertexMean = (vs: P[]) => ({
      x: vs.reduce((s, v) => s + v.x, 0) / vs.length,
      y: vs.reduce((s, v) => s + v.y, 0) / vs.length,
    });
    const m1 = vertexMean(RECT);
    const m64 = vertexMean(subdivideEdge(RECT, 0, 64));
    const driftPt = Math.hypot((m64.x - m1.x) * 1224, (m64.y - m1.y) * 792);
    expect(driftPt).toBeGreaterThan(100); // measured: 148.9 pt on a 1224 x 792 sheet

    // ...while the real implementation's drift over the same series is exactly zero.
    const c1 = polygonCentroid(RECT);
    const c64 = polygonCentroid(subdivideEdge(RECT, 0, 64));
    expect(Math.hypot((c64.x - c1.x) * 1224, (c64.y - c1.y) * 792)).toBeLessThan(1e-9);
  });
});

describe("polygonCentroid — degenerate input never produces a garbage anchor", () => {
  it("returns the origin for an empty ring", () => {
    expect(polygonCentroid([])).toEqual({ x: 0, y: 0 });
  });

  it("returns the point itself for one vertex, and the midpoint for two", () => {
    // Unchanged from the previous implementation — the bbox-centre fallback coincides with the
    // vertex mean at these sizes, so nothing that worked before moves.
    expect(polygonCentroid([pt(0.3, 0.7)])).toEqual({ x: 0.3, y: 0.7 });
    const two = polygonCentroid([pt(0.2, 0.4), pt(0.6, 0.8)]);
    expect(two.x).toBeCloseTo(0.4, 12);
    expect(two.y).toBeCloseTo(0.6, 12);
  });

  it("falls back to the bounding-box centre on a zero-area (collinear) ring", () => {
    // Unevenly spaced on purpose: a vertex mean would give 0.5333, biased by the clustered
    // points. The bbox centre is 0.5 and carries no density bias.
    const collinear = [pt(0.2, 0.3), pt(0.5, 0.3), pt(0.6, 0.3), pt(0.8, 0.3), pt(0.7, 0.3)];
    const c = polygonCentroid(collinear);
    expect(Number.isFinite(c.x)).toBe(true);
    expect(Number.isFinite(c.y)).toBe(true);
    expect(c.x).toBeCloseTo(0.5, 12);
    expect(c.y).toBeCloseTo(0.3, 12);
  });

  it("stays on a needle-thin ring that is still above the degeneracy threshold", () => {
    // 1e-9 tall over 0.6 wide ⇒ a2 = 1.2e-9, a thousand times the 1e-12 threshold, so this
    // takes the shoelace branch rather than the fallback.
    //
    // ⚠ MEASURED, and the reason this assertion is loose: the shoelace branch loses precision
    // to cancellation long before the threshold catches it. y comes back 0.5 + 1.15e-8 where
    // the true centroid is 0.5 + 5e-10 — an error 23x the sliver's own height, but 9e-6 pt on
    // a 792 pt sheet, i.e. invisible for label placement. The first version of this test
    // asserted 8 decimals and failed; the answer is fine and the assertion was wrong.
    const sliver = [pt(0.2, 0.5), pt(0.8, 0.5), pt(0.8, 0.5 + 1e-9), pt(0.2, 0.5 + 1e-9)];
    const c = polygonCentroid(sliver);
    expect(Number.isFinite(c.x)).toBe(true);
    expect(Number.isFinite(c.y)).toBe(true);
    expect(c.x).toBeGreaterThanOrEqual(0.2);
    expect(c.x).toBeLessThanOrEqual(0.8);
    expect(c.y).toBeCloseTo(0.5, 6);
  });

  it("takes the bbox fallback once the ring is thin enough to fall under the threshold", () => {
    // 1e-13 tall over 0.6 wide ⇒ a2 = 1.2e-13 < 1e-12. This is the branch the threshold exists
    // for; without it the division is by float noise and the anchor lands anywhere at all.
    const subThreshold = [pt(0.2, 0.5), pt(0.8, 0.5), pt(0.8, 0.5 + 1e-13), pt(0.2, 0.5 + 1e-13)];
    const c = polygonCentroid(subThreshold);
    expect(c.x).toBeCloseTo(0.5, 12);
    expect(c.y).toBeCloseTo(0.5, 12);
  });

  it("handles a self-touching ring without producing NaN", () => {
    // A figure-eight's two lobes cancel to zero signed area. Not a shape the tracer emits, but
    // the anchor must still be a number rather than NaN painted at the canvas origin.
    const bowtie = [pt(0.2, 0.2), pt(0.6, 0.6), pt(0.2, 0.6), pt(0.6, 0.2)];
    const c = polygonCentroid(bowtie);
    expect(Number.isFinite(c.x)).toBe(true);
    expect(Number.isFinite(c.y)).toBe(true);
  });
});

describe("polygonCentroid — what it deliberately does NOT guarantee", () => {
  /**
   * Pinned so it is not quietly assumed later. An area centroid is a centre of MASS; for a
   * sufficiently concave shape it lies outside the polygon, and no amount of correctness in
   * the formula changes that. Anyone who needs "a point inside the room" needs a different
   * function (pole of inaccessibility), and this block is where they should find that out.
   */
  it("can place the anchor OUTSIDE a strongly concave room — by construction, not by bug", () => {
    const thinL: P[] = [
      pt(0, 0), pt(490 / 1224, 0), pt(490 / 1224, 60 / 792),
      pt(60 / 1224, 60 / 792), pt(60 / 1224, 290 / 792), pt(0, 290 / 792),
    ];
    expect(pointInPolygon(polygonCentroid(thinL), thinL)).toBe(false);

    const u: P[] = [
      pt(100 / 1224, 100 / 792), pt(590 / 1224, 100 / 792), pt(590 / 1224, 390 / 792),
      pt(490 / 1224, 390 / 792), pt(490 / 1224, 200 / 792), pt(200 / 1224, 200 / 792),
      pt(200 / 1224, 390 / 792), pt(100 / 1224, 390 / 792),
    ];
    expect(pointInPolygon(polygonCentroid(u), u)).toBe(false);
  });

  it("moves the anchor when a tracer adds detail — the mean does, the centroid does not", () => {
    // The realistic case, and the one that justifies shipping the change.
    //
    // ⚠ THE CLAIM HERE IS DISPLACEMENT, NOT "OUTSIDE THE ROOM". PLAN §3.4 says the label
    // "renders outside the room today" on an L; that is TOO STRONG as a general statement and
    // this test deliberately does not assert it. Measured on this geometry: the mean stays
    // inside, it just walks 43.3 pt toward whichever side the tracer kept detail on. Whether
    // it crosses the boundary depends on how lopsided the vertex distribution happens to be —
    // an unstable anchor is the defect; landing outside is one of its symptoms, not the rule.
    //
    // (An earlier probe of mine appeared to show the mean landing outside. It had built a
    // self-intersecting ring by splicing every extra point at one index, which reverses them
    // and scrambles the boundary — point-in-polygon on that ring means nothing. Correcting the
    // ring order removed the effect. Recorded so the stronger claim is not resurrected.)
    expect(pointInPolygon(polygonCentroid(L_ROOM), L_ROOM)).toBe(true);

    // Detail kept around the concave corner, inserted IN RING ORDER along the two edges that
    // meet there — which is what an RDP tracer actually leaves behind.
    const traced = [
      L_ROOM[0], L_ROOM[1], L_ROOM[2],
      pt(560 / 1224, 240 / 792), pt(500 / 1224, 240 / 792),
      L_ROOM[3],
      pt(430 / 1224, 270 / 792), pt(430 / 1224, 300 / 792),
      L_ROOM[4], L_ROOM[5],
    ];
    const mean = (vs: P[]) => ({
      x: vs.reduce((s, v) => s + v.x, 0) / vs.length,
      y: vs.reduce((s, v) => s + v.y, 0) / vs.length,
    });
    const m0 = mean(L_ROOM), m1 = mean(traced);
    const c0 = polygonCentroid(L_ROOM), c1 = polygonCentroid(traced);

    // Identical region, more vertices: the mean walks tens of points, the centroid does not move.
    expect(Math.hypot((m1.x - m0.x) * 1224, (m1.y - m0.y) * 792)).toBeGreaterThan(25);
    expect(Math.hypot((c1.x - c0.x) * 1224, (c1.y - c0.y) * 792)).toBeLessThan(1e-9);
    expect(pointInPolygon(c1, traced)).toBe(true);
  });
});
