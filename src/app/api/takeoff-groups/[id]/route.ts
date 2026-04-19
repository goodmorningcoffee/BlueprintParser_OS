import { NextResponse } from "next/server";
import { resolveProjectAccess } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { takeoffGroups } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { detectCsiCodes } from "@/lib/csi-detect";
import { logger } from "@/lib/logger";

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const groupId = parseInt(id, 10);
  if (!Number.isInteger(groupId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const [group] = await db
    .select()
    .from(takeoffGroups)
    .where(eq(takeoffGroups.id, groupId))
    .limit(1);

  if (!group) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const access = await resolveProjectAccess({ dbId: group.projectId });
  if (access.error) return access.error;

  const body = await req.json();
  const updates: Record<string, unknown> = {};

  if (body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.trim().length === 0 || body.name.length > 255) {
      return NextResponse.json({ error: "invalid name" }, { status: 400 });
    }
    updates.name = body.name.trim();
  }
  if (body.color !== undefined) {
    if (body.color !== null && (typeof body.color !== "string" || body.color.length > 20)) {
      return NextResponse.json({ error: "invalid color" }, { status: 400 });
    }
    updates.color = body.color;
  }
  if (body.csiCode !== undefined) {
    if (body.csiCode !== null && (typeof body.csiCode !== "string" || body.csiCode.length > 20)) {
      return NextResponse.json({ error: "invalid csiCode" }, { status: 400 });
    }
    updates.csiCode = body.csiCode;
  } else if (
    // Fill-when-empty: only auto-detect if the user didn't explicitly
    // set a code, the current record has none, and the rename might
    // contain a CSI hint. Never overwrites a curated code.
    group.csiCode === null &&
    typeof updates.name === "string"
  ) {
    const detected = detectCsiCodes(updates.name as string);
    if (detected.length > 0) updates.csiCode = detected[0].code;
  }
  if (body.sortOrder !== undefined) {
    if (!Number.isInteger(body.sortOrder)) {
      return NextResponse.json({ error: "invalid sortOrder" }, { status: 400 });
    }
    updates.sortOrder = body.sortOrder;
  }
  updates.updatedAt = new Date();

  try {
    const [updated] = await db
      .update(takeoffGroups)
      .set(updates)
      .where(eq(takeoffGroups.id, groupId))
      .returning();
    return NextResponse.json({
      id: updated.id,
      name: updated.name,
      kind: updated.kind,
      color: updated.color,
      csiCode: updated.csiCode,
      sortOrder: updated.sortOrder,
    });
  } catch (err) {
    logger.error("[takeoff-groups] Update failed:", err);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const groupId = parseInt(id, 10);
  if (!Number.isInteger(groupId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const [group] = await db
    .select()
    .from(takeoffGroups)
    .where(eq(takeoffGroups.id, groupId))
    .limit(1);

  if (!group) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const access = await resolveProjectAccess({ dbId: group.projectId });
  if (access.error) return access.error;

  // FK ON DELETE SET NULL on takeoff_items.group_id orphans items automatically
  await db.delete(takeoffGroups).where(eq(takeoffGroups.id, groupId));

  return NextResponse.json({ success: true });
}
