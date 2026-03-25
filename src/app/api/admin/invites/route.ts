import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { inviteRequests } from "@/lib/db/schema";
import { eq, sql, desc } from "drizzle-orm";

export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const requests = await db
    .select()
    .from(inviteRequests)
    .orderBy(desc(inviteRequests.createdAt));

  const unseenCount = requests.filter((r) => !r.seen).length;

  return NextResponse.json({ requests, unseenCount });
}

export async function PUT() {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await db
    .update(inviteRequests)
    .set({ seen: true })
    .where(eq(inviteRequests.seen, false));

  return NextResponse.json({ success: true });
}
