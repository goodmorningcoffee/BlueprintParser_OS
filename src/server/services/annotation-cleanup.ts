// [feat 2026-10-22 annotation-cleanup] Admin › Data tools › Annotation cleanup (ROOT only).
// Owner 2026-10-22: "I need the ability to basically 'delete all annotations' from selected / all
// projects, like the YOLO 'purge all' button" — plus removal of exact duplicate rows left by
// earlier append-style reruns (audit: gitignore/projects/admin_data_tools/RERUN_AUDIT_2026-10-22.md).
//
//   GET  → the non-demo projects in scope (with annotation counts) and the distinct sources.
//   POST → dry run (counts per project + total, changes nothing) or, with the typed phrase, the
//          real run: per project, batched deletes, each batch inside withProjectWrite.
// Modes:  dedupe — rows identical on (project, page, source, name, bbox, data->>'modelId') are
//                  removed, keeping the lowest id.
//         delete — every matching row; optional clearPageCsi also sets pages.csi_codes = NULL.
// User-made sources (user-drawn markup, takeoff, symbol-search saves) are excluded unless the
// caller names them explicitly. Demo projects are never in scope (same rule as yolo-purge).
// [TP-1 WP-1.C, K75] POST with no company scope (no ?companyId) refuses unless the body says
// `allCompanies: true`. A caller that meant one company and lost its company id (the Reprocess tab
// when GET /reprocess/scope fails) used to delete in EVERY company; now it gets a 400.
import { z } from "zod";
import { and, asc, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import type { AuthSession } from "@/lib/api-utils";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { annotations, pages, projects } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { computeProjectSummaries } from "@/lib/project-analysis";
import { ApiError } from "@/server/api/envelope";
import { zPublicId } from "@/server/api/schemas";
import { assertProjectWritable, withProjectWrite } from "@/server/api/project-write-capability";
import { HUMAN_ANNOTATION_SOURCES, resolveCompanyScope } from "./page-duplicates";

/** Sources a person made by hand — never deleted unless named explicitly. */
export const USER_MADE_SOURCES: readonly string[] = [...HUMAN_ANNOTATION_SOURCES, "symbol-search"];
export const CLEANUP_BATCH = 2000;
const MAX_PROJECTS = 2000;
export const CONFIRM_PHRASE = { dedupe: "DEDUPE", delete: "DELETE" } as const;

export const zCleanupQuery = z.object({ companyId: z.string().optional() });
export const zCleanupBody = z.object({
  mode: z.enum(["dedupe", "delete"]),
  all: z.boolean().optional(),
  projectPublicIds: z.array(zPublicId).max(MAX_PROJECTS).optional(),
  sources: z.array(z.string().min(1).max(50)).max(50).optional(),
  clearPageCsi: z.boolean().optional(),
  /** Required (true) when no ?companyId is given: an every-company run must be chosen, never a fallback. */
  allCompanies: z.boolean().optional(),
  dryRun: z.boolean(),
  confirm: z.string().max(40).optional(),
});
type CleanupBody = z.infer<typeof zCleanupBody>;

interface ScopeProject { id: number; publicId: string; name: string; companyId: number; isDemo: boolean; lifecycleEpoch: number }

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
      id: projects.id, publicId: projects.publicId, name: projects.name,
      companyId: projects.companyId, isDemo: projects.isDemo, lifecycleEpoch: projects.lifecycleEpoch,
    })
    .from(projects)
    .where(and(...filters))
    .orderBy(asc(projects.id))
    .limit(MAX_PROJECTS);
  if (publicIds && rows.length !== new Set(publicIds).size) throw new ApiError("NOT_FOUND", "Project not found");
  return rows;
}

const sourceList = (sources: readonly string[]) => sql.join(sources.map((s) => sql`${s}`), sql`, `);

/** Ids of surplus exact-duplicate rows (all but the lowest id of each identical group). */
const duplicateIds = (projectId: number, sources: readonly string[]) => sql`
  SELECT id FROM (
    SELECT id, row_number() OVER (
      PARTITION BY page_number, source, name, min_x, min_y, max_x, max_y, data->>'modelId'
      ORDER BY id
    ) AS rn
    FROM annotations
    WHERE project_id = ${projectId} AND source IN (${sourceList(sources)})
  ) ranked
  WHERE rn > 1`;

async function countMatches(projectId: number, mode: CleanupBody["mode"], sources: readonly string[]): Promise<number> {
  const inner = mode === "dedupe"
    ? duplicateIds(projectId, sources)
    : sql`SELECT id FROM annotations WHERE project_id = ${projectId} AND source IN (${sourceList(sources)})`;
  const res = await db.execute(sql`SELECT count(*)::int AS n FROM (${inner}) m`);
  return Number((res.rows[0] as { n: number } | undefined)?.n ?? 0);
}

async function countPagesWithCsi(projectId: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(pages)
    .where(and(eq(pages.projectId, projectId), isNotNull(pages.csiCodes)));
  return Number(row?.n ?? 0);
}

