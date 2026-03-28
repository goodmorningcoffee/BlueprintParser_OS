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
  }[];
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
