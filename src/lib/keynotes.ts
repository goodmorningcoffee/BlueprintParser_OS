import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile, rm, mkdtemp } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { KeynoteData } from "@/types";

const execFileAsync = promisify(execFile);

/**
 * Extract keynotes (architectural symbols) from a page image using
 * the Python OpenCV + Tesseract pipeline.
 *
 * @param pngBuffer - Rasterized page image as PNG
 * @returns Array of detected keynotes with shape, text, bbox, and contour
 */
export async function extractKeynotes(
  pngBuffer: Buffer
): Promise<KeynoteData[]> {
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

    // Log all stderr output for diagnostics (keynote counts, image size, etc.)
    if (stderr?.trim()) {
      console.log(`[KEYNOTE] ${stderr.trim()}`);
    }

    const results = JSON.parse(stdout.trim() || "[]");

    return results.map((r: any) => ({
      shape: r.shape || "circle",
      text: r.text || "",
      bbox: r.bbox || [0, 0, 0, 0],
      contour: r.contour || [],
    }));
  } catch (err: any) {
    // Log the full error including stderr so we can diagnose container issues
    const stderr = err?.stderr || "";
    const message = err?.message || String(err);
    console.error(
      `[KEYNOTE] Extraction failed:\n  Error: ${message}\n  Stderr: ${stderr}\n  Exit code: ${err?.code || "unknown"}`
    );
    return [];
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
