// Admin › Data tools › Duplicates — scan (read-only) + the shared loaders the apply uses.
// PLAN §2 (admin_data_tools, rev 2). The detector is pure (src/lib/page-dedup); this file
// reads stored text only — no PDF, image or provider call.
//
// Scope: a company admin sees their own company; another companyId → 403 (refuse, never
// override). Root: one company via ?companyId, or every company. An unknown or foreign project
// id fails the WHOLE request with 404 (fail closed).

import { and, asc, eq, gt, inArray, type SQL } from "drizzle-orm";
import type { AuthSession } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { pages, projects } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import {
  crossProjectReport,
  detectDuplicates,
  getDuplicateOf,
  lineDiff,
  pageTextKey,
  type DuplicateReport,
} from "@/lib/page-dedup";
import { reportDigest } from "@/lib/page-dedup/digest";
import { ApiError } from "@/server/api/envelope";
import { projectAssetUrl } from "@/server/services/project-assets";

/** A page carrying any of these is "your work" and is never hidden (owner decision 5). */
export const HUMAN_ANNOTATION_SOURCES = ["user", "takeoff", "takeoff-scale"] as const;

const PAGE_BATCH = 200;
const MAX_SCAN_PROJECTS = 2000;
const MAX_DIFFS_PER_PROJECT = 50;
/** The pair pass is O(n²) on the one web task; larger projects are reported, not scanned (v1). */
export const MAX_SCAN_PAGES = 3000;

export interface DuplicateScopeProject {
  id: number;
  publicId: string;
  name: string;
  companyId: number;
  isDemo: boolean;
  status: string;
  lifecycleEpoch: number;
  numPages: number | null;
}

export interface StoredDedupPage {
  pageNumber: number;
  drawingNumber: string | null;
  rawText: string | null;
  pageIntelligence: unknown;
}

/** null = every company (root only). */
export function resolveCompanyScope(session: AuthSession, companyId: string | undefined): number | null {
  const requested = companyId === undefined || companyId === "" ? null : Number(companyId);
  if (requested !== null && (!Number.isInteger(requested) || requested <= 0)) {
    throw new ApiError("VALIDATION", "companyId must be a positive integer");
  }
  if (session.user.isRootAdmin) return requested;
  if (requested !== null && requested !== session.user.companyId) {
    throw new ApiError("FORBIDDEN", "Company admins can only use their own company");
  }
  return session.user.companyId;
}

const scopeColumns = {
  id: projects.id,
  publicId: projects.publicId,
  name: projects.name,
  companyId: projects.companyId,
  isDemo: projects.isDemo,
  status: projects.status,
  lifecycleEpoch: projects.lifecycleEpoch,
  numPages: projects.numPages,
};

/** Projects in scope; with `publicIds`, every id must resolve inside the scope or the request 404s. */
export async function loadScopeProjects(
  companyId: number | null,
  publicIds: readonly string[] | null,
): Promise<DuplicateScopeProject[]> {
  const filters: SQL[] = [];
  if (companyId !== null) filters.push(eq(projects.companyId, companyId));
  if (publicIds) {
    if (publicIds.length === 0) return [];
    filters.push(inArray(projects.publicId, [...new Set(publicIds)]));
  }
  const rows = await db
    .select(scopeColumns)
    .from(projects)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(asc(projects.id))
    .limit(MAX_SCAN_PROJECTS);
  if (publicIds && rows.length !== new Set(publicIds).size) {
    throw new ApiError("NOT_FOUND", "Project not found");
  }
  return rows;
}

type PageReader = Pick<typeof db, "select">;

/**
 * Stored pages of one project, keyset batches by pages.id. The scan passes `db` (short
 * standalone queries); the apply passes its transaction so the re-scan reads under the lock.
 */
export async function loadDedupPages(projectId: number, reader: PageReader = db): Promise<StoredDedupPage[]> {
  const out: StoredDedupPage[] = [];
  let lastId = 0;
  for (;;) {
    const batch = await reader
      .select({
        id: pages.id,
        pageNumber: pages.pageNumber,
        drawingNumber: pages.drawingNumber,
        rawText: pages.rawText,
        pageIntelligence: pages.pageIntelligence,
      })
      .from(pages)
      .where(and(eq(pages.projectId, projectId), gt(pages.id, lastId)))
      .orderBy(asc(pages.id))
      .limit(PAGE_BATCH);
    for (const row of batch) {
      out.push({
        pageNumber: row.pageNumber,
        drawingNumber: row.drawingNumber,
        rawText: row.rawText,
        pageIntelligence: row.pageIntelligence,
      });
    }
    if (batch.length < PAGE_BATCH) break;
    lastId = batch[batch.length - 1].id;
  }
  return out.sort((a, b) => a.pageNumber - b.pageNumber);
}

