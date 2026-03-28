/**
 * detectors/abbreviations.ts
 *
 * Detects AEC abbreviations via dictionary lookup (~200 entries)
 * and heuristic detection of unknown abbreviations by frequency.
 */

import type { AnnotationCategory, TextAnnotation } from "@/types";
import {
  makeAnnotation,
} from "@/lib/ocr-utils";
import type { DetectorContext, TextDetector } from "./types";

// ═══════════════════════════════════════════════════════════════════
// Module-scope constants
// ═══════════════════════════════════════════════════════════════════

const ABBR_STOP_WORDS = new Set([
  "THE", "AND", "FOR", "ARE", "BUT", "NOT", "YOU", "ALL", "CAN",
  "HER", "WAS", "ONE", "OUR", "OUT", "HAS", "HIS", "HOW", "ITS",
  "LET", "MAY", "NEW", "NOW", "OLD", "SEE", "WAY", "WHO", "BOY",
  "DID", "GET", "HIM", "HIT", "HOT", "MAP", "MOM", "SET", "SIT",
  "TOP", "TWO", "RED", "RUN", "USE", "PER", "MAX", "MIN", "REF",
  "FROM", "THAT", "WITH", "THIS", "HAVE", "WILL", "EACH", "MAKE",
  "LIKE", "BEEN", "CALL", "COME", "THAN", "INTO", "ONLY", "OVER",
  "SUCH", "TAKE", "THEM", "VERY", "WHEN", "ALSO", "BACK", "JUST",
  "KNOW", "SOME", "THEY", "WHAT", "PLAN", "AREA", "ROOM", "WALL",
  "DOOR", "ROOF", "PIPE", "DUCT", "WIRE", "BEAM", "SLAB", "NOTE",
  "TYPE", "SIZE", "HIGH", "WIDE", "LONG", "DEEP", "OPEN", "FLAT",
  "INCH", "FEET", "FOOT", "YARD", "MILE", "WEST", "EAST", "NORTH",
  "SOUTH", "LEFT", "RIGHT", "DATE", "NONE", "MARK", "LINE",
]);

// ═══════════════════════════════════════════════════════════════════
// AEC Abbreviation Dictionary (~200 entries)
// ═══════════════════════════════════════════════════════════════════

interface AbbrEntry {
  meaning: string;
  trade: AnnotationCategory | "general";
}

let _abbrDict: Map<string, AbbrEntry> | null = null;

