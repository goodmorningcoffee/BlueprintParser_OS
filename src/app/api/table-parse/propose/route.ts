import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { projects, pages } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { detectRowsAndColumns, type GridDetectOptions } from "@/lib/ocr-grid-detect";
import type { TextractPageData } from "@/types";

/**
 * POST /api/table-parse/propose
 *
 * Returns proposed row/column boundaries from OCR word clustering.
 * Used by guided parse flow — user can edit boundaries before parsing.
 */
export async function POST(req: Request) {
  const { session, error } = await requireAuth();
  if (error) return error;

  try {
    const body = await req.json();
    const { projectId, pageNumber, regionBbox, layoutHint, gridOptions } = body as {
      projectId: number;
      pageNumber: number;
      regionBbox: [number, number, number, number];
      layoutHint?: { columns?: number; tagColumnPosition?: "left" | "right" };
      gridOptions?: GridDetectOptions;
    };

    if (!projectId || !pageNumber || !regionBbox || regionBbox.length !== 4) {
      return NextResponse.json({ error: "Missing projectId, pageNumber, or regionBbox" }, { status: 400 });
    }

    // Bbox validation
    const [bx0, by0, bx1, by1] = regionBbox;
    if (![bx0, by0, bx1, by1].every((v) => typeof v === "number" && isFinite(v) && v >= 0 && v <= 1) || bx0 >= bx1 || by0 >= by1) {
      return NextResponse.json({ error: "Invalid regionBbox" }, { status: 400 });
    }

    // Verify project belongs to user's company
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, session.user.companyId)))
      .limit(1);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // Fetch page OCR data
    const [pageRow] = await db
      .select({ textractData: pages.textractData })
      .from(pages)
      .where(
        and(
          eq(pages.projectId, project.id),
          eq(pages.pageNumber, pageNumber),
        ),
      )
      .limit(1);

    if (!pageRow?.textractData) {
      return NextResponse.json({ error: "Page has no OCR data" }, { status: 404 });
    }

    const textractData = pageRow.textractData as TextractPageData;

    const proposal = detectRowsAndColumns(
      textractData.words,
      regionBbox,
      layoutHint,
      gridOptions,
    );

    return NextResponse.json({
      proposedRows: proposal.rowBoundaries,
      proposedCols: proposal.colBoundaries,
      rowCenters: proposal.rows.map((r) => r.yCenter),
      colCenters: proposal.cols.map((c) => c.center),
      rowCount: proposal.rows.length,
      colCount: proposal.cols.length,
      wordCount: proposal.wordCount,
      confidence: proposal.confidence,
    });
  } catch (err) {
    console.error("[table-parse/propose] Failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Grid proposal failed" },
      { status: 500 },
    );
  }
}
