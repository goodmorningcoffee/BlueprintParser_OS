// [evidence T4 2026-10-24] Types for the per-page evidence layer (src/lib/evidence/).
// Kept out of src/types/index.ts (zero MAX_LINES headroom); consumers import from "@/lib/evidence".
// All geometry is MinMax page fractions [minX, minY, maxX, maxY] — Textract LTWH is converted once.

import type { BboxMinMax, TextractPageData } from "@/types";
import type { PageZones, ZoneKind } from "@/lib/page-zones";

/** Bump when the summary shape or the fusion rule changes; consumers ignore other versions. */
export const EVIDENCE_VERSION = 1;

/** One YOLO annotation row as the yolo/reprocess loops already hold it. */
export interface EvidenceDetectionInput {
  name: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  confidence?: number;
  modelName?: string;
}

export interface PageEvidenceInput {
  textract: TextractPageData | null | undefined;
  detections?: readonly EvidenceDetectionInput[] | null;
  /** Persisted/known zones; omitted → computed from `detections` (fixed-zone fallback without YOLO). */
  zones?: PageZones;
}

/** "ocr" = Textract only; "both" = a yolo_text box holds the word's centre. OCR is always kept. */
export type TextSource = "ocr" | "both";

export interface TextEvidenceItem {
  text: string;
  bbox: BboxMinMax;
  /** Textract confidence normalised to 0-1. */
  cOcr: number;
  /** Highest confidence of a yolo_text box holding the word centre; null when none does. */
  cYolo: number | null;
  source: TextSource;
  /** Calibrated P(real text here) — research/text/REPORT.md §7.2. */
  pText: number;
  zone: ZoneKind;
}

/** A yolo_text box with no OCR word centre inside that is not a fragment of a read word. */
export interface TextHole {
  bbox: BboxMinMax;
  cYolo: number;
  pText: number;
  zone: ZoneKind;
}

export interface EvidenceDetection {
  name: string;
  bbox: BboxMinMax;
  confidence: number;
  zone: ZoneKind;
}

export interface ModelDetections {
  /** `data.modelName`, or "unknown" for legacy rows without one. */
  modelName: string;
  detections: EvidenceDetection[];
}

export interface EvidenceTableCell {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  text: string;
  bbox: BboxMinMax;
  confidence: number;
}

export interface EvidenceTable {
  bbox: BboxMinMax;
  rows: number;
  cols: number;
  cells: EvidenceTableCell[];
  zone: ZoneKind;
}

export interface TextEvidenceCounts {
  ocrWords: number;
  /** OCR words a yolo_text box also located. */
  both: number;
  ocrOnly: number;
  yoloTextBoxes: number;
  holes: number;
  /** yolo_text boxes with no word centre that sit on a read word's line (merged, not holes). */
  fragments: number;
}

/** The full, in-memory evidence for one page. NOT persisted — see EvidenceSummary. */
export interface PageEvidence {
  version: typeof EVIDENCE_VERSION;
  zones: PageZones;
  text: TextEvidenceItem[];
  holes: TextHole[];
  detections: ModelDetections[];
  tables: EvidenceTable[];
  counts: TextEvidenceCounts;
}

/** Compact projection persisted as `pageIntelligence.evidence`. */
export interface EvidenceSummary {
  v: typeof EVIDENCE_VERSION;
  computedAt: string;
  zonesSource: PageZones["source"];
  /** Which channels had data on this page (a channel with no rows reads false). */
  channels: { ocr: boolean; yoloText: boolean; layout: boolean };
  counts: TextEvidenceCounts & {
    tables: number;
    /** modelName → class → count. */
    detections: Record<string, Record<string, number>>;
  };
  holesByZone: Partial<Record<ZoneKind, number>>;
  /** Highest-confidence holes first, capped at EVIDENCE_HOLE_CAP; `holesTruncated` counts the rest. */
  holes: Array<{ bbox: BboxMinMax; conf: number; zone: ZoneKind }>;
  holesTruncated: number;
  tables: Array<{ bbox: BboxMinMax; rows: number; cols: number; cells: number; zone: ZoneKind }>;
}
