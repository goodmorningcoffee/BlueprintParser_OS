// Admin › Data tools › Duplicates — apply (hide) + restore, and the viewer's page flags.
// PLAN §2.2–2.3 (admin_data_tools, rev 2).
//
// Remove means HIDE: pages.page_intelligence.duplicateOf = {…, hiddenAt}. Page numbers never
// change; restore deletes the mark. Hiding saves no storage, YOLO cost or page charges.
//
// Safety (each is tested):
//   • digest contract — the apply re-scans and refuses (409) unless the report matches the one
//     the admin reviewed; all-projects mode needs a digest per project and touches only those;
//   • bulk = exact only (run after calibration, RUN_BULK_ENABLED); near only as named blocks
//     on a single project; a project with any revision evidence (report.bulkHold) takes no
//     bulk at all — its blocks, exact ones included, go one at a time;
//   • skipped: demo / not-completed projects, pages carrying human work, already-hidden pages,
//     any hide that would leave no visible copy;
//   • concurrency (critic #9): inside withProjectWrite, AFTER the project row is locked FOR
//     UPDATE, any active mutation lease → busy. Sound because lease acquisition runs under
//     the same row lock, so a later lease waits for this commit and then reads the mark.

import { and, eq, inArray, sql } from "drizzle-orm";
import type { AuthSession, ProjectAccessRow } from "@/lib/api-utils";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { annotations, pages, projectMutationLeases, projects, qtoWorkflows } from "@/lib/db/schema";
import {
  blockHides,
  bulkPairs,
  bulkTiers,
  defaultKeep,
  getDuplicateOf,
  type DuplicateKeep,
  type DuplicateMark,
  type DuplicateReport,
  type DuplicateTier,
} from "@/lib/page-dedup";
import { ApiError } from "@/server/api/envelope";
import {
  assertProjectWritable,
  withProjectWrite,
  type ProjectWriteCapability,
  type ProjectWriteTransaction,
} from "@/server/api/project-write-capability";
import {
  HUMAN_ANNOTATION_SOURCES,
  loadDedupPages,
  loadScopeProjects,
  projectSkipReason,
  resolveCompanyScope,
  scanProjectPages,
  type DuplicateScopeProject,
} from "@/server/services/page-duplicates";
import { recomputeProject } from "./project-recompute";

const MAX_ALL_PROJECTS = 500;

export interface ApplyDuplicatesBody {
  projectPublicId?: string;
  reportDigest?: string;
  tiers?: DuplicateTier[];
  blocks?: string[];
  keep?: DuplicateKeep;
  all?: boolean;
  digests?: Record<string, string>;
}

export interface PlannedHide {
  page: number;
  canonical: number;
  tier: DuplicateTier;
  content: number;
  full: number;
}

export interface ProjectApplyResult {
  projectPublicId: string;
  hidden: { page: number; canonical: number; tier: DuplicateTier }[];
  skipped: { page: number; reason: string }[];
}

function validateTiers(tiers: readonly DuplicateTier[] | undefined): DuplicateTier[] {
  const allowed = bulkTiers();
  for (const tier of tiers ?? []) {
    if (!allowed.includes(tier)) {
      throw new ApiError(
        "VALIDATION",
        tier === "run"
          ? "Repeat-set bulk removal is off until prod calibration; remove those blocks one at a time"
          : `Tier "${tier}" cannot be removed in bulk; remove its blocks one at a time`,
      );
    }
  }
  return [...new Set(tiers ?? [])];
}

/** What a request would hide, from a fresh report. Unknown block ids → 400. */
export function planHides(
  report: DuplicateReport,
  tiers: readonly DuplicateTier[],
  blockIds: readonly string[],
  keep: DuplicateKeep | undefined,
): PlannedHide[] {
  const byPage = new Map(report.pairs.map((p) => [p.page, p]));
  const plan = new Map<number, PlannedHide>();
  // A bulk tier whose blocks keep the latest copy by default (run, once RUN_BULK_ENABLED)
  // resolves block by block, so bulk never hides the copy a revision may live in.
  const tierBlocks = new Map<string, DuplicateKeep | undefined>();
  if (tiers.length && report.bulkHold) {
    throw new ApiError("CONFLICT", `Bulk removal is off for this project: it ${report.bulkHold}. Remove its blocks one at a time`);
  }
  for (const pair of bulkPairs(report, tiers)) {
    if (plan.has(pair.page)) continue;
    if (pair.blockId && defaultKeep(pair.tier) === "latest") tierBlocks.set(pair.blockId, undefined);
    else plan.set(pair.page, { page: pair.page, canonical: pair.canonical, tier: pair.tier, content: pair.content, full: pair.full });
  }
  for (const id of blockIds) tierBlocks.set(id, keep);
  for (const [id, chosen] of tierBlocks) {
    const block = report.blocks.find((b) => b.id === id);
    if (!block) throw new ApiError("VALIDATION", `Unknown block ${id}`);
    const choice = chosen ?? defaultKeep(block.tier);
    for (const hide of blockHides(block, choice)) {
      const later = choice === "latest" ? hide.canonical : hide.page;
      const pair = byPage.get(later);
      if (!pair || plan.has(hide.page)) continue;
      const canonical = choice === "earliest" ? pair.canonical : hide.canonical;
      plan.set(hide.page, { page: hide.page, canonical, tier: block.tier, content: pair.content, full: pair.full });
    }
  }
  return [...plan.values()].sort((a, b) => a.page - b.page);
}

