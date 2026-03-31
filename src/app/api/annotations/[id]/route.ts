import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-utils";
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
  const { session, error } = await requireAuth();
  if (error) return error;

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

  // Auto-CSI-tag: detect CSI codes from note text and merge with manual codes
  let autoCsiCodes: string[] = [];
  const noteText = (body.note as string) || "";
  if (noteText.trim()) {
    const detected = detectCsiCodes(noteText);
    autoCsiCodes = detected.map((c) => c.code);
  }

  if (autoCsiCodes.length > 0 && updates.data) {
    const data = updates.data as Record<string, unknown>;
    const manualCodes = (data.csiCodes as string[]) || [];
    const merged = [...new Set([...manualCodes, ...autoCsiCodes])];
    data.csiCodes = merged;
    updates.data = data;
  }

  updates.updatedAt = new Date();

  await db.update(annotations).set(updates).where(eq(annotations.id, annotation.id));

  return NextResponse.json({ success: true, autoCsiCodes });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { session, error } = await requireAuth();
  if (error) return error;

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
