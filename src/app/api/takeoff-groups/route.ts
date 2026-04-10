import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { projects, takeoffGroups } from "@/lib/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { logger } from "@/lib/logger";

const VALID_KINDS = ["count", "area", "linear"] as const;

export async function GET(req: Request) {
  const { session, error } = await requireAuth();
  if (error) return error;

  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId");
  if (!projectId) {
    return NextResponse.json({ error: "projectId required" }, { status: 400 });
  }

  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.publicId, projectId), eq(projects.companyId, session.user.companyId)))
    .limit(1);

  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const groups = await db
    .select()
    .from(takeoffGroups)
    .where(eq(takeoffGroups.projectId, project.id))
    .orderBy(takeoffGroups.sortOrder);

  return NextResponse.json(
    groups.map((g) => ({
      id: g.id,
      name: g.name,
      kind: g.kind,
      color: g.color,
      csiCode: g.csiCode,
      sortOrder: g.sortOrder,
    }))
  );
}

export async function POST(req: Request) {
  const { session, error } = await requireAuth();
  if (error) return error;

  const { projectId, name, kind, color, csiCode } = await req.json();

  if (!projectId || !name || !kind) {
    return NextResponse.json({ error: "projectId, name, kind required" }, { status: 400 });
  }
  if (typeof name !== "string" || name.trim().length === 0 || name.length > 255) {
    return NextResponse.json({ error: "invalid name" }, { status: 400 });
  }
  if (!VALID_KINDS.includes(kind)) {
    return NextResponse.json({ error: "invalid kind" }, { status: 400 });
  }
  if (color !== undefined && color !== null && (typeof color !== "string" || color.length > 20)) {
    return NextResponse.json({ error: "invalid color" }, { status: 400 });
  }
  if (csiCode !== undefined && csiCode !== null && (typeof csiCode !== "string" || csiCode.length > 20)) {
    return NextResponse.json({ error: "invalid csiCode" }, { status: 400 });
  }

  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.publicId, projectId), eq(projects.companyId, session.user.companyId)))
    .limit(1);

  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    // Next sort order scoped to (projectId, kind)
    const maxResult = await db.execute(
      sql`SELECT COALESCE(MAX(sort_order), -1)::int + 1 AS next_order
          FROM takeoff_groups
          WHERE project_id = ${project.id} AND kind = ${kind}`
    );
    const sortOrder = (maxResult.rows[0] as { next_order: number })?.next_order ?? 0;

    const [group] = await db
      .insert(takeoffGroups)
      .values({
        projectId: project.id,
        name: name.trim(),
        kind,
        color: color ?? null,
        csiCode: csiCode ?? null,
        sortOrder,
      })
      .returning();

    return NextResponse.json({
      id: group.id,
      name: group.name,
      kind: group.kind,
      color: group.color,
      csiCode: group.csiCode,
      sortOrder: group.sortOrder,
    });
  } catch (err) {
    const cause = (err as { cause?: { message?: string; detail?: string; code?: string } })?.cause;
    const pgMessage = cause?.message || cause?.detail || (err instanceof Error ? err.message : "Database error");
    const pgCode = cause?.code;
    logger.error("[takeoff-groups] Create failed:", { err, cause, pgCode, pgMessage });
    return NextResponse.json({
      error: `Failed to create group: ${pgMessage}${pgCode ? ` (${pgCode})` : ""}`,
    }, { status: 500 });
  }
}
