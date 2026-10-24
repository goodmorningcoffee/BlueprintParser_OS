// Post-YOLO per-page enrichment for yolo/load (services/yolo.ts `yoloLoad`): heuristic engine →
// table reclassification → composite region classifier → density heatmap → ensemble reducer.
// [fix 2026-10-24 T1a] Extracted VERBATIM from the yoloLoad page loop so it can be unit-tested
// (the loop was untestable, which is how the defect below shipped), with three wiring fixes:
//   1. the heuristic engine and the table classifier get the page's REAL CSI codes
//      (`pages.csiCodes`). They used to get `pageIntelligence.csiCodes`, a key that does not exist,
//      so every CSI-division term was dead after YOLO;
//   2. the heatmap reads its layout classes from their own model (lib/yolo-class-scope.ts);
//   3. the ensemble override arrives through lib/pipeline-toggles.ts (caller-resolved).
// Pure: no DB, no I/O — the caller merges YOLO class-config CSI codes and persists.

import { runHeuristicEngine, type HeuristicRule } from "@/lib/heuristic-engine";
import { classifyTables } from "@/lib/table-classifier";
import { classifyPageRegions } from "@/lib/composite-classifier";
import { computePageZones } from "@/lib/page-zones";
import { classifyRegionsV2 } from "@/lib/region-classifier-v2";
import { computeYoloHeatmap } from "@/lib/spatial/yolo-heatmap";
import { reduceRegionVotes, type EnsembleConfig } from "@/lib/ensemble/region-ensemble";
import { collectAllVotes } from "@/lib/ensemble/vote-adapters";
import { scopeLayoutDetections } from "@/lib/yolo-class-scope";
import type {
  ClassifiedPageRegions,
  ClassifiedTable,
  CsiCode,
  ParsedRegion,
  TextractPageData,
  YoloHeatmap,
} from "@/types";
import { logger } from "@/lib/logger";

/** YOLO classes aggregated by Layer 2 heatmap. Generic multi-class density —
 *  not notes-specific; used by LLM context + Stage 2b ensemble reducer. */
export const HEATMAP_CLASSES = [
  "text_box",
  "vertical_area",
  "horizontal_area",
] as const;

export interface PostYoloDetection {
  name: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  confidence: number;
  modelName?: string;
}

export interface PostYoloPage {
  pageNumber: number;
  rawText: string | null;
  pageIntelligence: unknown;
  /** `pages.csiCodes` — the page's CSI codes. NOT pageIntelligence (it has no csiCodes key). */
  csiCodes: CsiCode[] | null;
  /** `pages.textractData` — words + Textract tables for the shadow region classifier v2 (optional). */
  textractData?: TextractPageData | null;
}

export interface PostYoloOptions {
  rules: HeuristicRule[];
  heatmapEnabled: boolean;
  ensembleEnabled: boolean;
  ensembleConfig?: Partial<EnsembleConfig>;
}

