import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { projects, pages, annotations, chatMessages, processingJobs, takeoffItems, labelingSessions } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { getS3Url, deleteProjectFiles } from "@/lib/s3";
import { audit } from "@/lib/audit";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { session, error } = await requireAuth();
  if (error) return error;

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

  // Fetch lightweight page list (names only — detail data comes via /pages?from=N&to=M)
  const projectPages = await db
    .select({
      pageNumber: pages.pageNumber,
      name: pages.name,
      drawingNumber: pages.drawingNumber,
    })
    .from(pages)
    .where(eq(pages.projectId, project.id))
    .orderBy(pages.pageNumber);

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

  // Extract summaries from projectIntelligence (computed during processing)
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
    address: project.address,
    projectIntelligence: project.projectIntelligence || null,
    summaries,
    pages: projectPages.map((p) => ({
      pageNumber: p.pageNumber,
      name: p.name,
      drawingNumber: p.drawingNumber,
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
  const { session, error } = await requireAuth();
  if (error) return error;

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
  const { session, error } = await requireAuth();
  if (error) return error;

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

  try {
    // Delete S3 files (PDF, thumbnail, etc.)
    try {
      await deleteProjectFiles(project.dataUrl);
    } catch (err) {
      console.error("[project-delete] Failed to delete S3 files:", err);
    }

    // Delete DB records in dependency order (all tables with FK to projects.id)
    await db.delete(chatMessages).where(eq(chatMessages.projectId, project.id));
    await db.delete(annotations).where(eq(annotations.projectId, project.id));
    try { await db.delete(takeoffItems).where(eq(takeoffItems.projectId, project.id)); } catch { /* table may not exist yet */ }
    try { await db.delete(labelingSessions).where(eq(labelingSessions.projectId, project.id)); } catch { /* table may not exist yet */ }
    await db.delete(processingJobs).where(eq(processingJobs.projectId, project.id));
    await db.delete(pages).where(eq(pages.projectId, project.id));
    await db.delete(projects).where(eq(projects.id, project.id));

    audit("project_deleted", {
      userId: session.user.dbId,
      companyId: session.user.companyId,
      details: { projectId: id, projectName: project.name },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[project-delete] Failed to delete project:", id, err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Delete failed" }, { status: 500 });
  }
}
