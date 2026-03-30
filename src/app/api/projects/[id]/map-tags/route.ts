import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { projects, pages, annotations } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { mapYoloToOcrText } from "@/lib/yolo-tag-engine";
import type { ClientAnnotation, TextractPageData } from "@/types";

/**
 * POST /api/projects/[id]/map-tags
 *
 * Server-side tag mapping. Runs mapYoloToOcrText with project-scope access
 * to all annotations and textract data in the DB. This moves the O(N*M)
 * computation off the browser, enabling chunked page loading.
 *
 * Body: { tagText, yoloClass?, yoloModel?, scope: "project"|"page", pageNumber? }
 * Returns: { instances: YoloTagInstance[] }
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { session, error } = await requireAuth();
  if (error) return error;

  const body = await req.json();
  const { tagText, yoloClass, yoloModel, scope, pageNumber } = body;

  if (!tagText || typeof tagText !== "string") {
    return NextResponse.json({ error: "tagText required" }, { status: 400 });
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

  // Fetch all annotations for this project
  const allAnnotations = await db
    .select({
      id: annotations.id,
      pageNumber: annotations.pageNumber,
      name: annotations.name,
      minX: annotations.minX,
      minY: annotations.minY,
      maxX: annotations.maxX,
      maxY: annotations.maxY,
      note: annotations.note,
      source: annotations.source,
      data: annotations.data,
    })
    .from(annotations)
    .where(eq(annotations.projectId, project.id));

  const clientAnnotations: ClientAnnotation[] = allAnnotations.map((a) => ({
    id: a.id,
    pageNumber: a.pageNumber,
    name: a.name,
    bbox: [a.minX, a.minY, a.maxX, a.maxY] as [number, number, number, number],
    note: a.note,
    source: a.source,
    data: a.data as Record<string, unknown> | null,
  }));

  // Fetch textract data for relevant pages
  // For project scope: all pages. For page scope: just that page.
  const textractQuery = scope === "page" && pageNumber != null
    ? db
        .select({ pageNumber: pages.pageNumber, textractData: pages.textractData })
        .from(pages)
        .where(and(eq(pages.projectId, project.id), eq(pages.pageNumber, pageNumber)))
    : db
        .select({ pageNumber: pages.pageNumber, textractData: pages.textractData })
        .from(pages)
        .where(eq(pages.projectId, project.id));

  const pageRows = await textractQuery;
  const textractMap: Record<number, TextractPageData> = {};
  for (const row of pageRows) {
    if (row.textractData) {
      textractMap[row.pageNumber] = row.textractData as TextractPageData;
    }
  }

  // Run the tag engine server-side
  const instances = mapYoloToOcrText({
    tagText,
    yoloClass: yoloClass || undefined,
    yoloModel: yoloModel || undefined,
    scope: scope || "project",
    pageNumber: pageNumber || undefined,
    annotations: clientAnnotations,
    textractData: textractMap,
  });

  return NextResponse.json({ instances });
}
