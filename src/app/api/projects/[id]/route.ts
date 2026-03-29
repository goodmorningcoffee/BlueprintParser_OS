import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { projects, pages, annotations, chatMessages, processingJobs, takeoffItems } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { getS3Url, deleteProjectFiles } from "@/lib/s3";
import { audit } from "@/lib/audit";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [project] = await db
    .select()
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

  // Fetch pages with core data (explicit columns to avoid schema/migration mismatch)
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

  // Try to fetch textAnnotations separately (column may not exist if migration 0010 pending)
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

  // Try to fetch pageIntelligence separately (column may not exist if migration 0012 pending)
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

  // Fetch annotations
  const projectAnnotations = await db
    .select()
    .from(annotations)
    .where(eq(annotations.projectId, project.id));

  // Fetch takeoff items (table may not exist if migration hasn't run)
  let projectTakeoffItems: any[] = [];
  try {
    projectTakeoffItems = await db
      .select()
      .from(takeoffItems)
      .where(eq(takeoffItems.projectId, project.id))
      .orderBy(takeoffItems.sortOrder);
  } catch { /* table may not exist yet */ }

  // Fetch chat history
  const projectChats = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.projectId, project.id))
    .orderBy(chatMessages.createdAt);

  // Build PDF URL server-side (has access to CLOUDFRONT_DOMAIN / S3_BUCKET env vars)
  const pdfUrl = getS3Url(project.dataUrl, "original.pdf");

  return NextResponse.json({
    id: project.publicId,
    dbId: project.id,
    name: project.name,
    dataUrl: project.dataUrl,
    pdfUrl,
    numPages: project.numPages,
    status: project.status,
    address: project.address,
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
    takeoffItems: projectTakeoffItems.map((t) => ({
      id: t.id,
      name: t.name,
      shape: t.shape,
      color: t.color,
      sortOrder: t.sortOrder,
    })),
    chatMessages: projectChats.map((c) => ({
      id: c.id,
      role: c.role,
      content: c.content,
      model: c.model,
    })),
  });
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();

  const [project] = await db
    .select()
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

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.address !== undefined) updates.address = body.address;

  // Merge classCsiOverrides into projectIntelligence (preserving existing data)
  if (body.classCsiOverrides !== undefined) {
    const existingPi = (project.projectIntelligence as Record<string, unknown>) || {};
    updates.projectIntelligence = { ...existingPi, classCsiOverrides: body.classCsiOverrides };
  }

  updates.updatedAt = new Date();

  await db.update(projects).set(updates).where(eq(projects.id, project.id));

  return NextResponse.json({ success: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [project] = await db
    .select()
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

  // Delete S3 files (PDF, thumbnail, etc.)
  try {
    await deleteProjectFiles(project.dataUrl);
  } catch (err) {
    console.error("Failed to delete S3 files:", err);
  }

  // Delete DB records in dependency order
  await db.delete(chatMessages).where(eq(chatMessages.projectId, project.id));
  await db.delete(annotations).where(eq(annotations.projectId, project.id));
  try { await db.delete(takeoffItems).where(eq(takeoffItems.projectId, project.id)); } catch { /* table may not exist yet */ }
  await db.delete(processingJobs).where(eq(processingJobs.projectId, project.id));
  await db.delete(pages).where(eq(pages.projectId, project.id));
  await db.delete(projects).where(eq(projects.id, project.id));

  audit("project_deleted", {
    userId: session.user.dbId,
    companyId: session.user.companyId,
    details: { projectId: id, projectName: project.name },
  });

  return NextResponse.json({ success: true });
}
