// @vitest-environment node
// [tiles T9 2026-10-24] The tiler against a fake cutter (writes marker files where python would write
// PNGs) and the mocked S3 upload: every planned tile is uploaded under its key, the manifest names
// the same rects + keys, the returned record points at the manifest, the tempdir is gone, and the
// safe wrapper turns any failure into one warning + null. The PNG header reader is pinned on a
// hand-built IHDR. Nothing spawns python here — scripts/test_tile_page.py covers the cutter.
import { existsSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

const s3Mocks = vi.hoisted(() => ({ uploadToS3: vi.fn(async (_key: string, _body: Buffer, _type: string, _cache?: string) => {}) }));
vi.mock("@/lib/s3", async (importOriginal) => ({ ...(await importOriginal<object>()), uploadToS3: s3Mocks.uploadToS3 }));

import { logger } from "@/lib/logger";
import type { CutTile } from "../cut";
import { isTilesRecord, pngDimensions, staleTileKeys, storedTiles, tileKey, tileKeyPageNumber, tilesManifestKey, type TilesManifest, type TilesRecord } from "../keys";
import { Semaphore, tileCutConcurrency, tilePage, tilePageSafely, tileName } from "../tiler";

/** A PNG with only the header: signature + IHDR for width x height (what pngDimensions reads). */
function pngHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b[24] = 8; // bit depth
  b[25] = 2; // RGB
  return b;
}

const seen: { pngPath?: string; outDir?: string; tiles?: CutTile[] } = {};
const fakeCut = async (pngPath: string, outDir: string, tiles: readonly CutTile[]) => {
  seen.pngPath = pngPath;
  seen.outDir = outDir;
  seen.tiles = [...tiles];
  for (const t of tiles) {
    const p = join(outDir, t.name);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, `tile:${t.name}:${t.x},${t.y},${t.w},${t.h}`);
  }
};

afterEach(() => {
  vi.restoreAllMocks();
  s3Mocks.uploadToS3.mockReset();
  s3Mocks.uploadToS3.mockImplementation(async () => {});
});

describe("pngDimensions + keys", () => {
  it("reads IHDR and refuses anything else", () => {
    expect(pngDimensions(pngHeader(10800, 7200))).toEqual({ width: 10800, height: 7200 });
    expect(() => pngDimensions(Buffer.alloc(32))).toThrow(/not a PNG/);
    expect(() => pngDimensions(Buffer.from("fake-bytes"))).toThrow(/not a PNG/);
    expect(() => pngDimensions(pngHeader(0, 7200))).toThrow(/empty dimension/);
  });

  it("key grammar: level-first prefix, page_NNNN, r<row>_c<col>; the manifest sits beside the page image", () => {
    expect(tileKey("acme/abc", 3600, 7, 2, 3)).toBe("acme/abc/tiles/L3600/page_0007/r2_c3.png");
    expect(tilesManifestKey("acme/abc", 7)).toBe("acme/abc/pages/page_0007/tiles.json");
    expect(tileKeyPageNumber("acme/abc/tiles/L3600/page_0007/r2_c3.png")).toBe(7);
    expect(tileKeyPageNumber("acme/abc/tiles/L1280/page_0120/r0_c0.png")).toBe(120);
    expect(tileKeyPageNumber("acme/abc/pages/page_0007.png")).toBeNull();
    expect(tileKeyPageNumber("acme/abc/yolo-output/m/page_0007.json")).toBeNull();
    expect(storedTiles(null)).toBeUndefined();
    expect(storedTiles({ tiles: { v: 1 } })).toBeUndefined();
    expect(isTilesRecord({ v: 1, width: 1, height: 1, overlap: 0.2, tiledAt: "t", levels: [{ size: 1280, rows: 1, cols: 1, tiles: 1 }] })).toBe(true);
    expect(isTilesRecord({ v: 2, width: 1, height: 1, overlap: 0.2, tiledAt: "t", levels: [] })).toBe(false);
    // [T9 fix round] the pre-fix shape carried an S3 key in member-writable jsonb — never a record again
    expect(isTilesRecord({ v: 1, manifestKey: "other/tenant/original.pdf", width: 1, height: 1, overlap: 0.2, tiledAt: "t", levels: [] })).toBe(false);
  });

  it("[T9 fix round] staleTileKeys names only the dropped levels' tiles, from the caller's dataUrl and the previous rows × cols", () => {
    const rec = (levels: Array<[number, number, number]>): TilesRecord => ({
      v: 1, width: 1, height: 1, overlap: 0.2, tiledAt: "t", levels: levels.map(([size, rows, cols]) => ({ size, rows, cols, tiles: rows * cols })),
    });
    expect(staleTileKeys("acme/abc", 7, undefined, rec([[3600, 1, 1]]))).toEqual([]);
    expect(staleTileKeys("acme/abc", 7, rec([[3600, 3, 4], [1280, 8, 10]]), rec([[3600, 3, 4], [1280, 8, 10]]))).toEqual([]);
    expect(staleTileKeys("acme/abc", 7, rec([[1824, 1, 2], [1280, 3, 3]]), rec([[3600, 1, 1], [1280, 1, 1]]))).toEqual([
      "acme/abc/tiles/L1824/page_0007/r0_c0.png",
      "acme/abc/tiles/L1824/page_0007/r0_c1.png",
    ]);
  });
});

