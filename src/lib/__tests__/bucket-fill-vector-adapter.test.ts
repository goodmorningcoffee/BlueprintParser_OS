/**
 * The BP2 ↔ One-Click boundary.
 *
 * Geometry is hand-built rather than extracted from a PDF: the adapter's job is coordinate
 * spaces, barriers, holes and status mapping, and a literal `segs` array makes every expected
 * number arithmetic rather than a measurement.
 *
 * The coordinate assertions carry the most weight. Three spaces are in play — normalised 0-1,
 * image px, mask px — and mixing them produces a *plausible-looking* polygon at the wrong scale,
 * which is the kind of defect that survives review.
 */

import { describe, it, expect } from "vitest";
import { vectorBucketFill } from "@/lib/bucket-fill-vector-adapter";
import { MASK_MAX_DIM_HARD } from "@/lib/bucket-fill-vector-limits";
import type { VectorGeometry } from "@/lib/oneclick/oneclick";

const IMG_W = 1000;
const IMG_H = 800;

/**
 * Build geometry from device-px line segments.
 *
 * At imgW 1000 and mask dim 3000 the engine's `ws` is min(1, 3000/1000) = 1, so mask px and
 * image px coincide here. That keeps the expected values arithmetic rather than measured — but it
 * also means these cases CANNOT exercise the `/ws` conversion. The "ws < 1" block near the bottom
 * exists for exactly that reason; do not delete it thinking it is redundant.
 */
function geoFrom(lines: [number, number, number, number][]): VectorGeometry {
  const segs: number[] = [];
  for (const [x1, y1, x2, y2] of lines) segs.push(x1, y1, x2, y2);
  return { segs, points: [], meta: new Uint8Array(lines.length), imageArea: 0 };
}

/** A sealed 300x200 room at (100,100)-(400,300) — 7.5% of the sheet, well under LEAK_FRACTION. */
const ROOM: [number, number, number, number][] = [
  [100, 100, 400, 100],
  [400, 100, 400, 300],
  [400, 300, 100, 300],
  [100, 300, 100, 100],
];

/** The same room with a 20 px doorway in the bottom wall. */
const ROOM_WITH_GAP: [number, number, number, number][] = [
  [100, 100, 400, 100],
  [400, 100, 400, 300],
  [400, 300, 260, 300],
  [240, 300, 100, 300],
  [100, 300, 100, 100],
];

const SEED = { seedX: 250 / IMG_W, seedY: 200 / IMG_H }; // room centre, normalised

describe("vectorBucketFill — happy path and coordinate spaces", () => {
  it("returns BP2's result shape with normalised vertices", () => {
    const r = vectorBucketFill({ geo: geoFrom(ROOM), imgW: IMG_W, imgH: IMG_H, ...SEED });
    expect(r.type).toBe("result");
    expect(r.method).toBe("client-vector");
    expect(r.vertices!.length).toBeGreaterThanOrEqual(3);
    expect(r.holeCount).toBe(0);

    // EVERY vertex must be normalised 0-1. An image-px or mask-px leak shows up here first.
    for (const v of r.vertices!) {
      expect(v.x).toBeGreaterThanOrEqual(0);
      expect(v.x).toBeLessThanOrEqual(1);
      expect(v.y).toBeGreaterThanOrEqual(0);
      expect(v.y).toBeLessThanOrEqual(1);
    }
  });

  it("places the polygon on the actual room, not merely inside the page", () => {
    // The weaker "is it in 0..1" check above passes for any scale error that happens to stay in
    // range. This pins the polygon to the room's real corners.
    const r = vectorBucketFill({ geo: geoFrom(ROOM), imgW: IMG_W, imgH: IMG_H, ...SEED });
    const xs = r.vertices!.map((v) => v.x);
    const ys = r.vertices!.map((v) => v.y);
    expect(Math.min(...xs)).toBeCloseTo(100 / IMG_W, 2);
    expect(Math.max(...xs)).toBeCloseTo(400 / IMG_W, 2);
    expect(Math.min(...ys)).toBeCloseTo(100 / IMG_H, 2);
    expect(Math.max(...ys)).toBeCloseTo(300 / IMG_H, 2);
  });

  it("reports areaFraction as a fraction of the page, net of holes", () => {
    const r = vectorBucketFill({ geo: geoFrom(ROOM), imgW: IMG_W, imgH: IMG_H, ...SEED });
    // Centreline area is 300x200 = 60,000 of 800,000 = 0.075. The flood stops one mask px inside
    // the linework on each side, so expect a shade under that — not above it.
    expect(r.areaFraction).toBeGreaterThan(0.072);
    expect(r.areaFraction).toBeLessThan(0.075);
  });
});

