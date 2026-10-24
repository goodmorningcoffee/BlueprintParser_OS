// [cross-set F3 2026-10-24] Knowledge graph v2 — cross-set links (lib/knowledge-graph/cross-set.ts)
// for ONE company: the company-wide pass, its storage, the fail-soft per-project refresh and the
// access-filtered read.
//
// Compute: every non-demo project of the company with a storage prefix, one project at a time —
// its pages in keyset batches (rawText of ONE project in memory, never the company's), reduced to
// text key + content shingles by reduceCrossSetProject, raw text discarded. Hidden duplicates are
// dropped at the SQL edge (lib/page-dedup visibility). Demo projects stay out: they are a company's
// own published copies (projects.is_demo, same company_id), "demo never writes" forbids persisting
// to them, and an anonymous demo reader must never see a private set named beside it.
//
// Store, with NO migration and NO key in jsonb (same rule as the v1 graph, services/project-graph.ts):
//   • S3 `{dataUrl}/graph/cross-set.v1.json`          this project's links, other projects by publicId
//   • projects.projectIntelligence.crossSetLinks       compact summary: linked publicIds + counts
// Read: GET /api/projects/[id]/cross-set resolves names at read time and drops every link whose
// target the caller cannot open (another company, a demo, a deleted project) — the response never
// says such a project exists.
//
// Callers: the Reprocess "Cross-set links" stage (reprocess-cross-set.ts, company-wide, writes every
// selected project under its lease) and the upload end (lib/processing.ts → refreshProjectCrossSetLinks,
// this project only, fail-soft, skipped above HOOK_MAX_PROJECTS so a large company never pays a
// company-wide read per upload — the stage is the way then).

import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { pages, projects } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { downloadFromS3, uploadToS3 } from "@/lib/s3";
import { visiblePage } from "@/lib/page-dedup/visibility";
import {
  computeCrossSetLinks,
  CROSS_SET_INTELLIGENCE_KEY,
  crossSetObjectKey,
  crossSetSummary,
  isProjectCrossSetLinks,
  projectCrossSetLinks,
  reduceCrossSetProject,
  type CrossSetLinks,
  type CrossSetPageInput,
  type CrossSetProjectKeys,
  type CrossSetSummary,
  type ProjectCrossSetLink,
  type ProjectCrossSetLinks,
} from "@/lib/knowledge-graph";
import type { AuthSession, ProjectAccessRow } from "@/lib/api-utils";
import { type ProjectWriteCapability, withProjectWrite } from "@/server/api/project-write-capability";

/** Above this many eligible company projects the upload-end hook skips (the stage still runs). */
export const HOOK_MAX_PROJECTS = 40;
const PAGE_BATCH = 200;

export interface CrossSetProjectRow {
  id: number;
  publicId: string;
  name: string;
  dataUrl: string | null;
  createdAt: Date | null;
  companyId: number;
  isDemo: boolean;
}

export interface CrossSetDeps {
  loadProject(projectId: number): Promise<CrossSetProjectRow | undefined>;
  /** Every project row of ONE company (demo rows included; filtered here). */
  listCompanyProjects(companyId: number): Promise<CrossSetProjectRow[]>;
  /** All pages of one project, hidden duplicates already marked, loaded in bounded batches. */
  loadPages(projectId: number): Promise<CrossSetPageInput[]>;
  putObject(key: string, body: string): Promise<void>;
  /** null when the object does not exist. */
  getObject(key: string): Promise<string | null>;
  writeSummary(writeCapability: ProjectWriteCapability, projectId: number, summary: CrossSetSummary): Promise<void>;
  /** publicId → name for the given ids the session may open: own company only (root: any), never demo. */
  resolveVisibleProjects(publicIds: readonly string[], session: AuthSession | null): Promise<Map<string, string>>;
}

const isMissing = (err: unknown): boolean => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return e?.name === "NotFound" || e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
};

const projectColumns = {
  id: projects.id, publicId: projects.publicId, name: projects.name, dataUrl: projects.dataUrl,
  createdAt: projects.createdAt, companyId: projects.companyId, isDemo: projects.isDemo,
};

/** Merge ONE key, projectIntelligence.crossSetLinks, under the caller's capability. */
export async function writeCrossSetSummary(writeCapability: ProjectWriteCapability, projectId: number, summary: CrossSetSummary): Promise<void> {
  await withProjectWrite(writeCapability, projectId, async (tx) => {
    await tx.update(projects)
      .set({ projectIntelligence: sql`coalesce(${projects.projectIntelligence}, '{}'::jsonb) || jsonb_build_object(${CROSS_SET_INTELLIGENCE_KEY}::text, ${JSON.stringify(summary)}::jsonb)` })
      .where(eq(projects.id, projectId));
  });
}

