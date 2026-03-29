import type { TextractPageData, TextractWord } from "@/types";

/**
 * Drawing number pattern — matches common architectural/engineering formats:
 * A-100, E-345, S-201, M-001, P-101, A1.01, AS-100, MEP-200, etc.
 * Also matches: S3, DM1, A-1, S3.1 (short formats without zero-padding)
 * Also matches numbered variants like A-100A, E-345.1
 */
const DRAWING_NUMBER_RE =
  /^[A-Z]{1,4}[-.]?\d{1,4}(?:[A-Z])?(?:\.\d{1,2})?$/i;

/**
 * Default title block region: bottom-right of the page.
 * On standard architectural sheets, the title block is typically
 * in the bottom-right corner, roughly the last 25% vertically
 * and right 50% horizontally.
 */
const DEFAULT_TITLE_BLOCK = {
  minX: 0.45,
  minY: 0.7,
  maxX: 1.0,
  maxY: 1.0,
};

/** Known discipline prefixes from architectural/engineering drawings. */
const KNOWN_PREFIXES: Set<string> = new Set([
  // 1-char
  "T", "G", "C", "L", "A", "I", "S", "M", "E", "P", "H", "F", "D", "K", "R",
  // 2-char
  "ID", "DM", "FP", "FA", "SP", "AS", "LS", "EL", "ME", "AD",
  // 3-char
  "MEP", "ARC", "STR", "CIV",
]);

/** Words that match the regex but are never drawing numbers. */
const BLACKLIST: Set<string> = new Set([
  "REV", "REF", "SIM", "TYP", "NTS", "EQ", "MIN", "MAX",
  "NO", "NR", "BY", "AT", "OR", "IF", "TO", "OF",
  "HM", "FOR", "THE", "NOT", "ALL", "ANY", "SET",
]);

/** Label keywords that appear next to drawing numbers in title blocks. */
const LABEL_TRIGGERS: Set<string> = new Set([
  "SHEET", "DWG", "DRAWING", "DRW", "PLAN", "PAGE",
]);

/** Filler words between a label and its value. */
const LABEL_FILLER: Set<string> = new Set([
  "NO", "NO.", "NO:", "NUM", "NUM.", "NUM:", "NUMBER", "NUMBER:",
  "#", ":", ".", "-",
]);

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

