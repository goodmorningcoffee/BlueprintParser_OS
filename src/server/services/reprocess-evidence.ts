// [evidence T4 2026-10-24] POST /api/admin/reprocess?scope=evidence — rebuild ONLY
// `pageIntelligence.evidence` (src/lib/evidence) from each page's stored OCR and its YOLO rows.
// No SageMaker, no Textract, no classifier: the fast backfill for pages processed before the
// evidence layer existed, and the refresh after YOLO rows are purged / deduped.
//
// Lives here, not in reprocess.ts (its per-project loop count is pinned at exactly 5 by
// reprocess-per-project-guard.test.ts); this loop carries the same per-project guard itself.
// Writes merge the ONE key in SQL (`pageIntelligence || {evidence}`), so a user edit to another
// key between read and write (parsedRegions, rejectedTextRegionIds) can never be overwritten.
// Pages loaded one at a time — a project's textractData is never held in memory all at once.

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { annotations, pages } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import {
  buildEvidenceSummary,
  sameEvidence,
  storedPageEvidence,
  type EvidenceDetectionInput,
  type EvidenceSummary,
} from "@/lib/evidence";
import type { TextractPageData } from "@/types";
import { type ProjectWriteCapability, withProjectWrite } from "@/server/api/project-write-capability";
import type { ReprocessStream } from "./reprocess-stream";

export interface EvidenceScopeProject {
  id: number;
  name: string;
}

export interface EvidenceScopeDeps {
  listPages(projectId: number): Promise<Array<{ id: number; pageNumber: number }>>;
  loadPage(pageId: number): Promise<{ textractData: TextractPageData | null; pageIntelligence: unknown } | undefined>;
  loadDetections(projectId: number): Promise<Map<number, EvidenceDetectionInput[]>>;
  writeEvidence(writeCapability: ProjectWriteCapability, projectId: number, pageId: number, summary: EvidenceSummary): Promise<void>;
}

export interface EvidenceScopeCounts {
  updated: number;
  /** noOcr + unchanged + errors — the console's "skipped". */
  skipped: number;
  noOcr: number;
  unchanged: number;
  /** Not `failed`: the console reads a `failed` key on "done" as shape-parse's scan failures. */
  errors: number;
  total: number;
}

const dbDeps: EvidenceScopeDeps = {
  listPages: (projectId) =>
    db.select({ id: pages.id, pageNumber: pages.pageNumber }).from(pages)
      .where(eq(pages.projectId, projectId)).orderBy(pages.pageNumber),
  async loadPage(pageId) {
    const [row] = await db.select({ textractData: pages.textractData, pageIntelligence: pages.pageIntelligence })
      .from(pages).where(eq(pages.id, pageId)).limit(1);
    return row ? { textractData: row.textractData ?? null, pageIntelligence: row.pageIntelligence } : undefined;
  },
  async loadDetections(projectId) {
    const rows = await db
      .select({
        name: annotations.name, minX: annotations.minX, minY: annotations.minY, maxX: annotations.maxX,
        maxY: annotations.maxY, pageNumber: annotations.pageNumber, data: annotations.data,
      })
      .from(annotations)
      .where(and(eq(annotations.projectId, projectId), eq(annotations.source, "yolo")));
    const byPage = new Map<number, EvidenceDetectionInput[]>();
    for (const a of rows) {
      const data = a.data as { confidence?: number; modelName?: string } | null;
      const list = byPage.get(a.pageNumber) ?? [];
      list.push({ name: a.name, minX: a.minX, minY: a.minY, maxX: a.maxX, maxY: a.maxY, confidence: data?.confidence ?? 0, modelName: data?.modelName });
      byPage.set(a.pageNumber, list);
    }
    return byPage;
  },
  async writeEvidence(writeCapability, projectId, pageId, summary) {
    await withProjectWrite(writeCapability, projectId, async (tx) => {
      await tx.update(pages)
        .set({ pageIntelligence: sql`coalesce(${pages.pageIntelligence}, '{}'::jsonb) || jsonb_build_object('evidence', ${JSON.stringify(summary)}::jsonb)` })
        .where(eq(pages.id, pageId));
    });
  },
};

export async function reprocessEvidenceScope(opts: {
  projects: readonly EvidenceScopeProject[];
  withLease: <T>(projectId: number, op: (writeCapability: ProjectWriteCapability) => Promise<T>) => Promise<T>;
  stream: Pick<ReprocessStream, "send" | "debug">;
  deps?: Partial<EvidenceScopeDeps>;
  now?: () => Date;
}): Promise<EvidenceScopeCounts> {
  const deps: EvidenceScopeDeps = { ...dbDeps, ...opts.deps };
  const { send, debug } = opts.stream;
  const c = { updated: 0, noOcr: 0, unchanged: 0, errors: 0, total: 0 };
  const counts = (): EvidenceScopeCounts => ({ ...c, skipped: c.noOcr + c.unchanged + c.errors });

  for (const project of opts.projects) {
    try {
      await opts.withLease(project.id, async (writeCapability) => {
        const projectPages = await deps.listPages(project.id);
        const detsByPage = await deps.loadDetections(project.id);
        send({ type: "project", name: project.name, pages: projectPages.length, yoloPages: detsByPage.size });
        for (const p of projectPages) {
          c.total++;
          try {
            const page = await deps.loadPage(p.id);
            if (!page?.textractData) { c.noOcr++; continue; }
            const summary = buildEvidenceSummary(
              { textract: page.textractData, detections: detsByPage.get(p.pageNumber) ?? [] },
              opts.now?.(),
            );
            if (!summary) { c.noOcr++; continue; }
            if (sameEvidence(summary, storedPageEvidence(page.pageIntelligence))) { c.unchanged++; continue; }
            await deps.writeEvidence(writeCapability, project.id, p.id, summary);
            c.updated++;
            debug("page.evidence", { project: project.name, page: p.pageNumber, holes: summary.counts.holes, tables: summary.counts.tables });
          } catch (err) {
            c.errors++;
            logger.error(`[reprocess-evidence] Page ${p.pageNumber} of ${project.name} failed:`, err);
            send({ type: "warning", project: project.name, message: `Page ${p.pageNumber}: evidence not saved (${err instanceof Error ? err.message : "failed"})` });
          }
          if (c.total % 5 === 0) send({ type: "progress", updated: c.updated, total: c.total, project: project.name });
        }
        send({ type: "progress", updated: c.updated, total: c.total, project: project.name });
      });
    } catch (err) {
      // Per-project guard — same contract as reprocess.ts's five scopes (S8 / TILE_015 C1).
      logger.error(`[reprocess-evidence] Project ${project.name} failed:`, err);
      send({ type: "error", project: project.name, error: err instanceof Error ? err.message : "Failed" });
    }
  }
  return counts();
}
