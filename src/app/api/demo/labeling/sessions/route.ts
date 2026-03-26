import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, labelingSessions } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

/**
 * GET /api/demo/labeling/sessions?projectId=X
 *
 * Public endpoint — returns labeling sessions for demo projects only.
 * No auth required (demo projects are public).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId");
  if (!projectId) {
    return NextResponse.json({ error: "projectId required" }, { status: 400 });
  }

  // Only allow demo projects
  const [project] = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.publicId, projectId),
        eq(projects.isDemo, true)
      )
    )
    .limit(1);

  if (!project) {
    return NextResponse.json([], { status: 200 });
  }

  const sessions = await db
    .select()
    .from(labelingSessions)
    .where(eq(labelingSessions.projectId, project.id));

  return NextResponse.json(
    sessions.map((s) => ({
      id: s.id,
      labelStudioUrl: s.labelStudioUrl,
      taskType: s.taskType,
      pageRange: s.pageRange,
      taskCount: 0, // Not stored in DB, cosmetic only
    }))
  );
}
