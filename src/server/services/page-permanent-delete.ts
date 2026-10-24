// [feat 2026-10-23 page-permanent-delete] Admin › Data tools › Duplicates › Delete hidden pages
// permanently (ROOT only). Owner 2026-10-23: "yes i want real deletion" for data cleanup.
//
// Hiding (page-duplicates-apply.ts) keeps every row and object; this tool removes the HIDDEN
// duplicates for good: the pages row, its annotations (group memberships cascade; a group left
// with no members BY THIS DELETE is dropped), its page-scoped chat, and — after the commit —
// its S3 objects (page image, thumbnail, per-page YOLO output). original.pdf is never touched,
// so the pages still exist in the upload. Page numbers are KEPT (gaps); projects.num_pages
// stays the max index. Every consumer that walks 1..numPages tolerates a missing row.
//
//   POST dryRun:true  → per project: pages to delete (with counts + S3 keys), pages skipped and
//                       why. Changes nothing.
//   POST confirm:"DELETE" + planDigests → the real run: per project ONE transaction
//                       (withProjectWrite, busy check under the lock, re-planned there and
//                       compared with the previewed plan's digest — a difference is a 409-class
//                       per-project refusal, nothing deleted), then S3 deletes (failures are
//                       warnings, never a rollback), then the same recompute reprocess does
//                       (analyzeProject + computeProjectSummaries), then one audit entry.
// Never deleted: a page carrying human work (humanWorkPages with USER_MADE_SOURCES — user,
// takeoff, takeoff-scale, symbol-search — QTO references, non-empty parsedRegions), a page
// number stored twice (duplicate rows; fix those first), a page whose kept copy is gone, and
// PAGE 1 — both YOLO entry points (yolo.ts yoloRun, yolo-batch-run.ts) HEAD
// {dataUrl}/pages/page_0001.png before starting, so deleting it would refuse every later run.
// Demo projects are never in scope (same rule as annotation-cleanup / yolo-purge).

import { createHash } from "node:crypto";
import { z } from "zod";
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import type { AuthSession } from "@/lib/api-utils";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { annotationGroupMembers, annotationGroups, annotations, chatMessages, pages, projects } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { getDuplicateOf } from "@/lib/page-dedup";
import { deleteFromS3, s3Client, S3_BUCKET } from "@/lib/s3";
import { ApiError } from "@/server/api/envelope";
import { zPublicId } from "@/server/api/schemas";
import {
  assertProjectWritable,
  withProjectWrite,
  type ProjectWriteCapability,
} from "@/server/api/project-write-capability";
import { USER_MADE_SOURCES } from "./annotation-cleanup";
import { projectSkipReason, resolveCompanyScope } from "./page-duplicates";
import { assertNotBusy, humanWorkPages, type WorkReader } from "./page-duplicates-apply";
import { recomputeProject } from "./project-recompute";

export const DELETE_CONFIRM = "DELETE";
const MAX_PROJECTS = 2000;
export const ORIGINAL_PDF_NOTE = "original.pdf is not changed: the deleted pages are still in the uploaded file.";
/** YOLO's "processed?" probe object (yolo.ts yoloRun + yolo-batch-run.ts HEAD it): its page is never deleted. */
export const PROBE_PAGE = 1;
export const PROBE_PAGE_REASON = `page ${PROBE_PAGE} is the project's probe page (YOLO checks pages/page_0001.png exists before every run)`;
export const CHANGED_SINCE_PREVIEW = "Changed since the preview; preview again";
export const NOT_PREVIEWED = "Not in the preview; preview again";

export const zDeleteHiddenQuery = z.object({ companyId: z.string().optional() });
export const zDeleteHiddenBody = z.object({
  all: z.boolean().optional(),
  projectPublicIds: z.array(zPublicId).max(MAX_PROJECTS).optional(),
  dryRun: z.boolean(),
  confirm: z.string().max(40).optional(),
  /** Real run: publicId → planDigest from the dry run. The delete refuses a project whose re-plan differs. */
  planDigests: z.record(z.string().max(64), z.string().max(64)).optional(),
});
type DeleteHiddenBody = z.infer<typeof zDeleteHiddenBody>;

interface ScopeProject {
  id: number; publicId: string; name: string; companyId: number; isDemo: boolean;
  status: string; lifecycleEpoch: number; numPages: number | null; dataUrl: string;
}

export interface PlannedPage {
  /** pages.id of the one hidden row (never selected by page number: a twice-stored page is skipped). */
  rowId: number;
  page: number;
  canonical: number;
  tier: string;
  hiddenAt: string;
  annotations: number;
  chats: number;
  s3Keys: string[];
}

