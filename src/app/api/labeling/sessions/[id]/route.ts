import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { labelingSessions } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { deleteProject } from "@/lib/label-studio";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sessionId = parseInt(id);
  const [record] = await db
    .select()
    .from(labelingSessions)
    .where(
      and(
        eq(labelingSessions.id, sessionId),
        eq(labelingSessions.companyId, session.user.companyId)
      )
    )
    .limit(1);

  if (!record) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Delete the Label Studio project
  try {
    await deleteProject(record.labelStudioProjectId);
  } catch (err) {
    console.error("[LABELING] Failed to delete LS project:", err);
    // Continue with DB cleanup even if LS API fails
  }

  // Delete the session record
  await db.delete(labelingSessions).where(eq(labelingSessions.id, sessionId));

  return NextResponse.json({ success: true });
}
