import { NextResponse } from "next/server";
import { resolveProjectAccess } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { pages, annotations } from "@/lib/db/schema";
import { and, gte, lte, eq } from "drizzle-orm";
import type { ClientAnnotation } from "@/types";

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

  const url = new URL(req.url);
  const from = parseInt(url.searchParams.get("from") || "1", 10);
  const to = parseInt(url.searchParams.get("to") || "9", 10);

  if (isNaN(from) || isNaN(to) || from < 1 || to < from || to - from > 50) {
    return NextResponse.json(
      { error: "Invalid range. Max 50 pages per request." },
      { status: 400 }
    );
  }

  const access = await resolveProjectAccess({ publicId: id });
  if (access.error) return access.error;
  const { project } = access;

  // Fetch page data and annotations in parallel (both need only project.id + page range)
  const [pageRows, rangeAnnotations] = await Promise.all([
    db.select({
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
      .orderBy(pages.pageNumber),
    db.select()
      .from(annotations)
      .where(
        and(
          eq(annotations.projectId, project.id),
          gte(annotations.pageNumber, from),
          lte(annotations.pageNumber, to)
        )
      ),
  ]);

  const response = NextResponse.json({
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
      source: a.source as ClientAnnotation["source"],
      data: a.data ?? null,
    })),
  });
  response.headers.set("Cache-Control", "private, max-age=300, stale-while-revalidate=600");
  return response;
}
