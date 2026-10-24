// [classifier engine 2a 2026-10-24] Admin › Reprocess "Classifiers" (POST /api/admin/reprocess
// ?scope=classifiers): the classifier ENGINE only — no YOLO, no OCR, no region v2 recompute. For
// every page with stored YOLO rows it rebuilds `pageIntelligence.classifierProposals` from what is
// already there (regionsV2, pageZones, channels, parsedRegions, textract words / tables, csiCodes,
// drawingNumber) with the company's effective recipes, writes only pages whose record changed
// (jsonb merge of that ONE key — user-owned `proposalVerdicts` and every other key untouched),
// then refreshes `projectIntelligence.proposals`. A sibling of reprocess.ts (zero line headroom
// there, and its per-project loop count is pinned); this loop carries its own per-project guard.

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { annotations, pages } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { storedRegionsV2 } from "@/lib/region-classifier-v2";
import type { ChannelKind } from "@/lib/pdf-channels/types";
import type { PageZones } from "@/lib/page-zones";
import type { CsiCode, KeynoteShapeData, TextractPageData } from "@/types";
import type { ProjectWriteCapability } from "@/server/api/project-write-capability";
import { stableStringify } from "./yolo-post-enrichment";
import { classifierRecipesFor, computeClassifierProposals, writeProjectProposals } from "./classifier-proposals-write";
import type { ReprocessStream } from "./reprocess-stream";
import { withProjectWrite } from "@/server/api/project-write-capability";

export interface ClassifiersReprocessProject { id: number; name: string }

export interface ClassifiersReprocessCounters {
  /** Pages whose classifierProposals record was (re)written. */
  updated: number;
  /** Pages with YOLO rows whose record was unchanged, or without YOLO rows (no candidates). */
  skipped: number;
  total: number;
  proposals: number;
}

/** `pageIntelligence.channels.kind` when the census ran on this page. */
export function storedChannelKind(pageIntelligence: unknown): ChannelKind | null {
  const ch = pageIntelligence && typeof pageIntelligence === "object" ? (pageIntelligence as { channels?: { kind?: unknown } }).channels : undefined;
  return ch && typeof ch === "object" && typeof ch.kind === "string" ? (ch.kind as ChannelKind) : null;
}

export async function reprocessClassifiersScope(args: {
  projects: readonly ClassifiersReprocessProject[];
  withReprocessLease: <T>(projectId: number, operation: (capability: ProjectWriteCapability) => Promise<T>) => Promise<T>;
  stream: ReprocessStream;
  /** `companies.pipeline_config.classifiers` (unknown shape; validated by the engine). */
  overlay: unknown;
}): Promise<ClassifiersReprocessCounters> {
  const { send, debug } = args.stream;
  const c: ClassifiersReprocessCounters = { updated: 0, skipped: 0, total: 0, proposals: 0 };
  const recipes = classifierRecipesFor(args.overlay);
  for (const project of args.projects) {
    try {
      await args.withReprocessLease(project.id, async (capability) => {
        const rows = await db
          .select({
            id: pages.id, pageNumber: pages.pageNumber, drawingNumber: pages.drawingNumber, csiCodes: pages.csiCodes, keynotes: pages.keynotes,
            pageIntelligence: pages.pageIntelligence,
            words: sql<TextractPageData["words"] | null>`${pages.textractData}->'words'`,
            tables: sql<TextractPageData["tables"] | null>`${pages.textractData}->'tables'`,
          })
          .from(pages)
          .where(eq(pages.projectId, project.id))
          .orderBy(pages.pageNumber);
        send({ type: "project", name: project.name, pages: rows.length });
        const yolo = await db
          .select({ name: annotations.name, minX: annotations.minX, minY: annotations.minY, maxX: annotations.maxX, maxY: annotations.maxY, pageNumber: annotations.pageNumber, data: annotations.data })
          .from(annotations)
          .where(and(eq(annotations.projectId, project.id), eq(annotations.source, "yolo")));
        const byPage = new Map<number, Array<{ name: string; minX: number; minY: number; maxX: number; maxY: number; confidence: number; modelName?: string }>>();
        for (const a of yolo) {
          const data = a.data as { confidence?: number; modelName?: string } | null;
          (byPage.get(a.pageNumber) ?? byPage.set(a.pageNumber, []).get(a.pageNumber)!).push({ name: a.name, minX: a.minX, minY: a.minY, maxX: a.maxX, maxY: a.maxY, confidence: data?.confidence ?? 0, modelName: data?.modelName });
        }
        const proposalPages: Array<{ pageNumber: number; pageIntelligence: unknown }> = [];
        for (const page of rows) {
          c.total++;
          const existing = (page.pageIntelligence ?? {}) as Record<string, unknown>;
          const detections = byPage.get(page.pageNumber);
          if (!detections?.length) { c.skipped++; proposalPages.push({ pageNumber: page.pageNumber, pageIntelligence: existing }); continue; }
          const next = computeClassifierProposals({
            pageNumber: page.pageNumber, detections,
            zones: existing.pageZones as PageZones | undefined,
            textractData: Array.isArray(page.words) ? { words: page.words, ...(page.tables ? { tables: page.tables } : {}) } : null,
            csiCodes: (page.csiCodes ?? []) as CsiCode[],
            regionsV2: storedRegionsV2(existing),
            parsedRegions: existing.parsedRegions as ClassifierPageInputParsed,
            drawingNumber: page.drawingNumber,
            channelKind: storedChannelKind(existing),
            keynotes: (page.keynotes ?? null) as readonly KeynoteShapeData[] | null,
          }, recipes);
          if (!next || stableStringify(next) === stableStringify(existing.classifierProposals)) {
            c.skipped++;
            proposalPages.push({ pageNumber: page.pageNumber, pageIntelligence: existing });
            continue;
          }
          await withProjectWrite(capability, project.id, async (tx) => {
            await tx.update(pages)
              .set({ pageIntelligence: sql`COALESCE(${pages.pageIntelligence}, '{}'::jsonb) || ${JSON.stringify({ classifierProposals: next })}::jsonb` })
              .where(eq(pages.id, page.id));
          });
          c.updated++;
          c.proposals += next.proposals.length;
          proposalPages.push({ pageNumber: page.pageNumber, pageIntelligence: { ...existing, classifierProposals: next } });
        }
        const summary = await writeProjectProposals(capability, project.id, proposalPages);
        debug("project.classifiers", { project: project.name, proposals: summary.total, truncated: summary.truncated });
        send({ type: "progress", updated: c.updated, skipped: c.skipped, total: c.total, project: project.name, proposals: summary.total });
      });
    } catch (err) {
      // Per-project guard — see reprocess.ts page-names scope for why (S8 / TILE_015 C1).
      logger.error(`[reprocess-classifiers] Project ${project.name} failed:`, err);
      send({ type: "error", project: project.name, error: err instanceof Error ? err.message : "Failed" });
    }
  }
  send({ type: "done", updated: c.updated, skipped: c.skipped, total: c.total, proposals: c.proposals });
  return c;
}

type ClassifierPageInputParsed = ReadonlyArray<{ bbox?: readonly number[] | null }> | null | undefined;
