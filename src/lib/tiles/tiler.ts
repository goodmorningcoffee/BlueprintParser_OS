// [tiles T9 2026-10-24] Tile one page raster into S3. Called from the upload pipeline
// (lib/processing.ts, right after the 300-DPI page PNG is uploaded, behind the root
// `tiles_enabled` setting) and from the Reprocess "Tile images" stage (services/reprocess-tiles.ts,
// which downloads pages/page_NNNN.png — the stage depends on nothing but the raster).
//
// Steps: read the PNG's size from its header → plan (plan.ts) → write the PNG to a tempdir → cut
// (cut.ts, python/Pillow) → upload every tile + the manifest with the project's existing S3
// helper → return the TilesRecord the caller stores at pageIntelligence.tiles. Tiles are
// cache-immutable like the page images they are cut from (same keys are overwritten on a re-tile,
// the convention the thumbnails scope already relies on); the manifest takes the default
// cache-control because a re-tile with other levels changes it.
//
// Memory (T9 fix round): the python cutter holds the decoded raster (~340 MB for a 113 MP RGB
// sheet). processing.ts runs one page per `pageConcurrency` slot — up to 32 on the default task —
// so the cut step is gated by ONE process-wide semaphore (TILES_CUT_CONCURRENCY, default 2 → at
// most ~700 MB of cutters at once), independent of the page concurrency. The plan, the tempdir
// write and the S3 uploads are not gated; only the python process is.
//
// tilePage THROWS on any failure (the reprocess stage counts it); tilePageSafely logs ONE warning
// and returns null — the upload pipeline must never fail a page over its tiles.

import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { logger } from "@/lib/logger";
import { uploadToS3 } from "@/lib/s3";
import { cutTilesWithPython, type CutTile, type TileCutter } from "./cut";
import {
  pngDimensions,
  tileKey,
  tileRelPath,
  tilesLevelRelPrefix,
  tilesManifestKey,
  TILES_RECORD_VERSION,
  type TilesManifest,
  type TilesRecord,
} from "./keys";
import { planTiles } from "./plan";
import { DEFAULT_TILES_SETTING } from "./settings";

export interface TilePageInput {
  dataUrl: string;
  pageNumber: number;
  /** The page raster (Ghostscript png16m at 300 DPI). */
  png: Buffer;
  levels?: readonly number[];
  overlap?: number;
}

export type TileUploader = (key: string, body: Buffer, contentType: string, cacheControl?: string) => Promise<void>;

/** A counting semaphore: `run` waits for a slot, runs `fn`, releases the slot even when `fn` throws. */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(readonly size: number) {
    if (!Number.isInteger(size) || size < 1) throw new Error(`Semaphore size must be a positive integer, got ${size}`);
  }
  /** Slots in use right now (for tests and log lines). */
  get inFlight(): number {
    return this.active;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.size) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}

export const DEFAULT_TILE_CUT_CONCURRENCY = 2;
const MAX_TILE_CUT_CONCURRENCY = 8;

/** TILES_CUT_CONCURRENCY → 1..8; anything unparseable is the default. */
export function tileCutConcurrency(env: Record<string, string | undefined> = process.env): number {
  const raw = env.TILES_CUT_CONCURRENCY;
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return DEFAULT_TILE_CUT_CONCURRENCY;
  const n = Number(raw.trim());
  return n < 1 ? DEFAULT_TILE_CUT_CONCURRENCY : Math.min(n, MAX_TILE_CUT_CONCURRENCY);
}

/** The one process-wide gate on python cutters (processing.ts pages + a concurrent Reprocess run share it). */
export const cutGate = new Semaphore(tileCutConcurrency());

export interface TilePageDeps {
  cut?: TileCutter;
  upload?: TileUploader;
  /** Parallel S3 PUTs per page (the page loop above is already concurrent). */
  uploadConcurrency?: number;
  /** The python-process gate; defaults to the process-wide cutGate. */
  gate?: Semaphore;
  now?: () => Date;
}

const IMMUTABLE = "public, max-age=31536000, immutable";
const DEFAULT_UPLOAD_CONCURRENCY = 4;

export const tileName = (size: number, row: number, col: number): string => `L${size}/r${row}_c${col}.png`;

async function forEachLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

export async function tilePage(input: TilePageInput, deps: TilePageDeps = {}): Promise<TilesRecord> {
  const cut = deps.cut ?? cutTilesWithPython;
  const upload = deps.upload ?? uploadToS3;
  const gate = deps.gate ?? cutGate;
  const levels = input.levels ?? DEFAULT_TILES_SETTING.levels;
  const overlap = input.overlap ?? DEFAULT_TILES_SETTING.overlap;
  const { dataUrl, pageNumber } = input;

  const { width, height } = pngDimensions(input.png);
  const plan = planTiles(width, height, levels, overlap);
  const cutTiles: Array<CutTile & { key: string }> = [];
  const manifest: TilesManifest = {
    v: TILES_RECORD_VERSION,
    pageNumber,
    width,
    height,
    overlap,
    levels: plan.levels.map((level) => ({
      size: level.size,
      stride: level.stride,
      rows: level.rows,
      cols: level.cols,
      prefix: tilesLevelRelPrefix(level.size, pageNumber),
      tiles: level.tiles.map((t) => {
        cutTiles.push({ name: tileName(level.size, t.row, t.col), x: t.x, y: t.y, w: t.w, h: t.h, key: tileKey(dataUrl, level.size, pageNumber, t.row, t.col) });
        return { ...t, path: tileRelPath(level.size, pageNumber, t.row, t.col) };
      }),
    })),
    tiledAt: (deps.now ?? (() => new Date()))().toISOString(),
  };

  const tempDir = await mkdtemp(join(tmpdir(), "bp2-tiles-"));
  try {
    const pngPath = join(tempDir, "page.png");
    const outDir = join(tempDir, "out");
    await writeFile(pngPath, input.png);
    await gate.run(() => cut(pngPath, outDir, cutTiles));
    await forEachLimited(cutTiles, deps.uploadConcurrency ?? DEFAULT_UPLOAD_CONCURRENCY, async (tile) => {
      await upload(tile.key, await readFile(join(outDir, tile.name)), "image/png", IMMUTABLE);
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  await upload(tilesManifestKey(dataUrl, pageNumber), Buffer.from(JSON.stringify(manifest)), "application/json");

  return {
    v: TILES_RECORD_VERSION,
    width,
    height,
    overlap,
    levels: manifest.levels.map((l) => ({ size: l.size, rows: l.rows, cols: l.cols, tiles: l.tiles.length })),
    tiledAt: manifest.tiledAt,
  };
}

/** Upload-pipeline wrapper: never throws; a failure is one warning line and a null record. */
export async function tilePageSafely(input: TilePageInput, deps: TilePageDeps = {}): Promise<TilesRecord | null> {
  try {
    return await tilePage(input, deps);
  } catch (err) {
    logger.warn(`[tiles] Page ${input.pageNumber} tiling failed (upload continues without tiles):`, err);
    return null;
  }
}
