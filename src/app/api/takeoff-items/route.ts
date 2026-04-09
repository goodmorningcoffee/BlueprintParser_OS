import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { projects, takeoffItems } from "@/lib/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { TAKEOFF_SHAPES, TWENTY_COLORS } from "@/types";
import { logger } from "@/lib/logger";

export async function GET(req: Request) {
  const { session, error } = await requireAuth();
  if (error) return error;

  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId");
  if (!projectId) {
    return NextResponse.json({ error: "projectId required" }, { status: 400 });
  }

  const [project] = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.publicId, projectId),
        eq(projects.companyId, session.user.companyId)
      )
    )
    .limit(1);

  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const items = await db
    .select()
    .from(takeoffItems)
    .where(eq(takeoffItems.projectId, project.id))
    .orderBy(takeoffItems.sortOrder);

  return NextResponse.json(
    items.map((t) => ({
      id: t.id,
      name: t.name,
      shape: t.shape,
      color: t.color,
      size: t.size,
      notes: t.notes,
      sortOrder: t.sortOrder,
    }))
  );
}

export async function POST(req: Request) {
  const { session, error } = await requireAuth();
  if (error) return error;

  const { projectId, name, shape, color, size, groupId } = await req.json();

  if (!projectId || !name || !shape || !color) {
    return NextResponse.json(
      { error: "projectId, name, shape, color required" },
      { status: 400 }
    );
  }

  if (shape !== "polygon" && shape !== "linear" && !TAKEOFF_SHAPES.includes(shape)) {
    return NextResponse.json({ error: "Invalid shape" }, { status: 400 });
  }

  if (groupId !== undefined && groupId !== null && !Number.isInteger(groupId)) {
    return NextResponse.json({ error: "invalid groupId" }, { status: 400 });
  }

  const [project] = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.publicId, projectId),
        eq(projects.companyId, session.user.companyId)
      )
    )
    .limit(1);

  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    // Get next sort order
    const maxResult = await db.execute(
      sql`SELECT COALESCE(MAX(sort_order), -1)::int + 1 AS next_order FROM takeoff_items WHERE project_id = ${project.id}`
    );
    const sortOrder = (maxResult.rows[0] as any)?.next_order || 0;

    const [item] = await db
      .insert(takeoffItems)
      .values({
        projectId: project.id,
        groupId: groupId || null,
        name,
        shape,
        color,
        size: size || 10,
        sortOrder,
      })
      .returning();

    return NextResponse.json({
      id: item.id,
      name: item.name,
      shape: item.shape,
      color: item.color,
      size: item.size,
      notes: item.notes,
      sortOrder: item.sortOrder,
      groupId: item.groupId,
    });
  } catch (err) {
    logger.error("Failed to create takeoff item:", err);
    const message = err instanceof Error ? err.message : "Database error";
    return NextResponse.json(
      { error: `Failed to create item: ${message}` },
      { status: 500 }
    );
  }
}
