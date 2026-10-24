// [census F2 2026-10-24] Upload channel census — the project-level pass and its project write.
//
// Started ONCE per upload run from lib/processing.ts, after original.pdf is in memory, BESIDE the
// page loop (not before it — a dense set took 42 s of one core, and every upload used to wait for
// it): runs scripts/pdf_channels.py over the whole PDF (lib/pdf-channels/runner.ts,
// PDF_CHANNELS_TIMEOUT_MS, default 300 s), merges the project summary into
// projectIntelligence.channels (one key, jsonb `||`, so every other key survives) and resolves to
// pageNumber → record. processing.ts awaits it AFTER the page loop and BEFORE project analysis (so
// that read-modify-write sees the key and carries it as non-computed), then persistUploadChannels
// merges each record at pageIntelligence.channels. FAIL-SOFT: any failure is one warning and
// `null`; the upload never fails, waits past the timeout, or changes behaviour over the census.
// The Reprocess "PDF channels" stage (reprocess-channels.ts) reuses runCensus, alignedPageRecords,
// writeProjectChannels and persistPageChannels.

import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { pages as pagesTable, projects } from "@/lib/db/schema";
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
        .update(pagesTable)
        .set({ pageIntelligence: sql`coalesce(${pagesTable.pageIntelligence}, '{}'::jsonb) || ${patch}::jsonb` })
        .where(eq(pagesTable.id, id));
    }
  });
}

/**
 * The per-page records, or null (one warning) when mupdf's page count disagrees with the project's
 * Ghostscript count (numPages, which numbers the page rows): a damaged PDF repaired differently by
 * the two would otherwise land records on the wrong pages. A missing numPages is not checked.
 */
export function alignedPageRecords(
  projectId: number,
  result: PdfChannelsResult,
  records: Map<number, PageChannelsRecord>,
  numPages: number | null | undefined,
): Map<number, PageChannelsRecord> | null {
  if (!numPages || result.pageCount === numPages) return records;
  logger.warn(`[census F2] project ${projectId}: census saw ${result.pageCount} pages, the project has ${numPages} — per-page records dropped`);
  return null;
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

/** The upload pass: never rejects; null on any failure (one warning) or a page-count mismatch. */
export async function censusProjectChannels(
  projectId: number,
  pdf: Buffer,
  writeCapability: ProjectWriteCapability,
  numPages: number,
  deps: ChannelCensusDeps = {},
): Promise<Map<number, PageChannelsRecord> | null> {
  const started = Date.now();
  try {
    const { pages, summary, result } = await runCensus(projectId, pdf, writeCapability, deps);
    logger.info(
      `[census F2] project ${projectId}: ${summary.pages} pages in ${Date.now() - started} ms — ${JSON.stringify(summary.kinds)}${summary.truncated ? " (truncated)" : ""}`,
    );
    return alignedPageRecords(projectId, result, pages, numPages);
  } catch (err) {
    logger.warn(`[census F2] channel census skipped for project ${projectId}:`, err);
    return null;
  }
}

/**
 * The upload's per-page write, after the page loop: every page ROW with a record gets
 * pageIntelligence.channels by jsonb merge (the loop's own keys untouched). Never throws.
 */
export async function persistUploadChannels(
  writeCapability: ProjectWriteCapability,
  projectId: number,
  census: Map<number, PageChannelsRecord> | null,
): Promise<void> {
  if (!census || census.size === 0) return;
  try {
    const rows = await db
      .select({ id: pagesTable.id, pageNumber: pagesTable.pageNumber })
      .from(pagesTable)
      .where(eq(pagesTable.projectId, projectId));
    const writes = rows.flatMap((r) => {
      const record = census.get(r.pageNumber);
      return record ? [{ id: r.id, record }] : [];
    });
    await persistPageChannels(writeCapability, projectId, writes);
  } catch (err) {
    logger.warn(`[census F2] page channels not written for project ${projectId}:`, err);
  }
}

