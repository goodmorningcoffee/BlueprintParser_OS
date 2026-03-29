/**
 * csi-spatial.ts
 *
 * CSI Spatial Heatmap: grid-bins CSI-tagged elements by location on a
 * blueprint page.  Produces a CsiSpatialMap that tells downstream
 * consumers (LLM context builder, admin UI) where each CSI division
 * clusters on the page.
 *
 * Grid layout (normalized 0-1 coordinates):
 *   - 3x3 drawing grid (rows: top/mid/bottom, cols: left/center/right)
 *   - Special zone: title-block (y > 0.85)
 *   - Special zone: right-margin (x > 0.75, y < 0.85)
 *
 * Pure function — no DB access, no side effects.
 */

import type {
  TextAnnotation,
  ClassifiedTable,
  BboxLTWH,
} from "@/types";

// ═══════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════

export interface CsiSpatialZone {
  zone: string;
  divisions: { division: string; name: string; count: number; codes: string[] }[];
  totalInstances: number;
  dominantDivision?: string;
}

export interface CsiSpatialMap {
  pageNumber: number;
  zones: CsiSpatialZone[];
  summary: string;
}

// ═══════════════════════════════════════════════════════════════════
// YOLO detection input shape (subset of annotation data fields)
// ═══════════════════════════════════════════════════════════════════

export interface YoloDetectionInput {
  name: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  confidence: number;
  data?: {
    csiCodes?: string[];
    [key: string]: unknown;
  };
}

// ═══════════════════════════════════════════════════════════════════
// Division name map
// ═══════════════════════════════════════════════════════════════════

const DIVISION_NAMES: Record<string, string> = {
  "00": "Procurement",
  "01": "General Requirements",
  "02": "Existing Conditions",
  "03": "Concrete",
  "04": "Masonry",
  "05": "Metals",
  "06": "Wood/Plastics",
  "07": "Thermal & Moisture",
  "08": "Openings",
  "09": "Finishes",
  "10": "Specialties",
  "11": "Equipment",
  "12": "Furnishings",
  "21": "Fire Suppression",
  "22": "Plumbing",
  "23": "HVAC",
  "26": "Electrical",
  "27": "Communications",
  "28": "Electronic Safety",
};

// ═══════════════════════════════════════════════════════════════════
// Zone classification
// ═══════════════════════════════════════════════════════════════════

/** Row/column thresholds for the 3x3 drawing grid. */
const COL_THRESHOLDS = [0, 1 / 3, 2 / 3, 1] as const;
const ROW_THRESHOLDS = [0, 1 / 3, 2 / 3, 1] as const;
const ROW_LABELS = ["top", "mid", "bottom"] as const;
const COL_LABELS = ["left", "center", "right"] as const;

/**
 * Human-readable labels used in the summary string.
 * Mirrors the zone names but with friendlier phrasing.
 */
const ZONE_DISPLAY: Record<string, string> = {
  "top-left": "top-left drawing area",
  "top-center": "top-center drawing area",
  "top-right": "top-right drawing area",
  "mid-left": "mid-left drawing area",
  "mid-center": "center drawing area",
  "mid-right": "mid-right drawing area",
  "bottom-left": "bottom-left drawing area",
  "bottom-center": "bottom-center drawing area",
  "bottom-right": "bottom-right drawing area",
  "title-block": "title block",
  "right-margin": "right margin",
};

/**
 * Map a bbox center (normalized 0-1) to a zone name.
 * Special zones take precedence over the 3x3 grid.
 */
function classifyZone(cx: number, cy: number): string {
  // Special zone: title-block (bottom strip)
  if (cy > 0.85) return "title-block";

  // Special zone: right-margin (right strip above title-block)
  if (cx > 0.75) return "right-margin";

  // 3x3 drawing grid
  const col = cx < COL_THRESHOLDS[1] ? 0 : cx < COL_THRESHOLDS[2] ? 1 : 2;
  const row = cy < ROW_THRESHOLDS[1] ? 0 : cy < ROW_THRESHOLDS[2] ? 1 : 2;
  return `${ROW_LABELS[row]}-${COL_LABELS[col]}`;
}

/**
 * Compute the center of a [left, top, width, height] bbox.
 */
function bboxCenter(bbox: BboxLTWH): { cx: number; cy: number } {
  return { cx: bbox[0] + bbox[2] / 2, cy: bbox[1] + bbox[3] / 2 };
}

/**
 * Compute the center of a [minX, minY, maxX, maxY] bbox.
 */
