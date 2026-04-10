import { NextResponse } from "next/server";
import { resolveProjectAccess } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { getS3Url } from "@/lib/s3";
import { rasterizePage } from "@/lib/pdf-rasterize";
import { mergeGrids, type MethodResult } from "@/lib/grid-merger";
import type { TextractPageData } from "@/types";
import { detectCsiFromGrid } from "@/lib/csi-detect";
import { extractWithImg2Table } from "@/lib/img2table-extract";
import { extractWithCamelotPdfplumber } from "@/lib/camelot-extract";
import { methodOcrPositions, methodTextractTables, methodOpenCvLines } from "@/lib/services/table-parse";
import { logger } from "@/lib/logger";

/**
 * POST /api/table-parse
 *
 * Runs multiple parsing methods on a user-selected table region,
 * merges results, and returns the best grid.
 */
export async function POST(req: Request) {
  const body = await req.json();
  const {
    projectId, pageNumber, regionBbox,
    rowTolerance, minColGap, colHitRatio, headerMode,
    minHLineLengthRatio, minVLineLengthRatio, clusteringTolerance,
    mergerEditDistance,
  } = body as {
    projectId: number;
    pageNumber: number;
    regionBbox: [number, number, number, number];
    rowTolerance?: number;
    minColGap?: number;
    colHitRatio?: number;
    headerMode?: "auto" | "first" | "none";
    minHLineLengthRatio?: number;
    minVLineLengthRatio?: number;
    clusteringTolerance?: number;
    mergerEditDistance?: number;
  };

  if (!projectId || !pageNumber || !regionBbox || regionBbox.length !== 4) {
    return NextResponse.json({ error: "Missing projectId, pageNumber, or regionBbox" }, { status: 400 });
  }

  const [bx0, by0, bx1, by1] = regionBbox;
  if (![bx0, by0, bx1, by1].every((v) => typeof v === "number" && isFinite(v) && v >= 0 && v <= 1) || bx0 >= bx1 || by0 >= by1) {
    return NextResponse.json({ error: "Invalid regionBbox: values must be finite numbers in [0,1] with min < max" }, { status: 400 });
  }

  const access = await resolveProjectAccess({ dbId: projectId }, { allowDemo: true });
  if (access.error) return access.error;
  const { project } = access;

  try {
    const [pageRow] = await db
      .select({ textractData: pages.textractData })
      .from(pages)
      .where(and(eq(pages.projectId, project.id), eq(pages.pageNumber, pageNumber)))
      .limit(1);

    if (!pageRow?.textractData) {
      return NextResponse.json({ error: "Page has no OCR data" }, { status: 404 });
    }

    const textractData = pageRow.textractData as TextractPageData;

    // Fetch PDF + rasterize for image-based methods
    let pdfBuffer: Buffer | null = null;
    let pagePngBuffer: Buffer | null = null;
    try {
      const pdfUrl = getS3Url(project.dataUrl!, "original.pdf");
      const pdfResp = await fetch(pdfUrl);
      if (pdfResp.ok) pdfBuffer = Buffer.from(await pdfResp.arrayBuffer());
    } catch { /* PDF fetch failed — skip image/PDF-dependent methods */ }

    if (pdfBuffer) {
      try {
        pagePngBuffer = await rasterizePage(pdfBuffer, pageNumber, 150);
      } catch { /* rasterization failed */ }
    }

    // Run all 7 methods in parallel
    const methodPromises: Promise<MethodResult | MethodResult[]>[] = [
      Promise.resolve(methodOcrPositions(textractData.words, regionBbox, { rowTolerance, minColGap, colHitRatio, headerMode })),
      Promise.resolve(methodTextractTables(textractData.tables, regionBbox)),
      pagePngBuffer && pdfBuffer
        ? methodOpenCvLines(pdfBuffer, pageNumber, regionBbox, textractData.words, { minHLineLengthRatio, minVLineLengthRatio, clusteringTolerance })
        : Promise.resolve({ method: "opencv-lines", headers: [], rows: [], confidence: 0 } as MethodResult),
      pagePngBuffer
        ? extractWithImg2Table(pagePngBuffer, regionBbox)
        : Promise.resolve({ method: "img2table", headers: [], rows: [], confidence: 0 } as MethodResult),
      pdfBuffer
        ? extractWithCamelotPdfplumber(pdfBuffer, pageNumber, regionBbox)
        : Promise.resolve([] as MethodResult[]),
    ];

    const rawResults = await Promise.all(methodPromises);
    const results: MethodResult[] = rawResults.flat() as MethodResult[];

    logger.info(
      `[table-parse] Page ${pageNumber}: ` +
      results.map((r) => `${r.method}=${r.confidence.toFixed(2)} (${r.rows.length}r×${r.headers.length}c)`).join(", ")
    );

    const merged = mergeGrids(results, { editDistanceThreshold: mergerEditDistance });

    // Auto-detect CSI codes from parsed content
    try {
      const csiCodes = detectCsiFromGrid(merged.headers || [], merged.rows || []);
      (merged as any).csiTags = csiCodes.map((c) => ({ code: c.code, description: c.description }));
    } catch { /* CSI detection is best-effort */ }

    return NextResponse.json(merged);
  } catch (err) {
    logger.error("[table-parse] Failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Table parsing failed" },
      { status: 500 }
    );
  }
}
