/**
 * classifier-engine/catalog.ts — the SIGNAL CATALOG the builder UI edits against: every signal type
 * the engine evaluates (signals.ts) with its parameter schema, plus the fixed choice lists (scopes,
 * disciplines, structure features, zones, page kinds, candidate sources). The YOLO half (models +
 * their class lists) is per company and comes from the server (services/classifier-builder.ts);
 * this file is pure and client-safe. Adding a spec type to types.ts means adding a row here, or
 * the UI shows it as "unknown" and refuses to create one.
 */

import { CHANNEL_KINDS } from "@/lib/pdf-channels/types";
import type { RegionV2Signals } from "@/lib/region-classifier-v2/types";
import type { CandidateSource, SignalScope, SignalSpec } from "./types";

export const SIGNAL_SCOPES: readonly SignalScope[] = ["box", "header", "columns", "body", "above", "page", "titleBlock", "sheetTitle"];

export const SCOPE_HELP: Record<SignalScope, string> = {
  box: "every OCR word inside the candidate box",
  header: "the derived title line (top band, or the line just above)",
  columns: "the column-header rows under the title",
  body: "the box minus header and columns",
  above: "lines just above the box (titles outside the detector box)",
  page: "the whole page",
  titleBlock: "OCR inside the detected title block",
  sheetTitle: "the sheet title parsed from the title block",
};

/** Sheet-number prefixes the `sheet` signal compares against (page-utils extractDisciplinePrefix). */
export const DISCIPLINES: ReadonlyArray<{ id: string; name: string }> = [
  { id: "A", name: "Architectural" }, { id: "S", name: "Structural" }, { id: "M", name: "Mechanical" }, { id: "E", name: "Electrical" },
  { id: "P", name: "Plumbing" }, { id: "FP", name: "Fire protection" }, { id: "FA", name: "Fire alarm" }, { id: "SP", name: "Sprinkler" },
  { id: "C", name: "Civil" }, { id: "L", name: "Landscape" }, { id: "G", name: "General" }, { id: "T", name: "Title / cover" },
  { id: "D", name: "Demolition" }, { id: "I", name: "Interior" }, { id: "ID", name: "Interior design" }, { id: "Q", name: "Equipment" },
];

/** Region v2 structure features a `structure` signal may read (types.ts RegionV2Signals + structureScore). */
export const STRUCTURE_FEATURES: ReadonlyArray<{ id: keyof RegionV2Signals | "structureScore"; name: string; kind: "score" | "count" | "ratio" | "flag" }> = [
  { id: "structureScore", name: "region v2 structure score (0–1)", kind: "score" },
  { id: "detConf", name: "detector confidence", kind: "ratio" },
  { id: "areaCover", name: "share covered by grid / area boxes", kind: "ratio" },
  { id: "textLines", name: "yolo_text boxes inside", kind: "count" },
  { id: "textRows", name: "text rows", kind: "count" },
  { id: "textCols", name: "aligned text columns", kind: "count" },
  { id: "words", name: "OCR words inside", kind: "count" },
  { id: "textractTable", name: "Textract table containment", kind: "ratio" },
  { id: "tagShapes", name: "tag shapes inside", kind: "count" },
  { id: "shapes", name: "legend / keynote shapes inside", kind: "count" },
  { id: "legendColumn", name: "≥ 3 shapes in the left column", kind: "flag" },
  { id: "keyShapes", name: "≥ 2 key shapes", kind: "flag" },
  { id: "scheduleWord", name: "SCHEDULE / SCHED word inside", kind: "flag" },
  { id: "csiCodes", name: "CSI trigger marks inside", kind: "count" },
];

export const SHAPE_LABELS: readonly string[] = ["circle", "hexagon", "diamond", "square", "triangle", "arch_sheet_circle", "oval", "pill", "rectangle", "dot_small_circle"];
export const ZONES: ReadonlyArray<"titleBlock" | "drawing" | "margin"> = ["titleBlock", "drawing", "margin"];
export const PAGE_KINDS = CHANNEL_KINDS;
export const YOLO_WHERE: ReadonlyArray<Extract<SignalSpec, { type: "yolo" }>["where"]> = ["inside", "overlap", "page", "near"];
export const YOLO_MEASURES: ReadonlyArray<Extract<SignalSpec, { type: "yolo" }>["measure"]> = ["presence", "count", "maxConfidence", "cover"];
export const CSI_MEASURES: ReadonlyArray<"share" | "count"> = ["share", "count"];
export const CANDIDATE_SOURCE_TYPES: readonly CandidateSource["type"][] = ["regions-v2", "yolo", "textract-tables", "parsed-regions"];

export type ParamKind = "scope" | "terms" | "number" | "stringList" | "disciplineList" | "divisionList" | "sectionList" | "yoloClasses" | "yoloModel" | "enum" | "structureFeature" | "shapeList" | "pageKindList" | "regex";

export interface ParamSchema {
  key: string;
  label: string;
  kind: ParamKind;
  required?: boolean;
  /** For `enum`. */
  options?: readonly string[];
  /** For `number`. */
  min?: number;
  max?: number;
  step?: number;
  help?: string;
}

export interface SignalTypeSchema {
  type: SignalSpec["type"];
  name: string;
  /** What value in [0, 1] the signal yields. */
  valueHelp: string;
  params: ParamSchema[];
  /** A fresh spec of this type for "add signal". */
  blank: SignalSpec;
}

