// [refactor jun16 P1.2] Takeoff service — the P1 pilot family.
//
// The four takeoff route files (takeoff-items[/id], takeoff-groups[/id]) are now thin
// `defineRoute` shells; ALL behavior lives here. Behavior is preserved EXACTLY against the
// P0.3 characterization tests (takeoff-{items,groups}.route.test.ts) — the ONE sanctioned
// change is the error envelope (handled by the shell). The frozen quirks deliberately kept:
//   • validate-before-auth on the create paths (fields 400 even when signed out) — so auth
//     stays INSIDE the service here, AFTER field validation, rather than in the shell's
//     declarative auth phase (which runs before validation). This is the pilot's key recipe
//     finding: routes that validate-before-auth resolve access in the service.
//   • indirect lookup on the [id] paths (entity fetched by id → access checked on its parent
//     project) — likewise not expressible in the shell's param/bodyKey project-auth, so it's
//     resolved here after the 404-if-missing check (missing entity 404s before any auth).
//   • takeoff-items: `color` REQUIRED (groups treat it optional); GET list OMITS groupId
//     while POST returns it (payload asymmetry); GET is strictly company-scoped with NO
//     root-admin bypass (root of another company 404s).
//   • takeoff-groups: per-(project,kind) sortOrder ladder; auto-CSI from the name when no
//     explicit code (explicit value wins); demo read-only except admin/root scope.
//   • non-uuid projectId on create is now a clean 400 (zPublicId) instead of the old
//     pg-uuid-cast 500 — the S003 quirk the shell was designed to close; the check sits at
//     the auth step (after field validation) so error precedence is unchanged.
//
// Create paths get a db.transaction wrapping the MAX(sort_order)+1 read and the insert
// (plan 03 §1.2 "group-create gets its tx"; items get the same treatment — identical race).
// The transaction makes the read+write atomic; eliminating the duplicate-sortOrder race
// across truly concurrent creators (READ COMMITTED) is deferred to P2 (optimistic mutations)
// / P4 (FK + constraint wave). The old per-route try/catch that LEAKED raw pg error text
// into the 500 body is gone — DB errors propagate to the shell (generic 500 + server log),
// except the create paths keep a rich server-side log line before surfacing a generic error.

import { db } from "@/lib/db";
import { projects, takeoffItems, takeoffGroups } from "@/lib/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { TAKEOFF_SHAPES } from "@/types";
import { detectCsiCodes } from "@/lib/csi-detect";
import { logger } from "@/lib/logger";
import type { AuthSession } from "@/lib/api-utils";
import { ApiError } from "@/server/api/envelope";
import { resolveProjectOrThrow } from "@/server/api/access";
import { zPublicId } from "@/server/api/schemas";

const VALID_KINDS = ["count", "area", "linear"] as const;

/** Validate a publicId at the auth step, then resolve access — the create-path recipe.
 *  Keeps the non-uuid → 400 (not pg-cast 500) check AFTER field validation so the order of
 *  error precedence the characterization tests freeze (e.g. "invalid kind" wins over a bad
 *  id) is unchanged. */
async function resolveByPublicId(projectId: unknown) {
  const parsed = zPublicId.safeParse(projectId);
  if (!parsed.success) throw new ApiError("VALIDATION", "Invalid project id");
  return resolveProjectOrThrow({ publicId: parsed.data }, { allowDemo: true });
}

// ── takeoff items ──────────────────────────────────────────────────────────────

/** GET /api/takeoff-items?projectId — strictly company-scoped (NO root bypass; quirk). */
export async function listTakeoffItems(session: AuthSession, projectPublicId: string) {
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.publicId, projectPublicId), eq(projects.companyId, session.user.companyId)))
    .limit(1);
  if (!project) throw new ApiError("NOT_FOUND", "Not found");

  const items = await db
    .select()
    .from(takeoffItems)
    .where(eq(takeoffItems.projectId, project.id))
    .orderBy(takeoffItems.sortOrder);

  // NB: list payload OMITS groupId (POST returns it) — frozen asymmetry quirk.
  return items.map((t) => ({
    id: t.id,
    name: t.name,
    shape: t.shape,
    color: t.color,
    size: t.size,
    notes: t.notes,
    sortOrder: t.sortOrder,
  }));
}