/** Why a project is not scanned / not writable, or null when it is. */
export function projectSkipReason(project: Pick<DuplicateScopeProject, "isDemo" | "status">): string | null {
  if (project.isDemo) return "demo project (read-only)";
  if (project.status !== "completed") return `not completed (${project.status})`;
  return null;
}

export function scanProjectPages(stored: readonly StoredDedupPage[]): { report: DuplicateReport; digest: string } {
  const report = detectDuplicates(stored);
  return { report, digest: reportDigest(report) };
}

/** The report line for one project: blocks, pairs, current marks, thumbnails, near diffs. */
function projectLine(project: DuplicateScopeProject, stored: readonly StoredDedupPage[], scannedAt: string) {
  const { report, digest } = scanProjectPages(stored);
  const byPage = new Map(stored.map((p) => [p.pageNumber, p]));
  let diffs = 0;
  const pairs = report.pairs.map((pair) => {
    if (pair.tier !== "near" || pair.identical || diffs >= MAX_DIFFS_PER_PROJECT) return pair;
    diffs++;
    return { ...pair, diff: lineDiff(byPage.get(pair.canonical)?.rawText ?? null, byPage.get(pair.page)?.rawText ?? null) };
  });
  const hidden: { page: number; canonical: number; tier: string; hiddenAt: string }[] = [];
  for (const p of stored) {
    const mark = getDuplicateOf(p.pageIntelligence);
    if (mark?.hiddenAt) hidden.push({ page: p.pageNumber, canonical: mark.pageNumber, tier: mark.tier, hiddenAt: mark.hiddenAt });
  }
  return {
    t: "project",
    project: { publicId: project.publicId, name: project.name, companyId: project.companyId, numPages: project.numPages },
    scannedAt,
    reportDigest: digest,
    counts: report.counts,
    blocks: report.blocks,
    bulkHold: report.bulkHold,
    pairs,
    hidden,
    thumbnailBase: projectAssetUrl(project.publicId, "thumbnails"),
  };
}

async function* scanLines(projectsInScope: DuplicateScopeProject[], signal: AbortSignal) {
  const started = Date.now();
  const scannedAt = new Date().toISOString();
  yield { t: "start", projects: projectsInScope.length, scannedAt };
  const keysByCompany = new Map<number, { project: string; keys: string[] }[]>();
  let scanned = 0;
  for (const project of projectsInScope) {
    if (signal.aborted) return;
    const skip = projectSkipReason(project);
    if (skip) {
      yield { t: "skipped", project: { publicId: project.publicId, name: project.name }, reason: skip };
      continue;
    }
    try {
      const stored = await loadDedupPages(project.id);
      if (stored.length > MAX_SCAN_PAGES) {
        yield { t: "skipped", project: { publicId: project.publicId, name: project.name }, reason: `over ${MAX_SCAN_PAGES} pages` };
        continue;
      }
      yield projectLine(project, stored, scannedAt);
      scanned++;
      const keys: string[] = [];
      for (const p of stored) {
        const k = pageTextKey(p.rawText);
        if (k) keys.push(k);
      }
      const list = keysByCompany.get(project.companyId) ?? [];
      list.push({ project: project.publicId, keys });
      keysByCompany.set(project.companyId, list);
    } catch (err) {
      logger.error("[duplicates] scan failed", { projectPublicId: project.publicId, err: String(err) });
      yield { t: "error", project: { publicId: project.publicId, name: project.name }, message: "Scan failed for this project" };
    }
  }
  for (const [companyId, list] of keysByCompany) {
    if (list.length < 2) continue;
    yield { t: "crossProject", companyId, pairs: crossProjectReport(list) };
  }
  yield { t: "done", scanned, durationMs: Date.now() - started };
}

/**
 * POST /api/admin/duplicates/scan — read-only NDJSON stream. One line per project (report +
 * `reportDigest` the apply must echo), then one `crossProject` line per company.
 */
export async function scanDuplicates(
  req: Request,
  session: AuthSession,
  body: { projectPublicIds?: string[]; all?: boolean },
  query: { companyId?: string },
): Promise<Response> {
  const companyId = resolveCompanyScope(session, query.companyId);
  if (!body.all && !body.projectPublicIds?.length) {
    throw new ApiError("VALIDATION", "Pass projectPublicIds or all:true");
  }
  const inScope = await loadScopeProjects(companyId, body.all ? null : (body.projectPublicIds ?? []));
  const lines = scanLines(inScope, req.signal);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await lines.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(JSON.stringify(next.value) + "\n"));
      } catch (err) {
        logger.error("[duplicates] scan stream failed", { err: String(err) });
        controller.enqueue(encoder.encode(JSON.stringify({ t: "error", message: "Scan failed" }) + "\n"));
        controller.close();
      }
    },
    async cancel() {
      await lines.return(undefined);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "private, no-store",
    },
  });
}
