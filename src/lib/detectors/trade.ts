/**
 * detectors/trade.ts
 *
 * Detects structural, mechanical, electrical, plumbing, and fire protection
 * trade callouts including rebar, steel shapes, CFM, GPM, BTU, voltage, etc.
 */

import type { TextractWord, TextAnnotation } from "@/types";
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

const RE_REBAR = /^#(\d+)\s*@?\s*(\d+)?\s*(?:O\.?C\.?)?$/;
const RE_STEEL_W = /^W(\d+)[Xx](\d+)$/;
const RE_STEEL_HSS = /^HSS\s*\d+[Xx]\d+[Xx]\d+/;
const RE_CONCRETE_FC = /^f'?c\s*=\s*(\d+)/i;
const RE_CFM = /^(\d+(?:,\d{3})*)\s*CFM$/i;
const RE_GPM = /^(\d+(?:\.\d+)?)\s*GPM$/i;
const RE_BTU = /^(\d+(?:,\d{3})*)\s*(?:BTU\/?H?|BTUH|MBH)$/i;
const RE_TONS = /^(\d+(?:\.\d+)?)\s*(?:TON|TONS)$/i;
const MECH_KEYWORDS = new Set([
  "SUPPLY AIR", "RETURN AIR", "EXHAUST AIR", "OUTSIDE AIR",
  "DUCTWORK", "DUCT", "DIFFUSER", "DAMPER", "GRILLE", "REGISTER",
  "THERMOSTAT", "VAV BOX", "FLEX DUCT", "LOUVER", "MIXING BOX",
]);
const RE_AMPS = /^(\d+)\s*A(?:MP)?S?$/i;
const RE_VOLTAGE = /^(\d+(?:\/\d+)?)\s*V(?:AC|DC)?$/i;
const RE_WIRE = /^#(\d+)\s*(?:AWG|MCM)?$/i;
const ELEC_KEYWORDS = new Set([
  "EMT", "CONDUIT", "JUNCTION BOX", "J-BOX", "DISCONNECT",
  "TRANSFORMER", "SWITCHGEAR", "PANEL BOARD", "PANELBOARD",
  "RECEPTACLE", "SWITCH", "MOTOR", "STARTER", "MCC",
  "GFI", "GFCI", "ARC FAULT", "CIRCUIT BREAKER",
]);
const PLUMB_KEYWORDS = new Set([
  "HW", "CW", "HWR", "HWS", "CWS", "WASTE", "VENT", "CLEANOUT",
  "C.O.", "FD", "FLOOR DRAIN", "BACKFLOW", "PRV", "RELIEF VALVE",
  "TRAP PRIMER", "WATER HEATER", "EXPANSION TANK", "HOSE BIB",
  "SANITARY", "STORM", "ROOF DRAIN", "OVERFLOW", "P-TRAP",
]);
const FIRE_KEYWORDS = new Set([
  "SPRINKLER", "FIRE ALARM", "PULL STATION", "SMOKE DET.",
  "SMOKE DETECTOR", "FDC", "STANDPIPE", "FIRE DEPT. CONNECTION",
  "FIRE EXTINGUISHER", "FIRE HOSE", "HORN/STROBE", "HORN STROBE",
  "ANNUNCIATOR", "FIRE RATED", "HALON", "FM-200", "ANSUL",
  "WET PIPE", "DRY PIPE", "PRE-ACTION", "DELUGE",
]);

// ═══════════════════════════════════════════════════════════════════
// Detector
// ═══════════════════════════════════════════════════════════════════