/** POST /api/takeoff-items — validate fields, THEN auth, THEN insert (project-wide ladder). */
export async function createTakeoffItem(body: Record<string, unknown>) {
  const { projectId, name, shape, color, size, groupId } = body;

  if (!projectId || !name || !shape || !color) {
    throw new ApiError("VALIDATION", "projectId, name, shape, color required");
  }
  if (shape !== "polygon" && shape !== "linear" && !(TAKEOFF_SHAPES as readonly unknown[]).includes(shape)) {
    throw new ApiError("VALIDATION", "Invalid shape");
  }
  if (groupId !== undefined && groupId !== null && !Number.isInteger(groupId)) {
    throw new ApiError("VALIDATION", "invalid groupId");
  }

  const { project, scope } = await resolveByPublicId(projectId);
  if (project.isDemo && scope !== "admin" && scope !== "root") {
    throw new ApiError("FORBIDDEN", "Demo projects are read-only");
  }

  try {
    const item = await db.transaction(async (tx) => {
      // Next sort order is project-wide (NOT per-shape) — frozen ladder.
      const maxResult = await tx.execute(
        sql`SELECT COALESCE(MAX(sort_order), -1)::int + 1 AS next_order FROM takeoff_items WHERE project_id = ${project.id}`,
      );
      const sortOrder = (maxResult.rows[0] as { next_order: number })?.next_order ?? 0;
      const [row] = await tx
        .insert(takeoffItems)
        .values({
          projectId: project.id,
          groupId: (groupId as number) || null,
          name: name as string,
          shape: shape as string,
          color: color as string,
          size: (size as number) || 10,
          sortOrder,
        })
        .returning();
      return row;
    });

    return {
      id: item.id,
      name: item.name,
      shape: item.shape,
      color: item.color,
      size: item.size,
      notes: item.notes,
      sortOrder: item.sortOrder,
      groupId: item.groupId,
    };
  } catch (err) {
    // Was a raw-pg-leak 500; now: rich server-side log + generic envelope (no leak).
    const cause = (err as { cause?: { message?: string; detail?: string; code?: string } })?.cause;
    logger.error("[takeoff] create item failed:", { cause, pgCode: cause?.code });
    throw new ApiError("INTERNAL", "Internal server error");
  }
}

/** PUT /api/takeoff-items/[id] — indirect lookup (item → its project), partial update. */
export async function updateTakeoffItem(idParam: string, body: Record<string, unknown>) {
  const itemId = parseInt(idParam);
  const [item] = await db.select().from(takeoffItems).where(eq(takeoffItems.id, itemId)).limit(1);
  if (!item) throw new ApiError("NOT_FOUND", "Not found");

  await resolveProjectOrThrow({ dbId: item.projectId });

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.shape !== undefined) updates.shape = body.shape;
  if (body.color !== undefined) updates.color = body.color;
  if (body.size !== undefined) updates.size = body.size;
  if (body.notes !== undefined) updates.notes = body.notes;
  if (body.groupId !== undefined) {
    if (body.groupId !== null && !Number.isInteger(body.groupId)) {
      throw new ApiError("VALIDATION", "invalid groupId");
    }
    updates.groupId = body.groupId;
  }
  updates.updatedAt = new Date();

  await db.update(takeoffItems).set(updates).where(eq(takeoffItems.id, itemId));

  // Sync annotation names if the item was renamed.
  if (body.name !== undefined && body.name !== item.name) {
    await db.execute(
      sql`UPDATE annotations SET name = ${body.name} WHERE source = 'takeoff' AND data->>'takeoffItemId' = ${String(itemId)}`,
    );
  }

  return { success: true as const };
}

/** DELETE /api/takeoff-items/[id] — removes the item's markers, then the item. */
export async function deleteTakeoffItem(idParam: string) {
  const itemId = parseInt(idParam);
  const [item] = await db.select().from(takeoffItems).where(eq(takeoffItems.id, itemId)).limit(1);
  if (!item) throw new ApiError("NOT_FOUND", "Not found");

  await resolveProjectOrThrow({ dbId: item.projectId });

  await db.execute(
    sql`DELETE FROM annotations WHERE source = 'takeoff' AND data->>'takeoffItemId' = ${String(itemId)}`,
  );
  await db.delete(takeoffItems).where(eq(takeoffItems.id, itemId));

  return { success: true as const };
}

// ── takeoff groups ─────────────────────────────────────────────────────────────

/** GET /api/takeoff-groups?projectId — strictly company-scoped (NO root bypass; quirk). */
export async function listTakeoffGroups(session: AuthSession, projectPublicId: string) {
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.publicId, projectPublicId), eq(projects.companyId, session.user.companyId)))
    .limit(1);
  if (!project) throw new ApiError("NOT_FOUND", "Not found");

  const groups = await db
    .select()
    .from(takeoffGroups)
    .where(eq(takeoffGroups.projectId, project.id))
    .orderBy(takeoffGroups.sortOrder);

  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    kind: g.kind,
    color: g.color,
    csiCode: g.csiCode,
    sortOrder: g.sortOrder,
  }));
}

