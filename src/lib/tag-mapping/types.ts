/**
 * tag-mapping/types.ts — Public types for the tag-mapping engine.
 *
 * Consumers of this module (map-tags-batch route, AutoQtoTab, future
 * Discrepancy Engine, future note-mapping) depend only on these types.
 *
 * `ScoredMatch` is intentionally a structural superset of `YoloTagInstance`
 * with optional scoring fields, so:
 *   - code returning `ScoredMatch[]` is assignable where `YoloTagInstance[]`
 *     is expected (fields are compatible; extras ignored)
 *   - legacy callsites that produce `YoloTagInstance[]` can be widened to
 *     `ScoredMatch[]` without changes (optional fields are undefined)
 */

import type {
  BboxMinMax,
  ClientAnnotation,
  TextractPageData,
  QtoItemType,
  ClassifiedPageRegions,
} from "@/types";

// ─── Core scoring primitives ──────────────────────────────────

export type ConfidenceTier = "high" | "medium" | "low";

export type RegionType =
  | "drawings"
  | "tables"
  | "title_block"
  | "unclassified";

export type DropReason =
  | "outside_scope"
  | "pattern_mismatch"
  | "inside_title_block"
  | "inside_table"
  | "outside_drawings";

export interface ScoreSignals {
  patternMatch: boolean;
  patternStrength: "strong" | "weak" | "none";
  /** True when multi-word matches form a coherent window (adjacent + same line).
   *  Replaces `wordBoundary` given Textract's hyphen-split tokenization. */
  windowMatch: boolean;
  regionType: RegionType;
  regionWeight: number;
  shapeContainBoost: number;   // 0–shapeBoostMax when inside expected shape class
  objectAdjacencyBoost: number; // 0–objectBoostMax when near a target object
  scopeMatch: boolean;
  fuzzy: boolean;              // true when OCR-substitution was used
}

/**
 * A match with a score + signal breakdown. Structural superset of
 * `YoloTagInstance`: all scoring fields are optional so the type is
 * assignable in both directions to preserve back-compat with existing
 * consumers (YoloTag.instances, QtoLineItem.instances).
 */
export interface ScoredMatch {
  // YoloTagInstance fields (required for back-compat)
  pageNumber: number;
  annotationId: number;
  bbox: [number, number, number, number];   // MinMax
  confidence: number;                        // 1.0 exact | 0.9 fuzzy

  // Scoring fields (optional — present only when produced by the scoring path)
  score?: number;               // 0–1 composite
  signals?: ScoreSignals;
  confidenceTier?: ConfidenceTier;
  dropReason?: DropReason;
}

// ─── Pattern inference ────────────────────────────────────────

export interface InferredPattern {
  pattern: RegExp;
  strength: "strong" | "weak";
}

// ─── Scope ────────────────────────────────────────────────────

export interface ScopeFilter {
  allowsPage(pageNumber: number): boolean;
  filterPageNumbers(all: number[]): number[];
  describe(): string;
}

export interface PageMeta {
  pageNumber: number;
  drawingNumber: string | null;
}

export interface ScopeOptions {
  pages?: number[];
  drawingNumberPrefixes?: string[];
  /** Scaffolded for future use; sheet-trade classifier (Phase 1 F2 of
   *  tableSteaksFeatureRoadmap) has to ship before this is honored.
   *  Current behavior: logged as TODO, allow-all. */
  trades?: string[];
}

// ─── Scoring config ───────────────────────────────────────────

export interface ScoringConfig {
  regionWeights: Record<RegionType, number>;
  tierThresholds: { high: number; medium: number };
  strongPatternHardZero: boolean;
  weakPatternAttenuation: number;
  windowPenalty: number;
  fuzzyPenalty: number;
  shapeBoostMax: number;
  objectBoostMax: number;
}

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  regionWeights: {
    drawings: 1.0,
    unclassified: 0.5,
    tables: 0.3,
    title_block: 0.05,
  },
  tierThresholds: { high: 0.7, medium: 0.35 },
  strongPatternHardZero: true,
  weakPatternAttenuation: 0.7,
  windowPenalty: 0.85,
  fuzzyPenalty: 0.9,
  shapeBoostMax: 0.2,
  objectBoostMax: 0.15,
};

// ─── Orchestrator contracts ───────────────────────────────────

/** Parameters for a single countable item (moved from yolo-tag-engine). */
export interface CountableItem {
  itemType: QtoItemType;
  label: string;                 // for error messages / UI
  yoloClass?: string;
  yoloModel?: string;
  tagShapeClass?: string;        // Type 4 only
  text?: string;                 // Types 2, 3, 4, 5
}

/** Legacy entry-point options (moved from yolo-tag-engine). */
export interface MapYoloToOcrOptions {
  tagText: string;
  yoloClass?: string;
  yoloModel?: string;
  scope: "page" | "project";
  pageNumber?: number;
  annotations: ClientAnnotation[];
  textractData: Record<number, TextractPageData>;
}

/** Query context for findOccurrences. Supplied by the caller. */
export interface MatchContext {
  scope: ScopeFilter;
  pageNumber?: number;
  isPageScoped: boolean;   // true maps to legacy scope: "page"
  annotations: ClientAnnotation[];
  textractData: Record<number, TextractPageData>;
  classifiedRegionsByPage: Record<number, ClassifiedPageRegions | undefined>;
  pattern: InferredPattern | null;
  config?: ScoringConfig;  // defaults to DEFAULT_SCORING_CONFIG
}

// ─── Class scan (legacy compat) ──────────────────────────────

export interface ClassScanResult {
  text: string;
  count: number;
  pages: number[];
  instances: ScoredMatch[];   // widened from YoloTagInstance[] — compatible
}

// ─── Region lookup input (used by score-compose + region-weight) ──

/**
 * Minimal region data for scoring. Keeps the primitives consumer-agnostic:
 * any future mapper that produces region classifications in this shape can
 * use the scoring primitives without depending on composite-classifier.
 */
export interface RegionLookup {
  titleBlocks: Array<{ bbox: BboxMinMax }>;
  tables: Array<{ bbox: BboxMinMax }>;
  drawings: Array<{ bbox: BboxMinMax }>;
}
