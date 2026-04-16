/**
 * ocr-shape-binding.ts — Bind Textract OCR words to detected shapes.
 *
 * Turns raw bboxes (from Lambda template match or shape parse) into tagged
 * items by finding the Textract words inside or near each shape. Runs on the
 * web server because it needs Textract data from the database.
 *
 * Uses the same spatial logic as yolo-tag-engine.ts (Types 3 + 5) but
 * operates on raw shapes instead of annotations.
 */

import type { TextractPageData, TextractWord, BboxMinMax } from "@/types";
import {
  bboxCenterLTWH,
  bboxContainsPoint,
  ltwh2minmax,
  bboxCenterMinMax,
} from "@/lib/bbox-utils";

export interface RawShapeDetection {
  pageNumber: number;
  bbox: BboxMinMax;
  shapeType: string;
  confidence: number;
  method: string;
}

export interface ShapeWithText extends RawShapeDetection {
  boundText: string | null;
  bindingMethod: "inside" | "nearest" | "none";
  bindingDistance: number;
}

/**
 * Bind Textract words to each detected shape.
 *
 * For each shape:
 *   1. Find all words whose center falls inside the shape bbox → "inside"
 *   2. If none inside, find the nearest word within 2× bbox width → "nearest"
 *   3. Concatenate bound words left-to-right as the tag text
 */
export function bindOcrToShapes(
  shapes: RawShapeDetection[],
  textractByPage: Record<number, TextractPageData>,
): ShapeWithText[] {
  return shapes.map((shape) => {
    const pageData = textractByPage[shape.pageNumber];
    if (!pageData?.words?.length) {
      return { ...shape, boundText: null, bindingMethod: "none" as const, bindingDistance: 0 };
    }

    const [minX, minY, maxX, maxY] = shape.bbox;
    const shapeW = maxX - minX;

    // Step 1: words whose center falls inside the shape bbox
    const insideWords: TextractWord[] = [];
    for (const word of pageData.words) {
      const center = bboxCenterLTWH(word.bbox);
      if (bboxContainsPoint(shape.bbox, center)) {
        insideWords.push(word);
      }
    }

    if (insideWords.length > 0) {
      const sorted = [...insideWords].sort((a, b) => {
        const ay = a.bbox[1] + a.bbox[3] / 2;
        const by = b.bbox[1] + b.bbox[3] / 2;
        const avgH = (a.bbox[3] + b.bbox[3]) / 2;
        if (Math.abs(ay - by) < avgH * 0.5) {
          return a.bbox[0] - b.bbox[0];
        }
        return ay - by;
      });
      return {
        ...shape,
        boundText: sorted.map((w) => w.text).join(" "),
        bindingMethod: "inside" as const,
        bindingDistance: 0,
      };
    }

    // Step 2: nearest word within 2× bbox width
    const shapeCenter = bboxCenterMinMax(shape.bbox);
    const maxDist = shapeW * 2;
    let nearestWord: TextractWord | null = null;
    let nearestDist = Infinity;

    for (const word of pageData.words) {
      const wCenter = bboxCenterLTWH(word.bbox);
      const dx = wCenter.x - shapeCenter.x;
      const dy = wCenter.y - shapeCenter.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < nearestDist && dist <= maxDist) {
        nearestDist = dist;
        nearestWord = word;
      }
    }

    if (nearestWord) {
      return {
        ...shape,
        boundText: nearestWord.text,
        bindingMethod: "nearest" as const,
        bindingDistance: nearestDist,
      };
    }

    return { ...shape, boundText: null, bindingMethod: "none" as const, bindingDistance: 0 };
  });
}
