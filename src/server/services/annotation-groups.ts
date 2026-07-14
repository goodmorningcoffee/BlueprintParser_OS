// [refactor jun17 P1.3] Annotation-groups service — P1.3 core family 2/7.
//
// The three annotation-group route files (annotation-groups[/route], [id], [id]/members) are
// now thin `defineRoute` shells; ALL behavior lives here. Behavior is preserved EXACTLY against
// the P0.3 characterization tests (annotation-groups.route.test.ts) + the new [id]/members char
// file added with this migration. The ONE sanctioned diff is the error envelope ({error:string}
// → {error:{code,message}}, handled by the shell).
//
// Recipe applied (S008 §B / annotations precedent S009): every route is auth:"none" +
// service-resolved access, because each shape conflicts with the shell's declarative
// auth-before-validate phase:
//   • GET: unauthenticated-demo READ (allowDemo:true) keyed off a QUERY param — the shell's
//     declarative project-auth reads ids from URL params / body, not the query string, so the
//     service resolves access (with allowDemo) after the shell validates the query.
//   • POST (create): validate-before-auth — name/csiCode/color/annotationIds 400 BEFORE the 401.
//   • [id] PUT/DELETE + [id]/members POST/DELETE: indirect lookup — the group is fetched by URL
//     id (404 if missing), then access is checked on its PARENT project.
//
// Frozen quirks deliberately kept (do NOT "fix" them here):
//   • WRITES never allow demo: create resolves WITHOUT allowDemo; [id]/members resolve the
//     parent project WITHOUT allowDemo. Only GET passes allowDemo:true. (An owning-company
//     member can still write to their own demo project, treated as a normal company project.)
//   • [id] parses with parseInt(id, 10) + Number.isInteger guard → a non-numeric id is a clean
//     400 "invalid id" (NOT the 500 the annotations/[id] family produces — that family used
//     parseInt with no radix + no guard; this one is stricter. Preserve the difference.)
//   • POST create: csiCode is auto-filled from `${name} ${notes}` ONLY when the caller omitted
//     it (manual value wins); color is a random TWENTY_COLORS pick when omitted.
//   • PUT: auto-CSI re-derives from the post-update (name, notes) ONLY when the caller didn't
//     set csiCode AND touched name or notes; PUT does NOT validate any bbox (groups have none).
//   • DELETE cascade=true deletes member annotations (their FK cascade clears junction rows)
//     THEN the group; cascade=false (default) deletes only the group (junctions fall via FK).
//   • tenancy: every annotationId in create / members-add must belong to the group's project
//     → else 400 "one or more annotationIds not found in this project", nothing written.
//
// Leak fix (sanctioned, annotations precedent): the legacy routes' catch blocks returned
// `apiError(err.message, 500)` — a raw-pg leak. Those try/catches are DROPPED here; any
// unexpected db error propagates to the shell's outer catch, which logs server-side and
// returns the generic leak-free 500. Happy-path behavior is identical.

import { db } from "@/lib/db";
import { annotationGroups, annotationGroupMembers, annotations } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { detectCsiCodes } from "@/lib/csi-detect";
// [refactor jul9 P2-A C1] company CSI context resolver (config + custom DB), threaded into
// the auto-CSI detect in create/update below (D-1/D-2).
import { getCompanyCsiContext } from "@/lib/csi-company-db";
import { TWENTY_COLORS } from "@/types";
import { ApiError } from "@/server/api/envelope";
import {
  resolveByPublicId,
  resolveProjectOrThrow,
  resolveWritableProjectOrThrow,
} from "@/server/api/access";
import {
  assertProjectWritable,
  withProjectWrite,
} from "@/server/api/project-write-capability";

function toClientGroup(g: typeof annotationGroups.$inferSelect) {
  return {
    id: g.id,
    projectId: g.projectId,
    name: g.name,
    csiCode: g.csiCode,
    notes: g.notes,
    color: g.color,
    isActive: g.isActive,
    createdBy: g.createdBy,
    createdAt: g.createdAt?.toISOString() ?? null,
    updatedAt: g.updatedAt?.toISOString() ?? null,
  };
}

