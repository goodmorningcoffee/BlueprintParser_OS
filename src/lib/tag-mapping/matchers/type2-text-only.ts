/**
 * matchers/type2-text-only.ts — Type 2: free-floating text matching.
 *
 * Iterates Textract words directly (exact match OR fuzzy OCR substitution
 * via `isFuzzyCandidate`). Handles both single-word tags and multi-word
 * tags via a sliding window over adjacent words on the same line.
 *
 * IMPORTANT: Textract tokenizes hyphens as word boundaries, so `D-101`
 * appears in Textract as multiple words. The multi-word window reconstructs
 * the raw tag text; pattern-match against the reconstructed window text
 * (done by the caller in find-occurrences.ts), not raw Textract text.
 *
 * Behavior preserved verbatim from yolo-tag-engine.ts.
 */

import type { TextractPageData, YoloTagInstance } from "@/types";
import { ltwh2minmax } from "@/lib/bbox-utils";
import { isFuzzyCandidate } from "./fuzzy";

export function findFreeFloatingMatches(
  normalizedTag: string,
  scope: "page" | "project",
  pageNumber: number | undefined,
  textractData: Record<number, TextractPageData>,
): YoloTagInstance[] {
  const instances: YoloTagInstance[] = [];
  const pageNums = scope === "page" && pageNumber != null
    ? [pageNumber]
    : Object.keys(textractData).map(Number);

  const tagWords = normalizedTag.split(/\s+/);

  for (const pn of pageNums) {
    const words = textractData[pn]?.words;
    if (!words || words.length === 0) continue;

    if (tagWords.length === 1) {
      // Single-word tag: scan each word
      for (const w of words) {
        const wText = w.text.toUpperCase().trim();
        if (wText === normalizedTag || isFuzzyCandidate(wText, normalizedTag)) {
          const mm = ltwh2minmax(w.bbox);
          instances.push({
            pageNumber: pn,
            annotationId: -1,
            bbox: [mm[0], mm[1], mm[2], mm[3]],
            confidence: wText === normalizedTag ? 1.0 : 0.9,
          });
        }
      }
    } else {
      // Multi-word tag: sliding window over adjacent words
      for (let i = 0; i <= words.length - tagWords.length; i++) {
        const window = words.slice(i, i + tagWords.length);
        const windowText = window.map((w) => w.text).join(" ").toUpperCase().trim();
        if (windowText === normalizedTag || isFuzzyCandidate(windowText, normalizedTag)) {
          const minX = Math.min(...window.map((w) => w.bbox[0]));
          const minY = Math.min(...window.map((w) => w.bbox[1]));
          const maxX = Math.max(...window.map((w) => w.bbox[0] + w.bbox[2]));
          const maxY = Math.max(...window.map((w) => w.bbox[1] + w.bbox[3]));
          instances.push({
            pageNumber: pn,
            annotationId: -1,
            bbox: [minX, minY, maxX, maxY],
            confidence: windowText === normalizedTag ? 1.0 : 0.9,
          });
        }
      }
    }
  }

  return instances;
}
