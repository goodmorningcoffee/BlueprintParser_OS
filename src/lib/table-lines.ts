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

const execFileAsync = promisify(execFile);

export interface TableLineGrid {
  rows: { y: number; height: number }[];   // normalized 0-1 within the crop
  cols: { x: number; width: number }[];    // normalized 0-1 within the crop
  rowCount: number;
  colCount: number;
  confidence: number;
}

/**
 * Detect table grid lines in a cropped region image using OpenCV.
 *
 * @param pngBuffer - PNG image of the cropped table region
 * @returns Detected grid structure with row/column positions
 */
export async function detectTableLines(
  pngBuffer: Buffer
): Promise<TableLineGrid> {
  const tempDir = await mkdtemp(join(tmpdir(), "bp2-tablelines-"));

  try {
    const imgPath = join(tempDir, "region.png");
    await writeFile(imgPath, pngBuffer);

    const scriptPath = join(process.cwd(), "scripts/detect_table_lines.py");

    const { stdout, stderr } = await execFileAsync(
      "python3",
      [scriptPath, imgPath],
      { timeout: 60000, maxBuffer: 10 * 1024 * 1024 }
    );

    if (stderr?.trim()) {
      console.log(`[TABLE_LINES] ${stderr.trim()}`);
    }

    const result = JSON.parse(stdout.trim() || "{}");

    if (result.error) {
      console.error(`[TABLE_LINES] Error: ${result.error}`);
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
    console.error("[TABLE_LINES] Script failed:", err);
    return { rows: [], cols: [], rowCount: 0, colCount: 0, confidence: 0 };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
