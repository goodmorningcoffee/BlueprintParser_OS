// @vitest-environment node
// [tiles T9 2026-10-24] The Reprocess "Tile images" scope against the real test DB with the two true
// edges mocked (S3 download, the tiler). Pins: every page ROW is tiled from pages/page_NNNN.png (a
// deleted page — no row — is skipped), the record lands at pageIntelligence.tiles with every other
// key (user-owned parsedRegions, computed classifiedTables, a future key) untouched and a NULL
// intelligence becomes {tiles}, a page whose raster is missing or whose cut fails is counted failed
// with a warning line and its row left exactly as it was, a project that throws is one `error` line
// and the stream still gets `done`, and the level list reaches the tiler. T9 fix round: a non-root
// caller gets one error line and nothing is tiled; a re-tile deletes the tiles of dropped levels
// (keys derived from the previous record's rows × cols, never from a stored key) and a failed stale
// delete is a debug line only.
import { beforeEach, describe, expect, inject, it, vi } from "vitest";

const s3Mocks = vi.hoisted(() => ({ downloadFromS3: vi.fn(async (_key: string) => Buffer.from("png-bytes")) }));
vi.mock("@/lib/s3", async (importOriginal) => ({ ...(await importOriginal<object>()), downloadFromS3: s3Mocks.downloadFromS3 }));

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import type { TilesRecord } from "@/lib/tiles/keys";
import type { tilePage } from "@/lib/tiles/tiler";
import { assertProjectWritable } from "@/server/api/project-write-capability";
import { TILES_ROOT_ONLY_MESSAGE, reprocessTilesScope } from "@/server/services/reprocess-tiles";
import type { ReprocessStream } from "@/server/services/reprocess-stream";
import { createPage, createProject, createWorld } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

function fakeStream() {
  const events: Record<string, unknown>[] = [];
  const debugLines: Array<[string, Record<string, unknown> | undefined]> = [];
  const stream: ReprocessStream = {
    send: (e) => {
      events.push(e);
    },
    debug: (step, fields) => {
      debugLines.push([step, fields]);
    },
    isClosed: () => false,
    close: () => {},
    debugEnabled: true,
  };
  return { stream, events, debugLines };
}

const record = (_page: number, _dataUrl: string, levels: readonly number[]): TilesRecord => ({
  v: 1,
  width: 10800,
  height: 7200,
  overlap: 0.2,
  levels: levels.map((size) => ({ size, rows: 3, cols: 4, tiles: 12 })),
  tiledAt: "2026-10-24T00:00:00.000Z",
});

const intelligenceOf = async (pageId: number) =>
  (await db.select({ pi: pages.pageIntelligence }).from(pages).where(eq(pages.id, pageId)))[0].pi as Record<string, unknown> | null;

beforeEach(() => {
  vi.clearAllMocks();
  s3Mocks.downloadFromS3.mockImplementation(async () => Buffer.from("png-bytes"));
});

