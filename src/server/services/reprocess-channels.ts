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
// what it had; a census whose page count differs from the project's numPages writes no page record
// (alignedPageRecords — numbering would not line up). ROOT ONLY, like tiles: the script is python
// on the 2 vCPU / 4 GB WEB task (a 200k-path sheet costs ~2 s and ~50 MB; a page past 8 MB of
// content skips bboxlog, so a 2M-path sheet is ~5 s / ~175 MB; a large set can take a minute).
// Counters: updated (records written) · skipped (rows without a record) — per project.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { downloadFromS3 } from "@/lib/s3";
import type { ProjectWriteCapability } from "@/server/api/project-write-capability";
import { alignedPageRecords, persistPageChannels, runCensus, type ChannelCensusDeps } from "./channel-census";
import type { ReprocessStream } from "./reprocess-stream";

export { persistPageChannels } from "./channel-census";

export interface ChannelsReprocessProject {
  id: number;
  name: string;
  dataUrl: string;
  /** Ghostscript's count at upload; a census that disagrees writes no page records. */
  numPages?: number | null;
}

export interface ChannelsReprocessCounters {
  updated: number;
  skipped: number;
  total: number;
}

export const CHANNELS_ROOT_ONLY_MESSAGE = "PDF channels is root-only (it runs python on the web task)";

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
        const { pages: censused, summary, result } = await runCensus(project.id, pdf, capability, args.census);
        const records = alignedPageRecords(project.id, result, censused, project.numPages); // [census F2] null on a page-count mismatch
        const writes = rows.flatMap((r) => {
          const record = records?.get(r.pageNumber);
          return record ? [{ id: r.id, record }] : [];
        });
        await persistPageChannels(capability, project.id, writes);
        c.total += rows.length;
        c.updated += writes.length;
        c.skipped += rows.length - writes.length;
        if (writes.length < rows.length) {
          const why = records ? "the census could not read" : `of a ${result.pageCount}-page census (the project has ${project.numPages})`;
          send({ type: "warning", project: project.name, message: `channels not written for ${rows.length - writes.length} page(s) ${why}` });
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
