/**
 * text-annotations.ts
 *
 * Detects ~30 types of blueprint text annotations from Textract OCR output.
 * All regexes compiled at module scope for performance (<50ms/page target).
 */

import type {
  AnnotationCategory,
  TextAnnotationType,
  TextAnnotation,
  TextAnnotationGroup,
  TextAnnotationResult,
  TextractWord,
  TextractLine,
  TextractPageData,
  CsiCode,
} from "@/types";
import {
  isSameLine,
  isAdjacent,
  mergeBbox,
  slidingWindow,
  makeAnnotation,
  avgConf,
  findWordIndex,
} from "@/lib/ocr-utils";

// ═══════════════════════════════════════════════════════════════════
// Module-scope compiled regexes
// ═══════════════════════════════════════════════════════════════════

// Cat 1: Contact
const RE_PHONE = /^\(?\d{3}\)?[-.\s]?\d{3}[-.]?\d{4}$/;
const RE_PHONE_MULTI_START = /^\(?\d{3}\)?[-.]?$/;
const RE_PHONE_MULTI_END = /^\d{3}[-.]?\d{4}$/;
const RE_FAX_PREFIX = /^(?:FAX|F:)$/i;
const RE_EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const RE_EMAIL_USER = /^[A-Za-z0-9._%+-]+$/;
const RE_EMAIL_AT = /^@$/;
const RE_EMAIL_DOMAIN = /^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const RE_URL = /^(?:https?:\/\/|www\.)\S+$/i;
const RE_STREET_NUMBER = /^\d{1,6}$/;
const STREET_SUFFIXES = new Set([
  "ST", "ST.", "STREET", "AVE", "AVE.", "AVENUE", "BLVD", "BLVD.", "BOULEVARD",
  "DR", "DR.", "DRIVE", "RD", "RD.", "ROAD", "LN", "LN.", "LANE", "CT", "CT.",
  "COURT", "WAY", "PKWY", "PKWY.", "PARKWAY", "HWY", "HWY.", "HIGHWAY",
  "PL", "PL.", "PLACE", "CIR", "CIR.", "CIRCLE",
]);
const RE_ZIP = /^\d{5}(?:-\d{4})?$/;
const RE_STATE_ABBR = /^[A-Z]{2}$/;

// Cat 2: Construction Codes
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

// Cat 3: Dimensions
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

// Cat 4: Equipment Tags
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

// Cat 5: References
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

// Cat 6: Trade Callouts
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

// Cat 8: Notes
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

// Cat 9: Rooms
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

// Cat 7: Abbreviations (stop words for heuristic detector)
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

// Utility functions (isSameLine, isAdjacent, mergeBbox, slidingWindow,
// makeAnnotation, avgConf, findWordIndex) are imported from ocr-utils.ts

// ═══════════════════════════════════════════════════════════════════
// Detector functions
// ═══════════════════════════════════════════════════════════════════

