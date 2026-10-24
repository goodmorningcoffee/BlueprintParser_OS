// [tiles T9 2026-10-24] Admin › Reprocess "Tile images" (POST /api/admin/reprocess?scope=tiles),
// one project at a time. A sibling of reprocess.ts (zero line headroom there; its exactly-5-loops
// guard test counts the per-project loops in that file, so this loop lives here with its own
// per-project try/catch — a failing project is one `error` line, never a truncated stream).
//
// Depends on nothing but the page raster: downloads pages/page_NNNN.png, cuts + uploads the tile
// pyramid (lib/tiles/tiler.ts) and stores the manifest pointer at pageIntelligence.tiles with a
// jsonb merge (`existing || {tiles}`) so every other key — user-owned or computed — is untouched.
// Pages without a row (permanently deleted) are never tiled: the loop walks the rows. The root
// `tiles_enabled` switch governs UPLOADS only; this stage is an explicit admin action and runs
// regardless, with the configured level list. Counters: updated (tiles written) · failed (page
// left as it was — image missing, cut or upload failed).

import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { downloadFromS3 } from "@/lib/s3";
import { TILES_INTELLIGENCE_KEY, type TilesRecord } from "@/lib/tiles/keys";
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
  /** Injectable for tests (defaults to the real tiler, which spawns python). */
  tile?: typeof tilePage;
}

/** One page's manifest pointer, merged into pageIntelligence (null → {}) in one tx under the lease. */
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
  const counters: TilesReprocessCounters = { updated: 0, failed: 0, total: 0 };
  const progress = (project: string) =>
    send({ type: "progress", updated: counters.updated, skipped: counters.failed, total: counters.total, project });

  send({ type: "config", levels: [...args.levels] });
  for (const project of args.projects) {
    try {
      const rows = await db
        .select({ id: pages.id, pageNumber: pages.pageNumber })
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
