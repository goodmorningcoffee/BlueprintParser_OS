import { NextResponse } from "next/server";
import { resolveProjectAccess, apiError } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { annotations } from "@/lib/db/schema";
import { eq, inArray, and } from "drizzle-orm";
import { logger } from "@/lib/logger";

// POST /api/annotations/batch-delete
// Body: { projectId: string, annotationIds: number[] }
// Single DELETE query scoped by projectId for tenancy. Used by the
// multi-select mass-delete path (Group tool lasso → Delete button,
// or ViewAllPanel tree checkbox → Delete). Server-side FK cascade
// cleans up annotation_group_members rows automatically.
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return apiError("Invalid JSON body", 400);

  const { projectId, annotationIds } = body as {
    projectId?: string;
    annotationIds?: unknown;
  };

  if (!projectId || typeof projectId !== "string") return apiError("projectId required", 400);
  if (!Array.isArray(annotationIds) || annotationIds.length === 0) {
    return apiError("annotationIds required (non-empty array)", 400);
  }
  if (annotationIds.some((id) => !Number.isInteger(id))) {
    return apiError("annotationIds must be integers", 400);
  }

  const access = await resolveProjectAccess({ publicId: projectId });
  if (access.error) return access.error;
  const { project } = access;

  try {
    const deleted = await db
      .delete(annotations)
      .where(and(eq(annotations.projectId, project.id), inArray(annotations.id, annotationIds as number[])))
      .returning({ id: annotations.id });

    return NextResponse.json({
      success: true,
      deletedCount: deleted.length,
      deletedIds: deleted.map((r) => r.id),
    });
  } catch (err) {
    logger.error("[annotations/batch-delete] Failed:", err);
    return apiError(err instanceof Error ? err.message : "Delete failed", 500);
  }
}
