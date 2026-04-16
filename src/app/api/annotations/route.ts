import { NextResponse } from "next/server";
import { resolveProjectAccess, apiError } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { annotations } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import type { ClientAnnotation } from "@/types";

interface AnnotationInput {
  pageNumber: number;
  name: string;
  bbox: [number, number, number, number];
  note?: string;
  source?: string;
  data?: Record<string, unknown>;
  threshold?: number;
}

function validateBbox(bbox: number[]): string | null {
  if (!bbox || bbox.length !== 4) return "bbox must be [minX, minY, maxX, maxY]";
  const [minX, minY, maxX, maxY] = bbox;
  if ([minX, minY, maxX, maxY].some((v) => typeof v !== "number" || v < 0 || v > 1)) return "bbox values must be 0-1";
  if (minX >= maxX || minY >= maxY) return "bbox min must be less than max";
  return null;
}

function toClientAnnotation(a: typeof annotations.$inferSelect): ClientAnnotation {
  return {
    id: a.id,
    pageNumber: a.pageNumber,
    name: a.name,
    bbox: [a.minX, a.minY, a.maxX, a.maxY],
    note: a.note,
    source: a.source as ClientAnnotation["source"],
    data: a.data ?? null,
  };
}

export async function POST(req: Request) {
  const body = await req.json();

  // Batch mode: { projectId, annotations: [...], deleteSource?, deletePageNumbers? }
  if (body.annotations && Array.isArray(body.annotations)) {
    const { projectId, deleteSource, deletePageNumbers } = body as {
      projectId: string;
      annotations: AnnotationInput[];
      deleteSource?: string;
      deletePageNumbers?: number[];
    };

    if (!projectId) return apiError("projectId required", 400);

    const access = await resolveProjectAccess({ publicId: projectId });
    if (access.error) return access.error;
    const { project, session } = access;
    if (!session) return apiError("Unauthorized", 401);

    for (const ann of body.annotations) {
      const err = validateBbox(ann.bbox);
      if (err) return apiError(`Invalid annotation: ${err}`, 400);
    }

    // Delete-before-insert: remove existing annotations for this source+pages
    if (deleteSource && deletePageNumbers?.length) {
      for (const pn of deletePageNumbers) {
        await db.delete(annotations).where(
          and(
            eq(annotations.projectId, project.id),
            eq(annotations.source, deleteSource),
            eq(annotations.pageNumber, pn),
          )
        );
      }
    }

    const inserted = await db.insert(annotations).values(
      body.annotations.map((ann: AnnotationInput) => ({
        name: ann.name,
        minX: ann.bbox[0],
        minY: ann.bbox[1],
        maxX: ann.bbox[2],
        maxY: ann.bbox[3],
        pageNumber: ann.pageNumber,
        threshold: ann.threshold ?? null,
        note: ann.note || null,
        source: ann.source || "user",
        data: ann.data || null,
        creatorId: session.user.dbId,
        projectId: project.id,
      }))
    ).returning();

    return NextResponse.json({
      count: inserted.length,
      annotations: inserted.map(toClientAnnotation),
    });
  }

  // Single-record mode (backward compatible)
  const { projectId, pageNumber, name, bbox, note, source, data } = body;

  if (!projectId || !pageNumber || !name || !bbox || bbox.length !== 4) {
    return apiError("projectId, pageNumber, name, and bbox required", 400);
  }

  const bboxErr = validateBbox(bbox);
  if (bboxErr) return apiError(bboxErr, 400);

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

  return NextResponse.json(toClientAnnotation(annotation));
}
