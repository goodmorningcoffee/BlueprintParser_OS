// [tiles T9 2026-10-24] Geometry pins for the tile planner: every level covers the page exactly once
// with no gap, neighbours overlap by the configured fraction, edge tiles are full-size and anchored
// to the far edge, and a page smaller than a tile gets one page-sized tile. Checked by brute force
// over a coverage grid, not by trusting the row/col arithmetic.
import { describe, expect, it } from "vitest";
import { axisOffsets, coverageFactor, planLevel, planTiles, type TileLevelPlan } from "../plan";
import { DEFAULT_TILE_LEVELS } from "../settings";

/** Every pixel row/col index covered by at least one tile, and no tile outside the page. */
function assertCovers(level: TileLevelPlan, width: number, height: number) {
  const xs = new Uint8Array(width);
  const ys = new Uint8Array(height);
  for (const t of level.tiles) {
    expect(t.x).toBeGreaterThanOrEqual(0);
    expect(t.y).toBeGreaterThanOrEqual(0);
    expect(t.x + t.w).toBeLessThanOrEqual(width);
    expect(t.y + t.h).toBeLessThanOrEqual(height);
    xs.fill(1, t.x, t.x + t.w);
    ys.fill(1, t.y, t.y + t.h);
  }
  expect(xs.every((v) => v === 1), "every column covered").toBe(true);
  expect(ys.every((v) => v === 1), "every row covered").toBe(true);
  expect(level.tiles).toHaveLength(level.rows * level.cols);
  expect(new Set(level.tiles.map((t) => `${t.row}_${t.col}`)).size).toBe(level.tiles.length);
}

describe("axisOffsets", () => {
  it("steps by the stride and pulls the last tile back onto the edge; never two tiles at one origin", () => {
    expect(axisOffsets(10800, 3600, 2880)).toEqual([0, 2880, 5760, 7200]);
    expect(axisOffsets(7200, 3600, 2880)).toEqual([0, 2880, 3600]);
    expect(axisOffsets(3600, 3600, 2880)).toEqual([0]);
    expect(axisOffsets(1000, 3600, 2880)).toEqual([0]);
    expect(axisOffsets(3601, 3600, 2880)).toEqual([0, 1]);
    expect(axisOffsets(6480, 3600, 2880)).toEqual([0, 2880]); // exactly stride + size: no third tile
  });
});

describe("planTiles", () => {
  it("a 24x36\" sheet at 300 DPI (10800x7200): 4x3 tiles at L3600, 11x7 at L1280, 20% overlap", () => {
    const plan = planTiles(10800, 7200, DEFAULT_TILE_LEVELS);
    expect(plan.levels.map((l) => [l.size, l.stride, l.cols, l.rows, l.tiles.length])).toEqual([
      [3600, 2880, 4, 3, 12],
      [1280, 1024, 11, 7, 77],
    ]);
    for (const level of plan.levels) {
      assertCovers(level, 10800, 7200);
      for (const t of level.tiles) expect([t.w, t.h]).toEqual([level.size, level.size]);
    }
    // neighbours share size - stride = 20% of the tile (interior); the edge tile overlaps more, never less
    const l = plan.levels[0];
    const row0 = l.tiles.filter((t) => t.row === 0);
    expect(row0[0].x + row0[0].w - row0[1].x).toBe(720);
    expect(row0[2].x + row0[2].w - row0[3].x).toBeGreaterThanOrEqual(720);
    expect(row0[3].x + row0[3].w).toBe(10800);
    // storage: the page is stored ~2.0x at L3600 and ~1.6x at L1280
    expect(coverageFactor(plan.levels[0], 10800, 7200)).toBeCloseTo(2.0, 1);
    expect(coverageFactor(plan.levels[1], 10800, 7200)).toBeCloseTo(1.62, 1);
  });

  it("a 30x42\" sheet (12600x9000) and a landscape/portrait flip both cover exactly; a tiny page is one page-sized tile", () => {
    for (const [w, h] of [[12600, 9000], [9000, 12600], [5100, 3300], [1000, 800], [3601, 3599]]) {
      const plan = planTiles(w, h, DEFAULT_TILE_LEVELS);
      for (const level of plan.levels) assertCovers(level, w, h);
    }
    const tiny = planTiles(1000, 800, [3600, 1280]);
    expect(tiny.levels[0].tiles).toEqual([{ row: 0, col: 0, x: 0, y: 0, w: 1000, h: 800 }]);
    expect(tiny.levels[1].tiles).toEqual([{ row: 0, col: 0, x: 0, y: 0, w: 1000, h: 800 }]);
    const narrow = planTiles(1000, 3000, [1280]);
    expect(narrow.levels[0].tiles.map((t) => [t.x, t.y, t.w, t.h])).toEqual([[0, 0, 1000, 1280], [0, 1024, 1000, 1280], [0, 1720, 1000, 1280]]);
  });

  it("overlap 0 tiles edge to edge; overlap is honoured per level; sizes come out in the order given", () => {
    const l = planLevel(3000, 1000, 1000, 0);
    expect(l.stride).toBe(1000);
    expect(l.tiles.map((t) => t.x)).toEqual([0, 1000, 2000]);
    const plan = planTiles(5000, 5000, [1824, 3600], 0.25);
    expect(plan.levels.map((x) => x.size)).toEqual([1824, 3600]);
    expect(plan.levels[0].stride).toBe(1368);
    expect(plan.levels[1].stride).toBe(2700);
    for (const level of plan.levels) assertCovers(level, 5000, 5000);
  });

  it("refuses bad input loudly (callers pass validated settings)", () => {
    expect(() => planTiles(0, 100, [1280])).toThrow(/positive integers/);
    expect(() => planTiles(100.5, 100, [1280])).toThrow(/positive integers/);
    expect(() => planTiles(100, 100, [])).toThrow(/at least one/);
    expect(() => planTiles(100, 100, [1280, 1280])).toThrow(/unique/);
    expect(() => planTiles(100, 100, [32])).toThrow(/tile size/);
    expect(() => planTiles(100, 100, [1280.5])).toThrow(/tile size/);
    expect(() => planTiles(100, 100, [1280], 0.95)).toThrow(/overlap/);
    expect(() => planTiles(100, 100, [1280], -0.1)).toThrow(/overlap/);
  });
});
