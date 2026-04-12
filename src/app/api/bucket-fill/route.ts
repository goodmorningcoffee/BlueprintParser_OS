/**
 * POST /api/bucket-fill
 *
 * Bucket Fill tool endpoint. Accepts a seed point click and returns a polygon
 * outlining the enclosing room/region via OpenCV flood fill.
 *
 * Optional barrier lines can be drawn by the user to seal doorways before filling.
 */

import { resolveProjectAccess, apiError } from "@/lib/api-utils";
import { downloadFromS3 } from "@/lib/s3";
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
    // Happy path: download pre-rendered PNG from S3 (no PDF fetch needed)
    const s3Key = `${project.dataUrl}/pages/page_${String(pageNumber).padStart(4, "0")}.png`;
    let pngBuffer: Buffer | null = null;
    try {
      pngBuffer = await downloadFromS3(s3Key);
    } catch {
      // Fallback: PNG missing from S3 — fetch PDF and rasterize
      logger.warn(`[BUCKET_FILL] PNG missing at ${s3Key}, falling back to PDF rasterize`);
      try {
        const pdfBuffer = await downloadFromS3(`${project.dataUrl}/original.pdf`);
        pngBuffer = await rasterizePage(pdfBuffer, pageNumber, 200);
      } catch (err) {
        logger.error("[BUCKET_FILL] Failed to rasterize page:", err);
        return apiError("Failed to load page image", 500);
      }
    }

    const imagePath = join(tempDir, `page_${String(pageNumber).padStart(4, "0")}.png`);
    await writeFile(imagePath, pngBuffer);

    // Raster-only flood fill (vector mode removed)
    const result = await bucketFill({
      imagePath,
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
