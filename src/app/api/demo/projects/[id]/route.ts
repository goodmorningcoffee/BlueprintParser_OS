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
    .select()
    .from(pages)
    .where(eq(pages.projectId, project.id))
    .orderBy(pages.pageNumber);

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
    pages: projectPages.map((p) => ({
      pageNumber: p.pageNumber,
      name: p.name,
      drawingNumber: p.drawingNumber,
      rawText: p.rawText,
      textractData: p.textractData,
      keynotes: p.keynotes,
      csiCodes: p.csiCodes,
    })),
    annotations: projectAnnotations.map((a) => ({
      id: a.id,
      pageNumber: a.pageNumber,
      name: a.name,
      bbox: [a.minX, a.minY, a.maxX, a.maxY],
      note: a.note,
      source: a.source,
    })),
  });
}
