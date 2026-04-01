import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { projects, pages, annotations } from "@/lib/db/schema";
import { eq, and, gte, lte } from "drizzle-orm";

/**
 * GET /api/projects/[id]/pages?from=1&to=9
 *
 * Returns page-level data (keynotes, csiCodes, textAnnotations, pageIntelligence)
 * and annotations for a range of pages. Used by the chunk loader to fetch
 * data for the current viewing window without loading the entire project.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { session, error } = await requireAuth();
  if (error) return error;

  const url = new URL(req.url);
  const from = parseInt(url.searchParams.get("from") || "1", 10);
  const to = parseInt(url.searchParams.get("to") || "9", 10);

  if (isNaN(from) || isNaN(to) || from < 1 || to < from || to - from > 50) {
    return NextResponse.json(
      { error: "Invalid range. Max 50 pages per request." },
      { status: 400 }
    );
  }

  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.publicId, id),
        eq(projects.companyId, session.user.companyId)
      )
    )
    .limit(1);

  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Fetch all page data in a single query (migration safety no longer needed — all migrations have run)
  const pageRows = await db
    .select({
      pageNumber: pages.pageNumber,
      name: pages.name,
      drawingNumber: pages.drawingNumber,
      keynotes: pages.keynotes,
      csiCodes: pages.csiCodes,
      textAnnotations: pages.textAnnotations,
      pageIntelligence: pages.pageIntelligence,
    })
    .from(pages)
    .where(
      and(
        eq(pages.projectId, project.id),
        gte(pages.pageNumber, from),
        lte(pages.pageNumber, to)
      )
    )
    .orderBy(pages.pageNumber);

  // Fetch annotations for pages in range
  const rangeAnnotations = await db
    .select()
    .from(annotations)
    .where(
      and(
        eq(annotations.projectId, project.id),
        gte(annotations.pageNumber, from),
        lte(annotations.pageNumber, to)
      )
    );

  return NextResponse.json({
    from,
    to,
    pages: pageRows.map((p) => ({
      pageNumber: p.pageNumber,
      name: p.name,
      drawingNumber: p.drawingNumber,
      keynotes: p.keynotes,
      csiCodes: p.csiCodes,
      textAnnotations: p.textAnnotations || null,
      pageIntelligence: p.pageIntelligence || null,
    })),
    annotations: rangeAnnotations.map((a) => ({
      id: a.id,
      pageNumber: a.pageNumber,
      name: a.name,
      bbox: [a.minX, a.minY, a.maxX, a.maxY],
      note: a.note,
      source: a.source,
      data: a.data,
    })),
  });
}
