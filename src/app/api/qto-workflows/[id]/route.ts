import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { projects, qtoWorkflows } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { logger } from "@/lib/logger";

/** GET /api/qto-workflows/[id] — get a workflow */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { session, error } = await requireAuth();
  if (error) return error;

  const [workflow] = await db
    .select()
    .from(qtoWorkflows)
    .where(eq(qtoWorkflows.id, Number(id)))
    .limit(1);

  if (!workflow) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Verify company access
  const [project] = await db
    .select({ companyId: projects.companyId })
    .from(projects)
    .where(eq(projects.id, workflow.projectId))
    .limit(1);

  if (!project || project.companyId !== session.user.companyId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(workflow);
}

/** PUT /api/qto-workflows/[id] — update a workflow */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { session, error } = await requireAuth();
  if (error) return error;

  const [workflow] = await db
    .select()
    .from(qtoWorkflows)
    .where(eq(qtoWorkflows.id, Number(id)))
    .limit(1);

  if (!workflow) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const [project] = await db
    .select({ companyId: projects.companyId })
    .from(projects)
    .where(eq(projects.id, workflow.projectId))
    .limit(1);

  if (!project || project.companyId !== session.user.companyId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await req.json();
  const updates: Record<string, unknown> = {};

  if (body.step !== undefined) updates.step = body.step;
  if (body.schedulePageNumber !== undefined) updates.schedulePageNumber = body.schedulePageNumber;
  if (body.parsedSchedule !== undefined) updates.parsedSchedule = body.parsedSchedule;
  if (body.lineItems !== undefined) updates.lineItems = body.lineItems;
  if (body.userEdits !== undefined) updates.userEdits = body.userEdits;
  if (body.yoloModelFilter !== undefined) updates.yoloModelFilter = body.yoloModelFilter;
  if (body.yoloClassFilter !== undefined) updates.yoloClassFilter = body.yoloClassFilter;
  if (body.tagPattern !== undefined) updates.tagPattern = body.tagPattern;
  if (body.materialLabel !== undefined) updates.materialLabel = body.materialLabel;
  if (body.exportedAt !== undefined) updates.exportedAt = body.exportedAt;

  updates.updatedAt = new Date();

  try {
    const [updated] = await db
      .update(qtoWorkflows)
      .set(updates)
      .where(eq(qtoWorkflows.id, Number(id)))
      .returning();

    return NextResponse.json(updated);
  } catch (err) {
    logger.error("[qto-workflows] Update failed:", err);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
}

/** DELETE /api/qto-workflows/[id] — delete a workflow */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { session, error } = await requireAuth();
  if (error) return error;

  const [workflow] = await db
    .select()
    .from(qtoWorkflows)
    .where(eq(qtoWorkflows.id, Number(id)))
    .limit(1);

  if (!workflow) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const [project] = await db
    .select({ companyId: projects.companyId })
    .from(projects)
    .where(eq(projects.id, workflow.projectId))
    .limit(1);

  if (!project || project.companyId !== session.user.companyId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await db.delete(qtoWorkflows).where(eq(qtoWorkflows.id, Number(id)));

  return NextResponse.json({ success: true });
}
