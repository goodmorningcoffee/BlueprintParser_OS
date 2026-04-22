/**
 * composite-classifier.ts — Layer 1 of the Auto-QTO rebuild.
 *
 * Unifies multiple YOLO class signals + OCR header keywords into spatial
 * region classifications used for takeoff exclusion/inclusion:
 *
 *   - tables      → EXCLUSION zones (drop matches inside these)
 *   - titleBlocks → EXCLUSION zones (drop matches inside these)
 *   - drawings    → INCLUSION zones (keep matches only inside these, if any exist)
 *
 * This is distinct from `table-classifier.ts` (semantic OCR-keyword classifier
 * that produces ClassifiedTable[] with category labels like "door-schedule").
 * Both coexist — ClassifiedTable feeds the existing UI / symbol search / CSI
 * map pipeline; ClassifiedRegion feeds the takeoff engine's exclusion filter.
 *
 * Confidence rules (see project_composite_classifier_design.md):
 *   tables ∩ grid ∩ OCR header  → 0.95
 *   tables ∩ grid               → 0.85
 *   tables ∩ (v|h)_area         → 0.80
 *   tables alone                → 0.70
 *   grid ∩ OCR header           → 0.65   (grid-only NEVER emits without confirmation)
 *   grid ∩ (v|h)_area           → 0.60
 *   parsedRegions (user)        → 0.95
 *   pageIntel:classifiedTables  → 0.60
 *
 * Precedence rule: tables exclusion ALWAYS beats drawings inclusion.
 * A table region sitting physically inside a drawings region (inset schedule,
 * legend box on a large drawing) must still exclude its interior.
 */

import type {
  BboxMinMax,
  ClassifiedRegion,
  ClassifiedRegionSource,
  ClassifiedPageRegions,
  TextRegion,
  ParsedRegion,
  ClassifiedTable,
  YoloTagInstance,
} from "@/types";
import {
  bboxIoU,
  bboxOverlap,
  bboxContainsPoint,
  bboxCenterMinMax,
  ltwh2minmax,
} from "@/lib/bbox-utils";
import { migrateTextRegions } from "@/lib/text-region-migrate";

// ═══════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════

/**
 * Whole-word schedule header keywords. Matched against the `headerText` of
 * TextRegion objects that overlap a candidate bbox. Presence of any of these
 * is a strong signal the region is a schedule/legend/notes table.
 */
const SCHEDULE_HEADER_KEYWORDS = [
  "SCHEDULE",
  "LEGEND",
  "NOTES",
  "GENERAL NOTES",
  "KEY NOTES",
  "KEYNOTES",
  "DOOR SCHEDULE",
  "WINDOW SCHEDULE",
  "ROOM FINISH SCHEDULE",
  "HARDWARE SCHEDULE",
  "WALL TYPE",
  "FINISH SCHEDULE",
  "EQUIPMENT SCHEDULE",
  "PLUMBING SCHEDULE",
  "LIGHTING SCHEDULE",
  "MECHANICAL SCHEDULE",
  "ELECTRICAL LEGEND",
  "SYMBOLS LEGEND",
];

/**
 * Classes from yolo_medium that must have SOME annotation in the project for
 * Auto-QTO to run safely. Without these, the exclusion/inclusion zones
 * required for reliable takeoff counts cannot be built.
 *
 * Note: `drawings` can come from EITHER yolo_medium or yolo_primitive — the
 * preflight treats those as equivalent.
 */
const STRICT_EXCLUSION_CLASSES = ["tables", "title_block", "drawings"] as const;

/**
 * Classes from yolo_primitive that BOOST classification confidence but are
 * not strictly required. Missing them just means fewer high-confidence
 * regions, not a hard block.
 */
const RECOMMENDED_CLASSES = ["grid", "vertical_area", "horizontal_area"] as const;

/** IoU threshold for merging two overlapping candidate regions from different sources. */
const MERGE_IOU_THRESHOLD = 0.5;

/**
 * Containment threshold for confirmation signals. A `grid` annotation counts
 * as confirming a `tables` annotation when ≥60% of the grid bbox's area lies
 * inside the tables bbox. Prevents spurious matches on distant grids.
 */
const CONFIRMATION_OVERLAP_THRESHOLD = 0.6;

// ═══════════════════════════════════════════════════════════════════
// Input type
// ═══════════════════════════════════════════════════════════════════

/**
 * Minimal shape for a yolo annotation input. The composite classifier doesn't
 * need the full ClientAnnotation shape — just class name, bbox, and optional
 * modelName for drawings cross-model agreement. Callers can adapt from any
 * source (DB rows, ClientAnnotation, raw YOLO detections).
 */
export interface YoloRegionInput {
  name: string;
  bbox: BboxMinMax;
  modelName?: string;
}

