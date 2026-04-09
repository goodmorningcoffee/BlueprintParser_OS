import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { projects, pages, annotations, chatMessages, processingJobs, takeoffItems, takeoffGroups, labelingSessions } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { getS3Url, deleteProjectFiles } from "@/lib/s3";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";

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
      session.user.isRootAdmin
        ? eq(projects.publicId, id)
        : and(eq(projects.publicId, id), eq(projects.companyId, session.user.companyId))
    )
    .limit(1);

  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Fetch page list, takeoff items, takeoff groups, and chat history in parallel (all independent, need only project.id)
  const [projectPages, projectTakeoffItems, projectTakeoffGroups, projectChats] = await Promise.all([
    db.select({
      pageNumber: pages.pageNumber,
      name: pages.name,
      drawingNumber: pages.drawingNumber,
    })
      .from(pages)
      .where(eq(pages.projectId, project.id))
      .orderBy(pages.pageNumber),
    db.select()
      .from(takeoffItems)
      .where(eq(takeoffItems.projectId, project.id))
      .orderBy(takeoffItems.sortOrder)
      .catch(() => [] as any[]),
    db.select()
      .from(takeoffGroups)
      .where(eq(takeoffGroups.projectId, project.id))
      .orderBy(takeoffGroups.sortOrder)
      .catch(() => [] as any[]),
    db.select()
      .from(chatMessages)
      .where(eq(chatMessages.projectId, project.id))
      .orderBy(chatMessages.createdAt),
  ]);

  // Build PDF URL server-side (has access to CLOUDFRONT_DOMAIN / S3_BUCKET env vars)
  const pdfUrl = getS3Url(project.dataUrl, "original.pdf");

  // Extract summaries + graph from projectIntelligence (computed during processing)
  const pi = project.projectIntelligence as Record<string, unknown> | null;
  const summaries = (pi?.summaries as Record<string, unknown>) || null;
  const projectIntelligence = pi || null;

  const response = NextResponse.json({
    id: project.publicId,
    dbId: project.id,
    name: project.name,
    dataUrl: project.dataUrl,
    pdfUrl,
    numPages: project.numPages,
    status: project.status,
    address: project.address,
    summaries,
    projectIntelligence,
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
      size: t.size,
      notes: t.notes,
      sortOrder: t.sortOrder,
      groupId: t.groupId,
    })),
    takeoffGroups: projectTakeoffGroups.map((g) => ({
      id: g.id,
      name: g.name,
      kind: g.kind,
      color: g.color,
      csiCode: g.csiCode,
      sortOrder: g.sortOrder,
    })),
    chatMessages: projectChats.map((c) => ({
      id: c.id,
      role: c.role,
      content: c.content,
      model: c.model,
    })),
  });
  response.headers.set("Cache-Control", "private, max-age=60");
  return response;
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
      session.user.isRootAdmin
        ? eq(projects.publicId, id)
        : and(eq(projects.publicId, id), eq(projects.companyId, session.user.companyId))
    )
    .limit(1);

  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.address !== undefined) updates.address = body.address;

  // Merge into projectIntelligence (preserving existing data)
  if (body.classCsiOverrides !== undefined || body.yoloTags !== undefined) {
    const existingPi = (project.projectIntelligence as Record<string, unknown>) || {};
    const merged = { ...existingPi };
    if (body.classCsiOverrides !== undefined) merged.classCsiOverrides = body.classCsiOverrides;
    if (body.yoloTags !== undefined) merged.yoloTags = body.yoloTags;
    updates.projectIntelligence = merged;
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
      session.user.isRootAdmin
        ? eq(projects.publicId, id)
        : and(eq(projects.publicId, id), eq(projects.companyId, session.user.companyId))
    )
    .limit(1);

  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    // Stop any running Step Functions execution for this project
    if (project.jobId && process.env.STEP_FUNCTION_ARN) {
      try {
        const { SFNClient, StopExecutionCommand } = await import("@aws-sdk/client-sfn");
        const sfn = new SFNClient({ region: process.env.AWS_REGION || "us-east-1" });
        const executionArn = `${process.env.STEP_FUNCTION_ARN.replace(":stateMachine:", ":execution:")}:${project.jobId}`;
        await sfn.send(new StopExecutionCommand({ executionArn, cause: "Project deleted by user" }));
        logger.info(`[project-delete] Stopped Step Functions execution: ${project.jobId}`);
      } catch (err) {
        logger.warn("[project-delete] Could not stop Step Functions execution:", err);
      }
    }

    // Delete S3 files (PDF, thumbnail, etc.)
    try {
      await deleteProjectFiles(project.dataUrl);
    } catch (err) {
      logger.error("[project-delete] Failed to delete S3 files:", err);
    }

    // Delete DB records in dependency order (all tables with FK to projects.id)
    await db.delete(chatMessages).where(eq(chatMessages.projectId, project.id));
    await db.delete(annotations).where(eq(annotations.projectId, project.id));
    try { await db.delete(takeoffItems).where(eq(takeoffItems.projectId, project.id)); } catch { /* table may not exist yet */ }
    try { await db.delete(takeoffGroups).where(eq(takeoffGroups.projectId, project.id)); } catch { /* table may not exist yet */ }
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
    logger.error("[project-delete] Failed to delete project", { id, err });
    return NextResponse.json({ error: err instanceof Error ? err.message : "Delete failed" }, { status: 500 });
  }
}
