import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { projects, pages, annotations } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { classifyPageRegions, validateExclusionPreflight } from "@/lib/composite-classifier";
import type { PageIntelligence } from "@/types";

/**
 * GET /api/projects/[id]/classify-regions?page=N
 *
 * Debug endpoint — runs the composite region classifier on demand for a
 * single page and returns the raw ClassifiedPageRegions output. Used by
 * the admin Table Parsing tab to validate classifier behavior against real
 * pages without needing to trigger a full YOLO re-load.
 *
 * Also returns the project-wide preflight result so the caller can see
 * which strict exclusion classes are missing and whether Auto-QTO would
 * pass the hard-block check.
 *
 * Response shape:
 *   {
 *     pageNumber: number,
 *     preflight: PreflightResult,
 *     regions: ClassifiedPageRegions,
 *     inputCounts: { yoloAnnotations, textRegions, parsedRegions, legacyClassifiedTables }
 *   }
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(req.url);
  const pageParam = url.searchParams.get("page");
  if (!pageParam) {
    return NextResponse.json({ error: "page query parameter required" }, { status: 400 });
  }
  const pageNumber = parseInt(pageParam, 10);
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    return NextResponse.json({ error: "page must be a positive integer" }, { status: 400 });
  }

  // Auth: company-scoped with demo fallback, matching map-tags-batch
  const session = await auth();
  let project;
  if (session?.user) {
    const companyId = (session.user as { companyId?: number }).companyId;
    [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.publicId, id), eq(projects.companyId, companyId!)))
      .limit(1);
  } else {
    [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.publicId, id), eq(projects.isDemo, true)))
      .limit(1);
  }
  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Load all yolo annotations for the project. Needed twice:
  // 1. project-wide for the preflight (which strict classes exist anywhere)
  // 2. per-page filter for the classifier input
  const allYoloAnns = await db
    .select({
      name: annotations.name,
      minX: annotations.minX,
      minY: annotations.minY,
      maxX: annotations.maxX,
      maxY: annotations.maxY,
      pageNumber: annotations.pageNumber,
      data: annotations.data,
    })
    .from(annotations)
    .where(and(eq(annotations.projectId, project.id), eq(annotations.source, "yolo")));

  const preflight = validateExclusionPreflight(
    allYoloAnns.map((a) => ({ name: a.name })),
  );

  const pageAnns = allYoloAnns.filter((a) => a.pageNumber === pageNumber);

  // Load pageIntelligence for textRegions + parsedRegions + legacy table context
  const [pageRow] = await db
    .select({ pageIntelligence: pages.pageIntelligence })
    .from(pages)
    .where(and(eq(pages.projectId, project.id), eq(pages.pageNumber, pageNumber)))
    .limit(1);

  const pi = (pageRow?.pageIntelligence as PageIntelligence | null) ?? null;

  // Run the classifier on-demand
  const regions = classifyPageRegions({
    pageNumber,
    yoloAnnotations: pageAnns.map((a) => ({
      name: a.name,
      bbox: [a.minX, a.minY, a.maxX, a.maxY],
      modelName: (a.data as { modelName?: string } | null)?.modelName,
    })),
    textRegions: pi?.textRegions,
    parsedRegions: pi?.parsedRegions,
    legacyClassifiedTables: pi?.classifiedTables,
  });

  return NextResponse.json({
    pageNumber,
    preflight,
    regions,
    inputCounts: {
      yoloAnnotations: pageAnns.length,
      textRegions: pi?.textRegions?.length ?? 0,
      parsedRegions: pi?.parsedRegions?.length ?? 0,
      legacyClassifiedTables: pi?.classifiedTables?.length ?? 0,
    },
  });
}
