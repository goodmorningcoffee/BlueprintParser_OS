import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile, rm, mkdtemp } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { KeynoteShapeData } from "@/types";
import { logger } from "@/lib/logger";

const execFileAsync = promisify(execFile);

/**
 * Extract keynotes (architectural symbols) from a page image using
 * the Python OpenCV + Tesseract pipeline.
 *
 * @param pngBuffer - Rasterized page image as PNG
 * @returns Array of detected keynotes with shape, text, bbox, and contour
 */
export interface KeynoteExtractionResult {
  keynotes: KeynoteShapeData[];
  warnings: string[];
}

export async function extractKeynotes(
  pngBuffer: Buffer
): Promise<KeynoteExtractionResult> {
  const tempDir = await mkdtemp(join(tmpdir(), "bp2-keynote-"));

  try {
    const imgPath = join(tempDir, "page.png");
    await writeFile(imgPath, pngBuffer);

    const scriptPath = join(process.cwd(), "scripts/extract_keynotes.py");

    const { stdout, stderr } = await execFileAsync(
      "python3",
      [scriptPath, imgPath],
      { timeout: 180000, maxBuffer: 50 * 1024 * 1024 }
    );

    if (stderr?.trim()) {
      logger.info(`[KEYNOTE] ${stderr.trim()}`);
    }

    const parsed = JSON.parse(stdout.trim() || "[]");
    const rawResults = Array.isArray(parsed) ? parsed : parsed.results || [];
    const warnings: string[] = Array.isArray(parsed) ? [] : parsed.warnings || [];

    const keynotes = rawResults.map((r: any) => ({
      shape: r.shape || "circle",
      text: r.text || "",
      bbox: r.bbox || [0, 0, 0, 0],
      contour: r.contour || [],
    }));

    return { keynotes, warnings };
  } catch (err: any) {
    const stderr = err?.stderr || "";
    const message = err?.message || String(err);
    logger.error(
      `[KEYNOTE] Extraction failed:\n  Error: ${message}\n  Stderr: ${stderr}\n  Exit code: ${err?.code || "unknown"}`
    );
    return { keynotes: [], warnings: [`Extraction failed: ${message}`] };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