interface TitleBlockRegion {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface Candidate {
  text: string;
  score: number;
  strategy: "label-anchored" | "regex" | "yolo-validated";
}

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

function wordCenter(w: TextractWord): { cx: number; cy: number } {
  const [left, top, width, height] = w.bbox;
  return { cx: left + width / 2, cy: top + height / 2 };
}

function isInRegion(w: TextractWord, region: TitleBlockRegion): boolean {
  const { cx, cy } = wordCenter(w);
  return cx >= region.minX && cx <= region.maxX && cy >= region.minY && cy <= region.maxY;
}

function distance(a: TextractWord, b: TextractWord): number {
  const ac = wordCenter(a);
  const bc = wordCenter(b);
  return Math.sqrt((ac.cx - bc.cx) ** 2 + (ac.cy - bc.cy) ** 2);
}

/** Check if word b is to the right of word a (same line, within tolerance). */
function isRightOf(a: TextractWord, b: TextractWord, maxGap = 0.08): boolean {
  const [aLeft, aTop, aWidth, aHeight] = a.bbox;
  const [bLeft, bTop] = b.bbox;
  const aRight = aLeft + aWidth;
  const aCenterY = aTop + aHeight / 2;
  const bCenterY = bTop + b.bbox[3] / 2;
  return bLeft > aRight && (bLeft - aRight) < maxGap && Math.abs(aCenterY - bCenterY) < 0.015;
}

/** Check if word b is below word a (within tolerance). */
function isBelow(a: TextractWord, b: TextractWord, maxGap = 0.06): boolean {
  const [, aTop, , aHeight] = a.bbox;
  const [, bTop] = b.bbox;
  const aBottom = aTop + aHeight;
  return bTop > aBottom && (bTop - aBottom) < maxGap && Math.abs(wordCenter(a).cx - wordCenter(b).cx) < 0.1;
}

/** Extract the alphabetic prefix from a drawing number candidate. */
function extractPrefix(text: string): string {
  const match = text.match(/^([A-Z]+)/i);
  return match ? match[1].toUpperCase() : "";
}

/** Check if a prefix is a known discipline prefix (1, 2, or 3+ chars). */
function isKnownPrefix(prefix: string): boolean {
  if (!prefix) return false;
  if (KNOWN_PREFIXES.has(prefix)) return true;
  // Try progressive lookup: 2-char, 1-char
  if (prefix.length >= 2 && KNOWN_PREFIXES.has(prefix.slice(0, 2))) return true;
  if (KNOWN_PREFIXES.has(prefix[0])) return true;
  return false;
}

// ═══════════════════════════════════════════════════════════════════
// Validation Layer
// ═══════════════════════════════════════════════════════════════════

function validateCandidate(text: string): { valid: boolean; penalty: number } {
  const upper = text.toUpperCase();

  // Blacklisted words
  if (BLACKLIST.has(upper)) return { valid: false, penalty: 0 };

  // Must have at least one letter and one digit
  if (!/[A-Z]/i.test(text) || !/\d/.test(text)) return { valid: false, penalty: 0 };

  // All same letter prefix ("AAA1") — suspicious
  const prefix = extractPrefix(upper);
  if (prefix.length >= 3 && new Set(prefix.split("")).size === 1) {
    return { valid: true, penalty: 0.3 };
  }

  // Check prefix against known disciplines
  let penalty = 0;
  if (!isKnownPrefix(prefix)) {
    penalty += 0.15; // Unknown prefix gets penalized
  }

  // Very short candidates (2 chars like "S3") get slight penalty
  if (upper.length <= 2) {
    penalty += 0.05;
  }

  return { valid: true, penalty };
}

// ═══════════════════════════════════════════════════════════════════
// Strategy 1: Label-Anchored Search
// ═══════════════════════════════════════════════════════════════════

function labelAnchoredSearch(
  words: TextractWord[],
  regionWords: TextractWord[],
): Candidate[] {
  const candidates: Candidate[] = [];

  for (let i = 0; i < regionWords.length; i++) {
    const word = regionWords[i];
    const upper = word.text.trim().toUpperCase().replace(/[:.]/g, "");

    if (!LABEL_TRIGGERS.has(upper)) continue;

    // Found a label trigger — look for the value
    // Build list of nearby words to the right and below
    const nearby: TextractWord[] = [];
    for (const other of regionWords) {
      if (other === word) continue;
      if (isRightOf(word, other, 0.15) || isBelow(word, other, 0.06)) {
        nearby.push(other);
      }
    }

    // Sort by distance from the label
    nearby.sort((a, b) => distance(word, a) - distance(word, b));

    // Walk through nearby words, skipping filler
    for (const candidate of nearby) {
      const candidateText = candidate.text.trim();
      const candidateUpper = candidateText.toUpperCase().replace(/[:.]/g, "");

      // Skip filler words (NO, NUM, NUMBER, etc.)
      if (LABEL_FILLER.has(candidateUpper)) continue;

      // Check if it matches drawing number pattern
      if (!DRAWING_NUMBER_RE.test(candidateText)) continue;

      // Validate
      const validation = validateCandidate(candidateText);
      if (!validation.valid) continue;

      // High confidence — label-anchored
      const score = 1.0 - validation.penalty;
      candidates.push({
        text: candidateText.toUpperCase(),
        score,
        strategy: "label-anchored",
      });
      break; // Take the first valid match after this label
    }
  }

  return candidates;
}

// ═══════════════════════════════════════════════════════════════════
// Strategy 2: Improved Regex Match
// ═══════════════════════════════════════════════════════════════════

function regexSearch(
  regionWords: TextractWord[],
  allWords: TextractWord[],
  region: TitleBlockRegion,
): Candidate[] {
  const candidates: Candidate[] = [];

  // Count occurrences of each text on the whole page (for duplicate penalty)
  const pageCounts = new Map<string, number>();
  for (const w of allWords) {
    const upper = w.text.trim().toUpperCase();
    pageCounts.set(upper, (pageCounts.get(upper) || 0) + 1);
  }

  for (let i = 0; i < regionWords.length; i++) {
    const word = regionWords[i];
    const text = word.text.trim();
    if (!DRAWING_NUMBER_RE.test(text)) continue;

    const validation = validateCandidate(text);
    if (!validation.valid) continue;

    const { cx, cy } = wordCenter(word);

    // Position score: further right and lower = better (0-0.3)
    const positionScore = (cx - region.minX) / (region.maxX - region.minX) * 0.15 +
                          (cy - region.minY) / (region.maxY - region.minY) * 0.15;

    // Confidence from Textract (0-0.25)
    const confidenceScore = (word.confidence / 100) * 0.25;

    // Known prefix boost (+0.2)
    const prefix = extractPrefix(text.toUpperCase());
    const prefixBoost = isKnownPrefix(prefix) ? 0.2 : 0;

    // Context check: is the word to the LEFT a label keyword? (+0.25)
    let contextBoost = 0;
    for (const other of regionWords) {
      if (other === word) continue;
      if (isRightOf(other, word, 0.15)) {
        const otherUpper = other.text.trim().toUpperCase().replace(/[:.]/g, "");
        if (LABEL_TRIGGERS.has(otherUpper) || LABEL_FILLER.has(otherUpper)) {
          contextBoost = 0.25;
          break;
        }
      }
    }

    // Duplicate penalty: if text appears outside title block, less likely
    const upper = text.toUpperCase();
    const totalCount = pageCounts.get(upper) || 1;
    const duplicatePenalty = totalCount > 2 ? 0.15 : 0;

    const score = positionScore + confidenceScore + prefixBoost + contextBoost
                  - validation.penalty - duplicatePenalty;

    candidates.push({
      text: upper,
      score,
      strategy: "regex",
    });
  }

  return candidates;
}

// ═══════════════════════════════════════════════════════════════════
// Strategy 3: YOLO-Augmented Validation
// ═══════════════════════════════════════════════════════════════════

function yoloValidate(
  candidates: Candidate[],
  yoloRegion: TitleBlockRegion,
  allWords: TextractWord[],
): Candidate[] {
  // Get words inside the YOLO-detected title block
  const yoloWords = allWords.filter(w => isInRegion(w, yoloRegion));

  // Build set of texts found in YOLO region
  const yoloTexts = new Set(yoloWords.map(w => w.text.trim().toUpperCase()));

  // For each candidate, check if it exists in the YOLO region
  const validated: Candidate[] = [];
  for (const c of candidates) {
    if (yoloTexts.has(c.text)) {
      // Candidate is inside YOLO title block — boost score
      // Extra boost if in bottom half of YOLO region
      const midY = (yoloRegion.minY + yoloRegion.maxY) / 2;
      const inBottomHalf = yoloWords.some(w => {
        const upper = w.text.trim().toUpperCase();
        return upper === c.text && wordCenter(w).cy > midY;
      });

      validated.push({
        ...c,
        score: c.score + (inBottomHalf ? 0.2 : 0.1),
        strategy: c.strategy === "label-anchored" ? "label-anchored" : "yolo-validated",
      });
    } else {
      // Candidate NOT in YOLO title block — heavy penalty
      validated.push({
        ...c,
        score: c.score - 0.4,
      });
    }
  }

  // Also run a fresh search within the YOLO region specifically
  // This catches cases where the default region missed the title block entirely
  const yoloRegionWords = yoloWords.filter(w => {
    const text = w.text.trim();
    return DRAWING_NUMBER_RE.test(text) && validateCandidate(text).valid;
  });

  for (const w of yoloRegionWords) {
    const text = w.text.trim().toUpperCase();
    // Don't duplicate candidates already found
    if (validated.some(c => c.text === text)) continue;

    const { cy } = wordCenter(w);
    const midY = (yoloRegion.minY + yoloRegion.maxY) / 2;
    const inBottomHalf = cy > midY;
    const validation = validateCandidate(text);

    validated.push({
      text,
      score: 0.5 + (inBottomHalf ? 0.15 : 0) - validation.penalty,
      strategy: "yolo-validated",
    });
  }

  return validated;
}

// ═══════════════════════════════════════════════════════════════════
// Main Extraction Function
// ═══════════════════════════════════════════════════════════════════

/**
 * Extract a drawing number from Textract word data using a multi-strategy approach.
 *
 * Strategy chain:
 * 1. Label-anchored search — find keywords like "SHEET", "DWG" and grab adjacent value
 * 2. Regex pattern match — scan title block region for drawing number patterns with scoring
 * 3. YOLO-augmented validation — if YOLO title_block bbox available, validate/re-rank
 *
 * @param textractData - OCR data with words and their bounding boxes
 * @param yoloTitleBlock - Optional YOLO-detected title block region (minX/minY/maxX/maxY normalized 0-1)
 * @returns The best drawing number candidate, or null
 */
export function extractDrawingNumber(
  textractData: TextractPageData,
  yoloTitleBlock?: TitleBlockRegion | null,
): string | null {
  if (!textractData?.words?.length) return null;

  const allWords = textractData.words;

  // Determine the search region
  const searchRegion = DEFAULT_TITLE_BLOCK;

  // Get words in the default title block region
  const regionWords = allWords.filter(w => isInRegion(w, searchRegion));
  if (regionWords.length === 0) return null;

  // Strategy 1: Label-anchored search (highest priority)
  const labelCandidates = labelAnchoredSearch(allWords, regionWords);

  // Strategy 2: Regex pattern match
  const regexCandidates = regexSearch(regionWords, allWords, searchRegion);

  // Merge all candidates
  let allCandidates = [...labelCandidates, ...regexCandidates];

  // Strategy 3: YOLO validation (if available)
  if (yoloTitleBlock) {
    allCandidates = yoloValidate(allCandidates, yoloTitleBlock, allWords);
  }

  if (allCandidates.length === 0) return null;

  // Deduplicate: keep highest-scoring version of each text
  const bestByText = new Map<string, Candidate>();
  for (const c of allCandidates) {
    const existing = bestByText.get(c.text);
    if (!existing || c.score > existing.score) {
      bestByText.set(c.text, c);
    }
  }

  // Sort by score descending
  const sorted = Array.from(bestByText.values()).sort((a, b) => b.score - a.score);
  return sorted[0].text;
}
