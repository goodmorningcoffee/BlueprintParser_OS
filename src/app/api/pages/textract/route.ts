import { NextResponse } from "next/server";
import { resolveProjectAccess, apiError } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
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
    return apiError("Missing projectId or pageNumber", 400);
  }

  const access = await resolveProjectAccess({ dbId: projectId }, { allowDemo: true });
  if (access.error) return access.error;
  const { project } = access;

  const [pageRow] = await db
    .select({ textractData: pages.textractData })
    .from(pages)
    .where(and(eq(pages.projectId, project.id), eq(pages.pageNumber, pageNumber)))
    .limit(1);

  return NextResponse.json(
    { textractData: pageRow?.textractData || null },
    { headers: { "Cache-Control": "private, max-age=3600" } }
  );
}