function minMaxCenter(minX: number, minY: number, maxX: number, maxY: number): { cx: number; cy: number } {
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

// ═══════════════════════════════════════════════════════════════════
// Internal accumulator
// ═══════════════════════════════════════════════════════════════════

/** Mutable accumulator used while binning elements. */
interface ZoneAccumulator {
  /** zone name -> division code -> set of full CSI codes */
  bins: Map<string, Map<string, Set<string>>>;
}

function createAccumulator(): ZoneAccumulator {
  return { bins: new Map() };
}

function addCode(acc: ZoneAccumulator, zone: string, code: string): void {
  const div = code.substring(0, 2);
  if (!DIVISION_NAMES[div]) return; // skip unrecognised divisions

  if (!acc.bins.has(zone)) acc.bins.set(zone, new Map());
  const zoneMap = acc.bins.get(zone)!;

  if (!zoneMap.has(div)) zoneMap.set(div, new Set());
  zoneMap.get(div)!.add(code);
}

// ═══════════════════════════════════════════════════════════════════
// Element collectors
// ═══════════════════════════════════════════════════════════════════

function collectFromAnnotations(acc: ZoneAccumulator, annotations: TextAnnotation[]): void {
  for (const ann of annotations) {
    if (!ann.csiTags || ann.csiTags.length === 0) continue;
    const { cx, cy } = bboxCenter(ann.bbox as BboxLTWH);
    const zone = classifyZone(cx, cy);
    for (const tag of ann.csiTags) {
      addCode(acc, zone, tag.code);
    }
  }
}

function collectFromYoloDetections(acc: ZoneAccumulator, detections: YoloDetectionInput[]): void {
  for (const det of detections) {
    const codes = det.data?.csiCodes;
    if (!codes || codes.length === 0) continue;
    const { cx, cy } = minMaxCenter(det.minX, det.minY, det.maxX, det.maxY);
    const zone = classifyZone(cx, cy);
    for (const code of codes) {
      addCode(acc, zone, code);
    }
  }
}

function collectFromTables(acc: ZoneAccumulator, tables: ClassifiedTable[]): void {
  for (const table of tables) {
    if (!table.csiTags || table.csiTags.length === 0) continue;
    const { cx, cy } = bboxCenter(table.bbox as BboxLTWH);
    const zone = classifyZone(cx, cy);
    for (const tag of table.csiTags) {
      addCode(acc, zone, tag.code);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// Summary generation
// ═══════════════════════════════════════════════════════════════════

/** Descriptive label for a division — used in the summary sentence. */
function divisionLabel(div: string): string {
  const name = DIVISION_NAMES[div];
  if (!name) return `Div ${div}`;

  // Build a natural-language fragment like "Door-related content (Div 08)"
  const FRIENDLY: Record<string, string> = {
    "03": "Concrete-related content",
    "04": "Masonry-related content",
    "05": "Metals-related content",
    "06": "Wood/Plastics-related content",
    "07": "Waterproofing/insulation content",
    "08": "Door-related content",
    "09": "Finish-related content",
    "10": "Specialties content",
    "11": "Equipment-related content",
    "12": "Furnishings content",
    "21": "Fire-suppression content",
    "22": "Plumbing-related content",
    "23": "HVAC-related content",
    "26": "Electrical content",
    "27": "Communications content",
    "28": "Electronic-safety content",
  };

  return `${FRIENDLY[div] || `${name} content`} (Div ${div})`;
}

function buildSummary(zones: CsiSpatialZone[]): string {
  if (zones.length === 0) return "";

  const parts: string[] = [];

  for (const zone of zones) {
    if (!zone.dominantDivision) continue;
    const label = divisionLabel(zone.dominantDivision);
    const display = ZONE_DISPLAY[zone.zone] || zone.zone;
    parts.push(`${label} clusters in ${display}`);
  }

  if (parts.length === 0) return "CSI codes distributed across page with no clear clustering";

  return parts.join("; ");
}

// ═══════════════════════════════════════════════════════════════════
// Main export
// ═══════════════════════════════════════════════════════════════════

/**
 * Compute a CSI spatial heatmap for one blueprint page.
 *
 * Grid-bins every CSI-tagged element (text annotations, YOLO detections,
 * classified tables) into zones, groups codes by division within each
 * zone, and produces a human-readable summary.
 *
 * Returns null when no CSI-tagged elements are found.
 */
export function computeCsiSpatialMap(
  pageNumber: number,
  textAnnotations: TextAnnotation[],
  yoloDetections?: YoloDetectionInput[],
  classifiedTables?: ClassifiedTable[],
): CsiSpatialMap | null {
  const acc = createAccumulator();

  // Collect from all three sources
  collectFromAnnotations(acc, textAnnotations);
  if (yoloDetections) collectFromYoloDetections(acc, yoloDetections);
  if (classifiedTables) collectFromTables(acc, classifiedTables);

  // Nothing found?
  if (acc.bins.size === 0) return null;

  // Convert accumulator to CsiSpatialZone[]
  const zones: CsiSpatialZone[] = [];

  for (const [zoneName, divMap] of acc.bins) {
    const divisions: CsiSpatialZone["divisions"][number][] = [];
    let totalInstances = 0;
    let maxCount = 0;
    let dominant: string | undefined;

    for (const [div, codesSet] of divMap) {
      const codes = Array.from(codesSet).sort();
      const count = codes.length;
      totalInstances += count;

      divisions.push({
        division: div,
        name: DIVISION_NAMES[div] || `Division ${div}`,
        count,
        codes,
      });

      if (count > maxCount) {
        maxCount = count;
        dominant = div;
      }
    }

    // Sort divisions by count descending, then by division code
    divisions.sort((a, b) => b.count - a.count || a.division.localeCompare(b.division));

    zones.push({
      zone: zoneName,
      divisions,
      totalInstances,
      dominantDivision: dominant,
    });
  }

  // Sort zones by totalInstances descending for readability
  zones.sort((a, b) => b.totalInstances - a.totalInstances);

  return {
    pageNumber,
    zones,
    summary: buildSummary(zones),
  };
}
