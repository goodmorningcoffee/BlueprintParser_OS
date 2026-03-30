import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { projects, qtoWorkflows } from "@/lib/db/schema";
import { eq, and, desc } from "drizzle-orm";

/** GET /api/qto-workflows?projectId=<publicId> — list workflows for a project */
export async function GET(req: Request) {
  const { session, error } = await requireAuth();
  if (error) return error;

  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId");
  if (!projectId) {
    return NextResponse.json({ error: "projectId required" }, { status: 400 });
  }

  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.publicId, projectId), eq(projects.companyId, session.user.companyId)))
    .limit(1);

  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const workflows = await db
    .select()
    .from(qtoWorkflows)
    .where(eq(qtoWorkflows.projectId, project.id))
    .orderBy(desc(qtoWorkflows.createdAt));

  return NextResponse.json(workflows);
}

/** POST /api/qto-workflows — create a new workflow */
export async function POST(req: Request) {
  const { session, error } = await requireAuth();
  if (error) return error;

  const { projectId, materialType, materialLabel } = await req.json();
  if (!projectId || !materialType) {
    return NextResponse.json({ error: "projectId and materialType required" }, { status: 400 });
  }

  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.publicId, projectId), eq(projects.companyId, session.user.companyId)))
    .limit(1);

  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const [workflow] = await db
      .insert(qtoWorkflows)
      .values({
        projectId: project.id,
        materialType,
        materialLabel: materialLabel || materialType,
        step: "select-schedule",
      })
      .returning();

    return NextResponse.json(workflow);
  } catch (err) {
    console.error("[qto-workflows] Create failed:", err);
    return NextResponse.json({ error: "Failed to create workflow" }, { status: 500 });
  }
}
