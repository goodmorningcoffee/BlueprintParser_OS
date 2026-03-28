import type { TextractPageData, TextractWord, SpatialRegion, SpatialMappingResult } from "@/types";
import { wordsToText } from "@/lib/ocr-utils";

interface SpatialAnnotation {
  name: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  confidence: number;
}

/**
 * Map OCR words to YOLO spatial regions by checking if each word's center
 * falls inside a region's bounding box. Words not in any region go to unmappedText.
 *
 * Coordinate systems:
 * - TextractWord bbox: [left, top, width, height] normalized 0-1
 * - YOLO annotations: [minX, minY, maxX, maxY] normalized 0-1
 */
export function mapWordsToRegions(
  textractData: TextractPageData,
  spatialAnnotations: SpatialAnnotation[]
): SpatialMappingResult {
  if (!textractData?.words?.length || !spatialAnnotations.length) {
    return {
      regions: [],
      unmappedText: textractData?.words?.map((w) => w.text).join(" ") || "",
    };
  }

  // Pre-compute region areas for overlap resolution (smallest = most specific)
  const regionsWithArea = spatialAnnotations.map((r) => ({
    ...r,
    area: (r.maxX - r.minX) * (r.maxY - r.minY),
  }));

  // Map each word to its containing region
  const regionWords: Map<number, TextractWord[]> = new Map();
  const unmapped: TextractWord[] = [];

  for (const word of textractData.words) {
    // Compute center from [left, top, width, height]
    const cx = word.bbox[0] + word.bbox[2] / 2;
    const cy = word.bbox[1] + word.bbox[3] / 2;

    // Find which region(s) contain this word's center
    let bestRegionIdx = -1;
    let bestArea = Infinity;

    for (let i = 0; i < regionsWithArea.length; i++) {
      const r = regionsWithArea[i];
      if (cx >= r.minX && cx <= r.maxX && cy >= r.minY && cy <= r.maxY) {
        // Overlapping regions: pick smallest (most specific)
        if (r.area < bestArea) {
          bestArea = r.area;
          bestRegionIdx = i;
        }
      }
    }

    if (bestRegionIdx >= 0) {
      if (!regionWords.has(bestRegionIdx)) regionWords.set(bestRegionIdx, []);
      regionWords.get(bestRegionIdx)!.push(word);
    } else {
      unmapped.push(word);
    }
  }

  // Build spatial regions with text
  const totalWords = textractData.words.length;
  const regions: SpatialRegion[] = [];

  for (const [idx, words] of regionWords.entries()) {
    const ann = regionsWithArea[idx];

    // If a region absorbs >80% of all words, it's not adding value as a label
    // Demote it to the catch-all (unmapped) bucket
    if (words.length > totalWords * 0.8) {
      unmapped.push(...words);
      continue;
    }

    regions.push({
      className: ann.name,
      displayName: ann.name.replace(/_/g, " ").toUpperCase(),
      bbox: [ann.minX, ann.minY, ann.maxX, ann.maxY],
      confidence: ann.confidence,
      text: wordsToText(words),
    });
  }

  // Sort regions by a fixed priority (title block first, then tables, etc.)
  regions.sort((a, b) => regionPriority(a.className) - regionPriority(b.className));

  return {
    regions,
    unmappedText: wordsToText(unmapped),
  };
}

// wordsToText is imported from ocr-utils.ts

/**
 * Priority ordering for spatial regions in LLM context.
 * Lower number = appears first. Unknown classes get 50.
 */
function regionPriority(className: string): number {
  const lower = className.toLowerCase();
  if (lower.includes("title")) return 1;
  if (lower.includes("table") || lower.includes("schedule")) return 2;
  if (lower.includes("legend") || lower.includes("symbol")) return 3;
  if (lower.includes("note")) return 4;
  if (lower.includes("detail")) return 5;
  if (lower.includes("grid")) return 6;
  if (lower.includes("drawing")) return 7;
  return 50;
}

/**
 * Build structured LLM context from spatial mapping results.
 */
export function buildSpatialContext(
  pageNumber: number,
  drawingNumber: string | null,
  result: SpatialMappingResult
): string {
  const pageLabel = drawingNumber || `Page ${pageNumber}`;
  let text = "";

  for (const region of result.regions) {
    if (region.text.trim()) {
      text += `${region.displayName}:\n${region.text}\n\n`;
    }
  }

  if (result.unmappedText.trim()) {
    text += `DRAWING AREA:\n${result.unmappedText}\n`;
  }

  return text;
}
