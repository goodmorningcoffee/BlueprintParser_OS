/**
 * detectors/rooms.ts
 *
 * Detects room numbers, named rooms, and area/zone designations.
 */

import type { TextAnnotation, TextractWord } from "@/types";
import {
  isAdjacent,
  slidingWindow,
  makeAnnotation,
  avgConf,
} from "@/lib/ocr-utils";
import { computePageZones, zoneOf } from "@/lib/page-zones";
import { ltwh2minmax } from "@/lib/bbox-utils";
import type { DetectorContext, TextDetector } from "./types";

// ═══════════════════════════════════════════════════════════════════
// Module-scope compiled regexes and constants
// ═══════════════════════════════════════════════════════════════════

const RE_ROOM_NUMBER = /^\d{3,4}[A-Z]?$/;
const ROOM_NAMES = new Set([
  "LOBBY", "CORRIDOR", "HALLWAY", "MECH. ROOM", "MECHANICAL ROOM",
  "MECH ROOM", "ELEC. ROOM", "ELECTRICAL ROOM", "ELEC ROOM",
  "JANITOR", "JANITOR'S CLOSET", "JAN. CLOSET", "STORAGE",
  "RESTROOM", "BATHROOM", "TOILET", "MEN", "WOMEN", "MEN'S", "WOMEN'S",
  "OFFICE", "CONFERENCE", "CONFERENCE ROOM", "CONF. ROOM",
  "KITCHEN", "BREAK ROOM", "BREAKROOM", "LUNCHROOM",
  "SERVER ROOM", "DATA ROOM", "IT ROOM", "TELECOM", "IDF", "MDF",
  "VESTIBULE", "STAIRWELL", "STAIR", "STAIRWAY",
  "ELEVATOR", "ELEVATOR LOBBY", "ELEV. LOBBY",
  "CLASSROOM", "LAB", "LABORATORY", "LIBRARY", "GYMNASIUM", "GYM",
  "CAFETERIA", "AUDITORIUM", "RECEPTION", "WAITING",
  "NURSE", "EXAM ROOM", "COPY ROOM", "MAIL ROOM", "LOADING DOCK",
  "MECHANICAL", "ELECTRICAL", "PLUMBING", "BOILER ROOM",
]);
const RE_AREA_DESIGNATION = /^(?:ZONE|AREA|PHASE|WING)\s+([A-Z\d]+)$/i;

// ═══════════════════════════════════════════════════════════════════
// Detector
// ═══════════════════════════════════════════════════════════════════

/**
 * [zones T2] "Is this word in the title block?" — the DETECTED title block when the context
 * carries YOLO detections with one (`page-zones.ts`, ≥ 70 % containment); otherwise the legacy
 * rule, unchanged: word centre in the bottom 15 % of the sheet.
 */
function titleBlockTest(ctx: DetectorContext): (w: TextractWord) => boolean {
  const zones = ctx.yoloDetections?.length ? computePageZones(ctx.yoloDetections) : null;
  if (zones?.source === "detector") return (w) => zoneOf(zones, ltwh2minmax(w.bbox)) === "title_block";
  return (w) => w.bbox[1] + w.bbox[3] / 2 >= 0.85;
}

function detect(ctx: DetectorContext): TextAnnotation[] {
  const { words } = ctx;
  const results: TextAnnotation[] = [];
  const inTitleBlock = titleBlockTest(ctx);

  for (let i = 0; i < words.length; i++) {
    const txt = words[i].text;
    const upper = txt.toUpperCase();

    // Room numbers: 3-4 digit numbers NOT in the title block (detected zone, else bottom 15%)
    if (RE_ROOM_NUMBER.test(upper) && !inTitleBlock(words[i])) {
      results.push(makeAnnotation("room-number", "rooms",
        [words[i]], [i], words[i].confidence * 0.75,
        { meta: { roomNumber: upper } }));
      continue;
    }

    // Area designation: ZONE 1, AREA A, PHASE 2, WING B
    if (/^(?:ZONE|AREA|PHASE|WING)$/i.test(upper) && i + 1 < words.length
        && isAdjacent(words[i], words[i + 1])) {
      const nextUpper = words[i + 1].text.toUpperCase();
      if (/^[A-Z\d]+$/.test(nextUpper)) {
        results.push(makeAnnotation("area-designation", "rooms",
          [words[i], words[i + 1]], [i, i + 1],
          avgConf([words[i], words[i + 1]]),
          { meta: { designation: `${upper} ${nextUpper}` } }));
        i += 1;
        continue;
      }
    }
  }

  // Room names: multi-word sliding window
  for (const win of slidingWindow(words, 3)) {
    const upper = win.text.toUpperCase();
    if (ROOM_NAMES.has(upper)) {
      results.push(makeAnnotation("room-name", "rooms",
        win.group, win.indices, avgConf(win.group),
        { meta: { roomName: upper } }));
    }
  }

  // Single-word room names
  for (let i = 0; i < words.length; i++) {
    const upper = words[i].text.toUpperCase();
    if (ROOM_NAMES.has(upper)) {
      results.push(makeAnnotation("room-name", "rooms",
        [words[i]], [i], words[i].confidence,
        { meta: { roomName: upper } }));
    }
  }

  // Single-word area designation: ZONE1 (no space)
  for (let i = 0; i < words.length; i++) {
    const match = RE_AREA_DESIGNATION.exec(words[i].text);
    if (match) {
      results.push(makeAnnotation("area-designation", "rooms",
        [words[i]], [i], words[i].confidence,
        { meta: { designation: words[i].text.toUpperCase() } }));
    }
  }

  return results;
}

export const roomsDetector: TextDetector = {
  meta: {
    id: "rooms",
    name: "Room Detection",
    category: "heuristic",
    description: "Detects room numbers, named rooms, and area/zone designations.",
    defaultEnabled: true,
    produces: ["room-number", "room-name", "area-designation"],
  },
  detect,
};
