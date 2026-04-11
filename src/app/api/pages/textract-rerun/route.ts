/**
 * POST /api/pages/textract-rerun
 *
 * Force-refresh the cached Textract result for a single page. Downloads the
 * stored page PNG from S3, calls AnalyzeDocument fresh, overwrites the
 * `pages.textractData` row, and returns the new stats. Intended as a debug/
 * diagnostic tool — normal processing caches textract and never re-runs.
 */

import { resolveProjectAccess, apiError } from "@/lib/api-utils";
import { downloadFromS3 } from "@/lib/s3";
import { analyzePageImageWithFallback } from "@/lib/textract";
import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { logger } from "@/lib/logger";

export async function POST(req: Request) {
  const body = await req.json();
  const { projectId, pageNumber } = body as { projectId: number; pageNumber: number };

  if (!projectId || !pageNumber) {
    return apiError("Missing projectId or pageNumber", 400);
  }

  const access = await resolveProjectAccess({ dbId: projectId });
  if (access.error) return access.error;
  const { project } = access;

  if (!project.dataUrl) {
    return apiError("Project has no dataUrl", 404);
  }

  const [pageRow] = await db
    .select({ id: pages.id })
    .from(pages)
    .where(and(eq(pages.projectId, project.id), eq(pages.pageNumber, pageNumber)))
    .limit(1);
  if (!pageRow) {
    return apiError("Page not found", 404);
  }

  const s3Key = `${project.dataUrl}/pages/page_${String(pageNumber).padStart(4, "0")}.png`;
  let pngBuffer: Buffer;
  try {
    pngBuffer = await downloadFromS3(s3Key);
  } catch (err) {
    logger.error("[textract-rerun] S3 download failed:", err);
    return apiError("Failed to load page image from S3", 500);
  }

  const start = Date.now();
  let textractData;
  try {
    textractData = await analyzePageImageWithFallback(pngBuffer);
  } catch (err) {
    logger.error("[textract-rerun] Textract call failed:", err);
    const msg = err instanceof Error ? err.message : "Textract call failed";
    return apiError(msg, 500);
  }
  const durationMs = Date.now() - start;

  await db
    .update(pages)
    .set({ textractData })
    .where(eq(pages.id, pageRow.id));

  return Response.json({
    success: true,
    durationMs,
    stats: {
      wordCount: textractData.words?.length ?? 0,
      lineCount: textractData.lines?.length ?? 0,
      tableCount: textractData.tables?.length ?? 0,
    },
    textractData,
  });
}