const dbDeps: CrossSetDeps = {
  async loadProject(projectId) {
    const [row] = await db.select(projectColumns).from(projects).where(eq(projects.id, projectId)).limit(1);
    return row;
  },
  listCompanyProjects: (companyId) =>
    db.select(projectColumns).from(projects).where(eq(projects.companyId, companyId)).orderBy(asc(projects.createdAt), asc(projects.id)),
  async loadPages(projectId) {
    const out: CrossSetPageInput[] = [];
    let lastId = 0;
    for (;;) {
      const batch = await db
        .select({
          id: pages.id, pageNumber: pages.pageNumber, drawingNumber: pages.drawingNumber, title: pages.name, rawText: pages.rawText,
          hidden: sql<boolean>`NOT (${visiblePage(pages.pageIntelligence)})`,
        })
        .from(pages)
        .where(and(eq(pages.projectId, projectId), gt(pages.id, lastId)))
        .orderBy(asc(pages.id))
        .limit(PAGE_BATCH);
      for (const row of batch) out.push({ pageNumber: row.pageNumber, drawingNumber: row.drawingNumber, title: row.title, rawText: row.rawText, hidden: Boolean(row.hidden) });
      if (batch.length < PAGE_BATCH) break;
      lastId = batch[batch.length - 1].id;
    }
    return out;
  },
  putObject: (key, body) => uploadToS3(key, Buffer.from(body, "utf8"), "application/json", "private, no-store"),
  async getObject(key) {
    try {
      return (await downloadFromS3(key)).toString("utf8");
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  },
  writeSummary: writeCrossSetSummary,
  async resolveVisibleProjects(publicIds, session) {
    if (!session?.user || publicIds.length === 0) return new Map();
    const filters = [inArray(projects.publicId, [...new Set(publicIds)]), eq(projects.isDemo, false)];
    if (!session.user.isRootAdmin) filters.push(eq(projects.companyId, session.user.companyId));
    const rows = await db.select({ publicId: projects.publicId, name: projects.name }).from(projects).where(and(...filters));
    return new Map(rows.map((r) => [r.publicId, r.name]));
  },
};

/** The company's link-eligible projects: not demo, with a storage prefix. */
export async function listEligibleProjects(companyId: number, deps: CrossSetDeps = dbDeps): Promise<Array<CrossSetProjectRow & { dataUrl: string }>> {
  const rows = await deps.listCompanyProjects(companyId);
  return rows.filter((r): r is CrossSetProjectRow & { dataUrl: string } => !r.isDemo && !!r.dataUrl && r.companyId === companyId);
}

export interface CompanyCrossSet {
  projects: Array<CrossSetProjectRow & { dataUrl: string }>;
  result: CrossSetLinks;
}

/** One project at a time: load its pages, reduce, drop the text. `onProject` is a progress hook. */
export async function computeCompanyCrossSet(
  companyId: number,
  deps: CrossSetDeps = dbDeps,
  opts: { now?: Date; onProject?: (loaded: number, total: number, project: CrossSetProjectRow) => void } = {},
): Promise<CompanyCrossSet> {
  const eligible = await listEligibleProjects(companyId, deps);
  const keys: CrossSetProjectKeys[] = [];
  for (const project of eligible) {
    const rows = await deps.loadPages(project.id);
    keys.push(reduceCrossSetProject({ publicId: project.publicId, createdAt: project.createdAt, pages: rows }));
    opts.onProject?.(keys.length, eligible.length, project);
  }
  const result = computeCrossSetLinks(keys, { now: opts.now });
  const d = result.dropped;
  if (d.stockTexts || d.oversizedBuckets || d.truncatedBuckets) {
    logger.info(`[cross-set] company ${companyId}: dropped stock texts ${d.stockTexts}, oversized buckets ${d.oversizedBuckets}, truncated buckets ${d.truncatedBuckets} (${d.comparisons} comparisons)`);
  }
  return { projects: eligible, result };
}

/** This project's slice of the company result → S3 (derived key) + the jsonb summary. */
export async function persistProjectCrossSet(
  writeCapability: ProjectWriteCapability,
  project: { id: number; publicId: string; dataUrl: string },
  result: CrossSetLinks,
  deps: CrossSetDeps = dbDeps,
): Promise<CrossSetSummary> {
  const file = projectCrossSetLinks(result, project.publicId);
  const summary = crossSetSummary(file);
  await deps.putObject(crossSetObjectKey(project.dataUrl), JSON.stringify(file));
  await deps.writeSummary(writeCapability, project.id, summary);
  return summary;
}

export interface CrossSetRefreshResult {
  ok: boolean;
  summary?: CrossSetSummary;
  /** "no-data-url" | "company-too-large" | "demo" | an error message. */
  reason?: string;
}

/**
 * Upload-end hook: recompute the company's links and persist THIS project's slice only (the other
 * projects' files catch up at the next "Cross-set links" stage). Never throws.
 */
export async function refreshProjectCrossSetLinks(
  projectId: number,
  writeCapability: ProjectWriteCapability,
  deps: CrossSetDeps = dbDeps,
  now?: Date,
): Promise<CrossSetRefreshResult> {
  try {
    const project = await deps.loadProject(projectId);
    if (!project) return { ok: false, reason: "no-project" };
    if (project.isDemo) return { ok: false, reason: "demo" };
    if (!project.dataUrl) return { ok: false, reason: "no-data-url" };
    const eligible = await listEligibleProjects(project.companyId, deps);
    if (eligible.length > HOOK_MAX_PROJECTS) {
      logger.info(`[cross-set] project ${projectId}: company has ${eligible.length} projects (> ${HOOK_MAX_PROJECTS}); run the Cross-set links stage`);
      return { ok: false, reason: "company-too-large" };
    }
    const { result } = await computeCompanyCrossSet(project.companyId, deps, { now });
    const summary = await persistProjectCrossSet(writeCapability, { ...project, dataUrl: project.dataUrl }, result, deps);
    logger.info(`[cross-set] project ${projectId}: ${summary.linkedProjects.length} linked projects (company ${result.projects} projects, ${result.links.length} page links)`);
    return { ok: true, summary };
  } catch (err) {
    logger.error(`[cross-set] project ${projectId} refresh failed:`, err);
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export async function readProjectCrossSetLinks(dataUrl: string, deps: CrossSetDeps = dbDeps): Promise<ProjectCrossSetLinks | null> {
  const body = await deps.getObject(crossSetObjectKey(dataUrl));
  if (!body) return null;
  const parsed: unknown = JSON.parse(body);
  return isProjectCrossSetLinks(parsed) ? parsed : null;
}

export interface CrossSetQuery {
  page?: number;
}

/** A link as served: the target project named, because the caller may open it. */
export interface VisibleCrossSetLink extends Omit<ProjectCrossSetLink, "project"> {
  project: { publicId: string; name: string };
}

const nameLinks = (list: ProjectCrossSetLink[], visible: Map<string, string>): VisibleCrossSetLink[] =>
  list.flatMap((l) => {
    const name = visible.get(l.project);
    return name === undefined ? [] : [{ ...l, project: { publicId: l.project, name } }];
  });

/**
 * GET /api/projects/[id]/cross-set — read-only (auth:{project}).
 *   default        every page's links + the project-level copy_of rows, names resolved once
 *   ?page=N        one page's links
 * Links to projects the caller cannot open are dropped, so the response never discloses a project
 * outside the caller's company (or a demo copy). `built:false` when no pass has run for this project.
 */
export async function getProjectCrossSetLinks(project: ProjectAccessRow, query: CrossSetQuery, session: AuthSession | null, deps: CrossSetDeps = dbDeps): Promise<unknown> {
  if (project.isDemo || !project.dataUrl) return { built: false };
  const file = await readProjectCrossSetLinks(project.dataUrl, deps);
  if (!file) return { built: false };
  const pageLists: Array<[number, ProjectCrossSetLink[]]> = typeof query.page === "number"
    ? [[query.page, file.pages[query.page] ?? []]]
    : Object.entries(file.pages).map(([k, v]) => [Number(k), v]);
  const ids = new Set<string>();
  for (const [, list] of pageLists) for (const l of list) ids.add(l.project);
  for (const p of file.projects) ids.add(p.publicId);
  const visible = await deps.resolveVisibleProjects([...ids], session);
  const projectRows = file.projects.flatMap((p) => {
    const name = visible.get(p.publicId);
    return name === undefined ? [] : [{ ...p, name }];
  });
  if (typeof query.page === "number") {
    return { built: true, computedAt: file.computedAt, page: query.page, links: nameLinks(pageLists[0][1], visible), projects: projectRows };
  }
  const out: Record<number, VisibleCrossSetLink[]> = {};
  for (const [page, list] of pageLists) {
    const named = nameLinks(list, visible);
    if (named.length) out[page] = named;
  }
  return { built: true, computedAt: file.computedAt, pages: out, projects: projectRows };
}

/**
 * Compact view for the LLM `getCrossReferences` tool: this page's cross-set links by target
 * publicId (no names — the tool context carries no session to filter by). null without a pass.
 */
export async function crossSetLinksForLlm(projectId: number, pageNumber: number, deps: CrossSetDeps = dbDeps): Promise<Record<string, unknown> | null> {
  const project = await deps.loadProject(projectId);
  if (!project?.dataUrl || project.isDemo) return null;
  const file = await readProjectCrossSetLinks(project.dataUrl, deps);
  if (!file) return null;
  const links = (file.pages[pageNumber] ?? []).slice(0, 50).map((l) => ({ kind: l.kind, project: l.project, page: l.page, sheet: l.sheet, confidence: l.confidence, direction: l.direction }));
  return { computedAt: file.computedAt, links };
}
