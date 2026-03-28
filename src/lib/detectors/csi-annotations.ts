/**
 * detectors/csi-annotations.ts
 *
 * Matches CSI code descriptions and code numbers to Textract word bboxes.
 * Uses ctx.csiCodes from the detector context.
 */

import type { TextAnnotation } from "@/types";
import {
  makeAnnotation,
  avgConf,
} from "@/lib/ocr-utils";
import type { DetectorContext, TextDetector } from "./types";

// ═══════════════════════════════════════════════════════════════════
// Detector
// ═══════════════════════════════════════════════════════════════════

function detect(ctx: DetectorContext): TextAnnotation[] {
  const { words, csiCodes } = ctx;
  if (!csiCodes || csiCodes.length === 0) return [];
  const results: TextAnnotation[] = [];

  for (const csi of csiCodes) {
    // Find words matching the CSI description (phrase match)
    const descWords = csi.description.toLowerCase().split(/\s+/).filter(Boolean);
    if (descWords.length === 0) continue;

    const limit = words.length - descWords.length;
    for (let i = 0; i <= limit; i++) {
      let allMatch = true;
      for (let j = 0; j < descWords.length; j++) {
        if (words[i + j].text.toLowerCase().replace(/-/g, " ") !== descWords[j]) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) {
        const matchWords = words.slice(i, i + descWords.length);
        const matchIndices = Array.from({ length: descWords.length }, (_, j) => i + j);
        results.push(makeAnnotation("csi-code", "csi",
          matchWords, matchIndices, avgConf(matchWords),
          { group: csi.division, meta: { code: csi.code, description: csi.description, trade: csi.trade, division: csi.division } }));
      }
    }

    // Also match the CSI code number itself (e.g., "09 21 16")
    const codeDigits = csi.code.replace(/\s+/g, "");
    for (let i = 0; i < words.length; i++) {
      const combined = words[i].text.replace(/\s+/g, "");
      if (combined === codeDigits || combined === csi.code) {
        results.push(makeAnnotation("csi-code", "csi",
          [words[i]], [i], words[i].confidence,
          { group: csi.division, meta: { code: csi.code, description: csi.description, trade: csi.trade } }));
      }
    }
  }

  return results;
}

export const csiAnnotationsDetector: TextDetector = {
  meta: {
    id: "csi-annotations",
    name: "CSI Code Annotations",
    category: "csi",
    description: "Matches CSI code descriptions and numbers to OCR word positions.",
    defaultEnabled: true,
    produces: ["csi-code"],
  },
  detect,
};
