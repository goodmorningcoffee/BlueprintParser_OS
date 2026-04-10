import { NextResponse } from "next/server";
import { resolveProjectAccess } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { takeoffItems, annotations } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const itemId = parseInt(id);
  const [item] = await db
    .select()
    .from(takeoffItems)
    .where(eq(takeoffItems.id, itemId))
    .limit(1);

  if (!item) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const access = await resolveProjectAccess({ dbId: item.projectId });
  if (access.error) return access.error;

  const body = await req.json();
  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.shape !== undefined) updates.shape = body.shape;
  if (body.color !== undefined) updates.color = body.color;
  if (body.size !== undefined) updates.size = body.size;
  if (body.notes !== undefined) updates.notes = body.notes;
  if (body.groupId !== undefined) {
    if (body.groupId !== null && !Number.isInteger(body.groupId)) {
      return NextResponse.json({ error: "invalid groupId" }, { status: 400 });
    }
    updates.groupId = body.groupId;
  }
  updates.updatedAt = new Date();

  await db.update(takeoffItems).set(updates).where(eq(takeoffItems.id, itemId));

  // Sync annotation names if renamed
  if (body.name !== undefined && body.name !== item.name) {
    await db.execute(
      sql`UPDATE annotations SET name = ${body.name} WHERE source = 'takeoff' AND data->>'takeoffItemId' = ${String(itemId)}`
    );
  }

  return NextResponse.json({ success: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const itemId = parseInt(id);
  const [item] = await db
    .select()
    .from(takeoffItems)
    .where(eq(takeoffItems.id, itemId))
    .limit(1);

  if (!item) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const access = await resolveProjectAccess({ dbId: item.projectId });
  if (access.error) return access.error;

  // Delete all markers for this takeoff item
  await db.execute(
    sql`DELETE FROM annotations WHERE source = 'takeoff' AND data->>'takeoffItemId' = ${String(itemId)}`
  );

  // Delete the takeoff item
  await db.delete(takeoffItems).where(eq(takeoffItems.id, itemId));

  return NextResponse.json({ success: true });
}
