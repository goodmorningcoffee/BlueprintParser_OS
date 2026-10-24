/**
 * detectors/types.ts
 *
 * Common interface for all text-annotation detectors.
 * Each detector implements TextDetector and is registered in registry.ts.
 */

import type {
  TextractWord,
  TextractLine,
  TextAnnotation,
  TextAnnotationType,
  CsiCode,
} from "@/types";
import type { PageZones } from "@/lib/page-zones";

/** Context provided to all detectors by the orchestrator. */
export interface DetectorContext {
  words: TextractWord[];
  lines: TextractLine[];
  csiCodes: CsiCode[];
  yoloDetections?: {
    name: string;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    confidence: number;
    /** [zones T2] which model emitted it — page-zones.ts only trusts yolo_medium. */
    modelName?: string;
  }[];
  /**
   * [zones T2] The page's persisted detector zones (`pageIntelligence.pageZones`), when the
   * caller has them but not the raw YOLO detections (upload re-run, full reprocess).
   */
  pageZones?: PageZones;
  pageNumber?: number;
}

/** Metadata describing a detector module for registry/admin UI. */
export interface DetectorMeta {
  id: string;
  name: string;
  category: "heuristic" | "yolo-augmented" | "csi";
  description: string;
  defaultEnabled: boolean;
  produces: TextAnnotationType[];
}

/** A pluggable detector module. */
export interface TextDetector {
  meta: DetectorMeta;
  detect: (ctx: DetectorContext) => TextAnnotation[];
}
