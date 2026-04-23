import { NextResponse } from "next/server";
import { resolveProjectAccess, apiError } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { parseNotesFromRegion } from "@/lib/text-region-classifier";
import { detectCsiFromGrid } from "@/lib/csi-detect";
import type { TextractPageData, BboxLTWH } from "@/types";
import { logger } from "@/lib/logger";

/**
 * POST /api/notes-parse
 *
 * Stage 4 Notes Auto mode. Takes a user-drawn region bbox and returns
 * the numbered-notes grid + detected CSI tags. Pure computation — no DB
 * writes, no state change. The client receives the preview, renders via
 * `parseDraftRegion` + `ParseRegionLayer` dashed overlay, and commits via
 * `POST /api/regions/promote`.
 *
 * Request:
 *   {
 *     projectId: number;
 *     pageNumber: number;
 *     regionBbox: [x0, y0, x1, y1];  // normalized 0-1, MinMax (matches keynote/table convention)
 *   }
 *
 * Response:
 *   {
 *     headers: string[];
 *     rows: Record<string, string>[];
 *     rowBoundaries?: number[];
 *     colBoundaries?: number[];
 *     csiTags: { code: string; description: string }[];
 *   }
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { projectId, pageNumber, regionBbox, autoSplitColumns } = body as {
      projectId: number;
      pageNumber: number;
      regionBbox: [number, number, number, number];
      autoSplitColumns?: boolean;
    };

    if (!projectId || !pageNumber || !regionBbox || regionBbox.length !== 4) {
      return apiError("Missing projectId, pageNumber, or regionBbox", 400);
    }

    const [x0, y0, x1, y1] = regionBbox;
    if (
      ![x0, y0, x1, y1].every((v) => typeof v === "number" && isFinite(v) && v >= 0 && v <= 1)
      || x0 >= x1 || y0 >= y1
    ) {
      return apiError("Invalid regionBbox: values must be finite numbers in [0,1] with min < max", 400);
    }

    const access = await resolveProjectAccess({ dbId: projectId }, { allowDemo: true });
    if (access.error) return access.error;
    const { project } = access;

    const [pageRow] = await db
      .select({ id: pages.id, textractData: pages.textractData })
      .from(pages)
      .where(and(eq(pages.projectId, project.id), eq(pages.pageNumber, pageNumber)))
      .limit(1);

    if (!pageRow?.textractData) {
      return apiError("Page has no OCR data", 404);
    }

    const textractData = pageRow.textractData as TextractPageData;
    // Classifier-internal convention is LTWH; client sends MinMax.
    const ltwhBbox: BboxLTWH = [x0, y0, x1 - x0, y1 - y0];

    const grid = parseNotesFromRegion(textractData, ltwhBbox, {
      autoSplitColumns: autoSplitColumns ?? true,
    });
    if (!grid) {
      return NextResponse.json({
        headers: [],
        rows: [],
        csiTags: [],
        note: "No numbered items detected in region",
      });
    }

    let csiTags: { code: string; description: string }[] = [];
    try {
      const detected = detectCsiFromGrid(grid.headers, grid.rows);
      csiTags = detected.map((c) => ({ code: c.code, description: c.description }));
    } catch (err) {
      logger.warn("[notes-parse] CSI detect failed (non-fatal):", err);
    }

    return NextResponse.json({
      headers: grid.headers,
      rows: grid.rows,
      rowBoundaries: grid.rowBoundaries,
      colBoundaries: grid.colBoundaries,
      csiTags,
    });
  } catch (err) {
    logger.error("[notes-parse] Failed:", err);
    return apiError(err instanceof Error ? err.message : "Notes parsing failed", 500);
  }
}
