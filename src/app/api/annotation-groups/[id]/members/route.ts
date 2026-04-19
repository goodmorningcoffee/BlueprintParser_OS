import { NextResponse } from "next/server";
import { resolveProjectAccess, apiError } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { annotationGroups, annotationGroupMembers, annotations } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { logger } from "@/lib/logger";

async function loadGroupAndAuthz(groupId: number) {
  const [group] = await db
    .select()
    .from(annotationGroups)
    .where(eq(annotationGroups.id, groupId))
    .limit(1);
  if (!group) return { group: null, error: apiError("Not found", 404) };

  const access = await resolveProjectAccess({ dbId: group.projectId });
  if (access.error) return { group: null, error: access.error };
  return { group, error: null };
}

function validateBody(body: unknown): { annotationIds: number[] } | null {
  if (!body || typeof body !== "object") return null;
  const ids = (body as { annotationIds?: unknown }).annotationIds;
  if (!Array.isArray(ids) || ids.length === 0) return null;
  if (ids.some((id) => !Number.isInteger(id))) return null;
  return { annotationIds: ids as number[] };
}

// POST /api/annotation-groups/[id]/members
// Body: { annotationIds: number[] }
// Bulk-adds annotations to an existing group. M:N allows the same
// annotation to belong to multiple groups; this endpoint upserts (ON
// CONFLICT DO NOTHING) so repeated adds are safe.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const groupId = parseInt(id, 10);
  if (!Number.isInteger(groupId)) return apiError("invalid id", 400);

  const { group, error } = await loadGroupAndAuthz(groupId);
  if (error) return error;
  if (!group) return apiError("Not found", 404);

  const body = await req.json().catch(() => null);
  const parsed = validateBody(body);
  if (!parsed) return apiError("annotationIds required (non-empty integer array)", 400);

  try {
    // Verify tenancy — every annotationId must belong to the same project
    // as the group. Prevents cross-project grouping attacks.
    const verified = await db
      .select({ id: annotations.id })
      .from(annotations)
      .where(and(inArray(annotations.id, parsed.annotationIds), eq(annotations.projectId, group.projectId)));
    if (verified.length !== parsed.annotationIds.length) {
      return apiError("one or more annotationIds not found in this project", 400);
    }

    await db
      .insert(annotationGroupMembers)
      .values(parsed.annotationIds.map((aid) => ({ annotationId: aid, groupId })))
      .onConflictDoNothing();

    return NextResponse.json({ success: true, addedCount: parsed.annotationIds.length });
  } catch (err) {
    logger.error("[annotation-groups/:id/members] Add failed:", err);
    return apiError(err instanceof Error ? err.message : "Add failed", 500);
  }
}

// DELETE /api/annotation-groups/[id]/members
// Body: { annotationIds: number[] }
// Bulk-removes membership rows. Annotations themselves are unaffected.
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const groupId = parseInt(id, 10);
  if (!Number.isInteger(groupId)) return apiError("invalid id", 400);

  const { group, error } = await loadGroupAndAuthz(groupId);
  if (error) return error;
  if (!group) return apiError("Not found", 404);

  const body = await req.json().catch(() => null);
  const parsed = validateBody(body);
  if (!parsed) return apiError("annotationIds required (non-empty integer array)", 400);

  try {
    await db
      .delete(annotationGroupMembers)
      .where(
        and(
          eq(annotationGroupMembers.groupId, groupId),
          inArray(annotationGroupMembers.annotationId, parsed.annotationIds),
        ),
      );
    return NextResponse.json({ success: true, removedCount: parsed.annotationIds.length });
  } catch (err) {
    logger.error("[annotation-groups/:id/members] Remove failed:", err);
    return apiError(err instanceof Error ? err.message : "Remove failed", 500);
  }
}
