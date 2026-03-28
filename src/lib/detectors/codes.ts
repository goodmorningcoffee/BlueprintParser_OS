/**
 * detectors/codes.ts
 *
 * Detects construction spec sections, building codes, and code compliance phrases.
 */

import type { TextAnnotation } from "@/types";
import {
  isAdjacent,
  slidingWindow,
  makeAnnotation,
  avgConf,
} from "@/lib/ocr-utils";
import type { DetectorContext, TextDetector } from "./types";

// ═══════════════════════════════════════════════════════════════════
// Module-scope compiled regexes and constants
// ═══════════════════════════════════════════════════════════════════

const RE_SPEC_3GROUP = /^(\d{2})\s+(\d{2})\s+(\d{2})$/;
const RE_SPEC_SECTION = /^(?:SECTION|SEC\.?)\s+(\d{2})\s+(\d{2})\s+(\d{2})$/i;
const RE_SPEC_DIV = /^(?:DIV\.?|DIVISION)\s+(\d{1,2})$/i;
const KNOWN_CODES = new Set([
  "IBC", "IRC", "NFPA", "ADA", "OSHA", "ASHRAE", "ASCE", "ACI", "AISC",
  "NEC", "UPC", "UMC", "IMC", "IPC", "IFC", "IECC", "ANSI", "ASTM",
]);
const RE_CODE_YEAR = /^\d{2,4}$/;
const COMPLIANCE_PHRASES = [
  "PER CODE", "FIRE RATED", "1-HR RATED", "1 HR RATED", "2-HR RATED",
  "2 HR RATED", "SMOKE BARRIER", "FIRE BARRIER", "RATED WALL",
  "FIRE WALL", "RATED ASSEMBLY", "FIRE SEPARATION", "FIRE PARTITION",
  "SMOKE PARTITION", "LISTED ASSEMBLY", "UL LISTED",
];

// ═══════════════════════════════════════════════════════════════════
// Detector
// ═══════════════════════════════════════════════════════════════════

function detect(ctx: DetectorContext): TextAnnotation[] {
  const { words } = ctx;
  const results: TextAnnotation[] = [];
  const upperTexts = words.map(w => w.text.toUpperCase());

  // Sliding window for multi-word patterns
  for (const win of slidingWindow(words, 6)) {
    const upper = win.text.toUpperCase();

    // Spec section: "Section 09 21 16" or "09 21 16"
    if (RE_SPEC_SECTION.test(upper)) {
      results.push(makeAnnotation("spec-section", "codes",
        win.group, win.indices, avgConf(win.group),
        { meta: { section: upper } }));
      continue;
    }
    if (RE_SPEC_DIV.test(upper)) {
      results.push(makeAnnotation("spec-section", "codes",
        win.group, win.indices, avgConf(win.group),
        { meta: { division: upper } }));
      continue;
    }
    if (win.group.length === 3 && RE_SPEC_3GROUP.test(upper)) {
      results.push(makeAnnotation("spec-section", "codes",
        win.group, win.indices, avgConf(win.group),
        { meta: { section: upper } }));
      continue;
    }

    // Compliance phrases
    for (const phrase of COMPLIANCE_PHRASES) {
      if (upper === phrase) {
        results.push(makeAnnotation("code-compliance", "codes",
          win.group, win.indices, avgConf(win.group)));
        break;
      }
    }
  }

  // Building codes (single word + optional number/year)
  for (let i = 0; i < words.length; i++) {
    const upper = upperTexts[i];
    if (KNOWN_CODES.has(upper)) {
      const codeWords = [words[i]];
      const codeIndices = [i];
      // Look for trailing number/year
      if (i + 1 < words.length && isAdjacent(words[i], words[i + 1])
          && RE_CODE_YEAR.test(words[i + 1].text)) {
        codeWords.push(words[i + 1]);
        codeIndices.push(i + 1);
      }
      results.push(makeAnnotation("building-code", "codes",
        codeWords, codeIndices, avgConf(codeWords),
        { meta: { code: upper } }));
    }
  }

  return results;
}

export const codesDetector: TextDetector = {
  meta: {
    id: "codes",
    name: "Construction Codes",
    category: "heuristic",
    description: "Detects construction spec sections, building codes, and code compliance phrases.",
    defaultEnabled: true,
    produces: ["spec-section", "building-code", "code-compliance"],
  },
  detect,
};
