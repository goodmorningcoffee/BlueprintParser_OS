// [census F2 2026-10-24] Upload channel census — the project-level pass and its project write.
//
// Called ONCE per upload run from lib/processing.ts, after original.pdf is in memory and before
// the page loop: runs scripts/pdf_channels.py over the whole PDF (lib/pdf-channels/runner.ts,
// PDF_CHANNELS_TIMEOUT_MS, default 60 s), merges the project summary into
// projectIntelligence.channels (one key, jsonb `||`, so every other key survives — the later
// project-analysis merge carries it as a non-computed key) and hands back pageNumber → record for
// the page loop to attach at pageIntelligence.channels. FAIL-SOFT: any failure is one warning and
// `null`; the upload never fails, waits past the timeout, or changes behaviour over the census.
// The Reprocess "PDF channels" stage (reprocess-channels.ts) reuses runCensus + writeProjectChannels.

import { eq, sql } from "drizzle-orm";
import { projects } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import {
  CHANNELS_INTELLIGENCE_KEY,
  pageChannelsByNumber,
  summarizeChannels,
  type PageChannelsRecord,
  type PdfChannelsResult,
  type ProjectChannelsSummary,
} from "@/lib/pdf-channels";
import { runPdfChannelsOnBuffer } from "@/lib/pdf-channels/runner";
import { type ProjectWriteCapability, withProjectWrite } from "@/server/api/project-write-capability";

/** Merge ONE key, projectIntelligence.channels, under the caller's capability. */
export async function writeProjectChannels(
  writeCapability: ProjectWriteCapability,
  projectId: number,
  summary: ProjectChannelsSummary,
): Promise<void> {
  await withProjectWrite(writeCapability, projectId, async (tx) => {
    await tx
      .update(projects)
      .set({ projectIntelligence: sql`coalesce(${projects.projectIntelligence}, '{}'::jsonb) || jsonb_build_object(${CHANNELS_INTELLIGENCE_KEY}::text, ${JSON.stringify(summary)}::jsonb)` })
      .where(eq(projects.id, projectId));
  });
}

export interface ChannelCensusDeps {
  run?: (pdf: Buffer) => Promise<PdfChannelsResult>;
  write?: typeof writeProjectChannels;
  now?: () => Date;
}

/**
 * Census + project write. Returns the per-page records and the summary; THROWS on any failure
 * (the reprocess stage counts it). The upload path uses censusProjectChannels below.
 */
export async function runCensus(
  projectId: number,
  pdf: Buffer,
  writeCapability: ProjectWriteCapability,
  deps: ChannelCensusDeps = {},
): Promise<{ pages: Map<number, PageChannelsRecord>; summary: ProjectChannelsSummary; result: PdfChannelsResult }> {
  const result = await (deps.run ?? ((buf: Buffer) => runPdfChannelsOnBuffer(buf)))(pdf);
  const summary = summarizeChannels(result, deps.now?.() ?? new Date());
  await (deps.write ?? writeProjectChannels)(writeCapability, projectId, summary);
  return { pages: pageChannelsByNumber(result), summary, result };
}

/** The upload pass: never throws; null on any failure (one warning). */
export async function censusProjectChannels(
  projectId: number,
  pdf: Buffer,
  writeCapability: ProjectWriteCapability,
  deps: ChannelCensusDeps = {},
): Promise<Map<number, PageChannelsRecord> | null> {
  const started = Date.now();
  try {
    const { pages, summary } = await runCensus(projectId, pdf, writeCapability, deps);
    logger.info(
      `[census F2] project ${projectId}: ${summary.pages} pages in ${Date.now() - started} ms — ${JSON.stringify(summary.kinds)}${summary.truncated ? " (truncated)" : ""}`,
    );
    return pages;
  } catch (err) {
    logger.warn(`[census F2] channel census skipped for project ${projectId}:`, err);
    return null;
  }
}