export interface ProjectDeletePlan {
  publicId: string;
  name: string;
  companyId: number;
  numPages: number | null;
  /** Set when the whole project is skipped (demo, not completed, busy …). */
  skippedReason?: string;
  /** sha256 over the planned row ids; the real run must send it back (planDigests) and re-derives it under the lock. */
  planDigest?: string;
  pages: PlannedPage[];
  skipped: { page: number; reason: string }[];
  warnings: string[];
  /** Real run only: rows actually deleted in the committed transaction. */
  deleted?: number;
  error?: string;
}

function rootOnly(session: AuthSession): void {
  if (!session.user.isRootAdmin) throw new ApiError("FORBIDDEN", "Root only");
}

/** Non-demo projects in scope. With `publicIds`, every id must resolve or the request 404s. */
async function scopeProjects(companyId: number | null, publicIds: readonly string[] | null): Promise<ScopeProject[]> {
  const filters: SQL[] = [eq(projects.isDemo, false)];
  if (companyId !== null) filters.push(eq(projects.companyId, companyId));
  if (publicIds) {
    if (publicIds.length === 0) return [];
    filters.push(inArray(projects.publicId, [...new Set(publicIds)]));
  }
  const rows = await db
    .select({
      id: projects.id, publicId: projects.publicId, name: projects.name, companyId: projects.companyId,
      isDemo: projects.isDemo, status: projects.status, lifecycleEpoch: projects.lifecycleEpoch,
      numPages: projects.numPages, dataUrl: projects.dataUrl,
    })
    .from(projects)
    .where(and(...filters))
    .orderBy(asc(projects.id))
    .limit(MAX_PROJECTS);
  if (publicIds && rows.length !== new Set(publicIds).size) throw new ApiError("NOT_FOUND", "Project not found");
  return rows;
}

const pad4 = (n: number) => String(n).padStart(4, "0");

/** Per-page YOLO result files under {dataUrl}/yolo-output/<model>/ (named page_NNNN.json — yolo.ts:531-546). */
async function listYoloOutputKeys(dataUrl: string): Promise<Map<number, string[]>> {
  const prefix = `${dataUrl}/yolo-output/`;
  const byPage = new Map<number, string[]>();
  let token: string | undefined;
  do {
    const listed = await s3Client.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: prefix, ContinuationToken: token }));
    for (const obj of listed.Contents ?? []) {
      const key = obj.Key;
      if (!key || !key.endsWith(".json") || key.endsWith("_manifest.json")) continue;
      const match = /page_(\d+)/.exec(key.split("/").pop() ?? "");
      if (!match) continue;
      const page = parseInt(match[1], 10);
      byPage.set(page, [...(byPage.get(page) ?? []), key]);
    }
    token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (token);
  return byPage;
}

async function countByPage(reader: WorkReader, projectId: number, pageNumbers: number[]) {
  const counts = { annotations: new Map<number, number>(), chats: new Map<number, number>() };
  if (pageNumbers.length === 0) return counts;
  const ann = await reader
    .select({ page: annotations.pageNumber, n: sql<number>`count(*)::int` })
    .from(annotations)
    .where(and(eq(annotations.projectId, projectId), inArray(annotations.pageNumber, pageNumbers)))
    .groupBy(annotations.pageNumber);
  for (const r of ann) counts.annotations.set(r.page, Number(r.n));
  const chat = await reader
    .select({ page: chatMessages.pageNumber, n: sql<number>`count(*)::int` })
    .from(chatMessages)
    .where(and(eq(chatMessages.projectId, projectId), inArray(chatMessages.pageNumber, pageNumbers)))
    .groupBy(chatMessages.pageNumber);
  for (const r of chat) if (r.page !== null) counts.chats.set(r.page, Number(r.n));
  return counts;
}

/**
 * The plan for one project from the stored marks: hidden pages minus the protected ones. The
 * dry run plans from `db`; the real run re-plans inside its transaction, so what is deleted is
 * what the lock sees. `yoloKeys` is the S3 listing taken outside the transaction (or null).
 */
