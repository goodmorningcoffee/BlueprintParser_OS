import {
  TextractClient,
  AnalyzeDocumentCommand,
  type Block,
} from "@aws-sdk/client-textract";
import type { TextractPageData, TextractWord, TextractLine } from "@/types";

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
    FeatureTypes: ["LAYOUT"],
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

  return { lines, words };
}

/**
 * Join all line text into a single string for full-text search indexing.
 */
export function extractRawText(data: TextractPageData): string {
  return data.lines.map((l) => l.text).join("\n");
}
