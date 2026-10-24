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
import { computePageZones, type PageZones } from "@/lib/page-zones";
import { buildEvidenceSummary, sameEvidence } from "@/lib/evidence";
import { classifyRegionsV2, type RegionsV2 } from "@/lib/region-classifier-v2";
import type { ClassifierRecipe } from "@/lib/classifier-engine";
import { computeClassifierProposals } from "./classifier-proposals-write";
import { storedChannelKind } from "./reprocess-classifiers";
import { buildShapeEnsemble, sameShapeEnsemble, storedShapeEnsemble, summarizeShapeEnsemble, type ShapeEnsembleSummary } from "@/lib/shape-ensemble";
import { computeYoloHeatmap } from "@/lib/spatial/yolo-heatmap";
import { reduceRegionVotes, type EnsembleConfig } from "@/lib/ensemble/region-ensemble";
import { collectAllVotes } from "@/lib/ensemble/vote-adapters";
import { scopeLayoutDetections } from "@/lib/yolo-class-scope";
import type {
  ClassifiedPageRegions,
  ClassifiedTable,
  CsiCode,
  KeynoteShapeData,
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
  /** `pages.textractData` `words` + `tables` for the shadow region classifier v2 and the evidence summary [T4] (optional; `lines` unused; null → evidence left as it was). */
  textractData?: Pick<TextractPageData, "words" | "tables"> | null;
  /** `pages.keynotes` — the classical shape-parse results, the second arm of the shape ensemble
   *  [tag-mapping v2] (optional; null/absent → YOLO-only ensemble). */
  keynotes?: readonly KeynoteShapeData[] | null;
  /** `pages.drawingNumber` — the sheet number (discipline prefix) for the classifier engine [clf 2a]. */
  drawingNumber?: string | null;
}

export interface PostYoloOptions {
  rules: HeuristicRule[];
  heatmapEnabled: boolean;
  ensembleEnabled: boolean;
  ensembleConfig?: Partial<EnsembleConfig>;
  /** The project's drawing numbers — detail-callout recognition in the shape ensemble [tag-mapping v2]. */
  sheetNumbers?: readonly (string | null | undefined)[];
  /** [clf 2a] The company's effective classifier recipes (built-ins + overlay); absent → built-ins. */
  classifierRecipes?: readonly ClassifierRecipe[];
}

/** JSON with object keys sorted at every depth: Postgres reorders jsonb keys, so a stored record
 *  and a freshly computed one never match as plain `JSON.stringify` strings (T5 fix, LOW 3). */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
const sameJson = (a: unknown, b: unknown): boolean => stableStringify(a) === stableStringify(b);

export interface PageShapesInput {
  yoloDets: readonly PostYoloDetection[];
  /** `pages.keynotes` — the classical shape-parse arm (null/absent → YOLO-only). */
  keynotes?: readonly KeynoteShapeData[] | null;
  /** `pages.textractData.words` — the validator read. */
  words?: TextractPageData["words"] | null;
  zones: PageZones;
  /** The page's fresh `regionsV2` — its table regions drop shapes that are table cells. */
  regionsV2?: RegionsV2 | null;
  sheetNumbers?: readonly (string | null | undefined)[] | null;
}

/** [tag-mapping v2] The page's `shapes` summary — ONE definition shared by the post-YOLO
 *  enrichment (below) and the intelligence reprocess (services/reprocess.ts). Throws on bad input;
 *  callers guard it so a failure never drops the page's other enrichment. */
export function computePageShapes(input: PageShapesInput): ShapeEnsembleSummary {
  return summarizeShapeEnsemble(buildShapeEnsemble({
    yolo: input.yoloDets.map((d) => ({ name: d.name, bbox: [d.minX, d.minY, d.maxX, d.maxY], confidence: d.confidence, modelName: d.modelName })),
    classical: (input.keynotes ?? []).map((k) => ({ shape: k.shape, text: k.text ?? "", bbox: k.bbox })),
    words: input.words ?? null,
    zones: input.zones,
    tableBoxes: input.regionsV2?.regions.filter((r) => r.kind === "table").map((r) => r.bbox) ?? null,
    sheetNumbers: input.sheetNumbers ?? null,
  }));
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
  // otherwise; written only when they differ (key order aside) so an unchanged page is not rewritten.
  const zones = computePageZones(yoloDets);
  if (!sameJson(zones, existing.pageZones)) { updated.pageZones = zones; pageChanged = true; }
  // [evidence T4] fused OCR × YOLO evidence summary (src/lib/evidence), same zones; skipped without OCR.
  // Guarded like the composite classifier below: a throw here must not drop the page's other enrichment.
  try {
    const evidence = page.textractData ? buildEvidenceSummary({ textract: page.textractData, detections: yoloDets, zones }) : null;
    if (evidence && !sameEvidence(evidence, existing.evidence)) { updated.evidence = evidence; pageChanged = true; }
  } catch (err) {
    logger.error(`[yolo-post-enrichment] Evidence summary FAILED for page ${page.pageNumber}:`, err);
  }
  // [regions v2 2026-10-24] SHADOW: detector-first region classifier (src/lib/region-classifier-v2).
  // Persisted as `regionsV2` beside the legacy keys; nothing reads it yet and `classifiedTables`
  // below is unchanged. Written only when it differs, like the zones.
  try {
    const regionsV2 = classifyRegionsV2({
      pageNumber: page.pageNumber, detections: yoloDets, zones, textractData: page.textractData, csiCodes,
    });
    if (!sameJson(regionsV2, existing.regionsV2)) { updated.regionsV2 = regionsV2; pageChanged = true; }
  } catch (err) {
    logger.error(`[YOLO-LOAD] classifyRegionsV2 failed for page ${page.pageNumber}:`, err);
  }
  // [classifier engine 2a 2026-10-24] recipes over the fresh regionsV2 (src/lib/classifier-engine) →
  // `classifierProposals` (computed, server-owned; verdicts live apart in `proposalVerdicts`).
  // computeClassifierProposals never throws; written only when it differs, like the zones.
  {
    const proposals = computeClassifierProposals({
      pageNumber: page.pageNumber, detections: yoloDets, zones, textractData: page.textractData, csiCodes,
      regionsV2: updated.regionsV2 as RegionsV2 | undefined, parsedRegions: existing.parsedRegions as Array<{ bbox?: number[] }> | undefined,
      drawingNumber: page.drawingNumber, channelKind: storedChannelKind(existing), keynotes: page.keynotes,
    }, opts.classifierRecipes);
    if (proposals && !sameJson(proposals, existing.classifierProposals)) { updated.classifierProposals = proposals; pageChanged = true; }
  }
  // [tag-mapping v2 2026-10-24] shape ensemble (src/lib/shape-ensemble): yolo_primitive tag shapes
  // fused with the classical shape-parse results, text from the crop read validated by Textract,
  // shapes inside detected tables / title blocks dropped. Persisted compactly as `shapes`
  // (server-owned, services/pages.ts); written only when it differs, like the zones.
  try {
    const shapes = computePageShapes({
      yoloDets, keynotes: page.keynotes, words: page.textractData?.words, zones,
      regionsV2: updated.regionsV2 as RegionsV2 | undefined, sheetNumbers: opts.sheetNumbers,
    });
    if (!sameShapeEnsemble(shapes, storedShapeEnsemble(existing))) { updated.shapes = shapes; pageChanged = true; }
  } catch (err) {
    logger.error(`[yolo-post-enrichment] Shape ensemble FAILED for page ${page.pageNumber}:`, err);
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
