import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { users, companies, projects, annotations, chatMessages, modelAccess, appSettings, annotationGroups } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import bcrypt from "bcrypt";
import { deleteProjectFully } from "@/lib/project-delete";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";

// GET - list users (root admin: all companies, regular admin: own company)
export async function GET() {
  const { session, error } = await requireAdmin();
  if (error) return error;

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
  let permsMap: Record<number, { canRunModels: boolean; isRootAdmin: boolean }> = {};
  try {
    const perms = await db
      .select({ dbId: users.id, canRunModels: users.canRunModels, isRootAdmin: users.isRootAdmin })
      .from(users)
      .where(isRoot ? undefined : eq(users.companyId, session.user.companyId));
    for (const p of perms) permsMap[p.dbId] = { canRunModels: p.canRunModels, isRootAdmin: p.isRootAdmin };
  } catch {
    for (const u of coreUsers) permsMap[u.dbId] = { canRunModels: u.role === "admin", isRootAdmin: false };
  }

  // Fetch company names for root admin
  let companyMap: Record<number, string> = {};
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

  return NextResponse.json(allUsers);
}

// POST - create new user (root admin can specify companyId)
export async function POST(req: Request) {
  const { session, error } = await requireAdmin();
  if (error) return error;

  const { username, email: rawEmail, password, role, companyId } = await req.json();
  const email = typeof rawEmail === "string" ? rawEmail.toLowerCase().trim() : "";

  if (!username || !email || !password) {
    return NextResponse.json({ error: "username, email, password required" }, { status: 400 });
  }

  if (password.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
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
    return NextResponse.json({ error: "Email already exists" }, { status: 400 });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const isAdmin = role === "admin";

  try {
    await db.insert(users).values({
      username,
      email,
      passwordHash,
      role: isAdmin ? "admin" : "member",
      canRunModels: isAdmin,
      companyId: targetCompanyId,
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to create user" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}

// PUT - update user permissions, role, or company
export async function PUT(req: Request) {
  const { session, error } = await requireAdmin();
  if (error) return error;

  const { id, canRunModels, role, companyId } = await req.json();

  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const [target] = await db
    .select({ id: users.id, companyId: users.companyId })
    .from(users)
    .where(eq(users.publicId, id))
    .limit(1);

  if (!target) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Regular admin: can only manage own company users
  if (!session.user.isRootAdmin && target.companyId !== session.user.companyId) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof canRunModels === "boolean") updates.canRunModels = canRunModels;
  if (role && session.user.isRootAdmin) updates.role = role; // Only root admin can change roles
  if (companyId && session.user.isRootAdmin) updates.companyId = companyId; // Only root admin can move between companies

  try {
    await db.update(users).set(updates).where(eq(users.publicId, id));
  } catch {
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
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
export async function DELETE(req: Request) {
  const { session, error } = await requireAdmin();
  if (error) return error;

  const { id, mode = "reassign", reassignTo } = await req.json();
  if (!id) {
    return NextResponse.json({ error: "User id required" }, { status: 400 });
  }
  if (mode !== "reassign" && mode !== "cascade") {
    return NextResponse.json({ error: "mode must be 'reassign' or 'cascade'" }, { status: 400 });
  }

  const [target] = await db
    .select({ id: users.id, companyId: users.companyId, isRootAdmin: users.isRootAdmin })
    .from(users)
    .where(eq(users.publicId, id))
    .limit(1);

  if (!target) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Regular admin: can only delete own company users
  if (!session.user.isRootAdmin && target.companyId !== session.user.companyId) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Prevent self-deletion and root admin deletion
  if (target.id === session.user.dbId) {
    return NextResponse.json({ error: "Cannot delete yourself" }, { status: 400 });
  }
  if (target.isRootAdmin) {
    return NextResponse.json({ error: "Cannot delete root admin" }, { status: 400 });
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
      return NextResponse.json({ error: "Reassign target not found" }, { status: 400 });
    }
    // Keep projects in-company for regular admins.
    if (!session.user.isRootAdmin && rt.companyId !== session.user.companyId) {
      return NextResponse.json({ error: "Reassign target must be in your company" }, { status: 400 });
    }
    reassignTargetId = rt.id;
  }
  if (mode === "reassign" && reassignTargetId === target.id) {
    return NextResponse.json({ error: "Cannot reassign projects to the user being deleted" }, { status: 400 });
  }

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

    return NextResponse.json({ success: true, mode, projectCount });
  } catch (err) {
    logger.error("[user-delete] Failed", { id, mode, err });
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to delete user" }, { status: 500 });
  }
}