export interface ClassifyPageRegionsInput {
  pageNumber: number;
  yoloAnnotations: YoloRegionInput[];
  /** Optional — from existing pageIntelligence.textRegions (OCR-based). Used for header keyword signal. */
  textRegions?: TextRegion[];
  /** Optional — user-saved parsed schedule regions. Strongest tables signal. */
  parsedRegions?: ParsedRegion[];
  /** Optional — legacy OCR-keyword classifier output. Weak agreement signal. */
  legacyClassifiedTables?: ClassifiedTable[];
}

// ═══════════════════════════════════════════════════════════════════
// Main classifier
// ═══════════════════════════════════════════════════════════════════

/**
 * Classify a single page's regions into tables / title blocks / drawings.
 *
 * Consumes YOLO annotations + optional OCR text regions + optional user-saved
 * regions + optional legacy classifier output. Returns three arrays of
 * ClassifiedRegion objects, each with merged sources and max confidence.
 *
 * Empty arrays are valid outputs — a page with no tables simply returns
 * `{ tables: [], titleBlocks: [], drawings: [] }`.
 */
export function classifyPageRegions(
  input: ClassifyPageRegionsInput,
): ClassifiedPageRegions {
  const { pageNumber, yoloAnnotations, parsedRegions } = input;
  // Legacy-shape textRegions + legacyClassifiedTables carry old type strings
  // from pre-2026-04-24 pages; normalize here so downstream string comparisons
  // (e.g., `lt.type !== "schedule-table"`) see unified names.
  const textRegions = migrateTextRegions(input.textRegions);
  const legacyClassifiedTables = migrateTextRegions(
    input.legacyClassifiedTables,
  ) as ClassifiedTable[] | undefined;

  // Group yolo annotations by class name for O(1) lookup
  const byClass = new Map<string, YoloRegionInput[]>();
  for (const a of yoloAnnotations) {
    if (!byClass.has(a.name)) byClass.set(a.name, []);
    byClass.get(a.name)!.push(a);
  }

  const tables: ClassifiedRegion[] = [];
  const titleBlocks: ClassifiedRegion[] = [];
  const drawings: ClassifiedRegion[] = [];

  // ───────────────────────────────────────────────────────────────
  // Tables
  // ───────────────────────────────────────────────────────────────

  // Base signal: yolo_medium `tables` class
  for (const t of byClass.get("tables") ?? []) {
    const region: ClassifiedRegion = {
      kind: "table",
      bbox: t.bbox,
      confidence: 0.7,
      sources: ["yolo:tables"],
      pageNumber,
    };

    // Confirmation: overlapping grid annotation → +0.15
    if (hasConfirmingAnnotation(t.bbox, byClass.get("grid"))) {
      region.confidence = Math.max(region.confidence, 0.85);
      addSource(region, "yolo:grid");
    }

    // Confirmation: overlapping vertical/horizontal area primitive → +0.10
    const vaConf = hasConfirmingAnnotation(t.bbox, byClass.get("vertical_area"));
    const haConf = hasConfirmingAnnotation(t.bbox, byClass.get("horizontal_area"));
    if (vaConf || haConf) {
      region.confidence = Math.max(region.confidence, 0.8);
      if (vaConf) addSource(region, "yolo:vertical_area");
      if (haConf) addSource(region, "yolo:horizontal_area");
    }

    // Confirmation: OCR schedule header keyword in the top of the bbox → pin to 0.95
    const header = findHeaderKeyword(t.bbox, textRegions);
    if (header) {
      region.confidence = Math.max(region.confidence, 0.95);
      addSource(region, "ocr:header_keyword");
      region.headerText = header;
    }

    mergeOrInsert(tables, region);
  }

  // User-saved parsedRegions are always the strongest tables signal
  for (const pr of parsedRegions ?? []) {
    // ParsedRegion has no pageNumber field in our input shape — caller is
    // expected to pre-filter by page. Just accept what we're given.
    const region: ClassifiedRegion = {
      kind: "table",
      bbox: ltwh2minmax(pr.bbox),
      confidence: 0.95,
      sources: ["parsedRegions"],
      pageNumber,
    };
    mergeOrInsert(tables, region);
  }

  // Legacy classifiedTables agreement — only schedule-table, not notes/spec
  // Accepts both new-shape "schedule-table" and legacy "table-like" via
  // migrateTextRegion wrap applied at classifyPageRegions entry (see Task 12).
  for (const lt of legacyClassifiedTables ?? []) {
    if (lt.pageNumber !== pageNumber) continue;
    if (lt.type !== "schedule-table") continue;
    const region: ClassifiedRegion = {
      kind: "table",
      bbox: ltwh2minmax(lt.bbox),
      confidence: 0.6,
      sources: ["pageIntel:classifiedTables"],
      pageNumber,
    };
    mergeOrInsert(tables, region);
  }

  // Grid-only regions with OCR header keyword support (grid never emits alone)
  for (const g of byClass.get("grid") ?? []) {
    // Skip if already covered by a tables region we emitted above
    if (overlapsAnyRegion(g.bbox, tables)) continue;
    const header = findHeaderKeyword(g.bbox, textRegions);
    if (!header) continue;
    const region: ClassifiedRegion = {
      kind: "table",
      bbox: g.bbox,
      confidence: 0.65,
      sources: ["yolo:grid", "ocr:header_keyword"],
      headerText: header,
      pageNumber,
    };
    mergeOrInsert(tables, region);
  }

  // ───────────────────────────────────────────────────────────────
  // Title blocks
  // ───────────────────────────────────────────────────────────────

  for (const tb of byClass.get("title_block") ?? []) {
    const region: ClassifiedRegion = {
      kind: "title_block",
      bbox: tb.bbox,
      confidence: 0.85,
      sources: ["yolo:title_block"],
      pageNumber,
    };
    if (hasConfirmingAnnotation(tb.bbox, byClass.get("vertical_area"))) {
      region.confidence = 0.95;
      addSource(region, "yolo:vertical_area");
    }
    mergeOrInsert(titleBlocks, region);
  }

  // vertical_area alone is NEVER emitted — too noisy per user feedback.

  // ───────────────────────────────────────────────────────────────
  // Drawings
  // ───────────────────────────────────────────────────────────────

  // Collect all drawings annotations from both models — the merge step will
  // combine overlapping ones and bump confidence when agreement is detected.
  const drawingsAnnotations = byClass.get("drawings") ?? [];

  for (const d of drawingsAnnotations) {
    const region: ClassifiedRegion = {
      kind: "drawings",
      bbox: d.bbox,
      confidence: 0.8,
      sources: ["yolo:drawings"],
      pageNumber,
    };
    // If this annotation merges with an existing drawings region AND the
    // existing one came from a different model, bump to 0.95. This is the
    // "yolo_medium ∩ yolo_primitive" high-confidence case.
    const mergedWith = mergeOrInsert(drawings, region);
    if (mergedWith && d.modelName && mergedWith.sources.some((s) => s === "yolo:drawings")) {
      // Multi-model agreement: confidence bump
      const distinctModels = countDistinctModels(drawingsAnnotations, mergedWith.bbox);
      if (distinctModels >= 2) {
        mergedWith.confidence = Math.max(mergedWith.confidence, 0.95);
      }
    }
  }

  return { tables, titleBlocks, drawings };
}

