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
  const { projectId, pageNumber, regionBbox } = body as {
    projectId: number;
    pageNumber: number;
    regionBbox?: [number, number, number, number];
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

    let inputBuffer = pngBuffer;
    let offsetX = 0;
    let offsetY = 0;
    let regionW = 1;
    let regionH = 1;

    // Crop to user-drawn region if provided — reduces noise, improves accuracy
    if (regionBbox && regionBbox.length === 4) {
      const [minX, minY, maxX, maxY] = regionBbox;
      try {
        const sharp = (await import("sharp")).default;
        const meta = await sharp(pngBuffer).metadata();
        const imgW = meta.width || 1;
        const imgH = meta.height || 1;
        const cropX = Math.max(0, Math.round(minX * imgW));
        const cropY = Math.max(0, Math.round(minY * imgH));
        const cropW = Math.min(imgW - cropX, Math.round((maxX - minX) * imgW));
        const cropH = Math.min(imgH - cropY, Math.round((maxY - minY) * imgH));
        if (cropW > 10 && cropH > 10) {
          inputBuffer = await sharp(pngBuffer)
            .extract({ left: cropX, top: cropY, width: cropW, height: cropH })
            .png()
            .toBuffer();
          offsetX = minX;
          offsetY = minY;
          regionW = maxX - minX;
          regionH = maxY - minY;
        }
      } catch (err) {
        logger.warn("[SHAPE_PARSE] Region crop failed, using full page:", err);
      }
    }

    const { keynotes, warnings } = await extractKeynotes(inputBuffer);

    // Remap cropped coordinates back to full-page normalized space
    const remapped = keynotes.map((k) => ({
      ...k,
      bbox: [
        offsetX + k.bbox[0] * regionW,
        offsetY + k.bbox[1] * regionH,
        offsetX + k.bbox[2] * regionW,
        offsetY + k.bbox[3] * regionH,
      ] as [number, number, number, number],
      contour: k.contour?.map(([cx, cy]: [number, number]) => [
        offsetX + cx * regionW,
        offsetY + cy * regionH,
      ] as [number, number]),
    }));

    return NextResponse.json({ keynotes: remapped, warnings });
  } catch (err) {
    logger.error("[SHAPE_PARSE] Error:", err);
    const message = err instanceof Error ? err.message : "unknown";
    return apiError(`Shape parse failed: ${message}`, 500);
  }
}
