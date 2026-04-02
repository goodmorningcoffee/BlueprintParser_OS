import {
  TextractClient,
  AnalyzeDocumentCommand,
  type Block,
} from "@aws-sdk/client-textract";
import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile, readFile, mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { TextractPageData, TextractWord, TextractLine, TextractTable, TextractCell, BboxLTWH } from "@/types";
import { logger } from "@/lib/logger";

const execFileAsync = promisify(execFile);

const textractClient = new TextractClient({
  region: process.env.AWS_REGION || "us-east-1",
  ...(process.env.AWS_ACCESS_KEY_ID && {
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  }),
});

/**
 * Call Textract AnalyzeDocument on a single page image.
 * Sync API — works for images up to 10MB.
 */
export async function analyzePageImage(
  imageBuffer: Buffer
): Promise<TextractPageData> {
  const command = new AnalyzeDocumentCommand({
    Document: { Bytes: imageBuffer },
    FeatureTypes: ["LAYOUT", "TABLES"],
  });

  const response = await textractClient.send(command);
  return parseTextractResponse(response.Blocks || []);
}

/**
 * Parse raw Textract Block[] into our TextractPageData shape.
 * Pure function — reusable by both dev route and production webhook.
 */
export function parseTextractResponse(blocks: Block[]): TextractPageData {
  const words: TextractWord[] = [];
  const lineMap = new Map<
    string,
    { text: string; confidence: number; bbox: [number, number, number, number]; wordIds: string[] }
  >();

  // First pass: collect all WORD and LINE blocks
  for (const block of blocks) {
    if (block.BlockType === "WORD" && block.Geometry?.BoundingBox) {
      const bb = block.Geometry.BoundingBox;
      words.push({
        text: block.Text || "",
        confidence: block.Confidence || 0,
        bbox: [bb.Left || 0, bb.Top || 0, bb.Width || 0, bb.Height || 0],
      });
    }

    if (block.BlockType === "LINE" && block.Geometry?.BoundingBox) {
      const bb = block.Geometry.BoundingBox;
      const childIds =
        block.Relationships?.find((r) => r.Type === "CHILD")?.Ids || [];
      lineMap.set(block.Id || "", {
        text: block.Text || "",
        confidence: block.Confidence || 0,
        bbox: [bb.Left || 0, bb.Top || 0, bb.Width || 0, bb.Height || 0],
        wordIds: childIds,
      });
    }
  }

  // Build word lookup by block ID for LINE → WORD resolution
  const wordById = new Map<string, TextractWord>();
  for (const block of blocks) {
    if (block.BlockType === "WORD" && block.Geometry?.BoundingBox) {
      const bb = block.Geometry.BoundingBox;
      wordById.set(block.Id || "", {
        text: block.Text || "",
        confidence: block.Confidence || 0,
        bbox: [bb.Left || 0, bb.Top || 0, bb.Width || 0, bb.Height || 0],
      });
    }
  }

  // Build lines with their child words
  const lines: TextractLine[] = [];
  for (const [, lineData] of lineMap) {
    const lineWords: TextractWord[] = lineData.wordIds
      .map((id) => wordById.get(id))
      .filter((w): w is TextractWord => w !== undefined);

    lines.push({
      text: lineData.text,
      confidence: lineData.confidence,
      bbox: lineData.bbox,
      words: lineWords,
    });
  }

  // Extract TABLE blocks (from TABLES feature type)
  const tables: TextractTable[] = [];
  const blockById = new Map<string, Block>();
  for (const block of blocks) {
    if (block.Id) blockById.set(block.Id, block);
  }

  for (const block of blocks) {
    if (block.BlockType !== "TABLE" || !block.Geometry?.BoundingBox) continue;

    const tableBB = block.Geometry.BoundingBox;
    const tableBbox: BboxLTWH = [tableBB.Left || 0, tableBB.Top || 0, tableBB.Width || 0, tableBB.Height || 0];

    const cellIds = block.Relationships?.find((r) => r.Type === "CHILD")?.Ids || [];
    const cells: TextractCell[] = [];
    let maxRow = 0;
    let maxCol = 0;

    for (const cellId of cellIds) {
      const cellBlock = blockById.get(cellId);
      if (!cellBlock || cellBlock.BlockType !== "CELL" || !cellBlock.Geometry?.BoundingBox) continue;

      const cellBB = cellBlock.Geometry.BoundingBox;
      const row = cellBlock.RowIndex || 1;
      const col = cellBlock.ColumnIndex || 1;
      if (row > maxRow) maxRow = row;
      if (col > maxCol) maxCol = col;

      // Get text from child WORD blocks
      const wordIds = cellBlock.Relationships?.find((r) => r.Type === "CHILD")?.Ids || [];
      const cellText = wordIds
        .map((wid) => blockById.get(wid))
        .filter((b): b is Block => b != null && b.BlockType === "WORD")
        .map((b) => b.Text || "")
        .join(" ");

      cells.push({
        row,
        col,
        rowSpan: cellBlock.RowSpan || 1,
        colSpan: cellBlock.ColumnSpan || 1,
        text: cellText,
        bbox: [cellBB.Left || 0, cellBB.Top || 0, cellBB.Width || 0, cellBB.Height || 0],
        confidence: cellBlock.Confidence || 0,
      });
    }

    if (cells.length > 0) {
      tables.push({ bbox: tableBbox, cells, rowCount: maxRow, colCount: maxCol });
    }
  }

  return { lines, words, ...(tables.length > 0 ? { tables } : {}) };
}

