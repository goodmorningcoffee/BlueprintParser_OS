import { NextResponse } from "next/server";
import { requireAuth, requireCompanyAccess } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { pages, projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

/**
 * GET /api/pages/textract?projectId=X&pageNumber=Y
 *
 * Returns textractData for a single page. Used for lazy-loading
 * instead of sending all pages' textract data in the project response.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const projectId = Number(url.searchParams.get("projectId"));
  const pageNumber = Number(url.searchParams.get("pageNumber"));

  if (!projectId || !pageNumber) {
    return NextResponse.json({ error: "Missing projectId or pageNumber" }, { status: 400 });
  }

  // Check project exists and handle auth (demo projects skip auth)
  const [project] = await db
    .select({ id: projects.id, isDemo: projects.isDemo, companyId: projects.companyId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { session } = await requireAuth();
  const accessError = requireCompanyAccess(session, project);
  if (accessError) return accessError;

  const [pageRow] = await db
    .select({ textractData: pages.textractData })
    .from(pages)
    .where(and(eq(pages.projectId, project.id), eq(pages.pageNumber, pageNumber)))
    .limit(1);

  return NextResponse.json({
    textractData: pageRow?.textractData || null,
  });
}