export async function getCleanupScope(session: AuthSession, query: z.infer<typeof zCleanupQuery>): Promise<unknown> {
  rootOnly(session);
  const companyId = resolveCompanyScope(session, query.companyId);
  const inScope = await scopeProjects(companyId, null);
  const ids = inScope.map((p) => p.id);
  const counts = ids.length === 0 ? [] : await db
    .select({ projectId: annotations.projectId, source: annotations.source, n: sql<number>`count(*)::int` })
    .from(annotations)
    .where(inArray(annotations.projectId, ids))
    .groupBy(annotations.projectId, annotations.source);
  const perProject = new Map<number, number>();
  const perSource = new Map<string, number>();
  for (const c of counts) {
    perProject.set(c.projectId, (perProject.get(c.projectId) ?? 0) + Number(c.n));
    perSource.set(c.source, (perSource.get(c.source) ?? 0) + Number(c.n));
  }
  return {
    projects: inScope.map((p) => ({ publicId: p.publicId, name: p.name, companyId: p.companyId, annotations: perProject.get(p.id) ?? 0 })),
    sources: [...perSource.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([source, count]) => ({ source, count, userMade: USER_MADE_SOURCES.includes(source) })),
  };
}

/** Explicit sources win; omitted → every source present in scope except the user-made ones. */
async function resolveSources(body: CleanupBody, ids: readonly number[]): Promise<string[]> {
  if (body.sources) {
    if (body.sources.length === 0) throw new ApiError("VALIDATION", "Pick at least one source");
    return [...new Set(body.sources)];
  }
  if (ids.length === 0) return [];
  const rows = await db.selectDistinct({ source: annotations.source }).from(annotations).where(inArray(annotations.projectId, [...ids]));
  return rows.map((r) => r.source).filter((s) => !USER_MADE_SOURCES.includes(s)).sort();
}

export async function runAnnotationCleanup(
  session: AuthSession,
  body: CleanupBody,
  query: z.infer<typeof zCleanupQuery>,
): Promise<unknown> {
  rootOnly(session);
  if (!body.all && !body.projectPublicIds?.length) throw new ApiError("VALIDATION", "Pick projects or all projects");
  const clearPageCsi = body.mode === "delete" && body.clearPageCsi === true;
  const phrase = CONFIRM_PHRASE[body.mode];
  if (!body.dryRun && body.confirm?.trim() !== phrase) {
    throw new ApiError("VALIDATION", `Type ${phrase} to confirm`);
  }
  const companyId = resolveCompanyScope(session, query.companyId);
  if (companyId === null && body.allCompanies !== true) {
    throw new ApiError("VALIDATION", "Pick a company, or choose all companies explicitly");
  }
  const inScope = await scopeProjects(companyId, body.all ? null : (body.projectPublicIds ?? []));
  const sources = await resolveSources(body, inScope.map((p) => p.id));

  const results: { publicId: string; name: string; annotations: number; pagesCsiCleared: number; error?: string }[] = [];
  for (const project of inScope) {
    const row = { publicId: project.publicId, name: project.name, annotations: 0, pagesCsiCleared: 0 } as (typeof results)[number];
    try {
      if (body.dryRun) {
        row.annotations = sources.length ? await countMatches(project.id, body.mode, sources) : 0;
        row.pagesCsiCleared = clearPageCsi ? await countPagesWithCsi(project.id) : 0;
      } else {
        const capability = assertProjectWritable(project);
        for (;;) {
          if (!sources.length) break;
          const victims = body.mode === "dedupe"
            ? sql`${duplicateIds(project.id, sources)} LIMIT ${CLEANUP_BATCH}`
            : sql`SELECT id FROM annotations WHERE project_id = ${project.id} AND source IN (${sourceList(sources)}) LIMIT ${CLEANUP_BATCH}`;
          const deleted = await withProjectWrite(capability, project.id, (tx) =>
            tx.execute(sql`DELETE FROM annotations WHERE project_id = ${project.id} AND id IN (${victims}) RETURNING id`));
          const n = deleted.rowCount ?? 0;
          row.annotations += n;
          if (n < CLEANUP_BATCH) break;
        }
        if (clearPageCsi) {
          const cleared = await withProjectWrite(capability, project.id, (tx) => tx
            .update(pages).set({ csiCodes: null })
            .where(and(eq(pages.projectId, project.id), isNotNull(pages.csiCodes)))
            .returning({ id: pages.id }));
          row.pagesCsiCleared = cleared.length;
        }
        if (row.annotations > 0 || row.pagesCsiCleared > 0) {
          // Summaries (project chunk index) count annotations — refresh, best effort.
          await computeProjectSummaries(project.id, capability).catch((err) =>
            logger.warn("[annotation-cleanup] summary refresh failed", { project: project.publicId, error: String(err).slice(0, 200) }));
        }
      }
    } catch (err) {
      row.error = err instanceof ApiError ? err.message : "Failed";
      logger.error(`[annotation-cleanup] project ${project.publicId} failed:`, err);
    }
    results.push(row);
  }

  const total = results.reduce((n, r) => n + r.annotations, 0);
  const pagesCsiCleared = results.reduce((n, r) => n + r.pagesCsiCleared, 0);
  if (!body.dryRun) {
    audit("admin.annotations.cleanup", {
      userId: session.user.dbId,
      companyId: session.user.companyId,
      details: { mode: body.mode, sources, clearPageCsi, scopeCompanyId: companyId, projects: results.length, total, pagesCsiCleared },
    });
  }
  return { dryRun: body.dryRun, mode: body.mode, sources, clearPageCsi, confirmPhrase: phrase, projects: results, total, pagesCsiCleared };
}