/**
 * Join all line text into a single string for full-text search indexing.
 */
export function extractRawText(data: TextractPageData): string {
  return data.lines.map((l) => l.text).join("\n");
}

// ─── Fallback chain: Textract 300 → Textract 150 → Tesseract ───

/**
 * Downscale a PNG buffer using Ghostscript.
 * Renders the PNG at a lower resolution to reduce file size.
 */
async function downscalePng(pngBuffer: Buffer, scaleFactor: number): Promise<Buffer> {
  const tempDir = await mkdtemp(join(tmpdir(), "bp2-downscale-"));
  try {
    const inputPath = join(tempDir, "input.png");
    const outputPath = join(tempDir, "output.png");
    await writeFile(inputPath, pngBuffer);

    // Use Ghostscript to resize: scale dimensions by factor
    const dpi = Math.round(72 * scaleFactor); // 72 is base DPI for images
    await execFileAsync("gs", [
      "-dNOPAUSE", "-dBATCH", "-dSAFER",
      "-sDEVICE=png16m",
      `-r${dpi}`,
      "-dFIXEDMEDIA",
      `-dDEVICEWIDTHPOINTS=${Math.round(72 * scaleFactor)}`,
      `-dDEVICEHEIGHTPOINTS=${Math.round(72 * scaleFactor)}`,
      `-sOutputFile=${outputPath}`,
      inputPath,
    ]);
    return await readFile(outputPath);
  } catch {
    // If Ghostscript fails, return original — let the caller handle the error
    return pngBuffer;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Run Tesseract OCR on a PNG buffer, returning TextractPageData format.
 */
async function analyzeWithTesseract(pngBuffer: Buffer): Promise<TextractPageData> {
  const tempDir = await mkdtemp(join(tmpdir(), "bp2-tess-"));
  try {
    const imgPath = join(tempDir, "page.png");
    const outBase = join(tempDir, "out");
    await writeFile(imgPath, pngBuffer);

    // Run tesseract with TSV output for word-level bboxes
    await execFileAsync("tesseract", [imgPath, outBase, "-l", "eng", "tsv"]);

    const tsvContent = await readFile(outBase + ".tsv", "utf-8");
    const rows = tsvContent.split("\n").slice(1); // skip header

    // Get image dimensions for normalization
    // Read from PNG header: width at bytes 16-19, height at bytes 20-23
    const imgWidth = pngBuffer.readUInt32BE(16);
    const imgHeight = pngBuffer.readUInt32BE(20);

    const words: TextractWord[] = [];
    const lineGroups = new Map<string, TextractWord[]>();

    for (const row of rows) {
      const cols = row.split("\t");
      if (cols.length < 12) continue;

      const conf = parseInt(cols[10], 10);
      const text = cols[11]?.trim();
      if (!text || conf < 0) continue;

      const left = parseInt(cols[6], 10);
      const top = parseInt(cols[7], 10);
      const width = parseInt(cols[8], 10);
      const height = parseInt(cols[9], 10);

      const word: TextractWord = {
        text,
        confidence: conf,
        bbox: [
          left / imgWidth,
          top / imgHeight,
          width / imgWidth,
          height / imgHeight,
        ],
      };
      words.push(word);

      // Group by block + paragraph + line for line construction
      const lineKey = `${cols[2]}-${cols[3]}-${cols[4]}`;
      if (!lineGroups.has(lineKey)) lineGroups.set(lineKey, []);
      lineGroups.get(lineKey)!.push(word);
    }

    // Build lines from word groups
    const lines: TextractLine[] = [];
    for (const [, lineWords] of lineGroups) {
      if (lineWords.length === 0) continue;
      const lineText = lineWords.map((w) => w.text).join(" ");
      const minLeft = Math.min(...lineWords.map((w) => w.bbox[0]));
      const minTop = Math.min(...lineWords.map((w) => w.bbox[1]));
      const maxRight = Math.max(...lineWords.map((w) => w.bbox[0] + w.bbox[2]));
      const maxBottom = Math.max(...lineWords.map((w) => w.bbox[1] + w.bbox[3]));
      lines.push({
        text: lineText,
        confidence: lineWords.reduce((s, w) => s + w.confidence, 0) / lineWords.length,
        bbox: [minLeft, minTop, maxRight - minLeft, maxBottom - minTop],
        words: lineWords,
      });
    }

    return { lines, words };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/** Retry a function with exponential backoff for throttling errors. */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 1000,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const isThrottled =
        err?.name === "ThrottlingException" ||
        err?.name === "ProvisionedThroughputExceededException" ||
        err?.__type === "ThrottlingException" ||
        err?.__type === "ProvisionedThroughputExceededException" ||
        err?.message?.includes("Rate exceeded") ||
        err?.message?.includes("Too many requests");

      if (!isThrottled || attempt === maxRetries) throw err;

      const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 500;
      logger.warn(`[textract] Throttled, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("retryWithBackoff: unreachable");
}

/**
 * OCR with fallback chain: Textract (full, with retry) → Textract (half-size) → Tesseract.
 * Degrades gracefully — project completes even if Textract rejects pages.
 * All Textract errors now fall through to Tesseract instead of killing the page.
 */
export async function analyzePageImageWithFallback(
  pngBuffer: Buffer
): Promise<TextractPageData> {
  // Strategy A: Textract at original resolution (with retry for throttling)
  try {
    return await retryWithBackoff(() => analyzePageImage(pngBuffer));
  } catch (err: any) {
    const errName = err?.name || err?.__type || "";
    logger.warn(`[textract] Full-res failed (${errName}), trying half resolution...`);
  }

  // Strategy B: Textract at half resolution (cuts size by ~75%)
  try {
    const halfBuffer = await downscalePng(pngBuffer, 0.5);
    return await retryWithBackoff(() => analyzePageImage(halfBuffer), 2);
  } catch (err: any) {
    const errName = err?.name || err?.__type || "";
    logger.warn(`[textract] Half-res failed (${errName}), falling back to Tesseract...`);
  }

  // Strategy C: Tesseract (local, no AWS dependency)
  try {
    return await analyzeWithTesseract(pngBuffer);
  } catch (err) {
    logger.error("Tesseract fallback also failed:", err);
    // Return empty data rather than killing the whole project
    return { lines: [], words: [] };
  }
}
