// [tiles T9 2026-10-24] Where a page's tiles live and how a page row points at them. Pure.
//
//   {dataUrl}/tiles/L{size}/page_{NNNN}/r{row}_c{col}.png   one PNG per tile, native 300-DPI pixels
//   {dataUrl}/pages/page_{NNNN}/tiles.json                  the manifest: every level + rect + key
//   pageIntelligence.tiles                                   TilesRecord — the manifest pointer + counts
//
// Everything sits under the project's dataUrl, so project deletion (deleteProjectFiles purges
// `{dataUrl}/`) removes tiles with the rest; page-permanent-delete lists `{dataUrl}/tiles/` for the
// page's tiles and deletes the manifest key. `tiles` is NOT a REPROCESS_COMPUTED_KEY on purpose: the
// intelligence reprocess rebuilds derived data, but tiles are physical objects that stay valid until
// the page raster or the tile settings change — the Reprocess "Tile images" stage rewrites them.

import type { TileRect } from "./plan";

export const TILES_INTELLIGENCE_KEY = "tiles";
export const TILES_RECORD_VERSION = 1;

const pad4 = (n: number) => String(n).padStart(4, "0");

export function tilesRootPrefix(dataUrl: string): string {
  return `${dataUrl}/tiles/`;
}

export function tilesLevelPrefix(dataUrl: string, size: number, pageNumber: number): string {
  return `${tilesRootPrefix(dataUrl)}L${size}/page_${pad4(pageNumber)}/`;
}

export function tileKey(dataUrl: string, size: number, pageNumber: number, row: number, col: number): string {
  return `${tilesLevelPrefix(dataUrl, size, pageNumber)}r${row}_c${col}.png`;
}

export function tilesManifestKey(dataUrl: string, pageNumber: number): string {
  return `${dataUrl}/pages/page_${pad4(pageNumber)}/tiles.json`;
}

/** The page number a tile key names (`…/tiles/L3600/page_0007/r0_c1.png` → 7), or null. */
export function tileKeyPageNumber(key: string): number | null {
  const match = /\/tiles\/L\d+\/page_(\d+)\//.exec(key);
  return match ? parseInt(match[1], 10) : null;
}

export interface TilesManifestLevel {
  size: number;
  stride: number;
  rows: number;
  cols: number;
  /** S3 prefix of this level's tiles for the page. */
  prefix: string;
  tiles: Array<TileRect & { key: string }>;
}

/** Stored at tilesManifestKey(). Self-describing: a consumer needs nothing but this file. */
export interface TilesManifest {
  v: typeof TILES_RECORD_VERSION;
  pageNumber: number;
  /** Page raster size in px (the tiles' coordinate space). */
  width: number;
  height: number;
  overlap: number;
  levels: TilesManifestLevel[];
  tiledAt: string;
}

export interface TilesRecordLevel {
  size: number;
  rows: number;
  cols: number;
  tiles: number;
}

/** pageIntelligence.tiles — small on purpose: the rects live in the manifest. */
export interface TilesRecord {
  v: typeof TILES_RECORD_VERSION;
  manifestKey: string;
  width: number;
  height: number;
  overlap: number;
  levels: TilesRecordLevel[];
  tiledAt: string;
}

/** Type guard for a stored `pageIntelligence.tiles` value (jsonb, so the shape is not guaranteed). */
export function isTilesRecord(value: unknown): value is TilesRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    r.v === TILES_RECORD_VERSION &&
    typeof r.manifestKey === "string" &&
    typeof r.width === "number" &&
    typeof r.height === "number" &&
    typeof r.overlap === "number" &&
    typeof r.tiledAt === "string" &&
    Array.isArray(r.levels) &&
    r.levels.every(
      (l) =>
        !!l && typeof l === "object" &&
        typeof (l as TilesRecordLevel).size === "number" &&
        typeof (l as TilesRecordLevel).rows === "number" &&
        typeof (l as TilesRecordLevel).cols === "number" &&
        typeof (l as TilesRecordLevel).tiles === "number",
    )
  );
}

export function storedTiles(pageIntelligence: unknown): TilesRecord | undefined {
  if (!pageIntelligence || typeof pageIntelligence !== "object") return undefined;
  const stored = (pageIntelligence as Record<string, unknown>)[TILES_INTELLIGENCE_KEY];
  return isTilesRecord(stored) ? stored : undefined;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Width/height from a PNG's IHDR (the first chunk by spec; Ghostscript's png16m writes it at
 * byte 16). Throws on anything that is not a PNG — processing.ts reads the same offsets unchecked
 * for the Textract size guard; here a non-PNG must stop the tiler before it spawns python.
 */
export function pngDimensions(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE) || png.toString("latin1", 12, 16) !== "IHDR") {
    throw new Error("not a PNG (missing signature or IHDR)");
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width === 0 || height === 0) throw new Error(`PNG has an empty dimension (${width}x${height})`);
  return { width, height };
}
