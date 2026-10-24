// [tiles T9 2026-10-24] Tile-pyramid geometry. Pure: no I/O, no DB, no image library.
//
// Tiles are sized in PIXELS, not as a fixed grid count: sheet sizes vary (24x36", 30x42", 11x17"),
// and a fixed grid would hand the detectors a different scale per sheet. Each level cuts the page
// into `size`-px squares with `overlap` (fraction of `size`) shared between neighbours, so a word
// or symbol that straddles one tile edge is whole in the next tile. Edge tiles are anchored to the
// far edge (the last column starts at width - size), so every tile of a level is the same size
// and the page is covered exactly once with no gap; a page smaller than `size` in a dimension gets
// one tile of the page's own extent there. Default levels (settings.ts): 3600 px — detector input
// at roughly 3x the whole-page shrink — and 1280 px, yolo_text's native input size.

export interface TileRect {
  row: number;
  col: number;
  /** Top-left corner in page pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TileLevelPlan {
  /** Nominal tile edge in px (the level's name: L3600). */
  size: number;
  /** Distance between neighbouring tile origins: round(size * (1 - overlap)). */
  stride: number;
  rows: number;
  cols: number;
  /** Row-major; every tile is `size` square unless the page is smaller in that dimension. */
  tiles: TileRect[];
}

export interface TilePlan {
  width: number;
  height: number;
  overlap: number;
  levels: TileLevelPlan[];
}

export const DEFAULT_TILE_OVERLAP = 0.2;
export const MIN_TILE_SIZE = 64;
export const MAX_TILE_SIZE = 16384;

export function isTileSize(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_TILE_SIZE && value <= MAX_TILE_SIZE;
}

/** Tile origins along one axis: i*stride, with the last one pulled back so it ends at the edge. */
export function axisOffsets(extent: number, size: number, stride: number): number[] {
  if (extent <= size) return [0];
  const count = Math.ceil((extent - size) / stride) + 1;
  const offsets: number[] = [];
  for (let i = 0; i < count; i++) offsets.push(Math.min(i * stride, extent - size));
  return offsets;
}

export function planLevel(width: number, height: number, size: number, overlap: number): TileLevelPlan {
  const stride = Math.max(1, Math.round(size * (1 - overlap)));
  const xs = axisOffsets(width, size, stride);
  const ys = axisOffsets(height, size, stride);
  const w = Math.min(size, width);
  const h = Math.min(size, height);
  const tiles: TileRect[] = [];
  ys.forEach((y, row) => {
    xs.forEach((x, col) => {
      tiles.push({ row, col, x, y, w, h });
    });
  });
  return { size, stride, rows: ys.length, cols: xs.length, tiles };
}

/**
 * The full plan for one page. Throws on a non-positive page size, a size outside
 * [MIN_TILE_SIZE, MAX_TILE_SIZE], a duplicate size or an overlap outside [0, 0.9] — callers pass
 * validated settings (settings.ts) or the defaults, so a throw here is a programming error.
 */
export function planTiles(
  width: number,
  height: number,
  levels: readonly number[],
  overlap: number = DEFAULT_TILE_OVERLAP,
): TilePlan {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`planTiles: page size must be positive integers, got ${width}x${height}`);
  }
  if (!(overlap >= 0 && overlap <= 0.9)) throw new Error(`planTiles: overlap must be within [0, 0.9], got ${overlap}`);
  if (levels.length === 0) throw new Error("planTiles: at least one tile size is required");
  if (new Set(levels).size !== levels.length) throw new Error("planTiles: tile sizes must be unique");
  for (const size of levels) {
    if (!isTileSize(size)) throw new Error(`planTiles: tile size must be an integer in [${MIN_TILE_SIZE}, ${MAX_TILE_SIZE}], got ${size}`);
  }
  return { width, height, overlap, levels: levels.map((size) => planLevel(width, height, size, overlap)) };
}

/** Total tile pixels / page pixels for one level — how many times the page is stored at that level. */
export function coverageFactor(level: TileLevelPlan, width: number, height: number): number {
  const tilePixels = level.tiles.reduce((sum, t) => sum + t.w * t.h, 0);
  return tilePixels / (width * height);
}