export const SIGNAL_TYPES: readonly SignalTypeSchema[] = [
  {
    type: "words", name: "Words", valueHelp: "1 − exp(−Σ termWeight × √min(3, count) / saturation) over the scope's words",
    params: [
      { key: "where", label: "Scope", kind: "scope", required: true },
      { key: "terms", label: "Terms (upper-case word or phrase → weight)", kind: "terms", required: true },
      { key: "saturation", label: "Saturation", kind: "number", min: 0.1, max: 20, step: 0.1, help: "larger = needs more hits to reach 1" },
    ],
    blank: { type: "words", where: "box", terms: {}, saturation: 1 },
  },
  {
    type: "csi", name: "CSI codes", valueHelp: "share (matching / all codes tagged on the scope) or count (saturates at 3)",
    params: [
      { key: "where", label: "Scope", kind: "enum", options: ["box", "page"], required: true },
      { key: "divisions", label: "Divisions", kind: "divisionList", help: "two-digit MasterFormat divisions" },
      { key: "sectionPrefixes", label: "Section prefixes", kind: "sectionList", help: "e.g. 08 71" },
      { key: "measure", label: "Measure", kind: "enum", options: CSI_MEASURES, required: true },
      { key: "minCodes", label: "Min codes", kind: "number", min: 1, max: 50, step: 1 },
    ],
    blank: { type: "csi", where: "box", divisions: [], measure: "share", minCodes: 1 },
  },
  {
    type: "sheet", name: "Sheet number", valueHelp: "1 when the sheet's discipline prefix / number pattern matches",
    params: [
      { key: "disciplines", label: "Disciplines", kind: "disciplineList" },
      { key: "numberPattern", label: "Sheet number regex", kind: "regex" },
    ],
    blank: { type: "sheet", disciplines: [] },
  },
  {
    type: "yolo", name: "YOLO detections", valueHelp: "presence 0/1, count (saturates at 3), max confidence, or covered share of the box",
    params: [
      { key: "model", label: "Model", kind: "yoloModel", help: "blank = any model" },
      { key: "classes", label: "Classes", kind: "yoloClasses", required: true },
      { key: "where", label: "Where", kind: "enum", options: YOLO_WHERE, required: true },
      { key: "measure", label: "Measure", kind: "enum", options: YOLO_MEASURES, required: true },
      { key: "minConfidence", label: "Min confidence", kind: "number", min: 0, max: 1, step: 0.05 },
    ],
    blank: { type: "yolo", where: "inside", classes: [], measure: "presence" },
  },
  {
    type: "structure", name: "Region v2 structure", valueHelp: "the feature mapped to 0–1 by min/max, or divided by scale",
    params: [
      { key: "feature", label: "Feature", kind: "structureFeature", required: true },
      { key: "min", label: "Min (→ 0)", kind: "number", step: 0.1 },
      { key: "max", label: "Max (→ 1)", kind: "number", step: 0.1 },
      { key: "scale", label: "Scale (value / scale)", kind: "number", min: 0.1, step: 0.5 },
    ],
    blank: { type: "structure", feature: "structureScore" },
  },
  {
    type: "textract-table", name: "Textract table", valueHelp: "containment of the best coinciding Textract table (0 below the minimum)",
    params: [{ key: "minContainment", label: "Min containment", kind: "number", min: 0, max: 1, step: 0.05 }],
    blank: { type: "textract-table", minContainment: 0.5 },
  },
  {
    type: "shapes", name: "Shapes", valueHelp: "shape-parse / yolo_primitive shapes inside (count / min, capped at 1)",
    params: [
      { key: "shapes", label: "Shapes", kind: "shapeList", required: true },
      { key: "where", label: "Where", kind: "enum", options: ["inside", "leftColumn"], required: true },
      { key: "min", label: "Count for full value", kind: "number", min: 1, max: 50, step: 1 },
    ],
    blank: { type: "shapes", shapes: [], where: "inside", min: 3 },
  },
  {
    type: "zone", name: "Page zone", valueHelp: "1 when the box sits inside the zone (title block / drawing / page margin)",
    params: [
      { key: "zone", label: "Zone", kind: "enum", options: ZONES, required: true },
      { key: "minContainment", label: "Min containment", kind: "number", min: 0, max: 1, step: 0.05 },
    ],
    blank: { type: "zone", zone: "titleBlock" },
  },
  {
    type: "channel", name: "Page kind (PDF channels)", valueHelp: "1 when the page's channel census kind is listed",
    params: [{ key: "pageKinds", label: "Page kinds", kind: "pageKindList", required: true }],
    blank: { type: "channel", pageKinds: [] },
  },
];

export const signalTypeSchema = (type: string): SignalTypeSchema | undefined => SIGNAL_TYPES.find((t) => t.type === type);

/** One YOLO model as the catalog lists it (own or shared with the company). */
export interface CatalogModel { id: number; name: string; classes: string[]; shared: boolean }

export interface SignalCatalog {
  models: CatalogModel[];
  signalTypes: readonly SignalTypeSchema[];
  scopes: readonly SignalScope[];
  disciplines: typeof DISCIPLINES;
  structureFeatures: typeof STRUCTURE_FEATURES;
  shapes: readonly string[];
  pageKinds: readonly string[];
  candidateTypes: readonly CandidateSource["type"][];
}

/** The static half of the catalog; the server adds `models`. */
export function staticCatalog(models: CatalogModel[] = []): SignalCatalog {
  return {
    models, signalTypes: SIGNAL_TYPES, scopes: SIGNAL_SCOPES, disciplines: DISCIPLINES, structureFeatures: STRUCTURE_FEATURES,
    shapes: SHAPE_LABELS, pageKinds: PAGE_KINDS, candidateTypes: CANDIDATE_SOURCE_TYPES,
  };
}
