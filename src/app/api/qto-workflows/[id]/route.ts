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

  const VALID_STEPS = ["pick", "select-schedule", "confirm-tags", "map-tags", "review", "done"];
  const MAX_JSONB_BYTES = 1_048_576; // 1 MB
  const MAX_STRING_LEN = 1024;

  if (body.step !== undefined) {
    if (typeof body.step !== "string" || !VALID_STEPS.includes(body.step)) {
      return NextResponse.json({ error: "invalid step" }, { status: 400 });
    }
    updates.step = body.step;
  }
  if (body.schedulePageNumber !== undefined) {
    if (body.schedulePageNumber !== null && (!Number.isInteger(body.schedulePageNumber) || body.schedulePageNumber < 1)) {
      return NextResponse.json({ error: "invalid schedulePageNumber" }, { status: 400 });
    }
    updates.schedulePageNumber = body.schedulePageNumber;
  }
  for (const key of ["parsedSchedule", "lineItems", "userEdits"] as const) {
    if (body[key] !== undefined) {
      if (body[key] !== null && JSON.stringify(body[key]).length > MAX_JSONB_BYTES) {
        return NextResponse.json({ error: `${key} exceeds 1MB limit` }, { status: 400 });
      }
      updates[key] = body[key];
    }
  }
  for (const key of ["yoloModelFilter", "yoloClassFilter", "tagPattern", "materialLabel"] as const) {
    if (body[key] !== undefined) {
      if (body[key] !== null && (typeof body[key] !== "string" || body[key].length > MAX_STRING_LEN)) {
        return NextResponse.json({ error: `invalid ${key}` }, { status: 400 });
      }
      updates[key] = body[key];
    }
  }
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