function getAbbrDict(): Map<string, AbbrEntry> {
  if (_abbrDict) return _abbrDict;
  _abbrDict = new Map<string, AbbrEntry>([
    // General / Architectural
    ["ABV", { meaning: "Above", trade: "general" }],
    ["ACT", { meaning: "Acoustical Ceiling Tile", trade: "general" }],
    ["ADD", { meaning: "Addendum", trade: "general" }],
    ["ADJ", { meaning: "Adjacent / Adjustable", trade: "general" }],
    ["AFF", { meaning: "Above Finished Floor", trade: "general" }],
    ["AGGR", { meaning: "Aggregate", trade: "general" }],
    ["AHJ", { meaning: "Authority Having Jurisdiction", trade: "codes" }],
    ["ALT", { meaning: "Alternate", trade: "general" }],
    ["ALUM", { meaning: "Aluminum", trade: "general" }],
    ["APPROX", { meaning: "Approximate", trade: "general" }],
    ["ARCH", { meaning: "Architectural", trade: "general" }],
    ["BD", { meaning: "Board", trade: "general" }],
    ["BLDG", { meaning: "Building", trade: "general" }],
    ["BLK", { meaning: "Block", trade: "general" }],
    ["BLKG", { meaning: "Blocking", trade: "general" }],
    ["BM", { meaning: "Beam / Benchmark", trade: "general" }],
    ["BOT", { meaning: "Bottom", trade: "general" }],
    ["BRG", { meaning: "Bearing", trade: "general" }],
    ["BRKT", { meaning: "Bracket", trade: "general" }],
    ["BTW", { meaning: "Between", trade: "general" }],
    ["CAB", { meaning: "Cabinet", trade: "general" }],
    ["CEM", { meaning: "Cement", trade: "general" }],
    ["CL", { meaning: "Centerline", trade: "general" }],
    ["CLG", { meaning: "Ceiling", trade: "general" }],
    ["CLR", { meaning: "Clear / Clearance", trade: "general" }],
    ["CMU", { meaning: "Concrete Masonry Unit", trade: "general" }],
    ["COL", { meaning: "Column", trade: "general" }],
    ["CONC", { meaning: "Concrete", trade: "general" }],
    ["CONN", { meaning: "Connection", trade: "general" }],
    ["CONST", { meaning: "Construction", trade: "general" }],
    ["CONT", { meaning: "Continuous", trade: "general" }],
    ["CPT", { meaning: "Carpet", trade: "general" }],
    ["CRS", { meaning: "Course", trade: "general" }],
    ["CTR", { meaning: "Center", trade: "general" }],
    ["DBL", { meaning: "Double", trade: "general" }],
    ["DEM", { meaning: "Demolition", trade: "general" }],
    ["DET", { meaning: "Detail", trade: "general" }],
    ["DIA", { meaning: "Diameter", trade: "general" }],
    ["DIM", { meaning: "Dimension", trade: "general" }],
    ["DN", { meaning: "Down", trade: "general" }],
    ["DP", { meaning: "Dew Point / Deep", trade: "general" }],
    ["DS", { meaning: "Downspout", trade: "general" }],
    ["DWG", { meaning: "Drawing", trade: "general" }],
    ["EA", { meaning: "Each", trade: "general" }],
    ["EJ", { meaning: "Expansion Joint", trade: "general" }],
    ["EL", { meaning: "Elevation", trade: "general" }],
    ["ELEV", { meaning: "Elevation / Elevator", trade: "general" }],
    ["EMBED", { meaning: "Embedded", trade: "general" }],
    ["EQ", { meaning: "Equal", trade: "general" }],
    ["EQUIP", { meaning: "Equipment", trade: "general" }],
    ["EXIST", { meaning: "Existing", trade: "general" }],
    ["EXP", { meaning: "Expansion / Exposed", trade: "general" }],
    ["EXT", { meaning: "Exterior / Extension", trade: "general" }],
    ["FD", { meaning: "Floor Drain", trade: "general" }],
    ["FDN", { meaning: "Foundation", trade: "general" }],
    ["FF", { meaning: "Finished Floor", trade: "general" }],
    ["FFL", { meaning: "Finished Floor Level", trade: "general" }],
    ["FHC", { meaning: "Fire Hose Cabinet", trade: "general" }],
    ["FIN", { meaning: "Finish", trade: "general" }],
    ["FL", { meaning: "Floor / Floor Level", trade: "general" }],
    ["FLG", { meaning: "Flange / Flooring", trade: "general" }],
    ["FLR", { meaning: "Floor", trade: "general" }],
    ["FOC", { meaning: "Face of Concrete", trade: "general" }],
    ["FOM", { meaning: "Face of Masonry", trade: "general" }],
    ["FOS", { meaning: "Face of Stud", trade: "general" }],
    ["FRP", { meaning: "Fiberglass Reinforced Panel", trade: "general" }],
    ["FTG", { meaning: "Footing", trade: "general" }],
    ["FURR", { meaning: "Furring", trade: "general" }],
    ["GA", { meaning: "Gauge", trade: "general" }],
    ["GALV", { meaning: "Galvanized", trade: "general" }],
    ["GC", { meaning: "General Contractor", trade: "general" }],
    ["GI", { meaning: "Galvanized Iron", trade: "general" }],
    ["GL", { meaning: "Glass / Glazing", trade: "general" }],
    ["GND", { meaning: "Ground", trade: "general" }],
    ["GWB", { meaning: "Gypsum Wall Board", trade: "general" }],
    ["GYP", { meaning: "Gypsum", trade: "general" }],
    ["HC", { meaning: "Hollow Core", trade: "general" }],
    ["HDR", { meaning: "Header", trade: "general" }],
    ["HDW", { meaning: "Hardware", trade: "general" }],
    ["HM", { meaning: "Hollow Metal", trade: "general" }],
    ["HORIZ", { meaning: "Horizontal", trade: "general" }],
    ["HR", { meaning: "Hour", trade: "general" }],
    ["HT", { meaning: "Height", trade: "general" }],
    ["HVAC", { meaning: "Heating Ventilation Air Conditioning", trade: "trade" }],
    ["HWD", { meaning: "Hardwood", trade: "general" }],
    ["ID", { meaning: "Inside Diameter", trade: "general" }],
    ["INSUL", { meaning: "Insulation", trade: "general" }],
    ["INT", { meaning: "Interior", trade: "general" }],
    ["INV", { meaning: "Invert", trade: "general" }],
    ["JNT", { meaning: "Joint", trade: "general" }],
    ["JST", { meaning: "Joist", trade: "general" }],
    ["KIT", { meaning: "Kitchen", trade: "rooms" }],
    ["LAM", { meaning: "Laminate / Laminated", trade: "general" }],
    ["LAV", { meaning: "Lavatory", trade: "general" }],
    ["LF", { meaning: "Linear Feet", trade: "general" }],
    ["LT", { meaning: "Light", trade: "general" }],
    ["LVL", { meaning: "Level / Laminated Veneer Lumber", trade: "general" }],
    ["MAS", { meaning: "Masonry", trade: "general" }],
    ["MAX", { meaning: "Maximum", trade: "general" }],
    ["MBR", { meaning: "Member", trade: "general" }],
    ["MECH", { meaning: "Mechanical", trade: "trade" }],
    ["MEMB", { meaning: "Membrane", trade: "general" }],
    ["MFR", { meaning: "Manufacturer", trade: "general" }],
    ["MIN", { meaning: "Minimum", trade: "general" }],
    ["MISC", { meaning: "Miscellaneous", trade: "general" }],
    ["MO", { meaning: "Masonry Opening", trade: "general" }],
    ["MOD", { meaning: "Module / Modified", trade: "general" }],
    ["MTG", { meaning: "Mounting", trade: "general" }],
    ["MTL", { meaning: "Metal", trade: "general" }],
    ["NIC", { meaning: "Not In Contract", trade: "general" }],
    ["NOM", { meaning: "Nominal", trade: "general" }],
    ["NTS", { meaning: "Not To Scale", trade: "general" }],
    ["OC", { meaning: "On Center", trade: "general" }],
    ["OD", { meaning: "Outside Diameter", trade: "general" }],
    ["OH", { meaning: "Overhead", trade: "general" }],
    ["OPG", { meaning: "Opening", trade: "general" }],
    ["OPP", { meaning: "Opposite", trade: "general" }],
    ["PCC", { meaning: "Precast Concrete", trade: "general" }],
    ["PL", { meaning: "Plate / Property Line", trade: "general" }],
    ["PLAS", { meaning: "Plastic / Plaster", trade: "general" }],
    ["PLF", { meaning: "Pounds Per Linear Foot", trade: "general" }],
    ["PLYWD", { meaning: "Plywood", trade: "general" }],
    ["PMT", { meaning: "Permit", trade: "general" }],
    ["PNL", { meaning: "Panel", trade: "general" }],
    ["PR", { meaning: "Pair", trade: "general" }],
    ["PREFAB", { meaning: "Prefabricated", trade: "general" }],
    ["PSF", { meaning: "Pounds Per Square Foot", trade: "general" }],
    ["PSI", { meaning: "Pounds Per Square Inch", trade: "general" }],
    ["PTD", { meaning: "Painted", trade: "general" }],
    ["QTY", { meaning: "Quantity", trade: "general" }],
    ["RAD", { meaning: "Radius", trade: "general" }],
    ["RCP", { meaning: "Reflected Ceiling Plan", trade: "general" }],
    ["RD", { meaning: "Roof Drain", trade: "general" }],
    ["REINF", { meaning: "Reinforced / Reinforcing", trade: "general" }],
    ["REQ", { meaning: "Required", trade: "general" }],
    ["RETG", { meaning: "Retaining", trade: "general" }],
    ["RFG", { meaning: "Roofing", trade: "general" }],
    ["RGH", { meaning: "Rough", trade: "general" }],
    ["RM", { meaning: "Room", trade: "rooms" }],
    ["RO", { meaning: "Rough Opening", trade: "general" }],
    ["RWD", { meaning: "Redwood", trade: "general" }],
    ["SC", { meaning: "Solid Core", trade: "general" }],
    ["SCHED", { meaning: "Schedule", trade: "general" }],
    ["SECT", { meaning: "Section", trade: "general" }],
    ["SF", { meaning: "Square Feet", trade: "general" }],
    ["SHT", { meaning: "Sheet", trade: "general" }],
    ["SIM", { meaning: "Similar", trade: "general" }],
    ["SLB", { meaning: "Slab", trade: "general" }],
    ["SOG", { meaning: "Slab On Grade", trade: "general" }],
    ["SPEC", { meaning: "Specification", trade: "general" }],
    ["SQ", { meaning: "Square", trade: "general" }],
    ["SS", { meaning: "Stainless Steel", trade: "general" }],
    ["STD", { meaning: "Standard", trade: "general" }],
    ["STL", { meaning: "Steel", trade: "general" }],
    ["STOR", { meaning: "Storage", trade: "rooms" }],
    ["STRUCT", { meaning: "Structural", trade: "general" }],
    ["SUSP", { meaning: "Suspended", trade: "general" }],
    ["SYM", { meaning: "Symmetrical", trade: "general" }],
    ["SYS", { meaning: "System", trade: "general" }],
    ["TB", { meaning: "Top of Beam", trade: "general" }],
    ["TEL", { meaning: "Telephone", trade: "general" }],
    ["TER", { meaning: "Terrazzo", trade: "general" }],
    ["THK", { meaning: "Thick / Thickness", trade: "general" }],
    ["TOC", { meaning: "Top of Concrete", trade: "general" }],
    ["TOF", { meaning: "Top of Footing", trade: "general" }],
    ["TOS", { meaning: "Top of Steel / Top of Slab", trade: "general" }],
    ["TOW", { meaning: "Top of Wall", trade: "general" }],
    ["TPO", { meaning: "Thermoplastic Polyolefin", trade: "general" }],
    ["TS", { meaning: "Top of Steel", trade: "general" }],
    ["TW", { meaning: "Top of Wall", trade: "general" }],
    ["TYP", { meaning: "Typical", trade: "general" }],
    ["UNO", { meaning: "Unless Noted Otherwise", trade: "general" }],
    ["VERT", { meaning: "Vertical", trade: "general" }],
    ["VIF", { meaning: "Verify In Field", trade: "general" }],
    ["VCT", { meaning: "Vinyl Composition Tile", trade: "general" }],
    ["VOL", { meaning: "Volume", trade: "general" }],
    ["WC", { meaning: "Water Closet", trade: "general" }],
    ["WD", { meaning: "Wood", trade: "general" }],
    ["WDW", { meaning: "Window", trade: "general" }],
    ["WI", { meaning: "Wrought Iron", trade: "general" }],
    ["WP", { meaning: "Waterproof / Work Point", trade: "general" }],
    ["WTR", { meaning: "Water", trade: "general" }],
    ["WWF", { meaning: "Welded Wire Fabric", trade: "general" }],
    // Structural
    ["BRG", { meaning: "Bearing", trade: "general" }],
    ["CLJ", { meaning: "Control Joint", trade: "general" }],
    ["DL", { meaning: "Dead Load", trade: "general" }],
    ["EBF", { meaning: "Eccentric Braced Frame", trade: "general" }],
    ["EJ", { meaning: "Expansion Joint", trade: "general" }],
    ["FTG", { meaning: "Footing", trade: "general" }],
    ["LL", { meaning: "Live Load", trade: "general" }],
    ["MOM", { meaning: "Moment", trade: "general" }],
    ["OC", { meaning: "On Center", trade: "general" }],
    ["OMF", { meaning: "Ordinary Moment Frame", trade: "general" }],
    ["SMF", { meaning: "Special Moment Frame", trade: "general" }],
    ["TJI", { meaning: "Truss Joist", trade: "general" }],
    ["WF", { meaning: "Wide Flange", trade: "general" }],
    // Mechanical
    ["AHU", { meaning: "Air Handling Unit", trade: "trade" }],
    ["BLR", { meaning: "Boiler", trade: "trade" }],
    ["CFM", { meaning: "Cubic Feet Per Minute", trade: "trade" }],
    ["CHW", { meaning: "Chilled Water", trade: "trade" }],
    ["CW", { meaning: "Cold Water / Chilled Water", trade: "trade" }],
    ["DX", { meaning: "Direct Expansion", trade: "trade" }],
    ["EF", { meaning: "Exhaust Fan", trade: "trade" }],
    ["ERV", { meaning: "Energy Recovery Ventilator", trade: "trade" }],
    ["FCU", { meaning: "Fan Coil Unit", trade: "trade" }],
    ["FPM", { meaning: "Feet Per Minute", trade: "trade" }],
    ["GPM", { meaning: "Gallons Per Minute", trade: "trade" }],
    ["HHW", { meaning: "Heating Hot Water", trade: "trade" }],
    ["HW", { meaning: "Hot Water", trade: "trade" }],
    ["MAU", { meaning: "Makeup Air Unit", trade: "trade" }],
    ["MBH", { meaning: "Thousand BTU Per Hour", trade: "trade" }],
    ["OA", { meaning: "Outside Air", trade: "trade" }],
    ["RA", { meaning: "Return Air", trade: "trade" }],
    ["RTU", { meaning: "Rooftop Unit", trade: "trade" }],
    ["SA", { meaning: "Supply Air", trade: "trade" }],
    ["SP", { meaning: "Static Pressure", trade: "trade" }],
    ["VAV", { meaning: "Variable Air Volume", trade: "trade" }],
    // Electrical
    ["AF", { meaning: "Ampere Frame", trade: "trade" }],
    ["AT", { meaning: "Ampere Trip", trade: "trade" }],
    ["CB", { meaning: "Circuit Breaker", trade: "trade" }],
    ["EMT", { meaning: "Electrical Metallic Tubing", trade: "trade" }],
    ["GFI", { meaning: "Ground Fault Interrupter", trade: "trade" }],
    ["GFCI", { meaning: "Ground Fault Circuit Interrupter", trade: "trade" }],
    ["HP", { meaning: "Horsepower", trade: "trade" }],
    ["KVA", { meaning: "Kilovolt-Ampere", trade: "trade" }],
    ["KW", { meaning: "Kilowatt", trade: "trade" }],
    ["MCC", { meaning: "Motor Control Center", trade: "trade" }],
    ["MDP", { meaning: "Main Distribution Panel", trade: "trade" }],
    ["XFMR", { meaning: "Transformer", trade: "trade" }],
    // Plumbing
    ["CWS", { meaning: "Cold Water Supply", trade: "trade" }],
    ["HWR", { meaning: "Hot Water Return", trade: "trade" }],
    ["HWS", { meaning: "Hot Water Supply", trade: "trade" }],
    ["PRV", { meaning: "Pressure Reducing Valve", trade: "trade" }],
    ["RD", { meaning: "Roof Drain", trade: "trade" }],
    ["SD", { meaning: "Storm Drain", trade: "trade" }],
    ["WH", { meaning: "Water Heater", trade: "trade" }],
  ]);
  return _abbrDict;
}

