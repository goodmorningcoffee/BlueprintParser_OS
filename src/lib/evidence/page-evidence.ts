// [evidence T4 2026-10-24] EVIDENCE LAYER v1 — one place every tool reads fused page evidence from,
// instead of each tool re-deriving word/box overlaps (tools_audit/REPORT.md §6).
//
//   getPageEvidence(input)       full in-memory evidence: every Textract word with its source/p_text,
//                                yolo_text holes, per-model detections with real confidences,
//                                Textract TABLES (76 % of pages; nothing consumed them), zone of each item.
//   summarizePageEvidence(ev)    the compact projection persisted as `pageIntelligence.evidence`
//                                (counts, ≤ EVIDENCE_HOLE_CAP holes, table bboxes + dims, version stamp).
//   storedPageEvidence(pi)       read a persisted summary back (undefined when absent / other version).
//
// Pages carry thousands of words and up to ~6,000 yolo_text boxes, so per-mark data is NEVER persisted;
// a tool that needs marks calls getPageEvidence on rows it already holds (pure, ~linear).
// Written by: the post-YOLO enrichment (services/yolo-post-enrichment.ts), upload processing (OCR-only,
// lib/processing.ts), the intelligence reprocess, and the Reprocess "evidence" scope (reprocess-evidence.ts).

import type { BboxMinMax, TextractTable } from "@/types";
import { ltwh2minmax } from "@/lib/bbox-utils";
import { computePageZones, zoneOf, ZONE_MODEL_PATTERN, type PageZones, type ZoneKind } from "@/lib/page-zones";
import { TEXT_CLASS, TEXT_MODEL_NAME } from "@/lib/yolo-config-yaml";
import { fuseText, type YoloTextBox } from "./text-evidence";
import {
  EVIDENCE_VERSION,
  type EvidenceDetectionInput,
  type EvidenceSummary,
  type EvidenceTable,
  type ModelDetections,
  type PageEvidence,
  type PageEvidenceInput,
} from "./types";

/** Holes persisted per page (highest yolo confidence first). The median page has ~27. */
export const EVIDENCE_HOLE_CAP = 500;
/** Textract tables persisted per page (the corpus max is far below this). */
export const EVIDENCE_TABLE_CAP = 100;

/**
 * A yolo_text word box: a text class (`text_box`, `text_box_2`) from a model whose NAME is a text model.
 * yolo_medium's region-level `text_box` collides by class name, and legacy rows without a modelName
 * cannot be told apart — both are treated as ordinary detections, never as word boxes.
 */
export function isYoloTextDetection(d: { name: string; modelName?: string | null }): boolean {
  return typeof d.modelName === "string" && TEXT_MODEL_NAME.test(d.modelName) && TEXT_CLASS.test(d.name);
}

export function getPageEvidence(input: PageEvidenceInput): PageEvidence {
  const detections = (input.detections ?? []).filter(isValidDetection);
  const zones: PageZones = input.zones ?? computePageZones(detections);

  const textBoxes: YoloTextBox[] = [];
  const byModel = new Map<string, ModelDetections>();
  for (const d of detections) {
    const bbox: BboxMinMax = [d.minX, d.minY, d.maxX, d.maxY];
    const confidence = d.confidence ?? 0;
    if (isYoloTextDetection(d)) textBoxes.push({ bbox, confidence });
    const modelName = d.modelName || "unknown";
    let group = byModel.get(modelName);
    if (!group) byModel.set(modelName, (group = { modelName, detections: [] }));
    group.detections.push({ name: d.name, bbox, confidence, zone: zoneOf(zones, bbox) });
  }

  const fusion = fuseText(input.textract?.words ?? [], textBoxes);
  return {
    version: EVIDENCE_VERSION,
    zones,
    text: fusion.items.map((t) => ({ ...t, zone: zoneOf(zones, t.bbox) })),
    holes: fusion.holes.map((h) => ({ ...h, zone: zoneOf(zones, h.bbox) })),
    detections: [...byModel.values()].sort((a, b) => a.modelName.localeCompare(b.modelName)),
    tables: (input.textract?.tables ?? []).flatMap((t) => toEvidenceTable(t, zones)),
    counts: fusion.counts,
  };
}

