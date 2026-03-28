/**
 * detectors/notes.ts
 *
 * Detects general notes, numbered notes, typical markers, and coordination phrases.
 * Uses both word-level and line-level detection (TextractLine[]).
 */

import type { TextAnnotation } from "@/types";
import {
  slidingWindow,
  makeAnnotation,
  avgConf,
  findWordIndex,
} from "@/lib/ocr-utils";
import type { DetectorContext, TextDetector } from "./types";

// ═══════════════════════════════════════════════════════════════════
// Module-scope compiled regexes and constants
// ═══════════════════════════════════════════════════════════════════

const RE_NOTE_PREFIX = /^(?:NOTE|GENERAL\s+NOTE|GEN\.?\s+NOTE)S?:?\s*/i;
const RE_NUMBERED_NOTE = /^(\d+)\.\s+/;
const TYPICAL_MARKERS = new Set(["TYP.", "TYP", "TYPICAL", "U.N.O.", "UNO", "SIM.", "SIM", "SIMILAR"]);
const COORDINATION_PHRASES = [
  "COORDINATE WITH", "COORD. WITH", "COORD WITH",
  "FIELD VERIFY", "FIELD MEASURE",
  "CONTRACTOR TO PROVIDE", "CONTRACTOR SHALL",
  "VERIFY IN FIELD", "VERIFY WITH", "SUBMIT FOR APPROVAL",
  "PROVIDE BLOCKING", "SEE SPECIFICATIONS",
];

// ═══════════════════════════════════════════════════════════════════
// Detector
// ═══════════════════════════════════════════════════════════════════

function detect(ctx: DetectorContext): TextAnnotation[] {
  const { words, lines } = ctx;
  const results: TextAnnotation[] = [];

  // Line-level detection for notes
  for (const line of lines) {
    const upper = line.text.toUpperCase().trim();

    // General notes
    if (RE_NOTE_PREFIX.test(upper)) {
      const lineWords = line.words;
      const wordIndices = lineWords.map(w => {
        for (let i = 0; i < words.length; i++) {
          if (words[i] === w) return i;
        }
        // fallback: find by position
        return findWordIndex(words, w);
      });
      results.push(makeAnnotation("general-note", "notes",
        lineWords, wordIndices, avgConf(lineWords)));
      continue;
    }

    // Numbered notes: 1. text, 2. text
    if (RE_NUMBERED_NOTE.test(upper)) {
      const lineWords = line.words;
      const wordIndices = lineWords.map(w => findWordIndex(words, w));
      results.push(makeAnnotation("general-note", "notes",
        lineWords, wordIndices, avgConf(lineWords)));
      continue;
    }

    // Coordination phrases
    for (const phrase of COORDINATION_PHRASES) {
      if (upper.includes(phrase)) {
        const lineWords = line.words;
        const wordIndices = lineWords.map(w => findWordIndex(words, w));
        results.push(makeAnnotation("coordination-note", "notes",
          lineWords, wordIndices, avgConf(lineWords)));
        break;
      }
    }
  }

  // Single-word: typical markers
  for (let i = 0; i < words.length; i++) {
    const upper = words[i].text.toUpperCase();
    if (TYPICAL_MARKERS.has(upper)) {
      results.push(makeAnnotation("typical-marker", "notes",
        [words[i]], [i], words[i].confidence));
    }
  }

  // Multi-word typical/coordination via sliding window
  for (const win of slidingWindow(words, 4)) {
    const upper = win.text.toUpperCase();
    for (const phrase of COORDINATION_PHRASES) {
      if (upper === phrase) {
        results.push(makeAnnotation("coordination-note", "notes",
          win.group, win.indices, avgConf(win.group)));
        break;
      }
    }
  }

  return results;
}

export const notesDetector: TextDetector = {
  meta: {
    id: "notes",
    name: "General Notes",
    category: "heuristic",
    description: "Detects general notes, typical markers, and coordination notes.",
    defaultEnabled: true,
    produces: ["general-note", "typical-marker", "coordination-note"],
  },
  detect,
};
