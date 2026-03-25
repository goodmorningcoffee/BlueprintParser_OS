import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { projects, labelingSessions } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId");
  if (!projectId) {
    return NextResponse.json({ error: "projectId required" }, { status: 400 });
  }

  const [project] = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.publicId, projectId),
        eq(projects.companyId, session.user.companyId)
      )
    )
    .limit(1);

  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const sessions = await db
    .select()
    .from(labelingSessions)
    .where(eq(labelingSessions.projectId, project.id));

  return NextResponse.json(
    sessions.map((s) => ({
      id: s.id,
      labelStudioProjectId: s.labelStudioProjectId,
      labelStudioUrl: s.labelStudioUrl,
      taskType: s.taskType,
      labels: s.labels,
      pageRange: s.pageRange,
      status: s.status,
      createdAt: s.createdAt,
    }))
  );
}
