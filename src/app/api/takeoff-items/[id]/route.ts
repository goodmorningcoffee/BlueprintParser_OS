import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { projects, takeoffItems, annotations } from "@/lib/db/schema";
import { eq, and, sql } from "drizzle-orm";

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const itemId = parseInt(id);
  const [item] = await db
    .select()
    .from(takeoffItems)
    .where(eq(takeoffItems.id, itemId))
    .limit(1);

  if (!item) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Verify ownership
  const [project] = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.id, item.projectId),
        eq(projects.companyId, session.user.companyId)
      )
    )
    .limit(1);

  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await req.json();
  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.shape !== undefined) updates.shape = body.shape;
  if (body.color !== undefined) updates.color = body.color;
  if (body.size !== undefined) updates.size = body.size;
  if (body.notes !== undefined) updates.notes = body.notes;
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
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const itemId = parseInt(id);
  const [item] = await db
    .select()
    .from(takeoffItems)
    .where(eq(takeoffItems.id, itemId))
    .limit(1);

  if (!item) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Verify ownership
  const [project] = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.id, item.projectId),
        eq(projects.companyId, session.user.companyId)
      )
    )
    .limit(1);

  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Delete all markers for this takeoff item
  await db.execute(
    sql`DELETE FROM annotations WHERE source = 'takeoff' AND data->>'takeoffItemId' = ${String(itemId)}`
  );

  // Delete the takeoff item
  await db.delete(takeoffItems).where(eq(takeoffItems.id, itemId));

  return NextResponse.json({ success: true });
}
