// [tiles T9 2026-10-24] Admin › Reprocess "Tile images" (POST /api/admin/reprocess?scope=tiles),
// one project at a time. A sibling of reprocess.ts (zero line headroom there; its exactly-5-loops
// guard test counts the per-project loops in that file, so this loop lives here with its own
// per-project try/catch — a failing project is one `error` line, never a truncated stream).
//
// Depends on nothing but the page raster: downloads pages/page_NNNN.png, cuts + uploads the tile
// pyramid (lib/tiles/tiler.ts) and stores the record at pageIntelligence.tiles with a jsonb merge
// (`existing || {tiles}`) so every other key — user-owned or computed — is untouched. Pages without
// a row (permanently deleted) are never tiled: the loop walks the rows. The root `tiles_enabled`
// switch governs UPLOADS only; this stage is an explicit admin action and runs regardless, with the
// configured level list. Counters: updated (tiles written) · failed (page left as it was — image
// missing, cut or upload failed).
//
// T9 fix round (2026-10-24):
//   · ROOT ONLY. The cutter is python on the 2 vCPU / 4 GB WEB task — minutes of CPU per large
//     project taken from the task that serves users — so the stage is `rootOnly` in reprocess-plan
//     and this is the in-service belt: a non-root caller gets one `error` line and `done`.
//   · STALE LEVELS. A re-tile with a different level list overwrites the kept levels in place and
//     deletes the tiles of the levels the new record no longer has (keys expanded from the previous
//     record's rows × cols by lib/tiles/keys.ts staleTileKeys — never from a stored key). A failed
//     stale delete is a debug line, not a failed page: leftover tiles are harmless and the next
//     project purge removes them. Noncurrent versions of overwritten tiles follow the bucket's
//     90-day lifecycle rule (s3.tf) — nothing here can shorten that.

import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { deleteFromS3, downloadFromS3 } from "@/lib/s3";
import { TILES_INTELLIGENCE_KEY, staleTileKeys, storedTiles, type TilesRecord } from "@/lib/tiles/keys";
import { tilePage } from "@/lib/tiles/tiler";
import { withProjectWrite, type ProjectWriteCapability } from "@/server/api/project-write-capability";
import { pageImageKey } from "./reprocess-shape-parse";
import type { ReprocessStream } from "./reprocess-stream";

export interface TilesReprocessProject {
  id: number;
  name: string;
  dataUrl: string;
}

export interface TilesReprocessCounters {
  /** pages whose tiles + manifest were written and recorded */
  updated: number;
  /** pages that could not be tiled — previous tiles/record left untouched */
  failed: number;
  total: number;
}

export interface TilesReprocessArgs {
  projects: readonly TilesReprocessProject[];
  /** reprocess.ts's durable `admin-reprocess:tiles` lease per project. */
  withReprocessLease: <T>(projectId: number, operation: (capability: ProjectWriteCapability) => Promise<T>) => Promise<T>;
  stream: ReprocessStream;
  levels: readonly number[];
  /** The caller's session flag; false → one error line, nothing tiled. */
  isRootAdmin: boolean;
  /** Injectable for tests (defaults to the real tiler, which spawns python). */
  tile?: typeof tilePage;
  /** Injectable for tests (defaults to the real S3 delete). */
  deleteObject?: (key: string) => Promise<void>;
}

export const TILES_ROOT_ONLY_MESSAGE = "Tile images is root-only (it runs python on the web task)";

/** One page's record, merged into pageIntelligence (null → {}) in one tx under the lease. */
export async function persistPageTiles(
  capability: ProjectWriteCapability,
  projectId: number,
  pageId: number,
  record: TilesRecord,
): Promise<void> {
  const patch = JSON.stringify({ [TILES_INTELLIGENCE_KEY]: record });
  await withProjectWrite(capability, projectId, async (tx) => {
    await tx
      .update(pages)
      .set({ pageIntelligence: sql`coalesce(${pages.pageIntelligence}, '{}'::jsonb) || ${patch}::jsonb` })
      .where(eq(pages.id, pageId));
  });
}

export async function reprocessTilesScope(args: TilesReprocessArgs): Promise<TilesReprocessCounters> {
  const { send, debug } = args.stream;
  const tile = args.tile ?? tilePage;
  const deleteObject = args.deleteObject ?? deleteFromS3;
  const counters: TilesReprocessCounters = { updated: 0, failed: 0, total: 0 };
  const progress = (project: string) =>
    send({ type: "progress", updated: counters.updated, skipped: counters.failed, total: counters.total, project });

  if (!args.isRootAdmin) {
    send({ type: "error", error: TILES_ROOT_ONLY_MESSAGE });
    send({ type: "done", updated: 0, skipped: 0, total: 0 });
    return counters;
  }

  send({ type: "config", levels: [...args.levels] });
  for (const project of args.projects) {
    try {
      const rows = await db
        .select({ id: pages.id, pageNumber: pages.pageNumber, tiles: sql<unknown>`${pages.pageIntelligence}->'tiles'` })
        .from(pages)
        .where(eq(pages.projectId, project.id))
        .orderBy(pages.pageNumber);
      if (rows.length === 0) continue;
      await args.withReprocessLease(project.id, async (capability) => {
        send({ type: "project", name: project.name, pages: rows.length });
        for (const row of rows) {
          counters.total++;
          try {
            const png = await downloadFromS3(pageImageKey(project.dataUrl, row.pageNumber));
            const record = await tile({ dataUrl: project.dataUrl, pageNumber: row.pageNumber, png, levels: args.levels });
            await persistPageTiles(capability, project.id, row.id, record);
            counters.updated++;
            debug("page.tiled", { project: project.name, page: row.pageNumber, levels: record.levels });
            const stale = staleTileKeys(project.dataUrl, row.pageNumber, storedTiles({ tiles: row.tiles }), record);
            for (const key of stale) {
              try {
                await deleteObject(key);
              } catch (err) {
                debug("page.stale-tile-kept", { project: project.name, page: row.pageNumber, key, reason: err instanceof Error ? err.message : String(err) });
              }
            }
            if (stale.length > 0) debug("page.stale-tiles", { project: project.name, page: row.pageNumber, deleted: stale.length });
          } catch (err) {
            counters.failed++;
            const reason = err instanceof Error ? err.message : String(err);
            logger.error(`[reprocess-tiles] Page ${row.pageNumber} failed for ${project.name}:`, err);
            send({ type: "warning", project: project.name, page: row.pageNumber, message: `tiles not written: ${reason}` });
          }
          if (counters.total % 5 === 0) progress(project.name);
        }
        progress(project.name);
      });
    } catch (err) {
      // Per-project guard — see reprocess.ts page-names scope for why (S8 / TILE_015 C1).
      logger.error(`[reprocess-tiles] Project ${project.name} failed:`, err);
      send({ type: "error", project: project.name, error: err instanceof Error ? err.message : "Failed" });
    }
  }
  send({ type: "done", updated: counters.updated, skipped: counters.failed, total: counters.total });
  return counters;
}
