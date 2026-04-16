import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, pages, annotations } from "@/lib/db/schema";
import { eq, and, gte, lte, isNull, or } from "drizzle-orm";
import type { ClientAnnotation } from "@/types";

/**
 * GET /api/demo/projects/[id]/pages?from=1&to=9
 *
 * Demo version of chunked pages endpoint — no auth, demo projects only.
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

  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.publicId, id), eq(projects.isDemo, true)))
    .limit(1);

  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const pageRows = await db
    .select({
      pageNumber: pages.pageNumber,
      name: pages.name,
      drawingNumber: pages.drawingNumber,
      keynotes: pages.keynotes,
      csiCodes: pages.csiCodes,
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

  let textAnnotationsMap: Record<number, unknown> = {};
  try {
    const taRows = await db
      .select({ pageNumber: pages.pageNumber, textAnnotations: pages.textAnnotations })
      .from(pages)
      .where(
        and(
          eq(pages.projectId, project.id),
          gte(pages.pageNumber, from),
          lte(pages.pageNumber, to)
        )
      );
    for (const r of taRows) {
      if (r.textAnnotations) textAnnotationsMap[r.pageNumber] = r.textAnnotations;
    }
  } catch { /* migration safety */ }

  let pageIntelligenceMap: Record<number, unknown> = {};
  try {
    const piRows = await db
      .select({ pageNumber: pages.pageNumber, pageIntelligence: pages.pageIntelligence })
      .from(pages)
      .where(
        and(
          eq(pages.projectId, project.id),
          gte(pages.pageNumber, from),
          lte(pages.pageNumber, to)
        )
      );
    for (const r of piRows) {
      if (r.pageIntelligence) pageIntelligenceMap[r.pageNumber] = r.pageIntelligence;
    }
  } catch { /* migration safety */ }

  const rangeAnnotations = await db
    .select()
    .from(annotations)
    .where(
      and(
        eq(annotations.projectId, project.id),
        gte(annotations.pageNumber, from),
        lte(annotations.pageNumber, to),
        // Show project-scoped annotations (null creator) OR YOLO annotations.
        // YOLO annotations are inserted with the running user's creator_id by
        // /api/yolo/load, but they're conceptually project-scoped — they
        // represent model detections, not user markups. For demo users (who
        // are read-only), show all YOLO regardless of who ran the model, so
        // the YOLO toolbar button and tag-mapping UI are discoverable.
        or(
          isNull(annotations.creatorId),
          eq(annotations.source, "yolo"),
          eq(annotations.source, "shape-parse"),
          eq(annotations.source, "symbol-search"),
        ),
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
      textAnnotations: textAnnotationsMap[p.pageNumber] || null,
      pageIntelligence: pageIntelligenceMap[p.pageNumber] || null,
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
}
