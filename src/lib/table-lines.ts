/**
 * table-lines.ts — OpenCV line detection for table grid structure.
 *
 * Calls the Python script detect_table_lines.py on a cropped table region image.
 * Returns detected row/column line positions for grid construction.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile, rm, mkdtemp } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { logger } from "@/lib/logger";

const execFileAsync = promisify(execFile);

export interface TableLineGrid {
  rows: { y: number; height: number }[];   // normalized 0-1 within the crop
  cols: { x: number; width: number }[];    // normalized 0-1 within the crop
  rowCount: number;
  colCount: number;
  confidence: number;
}

export interface TableLineOptions {
  minHLineLengthRatio?: number;
  minVLineLengthRatio?: number;
  clusteringTolerance?: number;
}

/**
 * Detect table grid lines in a cropped region image using OpenCV.
 *
 * @param pngBuffer - PNG image of the cropped table region
 * @param options - Tunable parameters for line detection
 * @returns Detected grid structure with row/column positions
 */
export async function detectTableLines(
  pngBuffer: Buffer,
  options?: TableLineOptions,
): Promise<TableLineGrid> {
  const tempDir = await mkdtemp(join(tmpdir(), "bp2-tablelines-"));

  try {
    const imgPath = join(tempDir, "region.png");
    await writeFile(imgPath, pngBuffer);

    const scriptPath = join(process.cwd(), "scripts/detect_table_lines.py");

    // Pass tuning params as CLI args: --min-h-length 0.15 --min-v-length 0.10 --tolerance 15
    const args = [scriptPath, imgPath];
    if (options?.minHLineLengthRatio != null) args.push("--min-h-length", String(options.minHLineLengthRatio));
    if (options?.minVLineLengthRatio != null) args.push("--min-v-length", String(options.minVLineLengthRatio));
    if (options?.clusteringTolerance != null) args.push("--tolerance", String(options.clusteringTolerance));

    const { stdout, stderr } = await execFileAsync(
      "python3",
      args,
      { timeout: 60000, maxBuffer: 10 * 1024 * 1024 }
    );

    if (stderr?.trim()) {
      logger.info(`[TABLE_LINES] ${stderr.trim()}`);
    }

    const result = JSON.parse(stdout.trim() || "{}");

    if (result.error) {
      logger.error(`[TABLE_LINES] Error: ${result.error}`);
      return { rows: [], cols: [], rowCount: 0, colCount: 0, confidence: 0 };
    }

    return {
      rows: result.rows || [],
      cols: result.cols || [],
      rowCount: result.rowCount || 0,
      colCount: result.colCount || 0,
      confidence: result.confidence || 0,
    };
  } catch (err) {
    logger.error("[TABLE_LINES] Script failed:", err);
    return { rows: [], cols: [], rowCount: 0, colCount: 0, confidence: 0 };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