// [refactor jul8 P1-review PR-C1] the local resolveByPublicId (validate-before-auth, NO
// allowDemo — writes never allow demo) was hoisted byte-identical to server/api/access.ts. The
// call site here passes NO opts on purpose — undefined ≡ allowDemo:false (api-utils gates on
// `options?.allowDemo`), preserving the old no-opts body exactly. The zPublicId guard (non-uuid
// id → clean 400, not the legacy pg-uuid-cast 500) still sits AFTER field validation, keeping
// the frozen error precedence.

/** Indirect lookup: parse the URL id (non-numeric → clean 400, preserving this family's
 *  stricter behavior), fetch the group (404 if missing), resolve access on its parent project
 *  (NO allowDemo). Returns the group row. */
async function loadGroupAndAuthz(idParam: string) {
  const groupId = parseInt(idParam, 10);
  if (!Number.isInteger(groupId)) throw new ApiError("VALIDATION", "invalid id");

  const [group] = await db
    .select()
    .from(annotationGroups)
    .where(eq(annotationGroups.id, groupId))
    .limit(1);
  if (!group) throw new ApiError("NOT_FOUND", "Not found");

  // [refactor jul9 P2-A C1] keep the resolved project (was discarded) so
  // updateAnnotationGroup can derive companyId for the CSI resolver. Access
  // check is byte-identical; other callers just destructure { group }.
  const { project, writeCapability } = await resolveWritableProjectOrThrow({ dbId: group.projectId });
  return { group, project, writeCapability };
}

/** Narrow + validate an `annotationIds` body into a non-empty integer array (frozen message). */
function parseAnnotationIds(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ApiError("VALIDATION", "annotationIds required (non-empty integer array)");
  }
  if (value.some((id) => !Number.isInteger(id))) {
    throw new ApiError("VALIDATION", "annotationIds required (non-empty integer array)");
  }
  return value as number[];
}

// ── GET /api/annotation-groups?projectId=<publicId> ──────────────────────────────
//
/** Returns all groups for a project + their membership rows so the client hydrates the group
 *  slice + reverse index in one round trip. allowDemo:true → unauthenticated demo reads work. */
export async function getAnnotationGroups(projectId: string) {
  const { project } = await resolveProjectOrThrow({ publicId: projectId }, { allowDemo: true });
  if (project.isDemo) return redactPublicDemoGroups();

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

  return {
    groups: groups.map(toClientGroup),
    memberships: memberships.map((m) => ({
      annotationId: m.annotationId,
      groupId: m.groupId,
    })),
  };
}

function redactPublicDemoGroups() {
  return { groups: [], memberships: [] };
}

// ── POST /api/annotation-groups ──────────────────────────────────────────────────
//
/** Create a group row + junction rows in ONE transaction. Order (frozen): field validation →
 *  AUTH → tenancy verify → tx insert. Auto-CSI from (name + notes) when csiCode omitted. */
export async function createAnnotationGroup(body: Record<string, unknown>) {
  const { projectId, name, csiCode, notes, color, annotationIds } = body as {
    projectId?: string;
    name?: string;
    csiCode?: string | null;
    notes?: string | null;
    color?: string | null;
    annotationIds?: number[];
  };

  if (!projectId) throw new ApiError("VALIDATION", "projectId required");
  if (typeof name !== "string" || name.trim().length === 0 || name.length > 255) {
    throw new ApiError("VALIDATION", "invalid name");
  }
  if (csiCode != null && (typeof csiCode !== "string" || csiCode.length > 20)) {
    throw new ApiError("VALIDATION", "invalid csiCode");
  }
  if (color != null && (typeof color !== "string" || color.length > 20)) {
    throw new ApiError("VALIDATION", "invalid color");
  }
  if (!Array.isArray(annotationIds) || annotationIds.length === 0) {
    throw new ApiError("VALIDATION", "annotationIds required (non-empty array)");
  }
  if (annotationIds.some((id) => !Number.isInteger(id))) {
    throw new ApiError("VALIDATION", "annotationIds must be integers");
  }

  const { project, session } = await resolveByPublicId(projectId, { allowDemo: true });
  const writeCapability = assertProjectWritable(project);
  if (!session) throw new ApiError("UNAUTHORIZED", "Unauthorized");

  // [refactor jul9 P2-A C1] Resolve company CSI context BEFORE the tx (I-1) — the
  // detect below and the tx at the insert both follow.
  const csiCtx = await getCompanyCsiContext(project.companyId);

  // Auto-CSI from name + notes when the caller didn't set it explicitly. Manual value wins.
  let finalCsi: string | null = csiCode ?? null;
  if (!finalCsi) {
    const tagSource = `${name} ${notes ?? ""}`.trim();
    if (tagSource) {
      // [refactor jul9 P2-A C1] 4-arg: thread company config + DB (D-1/D-2).
      const detected = detectCsiCodes(tagSource, undefined, csiCtx.config, csiCtx.db);
      if (detected.length > 0) finalCsi = detected[0].code;
    }
  }

  const finalColor = color ?? TWENTY_COLORS[Math.floor(Math.random() * TWENTY_COLORS.length)];

  const group = await withProjectWrite(writeCapability, project.id, async (tx) => {
    // Verify tenancy only after the project lifecycle is locked. This keeps the validation and
    // both child writes in the same parent-first transaction.
    const verified = await tx
      .select({ id: annotations.id })
      .from(annotations)
      .where(and(inArray(annotations.id, annotationIds), eq(annotations.projectId, project.id)));
    if (verified.length !== annotationIds.length) {
      throw new ApiError("VALIDATION", "one or more annotationIds not found in this project");
    }

    const [created] = await tx
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
      .values(annotationIds.map((aid) => ({ annotationId: aid, groupId: created.id })));

    return created;
  });

  return { group: toClientGroup(group), memberCount: annotationIds.length };
}

