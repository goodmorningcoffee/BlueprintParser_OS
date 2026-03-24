import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile, readFile, mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

const execFileAsync = promisify(execFile);

/**
 * Rasterize a single page of a PDF to a PNG buffer using Ghostscript.
 *
 * @param pdfBuffer - The full PDF file as a Buffer
 * @param pageNumber - 1-based page number to rasterize
 * @param dpi - Resolution (default 200 — good balance for Textract on blueprints)
 * @returns PNG image buffer
 */
export async function rasterizePage(
  pdfBuffer: Buffer,
  pageNumber: number,
  dpi: number = 200
): Promise<Buffer> {
  const tempDir = await mkdtemp(join(tmpdir(), "bp2-raster-"));

  try {
    const pdfPath = join(tempDir, "input.pdf");
    const outputPath = join(tempDir, "output.png");

    await writeFile(pdfPath, pdfBuffer);

    await execFileAsync("gs", [
      "-dNOPAUSE",
      "-dBATCH",
      "-dSAFER",
      "-sDEVICE=png16m",
      `-dFirstPage=${pageNumber}`,
      `-dLastPage=${pageNumber}`,
      `-r${dpi}`,
      `-sOutputFile=${outputPath}`,
      pdfPath,
    ]);

    return await readFile(outputPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Get the page count of a PDF using Ghostscript.
 * Renders to nullpage device and counts pages processed.
 */
export async function getPdfPageCount(pdfBuffer: Buffer): Promise<number> {
  const tempDir = await mkdtemp(join(tmpdir(), "bp2-count-"));

  try {
    const pdfPath = join(tempDir, "input.pdf");
    await writeFile(pdfPath, pdfBuffer);

    // Use PostScript to read page count directly from the PDF
    // execFile passes args without shell, so PostScript parens are safe
    const { stdout } = await execFileAsync("gs", [
      "-q",
      "-dNODISPLAY",
      "-dBATCH",
      "-c",
      `(${pdfPath}) (r) file runpdfbegin pdfpagecount = quit`,
    ]);

    const count = parseInt(stdout.trim(), 10);
    if (!isNaN(count) && count > 0) {
      return count;
    }

    throw new Error(
      `Failed to determine PDF page count (gs output: ${stdout.trim()})`
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
