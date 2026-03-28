/**
 * detectors/registry.ts
 *
 * Central registry of all text-annotation detectors.
 * Adding a new detector = import it here + add to ALL_DETECTORS.
 */

import type { TextDetector, DetectorMeta } from "./types";
import { contactDetector } from "./contact";
import { codesDetector } from "./codes";
import { dimensionsDetector } from "./dimensions";
import { equipmentDetector } from "./equipment";
import { referencesDetector } from "./references";
import { tradeDetector } from "./trade";
import { abbreviationsDetector } from "./abbreviations";
import { notesDetector } from "./notes";
import { roomsDetector } from "./rooms";
import { csiAnnotationsDetector } from "./csi-annotations";

/** All available detectors. Order does not matter — dedup handles priority. */
export const ALL_DETECTORS: TextDetector[] = [
  contactDetector,
  codesDetector,
  dimensionsDetector,
  equipmentDetector,
  referencesDetector,
  tradeDetector,
  abbreviationsDetector,
  notesDetector,
  roomsDetector,
  csiAnnotationsDetector,
];

/** Get detector by ID. */
export function getDetector(id: string): TextDetector | undefined {
  return ALL_DETECTORS.find(d => d.meta.id === id);
}

/** Get all detector IDs. */
export function getDetectorIds(): string[] {
  return ALL_DETECTORS.map(d => d.meta.id);
}

/** Get detector metadata for admin UI. */
export function getAllDetectorMeta(): DetectorMeta[] {
  return ALL_DETECTORS.map(d => d.meta);
}
