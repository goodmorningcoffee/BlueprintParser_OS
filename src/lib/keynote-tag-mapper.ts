/**
 * keynote-tag-mapper.ts — Maps parsed keynote keys to YOLO detections on drawings.
 *
 * After keynotes are parsed (key:value pairs + assigned YOLO class),
 * this finds all YOLO detections of that class on the page and checks
 * if the OCR text inside each detection matches a parsed keynote key.
 *
 * Result: each matched detection links to its keynote description.
 */

import type { TextractWord, BboxLTWH, BboxMinMax } from "@/types";
import { ltwh2minmax, bboxCenterLTWH, bboxContainsPoint } from "@/lib/ocr-utils";
import { isFuzzyCandidate } from "@/lib/yolo-tag-engine";

export interface KeynoteTagMapping {
  annotationId: number;
  keynoteKey: string;
  keynoteDescription: string;
  bbox: [number, number, number, number]; // minmax of the YOLO detection
  pageNumber: number;
}

/**
 * Map parsed keynotes to YOLO detections on the same page.
 *
 * @param parsedKeys - Keynote key:value pairs from the parsed table
 * @param yoloAnnotations - YOLO annotations filtered to the keynote shape class on this page
 * @param words - Textract word-level OCR data for this page
 * @param pageNumber - Current page number
 * @returns Array of mappings linking YOLO detections to keynote descriptions
 */
export function mapKeynotesToDetections(
  parsedKeys: { key: string; description: string }[],
  yoloAnnotations: { id: number; bbox: [number, number, number, number] }[],
  words: TextractWord[],
  pageNumber: number,
): KeynoteTagMapping[] {
  if (parsedKeys.length === 0 || yoloAnnotations.length === 0) return [];

  // Build a lookup map: normalized key text → description
  const keyMap = new Map<string, string>();
  for (const k of parsedKeys) {
    if (k.key) {
      keyMap.set(k.key.toUpperCase().trim(), k.description);
    }
  }

  const mappings: KeynoteTagMapping[] = [];

  for (const ann of yoloAnnotations) {
    const [minX, minY, maxX, maxY] = ann.bbox;
    const annMinMax: BboxMinMax = [minX, minY, maxX, maxY];

    // Find OCR words whose center falls inside this YOLO detection
    const insideWords = words.filter((w) => {
      const center = bboxCenterLTWH(w.bbox);
      return bboxContainsPoint(annMinMax, center);
    });

    if (insideWords.length === 0) continue;

    // Concatenate words to get the candidate key text
    const candidateText = insideWords
      .sort((a, b) => a.bbox[0] - b.bbox[0])
      .map((w) => w.text)
      .join(" ")
      .toUpperCase()
      .trim();

    if (!candidateText) continue;

    // Exact match first
    if (keyMap.has(candidateText)) {
      mappings.push({
        annotationId: ann.id,
        keynoteKey: candidateText,
        keynoteDescription: keyMap.get(candidateText)!,
        bbox: ann.bbox,
        pageNumber,
      });
      continue;
    }

    // Fuzzy match: only OCR-plausible errors (A-Ol ↔ A-01), NOT A-01 ↔ A-02.
    // Uses shared isFuzzyCandidate (same treatment as yolo-tag-engine).
    for (const [key, desc] of keyMap) {
      if (isFuzzyCandidate(candidateText, key)) {
        mappings.push({
          annotationId: ann.id,
          keynoteKey: key,
          keynoteDescription: desc,
          bbox: ann.bbox,
          pageNumber,
        });
        break;
      }
    }
  }

  return mappings;
}