/** → the page's next pageIntelligence (a spread of the existing one) and whether it changed. */
export function enrichPageAfterYolo(
  page: PostYoloPage,
  yoloDets: PostYoloDetection[],
  opts: PostYoloOptions,
): { updated: Record<string, unknown>; pageChanged: boolean } {
  const existing = (page.pageIntelligence || {}) as Record<string, unknown>;
  const updated: Record<string, unknown> = { ...existing };
  let pageChanged = false;
  const csiCodes = page.csiCodes ?? [];
  // [zones T2] detector zones (src/lib/page-zones.ts): yolo_medium only, fixed-zone fallback
  // otherwise; written only when they differ so an unchanged page is not rewritten.
  const zones = computePageZones(yoloDets);
  if (JSON.stringify(zones) !== JSON.stringify(existing.pageZones)) { updated.pageZones = zones; pageChanged = true; }

  // [regions v2 2026-10-24] SHADOW: detector-first region classifier (src/lib/region-classifier-v2).
  // Persisted as `regionsV2` beside the legacy keys; nothing reads it yet and `classifiedTables`
  // below is unchanged. Written only when it differs, like the zones.
  try {
    const regionsV2 = classifyRegionsV2({
      pageNumber: page.pageNumber, detections: yoloDets, zones, textractData: page.textractData, csiCodes,
    });
    if (JSON.stringify(regionsV2) !== JSON.stringify(existing.regionsV2)) { updated.regionsV2 = regionsV2; pageChanged = true; }
  } catch (err) {
    logger.error(`[YOLO-LOAD] classifyRegionsV2 failed for page ${page.pageNumber}:`, err);
  }

  // Existing: re-run heuristic engine with YOLO data
  const inferences = runHeuristicEngine(opts.rules, {
    rawText: page.rawText || "",
    yoloDetections: yoloDets,
    textRegions: existing.textRegions as unknown,
    csiCodes,
    pageNumber: page.pageNumber,
  } as Parameters<typeof runHeuristicEngine>[1]);

  if (inferences.length > 0) {
    updated.heuristicInferences = inferences;
    pageChanged = true;

    // Reclassify tables (OCR-keyword classifier) with YOLO-enriched heuristics
    const textRegions = (existing.textRegions as unknown[] | undefined) ?? [];
    if (textRegions.length > 0) {
      const classified = classifyTables({
        textRegions: textRegions as Parameters<
          typeof classifyTables
        >[0]["textRegions"],
        heuristicInferences: inferences,
        csiCodes,
        pageNumber: page.pageNumber,
      });
      if (classified.length > 0) updated.classifiedTables = classified;
    }
  }

  // NEW (QTO SHIP 1): composite region classifier — Layer 1 of the QTO
  // rebuild. Combines yolo class signals with OCR header keywords to
  // produce exclusion (tables, title_block) and inclusion (drawings)
  // zones. Runs regardless of heuristic inferences because a page can
  // have a tables bbox without any heuristic rule firing.
  try {
    const regions = classifyPageRegions({
      pageNumber: page.pageNumber,
      yoloAnnotations: yoloDets.map((d) => ({
        name: d.name,
        bbox: [d.minX, d.minY, d.maxX, d.maxY],
        modelName: d.modelName,
      })),
      textRegions: existing.textRegions as Parameters<
        typeof classifyPageRegions
      >[0]["textRegions"],
      parsedRegions: existing.parsedRegions as Parameters<
        typeof classifyPageRegions
      >[0]["parsedRegions"],
      legacyClassifiedTables: (updated.classifiedTables ??
        existing.classifiedTables) as ClassifiedTable[] | undefined,
    });
    const hasRegions =
      regions.tables.length > 0 ||
      regions.titleBlocks.length > 0 ||
      regions.drawings.length > 0;
    if (hasRegions) {
      updated.classifiedRegions = regions;
      pageChanged = true;
    }
  } catch (err) {
    logger.error(
      `[YOLO-LOAD] classifyPageRegions failed for page ${page.pageNumber}:`,
      err,
    );
  }

  // Stage 2a Layer 2: YOLO density heatmap — aggregates text_box +
  // vertical_area + horizontal_area into confident-region bboxes, each class
  // from its own model (yolo_text's per-word text_box would flood the density).
  // Universal spatial signal consumed by LLM context + Stage 2b ensemble.
  if (opts.heatmapEnabled) {
    try {
      const heatmap = computeYoloHeatmap(
        page.pageNumber,
        scopeLayoutDetections(yoloDets),
        { classes: [...HEATMAP_CLASSES] },
      );
      if (
        heatmap.confidentRegions.length > 0 ||
        Object.values(heatmap.classContributions).some((v) => v > 0)
      ) {
        updated.yoloHeatmap = heatmap;
        pageChanged = true;
      }
    } catch (err) {
      logger.error(
        `[YOLO-LOAD] computeYoloHeatmap failed for page ${page.pageNumber}:`,
        err,
      );
    }
  }

  // Stage 2b: ensemble reducer — cross-signal agreement; suppresses
  // keyword-only false positives (the 2026-04-22 door-schedule screenshot bug).
  if (opts.ensembleEnabled) {
    try {
      const votes = collectAllVotes({
        classifiedTables: updated.classifiedTables as
          ClassifiedTable[] | undefined,
        classifiedRegionsTables: (
          updated.classifiedRegions as ClassifiedPageRegions | undefined
        )?.tables,
        yoloHeatmap: updated.yoloHeatmap as YoloHeatmap | undefined,
        parsedRegions:
          (existing.parsedRegions as ParsedRegion[] | undefined) ?? undefined,
      });
      if (votes.length > 0) {
        const ensembleRegions = reduceRegionVotes(
          page.pageNumber,
          votes,
          opts.ensembleConfig,
        );
        if (ensembleRegions.length > 0) {
          updated.ensembleRegions = ensembleRegions;
          pageChanged = true;
        }
      }
    } catch (err) {
      logger.error(
        `[YOLO-LOAD] ensemble reducer failed for page ${page.pageNumber}:`,
        err,
      );
    }
  }

  return { updated, pageChanged };
}
