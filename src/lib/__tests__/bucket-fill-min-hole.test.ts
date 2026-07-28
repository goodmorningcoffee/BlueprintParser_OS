// @vitest-environment node
/**
 * The minimum hole — PLAN §5 phase 3's caller-side hole filter.
 *
 * ── WHY A FILTER IS NEEDED AT ALL ───────────────────────────────────────────────────────
 * `findHoleBorders` reports every enclosed void in the flood region, correctly — it cannot know
 * which ones a user meant. On the raster path that was harmless by accident: a 1000 px-capped
 * downscale-then-threshold destroyed anything small before the detector ever saw it. The vector
 * path traces linework at ~2.4 mask px per point and has no such accidental filter, so specks,
 * glyph counters, hatch intersections and dimension-line crossings all become "holes" — each one
 * silently SUBTRACTED from the room's reported area.
 *
 * That is the same failure shape the whole rebuild targets: a wrong number, produced confidently,
 * with nothing on screen to indicate it.
 */

import { describe, it, expect } from "vitest";
import {
  isHoleSignificant,
  polygonAreaAbs,
  MIN_HOLE_MASK_PX,
  MIN_HOLE_REGION_FRACTION,
} from "@/lib/bucket-fill-vector-limits";

/** Axis-aligned square of side `s`, in whatever units the caller is working in. */
const square = (s: number, ox = 0, oy = 0) => [
  { x: ox, y: oy },
  { x: ox + s, y: oy },
  { x: ox + s, y: oy + s },
  { x: ox, y: oy + s },
];

