/**
 * detectors/references.ts
 *
 * Detects sheet numbers, sheet references, detail references, revisions,
 * and action markers.
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

const RE_SHEET_NUMBER = /^([A-Z]{1,2})-(\d{1,3})\.(\d{2})$/;
const DISCIPLINE_PREFIXES: Record<string, string> = {
  T: "Title/Cover", G: "General", C: "Civil", L: "Landscape",
  A: "Architectural", I: "Interior", ID: "Interior Design",
  DM: "Demolition", S: "Structural",
  M: "Mechanical", E: "Electrical", P: "Plumbing",
  FP: "Fire Protection", FA: "Fire Alarm", SP: "Sprinkler", SD: "Standpipe",
};
const RE_SHEET_REF = /^(?:SEE\s+)?(?:SHEET|SHT\.?|DWG\.?)\s+([A-Z]{1,2}-?\d{1,4}(?:\.\d{1,2})?)$/i;
const RE_REFER_TO = /^REFER\s+TO\s+([A-Z]{1,2}-?\d{1,4}(?:\.\d{1,2})?)$/i;
const RE_DETAIL_REF = /^(?:SEE\s+)?DETAIL\s+([A-Z\d]+(?:\/[A-Z]{1,2}-?\d{1,4})?)$/i;
const RE_DETAIL_SLASH = /^(\d+|[A-Z])\/([A-Z]{1,2}-?\d{1,4})$/;
const RE_REVISION = /^REV\.?\s+([A-Z\d]+)$/i;
const RE_REVISED_DATE = /^REVISED?\s+(\d{1,2}\/\d{1,2}\/\d{2,4})$/i;
const RE_BULLETIN = /^BULLETIN\s+#?(\d+)$/i;
const ACTION_MARKERS = new Set([
  "RFI", "VIF", "CONFIRM", "HOLD", "NIC", "BY OTHERS", "TBD",
  "DEFERRED", "PENDING", "OFCI", "OFOI", "N.I.C.", "BY OWNER",
]);

// ═══════════════════════════════════════════════════════════════════
// Detector
// ═══════════════════════════════════════════════════════════════════

function detect(ctx: DetectorContext): TextAnnotation[] {
  const { words } = ctx;
  const results: TextAnnotation[] = [];

  for (const win of slidingWindow(words, 5)) {
    const upper = win.text.toUpperCase();

    // Sheet references: SEE SHEET A-101, REFER TO M-401
    const sheetMatch = RE_SHEET_REF.exec(upper);
    if (sheetMatch) {
      results.push(makeAnnotation("sheet-ref", "references",
        win.group, win.indices, avgConf(win.group),
        { meta: { sheetNumber: sheetMatch[1] } }));
      continue;
    }

    const referMatch = RE_REFER_TO.exec(upper);
    if (referMatch) {
      results.push(makeAnnotation("sheet-ref", "references",
        win.group, win.indices, avgConf(win.group),
        { meta: { sheetNumber: referMatch[1] } }));
      continue;
    }

    // Detail references: SEE DETAIL 3/A-101, DETAIL A
    const detailMatch = RE_DETAIL_REF.exec(upper);
    if (detailMatch) {
      results.push(makeAnnotation("detail-ref", "references",
        win.group, win.indices, avgConf(win.group),
        { meta: { detail: detailMatch[1] } }));
      continue;
    }

    // Action markers (multi-word ones like BY OTHERS)
    if (ACTION_MARKERS.has(upper)) {
      results.push(makeAnnotation("action-marker", "references",
        win.group, win.indices, avgConf(win.group),
        { note: upper }));
      continue;
    }
  }

  // Single-word patterns
  for (let i = 0; i < words.length; i++) {
    const upper = words[i].text.toUpperCase();

    // Sheet numbers: A-001.00, E-100.00, FA-001.00, DM-100.00
    const sheetNumMatch = RE_SHEET_NUMBER.exec(upper);
    if (sheetNumMatch) {
      const prefix = sheetNumMatch[1];
      const discipline = DISCIPLINE_PREFIXES[prefix] || "Unknown";
      results.push(makeAnnotation("sheet-number", "references",
        [words[i]], [i], 0.90,
        { group: prefix, meta: { discipline, sheetNumber: upper } }));
      continue;
    }

    // Detail slash notation: 3/A-101
    const detSlash = RE_DETAIL_SLASH.exec(upper);
    if (detSlash) {
      results.push(makeAnnotation("detail-ref", "references",
        [words[i]], [i], words[i].confidence,
        { meta: { detail: detSlash[1], sheet: detSlash[2] } }));
      continue;
    }

    // Revision: REV A, REV 3
    if (/^REV\.?$/i.test(upper) && i + 1 < words.length && isAdjacent(words[i], words[i + 1])) {
      const nextUpper = words[i + 1].text.toUpperCase();
      if (/^[A-Z\d]+$/.test(nextUpper)) {
        results.push(makeAnnotation("revision", "references",
          [words[i], words[i + 1]], [i, i + 1],
          avgConf([words[i], words[i + 1]]),
          { meta: { revision: nextUpper } }));
        i += 1;
        continue;
      }
    }

    // Revision with date
    const revDateMatch = RE_REVISED_DATE.exec(
      upper + (i + 1 < words.length ? " " + words[i + 1].text : "")
    );
    if (revDateMatch && i + 1 < words.length) {
      results.push(makeAnnotation("revision", "references",
        [words[i], words[i + 1]], [i, i + 1],
        avgConf([words[i], words[i + 1]]),
        { meta: { date: revDateMatch[1] } }));
      i += 1;
      continue;
    }

    // Bulletin
    if (/^BULLETIN$/i.test(upper) && i + 1 < words.length && isAdjacent(words[i], words[i + 1])) {
      const nextTxt = words[i + 1].text;
      if (/^#?\d+$/.test(nextTxt)) {
        results.push(makeAnnotation("revision", "references",
          [words[i], words[i + 1]], [i, i + 1],
          avgConf([words[i], words[i + 1]]),
          { meta: { bulletin: nextTxt.replace("#", "") } }));
        i += 1;
        continue;
      }
    }

    // Single-word action markers (RFI, VIF, TBD, etc.)
    if (ACTION_MARKERS.has(upper)) {
      results.push(makeAnnotation("action-marker", "references",
        [words[i]], [i], words[i].confidence,
        { note: upper }));
    }
  }

  return results;
}

export const referencesDetector: TextDetector = {
  meta: {
    id: "references",
    name: "Sheet & Detail References",
    category: "heuristic",
    description: "Detects sheet numbers, sheet references, detail references, revisions, and action markers.",
    defaultEnabled: true,
    produces: ["sheet-number", "sheet-ref", "detail-ref", "revision", "action-marker"],
  },
  detect,
};
