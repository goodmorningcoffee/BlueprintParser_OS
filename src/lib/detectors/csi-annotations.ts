/**
 * detectors/csi-annotations.ts
 *
 * Turns the CSI tagger's own trigger spans into `csi-code` text annotations, plus printed code
 * numbers ("09 21 16") found in the Textract words. Uses ctx.csiCodes from the detector context.
 *
 * [csi-v2 S6] (IMPLEMENTATION E8) The detector no longer re-finds each code's DESCRIPTION
 * word-for-word on the page — v2 descriptions are the 2018 titles, which rarely appear verbatim.
 * It reads the v2 triggers instead: each EMITTED trigger becomes one annotation over the page words
 * whose bbox is one of the trigger's per-word `bboxes` (or, for a pre-v2 trigger with only a union
 * `bbox`, the words whose centre lies inside it). A code without triggers adds no span annotation.
 */

import type { BboxLTWH, CsiCode, TextAnnotation, TextractWord } from "@/types";
import {
  makeAnnotation,
  avgConf,
} from "@/lib/ocr-utils";
import type { DetectorContext, TextDetector } from "./types";

const boxKey = (b: BboxLTWH): string => `${b[0]},${b[1]},${b[2]},${b[3]}`;

/** Word indices a trigger covers: exact per-word boxes first, else centre-in-union. Ascending. */
function wordsOfTrigger(
  t: { bbox: BboxLTWH; bboxes?: BboxLTWH[] },
  words: TextractWord[],
  byBox: Map<string, number[]>,
): number[] {
  const idx = new Set<number>();
  for (const b of t.bboxes ?? [t.bbox]) for (const i of byBox.get(boxKey(b)) ?? []) idx.add(i);
  if (idx.size === 0) {
    const [l, top, w, h] = t.bbox;
    words.forEach((wd, i) => {
      const cx = wd.bbox[0] + wd.bbox[2] / 2, cy = wd.bbox[1] + wd.bbox[3] / 2;
      if (cx >= l && cx <= l + w && cy >= top && cy <= top + h) idx.add(i);
    });
  }
  return [...idx].sort((a, b) => a - b);
}

/** A v2 trigger records `emitted: false` for a span that did not count (e.g. "BY OTHERS"). */
function isEmitted(t: object): boolean {
  return !("emitted" in t) || t.emitted !== false;
}

function meta(csi: CsiCode): Record<string, unknown> {
  return { code: csi.code, description: csi.description, trade: csi.trade, division: csi.division };
}

// ═══════════════════════════════════════════════════════════════════
// Detector
// ═══════════════════════════════════════════════════════════════════

function detect(ctx: DetectorContext): TextAnnotation[] {
  const { words, csiCodes } = ctx;
  if (!csiCodes || csiCodes.length === 0) return [];
  const results: TextAnnotation[] = [];
  const byBox = new Map<string, number[]>();
  words.forEach((w, i) => {
    const k = boxKey(w.bbox);
    const list = byBox.get(k);
    if (list) list.push(i);
    else byBox.set(k, [i]);
  });

  for (const csi of csiCodes) {
    // The tagger's own spans (v2 triggers) — no description re-matching.
    for (const t of csi.triggers ?? []) {
      if (!isEmitted(t)) continue;
      const matchIndices = wordsOfTrigger(t, words, byBox);
      if (matchIndices.length === 0) continue;
      const matchWords = matchIndices.map((i) => words[i]);
      results.push(makeAnnotation("csi-code", "csi",
        matchWords, matchIndices, avgConf(matchWords),
        { group: csi.division, meta: meta(csi) }));
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
    description: "Marks the CSI tagger's matched spans and printed CSI code numbers at their OCR word positions.",
    defaultEnabled: true,
    produces: ["csi-code"],
  },
  detect,
};