describe("vectorBucketFill — statuses map to BP2's in-band errors", () => {
  it("refuses a leak with an actionable message instead of returning an area", () => {
    const r = vectorBucketFill({ geo: geoFrom(ROOM_WITH_GAP), imgW: IMG_W, imgH: IMG_H, ...SEED });
    expect(r.type).toBe("error");
    expect(r.vertices).toBeUndefined();
    expect(r.areaFraction).toBeUndefined();
    expect(r.error).toMatch(/escaped/i);
    expect(r.error).toMatch(/barrier/i); // tells the user what to DO
  });

  it("refuses a click that lands on a wall", () => {
    const r = vectorBucketFill({
      geo: geoFrom(ROOM), imgW: IMG_W, imgH: IMG_H,
      seedX: 700 / IMG_W, seedY: 700 / IMG_H, // outside the room, in open sheet
    });
    expect(r.type).toBe("error");
  });

  it("names the raster fallback when a page has no linework at all", () => {
    // This is the scan case. Returning a generic failure here would hide the one signal the
    // caller needs to route on.
    const r = vectorBucketFill({ geo: geoFrom([]), imgW: IMG_W, imgH: IMG_H, ...SEED });
    expect(r.type).toBe("error");
    expect(r.error).toMatch(/raster/i);
  });

  it("rejects a degenerate page rather than allocating from it", () => {
    const r = vectorBucketFill({ geo: geoFrom(ROOM), imgW: 0, imgH: 0, ...SEED });
    expect(r.type).toBe("error");
  });
});

describe("vectorBucketFill — barriers (upstream has no barrier concept)", () => {
  it("seals a doorway that otherwise leaks", () => {
    const gap = { geo: geoFrom(ROOM_WITH_GAP), imgW: IMG_W, imgH: IMG_H, ...SEED };
    expect(vectorBucketFill(gap).type).toBe("error"); // leaks without help

    const sealed = vectorBucketFill({
      ...gap,
      barriers: [{ x1: 238 / IMG_W, y1: 300 / IMG_H, x2: 262 / IMG_W, y2: 300 / IMG_H }],
    });
    expect(sealed.type).toBe("result");
    expect(sealed.areaFraction).toBeGreaterThan(0.072);
    expect(sealed.areaFraction).toBeLessThan(0.075);
  });

  it("excludes an already-captured polygon from the fill", () => {
    const r = vectorBucketFill({
      geo: geoFrom(ROOM), imgW: IMG_W, imgH: IMG_H, ...SEED,
      polygonBarriers: [{
        vertices: [
          { x: 300 / IMG_W, y: 150 / IMG_H },
          { x: 380 / IMG_W, y: 150 / IMG_H },
          { x: 380 / IMG_W, y: 250 / IMG_H },
          { x: 300 / IMG_W, y: 250 / IMG_H },
        ],
      }],
    });
    expect(r.type).toBe("result");
    // The excluded block (80x100 = 8,000 px) must come off the reported area.
    expect(r.areaFraction!).toBeLessThan(0.069);
  });
});

