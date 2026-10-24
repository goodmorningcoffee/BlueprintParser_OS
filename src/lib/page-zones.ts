/**
 * page-zones.ts — ONE answer to "where is the title block / drawing / table / legend on this page".
 *
 * BlueprintParser grew ~six independent notions of the title-block zone (a fixed bottom-right
 * rectangle in `spatial-constants.ts`, the CSI grid's y > .85 band, the composite classifier's
 * `titleBlocks`, ...). Measured on the 2026-10-24 corpus (research/regions): 51 % of detector
 * `tables` sit inside a detected `title_block`; the fixed `{.45,.7,1,1}` zone catches only 26 %
 * of those and swallows 20 real tables. This module builds zones from the page's YOLO detections
 * (yolo_medium classes `title_block`, `drawings`, `tables`, `symbol_legend`) and falls back
 * EXACTLY to today's fixed zone when no title block was detected, so pages without YOLO behave
 * identically to before.
 *
 * ONLY yolo_medium detections build zones (`ZONE_MODEL_PATTERN`). yolo_primitive also emits
 * `drawings`, yolo_text's `text_box` collides by name, and a company may register a custom model
 * with any class names — a detection whose `modelName` is missing or names another model is
 * ignored, so an unverified model can never move the title block. The page-names reprocess
 * opts out (`models: "any"`) because there the COMPANY picked the title-block class(es).
 *
 * Pure: no DB, no I/O. Persisted as `pageIntelligence.pageZones` by the post-YOLO enrichment
 * step (services/yolo.ts) and the intelligence reprocess — the stored value is what the upload
 * re-run and the full (text-annotations) reprocess read via `storedPageZones`, so a page's text
 * regions, drawing number and room numbers use the SAME title block whichever job ran last.
 */

import type { BboxMinMax } from "@/types";
import { DEFAULT_TITLE_BLOCK_REGION } from "@/lib/spatial-constants";
import { bboxAreaMinMax, bboxOverlap } from "@/lib/bbox-utils";

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

/** Minimal detection shape — matches the `annotations` rows the yolo/reprocess loops already hold. */
export interface PageZoneDetection {
  name: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  confidence?: number;
  /** Model that emitted the detection; required to match `ZONE_MODEL_PATTERN` unless `models: "any"`. */
  modelName?: string;
}

export interface ComputePageZonesOptions {
  /**
   * `"yolo_medium"` (default): only detections whose `modelName` matches `ZONE_MODEL_PATTERN`
   * contribute. `"any"`: trust the caller's pre-filtered list regardless of model.
   */
  models?: "yolo_medium" | "any";
}

export type ZoneKind = "title_block" | "drawing" | "table" | "legend" | "notes" | "margin";

export interface PageZones {
  /** Detected title block, or the fixed `DEFAULT_TITLE_BLOCK_REGION` when `source` is "fixed-fallback". */
  titleBlock: BboxMinMax | null;
  drawings: BboxMinMax[];
  tables: BboxMinMax[];
  legends: BboxMinMax[];
  source: "detector" | "fixed-fallback";
}

// ═══════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════

/** A bbox is "inside" a zone when at least this fraction of ITS area lies within the zone. */
export const ZONE_CONTAINMENT_THRESHOLD = 0.7;

/** Outer band of the sheet (normalized) treated as `margin` when nothing else claims the bbox. */
const MARGIN_BAND = 0.03;

/** The one model whose `title_block`/`drawings`/`tables`/`symbol_legend` classes define zones. */
export const ZONE_MODEL_PATTERN = /yolo_medium/i;

/** The legacy fixed zone, as MinMax — identical to `DEFAULT_TITLE_BLOCK_REGION`. */
export const FIXED_TITLE_BLOCK_ZONE: BboxMinMax = [
  DEFAULT_TITLE_BLOCK_REGION.minX,
  DEFAULT_TITLE_BLOCK_REGION.minY,
  DEFAULT_TITLE_BLOCK_REGION.maxX,
  DEFAULT_TITLE_BLOCK_REGION.maxY,
];

const CLASS_TITLE_BLOCK = "title_block";
const CLASS_DRAWINGS = "drawings";
const CLASS_TABLES = "tables";
const CLASS_LEGEND = "symbol_legend";

// ═══════════════════════════════════════════════════════════════════
// Builder
// ═══════════════════════════════════════════════════════════════════

/**
 * Build the page's zones from its YOLO detections.
 *
 * - `title_block`: the highest-confidence detection wins; ties go to the bottom-right-most box
 *   (the same pick the page-names reprocess made by hand). None → fixed zone, `source`
 *   "fixed-fallback".
 * - `drawings` / `tables` / `symbol_legend`: every detection is kept, in input order.
 * - Detections from any model other than yolo_medium (or with no `modelName`) are ignored
 *   unless `opts.models === "any"`; invalid boxes are dropped.
 *
 * `computePageZones()` / `computePageZones([])` return the fixed-fallback zones, so a consumer
 * without YOLO data can call this unconditionally and get today's behaviour.
 */