/** Any active mutation lease on the project → 409. Call after the project row is locked. */
export async function assertNotBusy(tx: ProjectWriteTransaction, projectId: number): Promise<void> {
  const [lease] = await tx
    .select({ kind: projectMutationLeases.kind })
    .from(projectMutationLeases)
    .where(and(eq(projectMutationLeases.projectId, projectId), eq(projectMutationLeases.status, "active")))
    .limit(1);
  if (lease) throw new ApiError("CONFLICT", "Project is busy (a job is running); retry when it finishes");
}

/** A transaction or `db`: the permanent-delete dry run plans outside any transaction. */
export type WorkReader = Pick<ProjectWriteTransaction, "select" | "selectDistinct">;

/**
 * Pages carrying human work: annotations of the given sources (default: user/takeoff), QTO
 * references (schedule page, line-item pages and instances), parsed regions.
 */
export async function humanWorkPages(
  tx: WorkReader,
  projectId: number,
  sources: readonly string[] = HUMAN_ANNOTATION_SOURCES,
): Promise<Set<number>> {
  const work = new Set<number>();
  const annotated = await tx
    .selectDistinct({ pageNumber: annotations.pageNumber })
    .from(annotations)
    .where(and(eq(annotations.projectId, projectId), inArray(annotations.source, [...sources])));
  for (const row of annotated) work.add(row.pageNumber);
  const workflows = await tx
    .select({ schedulePageNumber: qtoWorkflows.schedulePageNumber, lineItems: qtoWorkflows.lineItems })
    .from(qtoWorkflows)
    .where(eq(qtoWorkflows.projectId, projectId));
  for (const wf of workflows) {
    if (wf.schedulePageNumber) work.add(wf.schedulePageNumber);
    for (const item of Array.isArray(wf.lineItems) ? wf.lineItems : []) {
      for (const pageNumber of Array.isArray(item?.pages) ? item.pages : []) work.add(pageNumber);
      for (const inst of Array.isArray(item?.instances) ? item.instances : []) work.add(inst.pageNumber);
    }
  }
  const regions = await tx
    .select({ pageNumber: pages.pageNumber })
    .from(pages)
    .where(and(
      eq(pages.projectId, projectId),
      sql`jsonb_typeof(${pages.pageIntelligence}->'parsedRegions') = 'array'`,
      sql`jsonb_array_length(${pages.pageIntelligence}->'parsedRegions') > 0`,
    ));
  for (const row of regions) work.add(row.pageNumber);
  return work;
}

/**
 * Hide the planned pages of one project in ONE transaction. The re-scan runs inside it, so
 * the digest is compared against the text as it is under the lock.
 */
async function applyToProject(
  project: DuplicateScopeProject,
  expectedDigest: string,
  request: { tiers: DuplicateTier[]; blocks: string[]; keep?: DuplicateKeep },
  session: AuthSession,
): Promise<ProjectApplyResult> {
  return applyPlannedHides(project, expectedDigest, (report) => planHides(report, request.tiers, request.blocks, request.keep), session);
}

/**
 * The one hide path: `planner` maps the fresh (locked) report to the pages to hide. Every
 * safety rule below (digest, busy, human work, already hidden, last copy) applies to every
 * planner — apply (tiers / blocks) and apply-selection (page-duplicates-select.ts).
 */
