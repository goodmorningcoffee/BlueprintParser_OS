import type { TextractPageData } from "@/types";

/**
 * Drawing number pattern — matches common architectural/engineering formats:
 * A-100, E-345, S-201, M-001, P-101, A1.01, AS-100, MEP-200, etc.
 * Also matches: S3, DM1, A-1, S3.1 (short formats without zero-padding)
 * Also matches numbered variants like A-100A, E-345.1
 */
const DRAWING_NUMBER_RE =
  /^[A-Z]{1,4}[-.]?\d{1,4}(?:[A-Z])?(?:\.\d{1,2})?$/i;

/**
 * Title block region: bottom-right of the page.
 * On standard architectural sheets, the title block is typically
 * in the bottom-right corner, roughly the last 25% vertically
 * and right 50% horizontally.
 */
const TITLE_BLOCK = {
  minX: 0.45,
  minY: 0.7,
  maxX: 1.0,
  maxY: 1.0,
};

/**
 * Extract a drawing number from Textract word data by scanning the title block region.
 *
 * Strategy:
 * 1. Find all words in the title block region matching the drawing number pattern
 * 2. Score by confidence and position (further right + lower = more likely)
 * 3. Return the best match or null
 */
export function extractDrawingNumber(
  textractData: TextractPageData
): string | null {
  if (!textractData?.words?.length) return null;

  interface Candidate {
    text: string;
    score: number;
  }

  const candidates: Candidate[] = [];

  for (const word of textractData.words) {
    const [left, top, width, height] = word.bbox;
    const centerX = left + width / 2;
    const centerY = top + height / 2;

    // Must be in the title block region
    if (
      centerX < TITLE_BLOCK.minX ||
      centerY < TITLE_BLOCK.minY ||
      centerX > TITLE_BLOCK.maxX ||
      centerY > TITLE_BLOCK.maxY
    ) {
      continue;
    }

    // Must match the drawing number pattern
    const text = word.text.trim();
    if (!DRAWING_NUMBER_RE.test(text)) continue;

    // Score: prefer bottom-right position and high confidence
    // Position score: further right and lower = better (closer to title block core)
    const positionScore = centerX * 0.3 + centerY * 0.3;
    // Confidence from Textract (0-100, normalize to 0-0.4)
    const confidenceScore = (word.confidence / 100) * 0.4;

    candidates.push({
      text: text.toUpperCase(),
      score: positionScore + confidenceScore,
    });
  }

  if (candidates.length === 0) return null;

  // Sort by score descending, return best match
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].text;
}
