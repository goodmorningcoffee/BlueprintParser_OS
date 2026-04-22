import { NextResponse } from "next/server";
import { resolveProjectAccess, apiError } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { parseNotesFromRegion } from "@/lib/text-region-classifier";
import type { TextractPageData, BboxLTWH } from "@/types";
import { logger } from "@/lib/logger";

/**
 * POST /api/notes-parse/propose
 *
 * Stage 4 Notes Guided mode. Returns row/column boundary proposals for
 * a user-drawn region so the client can place draggable lines on the
 * canvas via `GuidedParseOverlay`. After the user adjusts, the client
 * extracts the grid via `extractCellsFromGrid` and commits through
 * `POST /api/regions/promote`.
 *
 * Structural bones mirror `/api/table-parse/propose` (auth + page load +
 * error shape); the detection path is notes-specific because notes don't
 * have Textract TABLES output like schedules do.
 *
 * Request:
 *   { projectId: number; pageNumber: number; regionBbox: [x0, y0, x1, y1] }
 *
 * Response:
 *   { proposedRows: number[]; proposedCols: number[] }
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { projectId, pageNumber, regionBbox } = body as {
      projectId: number;
      pageNumber: number;
      regionBbox: [number, number, number, number];
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
    const ltwhBbox: BboxLTWH = [x0, y0, x1 - x0, y1 - y0];

    const grid = parseNotesFromRegion(textractData, ltwhBbox);
    if (!grid) {
      return NextResponse.json({ proposedRows: [], proposedCols: [] });
    }

    return NextResponse.json({
      proposedRows: grid.rowBoundaries ?? [],
      proposedCols: grid.colBoundaries ?? [],
    });
  } catch (err) {
    logger.error("[notes-parse/propose] Failed:", err);
    return apiError(err instanceof Error ? err.message : "Notes boundary proposal failed", 500);
  }
}
