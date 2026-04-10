/**
 * POST /api/shape-parse
 *
 * Runs the OpenCV + Tesseract "Shape Parse" (theta-style) extractor
 * on a single page. Detects architectural symbols (circles, diamonds,
 * hexagons etc.) that contain keynote text like A1, B-2, 1A.
 *
 * Returns: { keynotes: KeynoteShapeData[] }
 */

import { resolveProjectAccess, apiError } from "@/lib/api-utils";
import { downloadFromS3 } from "@/lib/s3";
import { rasterizePage } from "@/lib/pdf-rasterize";
import { extractKeynotes } from "@/lib/keynotes";
import { logger } from "@/lib/logger";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const body = await req.json();
  const { projectId, pageNumber } = body as {
    projectId: number;
    pageNumber: number;
  };

  if (!projectId || !pageNumber) {
    return apiError("Missing projectId or pageNumber", 400);
  }

  const access = await resolveProjectAccess({ dbId: projectId }, { allowDemo: true });
  if (access.error) return access.error;
  const { project } = access;

  if (!project.dataUrl) {
    return apiError("Project not found", 404);
  }

  try {
    // Prefer the pre-rendered page PNG; fall back to rasterizing the PDF.
    const s3Key = `${project.dataUrl}/pages/page_${String(pageNumber).padStart(4, "0")}.png`;
    let pngBuffer: Buffer | null = null;

    try {
      pngBuffer = await downloadFromS3(s3Key);
    } catch {
      // Fall back to on-demand rasterization from PDF
      try {
        const pdfBuffer = await downloadFromS3(`${project.dataUrl}/original.pdf`);
        pngBuffer = await rasterizePage(pdfBuffer, pageNumber, 300);
      } catch (err) {
        logger.error("[SHAPE_PARSE] Failed to load page image:", err);
        return apiError("Failed to load page image", 500);
      }
    }

    if (!pngBuffer) {
      return apiError("Page image unavailable", 500);
    }

    const keynotes = await extractKeynotes(pngBuffer);

    return NextResponse.json({ keynotes });
  } catch (err) {
    logger.error("[SHAPE_PARSE] Error:", err);
    const message = err instanceof Error ? err.message : "unknown";
    return apiError(`Shape parse failed: ${message}`, 500);
  }
}