describe("polygonAreaAbs", () => {
  it("is the shoelace area and is winding-agnostic", () => {
    const cw = square(10);
    const ccw = [...cw].reverse();
    expect(polygonAreaAbs(cw)).toBe(100);
    expect(polygonAreaAbs(ccw)).toBe(100);
  });

  it("handles a concave ring, not just boxes", () => {
    // An L: 10x10 with a 5x5 bite out of the top-right ⇒ 100 - 25 = 75.
    const l = [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 },
      { x: 5, y: 5 }, { x: 5, y: 10 }, { x: 0, y: 10 },
    ];
    expect(polygonAreaAbs(l)).toBe(75);
  });

  it("is zero for degenerate rings rather than NaN or negative", () => {
    expect(polygonAreaAbs([])).toBe(0);
    expect(polygonAreaAbs([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBe(0);
    // Three collinear points enclose nothing.
    expect(polygonAreaAbs([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }])).toBe(0);
  });
});

describe("isHoleSignificant — BOTH floors must clear", () => {
  const REGION = 1_000_000; // mask px², a large room

  it("drops tracer noise: a speck below the absolute floor", () => {
    // 5x5 = 25 mask px², under MIN_HOLE_MASK_PX (30).
    expect(polygonAreaAbs(square(5))).toBe(25);
    expect(isHoleSignificant(25, REGION)).toBe(false);
  });

  it("drops a hole that clears the absolute floor but is negligible for this room", () => {
    // 100 mask px² is comfortably over 30, but 0.01% of a 1,000,000 px region.
    expect(isHoleSignificant(100, REGION)).toBe(false);
  });

  it("keeps a real feature — a column that is both big enough and proportionate", () => {
    expect(isHoleSignificant(REGION * 0.02, REGION)).toBe(true);
  });

  it("is inclusive at both boundaries", () => {
    // Exactly the absolute floor, in a region small enough that the relative floor is satisfied.
    expect(isHoleSignificant(MIN_HOLE_MASK_PX, 1000)).toBe(true);
    // Exactly the relative floor.
    expect(isHoleSignificant(REGION * MIN_HOLE_REGION_FRACTION, REGION)).toBe(true);
    // A hair under either one fails.
    expect(isHoleSignificant(MIN_HOLE_MASK_PX - 0.001, 1000)).toBe(false);
    expect(isHoleSignificant(REGION * MIN_HOLE_REGION_FRACTION - 1, REGION)).toBe(false);
  });

  it("⚠ THE KNOWN COST, pinned deliberately: a small real feature in a huge room is dropped", () => {
    // An 8" pipe chase in a warehouse. It is genuinely there, it clears the absolute floor
    // easily, and the relative floor still rejects it.
    const chase = 400; // mask px²
    expect(chase).toBeGreaterThan(MIN_HOLE_MASK_PX);
    expect(isHoleSignificant(chase, REGION)).toBe(false);
    // Recorded rather than hidden: an over-reported area is a visible, arguable number, while a
    // phantom hole silently under-reports and looks exactly like a measurement. If this ever needs
    // revisiting, the relative floor is the knob — and this test is the reason it exists.
  });

  it("a tiny closet does NOT become a licence to keep specks", () => {
    // In a 2000 px region, 0.5% is 10 px — below the absolute floor, which still rejects.
    expect(isHoleSignificant(12, 2000)).toBe(false);
  });

  it("rejects nonsense areas rather than letting them through a comparison", () => {
    expect(isHoleSignificant(0, REGION)).toBe(false);
    expect(isHoleSignificant(-5, REGION)).toBe(false);
    expect(isHoleSignificant(Number.NaN, REGION)).toBe(false);
  });

  it("falls back to the absolute floor alone when the region area is unusable", () => {
    // A zero/º region cannot give a meaningful ratio; refusing everything there would drop real
    // holes for a reason unrelated to their size.
    expect(isHoleSignificant(100, 0)).toBe(true);
    expect(isHoleSignificant(10, 0)).toBe(false);
  });
});

describe("the filter as the callers apply it — mask px, before conversion", () => {
  it("a 5x5 speck and a 200x200 column, judged against the same region", () => {
    const region = 500 * 500; // 250,000 mask px²
    const speck = polygonAreaAbs(square(5));
    const column = polygonAreaAbs(square(200));
    expect(isHoleSignificant(speck, region)).toBe(false);
    expect(isHoleSignificant(column, region)).toBe(true);
  });

  it("★ the thresholds are MASK-px literals — judging in normalised space would invert the result", () => {
    // The same 200x200 mask-px column expressed in normalised 0-1 coords on a 3000 px mask has an
    // area of ~0.0044 — far below MIN_HOLE_MASK_PX, so a caller that filtered after converting
    // would throw away every hole it has. This is risk #1 of the whole arc in miniature: the tuned
    // constants are mask-px literals, so the comparison has to happen in mask px.
    const normalisedArea = (200 / 3000) * (200 / 3000);
    expect(normalisedArea).toBeLessThan(MIN_HOLE_MASK_PX);
    expect(isHoleSignificant(normalisedArea, 1)).toBe(false);
  });
});

// ── the WIRING, not just the predicate ──────────────────────────────────────────────────
//
// ⚠ THIS SECTION EXISTS BECAUSE THE PREDICATE TESTS ABOVE PASSED WHILE THE FILTER WAS NOT
// CONNECTED. Deleting the filter line from BOTH vector callers left the entire 242-test bucket
// suite green — the classic shape of a test that protects nothing. Measured, not assumed: with the
// filter removed, the 6 px island below comes back as `holeCount: 1`.

import {
  handleOneclickMessage,
  createWorkerState,
  maskCacheKey,
} from "@/lib/oneclick-worker-core";

const IMG_W = 1000;
const IMG_H = 800;
const ROOM = { x0: 200, y0: 150, x1: 700, y1: 600 };
const KEY = maskCacheKey("p", 1, 3000, "vector");

/** Four segments tracing a box — an "island" of linework floating inside the room. */
function boxSegs(x: number, y: number, s: number): number[] {
  return [
    x, y, x + s, y,
    x + s, y, x + s, y + s,
    x + s, y + s, x, y + s,
    x, y + s, x, y,
  ];
}

/** Flood the room, which contains one island of the given size. Returns the reported hole count. */
function holeCountWithIsland(islandSize: number): number {
  const { x0, y0, x1, y1 } = ROOM;
  const room = [
    x0, y0, x1, y0,
    x1, y0, x1, y1,
    x1, y1, x0, y1,
    x0, y1, x0, y0,
  ];
  const segs = Float64Array.from([...room, ...boxSegs(400, 350, islandSize)]);
  const meta = new Uint8Array(segs.length / 4).fill(1 << 4);
  const state = createWorkerState();
  handleOneclickMessage(state, {
    type: "mask", key: KEY, segs, meta, imgW: IMG_W, imgH: IMG_H,
  });
  const res = handleOneclickMessage(state, {
    type: "fill", key: KEY, requestId: 1,
    seedX: 250 / IMG_W, seedY: 200 / IMG_H,
  });
  if (res.type !== "result") throw new Error(`expected a fill, got ${res.type}`);
  return res.holeCount;
}

describe("★ worker #2 applies the filter — tracer noise never reaches the caller", () => {
  it("a 6 px island is DROPPED (it is 1 hole without the filter — measured)", () => {
    expect(holeCountWithIsland(6)).toBe(0);
  });

  it("a 200 px column is KEPT", () => {
    expect(holeCountWithIsland(200)).toBe(1);
  });

  it("the two differ, which is the whole claim", () => {
    // Stated as its own assertion so a future change that drops or keeps EVERYTHING fails here
    // even if someone re-baselines one of the two numbers above.
    expect(holeCountWithIsland(6)).not.toBe(holeCountWithIsland(200));
  });
});
