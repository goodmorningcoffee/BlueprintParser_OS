// [refactor jul8 S058] admin/users SOLO — 4-method admin route (GET list + POST create +
// PUT update + DELETE reassign/cascade), folded from the legacy route
// (git show 7528e74:src/app/api/admin/users/route.ts). Char:
// __tests__/admin-users.route.test.ts (US-*). requireAdmin → shell auth:"admin".
// Sanctioned diffs:
//   • A — all validation/404 flat {error} → envelope ApiError, message BYTE-verbatim + status
//     preserved (POST 3 literals@400 · PUT "id required"@400 + "User not found"@404 ×2 ·
//     DELETE 9-literal ladder: "User id required"/"mode must be 'reassign' or 'cascade'"/
//     "Cannot delete yourself"/"Cannot delete root admin"/"Reassign target not found"/
//     "Reassign target must be in your company"/"Cannot reassign projects to the user being
//     deleted"@400 + "User not found"@404 ×2).
//   • B ×3 (DR002-sanctioned) — POST :109 err.message LEAK and DELETE :270 err.message LEAK
//     retired → shell generic INTERNAL 500 (DELETE keeps the "[user-delete] Failed"
//     logger.error breadcrumb via in-service try/log/re-throw); PUT :149 FIXED literal
//     "Update failed" retired → shell generic INTERNAL 500.
//   • E — POST/PUT/DELETE `await req.json()` subsumed by the shell raw-parse (malformed →
//     400 "Invalid JSON body"). GET has no body → NO E.
// PRESERVED verbatim (DR006 + recon traps):
//   • GET INNER perms try/catch = DATA fallback (canRunModels=role-derived, isRootAdmin=false)
//     — BUSINESS logic @200, NOT a B; the real column is authoritative when the query works;
//   • every in-body isRootAdmin branch stays IN-SERVICE (GET all-companies+companyName; POST
//     targetCompanyId; PUT role/companyId gates; DELETE cross-company scope + unscoped
//     cascade-select for root) — mis-hoisting any = tenant/priv-esc regression;
//   • cross-company target → "User not found" 404 (indistinguishable from missing);
//   • cascade deleteProjectFully loop runs BEFORE the tx by design (S3 irreversible;
//     per-project best-effort/sequential; do NOT reorder into the tx);
//   • the tx = reassign + 5 soft-FK nulls + user delete (all-or-nothing);
//   • audit("user_deleted") fire-and-forget (unawaited);
//   • bcrypt.hash(password, 12); email lowercased/trimmed BEFORE validation.

import { db } from "@/lib/db";
import { users, companies, projects, annotations, chatMessages, modelAccess, appSettings, annotationGroups } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import bcrypt from "bcrypt";
import { deleteProjectFully } from "@/lib/project-delete";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { ApiError } from "@/server/api/envelope";
import type { AuthSession } from "@/lib/api-utils";