// ── PUT /api/annotation-groups/[id] ────────────────────────────────────────────────
//
/** Partial update of a group row. Order (frozen): id-parse → load+authz → field validation →
 *  update. Auto-CSI re-derives from post-update (name, notes) when csiCode omitted but text changed. */
export async function updateAnnotationGroup(idParam: string, body: Record<string, unknown>) {
  // [refactor jul9 P2-A C1] loadGroupAndAuthz now returns { group, project }.
  const { group, project, writeCapability } = await loadGroupAndAuthz(idParam);

  const updates: Record<string, unknown> = {};

  if (body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.trim().length === 0 || body.name.length > 255) {
      throw new ApiError("VALIDATION", "invalid name");
    }
    updates.name = body.name.trim();
  }
  if (body.notes !== undefined) {
    if (body.notes !== null && typeof body.notes !== "string") {
      throw new ApiError("VALIDATION", "invalid notes");
    }
    updates.notes = body.notes;
  }
  if (body.color !== undefined) {
    if (body.color !== null && (typeof body.color !== "string" || body.color.length > 20)) {
      throw new ApiError("VALIDATION", "invalid color");
    }
    updates.color = body.color;
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") {
      throw new ApiError("VALIDATION", "invalid isActive");
    }
    updates.isActive = body.isActive;
  }
  if (body.csiCode !== undefined) {
    if (body.csiCode !== null && (typeof body.csiCode !== "string" || body.csiCode.length > 20)) {
      throw new ApiError("VALIDATION", "invalid csiCode");
    }
    updates.csiCode = body.csiCode;
  } else if (body.name !== undefined || body.notes !== undefined) {
    // Auto-CSI on text change when caller didn't explicitly set csiCode. Re-derive from
    // current-after-update (name, notes).
    const nextName = (updates.name as string | undefined) ?? group.name;
    const nextNotes = (updates.notes as string | null | undefined) ?? group.notes;
    const tagSource = `${nextName} ${nextNotes ?? ""}`.trim();
    if (tagSource) {
      // [refactor jul9 P2-A C1] 4-arg (no tx here): thread company config + DB (D-1/D-2).
      const csiCtx = await getCompanyCsiContext(project.companyId);
      const detected = detectCsiCodes(tagSource, undefined, csiCtx.config, csiCtx.db);
      if (detected.length > 0) updates.csiCode = detected[0].code;
    }
  }
  updates.updatedAt = new Date();

  const updated = await withProjectWrite(writeCapability, project.id, async (tx) => {
    const [row] = await tx
      .update(annotationGroups)
      .set(updates)
      .where(and(eq(annotationGroups.id, group.id), eq(annotationGroups.projectId, project.id)))
      .returning();
    return row;
  });

  return { group: toClientGroup(updated) };
}

