// [classifier engine 2a 2026-10-24] Admin › Reprocess "Classifiers" (POST /api/admin/reprocess
// ?scope=classifiers, also POST /api/admin/classifiers/run): the classifier ENGINE only — no YOLO,
// no OCR. For every page with stored YOLO rows it rebuilds `pageIntelligence.classifierProposals`
// from what is already there (regionsV2, pageZones, channels, parsedRegions, textract words / tables
// read ONE page at a time, csiCodes, drawingNumber) with the company's effective recipes, writes only
// pages whose record changed (jsonb merge — user-owned `proposalVerdicts` and every other key
// untouched), drops the record of a page whose YOLO rows are gone, then refreshes
// `projectIntelligence.proposals`. A sibling of reprocess.ts (zero line headroom there, and its
// per-project loop count is pinned); this loop carries its own per-project guard.
//
// [clf visibility 2026-10-25] A page with YOLO rows but NO stored `regionsV2` (its Intelligence has
// not been re-run since regions v2 shipped) used to yield zero candidates, so the owner's run wrote
// zero proposals with no explanation. Now the regions are computed here with the same call the
// Intelligence reprocess uses and persisted beside `classifierProposals` in the same write; each
// project ends with one `classifiers` line (pages / with YOLO / regions computed now / proposals)
// and a `warning` when it has no YOLO detections at all.

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { annotations, pages } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { classifyRegionsV2, storedRegionsV2, type RegionClassifierInput, type RegionsV2 } from "@/lib/region-classifier-v2";
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
  /** Pages whose classifierProposals record was (re)written, or dropped because their YOLO rows are gone. */
  updated: number;
  /** Pages with YOLO rows whose record was unchanged, or without YOLO rows and without a record. */
  skipped: number;
  total: number;
  /** Proposals the engine produced on every page with YOLO rows this run (written or unchanged). */
  proposals: number;
}

/** The stored `regionsV2`, or — when the page has detections and none is stored — a fresh one (`computed`), undefined if that throws. */
export function regionsV2OrCompute(pageIntelligence: unknown, input: RegionClassifierInput): { regionsV2: RegionsV2 | undefined; computed: boolean } {
  const stored = storedRegionsV2(pageIntelligence);
  if (stored || !input.detections.length) return { regionsV2: stored, computed: false };
  try { return { regionsV2: classifyRegionsV2(input), computed: true }; }
  catch (err) {
    logger.error(`[reprocess-classifiers] classifyRegionsV2 failed for page ${input.pageNumber}:`, err);
    return { regionsV2: undefined, computed: false };
  }
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
            // textractData is NOT selected here (the yolo.ts "regions v2 T5" lesson: every page's words in one
            // select can need > 1 GB on a dense set) — each YOLO page reads its own words + tables below.
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
        const per = { yoloPages: 0, regionsComputed: 0 };
        for (const page of rows) {
          c.total++;
          const existing = (page.pageIntelligence ?? {}) as Record<string, unknown>;
          const detections = byPage.get(page.pageNumber);
          if (!detections?.length) {
            // No YOLO rows → no candidates. A page that never had a record is skipped; a stale record (its
            // YOLO rows were deleted since) is dropped, as the intelligence reprocess drops every computed key.
            if (existing.classifierProposals === undefined) { c.skipped++; proposalPages.push({ pageNumber: page.pageNumber, pageIntelligence: existing }); continue; }
            await withProjectWrite(capability, project.id, async (tx) => {
              await tx.update(pages)
                .set({ pageIntelligence: sql`COALESCE(${pages.pageIntelligence}, '{}'::jsonb) - 'classifierProposals'` })
                .where(eq(pages.id, page.id));
            });
            c.updated++;
            const rest = { ...existing };
            delete rest.classifierProposals;
            proposalPages.push({ pageNumber: page.pageNumber, pageIntelligence: rest });
            continue;
          }
          per.yoloPages++;
          // ONE page's OCR at a time, and only the two keys the engine reads (never `lines`).
          const [ocr] = await db
            .select({
              words: sql<TextractPageData["words"] | null>`${pages.textractData}->'words'`,
              tables: sql<TextractPageData["tables"] | null>`${pages.textractData}->'tables'`,
            })
            .from(pages)
            .where(eq(pages.id, page.id));
          const zones = existing.pageZones as PageZones | undefined;
          const textractData = Array.isArray(ocr?.words) ? { words: ocr.words, ...(ocr.tables ? { tables: ocr.tables } : {}) } : null;
          const csiCodes = (page.csiCodes ?? []) as CsiCode[];
          const regions = regionsV2OrCompute(existing, { pageNumber: page.pageNumber, detections, zones, textractData, csiCodes });
          if (regions.computed) per.regionsComputed++;
          const next = computeClassifierProposals({
            pageNumber: page.pageNumber, detections, zones, textractData, csiCodes,
            regionsV2: regions.regionsV2,
            parsedRegions: existing.parsedRegions as ClassifierPageInputParsed,
            drawingNumber: page.drawingNumber,
            channelKind: storedChannelKind(existing),
            keynotes: (page.keynotes ?? null) as readonly KeynoteShapeData[] | null,
          }, recipes);
          if (next) c.proposals += next.proposals.length;
          // The patch: freshly computed regions always land; the proposals record only when it changed.
          const patch: Record<string, unknown> = {};
          if (regions.computed) patch.regionsV2 = regions.regionsV2;
          if (next && stableStringify(next) !== stableStringify(existing.classifierProposals)) patch.classifierProposals = next;
          if (!Object.keys(patch).length) {
            c.skipped++;
            proposalPages.push({ pageNumber: page.pageNumber, pageIntelligence: existing });
            continue;
          }
          await withProjectWrite(capability, project.id, async (tx) => {
            await tx.update(pages)
              .set({ pageIntelligence: sql`COALESCE(${pages.pageIntelligence}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb` })
              .where(eq(pages.id, page.id));
          });
          c.updated++;
          proposalPages.push({ pageNumber: page.pageNumber, pageIntelligence: { ...existing, ...patch } });
        }
        const summary = await writeProjectProposals(capability, project.id, proposalPages);
        debug("project.classifiers", { project: project.name, proposals: summary.total, truncated: summary.truncated });
        if (per.yoloPages === 0 && rows.length > 0) send({ type: "warning", project: project.name, message: "no YOLO detections — run YOLO load first" });
        send({ type: "classifiers", project: project.name, pages: rows.length, yoloPages: per.yoloPages, regionsComputed: per.regionsComputed, proposals: summary.total, truncated: summary.truncated });
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