function detect(ctx: DetectorContext): TextAnnotation[] {
  const { words } = ctx;
  const results: TextAnnotation[] = [];

  // Sliding window for multi-word trade callouts
  for (const win of slidingWindow(words, 4)) {
    const upper = win.text.toUpperCase();

    // Mechanical keywords
    if (MECH_KEYWORDS.has(upper)) {
      results.push(makeAnnotation("mechanical", "trade",
        win.group, win.indices, avgConf(win.group)));
      continue;
    }

    // Electrical keywords
    if (ELEC_KEYWORDS.has(upper)) {
      results.push(makeAnnotation("electrical", "trade",
        win.group, win.indices, avgConf(win.group)));
      continue;
    }

    // Plumbing keywords
    if (PLUMB_KEYWORDS.has(upper)) {
      results.push(makeAnnotation("plumbing", "trade",
        win.group, win.indices, avgConf(win.group)));
      continue;
    }

    // Fire protection keywords
    if (FIRE_KEYWORDS.has(upper)) {
      results.push(makeAnnotation("fire-protection", "trade",
        win.group, win.indices, avgConf(win.group)));
      continue;
    }
  }

  // Single-word & pattern-based
  for (let i = 0; i < words.length; i++) {
    const txt = words[i].text;
    const upper = txt.toUpperCase();

    // Rebar: #4@12 O.C. or #4 @ 12 O.C.
    if (RE_REBAR.test(upper)) {
      results.push(makeAnnotation("structural", "trade",
        [words[i]], [i], words[i].confidence,
        { meta: { rebar: upper } }));
      continue;
    }
    // Multi-word rebar: #4 @ 12" O.C.
    if (/^#\d+$/.test(txt) && i + 1 < words.length) {
      const lookAhead: TextractWord[] = [words[i]];
      const lookIndices = [i];
      let j = i + 1;
      while (j < Math.min(i + 4, words.length) && isAdjacent(words[j - 1], words[j])) {
        lookAhead.push(words[j]);
        lookIndices.push(j);
        j++;
      }
      const combined = lookAhead.map(w => w.text).join(" ").toUpperCase();
      if (/O\.?C\.?/.test(combined) || /@/.test(combined)) {
        results.push(makeAnnotation("structural", "trade",
          lookAhead, lookIndices, avgConf(lookAhead),
          { meta: { rebar: combined } }));
        i = j - 1;
        continue;
      }
    }

    // Steel shapes: W12x26, HSS6x6x1/2
    if (RE_STEEL_W.test(upper) || RE_STEEL_HSS.test(upper)) {
      results.push(makeAnnotation("structural", "trade",
        [words[i]], [i], words[i].confidence,
        { meta: { steelShape: upper } }));
      continue;
    }

    // Concrete strength: f'c=4000
    const fcMatch = RE_CONCRETE_FC.exec(upper);
    if (fcMatch) {
      results.push(makeAnnotation("structural", "trade",
        [words[i]], [i], words[i].confidence,
        { meta: { concreteStrength: Number(fcMatch[1]) } }));
      continue;
    }

    // CFM
    if (RE_CFM.test(upper)) {
      results.push(makeAnnotation("mechanical", "trade",
        [words[i]], [i], words[i].confidence));
      continue;
    }
    // Two-word CFM: "350" "CFM"
    if (/^\d+(?:,\d{3})*$/.test(txt) && i + 1 < words.length
        && /^CFM$/i.test(words[i + 1].text) && isAdjacent(words[i], words[i + 1])) {
      results.push(makeAnnotation("mechanical", "trade",
        [words[i], words[i + 1]], [i, i + 1],
        avgConf([words[i], words[i + 1]])));
      i += 1;
      continue;
    }

    // GPM
    if (RE_GPM.test(upper)) {
      results.push(makeAnnotation("mechanical", "trade",
        [words[i]], [i], words[i].confidence));
      continue;
    }
    if (/^\d+(?:\.\d+)?$/.test(txt) && i + 1 < words.length
        && /^GPM$/i.test(words[i + 1].text) && isAdjacent(words[i], words[i + 1])) {
      results.push(makeAnnotation("mechanical", "trade",
        [words[i], words[i + 1]], [i, i + 1],
        avgConf([words[i], words[i + 1]])));
      i += 1;
      continue;
    }

    // BTU/MBH
    if (RE_BTU.test(upper)) {
      results.push(makeAnnotation("mechanical", "trade",
        [words[i]], [i], words[i].confidence));
      continue;
    }

    // Tons
    if (RE_TONS.test(upper)) {
      results.push(makeAnnotation("mechanical", "trade",
        [words[i]], [i], words[i].confidence));
      continue;
    }

    // Amps
    if (RE_AMPS.test(upper)) {
      results.push(makeAnnotation("electrical", "trade",
        [words[i]], [i], words[i].confidence));
      continue;
    }
    // Two-word amps: "20" "A"
    if (/^\d+$/.test(txt) && i + 1 < words.length
        && /^A(?:MP)?S?$/i.test(words[i + 1].text) && isAdjacent(words[i], words[i + 1])) {
      results.push(makeAnnotation("electrical", "trade",
        [words[i], words[i + 1]], [i, i + 1],
        avgConf([words[i], words[i + 1]])));
      i += 1;
      continue;
    }

    // Voltage: 120V, 120/208V, 277VAC
    if (RE_VOLTAGE.test(upper)) {
      results.push(makeAnnotation("electrical", "trade",
        [words[i]], [i], words[i].confidence));
      continue;
    }
    // Two-word voltage: "120/208" "V"
    if (/^\d+(?:\/\d+)?$/.test(txt) && i + 1 < words.length
        && /^V(?:AC|DC)?$/i.test(words[i + 1].text) && isAdjacent(words[i], words[i + 1])) {
      results.push(makeAnnotation("electrical", "trade",
        [words[i], words[i + 1]], [i, i + 1],
        avgConf([words[i], words[i + 1]])));
      i += 1;
      continue;
    }

    // Wire: #12 AWG, #10
    if (RE_WIRE.test(upper)) {
      results.push(makeAnnotation("electrical", "trade",
        [words[i]], [i], words[i].confidence));
      continue;
    }

    // Single-word trade keywords
    if (MECH_KEYWORDS.has(upper)) {
      results.push(makeAnnotation("mechanical", "trade",
        [words[i]], [i], words[i].confidence));
      continue;
    }
    if (ELEC_KEYWORDS.has(upper)) {
      results.push(makeAnnotation("electrical", "trade",
        [words[i]], [i], words[i].confidence));
      continue;
    }
    if (PLUMB_KEYWORDS.has(upper)) {
      results.push(makeAnnotation("plumbing", "trade",
        [words[i]], [i], words[i].confidence));
      continue;
    }
    if (FIRE_KEYWORDS.has(upper)) {
      results.push(makeAnnotation("fire-protection", "trade",
        [words[i]], [i], words[i].confidence));
      continue;
    }
  }

  return results;
}

export const tradeDetector: TextDetector = {
  meta: {
    id: "trade",
    name: "Trade Callouts",
    category: "heuristic",
    description: "Detects structural, mechanical, electrical, plumbing, and fire protection trade callouts.",
    defaultEnabled: true,
    produces: ["structural", "mechanical", "electrical", "plumbing", "fire-protection"],
  },
  detect,
};
