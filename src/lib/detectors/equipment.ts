/**
 * detectors/equipment.ts
 *
 * Detects equipment tags, door/window tags, finish codes, material codes,
 * panel references, and circuit identifiers.
 */

import type { TextAnnotation } from "@/types";
import {
  isAdjacent,
  makeAnnotation,
  avgConf,
} from "@/lib/ocr-utils";
import type { DetectorContext, TextDetector } from "./types";

// ═══════════════════════════════════════════════════════════════════
// Module-scope compiled regexes and constants
// ═══════════════════════════════════════════════════════════════════

const EQUIP_PREFIXES = new Set([
  "AHU", "RTU", "EF", "P", "FCU", "MAU", "VAV", "BLR", "CH", "CT",
  "CP", "UH", "FAN", "CUH", "SF", "RF", "ERV", "HRV", "AC", "HP",
  "FPB", "VFD", "HX", "WH", "PRV", "PMP",
]);
const RE_EQUIP_TAG = /^([A-Z]{1,4})-(\d{1,4}[A-Z]?)$/;
const RE_DOOR_TAG = /^D-?(\d{1,4}[A-Z]?)$/i;
const RE_WINDOW_TAG = /^W-?(\d{1,4}[A-Z]?)$/i;
const FINISH_PREFIXES = new Set([
  "PT", "CPT", "CT", "VCT", "WD", "ACT", "RB", "EP", "CRM", "CMU",
  "GWB", "FRP", "LVT", "SLT", "TER", "QT",
]);
const RE_FINISH_CODE = /^([A-Z]{2,4})-?(\d{1,3}[A-Z]?)$/;
const RE_MATERIAL_CODE = /^([A-Z]{1,3})-?(\d{1,4})$/;
const RE_PANEL_REF = /^(?:PANEL|PNL)\s+([A-Z0-9-]+)$/i;
const RE_PANEL_LP = /^LP-?\d+[A-Z]?$/i;
const RE_CIRCUIT = /^(?:CKT|CIRCUIT)\s+(\d+[A-Z]?)$/i;

// ═══════════════════════════════════════════════════════════════════
// Detector
// ═══════════════════════════════════════════════════════════════════

function detect(ctx: DetectorContext): TextAnnotation[] {
  const { words } = ctx;
  const results: TextAnnotation[] = [];

  for (let i = 0; i < words.length; i++) {
    const txt = words[i].text;
    const upper = txt.toUpperCase();

    // Equipment tag: AHU-1, RTU-3A, etc.
    const equipMatch = RE_EQUIP_TAG.exec(upper);
    if (equipMatch && EQUIP_PREFIXES.has(equipMatch[1])) {
      results.push(makeAnnotation("equipment-tag", "equipment",
        [words[i]], [i], words[i].confidence,
        { group: equipMatch[1], meta: { prefix: equipMatch[1], number: equipMatch[2] } }));
      continue;
    }

    // Equipment tag: two-word (prefix + number) e.g., "AHU" "1"
    if (EQUIP_PREFIXES.has(upper) && i + 1 < words.length && isAdjacent(words[i], words[i + 1])) {
      const nextTxt = words[i + 1].text;
      if (/^\d{1,4}[A-Z]?$/i.test(nextTxt)) {
        results.push(makeAnnotation("equipment-tag", "equipment",
          [words[i], words[i + 1]], [i, i + 1],
          avgConf([words[i], words[i + 1]]),
          { group: upper, meta: { prefix: upper, number: nextTxt } }));
        i += 1;
        continue;
      }
    }

    // Door tag: D-101, D101
    const doorMatch = RE_DOOR_TAG.exec(upper);
    if (doorMatch) {
      results.push(makeAnnotation("door-window-tag", "equipment",
        [words[i]], [i], words[i].confidence,
        { group: "D", meta: { prefix: "D", number: doorMatch[1] } }));
      continue;
    }

    // Window tag: W-201, W201
    const winMatch = RE_WINDOW_TAG.exec(upper);
    if (winMatch) {
      results.push(makeAnnotation("door-window-tag", "equipment",
        [words[i]], [i], words[i].confidence,
        { group: "W", meta: { prefix: "W", number: winMatch[1] } }));
      continue;
    }

    // Finish code: PT-1, VCT-2, ACT-3
    const finishMatch = RE_FINISH_CODE.exec(upper);
    if (finishMatch && FINISH_PREFIXES.has(finishMatch[1])) {
      results.push(makeAnnotation("finish-code", "equipment",
        [words[i]], [i], words[i].confidence,
        { group: finishMatch[1], meta: { prefix: finishMatch[1], code: finishMatch[2] } }));
      continue;
    }

    // Panel: "Panel LP-1", "LP-2"
    if (RE_PANEL_LP.test(upper)) {
      results.push(makeAnnotation("panel-circuit", "equipment",
        [words[i]], [i], words[i].confidence,
        { meta: { panel: upper } }));
      continue;
    }

    // Panel: "Panel X" (two-word)
    if (/^PANEL$/i.test(txt) && i + 1 < words.length && isAdjacent(words[i], words[i + 1])) {
      const nextUpper = words[i + 1].text.toUpperCase();
      if (/^[A-Z0-9][-A-Z0-9]*$/.test(nextUpper)) {
        results.push(makeAnnotation("panel-circuit", "equipment",
          [words[i], words[i + 1]], [i, i + 1],
          avgConf([words[i], words[i + 1]]),
          { meta: { panel: nextUpper } }));
        i += 1;
        continue;
      }
    }

    // Circuit: CKT 12, CIRCUIT 5
    if (/^(?:CKT|CIRCUIT)$/i.test(txt) && i + 1 < words.length
        && isAdjacent(words[i], words[i + 1])) {
      const nextTxt = words[i + 1].text;
      if (/^\d+[A-Z]?$/i.test(nextTxt)) {
        results.push(makeAnnotation("panel-circuit", "equipment",
          [words[i], words[i + 1]], [i, i + 1],
          avgConf([words[i], words[i + 1]]),
          { meta: { circuit: nextTxt } }));
        i += 1;
        continue;
      }
    }

    // Generic material code: letter(s) + number  (catch-all, lower confidence)
    const matMatch = RE_MATERIAL_CODE.exec(upper);
    if (matMatch && !EQUIP_PREFIXES.has(matMatch[1]) && !FINISH_PREFIXES.has(matMatch[1])
        && matMatch[1] !== "D" && matMatch[1] !== "W"
        && !/^LP$/i.test(matMatch[1])) {
      // Exclude things that look like sheet references (A-101, M-401, etc.) by length check
      if (matMatch[1].length <= 2 && matMatch[2].length >= 1) {
        results.push(makeAnnotation("material-code", "equipment",
          [words[i]], [i], words[i].confidence * 0.7,
          { group: matMatch[1], meta: { prefix: matMatch[1], number: matMatch[2] } }));
      }
    }
  }

  return results;
}

export const equipmentDetector: TextDetector = {
  meta: {
    id: "equipment",
    name: "Equipment & Tags",
    category: "heuristic",
    description: "Detects equipment tags, material codes, door/window tags, finish codes, and panel/circuit references.",
    defaultEnabled: true,
    produces: ["equipment-tag", "material-code", "door-window-tag", "finish-code", "panel-circuit"],
  },
  detect,
};