// ═══════════════════════════════════════════════════════════════════
// Detector
// ═══════════════════════════════════════════════════════════════════

function detect(ctx: DetectorContext): TextAnnotation[] {
  const { words } = ctx;
  const results: TextAnnotation[] = [];
  const dict = getAbbrDict();
  const wordCounts = new Map<string, number>();

  // First pass: count uppercase word frequencies for heuristic (3+ chars only)
  for (const w of words) {
    const txt = w.text;
    if (/^[A-Z]{3,5}$/.test(txt) && !ABBR_STOP_WORDS.has(txt)) {
      wordCounts.set(txt, (wordCounts.get(txt) ?? 0) + 1);
    }
  }

  for (let i = 0; i < words.length; i++) {
    const txt = words[i].text;
    const upper = txt.toUpperCase();
    // Strip trailing periods for dict lookup
    const stripped = upper.replace(/\.+$/, "");

    // Dictionary match
    const entry = dict.get(stripped) || dict.get(upper);
    if (entry) {
      const cat: AnnotationCategory = entry.trade === "general" ? "abbreviation"
        : entry.trade === "codes" ? "codes"
        : entry.trade === "rooms" ? "rooms"
        : entry.trade === "trade" ? "trade"
        : "abbreviation";
      results.push(makeAnnotation("abbreviation", "abbreviation",
        [words[i]], [i], words[i].confidence * 0.85,
        { note: entry.meaning, meta: { trade: entry.trade } }));
      continue;
    }

    // Heuristic: ALL-CAPS 3-5 char words appearing 5+ times (tightened to reduce false positives)
    if (/^[A-Z]{3,5}$/.test(txt) && !ABBR_STOP_WORDS.has(txt)) {
      const count = wordCounts.get(txt) ?? 0;
      if (count >= 5) {
        results.push(makeAnnotation("abbreviation", "abbreviation",
          [words[i]], [i], words[i].confidence * 0.5,
          { note: `Unknown abbreviation (appears ${count}x)`, meta: { frequency: count } }));
      }
    }
  }

  return results;
}

export const abbreviationsDetector: TextDetector = {
  meta: {
    id: "abbreviations",
    name: "AEC Abbreviations",
    category: "heuristic",
    description: "Detects AEC abbreviations via dictionary lookup and frequency-based heuristics.",
    defaultEnabled: true,
    produces: ["abbreviation"],
  },
  detect,
};
