/**
 * page-analysis.ts
 *
 * Per-page intelligence: classification, cross-references, note blocks.
 * Pure functions, no side effects, no DB access.
 * Called from processing.ts after OCR/CSI/textAnnotations are computed.
 */

import type {
  TextractPageData,
  TextractWord,
  TextAnnotationResult,
  CsiCode,
  PageIntelligence,
  PageClassification,
  CrossRef,
  NoteBlock,
  BboxLTWH,
} from "@/types";
import { mergeBbox, isSameLine, wordsToText } from "@/lib/ocr-utils";

// ═══════════════════════════════════════════════════════════════════
// Page Classification
// ═══════════════════════════════════════════════════════════════════

const DISCIPLINE_MAP: Record<string, string> = {
  T: "Title/Cover", G: "General", C: "Civil", L: "Landscape",
  A: "Architectural", I: "Interior", ID: "Interior Design",
  DM: "Demolition", S: "Structural",
  M: "Mechanical", E: "Electrical", P: "Plumbing",
  FP: "Fire Protection", FA: "Fire Alarm", SP: "Sprinkler",
};

const SERIES_MAP: Record<string, string> = {
  "0": "General/Cover",
  "1": "Floor Plan",
  "2": "Elevation",
  "3": "Section",
  "4": "Enlarged Plan",
  "5": "Detail",
  "6": "Schedule/Diagram",
  "7": "Diagram",
  "8": "Detail",
  "9": "3D/Rendering",
};

const RE_DRAWING_NUM = /^([A-Z]{1,4})-?(\d{1,4})(?:\.(\d{1,2}))?$/;

