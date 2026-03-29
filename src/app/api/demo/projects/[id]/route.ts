import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, pages, annotations } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { getS3Url } from "@/lib/s3";

// Public — no auth required, only serves demo projects
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.publicId, id), eq(projects.isDemo, true)))
    .limit(1);

  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const projectPages = await db
    .select({
      pageNumber: pages.pageNumber,
      name: pages.name,
      drawingNumber: pages.drawingNumber,
      rawText: pages.rawText,
      textractData: pages.textractData,
      keynotes: pages.keynotes,
      csiCodes: pages.csiCodes,
    })
    .from(pages)
    .where(eq(pages.projectId, project.id))
    .orderBy(pages.pageNumber);

  let textAnnotationsMap: Record<number, unknown> = {};
  try {
    const taRows = await db
      .select({ pageNumber: pages.pageNumber, textAnnotations: pages.textAnnotations })
      .from(pages)
      .where(eq(pages.projectId, project.id));
    for (const r of taRows) {
      if (r.textAnnotations) textAnnotationsMap[r.pageNumber] = r.textAnnotations;
    }
  } catch { /* migration 0010 hasn't run */ }

  let pageIntelligenceMap: Record<number, unknown> = {};
  try {
    const piRows = await db
      .select({ pageNumber: pages.pageNumber, pageIntelligence: pages.pageIntelligence })
      .from(pages)
      .where(eq(pages.projectId, project.id));
    for (const r of piRows) {
      if (r.pageIntelligence) pageIntelligenceMap[r.pageNumber] = r.pageIntelligence;
    }
  } catch { /* migration 0012 hasn't run */ }

  const projectAnnotations = await db
    .select()
    .from(annotations)
    .where(eq(annotations.projectId, project.id));

  const pdfUrl = getS3Url(project.dataUrl, "original.pdf");

  return NextResponse.json({
    id: project.publicId,
    dbId: project.id,
    name: project.name,
    dataUrl: project.dataUrl,
    pdfUrl,
    numPages: project.numPages,
    status: project.status,
    projectIntelligence: project.projectIntelligence || null,
    pages: projectPages.map((p) => ({
      pageNumber: p.pageNumber,
      name: p.name,
      drawingNumber: p.drawingNumber,
      rawText: p.rawText,
      textractData: p.textractData,
      keynotes: p.keynotes,
      csiCodes: p.csiCodes,
      textAnnotations: textAnnotationsMap[p.pageNumber] || null,
      pageIntelligence: pageIntelligenceMap[p.pageNumber] || null,
    })),
    annotations: projectAnnotations.map((a) => ({
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
