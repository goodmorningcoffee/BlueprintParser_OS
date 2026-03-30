import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { inviteRequests } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";

export async function GET() {
  const { session, error } = await requireAdmin();
  if (error) return error;

  const requests = await db
    .select()
    .from(inviteRequests)
    .orderBy(desc(inviteRequests.createdAt));

  const unseenCount = requests.filter((r) => !r.seen).length;

  return NextResponse.json({ requests, unseenCount });
}

export async function PUT() {
  const { session, error } = await requireAdmin();
  if (error) return error;

  await db
    .update(inviteRequests)
    .set({ seen: true })
    .where(eq(inviteRequests.seen, false));

  return NextResponse.json({ success: true });
}
