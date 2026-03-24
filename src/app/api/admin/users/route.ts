import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { users, companies } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import bcrypt from "bcrypt";

// GET - list all users in admin's company
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const allUsers = await db
    .select({
      id: users.publicId,
      username: users.username,
      email: users.email,
      role: users.role,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.companyId, session.user.companyId));

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
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing) {
    return NextResponse.json({ error: "Email already exists" }, { status: 400 });
  }

  const passwordHash = await bcrypt.hash(password, 12);

  await db.insert(users).values({
    username,
    email,
    passwordHash,
    role: "member", // always member — admin role requires separate elevation
    companyId: session.user.companyId,
  });

  return NextResponse.json({ success: true });
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
    .select()
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
