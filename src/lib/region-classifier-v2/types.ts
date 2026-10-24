/**
 * region-classifier-v2/types.ts — input and output contracts of the detector-first region
 * classifier (shadow mode, 2026-10-24). See ./classify.ts for the algorithm and
 * gitignore/projects/master_plan_2026-10-24/research/regions/REPORT.md §6 for the measurements
 * that chose the signals.
 *
 * Geometry: every bbox here is normalized MinMax `[minX, minY, maxX, maxY]` — the same shape as
 * `annotations` rows and `pageIntelligence.pageZones`. The legacy-vocabulary adapter
 * (./adapter.ts) converts to LTWH where `TextRegion` consumers need it.
 */

import type { BboxMinMax, CsiCode, TextractPageData } from "@/types";
import type { PageZones } from "@/lib/page-zones";

/** Current algorithm + weight set. Bump when a weight, a rule or the output shape changes. */
export const REGIONS_V2_VERSION = "rc-v2/0.1";

/** Minimal detection shape — matches the rows the yolo/reprocess loops already hold. */
export interface RegionDetection {
  name: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  confidence?: number;
  modelName?: string;
}

export interface RegionClassifierInput {
  pageNumber: number;
  /** Every YOLO detection on the page, all models (yolo_medium anchors, yolo_primitive support, yolo_text grid). */
  detections: readonly RegionDetection[];
  /** Detector zones (page-zones.ts). Computed from `detections` when absent. */
  zones?: PageZones;
  /** `pages.textractData` — words (OCR mass + L2 tokens) and Textract tables (coincidence signal). */
  textractData?: Pick<TextractPageData, "words" | "tables"> | null;
  /** `pages.csiCodes` — trigger bboxes locate the codes inside a box. */
  csiCodes?: readonly CsiCode[] | null;
}

export type RegionV2Kind = "table" | "legend" | "notes" | "keynotes";
export type RegionV2Anchor = "tables" | "symbol_legend" | "text_box";

/** Class name used when no class row clears the bar. */
export const UNCLASSIFIED = "unclassified";

/** Structure signals measured on one candidate (all numbers; persisted so later labels can refit). */
export interface RegionV2Signals {
  /** Detector confidence of the anchor box. */
  detConf: number;
  /** Share of the anchor covered by yolo_primitive grid / vertical_area / horizontal_area boxes (24×24 sample). */
  areaCover: number;
  /** yolo_text boxes whose centre lies in the (widened) box, and the rows × aligned columns they form. */
  textLines: number;
  textRows: number;
  textCols: number;
  /** OCR words whose centre lies in the box. */
  words: number;
  /** Best containment (intersection / smaller area) with a Textract table; 0 when none. */
  textractTable: number;
  /** yolo_primitive tag shapes (circle, hexagon, …) whose centre lies in the box. */
  tagShapes: number;
  /** rc2 legend / keynote structure: shapes inside, ≥3 shapes in the left 30 % column, ≥2 key shapes. */
  shapes: number;
  legendColumn: boolean;
  keyShapes: boolean;
  /** SCHEDULE / SCHED token inside the box. */
  scheduleWord: boolean;
  /** CSI codes (trigger positions) inside the box. */
  csiCodes: number;
}

export interface RegionV2 {
  /** Stable id: page + anchor class + anchor bbox (so promote/dismiss labels can join later). */
  id: string;
  kind: RegionV2Kind;
  anchor: RegionV2Anchor;
  /** Widened box (toward yolo_primitive area boxes, ≤ 2× per side). */
  bbox: BboxMinMax;
  /** The detector box the region grew from. */
  anchorBbox: BboxMinMax;
  /** 0–1 "this is a real table / legend / notes block" (structure only, no OCR semantics). */
  structureScore: number;
  /** Class row name from region-classes.v2.json, or `UNCLASSIFIED`. */
  className: string;
  /** 0–1 match strength of the winning row (`1 − exp(−score / min_score)`; .63 at the bar). */
  nameScore: number;
  /** Raw L2 score of the winner and the runner-up, for threshold tuning. */
  nameRaw: { best: string; score: number; second: number; hits: string[] };
  signals: RegionV2Signals;
  evidence: string[];
  modelVersion: string;
}

export interface RegionsV2Stats {
  rawTables: number;
  rawLegends: number;
  rawTextBoxes: number;
  inTitleBlock: number;
  /** text_box anchors the fallback checklist called page labels (short label, view title, …). */
  labelsDropped: number;
  /** IoU ≥ .6 duplicates and text boxes folded into a legend. */
  merged: number;
}

export interface RegionsV2 {
  version: string;
  classesHash: string;
  regions: RegionV2[];
  stats: RegionsV2Stats;
}
