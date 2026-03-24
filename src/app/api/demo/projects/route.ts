import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { getS3Url } from "@/lib/s3";

// Public — no auth required
export async function GET() {
  const demoProjects = await db
    .select()
    .from(projects)
    .where(eq(projects.isDemo, true))
    .orderBy(projects.createdAt);

  // Get actual page counts from pages table
  const pageCounts: Record<number, number> = {};
  for (const proj of demoProjects) {
    const result = await db.execute(sql`
      SELECT COUNT(*)::int as cnt FROM pages WHERE project_id = ${proj.id}
    `);
    pageCounts[proj.id] = (result.rows[0] as any)?.cnt || 0;
  }

  return NextResponse.json(
    demoProjects.map((p) => ({
      id: p.publicId,
      name: p.name,
      numPages: pageCounts[p.id] || p.numPages || 0,
      status: p.status,
      thumbnailUrl:
        p.status === "completed" ? getS3Url(p.dataUrl, "thumbnail.png") : null,
    }))
  );
}
