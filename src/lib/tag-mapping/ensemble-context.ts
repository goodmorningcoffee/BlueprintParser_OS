/**
 * ensemble-context.ts — [tag-mapping v2 2026-10-24] Build the per-page shape ensemble a
 * MatchContext carries, from what the map-tags route (and the corpus measurement script) already
 * hold: the project's annotation rows (yolo + shape-parse), each page's Textract words and its
 * stored intelligence (detector zones, regionsV2 table regions) and the drawing numbers.
 * Pure: no DB, no I/O.
 */

import type { ClientAnnotation, TextractPageData } from "@/types";
import { computePageZones, storedPageZones, type PageZones } from "@/lib/page-zones";
import { storedRegionsV2 } from "@/lib/region-classifier-v2";
import {
  buildShapeEnsemble,
  type EnsembleClassicalInput,
  type EnsembleShape,
  type EnsembleYoloInput,
  type ShapeEnsembleResult,
} from "@/lib/shape-ensemble";

export interface EnsembleContextPage {
  pageNumber: number;
  drawingNumber?: string | null;
  textractData?: Pick<TextractPageData, "words"> | null;
  pageIntelligence?: unknown;
}

export interface EnsembleContext {
  shapes: Record<number, EnsembleShape[]>;
  results: Record<number, ShapeEnsembleResult>;
  /** The zones each page's ensemble was built with (stored, or computed from its yolo_medium rows). */
  zonesByPage: Record<number, PageZones>;
  sheetNumbers: string[];
}

/** Split a project's annotation rows into the two ensemble inputs, per page. */
export function ensembleInputsFromAnnotations(annotations: readonly ClientAnnotation[]): {
  yolo: Map<number, EnsembleYoloInput[]>;
  classical: Map<number, EnsembleClassicalInput[]>;
} {
  const yolo = new Map<number, EnsembleYoloInput[]>();
  const classical = new Map<number, EnsembleClassicalInput[]>();
  for (const a of annotations) {
    const data = (a.data ?? {}) as { confidence?: number; modelName?: string; text?: string; shapeType?: string };
    if (a.source === "yolo") {
      const list = yolo.get(a.pageNumber) ?? [];
      list.push({ name: a.name, bbox: a.bbox, confidence: typeof data.confidence === "number" ? data.confidence : 0, modelName: data.modelName, annotationId: a.id });
      yolo.set(a.pageNumber, list);
    } else if (a.source === "shape-parse") {
      const list = classical.get(a.pageNumber) ?? [];
      list.push({ shape: data.shapeType ?? a.name, text: typeof data.text === "string" ? data.text : "", bbox: a.bbox, annotationId: a.id });
      classical.set(a.pageNumber, list);
    }
  }
  return { yolo, classical };
}

export function buildEnsembleContext(annotations: readonly ClientAnnotation[], pages: readonly EnsembleContextPage[]): EnsembleContext {
  const { yolo, classical } = ensembleInputsFromAnnotations(annotations);
  const sheetNumbers = pages.map((p) => p.drawingNumber).filter((d): d is string => typeof d === "string" && d.trim().length > 0);
  const shapes: Record<number, EnsembleShape[]> = {};
  const results: Record<number, ShapeEnsembleResult> = {};
  const zonesByPage: Record<number, PageZones> = {};
  for (const page of pages) {
    const y = yolo.get(page.pageNumber) ?? [];
    const c = classical.get(page.pageNumber) ?? [];
    if (y.length === 0 && c.length === 0) continue;
    const regionsV2 = storedRegionsV2(page.pageIntelligence);
    // Stored detector zones when the page has them (post-YOLO enrichment since Release D); pages
    // enriched before that get the same zones computed from their yolo_medium rows (fixed fallback
    // without a title block — identical to what the enrichment would persist).
    const zones = storedPageZones(page.pageIntelligence)
      ?? computePageZones(y.map((d) => ({ name: d.name, minX: d.bbox[0], minY: d.bbox[1], maxX: d.bbox[2], maxY: d.bbox[3], confidence: d.confidence, modelName: d.modelName })));
    const result = buildShapeEnsemble({
      yolo: y,
      classical: c,
      words: page.textractData?.words ?? null,
      zones,
      tableBoxes: regionsV2?.regions.filter((r) => r.kind === "table").map((r) => r.bbox) ?? null,
      sheetNumbers,
    });
    shapes[page.pageNumber] = result.shapes;
    results[page.pageNumber] = result;
    zonesByPage[page.pageNumber] = zones;
  }
  return { shapes, results, zonesByPage, sheetNumbers };
}
