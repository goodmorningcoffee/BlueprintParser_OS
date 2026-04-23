/**
 * POST /api/table-structure
 *
 * TATR (Table Transformer) post-processing endpoint.
 * Runs deep learning table structure recognition on a cropped table region.
 * Returns per-cell bounding boxes with row/col positions.
 *
 * This is a separate manual action triggered by "Detect Cell Structure" button,
 * not part of the normal table parse flow.
 */

import { NextResponse } from "next/server";
import { resolveProjectAccess, apiError } from "@/lib/api-utils";
import { assertDemoFeatureEnabled } from "@/lib/demo-features";
import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { downloadFromS3 } from "@/lib/s3";
import { rasterizePage } from "@/lib/pdf-rasterize";
import { detectTableStructure } from "@/lib/tatr-structure";
import type { TextractPageData, TextractWord } from "@/types";
import { logger } from "@/lib/logger";
import { writeFile, rm, mkdtemp } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export async function POST(req: Request) {
  const body = await req.json();

  const {
    projectId,
    pageNumber,
    regionBbox,
    confidenceThreshold = 0.5,
  } = body as {
    projectId: number;
    pageNumber: number;
    regionBbox: [number, number, number, number];
    confidenceThreshold?: number;
  };

  if (!projectId || !pageNumber || !regionBbox || regionBbox.length !== 4) {
    return apiError("Missing projectId, pageNumber, or regionBbox", 400);
  }

  const access = await resolveProjectAccess({ dbId: projectId }, { allowDemo: true });
  if (access.error) return access.error;
  const { project } = access;

  if (project.isDemo) {
    const gate = await assertDemoFeatureEnabled(project.companyId, "tableParse");
    if (gate) return gate;
  }

  const tempDir = await mkdtemp(join(tmpdir(), "bp2-tatr-route-"));

  try {
    // Download PDF via AWS SDK (uses credentials, works with private buckets)
    let pdfBuffer: Buffer;
    try {
      pdfBuffer = await downloadFromS3(`${project.dataUrl}/original.pdf`);
    } catch (err) {
      logger.error("[TABLE_STRUCTURE] PDF download failed", { dataUrl: project.dataUrl, err });
      return apiError(`Failed to fetch PDF: ${err instanceof Error ? err.message : "unknown"}`, 500);
    }
    const pagePng = await rasterizePage(pdfBuffer, pageNumber, 200);

    // Get image dimensions
    const imgW = pagePng.readUInt32BE(16);
    const imgH = pagePng.readUInt32BE(20);

    // Crop to region using Python/OpenCV
    const [rx0, ry0, rx1, ry1] = regionBbox;
    const cropX = Math.round(rx0 * imgW);
    const cropY = Math.round(ry0 * imgH);
    const cropW = Math.max(1, Math.round((rx1 - rx0) * imgW));
    const cropH = Math.max(1, Math.round((ry1 - ry0) * imgH));

    const fullPagePath = join(tempDir, "page.png");
    const croppedPath = join(tempDir, "cropped.png");
    await writeFile(fullPagePath, pagePng);

    const cropScript = `
import cv2, json, sys
cfg = json.loads(sys.argv[1])
img = cv2.imread(cfg["src"])
crop = img[cfg["y"]:cfg["y"]+cfg["h"], cfg["x"]:cfg["x"]+cfg["w"]]
cv2.imwrite(cfg["dst"], crop)
`.trim();

    await execFileAsync("python3", [
      "-c", cropScript,
      JSON.stringify({ src: fullPagePath, dst: croppedPath, x: cropX, y: cropY, w: cropW, h: cropH }),
    ], { timeout: 10000 });

    // Read cropped image
    const { readFile } = await import("fs/promises");
    const croppedBuffer = await readFile(croppedPath);

    // Run TATR structure detection
    const tatrResult = await detectTableStructure(croppedBuffer, confidenceThreshold);

    if (tatrResult.error) {
      return NextResponse.json({ error: tatrResult.error, cells: [], rows: [], columns: [], confidence: 0 });
    }

    // Map cell bboxes from crop-relative (0-1) to page-relative (0-1)
    const regionW = rx1 - rx0;
    const regionH = ry1 - ry0;

    const pageCells = tatrResult.cells.map((cell) => ({
      ...cell,
      bbox: [
        rx0 + cell.bbox[0] * regionW,
        ry0 + cell.bbox[1] * regionH,
        rx0 + cell.bbox[2] * regionW,
        ry0 + cell.bbox[3] * regionH,
      ] as [number, number, number, number],
    }));

    // Fill cell text from Textract OCR words
    const [pageRow] = await db
      .select({ textractData: pages.textractData })
      .from(pages)
      .where(and(eq(pages.projectId, project.id), eq(pages.pageNumber, pageNumber)))
      .limit(1);

    if (pageRow?.textractData) {
      const textractData = pageRow.textractData as TextractPageData;
      for (const cell of pageCells) {
        const [cx0, cy0, cx1, cy1] = cell.bbox;
        const wordsInCell = textractData.words.filter((w: TextractWord) => {
          const wcx = w.bbox[0] + w.bbox[2] / 2;
          const wcy = w.bbox[1] + w.bbox[3] / 2;
          return wcx >= cx0 && wcx <= cx1 && wcy >= cy0 && wcy <= cy1;
        });
        cell.text = wordsInCell
          .sort((a: TextractWord, b: TextractWord) => a.bbox[0] - b.bbox[0])
          .map((w: TextractWord) => w.text)
          .join(" ");
      }
    }

    return NextResponse.json({
      cells: pageCells,
      rows: tatrResult.rows,
      columns: tatrResult.columns,
      confidence: tatrResult.confidence,
    });
  } catch (err) {
    logger.error("[table-structure] Failed:", err);
    return apiError(err instanceof Error ? err.message : "Table structure detection failed", 500);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
