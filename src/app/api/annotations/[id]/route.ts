import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { annotations, projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { detectCsiCodes } from "@/lib/csi-detect";

async function verifyAnnotationOwnership(annotationId: number, companyId: number) {
  const [annotation] = await db
    .select()
    .from(annotations)
    .where(eq(annotations.id, annotationId))
    .limit(1);

  if (!annotation) return null;

  const [project] = await db
    .select()
    .from(projects)
    .where(
      and(eq(projects.id, annotation.projectId), eq(projects.companyId, companyId))
    )
    .limit(1);

  if (!project) return null;
  return annotation;
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

  const annotation = await verifyAnnotationOwnership(
    parseInt(id),
    session.user.companyId
  );
  if (!annotation) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await req.json();
  const updates: Record<string, unknown> = {};

  if (body.name !== undefined) updates.name = body.name;
  if (body.note !== undefined) updates.note = body.note;
  if (body.data !== undefined) updates.data = body.data;
  if (body.bbox) {
    updates.minX = body.bbox[0];
    updates.minY = body.bbox[1];
    updates.maxX = body.bbox[2];
    updates.maxY = body.bbox[3];
  }
  updates.updatedAt = new Date();

  await db.update(annotations).set(updates).where(eq(annotations.id, annotation.id));

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

  const annotation = await verifyAnnotationOwnership(
    parseInt(id),
    session.user.companyId
  );
  if (!annotation) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await db.delete(annotations).where(eq(annotations.id, annotation.id));

  return NextResponse.json({ success: true });
}
