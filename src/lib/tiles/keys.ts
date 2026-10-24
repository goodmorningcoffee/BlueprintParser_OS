// [tiles T9 2026-10-24] Where a page's tiles live and how a page row points at them. Pure.
//
//   {dataUrl}/tiles/L{size}/page_{NNNN}/r{row}_c{col}.png   one PNG per tile, native 300-DPI pixels
//   {dataUrl}/pages/page_{NNNN}/tiles.json                  the manifest: every level + rect + path
//   pageIntelligence.tiles                                   TilesRecord — sizes + counts, NO keys
//
// Everything sits under the project's dataUrl, so project deletion (deleteProjectFiles purges
// `{dataUrl}/`) removes tiles with the rest; page-permanent-delete lists `{dataUrl}/tiles/` for the
// page's tiles and derives the manifest key. `tiles` is NOT a REPROCESS_COMPUTED_KEY on purpose: the
// intelligence reprocess rebuilds derived data, but tiles are physical objects that stay valid until
// the page raster or the tile settings change — the Reprocess "Tile images" stage rewrites them.
//
// ⚠ NO S3 KEY IS EVER STORED (T9 fix round, 2026-10-24). pageIntelligence reaches every project
// member (page window), the admin data export (whose contract is "never emitted: dataUrl and any
// other S3 key") and bp-export/1 — and a member can PATCH it. So the record holds sizes and counts
// only, every key is DERIVED from (dataUrl, pageNumber) by the functions below, and the manifest in
// S3 names its tiles by project-RELATIVE path. A record that still carries a `manifestKey` (written
// by 1882a1b before this fix) is simply not a TilesRecord any more and is re-tiled on the next run.

import type { TileRect } from "./plan";

export const TILES_INTELLIGENCE_KEY = "tiles";
export const TILES_RECORD_VERSION = 1;

const pad4 = (n: number) => String(n).padStart(4, "0");

/** Project-relative paths (what the manifest stores; prepend `${dataUrl}/` for the S3 key). */
export function tilesLevelRelPrefix(size: number, pageNumber: number): string {
  return `tiles/L${size}/page_${pad4(pageNumber)}/`;
}

export function tileRelPath(size: number, pageNumber: number, row: number, col: number): string {
  return `${tilesLevelRelPrefix(size, pageNumber)}r${row}_c${col}.png`;
}

export function tilesRootPrefix(dataUrl: string): string {
  return `${dataUrl}/tiles/`;
}

export function tilesLevelPrefix(dataUrl: string, size: number, pageNumber: number): string {
  return `${dataUrl}/${tilesLevelRelPrefix(size, pageNumber)}`;
}

export function tileKey(dataUrl: string, size: number, pageNumber: number, row: number, col: number): string {
  return `${dataUrl}/${tileRelPath(size, pageNumber, row, col)}`;
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
  /** Project-relative prefix of this level's tiles for the page (`tiles/L3600/page_0007/`). */
  prefix: string;
  tiles: Array<TileRect & { path: string }>;
}

/** Stored at tilesManifestKey(). Self-describing relative to the project root: no dataUrl inside. */
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

/** pageIntelligence.tiles — small on purpose: the rects live in the manifest, the keys are derived. */
export interface TilesRecord {
  v: typeof TILES_RECORD_VERSION;
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
    !("manifestKey" in r) && // pre-fix shape (1882a1b) carried an S3 key — not a record any more
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

/**
 * Keys of the tiles a re-tile left behind: every level in `previous` that `next` no longer has,
 * expanded from the stored rows × cols (no listing needed). Levels kept are overwritten in place by
 * the tiler, so they are not stale. Nothing here can name another project's objects: every key is
 * built from the caller's (dataUrl, pageNumber), never from the stored record.
 */
export function staleTileKeys(dataUrl: string, pageNumber: number, previous: TilesRecord | undefined, next: TilesRecord): string[] {
  if (!previous) return [];
  const kept = new Set(next.levels.map((l) => l.size));
  const keys: string[] = [];
  for (const level of previous.levels) {
    if (kept.has(level.size)) continue;
    for (let row = 0; row < level.rows; row++) {
      for (let col = 0; col < level.cols; col++) keys.push(tileKey(dataUrl, level.size, pageNumber, row, col));
    }
  }
  return keys;
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