// ── DELETE /api/annotation-groups/[id]?cascade=true|false ──────────────────────────
//
/** cascade=false (default, "dissolve"): delete the group row only; junction rows fall via FK,
 *  annotations survive. cascade=true: delete all member annotations first (their FK cascade
 *  clears junction rows), then the group — a member that ALSO belongs to other groups loses
 *  those memberships too (caller UI must surface impact before calling). */
export async function deleteAnnotationGroup(idParam: string, cascade: boolean) {
  const { group, project, writeCapability } = await loadGroupAndAuthz(idParam);

  if (cascade) {
    await withProjectWrite(writeCapability, project.id, async (tx) => {
      const [currentGroup] = await tx
        .select({ id: annotationGroups.id })
        .from(annotationGroups)
        .where(and(eq(annotationGroups.id, group.id), eq(annotationGroups.projectId, project.id)))
        .limit(1);
      if (!currentGroup) return;

      const members = await tx
        .select({ annotationId: annotationGroupMembers.annotationId })
        .from(annotationGroupMembers)
        .where(eq(annotationGroupMembers.groupId, group.id));
      const annotationIds = members.map((m) => m.annotationId);
      if (annotationIds.length > 0) {
        await tx
          .delete(annotations)
          .where(and(inArray(annotations.id, annotationIds), eq(annotations.projectId, project.id)));
      }
      await tx
        .delete(annotationGroups)
        .where(and(eq(annotationGroups.id, group.id), eq(annotationGroups.projectId, project.id)));
    });
    return { success: true, cascade: true };
  }

  // Dissolve — delete the group; junction rows fall via FK cascade.
  await withProjectWrite(writeCapability, project.id, async (tx) => {
    await tx
      .delete(annotationGroups)
      .where(and(eq(annotationGroups.id, group.id), eq(annotationGroups.projectId, project.id)));
  });
  return { success: true, cascade: false };
}

// ── POST/DELETE /api/annotation-groups/[id]/members ────────────────────────────────
//
/** Bulk-add annotations to a group. M:N + upsert (ON CONFLICT DO NOTHING) → repeated adds are
 *  safe. Order (frozen): id-parse → load+authz → body validation → tenancy verify → upsert. */
export async function addGroupMembers(idParam: string, body: Record<string, unknown>) {
  const { group, project, writeCapability } = await loadGroupAndAuthz(idParam);
  const annotationIds = parseAnnotationIds(body.annotationIds);

  await withProjectWrite(writeCapability, project.id, async (tx) => {
    const [currentGroup] = await tx
      .select({ id: annotationGroups.id })
      .from(annotationGroups)
      .where(and(eq(annotationGroups.id, group.id), eq(annotationGroups.projectId, project.id)))
      .limit(1);
    const verified = await tx
      .select({ id: annotations.id })
      .from(annotations)
      .where(and(inArray(annotations.id, annotationIds), eq(annotations.projectId, project.id)));
    if (!currentGroup || verified.length !== annotationIds.length) {
      throw new ApiError("VALIDATION", "one or more annotationIds not found in this project");
    }

    await tx
      .insert(annotationGroupMembers)
      .values(annotationIds.map((aid) => ({ annotationId: aid, groupId: group.id })))
      .onConflictDoNothing();
  });

  return { success: true, addedCount: annotationIds.length };
}

/** Bulk-remove membership rows; the annotations themselves are unaffected. */
export async function removeGroupMembers(idParam: string, body: Record<string, unknown>) {
  const { group, project, writeCapability } = await loadGroupAndAuthz(idParam);
  const annotationIds = parseAnnotationIds(body.annotationIds);

  await withProjectWrite(writeCapability, project.id, async (tx) => {
    const [currentGroup] = await tx
      .select({ id: annotationGroups.id })
      .from(annotationGroups)
      .where(and(eq(annotationGroups.id, group.id), eq(annotationGroups.projectId, project.id)))
      .limit(1);
    if (!currentGroup) throw new ApiError("NOT_FOUND", "Not found");

    await tx
      .delete(annotationGroupMembers)
      .where(
        and(
          eq(annotationGroupMembers.groupId, group.id),
          inArray(annotationGroupMembers.annotationId, annotationIds),
        ),
      );
  });

  return { success: true, removedCount: annotationIds.length };
}