export function summarizePageEvidence(ev: PageEvidence, now: Date = new Date()): EvidenceSummary {
  const detections: EvidenceSummary["counts"]["detections"] = {};
  let layout = false;
  for (const group of ev.detections) {
    const perClass: Record<string, number> = {};
    for (const d of group.detections) perClass[d.name] = (perClass[d.name] ?? 0) + 1;
    detections[group.modelName] = perClass;
    if (ZONE_MODEL_PATTERN.test(group.modelName) && group.detections.length > 0) layout = true;
  }
  const holesByZone: Partial<Record<ZoneKind, number>> = {};
  for (const h of ev.holes) holesByZone[h.zone] = (holesByZone[h.zone] ?? 0) + 1;
  const holes = [...ev.holes]
    .sort((a, b) => b.cYolo - a.cYolo)
    .slice(0, EVIDENCE_HOLE_CAP)
    .map((h) => ({ bbox: roundBox(h.bbox), conf: round(h.cYolo, 3), zone: h.zone }));
  return {
    v: EVIDENCE_VERSION,
    computedAt: now.toISOString(),
    zonesSource: ev.zones.source,
    channels: { ocr: ev.counts.ocrWords > 0, yoloText: ev.counts.yoloTextBoxes > 0, layout },
    counts: { ...ev.counts, tables: ev.tables.length, detections },
    holesByZone,
    holes,
    holesTruncated: ev.holes.length - holes.length,
    tables: ev.tables.slice(0, EVIDENCE_TABLE_CAP).map((t) => ({
      bbox: roundBox(t.bbox), rows: t.rows, cols: t.cols, cells: t.cells.length, zone: t.zone,
    })),
  };
}

/** getPageEvidence → summarizePageEvidence; null when the page has no OCR (nothing to fuse). */
export function buildEvidenceSummary(input: PageEvidenceInput, now?: Date): EvidenceSummary | null {
  if (!input.textract) return null;
  return summarizePageEvidence(getPageEvidence(input), now);
}

/**
 * Equal apart from `computedAt` — lets writers skip rewriting an unchanged page. Key order is
 * ignored: a value read back from jsonb has Postgres's key order, not the writer's.
 */
export function sameEvidence(a: unknown, b: unknown): boolean {
  if (!isEvidenceSummary(a) || !isEvidenceSummary(b)) return false;
  return canonicalJson({ ...a, computedAt: "" }) === canonicalJson({ ...b, computedAt: "" });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Shallow guard for a stored summary (jsonb, so the shape is not guaranteed). */
export function isEvidenceSummary(value: unknown): value is EvidenceSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.v === EVIDENCE_VERSION && typeof v.computedAt === "string"
    && !!v.counts && typeof v.counts === "object" && Array.isArray(v.holes) && Array.isArray(v.tables);
}

/** The persisted evidence summary of a page, or undefined (none yet, malformed, or another version). */
export function storedPageEvidence(pageIntelligence: unknown): EvidenceSummary | undefined {
  if (!pageIntelligence || typeof pageIntelligence !== "object") return undefined;
  const stored = (pageIntelligence as Record<string, unknown>).evidence;
  return isEvidenceSummary(stored) ? stored : undefined;
}

function toEvidenceTable(t: TextractTable, zones: PageZones): EvidenceTable[] {
  if (!Array.isArray(t?.bbox) || t.bbox.length !== 4) return [];
  const bbox = ltwh2minmax(t.bbox);
  return [{
    bbox,
    rows: t.rowCount ?? 0,
    cols: t.colCount ?? 0,
    cells: (t.cells ?? []).map((c) => ({
      row: c.row, col: c.col, rowSpan: c.rowSpan, colSpan: c.colSpan, text: c.text,
      bbox: ltwh2minmax(c.bbox), confidence: c.confidence,
    })),
    zone: zoneOf(zones, bbox),
  }];
}

function isValidDetection(d: EvidenceDetectionInput): boolean {
  const n = [d.minX, d.minY, d.maxX, d.maxY];
  return n.every((x) => typeof x === "number" && Number.isFinite(x)) && d.maxX > d.minX && d.maxY > d.minY;
}

function round(v: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

function roundBox(b: BboxMinMax): BboxMinMax {
  return [round(b[0], 4), round(b[1], 4), round(b[2], 4), round(b[3], 4)];
}
