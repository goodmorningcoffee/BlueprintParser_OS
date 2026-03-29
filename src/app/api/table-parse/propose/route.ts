import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { projects, pages } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { detectRowsAndColumns } from "@/lib/ocr-grid-detect";
import type { TextractPageData } from "@/types";

/**
 * POST /api/table-parse/propose
 *
 * Returns proposed row/column boundaries from OCR word clustering.
 * Used by guided parse flow — user can edit boundaries before parsing.
 */
export async function POST(req: Request) {
  // Auth handled at project level — demo projects allowed without session
  try {
    const body = await req.json();
    const { projectId, pageNumber, regionBbox, layoutHint } = body as {
      projectId: number;
      pageNumber: number;
      regionBbox: [number, number, number, number];
      layoutHint?: { columns?: number; tagColumnPosition?: "left" | "right" };
    };

    if (!projectId || !pageNumber || !regionBbox || regionBbox.length !== 4) {
      return NextResponse.json({ error: "Missing projectId, pageNumber, or regionBbox" }, { status: 400 });
    }

    // Fetch page OCR data
    const [pageRow] = await db
      .select({ textractData: pages.textractData })
      .from(pages)
      .where(
        and(
          eq(pages.projectId, projectId),
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
