import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { projects, pages, annotations, qtoWorkflows } from "@/lib/db/schema";
import { eq, and, inArray, sql, desc } from "drizzle-orm";

/**
 * GET /api/projects/export-index
 *
 * Lists every project the caller can access (root admin → all; otherwise the
 * caller's company) with a per-project **parse-coverage summary**, so a download
 * tool can prioritize the richly-parsed projects.
 *
 * Coverage distinguishes *user-initiated* parsings (the valuable, per-plan work
 * — parsed tables/notes/specs, tag-mapping/QTO, symbol search) from *automatic*
 * outputs (YOLO load, shape-parse-at-upload). The `richness` score weights the
 * user-initiated ones so the TUI can sort them to the top.
 *
 * Response:
 *   { projects: [ {
 *       publicId, name, numPages, status, createdAt,
 *       coverage: { yolo, yoloModels[], shapeParse, symbolSearch, userAnnotations,
 *                   parsedRegions, pagesWithParsedRegions, qtoWorkflows },
 *       richness
 *   } ] }
 *
 * All counts come from cheap GROUP BY aggregates (no JSONB blobs transferred).
 */
export async function GET() {
  const { session, error } = await requireAuth();
  if (error) return error;
  const user = session.user as { companyId: number; isRootAdmin?: boolean };

  const cols = {
    id: projects.id,
    publicId: projects.publicId,
    name: projects.name,
    numPages: projects.numPages,
    status: projects.status,
    createdAt: projects.createdAt,
  };
  const projRows = user.isRootAdmin
    ? await db.select(cols).from(projects).orderBy(desc(projects.createdAt))
    : await db.select(cols).from(projects)
        .where(eq(projects.companyId, user.companyId))
        .orderBy(desc(projects.createdAt));

  if (projRows.length === 0) return NextResponse.json({ projects: [] });
  const ids = projRows.map((p) => p.id);

  // annotation counts by source per project
  const annAgg = await db
    .select({
      projectId: annotations.projectId,
      source: annotations.source,
      n: sql<number>`count(*)::int`,
    })
    .from(annotations)
    .where(inArray(annotations.projectId, ids))
    .groupBy(annotations.projectId, annotations.source);

  // distinct YOLO model names per project
  const modelAgg = await db
    .select({
      projectId: annotations.projectId,
      modelName: sql<string | null>`(${annotations.data} ->> 'modelName')`,
    })
    .from(annotations)
    .where(and(inArray(annotations.projectId, ids), eq(annotations.source, "yolo")))
    .groupBy(annotations.projectId, sql`(${annotations.data} ->> 'modelName')`);

  // parsedRegions: total + pages-with-any, summed over pageIntelligence JSONB
  const prAgg = await db
    .select({
      projectId: pages.projectId,
      parsedRegions: sql<number>`COALESCE(SUM(CASE WHEN jsonb_typeof(${pages.pageIntelligence} -> 'parsedRegions') = 'array' THEN jsonb_array_length(${pages.pageIntelligence} -> 'parsedRegions') ELSE 0 END), 0)::int`,
      pagesWithParsedRegions: sql<number>`(COUNT(*) FILTER (WHERE jsonb_typeof(${pages.pageIntelligence} -> 'parsedRegions') = 'array' AND jsonb_array_length(${pages.pageIntelligence} -> 'parsedRegions') > 0))::int`,
    })
    .from(pages)
    .where(inArray(pages.projectId, ids))
    .groupBy(pages.projectId);

  // QTO workflows (tag-mapping / Auto-QTO) per project
  const qtoAgg = await db
    .select({ projectId: qtoWorkflows.projectId, n: sql<number>`count(*)::int` })
    .from(qtoWorkflows)
    .where(inArray(qtoWorkflows.projectId, ids))
    .groupBy(qtoWorkflows.projectId);

  // ── fold aggregates into per-project maps ──
  const bySource = new Map<number, Record<string, number>>();
  for (const r of annAgg) {
    const m = bySource.get(r.projectId) ?? {};
    m[r.source] = r.n;
    bySource.set(r.projectId, m);
  }
  const models = new Map<number, Set<string>>();
  for (const r of modelAgg) {
    if (!r.modelName) continue;
    const s = models.get(r.projectId) ?? new Set<string>();
    s.add(r.modelName);
    models.set(r.projectId, s);
  }
  const pr = new Map(prAgg.map((r) => [r.projectId, r]));
  const qto = new Map(qtoAgg.map((r) => [r.projectId, r.n]));

  const out = projRows.map((p) => {
    const src = bySource.get(p.id) ?? {};
    const parsedRegions = pr.get(p.id)?.parsedRegions ?? 0;
    const pagesWithParsedRegions = pr.get(p.id)?.pagesWithParsedRegions ?? 0;
    const symbolSearch = src["symbol-search"] ?? 0;
    const shapeParse = src["shape-parse"] ?? 0;
    const yolo = src["yolo"] ?? 0;
    const userAnnotations = src["user"] ?? 0;
    const qtoWorkflowsCount = qto.get(p.id) ?? 0;

    // Prioritize *user-initiated* per-plan work. parsedRegions + QTO are the gold
    // (a human committed each). shape-parse & yolo run automatically → info only.
    const richness =
      parsedRegions * 5 +
      qtoWorkflowsCount * 5 +
      (symbolSearch > 0 ? 3 : 0) +
      userAnnotations * 1;

    return {
      publicId: p.publicId,
      name: p.name,
      numPages: p.numPages,
      status: p.status,
      createdAt: p.createdAt,
      coverage: {
        yolo,
        yoloModels: Array.from(models.get(p.id) ?? []).sort(),
        shapeParse,
        symbolSearch,
        userAnnotations,
        parsedRegions,
        pagesWithParsedRegions,
        qtoWorkflows: qtoWorkflowsCount,
      },
      richness,
    };
  });

  out.sort((a, b) => b.richness - a.richness);
  return NextResponse.json({ projects: out });
}