export function computePageZones(
  detections?: readonly PageZoneDetection[] | null,
  opts?: ComputePageZonesOptions,
): PageZones {
  const zones: PageZones = {
    titleBlock: null,
    drawings: [],
    tables: [],
    legends: [],
    source: "detector",
  };

  let bestTitle: { bbox: BboxMinMax; confidence: number } | null = null;
  for (const d of detections ?? []) {
    if (!isZoneModel(d.modelName, opts?.models)) continue;
    const bbox = toBbox(d);
    if (!bbox) continue;
    switch (d.name) {
      case CLASS_TITLE_BLOCK: {
        const confidence = d.confidence ?? 0;
        if (!bestTitle || confidence > bestTitle.confidence
          || (confidence === bestTitle.confidence && isBottomRightOf(bbox, bestTitle.bbox))) {
          bestTitle = { bbox, confidence };
        }
        break;
      }
      case CLASS_DRAWINGS: zones.drawings.push(bbox); break;
      case CLASS_TABLES: zones.tables.push(bbox); break;
      case CLASS_LEGEND: zones.legends.push(bbox); break;
      default: break;
    }
  }

  if (bestTitle) {
    zones.titleBlock = bestTitle.bbox;
  } else {
    zones.titleBlock = [...FIXED_TITLE_BLOCK_ZONE] as BboxMinMax;
    zones.source = "fixed-fallback";
  }
  return zones;
}

// ═══════════════════════════════════════════════════════════════════
// Queries
// ═══════════════════════════════════════════════════════════════════

/** Fraction of `inner`'s area that lies inside `outer` (0 for a degenerate `inner`). */
export function containmentRatio(inner: BboxMinMax, outer: BboxMinMax): number {
  const area = bboxAreaMinMax(inner);
  if (area <= 0) return 0;
  return bboxOverlap(inner, outer) / area;
}

/** True when ≥ `ZONE_CONTAINMENT_THRESHOLD` of `bbox` lies inside `zone`. */
export function isInsideZone(bbox: BboxMinMax, zone: BboxMinMax): boolean {
  return containmentRatio(bbox, zone) >= ZONE_CONTAINMENT_THRESHOLD;
}

/**
 * Classify a bbox against the page's zones. Precedence: title_block > table > legend > drawing
 * (a schedule inset on a plan is still a table). A bbox inside none of them is `margin` when its
 * centre sits in the outer 3 % band of the sheet (border / trim), otherwise `notes` — free sheet
 * space outside every detected structure, which is where general notes live.
 */
export function zoneOf(zones: PageZones, bbox: BboxMinMax): ZoneKind {
  if (zones.titleBlock && isInsideZone(bbox, zones.titleBlock)) return "title_block";
  if (zones.tables.some((z) => isInsideZone(bbox, z))) return "table";
  if (zones.legends.some((z) => isInsideZone(bbox, z))) return "legend";
  if (zones.drawings.some((z) => isInsideZone(bbox, z))) return "drawing";
  const cx = (bbox[0] + bbox[2]) / 2;
  const cy = (bbox[1] + bbox[3]) / 2;
  if (cx < MARGIN_BAND || cx > 1 - MARGIN_BAND || cy < MARGIN_BAND || cy > 1 - MARGIN_BAND) {
    return "margin";
  }
  return "notes";
}

/** Type guard for a stored `pageIntelligence.pageZones` value (jsonb, so shape is not guaranteed). */
export function isPageZones(value: unknown): value is PageZones {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const isBoxList = (x: unknown) => Array.isArray(x) && x.every(isBox);
  return (
    (v.titleBlock === null || isBox(v.titleBlock)) &&
    isBoxList(v.drawings) && isBoxList(v.tables) && isBoxList(v.legends) &&
    (v.source === "detector" || v.source === "fixed-fallback")
  );
}

/**
 * The zones persisted on a page by the post-YOLO step / intelligence reprocess, or `undefined`
 * when the page has none (no YOLO yet) or the stored value is malformed. Consumers that cannot
 * see the YOLO annotations (upload re-run, full reprocess) read this instead of recomputing, so
 * every job agrees on the page's title block.
 */
export function storedPageZones(pageIntelligence: unknown): PageZones | undefined {
  if (!pageIntelligence || typeof pageIntelligence !== "object") return undefined;
  const stored = (pageIntelligence as Record<string, unknown>).pageZones;
  return isPageZones(stored) ? stored : undefined;
}

// ═══════════════════════════════════════════════════════════════════
// Internals
// ═══════════════════════════════════════════════════════════════════

function isZoneModel(modelName: string | undefined, models: ComputePageZonesOptions["models"]): boolean {
  if (models === "any") return true;
  return typeof modelName === "string" && ZONE_MODEL_PATTERN.test(modelName);
}

function toBbox(d: PageZoneDetection): BboxMinMax | null {
  const bbox: BboxMinMax = [d.minX, d.minY, d.maxX, d.maxY];
  if (!bbox.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  if (bbox[2] <= bbox[0] || bbox[3] <= bbox[1]) return null;
  return bbox;
}

function isBottomRightOf(a: BboxMinMax, b: BboxMinMax): boolean {
  return a[0] + a[1] > b[0] + b[1];
}

function isBox(x: unknown): x is BboxMinMax {
  return Array.isArray(x) && x.length === 4 && x.every((n) => typeof n === "number" && Number.isFinite(n));
}