// ═══════════════════════════════════════════════════════════════════
// Preflight validation
// ═══════════════════════════════════════════════════════════════════

export interface PreflightResult {
  ok: boolean;
  missingStrict: string[];       // strict classes with zero annotations across the project
  missingRecommended: string[];  // recommended classes with zero annotations
  hasTables: boolean;
  hasTitleBlock: boolean;
  hasDrawings: boolean;
}

/**
 * Check whether the project has the YOLO class annotations required for
 * Auto-QTO's exclusion/inclusion logic to work.
 *
 * Hard block (ok=false) if any of {tables, title_block, drawings} has zero
 * annotations project-wide — the user needs to run yolo_medium before
 * Auto-QTO can produce a defensible count.
 *
 * Map Tags double-click uses the return value as a soft warning: still runs,
 * but surfaces "you're missing X — results may over-count" in the UI.
 */
export function validateExclusionPreflight(
  allYoloAnnotations: Array<{ name: string }>,
): PreflightResult {
  const classCounts = new Map<string, number>();
  for (const a of allYoloAnnotations) {
    classCounts.set(a.name, (classCounts.get(a.name) ?? 0) + 1);
  }

  const missingStrict: string[] = [];
  for (const cls of STRICT_EXCLUSION_CLASSES) {
    if ((classCounts.get(cls) ?? 0) === 0) missingStrict.push(cls);
  }

  const missingRecommended: string[] = [];
  for (const cls of RECOMMENDED_CLASSES) {
    if ((classCounts.get(cls) ?? 0) === 0) missingRecommended.push(cls);
  }

  return {
    ok: missingStrict.length === 0,
    missingStrict,
    missingRecommended,
    hasTables: (classCounts.get("tables") ?? 0) > 0,
    hasTitleBlock: (classCounts.get("title_block") ?? 0) > 0,
    hasDrawings: (classCounts.get("drawings") ?? 0) > 0,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Internal helpers
// ═══════════════════════════════════════════════════════════════════

/**
 * Check whether any annotation from the given list has ≥60% of its area
 * overlapping the candidate bbox. Used to detect "confirmation signals" like
 * a grid sitting inside a tables bbox. Higher threshold than IoU so that a
 * small grid inside a much larger tables region still confirms.
 */
function hasConfirmingAnnotation(
  candidateBbox: BboxMinMax,
  confirmers: YoloRegionInput[] | undefined,
): boolean {
  if (!confirmers || confirmers.length === 0) return false;
  for (const c of confirmers) {
    const intersection = bboxOverlap(candidateBbox, c.bbox);
    if (intersection === 0) continue;
    const confirmerArea = Math.max(0, c.bbox[2] - c.bbox[0]) * Math.max(0, c.bbox[3] - c.bbox[1]);
    if (confirmerArea === 0) continue;
    if (intersection / confirmerArea >= CONFIRMATION_OVERLAP_THRESHOLD) return true;
  }
  return false;
}

/**
 * Look for a schedule header keyword in the OCR text regions that overlap
 * the top 15% of the candidate bbox. Returns the matched keyword (or the
 * first line of the header text containing it) for inclusion in the region.
 *
 * Memory spec said 10%; we use 15% as a slight cushion for OCR fuzziness
 * where a header line may straddle the 10% boundary. TextRegion bboxes
 * aggregate full lines, so the overlap doesn't need to cover much of the
 * region to detect a header match.
 */
function findHeaderKeyword(
  bbox: BboxMinMax,
  textRegions: TextRegion[] | undefined,
): string | undefined {
  if (!textRegions || textRegions.length === 0) return undefined;
  const [minX, minY, maxX, maxY] = bbox;
  const topStrip: BboxMinMax = [minX, minY, maxX, minY + (maxY - minY) * 0.15];
  for (const tr of textRegions) {
    const trBbox = ltwh2minmax(tr.bbox);
    if (bboxOverlap(trBbox, topStrip) === 0) continue;
    const header = (tr.headerText || "").toUpperCase();
    if (!header) continue;
    for (const kw of SCHEDULE_HEADER_KEYWORDS) {
      if (isWholeWordMatch(header, kw)) return tr.headerText;
    }
  }
  return undefined;
}

/** Whole-word regex match (no partial — "NOTES" matches "GENERAL NOTES" but not "NOTEBOOK"). */
function isWholeWordMatch(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const re = new RegExp(`\\b${escaped}\\b`, "i");
  return re.test(haystack);
}

/**
 * Merge `newRegion` into an existing region with IoU > threshold, or insert
 * as a new entry. Returns the existing region that absorbed the new one, or
 * the newly-inserted region.
 *
 * Merge behavior: union the bboxes, merge sources (deduped), take max
 * confidence, take the first available headerText.
 */
function mergeOrInsert(
  existing: ClassifiedRegion[],
  newRegion: ClassifiedRegion,
): ClassifiedRegion {
  for (const r of existing) {
    if (bboxIoU(r.bbox, newRegion.bbox) > MERGE_IOU_THRESHOLD) {
      r.bbox = [
        Math.min(r.bbox[0], newRegion.bbox[0]),
        Math.min(r.bbox[1], newRegion.bbox[1]),
        Math.max(r.bbox[2], newRegion.bbox[2]),
        Math.max(r.bbox[3], newRegion.bbox[3]),
      ];
      r.confidence = Math.max(r.confidence, newRegion.confidence);
      for (const s of newRegion.sources) {
        if (!r.sources.includes(s)) r.sources.push(s);
      }
      if (newRegion.headerText && !r.headerText) r.headerText = newRegion.headerText;
      return r;
    }
  }
  existing.push(newRegion);
  return newRegion;
}

/** Add a source to a region without duplicating. */
function addSource(region: ClassifiedRegion, source: ClassifiedRegionSource): void {
  if (!region.sources.includes(source)) region.sources.push(source);
}

/** Check if a candidate bbox's center is inside any of the existing regions. */
function overlapsAnyRegion(candidate: BboxMinMax, regions: ClassifiedRegion[]): boolean {
  const center = bboxCenterMinMax(candidate);
  return regions.some((r) => bboxContainsPoint(r.bbox, center));
}

/**
 * Count distinct model names among drawings annotations whose bbox overlaps
 * a target bbox. Used to detect yolo_medium + yolo_primitive agreement.
 */
function countDistinctModels(
  drawingsAnns: YoloRegionInput[],
  targetBbox: BboxMinMax,
): number {
  const models = new Set<string>();
  for (const a of drawingsAnns) {
    if (bboxIoU(a.bbox, targetBbox) > MERGE_IOU_THRESHOLD) {
      if (a.modelName) models.add(a.modelName);
    }
  }
  return models.size;
}