export async function applyPlannedHides(
  project: DuplicateScopeProject,
  expectedDigest: string,
  planner: (report: DuplicateReport) => PlannedHide[],
  session: AuthSession,
): Promise<ProjectApplyResult> {
  const skip = projectSkipReason(project);
  if (skip) throw new ApiError(project.isDemo ? "FORBIDDEN" : "CONFLICT", `Project skipped: ${skip}`);
  const capability = assertProjectWritable(project);
  const result = await withProjectWrite(capability, project.id, async (tx) => {
    const [current] = await tx
      .select({ status: projects.status, isDemo: projects.isDemo })
      .from(projects)
      .where(and(eq(projects.id, project.id), eq(projects.isDemo, false)))
      .limit(1);
    if (!current || current.status !== "completed") throw new ApiError("CONFLICT", "Project skipped: not completed");
    await assertNotBusy(tx, project.id);

    const stored = await loadDedupPages(project.id, tx);
    const { report, digest } = scanProjectPages(stored);
    if (digest !== expectedDigest) throw new ApiError("CONFLICT", "Duplicates changed since the scan; scan again");
    const plan = planner(report);
    const work = await humanWorkPages(tx, project.id);

    const hiddenTo = new Map<number, number>();
    for (const p of stored) {
      const mark = getDuplicateOf(p.pageIntelligence);
      if (mark?.hiddenAt) hiddenTo.set(p.pageNumber, mark.pageNumber);
    }
    const now = new Date().toISOString();
    const result: ProjectApplyResult = { projectPublicId: project.publicId, hidden: [], skipped: [] };
    for (const h of plan) {
      if (hiddenTo.has(h.page)) { result.skipped.push({ page: h.page, reason: "already hidden" }); continue; }
      if (work.has(h.page)) { result.skipped.push({ page: h.page, reason: "has your work" }); continue; }
      const seen = new Set<number>([h.page]);
      let target = h.canonical;
      while (hiddenTo.has(target) && !seen.has(target)) {
        seen.add(target);
        target = hiddenTo.get(target)!;
      }
      if (seen.has(target)) { result.skipped.push({ page: h.page, reason: "would hide every copy" }); continue; }
      const mark: DuplicateMark = {
        v: 1,
        pageNumber: target,
        tier: h.tier,
        score: h.full,
        content: h.content,
        full: h.full,
        scannedAt: now,
        hiddenAt: now,
        by: session.user.dbId,
      };
      await tx
        .update(pages)
        .set({
          pageIntelligence: sql`coalesce(${pages.pageIntelligence}, '{}'::jsonb) || jsonb_build_object('duplicateOf', ${JSON.stringify(mark)}::jsonb)`,
        })
        .where(and(eq(pages.projectId, project.id), eq(pages.pageNumber, h.page)));
      hiddenTo.set(h.page, target);
      result.hidden.push({ page: h.page, canonical: target, tier: h.tier });
    }
    return result;
  });
  if (result.hidden.length > 0) await refreshAfterVisibilityChange(project, capability);
  return result;
}

/**
 * [fix 2026-10-24 DOUBLE_BACK] Hiding / restoring changes the visible page set, so the project
 * analysis + summaries are refreshed exactly as permanent delete does (project-recompute.ts). The
 * marks are already committed; a failed refresh is logged and leaves them (Pipeline › Reprocess
 * intelligence rebuilds the analysis).
 */
async function refreshAfterVisibilityChange(project: DuplicateScopeProject, capability: ProjectWriteCapability): Promise<void> {
  try {
    await recomputeProject(project.id, capability);
  } catch (err) {
    logger.warn("[duplicates] recompute failed", { projectPublicId: project.publicId, error: String(err).slice(0, 200) });
  }
}

function auditApply(session: AuthSession, companyId: number, result: ProjectApplyResult, request: { tiers: DuplicateTier[]; blocks: string[]; keep?: DuplicateKeep }) {
  audit("admin.duplicates.apply", {
    userId: session.user.dbId,
    companyId,
    details: {
      projectPublicId: result.projectPublicId,
      hidden: result.hidden.map((h) => [h.page, h.canonical, h.tier]),
      skipped: result.skipped.length,
      tiers: request.tiers,
      blocks: request.blocks,
      keep: request.keep ?? null,
    },
  });
}

