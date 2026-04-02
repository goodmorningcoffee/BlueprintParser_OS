/**
 * csi-spatial.ts
 *
 * CSI Spatial Heatmap: grid-bins CSI-tagged elements by location on a
 * blueprint page.  Produces a CsiSpatialMap that tells downstream
 * consumers (LLM context builder, admin UI) where each CSI division
 * clusters on the page.
 *
 * Grid layout (normalized 0-1 coordinates):
 *   - 9x9 drawing grid (default, configurable via CsiSpatialGridConfig)
 *   - Special zone: title-block (y > 0.85)
 *   - Special zone: right-margin (x > 0.75, y < 0.85)
 *
 * Pure function — no DB access, no side effects.
 */

import type {
  TextAnnotation,
  ClassifiedTable,
  BboxLTWH,
  ParsedRegion,
  YoloTag,
  ClientAnnotation,
} from "@/types";
import { TITLE_BLOCK_Y_THRESHOLD, RIGHT_MARGIN_X_THRESHOLD } from "@/lib/spatial-constants";

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

/** Row/column labels for the classic 3x3 grid (backwards compat). */
const ROW_LABELS = ["top", "mid", "bottom"] as const;
const COL_LABELS = ["left", "center", "right"] as const;

/** Grid config for spatial resolution. */
export interface CsiSpatialGridConfig {
  rows: number;
  cols: number;
}

export const DEFAULT_GRID: CsiSpatialGridConfig = { rows: 9, cols: 9 };

/**
 * Human-readable labels used in the summary string.
 * For 3x3 grids, uses friendly names. For higher resolution, generates "row R, col C" labels.
 */
const ZONE_DISPLAY_3X3: Record<string, string> = {
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

function zoneDisplayName(zone: string): string {
  return ZONE_DISPLAY_3X3[zone] || zone.replace(/^r(\d+)-c(\d+)$/, "row $1, col $2");
}

/**
 * Map a bbox center (normalized 0-1) to a zone name.
 * Special zones take precedence over the NxN grid.
 */
export function classifyZone(cx: number, cy: number, nRows: number, nCols: number): string {
  // Special zone: title-block (bottom strip)
  if (cy > TITLE_BLOCK_Y_THRESHOLD) return "title-block";

  // Special zone: right-margin (right strip above title-block)
  if (cx > RIGHT_MARGIN_X_THRESHOLD) return "right-margin";

  const col = Math.min(Math.floor(cx * nCols), nCols - 1);
  const row = Math.min(Math.floor(cy * nRows), nRows - 1);

  // Classic 3x3: use human-readable names for backwards compat
  if (nRows === 3 && nCols === 3) {
    return `${ROW_LABELS[row]}-${COL_LABELS[col]}`;
  }

  // Higher resolution: coordinate-based names
  return `r${row + 1}-c${col + 1}`;
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
  nRows: number;
  nCols: number;
}

function createAccumulator(grid: CsiSpatialGridConfig): ZoneAccumulator {
  return { bins: new Map(), nRows: grid.rows, nCols: grid.cols };
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
    const zone = classifyZone(cx, cy, acc.nRows, acc.nCols);
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
    const zone = classifyZone(cx, cy, acc.nRows, acc.nCols);
    for (const code of codes) {
      addCode(acc, zone, code);
    }
  }
}

function collectFromTables(acc: ZoneAccumulator, tables: ClassifiedTable[]): void {
  for (const table of tables) {
    if (!table.csiTags || table.csiTags.length === 0) continue;
    const { cx, cy } = bboxCenter(table.bbox as BboxLTWH);
    const zone = classifyZone(cx, cy, acc.nRows, acc.nCols);
    for (const tag of table.csiTags) {
      addCode(acc, zone, tag.code);
    }
  }
}

function collectFromParsedRegions(acc: ZoneAccumulator, regions: ParsedRegion[]): void {
  for (const region of regions) {
    if (!region.csiTags || region.csiTags.length === 0) continue;
    // parsedRegion.bbox is stored as MinMax [minX, minY, maxX, maxY] by saveParsedToIntelligence
    const bbox = region.bbox;
    const cx = (bbox[0] + bbox[2]) / 2;
    const cy = (bbox[1] + bbox[3]) / 2;
    const zone = classifyZone(cx, cy, acc.nRows, acc.nCols);
    for (const tag of region.csiTags) {
      addCode(acc, zone, tag.code);
    }
  }
}

function collectFromYoloTags(acc: ZoneAccumulator, tags: YoloTag[], pageNumber: number): void {
  for (const tag of tags) {
    if (!tag.csiCodes || tag.csiCodes.length === 0) continue;
    for (const inst of tag.instances) {
      if (inst.pageNumber !== pageNumber) continue;
      const { cx, cy } = minMaxCenter(inst.bbox[0], inst.bbox[1], inst.bbox[2], inst.bbox[3]);
      const zone = classifyZone(cx, cy, acc.nRows, acc.nCols);
      for (const code of tag.csiCodes) {
        addCode(acc, zone, code);
      }
    }
  }
}

function collectFromDbAnnotations(acc: ZoneAccumulator, annotations: ClientAnnotation[]): void {
  for (const ann of annotations) {
    const codes = (ann as any).data?.csiCodes as string[] | undefined;
    if (!codes || codes.length === 0) continue;
    const { cx, cy } = minMaxCenter(ann.bbox[0], ann.bbox[1], ann.bbox[2], ann.bbox[3]);
    const zone = classifyZone(cx, cy, acc.nRows, acc.nCols);
    for (const code of codes) {
      addCode(acc, zone, code);
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
    const display = zoneDisplayName(zone.zone);
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
  parsedRegions?: ParsedRegion[],
  yoloTags?: YoloTag[],
  dbAnnotations?: ClientAnnotation[],
  gridConfig?: CsiSpatialGridConfig,
): CsiSpatialMap | null {
  const acc = createAccumulator(gridConfig || DEFAULT_GRID);

  // Collect from all sources
  collectFromAnnotations(acc, textAnnotations);
  if (yoloDetections) collectFromYoloDetections(acc, yoloDetections);
  if (classifiedTables) collectFromTables(acc, classifiedTables);
  if (parsedRegions) collectFromParsedRegions(acc, parsedRegions);
  if (yoloTags) collectFromYoloTags(acc, yoloTags, pageNumber);
  if (dbAnnotations) collectFromDbAnnotations(acc, dbAnnotations);

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