/** POST /api/takeoff-groups — validate fields, THEN auth, THEN insert (per-(project,kind)). */
export async function createTakeoffGroup(body: Record<string, unknown>) {
  const { projectId, name, kind, color, csiCode } = body;

  if (!projectId || !name || !kind) {
    throw new ApiError("VALIDATION", "projectId, name, kind required");
  }
  if (typeof name !== "string" || name.trim().length === 0 || name.length > 255) {
    throw new ApiError("VALIDATION", "invalid name");
  }
  if (!(VALID_KINDS as readonly unknown[]).includes(kind)) {
    throw new ApiError("VALIDATION", "invalid kind");
  }
  if (color !== undefined && color !== null && (typeof color !== "string" || color.length > 20)) {
    throw new ApiError("VALIDATION", "invalid color");
  }
  if (csiCode !== undefined && csiCode !== null && (typeof csiCode !== "string" || csiCode.length > 20)) {
    throw new ApiError("VALIDATION", "invalid csiCode");
  }

  const { project, scope } = await resolveByPublicId(projectId);
  if (project.isDemo && scope !== "admin" && scope !== "root") {
    throw new ApiError("FORBIDDEN", "Demo projects are read-only");
  }

  try {
    const group = await db.transaction(async (tx) => {
      // Sort order is scoped to (projectId, kind) — separate ladder per kind.
      const maxResult = await tx.execute(
        sql`SELECT COALESCE(MAX(sort_order), -1)::int + 1 AS next_order
            FROM takeoff_groups
            WHERE project_id = ${project.id} AND kind = ${kind}`,
      );
      const sortOrder = (maxResult.rows[0] as { next_order: number })?.next_order ?? 0;

      // Auto-CSI from the name when the caller didn't set one explicitly (user value wins).
      let finalCsiCode: string | null = (csiCode as string | null | undefined) ?? null;
      if (!finalCsiCode) {
        const detected = detectCsiCodes(name);
        if (detected.length > 0) finalCsiCode = detected[0].code;
      }

      const [row] = await tx
        .insert(takeoffGroups)
        .values({
          projectId: project.id,
          name: name.trim(),
          kind: kind as string,
          color: (color as string | null | undefined) ?? null,
          csiCode: finalCsiCode,
          sortOrder,
        })
        .returning();
      return row;
    });

    return {
      id: group.id,
      name: group.name,
      kind: group.kind,
      color: group.color,
      csiCode: group.csiCode,
      sortOrder: group.sortOrder,
    };
  } catch (err) {
    const cause = (err as { cause?: { message?: string; detail?: string; code?: string } })?.cause;
    logger.error("[takeoff-groups] create failed:", { cause, pgCode: cause?.code });
    throw new ApiError("INTERNAL", "Internal server error");
  }
}

/** PUT /api/takeoff-groups/[id] — id validated (400 invalid id), partial update + fill-CSI. */
export async function updateTakeoffGroup(idParam: string, body: Record<string, unknown>) {
  const groupId = parseInt(idParam, 10);
  if (!Number.isInteger(groupId)) throw new ApiError("VALIDATION", "invalid id");

  const [group] = await db.select().from(takeoffGroups).where(eq(takeoffGroups.id, groupId)).limit(1);
  if (!group) throw new ApiError("NOT_FOUND", "Not found");

  await resolveProjectOrThrow({ dbId: group.projectId });

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.trim().length === 0 || body.name.length > 255) {
      throw new ApiError("VALIDATION", "invalid name");
    }
    updates.name = body.name.trim();
  }
  if (body.color !== undefined) {
    if (body.color !== null && (typeof body.color !== "string" || body.color.length > 20)) {
      throw new ApiError("VALIDATION", "invalid color");
    }
    updates.color = body.color;
  }
  if (body.csiCode !== undefined) {
    if (body.csiCode !== null && (typeof body.csiCode !== "string" || body.csiCode.length > 20)) {
      throw new ApiError("VALIDATION", "invalid csiCode");
    }
    updates.csiCode = body.csiCode;
  } else if (
    // Fill-when-empty: only auto-detect if the user didn't explicitly set a code, the
    // current record has none, and the rename might contain a CSI hint. Never overwrites.
    group.csiCode === null &&
    typeof updates.name === "string"
  ) {
    const detected = detectCsiCodes(updates.name as string);
    if (detected.length > 0) updates.csiCode = detected[0].code;
  }
  if (body.sortOrder !== undefined) {
    if (!Number.isInteger(body.sortOrder)) throw new ApiError("VALIDATION", "invalid sortOrder");
    updates.sortOrder = body.sortOrder;
  }
  updates.updatedAt = new Date();

  const [updated] = await db
    .update(takeoffGroups)
    .set(updates)
    .where(eq(takeoffGroups.id, groupId))
    .returning();

  return {
    id: updated.id,
    name: updated.name,
    kind: updated.kind,
    color: updated.color,
    csiCode: updated.csiCode,
    sortOrder: updated.sortOrder,
  };
}

/** DELETE /api/takeoff-groups/[id] — id validated; FK SET NULL orphans items. */
export async function deleteTakeoffGroup(idParam: string) {
  const groupId = parseInt(idParam, 10);
  if (!Number.isInteger(groupId)) throw new ApiError("VALIDATION", "invalid id");

  const [group] = await db.select().from(takeoffGroups).where(eq(takeoffGroups.id, groupId)).limit(1);
  if (!group) throw new ApiError("NOT_FOUND", "Not found");

  await resolveProjectOrThrow({ dbId: group.projectId });

  // FK ON DELETE SET NULL on takeoff_items.group_id orphans items automatically.
  await db.delete(takeoffGroups).where(eq(takeoffGroups.id, groupId));

  return { success: true as const };
}