// GET - list users (root admin: all companies, regular admin: own company)
export async function listUsers(session: AuthSession): Promise<unknown> {
  const isRoot = session.user.isRootAdmin;

  const coreUsers = await db
    .select({
      id: users.publicId,
      dbId: users.id,
      username: users.username,
      email: users.email,
      role: users.role,
      companyId: users.companyId,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(isRoot ? undefined : eq(users.companyId, session.user.companyId));

  // Fetch canRunModels + isRootAdmin
  const permsMap: Record<number, { canRunModels: boolean; isRootAdmin: boolean }> = {};
  try {
    const perms = await db
      .select({ dbId: users.id, canRunModels: users.canRunModels, isRootAdmin: users.isRootAdmin })
      .from(users)
      .where(isRoot ? undefined : eq(users.companyId, session.user.companyId));
    for (const p of perms) permsMap[p.dbId] = { canRunModels: p.canRunModels, isRootAdmin: p.isRootAdmin };
  } catch {
    // DATA fallback (not an error path): derive from role. US-4 pins.
    for (const u of coreUsers) permsMap[u.dbId] = { canRunModels: u.role === "admin", isRootAdmin: false };
  }

  // Fetch company names for root admin
  const companyMap: Record<number, string> = {};
  if (isRoot) {
    const allCompanies = await db.select({ id: companies.id, name: companies.name }).from(companies);
    for (const c of allCompanies) companyMap[c.id] = c.name;
  }

  const allUsers = coreUsers.map((u) => ({
    id: u.id,
    username: u.username,
    email: u.email,
    role: u.role,
    companyId: u.companyId,
    companyName: companyMap[u.companyId] || undefined,
    canRunModels: permsMap[u.dbId]?.canRunModels ?? u.role === "admin",
    isRootAdmin: permsMap[u.dbId]?.isRootAdmin ?? false,
    createdAt: u.createdAt,
  }));

  return allUsers; // BARE array (shell passes it through un-enveloped)
}

// POST - create new user (root admin can specify companyId)
export async function createUser(session: AuthSession, body: Record<string, unknown>): Promise<unknown> {
  const { username, email: rawEmail, password, role, companyId } = body as {
    username?: string; email?: string; password?: string; role?: string; companyId?: number;
  };
  const email = typeof rawEmail === "string" ? rawEmail.toLowerCase().trim() : "";

  if (!username || !email || !password) {
    throw new ApiError("VALIDATION", "username, email, password required");
  }

  if (password.length < 8) {
    throw new ApiError("VALIDATION", "Password must be at least 8 characters");
  }

  // Root admin can create in any company, regular admin only in own company
  const targetCompanyId = session.user.isRootAdmin && companyId
    ? companyId
    : session.user.companyId;

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing) {
    throw new ApiError("VALIDATION", "Email already exists");
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const isAdmin = role === "admin";

  // [S058 diff B] legacy caught insert errors and returned err.message@500 (DR002 users:109
  // leak) — retired: an insert throw now propagates to the shell's generic INTERNAL 500.
  await db.insert(users).values({
    username,
    email,
    passwordHash,
    role: isAdmin ? "admin" : "member",
    canRunModels: isAdmin,
    companyId: targetCompanyId,
  });

  return { success: true };
}

// PUT - update user permissions, role, or company
export async function updateUser(session: AuthSession, body: Record<string, unknown>): Promise<unknown> {
  const { id, canRunModels, role, companyId } = body as {
    id?: string; canRunModels?: unknown; role?: string; companyId?: number;
  };

  if (!id) {
    throw new ApiError("VALIDATION", "id required");
  }

  const [target] = await db
    .select({ id: users.id, companyId: users.companyId })
    .from(users)
    .where(eq(users.publicId, id))
    .limit(1);

  if (!target) {
    throw new ApiError("NOT_FOUND", "User not found");
  }

  // Regular admin: can only manage own company users (same message — no existence leak)
  if (!session.user.isRootAdmin && target.companyId !== session.user.companyId) {
    throw new ApiError("NOT_FOUND", "User not found");
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof canRunModels === "boolean") updates.canRunModels = canRunModels;
  if (role && session.user.isRootAdmin) updates.role = role; // Only root admin can change roles
  if (companyId && session.user.isRootAdmin) updates.companyId = companyId; // Only root admin can move between companies

  // [S058 diff B] legacy caught update errors with the FIXED literal "Update failed"@500 —
  // retired: an update throw now propagates to the shell's generic INTERNAL 500.
  await db.update(users).set(updates).where(eq(users.publicId, id));

  return { success: true };
}

// DELETE - remove a user.
// Body: { id, mode?: 'reassign'|'cascade', reassignTo? }
//  - 'reassign' (default): move the user's projects to `reassignTo` (a user
//    publicId) or, if omitted, to the acting admin (the root admin, for the
//    owner), then delete the user. Their blueprints are preserved.
//  - 'cascade': permanently delete the user AND every project they authored
//    (incl. S3 files). Destructive — the UI gates this behind a confirm.
// Either way, soft-attribution rows (annotation/chat/etc. "who did this" links)
// are nulled so the user row can be removed; compute_usage.user_id nulls via
// ON DELETE SET NULL; sessions / api-keys / llm-configs cascade-delete.
export async function deleteUser(session: AuthSession, body: Record<string, unknown>): Promise<unknown> {
  const { id, mode = "reassign", reassignTo } = body as {
    id?: string; mode?: string; reassignTo?: string;
  };
  if (!id) {
    throw new ApiError("VALIDATION", "User id required");
  }
  if (mode !== "reassign" && mode !== "cascade") {
    throw new ApiError("VALIDATION", "mode must be 'reassign' or 'cascade'");
  }

  const [target] = await db
    .select({ id: users.id, companyId: users.companyId, isRootAdmin: users.isRootAdmin })
    .from(users)
    .where(eq(users.publicId, id))
    .limit(1);

  if (!target) {
    throw new ApiError("NOT_FOUND", "User not found");
  }

  // Regular admin: can only delete own company users (same message — no existence leak)
  if (!session.user.isRootAdmin && target.companyId !== session.user.companyId) {
    throw new ApiError("NOT_FOUND", "User not found");
  }

  // Prevent self-deletion and root admin deletion
  if (target.id === session.user.dbId) {
    throw new ApiError("VALIDATION", "Cannot delete yourself");
  }
  if (target.isRootAdmin) {
    throw new ApiError("VALIDATION", "Cannot delete root admin");
  }

  // Resolve the reassign target (reassign mode only).
  let reassignTargetId = session.user.dbId; // default: the acting admin (root, for the owner)
  if (mode === "reassign" && reassignTo) {
    const [rt] = await db
      .select({ id: users.id, companyId: users.companyId })
      .from(users)
      .where(eq(users.publicId, reassignTo))
      .limit(1);
    if (!rt) {
      throw new ApiError("VALIDATION", "Reassign target not found");
    }
    // Keep projects in-company for regular admins.
    if (!session.user.isRootAdmin && rt.companyId !== session.user.companyId) {
      throw new ApiError("VALIDATION", "Reassign target must be in your company");
    }
    reassignTargetId = rt.id;
  }
  if (mode === "reassign" && reassignTargetId === target.id) {
    throw new ApiError("VALIDATION", "Cannot reassign projects to the user being deleted");
  }

  // [S058 diff B] legacy's outer catch returned err.message@500 (DR002 users:270 leak) —
  // retired to the shell generic INTERNAL 500, but the "[user-delete] Failed" breadcrumb
  // SURVIVES via this try/log/re-throw (the cascade is irreversible; ops needs the trace).
  try {
    let projectCount = 0;

    // Nuclear path touches S3 (irreversible), so it runs BEFORE the transaction;
    // per-project deletion is best-effort/sequential.
    if (mode === "cascade") {
      const owned = await db
        .select({ id: projects.id, dataUrl: projects.dataUrl, jobId: projects.jobId, name: projects.name })
        .from(projects)
        .where(
          session.user.isRootAdmin
            ? eq(projects.authorId, target.id)
            : and(eq(projects.authorId, target.id), eq(projects.companyId, session.user.companyId))
        );
      projectCount = owned.length;
      for (const p of owned) {
        await deleteProjectFully(p);
      }
    }

    // Atomic: reassign the user's projects (reassign mode) + null soft-attribution
    // FKs + delete the user. All-or-nothing so a mid-sequence failure can't leave
    // a half-deleted user.
    await db.transaction(async (tx) => {
      if (mode === "reassign") {
        const moved = await tx
          .update(projects)
          .set({ authorId: reassignTargetId })
          .where(eq(projects.authorId, target.id))
          .returning({ id: projects.id });
        projectCount = moved.length;
      }
      await tx.update(annotations).set({ creatorId: null }).where(eq(annotations.creatorId, target.id));
      await tx.update(chatMessages).set({ userId: null }).where(eq(chatMessages.userId, target.id));
      await tx.update(modelAccess).set({ grantedBy: null }).where(eq(modelAccess.grantedBy, target.id));
      await tx.update(appSettings).set({ updatedBy: null }).where(eq(appSettings.updatedBy, target.id));
      await tx.update(annotationGroups).set({ createdBy: null }).where(eq(annotationGroups.createdBy, target.id));
      await tx.delete(users).where(eq(users.publicId, id));
    });

    audit("user_deleted", {
      userId: session.user.dbId,
      companyId: session.user.companyId,
      details: { deletedUserId: id, mode, projectCount, reassignTargetId: mode === "reassign" ? reassignTargetId : undefined },
    });

    return { success: true, mode, projectCount };
  } catch (err) {
    logger.error("[user-delete] Failed", { id, mode, err });
    throw err; // → shell generic INTERNAL 500 (no err.message leak)
  }
}
