import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { annotations, projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { projectId, pageNumber, name, bbox, note, source, data } = await req.json();

  if (!projectId || !pageNumber || !name || !bbox || bbox.length !== 4) {
    return NextResponse.json(
      { error: "projectId, pageNumber, name, and bbox required" },
      { status: 400 }
    );
  }

  const [minX, minY, maxX, maxY] = bbox;
  if (
    [minX, minY, maxX, maxY].some((v) => typeof v !== "number" || v < 0 || v > 1) ||
    minX >= maxX || minY >= maxY
  ) {
    return NextResponse.json(
      { error: "bbox values must be 0-1 with min < max" },
      { status: 400 }
    );
  }

  // Verify project ownership
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

  const [annotation] = await db
    .insert(annotations)
    .values({
      name,
      minX: bbox[0],
      minY: bbox[1],
      maxX: bbox[2],
      maxY: bbox[3],
      pageNumber,
      note: note || null,
      source: source || "user",
      data: data || null,
      creatorId: session.user.dbId,
      projectId: project.id,
    })
    .returning();

  return NextResponse.json({
    id: annotation.id,
    pageNumber: annotation.pageNumber,
    name: annotation.name,
    bbox: [annotation.minX, annotation.minY, annotation.maxX, annotation.maxY],
    note: annotation.note,
    source: annotation.source,
    data: annotation.data,
  });
}
