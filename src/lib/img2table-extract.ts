/**
 * img2table-extract.ts — TypeScript wrapper for img2table Python extraction.
 *
 * Spawns scripts/img2table_extract.py, sends config via stdin, reads JSON from stdout.
 * img2table uses Hough Transform + morphological operations with built-in
 * skew correction and merged cell detection.
 */

import { spawn } from "child_process";
import { writeFile, rm, mkdtemp } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { logger } from "@/lib/logger";
import type { MethodResult } from "@/lib/grid-merger";

const EMPTY: MethodResult = { method: "img2table", headers: [], rows: [], confidence: 0 };

/**
 * Extract a table from a page image using img2table.
 *
 * @param pngBuffer - Rasterized page image (full page PNG)
 * @param regionBbox - [minX, minY, maxX, maxY] normalized 0-1
 */
export async function extractWithImg2Table(
  pngBuffer: Buffer,
  regionBbox: [number, number, number, number],
): Promise<MethodResult> {
  const tempDir = await mkdtemp(join(tmpdir(), "bp2-img2table-"));

  try {
    const imgPath = join(tempDir, "page.png");
    await writeFile(imgPath, pngBuffer);

    const scriptPath = join(process.cwd(), "scripts/img2table_extract.py");
    const config = JSON.stringify({ image_path: imgPath, region_bbox: regionBbox });

    return await new Promise<MethodResult>((resolve) => {
      const proc = spawn("python3", [scriptPath], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve(EMPTY);
      }, 30_000);

      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d) => { stdout += d.toString(); });
      proc.stderr.on("data", (d) => { stderr += d.toString(); });

      proc.on("close", () => {
        clearTimeout(timer);
        if (stderr.trim()) logger.info(`[img2table] ${stderr.trim()}`);
        try {
          const result = JSON.parse(stdout.trim() || "{}");
          resolve({
            method: result.method || "img2table",
            headers: result.headers || [],
            rows: result.rows || [],
            confidence: result.confidence || 0,
            colBoundaries: result.colBoundaries,
            rowBoundaries: result.rowBoundaries,
            ...(result.error ? { error: result.error } : {}),
          });
        } catch {
          logger.error("[img2table] Failed to parse output");
          resolve(EMPTY);
        }
      });

      proc.on("error", () => {
        clearTimeout(timer);
        resolve(EMPTY);
      });

      proc.stdin.write(config);
      proc.stdin.end();
    });
  } catch (err) {
    logger.error("[img2table] Wrapper failed:", err);
    return EMPTY;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