async function planProject(reader: WorkReader, project: ScopeProject, yoloKeys: Map<number, string[]> | null): Promise<ProjectDeletePlan> {
  const plan: ProjectDeletePlan = {
    publicId: project.publicId, name: project.name, companyId: project.companyId, numPages: project.numPages,
    pages: [], skipped: [], warnings: [],
  };
  const rows = await reader
    .select({ id: pages.id, pageNumber: pages.pageNumber, mark: sql<unknown>`${pages.pageIntelligence}->'duplicateOf'` })
    .from(pages)
    .where(eq(pages.projectId, project.id))
    .orderBy(asc(pages.pageNumber), asc(pages.id));
  const rowsPerPage = new Map<number, number>();
  for (const r of rows) rowsPerPage.set(r.pageNumber, (rowsPerPage.get(r.pageNumber) ?? 0) + 1);
  const hidden = rows.flatMap((r) => {
    const mark = getDuplicateOf({ duplicateOf: r.mark });
    return mark?.hiddenAt ? [{ row: r, mark }] : [];
  });
  if (hidden.length === 0) return plan;
  const work = await humanWorkPages(reader, project.id, USER_MADE_SOURCES);
  for (const { row, mark } of hidden) {
    const page = row.pageNumber;
    if (page === PROBE_PAGE) { plan.skipped.push({ page, reason: PROBE_PAGE_REASON }); continue; }
    if ((rowsPerPage.get(page) ?? 0) > 1) { plan.skipped.push({ page, reason: "stored twice (duplicate page rows)" }); continue; }
    if (work.has(page)) { plan.skipped.push({ page, reason: "has your work" }); continue; }
    if (!rowsPerPage.has(mark.pageNumber)) { plan.skipped.push({ page, reason: `kept copy (page ${mark.pageNumber}) is missing` }); continue; }
    plan.pages.push({
      rowId: row.id, page, canonical: mark.pageNumber, tier: mark.tier, hiddenAt: mark.hiddenAt!,
      annotations: 0, chats: 0,
      s3Keys: [
        `${project.dataUrl}/pages/page_${pad4(page)}.png`,
        `${project.dataUrl}/thumbnails/page_${pad4(page)}.png`,
        ...(yoloKeys?.get(page) ?? []),
      ],
    });
  }
  const counts = await countByPage(reader, project.id, plan.pages.map((p) => p.page));
  for (const p of plan.pages) {
    p.annotations = counts.annotations.get(p.page) ?? 0;
    p.chats = counts.chats.get(p.page) ?? 0;
  }
  plan.planDigest = planDigest(plan.pages);
  return plan;
}

/**
 * The plan's identity: the set of page ROWS it deletes (row ids are never reused, and a page that
 * gains work, loses its mark or gets a twin leaves the set). S3 keys are left out on purpose: the
 * YOLO listing is best-effort and taken outside the lock.
 */
function planDigest(planned: readonly PlannedPage[]): string {
  const ids = planned.map((p) => p.rowId).sort((a, b) => a - b);
  return createHash("sha256").update(ids.join(",")).digest("hex");
}

/**
 * S3 listing for the plan's YOLO files; a listing failure is a warning (keys may be left behind).
 * A leftover page_NNNN.json is harmless to the DB: /yolo/load skips files whose page has no row.
 */
const YOLO_LEFTOVER_NOTE = "a later YOLO load skips them (no page row)";
async function yoloKeysOrWarn(project: ScopeProject, warnings: string[]): Promise<Map<number, string[]> | null> {
  try {
    return await listYoloOutputKeys(project.dataUrl);
  } catch (err) {
    warnings.push(`YOLO output could not be listed; per-page YOLO files are not deleted, ${YOLO_LEFTOVER_NOTE} (${String(err).slice(0, 120)})`);
    return null;
  }
}

/**
 * Delete the planned pages of one project in ONE transaction. Re-plans under the lock and refuses
 * (CONFLICT, nothing deleted) unless the re-plan's digest equals the previewed one; then deletes
 * the page's annotations (memberships cascade), the groups those annotations emptied, the
 * page's chat, then the page row. Returns the committed plan.
 */
async function deleteInProject(project: ScopeProject, capability: ProjectWriteCapability, yoloKeys: Map<number, string[]> | null, expectedDigest: string): Promise<ProjectDeletePlan> {
  return withProjectWrite(capability, project.id, async (tx) => {
    const [current] = await tx
      .select({ status: projects.status })
      .from(projects)
      .where(and(eq(projects.id, project.id), eq(projects.isDemo, false)))
      .limit(1);
    if (!current || current.status !== "completed") throw new ApiError("CONFLICT", "Project skipped: not completed");
    await assertNotBusy(tx, project.id);
    const plan = await planProject(tx, project, yoloKeys);
    if (plan.planDigest !== expectedDigest) throw new ApiError("CONFLICT", CHANGED_SINCE_PREVIEW);
    for (const p of plan.pages) {
      const onPage = and(eq(annotations.projectId, project.id), eq(annotations.pageNumber, p.page));
      const touched = await tx
        .selectDistinct({ groupId: annotationGroupMembers.groupId })
        .from(annotationGroupMembers)
        .innerJoin(annotations, eq(annotationGroupMembers.annotationId, annotations.id))
        .where(onPage);
      await tx.delete(annotations).where(onPage);
      if (touched.length > 0) {
        await tx.delete(annotationGroups).where(and(
          eq(annotationGroups.projectId, project.id),
          inArray(annotationGroups.id, touched.map((g) => g.groupId)),
          sql`NOT EXISTS (SELECT 1 FROM annotation_group_members m WHERE m.group_id = ${annotationGroups.id})`,
        ));
      }
      await tx.delete(chatMessages).where(and(eq(chatMessages.projectId, project.id), eq(chatMessages.pageNumber, p.page)));
      await tx.delete(pages).where(and(eq(pages.id, p.rowId), eq(pages.projectId, project.id)));
    }
    plan.deleted = plan.pages.length;
    return plan;
  });
}

