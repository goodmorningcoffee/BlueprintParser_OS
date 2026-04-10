import { NextResponse } from "next/server";
import { resolveProjectAccess, apiError } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { annotations } from "@/lib/db/schema";

export async function POST(req: Request) {
  const { projectId, pageNumber, name, bbox, note, source, data } = await req.json();

  if (!projectId || !pageNumber || !name || !bbox || bbox.length !== 4) {
    return apiError("projectId, pageNumber, name, and bbox required", 400);
  }

  const [minX, minY, maxX, maxY] = bbox;
  if (
    [minX, minY, maxX, maxY].some((v) => typeof v !== "number" || v < 0 || v > 1) ||
    minX >= maxX || minY >= maxY
  ) {
    return apiError("bbox values must be 0-1 with min < max", 400);
  }

  const access = await resolveProjectAccess({ publicId: projectId });
  if (access.error) return access.error;
  const { project, session } = access;
  if (!session) return apiError("Unauthorized", 401);

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
