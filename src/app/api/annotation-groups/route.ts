import { NextResponse } from "next/server";
import { resolveProjectAccess, apiError } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { annotationGroups, annotationGroupMembers, annotations } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { detectCsiCodes } from "@/lib/csi-detect";
import { TWENTY_COLORS } from "@/types";
import { logger } from "@/lib/logger";

// GET /api/annotation-groups?projectId=<publicId>
// Returns all groups for a project plus their membership rows so the
// client can hydrate the group store slice + reverse index in one round
// trip at project load.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId");
  if (!projectId) return apiError("projectId required", 400);

  const access = await resolveProjectAccess({ publicId: projectId }, { allowDemo: true });
  if (access.error) return access.error;
  const { project } = access;

  const groups = await db
    .select()
    .from(annotationGroups)
    .where(eq(annotationGroups.projectId, project.id))
    .orderBy(annotationGroups.createdAt);

  const groupIds = groups.map((g) => g.id);
  const memberships = groupIds.length
    ? await db
        .select()
        .from(annotationGroupMembers)
        .where(inArray(annotationGroupMembers.groupId, groupIds))
    : [];

  return NextResponse.json({
    groups: groups.map(toClientGroup),
    memberships: memberships.map((m) => ({
      annotationId: m.annotationId,
      groupId: m.groupId,
    })),
  });
}

// POST /api/annotation-groups
// Body: { projectId, name, csiCode?, notes?, color?, annotationIds: number[] }
// Creates a group row + junction rows in a single transaction. Runs
// auto-CSI on (name + notes) when csiCode not provided. Picks a random
// color from TWENTY_COLORS when color not provided.
export async function POST(req: Request) {
  const body = await req.json();
  const {
    projectId,
    name,
    csiCode,
    notes,
    color,
    annotationIds,
  } = body as {
    projectId: string;
    name: string;
    csiCode?: string | null;
    notes?: string | null;
    color?: string | null;
    annotationIds: number[];
  };

  if (!projectId) return apiError("projectId required", 400);
  if (typeof name !== "string" || name.trim().length === 0 || name.length > 255) {
    return apiError("invalid name", 400);
  }
  if (csiCode != null && (typeof csiCode !== "string" || csiCode.length > 20)) {
    return apiError("invalid csiCode", 400);
  }
  if (color != null && (typeof color !== "string" || color.length > 20)) {
    return apiError("invalid color", 400);
  }
  if (!Array.isArray(annotationIds) || annotationIds.length === 0) {
    return apiError("annotationIds required (non-empty array)", 400);
  }
  if (annotationIds.some((id) => !Number.isInteger(id))) {
    return apiError("annotationIds must be integers", 400);
  }

  const access = await resolveProjectAccess({ publicId: projectId });
  if (access.error) return access.error;
  const { project, session } = access;
  if (!session) return apiError("Unauthorized", 401);

  // Auto-CSI from name + notes when the caller didn't set it explicitly.
  // Manual caller value wins — we only fill the gap.
  let finalCsi: string | null = csiCode ?? null;
  if (!finalCsi) {
    const tagSource = `${name} ${notes ?? ""}`.trim();
    if (tagSource) {
      const detected = detectCsiCodes(tagSource);
      if (detected.length > 0) finalCsi = detected[0].code;
    }
  }

  const finalColor = color ?? TWENTY_COLORS[Math.floor(Math.random() * TWENTY_COLORS.length)];

  try {
    // Verify all annotationIds belong to this project — prevents a
    // caller from grouping annotations across tenancy boundaries.
    const verified = await db
      .select({ id: annotations.id })
      .from(annotations)
      .where(and(inArray(annotations.id, annotationIds), eq(annotations.projectId, project.id)));
    if (verified.length !== annotationIds.length) {
      return apiError("one or more annotationIds not found in this project", 400);
    }

    const result = await db.transaction(async (tx) => {
      const [group] = await tx
        .insert(annotationGroups)
        .values({
          projectId: project.id,
          name: name.trim(),
          csiCode: finalCsi,
          notes: notes ?? null,
          color: finalColor,
          createdBy: session.user.dbId,
        })
        .returning();

      await tx
        .insert(annotationGroupMembers)
        .values(annotationIds.map((aid) => ({ annotationId: aid, groupId: group.id })));

      return group;
    });

    return NextResponse.json({
      group: toClientGroup(result),
      memberCount: annotationIds.length,
    });
  } catch (err) {
    logger.error("[annotation-groups] Create failed:", err);
    return apiError(err instanceof Error ? err.message : "Create failed", 500);
  }
}

function toClientGroup(g: typeof annotationGroups.$inferSelect) {
  return {
    id: g.id,
    projectId: g.projectId,
    name: g.name,
    csiCode: g.csiCode,
    notes: g.notes,
    color: g.color,
    createdBy: g.createdBy,
    createdAt: g.createdAt?.toISOString() ?? null,
    updatedAt: g.updatedAt?.toISOString() ?? null,
  };
}
