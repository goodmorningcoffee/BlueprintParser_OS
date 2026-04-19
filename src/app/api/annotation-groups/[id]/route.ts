import { NextResponse } from "next/server";
import { resolveProjectAccess, apiError } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { annotationGroups, annotationGroupMembers, annotations } from "@/lib/db/schema";
import { eq, inArray } from "drizzle-orm";
import { detectCsiCodes } from "@/lib/csi-detect";
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

// PUT /api/annotation-groups/[id]
// Body: { name?, csiCode?, notes?, color? }
// Updates group row. Runs auto-CSI on (name + notes) if caller didn't
// set csiCode explicitly AND text changed (detects even when the
// caller only updated notes without touching csiCode).
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const groupId = parseInt(id, 10);
  if (!Number.isInteger(groupId)) return apiError("invalid id", 400);

  const { group, error } = await loadGroupAndAuthz(groupId);
  if (error) return error;
  if (!group) return apiError("Not found", 404);

  const body = await req.json();
  const updates: Record<string, unknown> = {};

  if (body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.trim().length === 0 || body.name.length > 255) {
      return apiError("invalid name", 400);
    }
    updates.name = body.name.trim();
  }
  if (body.notes !== undefined) {
    if (body.notes !== null && typeof body.notes !== "string") {
      return apiError("invalid notes", 400);
    }
    updates.notes = body.notes;
  }
  if (body.color !== undefined) {
    if (body.color !== null && (typeof body.color !== "string" || body.color.length > 20)) {
      return apiError("invalid color", 400);
    }
    updates.color = body.color;
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") {
      return apiError("invalid isActive", 400);
    }
    updates.isActive = body.isActive;
  }
  if (body.csiCode !== undefined) {
    if (body.csiCode !== null && (typeof body.csiCode !== "string" || body.csiCode.length > 20)) {
      return apiError("invalid csiCode", 400);
    }
    updates.csiCode = body.csiCode;
  } else if (body.name !== undefined || body.notes !== undefined) {
    // Auto-CSI on text change when caller didn't explicitly set csiCode.
    // Re-derive from current-after-update (name, notes).
    const nextName = (updates.name as string | undefined) ?? group.name;
    const nextNotes = (updates.notes as string | null | undefined) ?? group.notes;
    const tagSource = `${nextName} ${nextNotes ?? ""}`.trim();
    if (tagSource) {
      const detected = detectCsiCodes(tagSource);
      if (detected.length > 0) updates.csiCode = detected[0].code;
    }
  }
  updates.updatedAt = new Date();

  try {
    const [updated] = await db
      .update(annotationGroups)
      .set(updates)
      .where(eq(annotationGroups.id, groupId))
      .returning();
    return NextResponse.json({
      group: {
        id: updated.id,
        projectId: updated.projectId,
        name: updated.name,
        csiCode: updated.csiCode,
        notes: updated.notes,
        color: updated.color,
        isActive: updated.isActive,
        createdBy: updated.createdBy,
        createdAt: updated.createdAt?.toISOString() ?? null,
        updatedAt: updated.updatedAt?.toISOString() ?? null,
      },
    });
  } catch (err) {
    logger.error("[annotation-groups/:id] Update failed:", err);
    return apiError(err instanceof Error ? err.message : "Update failed", 500);
  }
}

// DELETE /api/annotation-groups/[id]?cascade=true|false
//   cascade=false (default, dissolve): DELETE the group row. FK
//     cascade drops junction rows; annotations survive.
//   cascade=true: DELETE all member annotations first (their FK cascade
//     cleans up the junction rows), then DELETE the group row. Any
//     member annotation that ALSO belongs to other groups loses those
//     memberships too — caller UI must surface this impact before the
//     call reaches here.
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

  const url = new URL(req.url);
  const cascade = url.searchParams.get("cascade") === "true";

  try {
    if (cascade) {
      await db.transaction(async (tx) => {
        const members = await tx
          .select({ annotationId: annotationGroupMembers.annotationId })
          .from(annotationGroupMembers)
          .where(eq(annotationGroupMembers.groupId, groupId));
        const annotationIds = members.map((m) => m.annotationId);
        if (annotationIds.length > 0) {
          // Annotations must belong to the same project (enforced at
          // group-create); bound the delete by projectId as defense in depth.
          await tx
            .delete(annotations)
            .where(inArray(annotations.id, annotationIds));
        }
        await tx.delete(annotationGroups).where(eq(annotationGroups.id, groupId));
      });
      return NextResponse.json({ success: true, cascade: true });
    }

    // Dissolve — just delete the group; junction rows fall via FK cascade.
    await db.delete(annotationGroups).where(eq(annotationGroups.id, groupId));
    return NextResponse.json({ success: true, cascade: false });
  } catch (err) {
    logger.error("[annotation-groups/:id] Delete failed:", err);
    return apiError(err instanceof Error ? err.message : "Delete failed", 500);
  }
}
