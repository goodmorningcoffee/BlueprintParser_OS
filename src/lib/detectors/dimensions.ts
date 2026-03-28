/**
 * detectors/dimensions.ts
 *
 * Detects imperial dimensions, metric dimensions, scales, and slopes.
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
// Module-scope compiled regexes
// ═══════════════════════════════════════════════════════════════════

const RE_IMPERIAL_FULL = /^\d+'-\d{1,2}"?$/;
const RE_IMPERIAL_FEET = /^\d+'-?\s*\d*"?$/;
const RE_IMPERIAL_FRACTION = /^\d*\s*\d+\/\d+"$/;
const RE_IMPERIAL_INCH = /^\d+"$/;
const RE_METRIC_MM = /^\d+(?:\.\d+)?\s*mm$/i;
const RE_METRIC_M = /^\d+(?:\.\d+)?\s*m$/i;
const RE_METRIC_CM = /^\d+(?:\.\d+)?\s*cm$/i;
const RE_SCALE_FRACTION = /^\d+\/\d+"\s*=\s*\d+'-\d+"$/;
const RE_SCALE_RATIO = /^1:\d+$/;
const RE_SCALE_NTS = /^(?:SCALE:?\s*)?N\.?T\.?S\.?$/i;
const RE_SCALE_PREFIX = /^SCALE:?$/i;
const RE_SLOPE_PERCENT = /^\d+(?:\.\d+)?%\s*(?:SLOPE|SLP\.?|MIN\.?)?$/i;
const RE_SLOPE_RATIO = /^\d+\/\d+(?:"|'')\s*:\s*\d+(?:'|FT)?$/i;
const RE_SLOPE_WORD = /^SLOPE$/i;

// ═══════════════════════════════════════════════════════════════════
// Detector
// ═══════════════════════════════════════════════════════════════════

function detect(ctx: DetectorContext): TextAnnotation[] {
  const { words } = ctx;
  const results: TextAnnotation[] = [];

  for (const win of slidingWindow(words, 5)) {
    const txt = win.text;
    const trimmed = txt.replace(/\s+/g, "");

    // Imperial: 12'-6", 3'-0", etc.
    if (win.group.length <= 3 && (RE_IMPERIAL_FULL.test(trimmed) || RE_IMPERIAL_FEET.test(trimmed))) {
      results.push(makeAnnotation("imperial-dim", "dimensions",
        win.group, win.indices, avgConf(win.group)));
      continue;
    }

    // Scale: 1/4" = 1'-0" (multi-word)
    if (RE_SCALE_FRACTION.test(trimmed)) {
      results.push(makeAnnotation("scale", "dimensions",
        win.group, win.indices, avgConf(win.group)));
      continue;
    }

    // Scale: SCALE: 1/4" = 1'-0" or SCALE: NTS
    if (win.group.length >= 2) {
      const upper = txt.toUpperCase();
      if (RE_SCALE_PREFIX.test(win.group[0].text)) {
        const rest = win.group.slice(1).map(w => w.text).join("").replace(/\s/g, "");
        if (RE_SCALE_NTS.test(rest) || RE_SCALE_RATIO.test(rest) || RE_SCALE_FRACTION.test(rest)) {
          results.push(makeAnnotation("scale", "dimensions",
            win.group, win.indices, avgConf(win.group)));
          continue;
        }
      }
    }

    // Slope: 2% SLOPE, N% SLP
    if (RE_SLOPE_PERCENT.test(txt.replace(/\s+/g, " ").trim())) {
      results.push(makeAnnotation("slope", "dimensions",
        win.group, win.indices, avgConf(win.group)));
      continue;
    }

    // Slope ratio
    if (RE_SLOPE_RATIO.test(trimmed)) {
      results.push(makeAnnotation("slope", "dimensions",
        win.group, win.indices, avgConf(win.group)));
      continue;
    }
  }

  // Single-word checks
  for (let i = 0; i < words.length; i++) {
    const txt = words[i].text;

    // Imperial fraction: 3/4"
    if (RE_IMPERIAL_FRACTION.test(txt)) {
      results.push(makeAnnotation("imperial-dim", "dimensions",
        [words[i]], [i], words[i].confidence));
      continue;
    }

    // Imperial inches: 6"
    if (RE_IMPERIAL_INCH.test(txt)) {
      results.push(makeAnnotation("imperial-dim", "dimensions",
        [words[i]], [i], words[i].confidence));
      continue;
    }

    // Metric
    if (RE_METRIC_MM.test(txt) || RE_METRIC_M.test(txt) || RE_METRIC_CM.test(txt)) {
      results.push(makeAnnotation("metric-dim", "dimensions",
        [words[i]], [i], words[i].confidence));
      continue;
    }

    // Scale ratio: 1:50
    if (RE_SCALE_RATIO.test(txt)) {
      results.push(makeAnnotation("scale", "dimensions",
        [words[i]], [i], words[i].confidence));
      continue;
    }

    // NTS
    if (RE_SCALE_NTS.test(txt)) {
      results.push(makeAnnotation("scale", "dimensions",
        [words[i]], [i], words[i].confidence));
      continue;
    }

    // Slope with % followed by SLOPE word
    if (/^\d+(?:\.\d+)?%$/.test(txt) && i + 1 < words.length
        && RE_SLOPE_WORD.test(words[i + 1].text) && isAdjacent(words[i], words[i + 1])) {
      results.push(makeAnnotation("slope", "dimensions",
        [words[i], words[i + 1]], [i, i + 1],
        avgConf([words[i], words[i + 1]])));
      i += 1;
      continue;
    }
  }

  return results;
}

export const dimensionsDetector: TextDetector = {
  meta: {
    id: "dimensions",
    name: "Dimensions & Scales",
    category: "heuristic",
    description: "Detects imperial dimensions, metric dimensions, scales, and slopes.",
    defaultEnabled: true,
    produces: ["imperial-dim", "metric-dim", "scale", "slope"],
  },
  detect,
};
