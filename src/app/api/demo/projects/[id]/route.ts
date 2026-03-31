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

  // Lightweight page list (detail data comes via /pages?from=N&to=M)
  const projectPages = await db
    .select({
      pageNumber: pages.pageNumber,
      name: pages.name,
      drawingNumber: pages.drawingNumber,
    })
    .from(pages)
    .where(eq(pages.projectId, project.id))
    .orderBy(pages.pageNumber);

  const pdfUrl = getS3Url(project.dataUrl, "original.pdf");

  const pi = project.projectIntelligence as Record<string, unknown> | null;
  const summaries = (pi?.summaries as Record<string, unknown>) || null;

  return NextResponse.json({
    id: project.publicId,
    dbId: project.id,
    name: project.name,
    dataUrl: project.dataUrl,
    pdfUrl,
    numPages: project.numPages,
    status: project.status,
    summaries,
    projectIntelligence: pi || null,
    pages: projectPages.map((p) => ({
      pageNumber: p.pageNumber,
      name: p.name,
      drawingNumber: p.drawingNumber,
    })),
  });
}
