import { NextResponse } from "next/server";
import { resolveProjectAccess } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

export async function POST(req: Request) {
  const { projectId, pageNumber, name } = await req.json();

  if (!projectId || !pageNumber || !name) {
    return NextResponse.json(
      { error: "projectId, pageNumber, and name are required" },
      { status: 400 }
    );
  }

  const access = await resolveProjectAccess({ publicId: projectId });
  if (access.error) return access.error;
  const { project } = access;

  await db
    .update(pages)
    .set({ name })
    .where(
      and(eq(pages.projectId, project.id), eq(pages.pageNumber, pageNumber))
    );

  return NextResponse.json({ success: true });
}