function detectContact(words: TextractWord[]): TextAnnotation[] {
  const results: TextAnnotation[] = [];

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const txt = w.text;

    // Single-word phone
    if (RE_PHONE.test(txt.replace(/\s/g, ""))) {
      // Check if preceded by FAX
      const isFax = i > 0 && RE_FAX_PREFIX.test(words[i - 1].text);
      if (isFax) {
        results.push(makeAnnotation("fax", "contact",
          [words[i - 1], w], [i - 1, i], avgConf([words[i - 1], w])));
      } else {
        results.push(makeAnnotation("phone", "contact", [w], [i], w.confidence));
      }
      continue;
    }

    // Multi-word phone: area code + rest
    if (RE_PHONE_MULTI_START.test(txt) && i + 1 < words.length) {
      const next = words[i + 1];
      if (isAdjacent(w, next) && RE_PHONE_MULTI_END.test(next.text)) {
        const isFax = i > 0 && RE_FAX_PREFIX.test(words[i - 1].text);
        if (isFax) {
          results.push(makeAnnotation("fax", "contact",
            [words[i - 1], w, next], [i - 1, i, i + 1],
            avgConf([words[i - 1], w, next])));
        } else {
          results.push(makeAnnotation("phone", "contact",
            [w, next], [i, i + 1], avgConf([w, next])));
        }
        i += 1;
        continue;
      }
    }

    // Email: single word
    if (RE_EMAIL.test(txt)) {
      results.push(makeAnnotation("email", "contact", [w], [i], w.confidence));
      continue;
    }

    // Email: split at @
    if (RE_EMAIL_USER.test(txt) && i + 2 < words.length) {
      const atWord = words[i + 1];
      const domainWord = words[i + 2];
      if (RE_EMAIL_AT.test(atWord.text) && RE_EMAIL_DOMAIN.test(domainWord.text)
          && isAdjacent(w, atWord) && isAdjacent(atWord, domainWord)) {
        results.push(makeAnnotation("email", "contact",
          [w, atWord, domainWord], [i, i + 1, i + 2],
          avgConf([w, atWord, domainWord])));
        i += 2;
        continue;
      }
    }

    // URL
    if (RE_URL.test(txt)) {
      results.push(makeAnnotation("url", "contact", [w], [i], w.confidence));
      continue;
    }

    // Zip code: 5 digits or 5+4, preceded by a 2-letter state abbreviation
    if (RE_ZIP.test(txt)) {
      const prevIsState = i > 0 && /^[A-Z]{2}\.?$/.test(words[i - 1].text);
      if (prevIsState) {
        results.push(makeAnnotation("zip-code", "contact",
          [words[i - 1], w], [i - 1, i], avgConf([words[i - 1], w])));
      } else {
        // Standalone zip (lower confidence — could be a room number)
        results.push(makeAnnotation("zip-code", "contact", [w], [i], w.confidence * 0.6));
      }
      continue;
    }

    // Address: number + street name + suffix
    if (RE_STREET_NUMBER.test(txt) && i + 2 < words.length) {
      // Look ahead for street suffix within next 5 words
      for (let j = i + 1; j < Math.min(i + 6, words.length); j++) {
        if (!isAdjacent(words[j - 1], words[j])) break;
        const upper = words[j].text.toUpperCase();
        if (STREET_SUFFIXES.has(upper)) {
          const addrWords: TextractWord[] = [];
          const addrIndices: number[] = [];
          for (let k = i; k <= j; k++) {
            addrWords.push(words[k]);
            addrIndices.push(k);
          }
          // Extend to capture city, state, zip
          let end = j;
          for (let k = j + 1; k < Math.min(j + 6, words.length); k++) {
            if (!isAdjacent(words[k - 1], words[k])) break;
            addrWords.push(words[k]);
            addrIndices.push(k);
            end = k;
            if (RE_ZIP.test(words[k].text)) break;
          }
          results.push(makeAnnotation("address", "contact",
            addrWords, addrIndices, avgConf(addrWords)));
          i = end;
          break;
        }
      }
    }
  }

  return results;
}

