import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { users, companies } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import bcrypt from "bcrypt";

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

  const { username, email, password, role, companyId } = await req.json();

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
  } catch {
    await db.insert(users).values({
      username,
      email,
      passwordHash,
      role: isAdmin ? "admin" : "member",
      companyId: targetCompanyId,
    } as any);
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

// DELETE - remove a user
export async function DELETE(req: Request) {
  const { session, error } = await requireAdmin();
  if (error) return error;

  const { id } = await req.json();
  if (!id) {
    return NextResponse.json({ error: "User id required" }, { status: 400 });
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

  await db.delete(users).where(eq(users.publicId, id));
  return NextResponse.json({ success: true });
}
