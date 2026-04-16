/**
 * ocr-shape-binding.ts — Bind Textract OCR words to detected shapes.
 *
 * Turns raw bboxes (from Lambda template match or shape parse) into tagged
 * items by finding the Textract words inside or near each shape. Runs on the
 * web server because it needs Textract data from the database.
 *
 * Uses shared spatial helpers from ocr-utils.ts — same logic as
 * yolo-tag-engine.ts but operates on raw shapes instead of annotations.
 */

import type { TextractPageData, BboxMinMax } from "@/types";
import {
  bboxCenterMinMax,
  findWordsInBbox,
  sortWordsReadingOrder,
  findNearestWord,
} from "@/lib/ocr-utils";

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

export function bindOcrToShapes(
  shapes: RawShapeDetection[],
  textractByPage: Record<number, TextractPageData>,
): ShapeWithText[] {
  return shapes.map((shape) => {
    const words = textractByPage[shape.pageNumber]?.words;
    if (!words?.length) {
      return { ...shape, boundText: null, bindingMethod: "none" as const, bindingDistance: 0 };
    }

    const insideWords = findWordsInBbox(words, shape.bbox);
    if (insideWords.length > 0) {
      const text = sortWordsReadingOrder(insideWords).map((w) => w.text).join(" ");
      return { ...shape, boundText: text, bindingMethod: "inside" as const, bindingDistance: 0 };
    }

    const shapeW = shape.bbox[2] - shape.bbox[0];
    const nearest = findNearestWord(bboxCenterMinMax(shape.bbox), words, shapeW * 2);
    if (nearest) {
      return { ...shape, boundText: nearest.word.text, bindingMethod: "nearest" as const, bindingDistance: nearest.distance };
    }

    return { ...shape, boundText: null, bindingMethod: "none" as const, bindingDistance: 0 };
  });
}
