import { NextResponse } from "next/server";
import { resolveProjectAccess, apiError } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { bindSpecSectionsInRegion } from "@/lib/specnote-parser";
import type { TextractPageData } from "@/types";
import { logger } from "@/lib/logger";

/**
 * POST /api/spec-parse/propose
 *
 * Stage 5 Spec Paragraph / Guided mode — returns the per-section Y
 * boundaries so the client can place draggable section splits on the
 * canvas. After the user adjusts, the grid data ships to
 * `POST /api/regions/promote` with `type: "spec"`.
 *
 * Request:
 *   { projectId: number; pageNumber: number; regionBbox: [x0, y0, x1, y1]; includeSubSections?: boolean }
 *
 * Response:
 *   { proposedRows: number[] }
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { projectId, pageNumber, regionBbox, includeSubSections } = body as {
      projectId: number;
      pageNumber: number;
      regionBbox: [number, number, number, number];
      includeSubSections?: boolean;
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
    const result = bindSpecSectionsInRegion(
      textractData.lines,
      [x0, y0, x1 - x0, y1 - y0],
      { includeSubSections: !!includeSubSections },
    );

    if (!result) {
      return NextResponse.json({ proposedRows: [] });
    }

    return NextResponse.json({ proposedRows: result.rowBoundaries ?? [] });
  } catch (err) {
    logger.error("[spec-parse/propose] Failed:", err);
    return apiError(err instanceof Error ? err.message : "Spec boundary proposal failed", 500);
  }
}
