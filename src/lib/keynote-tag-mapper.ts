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

    // Fuzzy match: edit distance ≤ 1 (handles common OCR errors like O→0, l→1)
    for (const [key, desc] of keyMap) {
      if (editDistance(candidateText, key) <= 1) {
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

/** Simple Levenshtein edit distance. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;

  let prev = Array.from({ length: lb + 1 }, (_, i) => i);
  for (let i = 1; i <= la; i++) {
    const curr = [i];
    for (let j = 1; j <= lb; j++) {
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = curr;
  }
  return prev[lb];
}