function classifyPage(
  drawingNumber: string | null,
  csiCodes: CsiCode[] | null,
): PageClassification | null {
  if (!drawingNumber) {
    // Fallback: try to infer discipline from CSI trade majority
    if (csiCodes && csiCodes.length > 0) {
      const tradeCounts: Record<string, number> = {};
      for (const c of csiCodes) {
        tradeCounts[c.trade] = (tradeCounts[c.trade] || 0) + 1;
      }
      const topTrade = Object.entries(tradeCounts).sort(([, a], [, b]) => b - a)[0];
      if (topTrade) {
        return {
          discipline: topTrade[0],
          disciplinePrefix: "?",
          confidence: 0.4,
        };
      }
    }
    return null;
  }

  const match = RE_DRAWING_NUM.exec(drawingNumber.toUpperCase());
  if (!match) return null;

  const prefix = match[1];
  const pageNum = match[2];
  const series = pageNum.length >= 1 ? pageNum[0] : undefined;

  // Look up discipline — try full prefix first, then progressively shorter
  // Handles cases like "MEP200" where "MEP" isn't mapped but "M" is
  let discipline = DISCIPLINE_MAP[prefix];
  let resolvedPrefix = prefix;
  if (!discipline && prefix.length > 2) {
    discipline = DISCIPLINE_MAP[prefix.substring(0, 2)];
    if (discipline) resolvedPrefix = prefix.substring(0, 2);
  }
  if (!discipline && prefix.length > 1) {
    discipline = DISCIPLINE_MAP[prefix.substring(0, 1)];
    if (discipline) resolvedPrefix = prefix.substring(0, 1);
  }
  if (!discipline) {
    return {
      discipline: `Unknown (${prefix})`,
      disciplinePrefix: prefix,
      confidence: 0.5,
    };
  }

  return {
    discipline,
    disciplinePrefix: resolvedPrefix,
    subType: series ? SERIES_MAP[series] : undefined,
    series: series ? `${series}00` : undefined,
    confidence: 0.95,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Cross-Page Reference Detection
// ═══════════════════════════════════════════════════════════════════

const CROSS_REF_PATTERNS: { re: RegExp; type: CrossRef["refType"] }[] = [
  { re: /SEE\s+DETAIL\s+(\w+)\s*[/]\s*([A-Z]{1,2}-?\d{1,4}(?:\.\d{1,2})?)/i, type: "detail" },
  { re: /SEE\s+(?:SHEET|SHT\.?|DWG\.?)\s+([A-Z]{1,2}-?\d{1,4}(?:\.\d{1,2})?)/i, type: "sheet" },
  { re: /REFER\s+TO\s+(?:DWG\.?\s+)?([A-Z]{1,2}-?\d{1,4}(?:\.\d{1,2})?)/i, type: "refer" },
  { re: /SIM(?:ILAR)?\s+TO\s+([A-Z]{1,2}-?\d{1,4}(?:\.\d{1,2})?)/i, type: "similar" },
  { re: /TYP(?:ICAL)?\s+(?:SEE|PER)\s+([A-Z]{1,2}-?\d{1,4}(?:\.\d{1,2})?)/i, type: "typical" },
  { re: /SEE\s+(?:SECTION|ELEVATION)\s+(\w+)\s*(?:ON|[/])\s*([A-Z]{1,2}-?\d{1,4})/i, type: "section" },
];

// Standalone detail-slash: 3/A-101
const RE_DETAIL_SLASH = /^(\d+|[A-Z])\/([A-Z]{1,2}-?\d{1,4}(?:\.\d{1,2})?)$/;

function detectCrossRefs(textractData: TextractPageData): CrossRef[] {
  if (!textractData?.words?.length) return [];

  const refs: CrossRef[] = [];
  const rawText = textractData.words.map(w => w.text).join(" ");

  // Multi-word pattern matching on raw text
  for (const { re, type } of CROSS_REF_PATTERNS) {
    const match = re.exec(rawText);
    if (match) {
      // Find approximate bbox from matching words
      const matchText = match[0];
      const startIdx = rawText.indexOf(matchText);
      const bbox = findBboxForTextRange(textractData.words, startIdx, matchText.length, rawText);

      const targetDrawing = type === "detail" && match[2] ? match[2] : match[1];
      const detail = type === "detail" ? match[1] : undefined;

      refs.push({
        sourceText: matchText,
        targetDrawing,
        refType: type,
        detail,
        bbox,
        confidence: 0.85,
      });
    }
  }

  // Standalone detail-slash notation on individual words: 3/A-101
  for (const word of textractData.words) {
    const slashMatch = RE_DETAIL_SLASH.exec(word.text);
    if (slashMatch) {
      refs.push({
        sourceText: word.text,
        targetDrawing: slashMatch[2],
        refType: "detail",
        detail: slashMatch[1],
        bbox: word.bbox as BboxLTWH,
        confidence: 0.80,
      });
    }
  }

  return refs;
}

/** Approximate bbox for a text range in the joined word string. */
function findBboxForTextRange(
  words: TextractWord[],
  charStart: number,
  charLen: number,
  _rawText: string,
): BboxLTWH {
  let charPos = 0;
  const matchWords: TextractWord[] = [];
  for (const w of words) {
    const wordEnd = charPos + w.text.length;
    if (charPos >= charStart && charPos < charStart + charLen) {
      matchWords.push(w);
    } else if (wordEnd > charStart && charPos < charStart + charLen) {
      matchWords.push(w);
    }
    charPos = wordEnd + 1; // +1 for space
  }
  return matchWords.length > 0 ? mergeBbox(matchWords) : [0, 0, 0, 0];
}

// ═══════════════════════════════════════════════════════════════════
// Note Block Detection
// ═══════════════════════════════════════════════════════════════════

const RE_NOTE_HEADER = /^(?:GENERAL\s+)?NOTES?:?\s*$/i;
const RE_NUMBERED_ITEM = /^(\d+)\.\s*/;

function detectNoteBlocks(textractData: TextractPageData): NoteBlock[] {
  if (!textractData?.lines?.length) return [];

  const blocks: NoteBlock[] = [];
  let currentBlock: { title: string; notes: string[]; words: TextractWord[] } | null = null;

  for (const line of textractData.lines) {
    const upper = line.text.trim().toUpperCase();

    // Start of a new note block
    if (RE_NOTE_HEADER.test(upper)) {
      if (currentBlock && currentBlock.notes.length > 0) {
        blocks.push(finalizeBlock(currentBlock));
      }
      currentBlock = { title: line.text.trim(), notes: [], words: [...line.words] };
      continue;
    }

    // Numbered item continues or starts a note block
    const numMatch = RE_NUMBERED_ITEM.exec(line.text.trim());
    if (numMatch) {
      if (!currentBlock) {
        // Start implicit block (numbered notes without header)
        if (numMatch[1] === "1") {
          currentBlock = { title: "NOTES", notes: [], words: [] };
        }
      }
      if (currentBlock) {
        currentBlock.notes.push(line.text.trim());
        currentBlock.words.push(...line.words);
        continue;
      }
    }

    // Non-numbered line: if we're in a block and the previous note exists,
    // this might be a continuation. Only continue if we're close in Y to last word.
    if (currentBlock && currentBlock.words.length > 0 && currentBlock.notes.length > 0) {
      const lastWord = currentBlock.words[currentBlock.words.length - 1];
      const firstWord = line.words[0];
      if (firstWord && isSameLine(lastWord, firstWord)) {
        // Continuation of previous note line
        currentBlock.notes[currentBlock.notes.length - 1] += " " + line.text.trim();
        currentBlock.words.push(...line.words);
        continue;
      }
      // Gap — end current block
      blocks.push(finalizeBlock(currentBlock));
      currentBlock = null;
    }
  }

  // Finalize last block
  if (currentBlock && currentBlock.notes.length > 0) {
    blocks.push(finalizeBlock(currentBlock));
  }

  // Only return blocks with 2+ notes (single notes aren't "blocks")
  return blocks.filter(b => b.noteCount >= 2);
}

function finalizeBlock(block: { title: string; notes: string[]; words: TextractWord[] }): NoteBlock {
  return {
    title: block.title,
    notes: block.notes,
    bbox: mergeBbox(block.words),
    noteCount: block.notes.length,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Main Export
// ═══════════════════════════════════════════════════════════════════

/**
 * Analyze a page and produce PageIntelligence.
 * Each sub-analysis is wrapped in try/catch so one failure
 * doesn't block the others.
 */
export function analyzePageIntelligence(
  drawingNumber: string | null,
  textractData: TextractPageData | null,
  csiCodes: CsiCode[] | null,
): PageIntelligence {
  const result: PageIntelligence = {};

  // Page classification
  try {
    const classification = classifyPage(drawingNumber, csiCodes);
    if (classification) result.classification = classification;
  } catch (err) {
    console.error("[page-analysis] classifyPage failed:", err);
  }

  // Cross-page references
  try {
    if (textractData) {
      const crossRefs = detectCrossRefs(textractData);
      if (crossRefs.length > 0) result.crossRefs = crossRefs;
    }
  } catch (err) {
    console.error("[page-analysis] detectCrossRefs failed:", err);
  }

  // Note blocks
  try {
    if (textractData) {
      const noteBlocks = detectNoteBlocks(textractData);
      if (noteBlocks.length > 0) result.noteBlocks = noteBlocks;
    }
  } catch (err) {
    console.error("[page-analysis] detectNoteBlocks failed:", err);
  }

  return result;
}