describe("tilePage", () => {
  it("cuts the planned tiles, uploads each under its key (immutable) plus the manifest, returns the record, cleans up", async () => {
    const now = new Date("2026-10-24T12:00:00.000Z");
    const record = await tilePage(
      { dataUrl: "acme/abc", pageNumber: 3, png: pngHeader(3000, 2000), levels: [2000, 1280] },
      { cut: fakeCut, now: () => now, uploadConcurrency: 2 },
    );

    // plan: L2000 → xs [0, 1000], ys [0]; L1280 → xs [0, 1024, 1720], ys [0, 720] → 2 + 6 tiles
    expect(seen.tiles!.map((t) => t.name)).toEqual([
      "L2000/r0_c0.png", "L2000/r0_c1.png",
      "L1280/r0_c0.png", "L1280/r0_c1.png", "L1280/r0_c2.png", "L1280/r1_c0.png", "L1280/r1_c1.png", "L1280/r1_c2.png",
    ]);
    expect(seen.tiles![1]).toMatchObject({ x: 1000, y: 0, w: 2000, h: 2000 });
    expect(seen.tiles![7]).toMatchObject({ x: 1720, y: 720, w: 1280, h: 1280 });
    expect(tileName(2000, 0, 1)).toBe("L2000/r0_c1.png");

    const uploads = s3Mocks.uploadToS3.mock.calls as unknown as Array<[string, Buffer, string, string | undefined]>;
    expect(uploads).toHaveLength(9);
    const tileUploads = uploads.filter(([k]) => k.endsWith(".png"));
    // two upload workers may interleave, so compare as sets
    expect([...tileUploads.map(([k]) => k)].sort()).toEqual(seen.tiles!.map((t) => `acme/abc/tiles/${t.name.replace("/", "/page_0003/")}`).sort());
    for (const [key, body, type, cache] of tileUploads) {
      expect(type).toBe("image/png");
      expect(cache).toBe("public, max-age=31536000, immutable");
      const t = seen.tiles!.find((x) => key.endsWith(x.name.split("/")[1]) && key.includes(`/${x.name.split("/")[0]}/`))!;
      expect(body.toString()).toBe(`tile:${t.name}:${t.x},${t.y},${t.w},${t.h}`); // the file python wrote is what went up
    }

    const [manifestKey, manifestBody, manifestType, manifestCache] = uploads[8];
    expect(manifestKey).toBe("acme/abc/pages/page_0003/tiles.json");
    expect(manifestType).toBe("application/json");
    expect(manifestCache).toBeUndefined();
    const manifest = JSON.parse(manifestBody.toString()) as TilesManifest;
    expect(manifest).toMatchObject({ v: 1, pageNumber: 3, width: 3000, height: 2000, overlap: 0.2, tiledAt: now.toISOString() });
    // [T9 fix round] project-relative paths only: the manifest never names the dataUrl
    expect(manifest.levels.map((l) => [l.size, l.stride, l.rows, l.cols, l.prefix, l.tiles.length])).toEqual([
      [2000, 1600, 1, 2, "tiles/L2000/page_0003/", 2],
      [1280, 1024, 2, 3, "tiles/L1280/page_0003/", 6],
    ]);
    expect(manifest.levels[1].tiles[5]).toEqual({ row: 1, col: 2, x: 1720, y: 720, w: 1280, h: 1280, path: "tiles/L1280/page_0003/r1_c2.png" });
    expect(manifestBody.toString()).not.toContain("acme/abc");

    expect(record).toEqual({
      v: 1,
      width: 3000,
      height: 2000,
      overlap: 0.2,
      levels: [{ size: 2000, rows: 1, cols: 2, tiles: 2 }, { size: 1280, rows: 2, cols: 3, tiles: 6 }],
      tiledAt: now.toISOString(),
    });
    expect(isTilesRecord(record)).toBe(true);
    expect(JSON.stringify(record)).not.toContain("acme/abc"); // no S3 key in the row (page window, data export, bp-export/1 all emit it)
    expect(storedTiles({ tiles: record, parsedRegions: [] })).toEqual(record);
    expect(existsSync(seen.outDir!)).toBe(false); // tempdir removed
  });

  it("defaults to the settings' levels (3600, 1280) and a tempdir path python can read", async () => {
    await tilePage({ dataUrl: "acme/abc", pageNumber: 1, png: pngHeader(10800, 7200) }, { cut: fakeCut });
    expect(seen.tiles!.filter((t) => t.name.startsWith("L3600/"))).toHaveLength(12);
    expect(seen.tiles!.filter((t) => t.name.startsWith("L1280/"))).toHaveLength(77);
    expect(seen.pngPath!.endsWith("/page.png")).toBe(true);
    expect(s3Mocks.uploadToS3).toHaveBeenCalledTimes(90);
  });

  it("throws on a non-PNG before cutting; uploads nothing when the cutter fails; the manifest is written last", async () => {
    const cut = vi.fn(fakeCut);
    await expect(tilePage({ dataUrl: "a/b", pageNumber: 1, png: Buffer.alloc(32) }, { cut })).rejects.toThrow(/not a PNG/);
    expect(cut).not.toHaveBeenCalled();
    expect(s3Mocks.uploadToS3).not.toHaveBeenCalled();

    const failing = vi.fn(async () => {
      throw new Error("tile_page.py: image_decode_failed");
    });
    await expect(tilePage({ dataUrl: "a/b", pageNumber: 1, png: pngHeader(100, 100), levels: [64] }, { cut: failing })).rejects.toThrow(/image_decode_failed/);
    expect(s3Mocks.uploadToS3).not.toHaveBeenCalled();

    s3Mocks.uploadToS3.mockImplementation(async () => {
      throw new Error("AccessDenied");
    });
    await expect(tilePage({ dataUrl: "a/b", pageNumber: 1, png: pngHeader(100, 100), levels: [64] }, { cut: fakeCut })).rejects.toThrow(/AccessDenied/);
    await new Promise((r) => setTimeout(r, 20)); // let the other upload worker drain
    expect(s3Mocks.uploadToS3.mock.calls.some(([k]) => k.endsWith("tiles.json"))).toBe(false);
  });

  it("tilePageSafely: one warning and null on failure, the record on success", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    expect(await tilePageSafely({ dataUrl: "a/b", pageNumber: 4, png: Buffer.from("fake-bytes") }, { cut: fakeCut })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/Page 4 tiling failed/);
    const ok = await tilePageSafely({ dataUrl: "a/b", pageNumber: 4, png: pngHeader(100, 100), levels: [64] }, { cut: fakeCut });
    expect(ok?.levels).toEqual([{ size: 64, rows: 2, cols: 2, tiles: 4 }]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("[T9 fix round] the python cutter is gated by one semaphore, independent of how many pages tile at once", async () => {
    const gate = new Semaphore(2);
    let inFlight = 0;
    let peak = 0;
    const slowCut = async (pngPath: string, outDir: string, tiles: readonly CutTile[]) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight--;
      await fakeCut(pngPath, outDir, tiles);
    };
    const pagesAtOnce = [1, 2, 3, 4, 5, 6];
    const records = await Promise.all(
      pagesAtOnce.map((n) => tilePage({ dataUrl: "a/b", pageNumber: n, png: pngHeader(100, 100), levels: [64] }, { cut: slowCut, gate })),
    );
    expect(records).toHaveLength(6);
    expect(peak).toBe(2);
    expect(gate.inFlight).toBe(0);
    expect(s3Mocks.uploadToS3).toHaveBeenCalledTimes(6 * 5); // 4 tiles + manifest per page: nothing else is gated

    // a throwing cutter releases its slot
    const failing = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(tilePage({ dataUrl: "a/b", pageNumber: 9, png: pngHeader(100, 100), levels: [64] }, { cut: failing, gate })).rejects.toThrow(/boom/);
    expect(gate.inFlight).toBe(0);

    expect(tileCutConcurrency({})).toBe(2);
    expect(tileCutConcurrency({ TILES_CUT_CONCURRENCY: "4" })).toBe(4);
    expect(tileCutConcurrency({ TILES_CUT_CONCURRENCY: "99" })).toBe(8);
    expect(tileCutConcurrency({ TILES_CUT_CONCURRENCY: "0" })).toBe(2);
    expect(tileCutConcurrency({ TILES_CUT_CONCURRENCY: "lots" })).toBe(2);
    expect(() => new Semaphore(0)).toThrow(/positive integer/);
  });
});
