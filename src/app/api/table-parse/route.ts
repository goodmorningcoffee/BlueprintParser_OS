import { NextResponse } from "next/server";
import { resolveProjectAccess, apiError } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { downloadFromS3 } from "@/lib/s3";
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
    return apiError("Missing projectId, pageNumber, or regionBbox", 400);
  }

  const [bx0, by0, bx1, by1] = regionBbox;
  if (![bx0, by0, bx1, by1].every((v) => typeof v === "number" && isFinite(v) && v >= 0 && v <= 1) || bx0 >= bx1 || by0 >= by1) {
    return apiError("Invalid regionBbox: values must be finite numbers in [0,1] with min < max", 400);
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
      return apiError("Page has no OCR data", 404);
    }

    const textractData = pageRow.textractData as TextractPageData;

    // Fetch PDF + rasterize for image-based methods.
    // Phase A.1: capture infrastructure failures explicitly so the UI can
    // distinguish "method ran and found nothing" from "method never ran".
    const infraErrors: { stage: string; error: string }[] = [];
    let pdfBuffer: Buffer | null = null;
    let pagePngBuffer: Buffer | null = null;

    // Phase B.4: use AWS SDK directly (matches /api/table-structure/route.ts).
    // Previously used fetch(getS3Url(...)) which silently failed on private S3
    // buckets when CloudFront isn't configured — that was the most likely
    // production root cause for img2table appearing to "do nothing".
    try {
      pdfBuffer = await downloadFromS3(`${project.dataUrl}/original.pdf`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      infraErrors.push({ stage: "pdf-download", error: msg });
      logger.error(`[table-parse] PDF download failed: ${msg}`, { projectId, pageNumber, dataUrl: project.dataUrl });
    }

    if (pdfBuffer) {
      try {
        pagePngBuffer = await rasterizePage(pdfBuffer, pageNumber, 200);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        infraErrors.push({ stage: "rasterize", error: msg });
        logger.error(`[table-parse] Rasterize failed: ${msg}`, { projectId, pageNumber, pdfBytes: pdfBuffer.length });
      }
    }

    // Run methods in parallel. Methods that need PDF/PNG that we don't have
    // get an explicit "skipped" error so the UI can show why they're missing
    // instead of silently displaying an empty result as success.
    const skippedReason = (need: string) =>
      infraErrors.length > 0
        ? `skipped: ${need} unavailable (see infraErrors)`
        : `skipped: ${need} unavailable`;

    const methodPromises: Promise<MethodResult | MethodResult[]>[] = [
      Promise.resolve(methodOcrPositions(textractData.words, regionBbox, { rowTolerance, minColGap, colHitRatio, headerMode })),
      Promise.resolve(methodTextractTables(textractData.tables, regionBbox)),
      pagePngBuffer && pdfBuffer
        ? methodOpenCvLines(pdfBuffer, pageNumber, regionBbox, textractData.words, { minHLineLengthRatio, minVLineLengthRatio, clusteringTolerance })
        : Promise.resolve({ method: "opencv-lines", headers: [], rows: [], confidence: 0, error: skippedReason("page image") } as MethodResult),
      // Phase C.3: img2table now accepts both pdfBuffer (for native PDF mode)
      // and pngBuffer (for image mode + auto-fallback). After Phase B.4 the
      // pdfBuffer is reliably populated via downloadFromS3, so PDF mode runs
      // by default. Image mode is the fallback if PDF mode finds nothing.
      (pdfBuffer || pagePngBuffer)
        ? extractWithImg2Table(pdfBuffer, pagePngBuffer, pageNumber, regionBbox)
        : Promise.resolve({ method: "img2table", headers: [], rows: [], confidence: 0, error: skippedReason("PDF and page image") } as MethodResult),
      pdfBuffer
        ? extractWithCamelotPdfplumber(pdfBuffer, pageNumber, regionBbox)
        : Promise.resolve([
            { method: "camelot-lattice", headers: [], rows: [], confidence: 0, error: skippedReason("PDF") } as MethodResult,
            { method: "camelot-stream", headers: [], rows: [], confidence: 0, error: skippedReason("PDF") } as MethodResult,
            { method: "pdfplumber", headers: [], rows: [], confidence: 0, error: skippedReason("PDF") } as MethodResult,
          ]),
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

    // Phase D.1: include the full per-method results so the UI can show each
    // method's individual grid, not just the shape summary in merged.methods.
    // Filter to only methods that have data OR error — drop silent no-ops.
    const methodResults = results.filter((r) => (r.headers.length > 0 && r.rows.length > 0) || r.error);

    return NextResponse.json({ ...merged, methodResults, infraErrors });
  } catch (err) {
    logger.error("[table-parse] Failed:", err);
    return apiError(err instanceof Error ? err.message : "Table parsing failed", 500);
  }
}
