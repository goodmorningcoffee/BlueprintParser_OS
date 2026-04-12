/**
 * POST /api/pages/csi-recompute
 *
 * Force-refresh the cached CSI code detection for a single page. Reads
 * existing Textract data from the DB (no S3/Textract round-trip), re-runs
 * detectCsiCodes with current detection logic, and overwrites `pages.csiCodes`.
 *
 * Admin debug tool — used when detection logic changes and you want to test
 * the effect on one page without reprocessing the entire project. Uses the
 * exact same detectCsiCodes code path as the bulk "Re-run All Processes"
 * button on the admin Overview tab, so the two always stay consistent.
 */

import { resolveProjectAccess, apiError } from "@/lib/api-utils";
import { detectCsiCodes } from "@/lib/csi-detect";
import { extractRawText } from "@/lib/textract";
import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { logger } from "@/lib/logger";
import type { TextractPageData } from "@/types";

export async function POST(req: Request) {
  const body = await req.json();
  const { projectId, pageNumber } = body as { projectId: number; pageNumber: number };

  if (!projectId || !pageNumber) {
    return apiError("Missing projectId or pageNumber", 400);
  }

  const access = await resolveProjectAccess({ dbId: projectId });
  if (access.error) return access.error;
  const { project } = access;

  const [pageRow] = await db
    .select({ id: pages.id, textractData: pages.textractData, rawText: pages.rawText })
    .from(pages)
    .where(and(eq(pages.projectId, project.id), eq(pages.pageNumber, pageNumber)))
    .limit(1);
  if (!pageRow) return apiError("Page not found", 404);
  if (!pageRow.textractData) return apiError("Page has no OCR data — run textract-rerun first", 400);

  const textractData = pageRow.textractData as TextractPageData;
  const rawText = pageRow.rawText || extractRawText(textractData);

  const start = Date.now();
  let csiCodes;
  try {
    csiCodes = detectCsiCodes(rawText, textractData.words);
  } catch (err) {
    logger.error("[csi-recompute] detectCsiCodes failed:", err);
    const msg = err instanceof Error ? err.message : "detectCsiCodes failed";
    return apiError(msg, 500);
  }
  const durationMs = Date.now() - start;

  await db.update(pages).set({ csiCodes }).where(eq(pages.id, pageRow.id));

  const triggerCount = csiCodes.reduce((n, c) => n + (c.triggers?.length || 0), 0);

  return Response.json({
    success: true,
    durationMs,
    stats: {
      codeCount: csiCodes.length,
      triggerCount,
      tradeCount: new Set(csiCodes.map((c) => c.trade)).size,
    },
    csiCodes,
  });
}
