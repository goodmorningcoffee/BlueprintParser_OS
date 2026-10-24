// [census F2 2026-10-24] Admin › Reprocess "PDF channels" (POST /api/admin/reprocess?scope=channels),
// one project at a time. A sibling of reprocess.ts (little line headroom there, and its
// exactly-5-loops guard test counts the per-project loops in that file), modelled on
// reprocess-tiles.ts: this loop carries its own per-project try/catch — a failing project is one
// `error` line, never a truncated stream.
//
// Depends on nothing but the source PDF: downloads `{dataUrl}/original.pdf` (key derived from the
// project row, never stored), runs the census (channel-census.ts runCensus → projectIntelligence
// .channels) and merges each page's record at pageIntelligence.channels with a jsonb merge
// (`existing || {channels}`) so every other key — user-owned or computed — is untouched. Only page
// ROWS are written (a permanently deleted page has none). A page the census could not read keeps
// what it had. ROOT ONLY, like tiles: the script is python on the 2 vCPU / 4 GB WEB task (a
// 200k-path sheet costs ~2 s and ~50 MB; a large set can take a minute of that CPU).
// Counters: updated (records written) · skipped (rows without a record) — per project.

import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { CHANNELS_INTELLIGENCE_KEY, type PageChannelsRecord } from "@/lib/pdf-channels";
import { downloadFromS3 } from "@/lib/s3";
import { withProjectWrite, type ProjectWriteCapability } from "@/server/api/project-write-capability";
import { runCensus, type ChannelCensusDeps } from "./channel-census";
import type { ReprocessStream } from "./reprocess-stream";

export interface ChannelsReprocessProject {
  id: number;
  name: string;
  dataUrl: string;
}

export interface ChannelsReprocessCounters {
  updated: number;
  skipped: number;
  total: number;
}

export const CHANNELS_ROOT_ONLY_MESSAGE = "PDF channels is root-only (it runs python on the web task)";

/** Every page record of one project, merged into pageIntelligence (null → {}) in ONE tx under the lease. */
export async function persistPageChannels(
  capability: ProjectWriteCapability,
  projectId: number,
  rows: ReadonlyArray<{ id: number; record: PageChannelsRecord }>,
): Promise<void> {
  if (rows.length === 0) return;
  await withProjectWrite(capability, projectId, async (tx) => {
    for (const { id, record } of rows) {
      const patch = JSON.stringify({ [CHANNELS_INTELLIGENCE_KEY]: record });
      await tx
        .update(pages)
        .set({ pageIntelligence: sql`coalesce(${pages.pageIntelligence}, '{}'::jsonb) || ${patch}::jsonb` })
        .where(eq(pages.id, id));
    }
  });
}

export async function reprocessChannelsScope(args: {
  projects: readonly ChannelsReprocessProject[];
  withReprocessLease: <T>(projectId: number, operation: (capability: ProjectWriteCapability) => Promise<T>) => Promise<T>;
  stream: ReprocessStream;
  isRootAdmin: boolean;
  /** Injectable for tests (defaults to the real python census). */
  census?: ChannelCensusDeps;
}): Promise<ChannelsReprocessCounters> {
  const { send, debug } = args.stream;
  const c: ChannelsReprocessCounters = { updated: 0, skipped: 0, total: 0 };
  const done = () => send({ type: "done", updated: c.updated, skipped: c.skipped, total: c.total });
  if (!args.isRootAdmin) {
    send({ type: "error", error: CHANNELS_ROOT_ONLY_MESSAGE });
    done();
    return c;
  }
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
        const pdf = await downloadFromS3(`${project.dataUrl}/original.pdf`);
        const { pages: records, summary } = await runCensus(project.id, pdf, capability, args.census);
        const writes = rows.flatMap((r) => {
          const record = records.get(r.pageNumber);
          return record ? [{ id: r.id, record }] : [];
        });
        await persistPageChannels(capability, project.id, writes);
        c.total += rows.length;
        c.updated += writes.length;
        c.skipped += rows.length - writes.length;
        if (writes.length < rows.length) {
          send({ type: "warning", project: project.name, message: `channels not written for ${rows.length - writes.length} page(s) the census could not read` });
        }
        debug("project.channels", { project: project.name, kinds: summary.kinds, truncated: summary.truncated, failedPages: summary.failedPages });
        send({ type: "progress", updated: c.updated, skipped: c.skipped, total: c.total, project: project.name, kinds: summary.kinds });
      });
    } catch (err) {
      // Per-project guard — see reprocess.ts page-names scope for why (S8 / TILE_015 C1).
      logger.error(`[reprocess-channels] Project ${project.name} failed:`, err);
      send({ type: "error", project: project.name, error: err instanceof Error ? err.message : "Failed" });
    }
  }
  done();
  return c;
}