/** POST /api/admin/duplicates/apply — single project (digest) or all:true (digest map). */
export async function applyDuplicates(
  body: ApplyDuplicatesBody,
  session: AuthSession,
  query: { companyId?: string },
): Promise<unknown> {
  const companyId = resolveCompanyScope(session, query.companyId);
  const tiers = validateTiers(body.tiers);
  const blocks = [...new Set(body.blocks ?? [])];

  if (body.all) {
    if (blocks.length) throw new ApiError("VALIDATION", "Blocks are applied one project at a time");
    if (!tiers.length) throw new ApiError("VALIDATION", "Pass the tiers to remove");
    const digests = Object.entries(body.digests ?? {});
    if (!digests.length) throw new ApiError("VALIDATION", "all:true needs the scan's digests per project");
    if (digests.length > MAX_ALL_PROJECTS) throw new ApiError("VALIDATION", `At most ${MAX_ALL_PROJECTS} projects per request`);
    const inScope = await loadScopeProjects(companyId, null);
    const byPublicId = new Map(inScope.map((p) => [p.publicId, p]));
    const results: (ProjectApplyResult | { projectPublicId: string; skipped: string })[] = [];
    for (const [publicId, digest] of digests) {
      const project = byPublicId.get(publicId);
      if (!project) { results.push({ projectPublicId: publicId, skipped: "not found" }); continue; }
      try {
        const result = await applyToProject(project, digest, { tiers, blocks: [] }, session);
        auditApply(session, project.companyId, result, { tiers, blocks: [] });
        results.push(result);
      } catch (err) {
        if (!(err instanceof ApiError)) {
          logger.error("[duplicates] apply failed", { projectPublicId: publicId, err: String(err) });
          results.push({ projectPublicId: publicId, skipped: "failed" });
          continue;
        }
        results.push({ projectPublicId: publicId, skipped: err.status === 409 && err.message.startsWith("Duplicates changed") ? "changed since scan" : err.message });
      }
    }
    return { results };
  }

  if (!body.projectPublicId || !body.reportDigest) {
    throw new ApiError("VALIDATION", "Pass projectPublicId and reportDigest (or all:true with digests)");
  }
  if (!tiers.length && !blocks.length) throw new ApiError("VALIDATION", "Nothing to remove: pass tiers or blocks");
  const [project] = await loadScopeProjects(companyId, [body.projectPublicId]);
  const request = { tiers, blocks, keep: body.keep };
  const result = await applyToProject(project, body.reportDigest, request, session);
  auditApply(session, project.companyId, result, request);
  return result;
}

/** POST /api/admin/duplicates/restore — unhide every (or the listed) hidden page of one project. */
export async function restoreDuplicates(
  body: { projectPublicId: string; pages?: number[] },
  session: AuthSession,
  query: { companyId?: string },
): Promise<unknown> {
  const companyId = resolveCompanyScope(session, query.companyId);
  const [project] = await loadScopeProjects(companyId, [body.projectPublicId]);
  if (project.isDemo) throw new ApiError("FORBIDDEN", "Demo projects are read-only");
  const capability = assertProjectWritable(project);
  const restored = await withProjectWrite(capability, project.id, async (tx) => {
    const [current] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, project.id), eq(projects.isDemo, false)))
      .limit(1);
    if (!current) throw new ApiError("FORBIDDEN", "Demo projects are read-only");
    await assertNotBusy(tx, project.id);
    const filters = [eq(pages.projectId, project.id), sql`${pages.pageIntelligence} ? 'duplicateOf'`];
    if (body.pages?.length) filters.push(inArray(pages.pageNumber, body.pages));
    return tx
      .update(pages)
      .set({ pageIntelligence: sql`${pages.pageIntelligence} - 'duplicateOf'` })
      .where(and(...filters))
      .returning({ pageNumber: pages.pageNumber });
  });
  const restoredPages = restored.map((r) => r.pageNumber).sort((a, b) => a - b);
  if (restoredPages.length > 0) await refreshAfterVisibilityChange(project, capability);
  audit("admin.duplicates.restore", {
    userId: session.user.dbId,
    companyId: project.companyId,
    details: { projectPublicId: project.publicId, restored: restoredPages },
  });
  return { projectPublicId: project.publicId, restored: restoredPages };
}

/**
 * GET /api/projects/[id]/page-flags — the viewer's hidden duplicates (page → canonical) and,
 * for a completed project, `missing`: numbers in 1..numPages with no page row (permanently
 * deleted duplicates, page-permanent-delete.ts). The sidebar skips those like hidden pages.
 */
export async function getPageFlags(project: ProjectAccessRow): Promise<unknown> {
  const rows = await db
    .select({ pageNumber: pages.pageNumber, mark: sql<unknown>`${pages.pageIntelligence}->'duplicateOf'` })
    .from(pages)
    .where(eq(pages.projectId, project.id));
  const hidden: { pageNumber: number; duplicateOf: number; tier: DuplicateTier }[] = [];
  const present = new Set<number>();
  for (const row of rows) {
    present.add(row.pageNumber);
    const mark = getDuplicateOf({ duplicateOf: row.mark });
    if (mark?.hiddenAt) hidden.push({ pageNumber: row.pageNumber, duplicateOf: mark.pageNumber, tier: mark.tier });
  }
  const missing: number[] = [];
  if (project.status === "completed" && present.size > 0) {
    for (let n = 1; n <= (project.numPages ?? 0); n++) if (!present.has(n)) missing.push(n);
  }
  return { hidden: hidden.sort((a, b) => a.pageNumber - b.pageNumber), missing };
}