function detectCodes(words: TextractWord[]): TextAnnotation[] {
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

function detectDimensions(words: TextractWord[]): TextAnnotation[] {
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

function detectEquipment(words: TextractWord[]): TextAnnotation[] {
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

function detectReferences(words: TextractWord[]): TextAnnotation[] {
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

function detectTrade(words: TextractWord[]): TextAnnotation[] {
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

function detectAbbreviations(words: TextractWord[]): TextAnnotation[] {
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

function detectNotes(words: TextractWord[], lines: TextractLine[]): TextAnnotation[] {
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

// findWordIndex is imported from ocr-utils.ts

function detectRooms(words: TextractWord[]): TextAnnotation[] {
  const results: TextAnnotation[] = [];

  for (let i = 0; i < words.length; i++) {
    const txt = words[i].text;
    const upper = txt.toUpperCase();
    const yCenter = words[i].bbox[1] + words[i].bbox[3] / 2;

    // Room numbers: 3-4 digit numbers NOT in title block region (bottom 15%)
    if (RE_ROOM_NUMBER.test(upper) && yCenter < 0.85) {
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

// ═══════════════════════════════════════════════════════════════════
// Dedup & Grouping
// ═══════════════════════════════════════════════════════════════════

/** Priority order for dedup — higher-priority types win when word indices overlap. */
const TYPE_PRIORITY: Record<TextAnnotationType, number> = {
  // Contact: high
  "phone": 90, "fax": 91, "email": 92, "url": 90, "zip-code": 80, "address": 88, "csi-code": 75,
  // Codes
  "spec-section": 85, "building-code": 85, "code-compliance": 84,
  // Dimensions
  "imperial-dim": 80, "metric-dim": 80, "scale": 82, "slope": 81,
  // Equipment
  "equipment-tag": 75, "door-window-tag": 76, "finish-code": 74,
  "panel-circuit": 73, "material-code": 40,
  // References
  "sheet-number": 85, "sheet-ref": 70, "detail-ref": 70, "revision": 68, "action-marker": 65,
  // Trade
  "structural": 60, "mechanical": 60, "electrical": 60, "plumbing": 60, "fire-protection": 60,
  // Notes
  "general-note": 50, "typical-marker": 55, "coordination-note": 52,
  // Rooms
  "room-number": 45, "room-name": 48, "area-designation": 47,
  // Abbreviations: lowest — they coexist
  "abbreviation": 10,
};

function dedup(annotations: TextAnnotation[]): TextAnnotation[] {
  // Sort by priority descending
  const sorted = [...annotations].sort(
    (a, b) => (TYPE_PRIORITY[b.type] ?? 0) - (TYPE_PRIORITY[a.type] ?? 0)
  );

  const consumedIndices = new Set<number>();
  const kept: TextAnnotation[] = [];

  for (const ann of sorted) {
    // Abbreviations always coexist — don't consume and don't get blocked
    if (ann.type === "abbreviation") {
      kept.push(ann);
      continue;
    }

    // Check if any of this annotation's word indices are already consumed
    const overlaps = ann.wordIndices.some(idx => consumedIndices.has(idx));
    if (overlaps) continue;

    kept.push(ann);
    for (const idx of ann.wordIndices) {
      consumedIndices.add(idx);
    }
  }

  return kept;
}

/** Remove duplicate annotations with same type and overlapping word indices. */
function dedupSameType(annotations: TextAnnotation[]): TextAnnotation[] {
  const seen = new Map<string, Set<number>>();
  const kept: TextAnnotation[] = [];

  for (const ann of annotations) {
    const key = `${ann.type}`;
    if (!seen.has(key)) seen.set(key, new Set());
    const usedIndices = seen.get(key)!;

    // Check if all indices already seen for this type
    const allSeen = ann.wordIndices.length > 0
      && ann.wordIndices.every(idx => usedIndices.has(idx));
    if (allSeen) continue;

    kept.push(ann);
    for (const idx of ann.wordIndices) {
      usedIndices.add(idx);
    }
  }
  return kept;
}

/** Auto-group: group equipment/material/finish/door-window by letter prefix.
 *  Only include groups with 2+ members. */
function autoGroup(annotations: TextAnnotation[]): TextAnnotationGroup[] {
  const groupable = annotations.filter(a =>
    a.group && (a.type === "equipment-tag" || a.type === "material-code"
      || a.type === "finish-code" || a.type === "door-window-tag"
      || a.type === "sheet-number")
  );

  const buckets = new Map<string, TextAnnotation[]>();
  for (const ann of groupable) {
    const key = `${ann.type}:${ann.group}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(ann);
  }

  const groups: TextAnnotationGroup[] = [];
  for (const [key, items] of buckets) {
    if (items.length < 2) continue;
    const prefix = items[0].group!;
    const typeLabel = items[0].type === "equipment-tag" ? "Equipment"
      : items[0].type === "door-window-tag" ? (prefix === "D" ? "Doors" : "Windows")
      : items[0].type === "finish-code" ? "Finish"
      : items[0].type === "sheet-number" ? (DISCIPLINE_PREFIXES[prefix] || "Sheets")
      : "Material";
    groups.push({
      prefix,
      count: items.length,
      items,
      label: `${typeLabel} ${prefix} (${items.length} items)`,
    });
  }

  // Sort by count descending
  groups.sort((a, b) => b.count - a.count);
  return groups;
}

/** Detect CSI codes as text annotations — matches CSI description words to Textract bboxes. */
function detectCsiAnnotations(words: TextractWord[], csiCodes: CsiCode[]): TextAnnotation[] {
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

/** Build summary: count by category. */
function buildSummary(annotations: TextAnnotation[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const ann of annotations) {
    summary[ann.category] = (summary[ann.category] ?? 0) + 1;
    summary[ann.type] = (summary[ann.type] ?? 0) + 1;
  }
  summary["total"] = annotations.length;
  return summary;
}

// ═══════════════════════════════════════════════════════════════════
// Main export
// ═══════════════════════════════════════════════════════════════════

export function detectTextAnnotations(data: TextractPageData, csiCodes?: CsiCode[]): TextAnnotationResult {
  const { words, lines } = data;

  if (!words || words.length === 0) {
    return { annotations: [], groups: [], summary: { total: 0 } };
  }

  // Run all detectors
  const raw: TextAnnotation[] = [
    ...detectContact(words),
    ...detectCodes(words),
    ...detectCsiAnnotations(words, csiCodes || []),
    ...detectDimensions(words),
    ...detectEquipment(words),
    ...detectReferences(words),
    ...detectTrade(words),
    ...detectAbbreviations(words),
    ...detectNotes(words, lines),
    ...detectRooms(words),
  ];

  // Dedup: first remove same-type duplicates, then cross-type dedup
  const noDupSameType = dedupSameType(raw);
  const annotations = dedup(noDupSameType);

  // Auto-group
  const groups = autoGroup(annotations);

  // Summary
  const summary = buildSummary(annotations);

  return { annotations, groups, summary };
}