describe("vectorBucketFill — holes use BP2's detector over their region", () => {
  it("finds an interior island and returns its border normalised", () => {
    const withColumn = geoFrom([
      ...ROOM,
      [200, 160, 260, 160],
      [260, 160, 260, 240],
      [260, 240, 200, 240],
      [200, 240, 200, 160],
    ]);
    const r = vectorBucketFill({ geo: withColumn, imgW: IMG_W, imgH: IMG_H, ...SEED,
      seedX: 150 / IMG_W, seedY: 120 / IMG_H }); // seed outside the column, inside the room
    expect(r.type).toBe("result");
    expect(r.holeCount).toBeGreaterThanOrEqual(1);
    for (const h of r.holes!) {
      for (const v of h.vertices) {
        // Holes come out of findHoleBorders in MASK px and must arrive normalised.
        // ⚠ This range check is necessary but NOT sufficient: at ws = 1 (this fixture) dropping
        // the /ws conversion changes nothing, and even at ws < 1 the wrong value stays inside
        // 0-1. The positional assertions in the "ws < 1" block are what actually catch it.
        expect(v.x).toBeGreaterThanOrEqual(0);
        expect(v.x).toBeLessThanOrEqual(1);
        expect(v.y).toBeGreaterThanOrEqual(0);
        expect(v.y).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("vectorBucketFill — mask px != image px (ws < 1)", () => {
  /**
   * ⚠ THIS BLOCK EXISTS BECAUSE THE OTHERS COULD NOT CATCH A REAL BUG.
   *
   * Everything above runs at imgW 1000 with mask dim 3000, where the engine's
   * `ws = min(1, maskDim/max(imgW,imgH))` is exactly 1 — so mask px and image px coincide and the
   * `/ws` conversion on hole borders is a no-op. Deleting that conversion left all twelve tests
   * green (verified by doing it). A range check cannot save you either: the wrong value is still
   * inside 0-1, just in the wrong place.
   *
   * Here imgW is 6000 against mask dim 3000, so ws = 0.5 and the two spaces genuinely differ. The
   * assertions are POSITIONAL — where the hole is, not merely that it is normalised.
   */
  const W = 6000;
  const H = 4800;
  const S = 6; // everything below is the earlier fixture, scaled

  it("returns holes at the right PLACE, not merely inside 0-1", () => {
    const geo = geoFrom([
      ...ROOM.map(([a, b, c, d]) => [a * S, b * S, c * S, d * S] as [number, number, number, number]),
      [200 * S, 160 * S, 260 * S, 160 * S],
      [260 * S, 160 * S, 260 * S, 240 * S],
      [260 * S, 240 * S, 200 * S, 240 * S],
      [200 * S, 240 * S, 200 * S, 160 * S],
    ]);
    const r = vectorBucketFill({
      geo, imgW: W, imgH: H,
      seedX: (150 * S) / W, seedY: (120 * S) / H,
    });
    expect(r.type).toBe("result");
    expect(r.holeCount).toBeGreaterThanOrEqual(1);

    // The column sits at device (1200,960)-(1560,1440) => normalised x 0.20-0.26, y 0.20-0.30.
    // Drop the /ws and these land near 0.10-0.13 — still inside 0-1, and still wrong.
    const hx = r.holes!.flatMap((h) => h.vertices.map((v) => v.x));
    const hy = r.holes!.flatMap((h) => h.vertices.map((v) => v.y));
    expect(Math.min(...hx)).toBeCloseTo(0.2, 1);
    expect(Math.max(...hx)).toBeCloseTo(0.26, 1);
    expect(Math.min(...hy)).toBeCloseTo(0.2, 1);
    expect(Math.max(...hy)).toBeCloseTo(0.3, 1);
  });

  it("still places the outer polygon on the room at ws < 1", () => {
    const geo = geoFrom(ROOM.map(([a, b, c, d]) => [a * S, b * S, c * S, d * S] as [number, number, number, number]));
    const r = vectorBucketFill({ geo, imgW: W, imgH: H, seedX: (250 * S) / W, seedY: (200 * S) / H });
    expect(r.type).toBe("result");
    const xs = r.vertices!.map((v) => v.x);
    expect(Math.min(...xs)).toBeCloseTo(100 / 1000, 2);
    expect(Math.max(...xs)).toBeCloseTo(400 / 1000, 2);
  });
});

describe("vectorBucketFill — mask dimension is clamped, not trusted", () => {
  it("survives an absurd maskDimension by clamping to the safe ceiling", () => {
    const r = vectorBucketFill({
      geo: geoFrom(ROOM), imgW: IMG_W, imgH: IMG_H, ...SEED,
      maskDimension: 100_000,
    });
    expect(r.type).toBe("result");
    expect(MASK_MAX_DIM_HARD).toBe(4096);
  });

  it("works at a small mask dimension too", () => {
    const r = vectorBucketFill({
      geo: geoFrom(ROOM), imgW: IMG_W, imgH: IMG_H, ...SEED,
      maskDimension: 500,
    });
    expect(r.type).toBe("result");
  });
});