/** `expectedDigest` is the real run's previewed digest for this project (undefined on a dry run). */
async function runProject(project: ScopeProject, dryRun: boolean, expectedDigest: string | undefined): Promise<ProjectDeletePlan> {
  const skip = projectSkipReason(project);
  if (skip) {
    return { publicId: project.publicId, name: project.name, companyId: project.companyId, numPages: project.numPages, skippedReason: skip, pages: [], skipped: [], warnings: [] };
  }
  const warnings: string[] = [];
  const yoloKeys = await yoloKeysOrWarn(project, warnings);
  if (dryRun) {
    const plan = await planProject(db, project, yoloKeys);
    plan.warnings.push(...warnings);
    return plan;
  }
  // A project the preview never saw (e.g. one that completed since, under all:true) is refused.
  if (expectedDigest === undefined) throw new ApiError("CONFLICT", NOT_PREVIEWED);
  const capability = assertProjectWritable(project);
  const plan = await deleteInProject(project, capability, yoloKeys, expectedDigest);
  plan.warnings.push(...warnings);
  if (plan.pages.length === 0) return plan;
  // Storage after the commit: a failure here leaves an orphan object, never a half-deleted page.
  for (const key of plan.pages.flatMap((p) => p.s3Keys)) {
    try {
      await deleteFromS3(key);
    } catch (err) {
      const leftover = key.includes("/yolo-output/") ? `, ${YOLO_LEFTOVER_NOTE}` : "";
      plan.warnings.push(`S3 delete failed for ${key}${leftover} (${String(err).slice(0, 120)})`);
    }
  }
  try {
    await recomputeProject(project.id, capability);
  } catch (err) {
    plan.warnings.push(`Project analysis refresh failed (${String(err).slice(0, 120)}); run Pipeline › Reprocess intelligence`);
    logger.warn("[page-permanent-delete] recompute failed", { project: project.publicId, error: String(err).slice(0, 200) });
  }
  return plan;
}

/** POST /api/admin/duplicates/delete-hidden — dry run, or (typed phrase) permanent delete. */
export async function deleteHiddenPages(
  session: AuthSession,
  body: DeleteHiddenBody,
  query: z.infer<typeof zDeleteHiddenQuery>,
): Promise<unknown> {
  rootOnly(session);
  if (!body.all && !body.projectPublicIds?.length) throw new ApiError("VALIDATION", "Pick projects or all projects");
  if (!body.dryRun && body.confirm?.trim() !== DELETE_CONFIRM) throw new ApiError("VALIDATION", `Type ${DELETE_CONFIRM} to confirm`);
  if (!body.dryRun && !body.planDigests) throw new ApiError("VALIDATION", "Preview first: the real run needs the preview's planDigests");
  const companyId = resolveCompanyScope(session, query.companyId);
  const inScope = await scopeProjects(companyId, body.all ? null : (body.projectPublicIds ?? []));

  const results: ProjectDeletePlan[] = [];
  for (const project of inScope) {
    try {
      results.push(await runProject(project, body.dryRun, body.planDigests?.[project.publicId]));
    } catch (err) {
      logger.error(`[page-permanent-delete] project ${project.publicId} failed:`, err);
      results.push({
        publicId: project.publicId, name: project.name, companyId: project.companyId, numPages: project.numPages,
        pages: [], skipped: [], warnings: [], error: err instanceof ApiError ? err.message : "Failed",
      });
    }
  }
  const totals = {
    pages: results.reduce((n, r) => n + r.pages.length, 0),
    annotations: results.reduce((n, r) => n + r.pages.reduce((m, p) => m + p.annotations, 0), 0),
    chats: results.reduce((n, r) => n + r.pages.reduce((m, p) => m + p.chats, 0), 0),
    s3Keys: results.reduce((n, r) => n + r.pages.reduce((m, p) => m + p.s3Keys.length, 0), 0),
    skipped: results.reduce((n, r) => n + r.skipped.length, 0),
  };
  if (!body.dryRun) {
    audit("admin.duplicates.delete-hidden", {
      userId: session.user.dbId,
      companyId: session.user.companyId,
      details: {
        scopeCompanyId: companyId,
        projects: results.length,
        ...totals,
        deleted: results.filter((r) => r.pages.length > 0).map((r) => [r.publicId, r.pages.map((p) => p.page)]),
        warnings: results.reduce((n, r) => n + r.warnings.length, 0),
      },
    });
  }
  return { dryRun: body.dryRun, confirmPhrase: DELETE_CONFIRM, note: ORIGINAL_PDF_NOTE, projects: results, totals };
}
