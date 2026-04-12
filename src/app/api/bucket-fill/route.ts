/**
 * POST /api/bucket-fill
 *
 * Bucket Fill tool endpoint. Accepts a seed point click and returns a polygon
 * outlining the enclosing room/region via OpenCV flood fill.
 *
 * Optional barrier lines can be drawn by the user to seal doorways before filling.
 */

import { resolveProjectAccess, apiError } from "@/lib/api-utils";
import { getS3Url, downloadFromS3 } from "@/lib/s3";
import { rasterizePage } from "@/lib/pdf-rasterize";
import { writeFile, rm, mkdtemp } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { bucketFill } from "@/lib/bucket-fill";
import { logger } from "@/lib/logger";

export async function POST(req: Request) {
  const body = await req.json();
  const {
    projectId,
    pageNumber,
    seedPoint,
    tolerance = 30,
    dilate = 3,
    simplifyEpsilon = 0.005,
    barriers = [],
    polygonBarriers = [],
  } = body as {
    projectId: number;
    pageNumber: number;
    seedPoint: { x: number; y: number };
    tolerance?: number;
    dilate?: number;
    simplifyEpsilon?: number;
    barriers?: Array<{ x1: number; y1: number; x2: number; y2: number }>;
    polygonBarriers?: Array<{ vertices: Array<{ x: number; y: number }> }>;
  };

  if (!projectId || !pageNumber || !seedPoint) {
    return apiError("Missing projectId, pageNumber, or seedPoint", 400);
  }

  const { x, y } = seedPoint;
  if (typeof x !== "number" || typeof y !== "number" || x < 0 || x > 1 || y < 0 || y > 1) {
    return apiError("Invalid seedPoint (must be normalized 0-1)", 400);
  }

  const access = await resolveProjectAccess({ dbId: projectId }, { allowDemo: true });
  if (access.error) return access.error;
  const { project } = access;

  if (!project.dataUrl) {
    return apiError("Project not found", 404);
  }

  const tempDir = await mkdtemp(join(tmpdir(), "bp2-bucket-fill-"));

  try {
    // Download PDF for vector mode
    const pdfUrl = getS3Url(project.dataUrl, "original.pdf");
    const pdfResp = await fetch(pdfUrl);
    if (!pdfResp.ok) {
      return apiError("Failed to fetch PDF", 500);
    }
    const pdfBuffer = Buffer.from(await pdfResp.arrayBuffer());
    const pdfPath = join(tempDir, "original.pdf");
    await writeFile(pdfPath, pdfBuffer);

    // Download page PNG for raster fallback
    const s3Key = `${project.dataUrl}/pages/page_${String(pageNumber).padStart(4, "0")}.png`;
    let pngBuffer: Buffer | null = null;
    try {
      pngBuffer = await downloadFromS3(s3Key);
    } catch {
      try {
        pngBuffer = await rasterizePage(pdfBuffer, pageNumber, 200);
      } catch (err) {
        logger.error("[BUCKET_FILL] Failed to rasterize page:", err);
        return apiError("Failed to load page image", 500);
      }
    }

    const imagePath = join(tempDir, `page_${String(pageNumber).padStart(4, "0")}.png`);
    await writeFile(imagePath, pngBuffer);

    // Run bucket fill (tries vector first via PDF, falls back to raster via PNG)
    const result = await bucketFill({
      imagePath,
      pdfPath,
      pageNumber,
      seedX: x,
      seedY: y,
      tolerance,
      dilatePx: dilate,
      simplifyEpsilon,
      barriers,
      polygonBarriers,
    });

    return Response.json(result);
  } catch (err) {
    logger.error("[BUCKET_FILL] Error:", err);
    return apiError("Bucket fill failed", 500);
  } finally {
    rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