describe.skipIf(!dbUp)("reprocessTilesScope", () => {
  it("tiles every page row from its page PNG, merges the record into pageIntelligence, reports counts", async () => {
    const { project } = await createWorld({ numPages: 4 });
    const p1 = await createPage(project.id, 1, { pageIntelligence: { parsedRegions: [{ id: "r1" }], classifiedTables: [{ x: 1 }], futureKey: true } as never });
    const p2 = await createPage(project.id, 2); // NULL intelligence
    // page 3 permanently deleted: no row → never tiled
    const p4 = await createPage(project.id, 4, { pageIntelligence: { tiles: { v: 1, stale: true } } as never });
    const tile = vi.fn<typeof tilePage>(async (input) => record(input.pageNumber, input.dataUrl, input.levels ?? []));
    const { stream, events, debugLines } = fakeStream();

    const counters = await reprocessTilesScope({
      projects: [project],
      withReprocessLease: (id, op) => op(assertProjectWritable({ ...project, id })),
      stream,
      levels: [3600, 1280],
      isRootAdmin: true,
      tile,
    });

    expect(counters).toEqual({ updated: 3, failed: 0, total: 3 });
    expect(s3Mocks.downloadFromS3.mock.calls.map(([k]) => k)).toEqual([1, 2, 4].map((n) => `${project.dataUrl}/pages/page_000${n}.png`));
    expect(tile.mock.calls.map(([i]) => [i.pageNumber, i.levels, i.png.toString()])).toEqual([
      [1, [3600, 1280], "png-bytes"], [2, [3600, 1280], "png-bytes"], [4, [3600, 1280], "png-bytes"],
    ]);
    expect(await intelligenceOf(p1.id)).toEqual({
      parsedRegions: [{ id: "r1" }], classifiedTables: [{ x: 1 }], futureKey: true, tiles: record(1, project.dataUrl, [3600, 1280]),
    });
    expect(await intelligenceOf(p2.id)).toEqual({ tiles: record(2, project.dataUrl, [3600, 1280]) });
    expect(await intelligenceOf(p4.id)).toEqual({ tiles: record(4, project.dataUrl, [3600, 1280]) }); // stale pointer replaced

    expect(events[0]).toEqual({ type: "config", levels: [3600, 1280] });
    expect(events[1]).toEqual({ type: "project", name: project.name, pages: 3 });
    expect(events.at(-2)).toEqual({ type: "progress", updated: 3, skipped: 0, total: 3, project: project.name });
    expect(events.at(-1)).toEqual({ type: "done", updated: 3, skipped: 0, total: 3 });
    expect(debugLines.map(([s, f]) => [s, f?.page])).toEqual([["page.tiled", 1], ["page.tiled", 2], ["page.tiled", 4]]);
  });

  it("a missing raster or a failed cut counts as failed with a warning line; that row is left exactly as it was", async () => {
    const { project } = await createWorld({ numPages: 3 });
    const before = { parsedRegions: [{ id: "keep" }], tiles: { v: 1, width: 1, height: 1, overlap: 0.2, levels: [], tiledAt: "t" } };
    const p1 = await createPage(project.id, 1, { pageIntelligence: before as never });
    const p2 = await createPage(project.id, 2);
    const p3 = await createPage(project.id, 3);
    s3Mocks.downloadFromS3.mockImplementation(async (key: string) => {
      if (key.endsWith("page_0001.png")) throw new Error("NoSuchKey");
      return Buffer.from("png-bytes");
    });
    const tile = vi.fn<typeof tilePage>(async (input) => {
      if (input.pageNumber === 2) throw new Error("tile_page.py: image_decode_failed");
      return record(input.pageNumber, input.dataUrl, [1280]);
    });
    const { stream, events } = fakeStream();

    const counters = await reprocessTilesScope({
      projects: [project],
      withReprocessLease: (id, op) => op(assertProjectWritable({ ...project, id })),
      stream,
      levels: [1280],
      isRootAdmin: true,
      tile,
    });

    expect(counters).toEqual({ updated: 1, failed: 2, total: 3 });
    expect(await intelligenceOf(p1.id)).toEqual(before);
    expect(await intelligenceOf(p2.id)).toBeNull();
    expect(await intelligenceOf(p3.id)).toEqual({ tiles: record(3, project.dataUrl, [1280]) });
    const warnings = events.filter((e) => e.type === "warning");
    expect(warnings).toEqual([
      { type: "warning", project: project.name, page: 1, message: "tiles not written: NoSuchKey" },
      { type: "warning", project: project.name, page: 2, message: "tiles not written: tile_page.py: image_decode_failed" },
    ]);
    expect(events.at(-1)).toEqual({ type: "done", updated: 1, skipped: 2, total: 3 });
  });

  it("a project without rows is skipped silently; a project whose lease throws is one error line and the run continues to done", async () => {
    const { company, user, project: good } = await createWorld({ numPages: 1 });
    const empty = await createProject(company.id, user.id, { numPages: 2 });
    const broken = await createProject(company.id, user.id, { numPages: 1 });
    await createPage(good.id, 1);
    await createPage(broken.id, 1);
    const tile = vi.fn<typeof tilePage>(async (input) => record(input.pageNumber, input.dataUrl, [1280]));
    const { stream, events } = fakeStream();

    const counters = await reprocessTilesScope({
      projects: [empty, broken, good],
      withReprocessLease: (id, op) => {
        if (id === broken.id) throw new Error("project is busy");
        return op(assertProjectWritable({ ...good, id }));
      },
      stream,
      levels: [1280],
      isRootAdmin: true,
      tile,
    });

    expect(counters).toEqual({ updated: 1, failed: 0, total: 1 });
    expect(events.filter((e) => e.type === "error")).toEqual([{ type: "error", project: broken.name, error: "project is busy" }]);
    expect(events.filter((e) => e.type === "project")).toEqual([{ type: "project", name: good.name, pages: 1 }]);
    expect(events.at(-1)).toEqual({ type: "done", updated: 1, skipped: 0, total: 1 });
    expect(tile).toHaveBeenCalledTimes(1);
  });

  it("[T9 fix round] non-root: one error line, done, nothing downloaded or tiled", async () => {
    const { project } = await createWorld({ numPages: 1 });
    const p1 = await createPage(project.id, 1);
    const tile = vi.fn<typeof tilePage>(async (input) => record(input.pageNumber, input.dataUrl, [1280]));
    const lease = vi.fn((id: number, op: (c: ReturnType<typeof assertProjectWritable>) => Promise<unknown>) => op(assertProjectWritable({ ...project, id })));
    const { stream, events } = fakeStream();

    const counters = await reprocessTilesScope({ projects: [project], withReprocessLease: lease as never, stream, levels: [1280], isRootAdmin: false, tile });

    expect(counters).toEqual({ updated: 0, failed: 0, total: 0 });
    expect(events).toEqual([{ type: "error", error: TILES_ROOT_ONLY_MESSAGE }, { type: "done", updated: 0, skipped: 0, total: 0 }]);
    expect(tile).not.toHaveBeenCalled();
    expect(lease).not.toHaveBeenCalled();
    expect(s3Mocks.downloadFromS3).not.toHaveBeenCalled();
    expect(await intelligenceOf(p1.id)).toBeNull();
  });

  it("[T9 fix round] a re-tile with other levels deletes the dropped levels' tiles (derived keys); a failed stale delete is a debug line only", async () => {
    const { project } = await createWorld({ numPages: 3 });
    const previous = (levels: Array<[number, number, number]>) => ({
      v: 1, width: 10800, height: 7200, overlap: 0.2, tiledAt: "t",
      levels: levels.map(([size, rows, cols]) => ({ size, rows, cols, tiles: rows * cols })),
    });
    const p1 = await createPage(project.id, 1, { pageIntelligence: { tiles: previous([[1824, 1, 2], [1280, 5, 5]]) } as never }); // 1824 dropped
    const p2 = await createPage(project.id, 2, { pageIntelligence: { tiles: previous([[3600, 3, 4], [1280, 5, 5]]) } as never }); // nothing dropped
    const p3 = await createPage(project.id, 3, { pageIntelligence: { tiles: { v: 1, manifestKey: "other/tenant/x", width: 1, height: 1, overlap: 0.2, levels: [{ size: 999, rows: 1, cols: 1, tiles: 1 }], tiledAt: "t" } } as never }); // pre-fix shape: not a record → no stale keys
    const tile = vi.fn<typeof tilePage>(async (input) => record(input.pageNumber, input.dataUrl, input.levels ?? []));
    const deleteObject = vi.fn(async (key: string) => {
      if (key.endsWith("r0_c1.png")) throw new Error("Denied");
    });
    const { stream, events, debugLines } = fakeStream();

    const counters = await reprocessTilesScope({
      projects: [project],
      withReprocessLease: (id, op) => op(assertProjectWritable({ ...project, id })),
      stream,
      levels: [3600, 1280],
      isRootAdmin: true,
      tile,
      deleteObject,
    });

    expect(counters).toEqual({ updated: 3, failed: 0, total: 3 });
    expect(deleteObject.mock.calls.map(([k]) => k)).toEqual([
      `${project.dataUrl}/tiles/L1824/page_0001/r0_c0.png`,
      `${project.dataUrl}/tiles/L1824/page_0001/r0_c1.png`,
    ]);
    expect(await intelligenceOf(p1.id)).toEqual({ tiles: record(1, project.dataUrl, [3600, 1280]) });
    expect(await intelligenceOf(p2.id)).toEqual({ tiles: record(2, project.dataUrl, [3600, 1280]) });
    expect(await intelligenceOf(p3.id)).toEqual({ tiles: record(3, project.dataUrl, [3600, 1280]) }); // forged key gone
    expect(events.filter((e) => e.type === "warning" || e.type === "error")).toEqual([]);
    expect(debugLines.filter(([s]) => s === "page.stale-tile-kept").map(([, f]) => f?.key)).toEqual([`${project.dataUrl}/tiles/L1824/page_0001/r0_c1.png`]);
    expect(debugLines.filter(([s]) => s === "page.stale-tiles").map(([, f]) => [f?.page, f?.deleted])).toEqual([[1, 2]]);
    expect(events.at(-1)).toEqual({ type: "done", updated: 3, skipped: 0, total: 3 });
  });
});
