import { NextResponse } from "next/server";
import { resolveProjectAccess, apiError } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { bindSpecSectionsInRegion } from "@/lib/specnote-parser";
import { detectCsiCodes } from "@/lib/csi-detect";
import type { CsiCode } from "@/types";
import type { TextractPageData } from "@/types";
import { logger } from "@/lib/logger";

/**
 * POST /api/spec-parse
 *
 * Stage 5 Spec Auto mode. Given a region bbox, returns the section-keyed
 * spec body + detected CSI tags. Pure computation — no DB writes. Client
 * commits via `POST /api/regions/promote` with `type: "spec"`.
 *
 * Request:
 *   {
 *     projectId: number;
 *     pageNumber: number;
 *     regionBbox: [x0, y0, x1, y1];  // normalized 0-1, MinMax
 *     includeSubSections?: boolean;  // opt-in split on 1.01 / 1.02 within a PART
 *   }
 *
 * Response:
 *   {
 *     sections: { sectionHeader: string; body: string }[];
 *     rowBoundaries?: number[];
 *     csiTags: { code: string; description: string }[];
 *   }
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
      return NextResponse.json({
        sections: [],
        csiTags: [],
        note: "No spec section headers detected in region",
      });
    }

    let csiTags: CsiCode[] = [];
    try {
      const bodyText = result.sections.map((s) => `${s.sectionHeader}\n${s.body}`).join("\n\n");
      csiTags = detectCsiCodes(bodyText);
    } catch (err) {
      logger.warn("[spec-parse] CSI detect failed (non-fatal):", err);
    }

    return NextResponse.json({
      sections: result.sections,
      rowBoundaries: result.rowBoundaries,
      csiTags,
    });
  } catch (err) {
    logger.error("[spec-parse] Failed:", err);
    return apiError(err instanceof Error ? err.message : "Spec parsing failed", 500);
  }
}
