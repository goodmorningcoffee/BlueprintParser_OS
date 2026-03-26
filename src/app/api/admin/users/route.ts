import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import bcrypt from "bcrypt";

// GET - list all users in admin's company
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  // Select core fields first (always available)
  const coreUsers = await db
    .select({
      id: users.publicId,
      username: users.username,
      email: users.email,
      role: users.role,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.companyId, session.user.companyId));

  // Try to fetch canRunModels — column may not exist yet
  let permsMap: Record<string, boolean> = {};
  try {
    const perms = await db
      .select({ id: users.publicId, canRunModels: users.canRunModels })
      .from(users)
      .where(eq(users.companyId, session.user.companyId));
    for (const p of perms) permsMap[p.id] = p.canRunModels;
  } catch {
    // Migration 0009 hasn't run — default admins to true
    for (const u of coreUsers) permsMap[u.id] = u.role === "admin";
  }

  const allUsers = coreUsers.map((u) => ({
    ...u,
    canRunModels: permsMap[u.id] ?? u.role === "admin",
  }));

  return NextResponse.json(allUsers);
}

// POST - create new user
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const { username, email, password, role } = await req.json();

  if (!username || !email || !password) {
    return NextResponse.json({ error: "username, email, password required" }, { status: 400 });
  }

  if (password.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
  }

  // Check email uniqueness
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

  // Try with canRunModels first, fall back to without if column doesn't exist
  try {
    await db.insert(users).values({
      username,
      email,
      passwordHash,
      role: isAdmin ? "admin" : "member",
      canRunModels: isAdmin,
      companyId: session.user.companyId,
    });
  } catch {
    // canRunModels column may not exist yet — insert without it
    await db.insert(users).values({
      username,
      email,
      passwordHash,
      role: isAdmin ? "admin" : "member",
      companyId: session.user.companyId,
    } as any);
  }

  return NextResponse.json({ success: true });
}

// PUT - toggle user permissions (canRunModels)
export async function PUT(req: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const { id, canRunModels } = await req.json();

  if (!id || typeof canRunModels !== "boolean") {
    return NextResponse.json({ error: "id and canRunModels required" }, { status: 400 });
  }

  // Ensure user belongs to same company
  const [target] = await db
    .select({ id: users.id, companyId: users.companyId })
    .from(users)
    .where(eq(users.publicId, id))
    .limit(1);

  if (!target || target.companyId !== session.user.companyId) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  try {
    await db
      .update(users)
      .set({ canRunModels, updatedAt: new Date() })
      .where(eq(users.publicId, id));
  } catch {
    // canRunModels column may not exist yet
    return NextResponse.json({ error: "Migration pending — try again after restart" }, { status: 503 });
  }

  return NextResponse.json({ success: true, canRunModels });
}

// DELETE - remove a user
export async function DELETE(req: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const { id } = await req.json();

  if (!id) {
    return NextResponse.json({ error: "User id required" }, { status: 400 });
  }

  // Ensure user belongs to same company
  const [target] = await db
    .select({ id: users.id, companyId: users.companyId })
    .from(users)
    .where(eq(users.publicId, id))
    .limit(1);

  if (!target || target.companyId !== session.user.companyId) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Prevent self-deletion
  if (target.id === session.user.dbId) {
    return NextResponse.json({ error: "Cannot delete yourself" }, { status: 400 });
  }

  await db.delete(users).where(eq(users.publicId, id));

  return NextResponse.json({ success: true });
}
