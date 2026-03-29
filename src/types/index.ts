import type { InferSelectModel, InferInsertModel } from "drizzle-orm";
import type {
  companies,
  users,
  projects,
  pages,
  annotations,
  chatMessages,
  userApiKeys,
  processingJobs,
  models,
  llmConfigs,
} from "@/lib/db/schema";

// ─── Database row types ──────────────────────────────────────
export type Company = InferSelectModel<typeof companies>;
export type NewCompany = InferInsertModel<typeof companies>;

export type User = InferSelectModel<typeof users>;
export type NewUser = InferInsertModel<typeof users>;

export type Project = InferSelectModel<typeof projects>;
export type NewProject = InferInsertModel<typeof projects>;

export type Page = InferSelectModel<typeof pages>;
export type NewPage = InferInsertModel<typeof pages>;

export type Annotation = InferSelectModel<typeof annotations>;
export type NewAnnotation = InferInsertModel<typeof annotations>;

export type ChatMessage = InferSelectModel<typeof chatMessages>;
export type NewChatMessage = InferInsertModel<typeof chatMessages>;

export type UserApiKey = InferSelectModel<typeof userApiKeys>;
export type ProcessingJob = InferSelectModel<typeof processingJobs>;
export type Model = InferSelectModel<typeof models>;
export type LlmConfig = InferSelectModel<typeof llmConfigs>;

// ─── Bbox types ─────────────────────────────────────────────
// Two bbox conventions used across the codebase:
// - LTWH: Textract OCR words use [left, top, width, height]
// - MinMax: Annotations/YOLO use [minX, minY, maxX, maxY]
// Both normalized 0-1.
export type BboxLTWH = [left: number, top: number, width: number, height: number];
export type BboxMinMax = [minX: number, minY: number, maxX: number, maxY: number];

// ─── Client-side types ───────────────────────────────────────

export interface ClientAnnotation {
  id: number;
  pageNumber: number;
  name: string;
  bbox: [number, number, number, number]; // [minX, minY, maxX, maxY] normalized 0-1
  note: string | null;
  source: string;
  data?: Record<string, unknown> | null;
}

// ─── Takeoff types ──────────────────────────────────────────

export const TAKEOFF_SHAPES = ["circle", "square", "diamond", "triangle", "cross"] as const;
export type TakeoffShape = (typeof TAKEOFF_SHAPES)[number];
export type TakeoffItemShape = TakeoffShape | "polygon";

export type TakeoffTab = "count" | "area";

export type AreaUnit = "ft" | "in" | "m" | "cm";
export type AreaUnitSq = "SF" | "SI" | "SM" | "SC";
export const AREA_UNIT_MAP: Record<AreaUnit, AreaUnitSq> = {
  ft: "SF", in: "SI", m: "SM", cm: "SC",
};

export interface ClientTakeoffItem {
  id: number;
  name: string;
  shape: TakeoffItemShape;
  color: string;
  size: number;
  notes?: string;
  sortOrder: number;
}

export interface CountMarkerData {
  type: "count-marker";
  shape: TakeoffShape;
  color: string;
  takeoffItemId: number;
}

export interface ScaleCalibrationData {
  type: "scale-calibration";
  point1: { x: number; y: number };
  point2: { x: number; y: number };
  realDistance: number;
  unit: AreaUnit;
}

export interface AreaPolygonData {
  type: "area-polygon";
  takeoffItemId: number;
  color: string;
  vertices: { x: number; y: number }[];
  areaSqUnits: number;
  unit: AreaUnitSq;
}

export interface TextractWord {
  text: string;
  confidence: number;
  bbox: [number, number, number, number]; // [left, top, width, height] normalized 0-1
}

export interface TextractLine {
  text: string;
  confidence: number;
  words: TextractWord[];
  bbox: [number, number, number, number];
}

export interface TextractPageData {
  lines: TextractLine[];
  words: TextractWord[];
}

export interface SearchWordMatch {
  text: string;
  bbox: [number, number, number, number]; // [left, top, width, height] normalized 0-1
}

export interface KeynoteData {
  shape: string;
  text: string;
  bbox: [number, number, number, number]; // [left, top, right, bottom] normalized 0-1
  contour?: [number, number][];
}

export interface CsiCode {
  code: string;
  description: string;
  trade: string;
  division: string;
}

export interface PageData {
  pageNumber: number;
  name: string;
  drawingNumber: string | null;
  rawText: string | null;
  keynotes: KeynoteData[];
  csiCodes: CsiCode[];
  textractData: TextractPageData | null;
  textAnnotations: TextAnnotationResult | null;
}

// ─── Text Annotation types ───────────────────────────────────

export type AnnotationCategory =
  | "contact" | "codes" | "csi" | "dimensions" | "equipment"
  | "references" | "trade" | "abbreviation" | "notes" | "rooms";

export type TextAnnotationType =
  // Contact
  | "phone" | "fax" | "address" | "email" | "url" | "zip-code"
  // Codes
  | "csi-code" | "spec-section" | "building-code" | "code-compliance"
  // Dimensions
  | "imperial-dim" | "metric-dim" | "scale" | "slope"
  // Equipment
  | "equipment-tag" | "material-code" | "door-window-tag" | "finish-code" | "panel-circuit"
  // References
  | "sheet-number" | "sheet-ref" | "detail-ref" | "revision" | "action-marker"
  // Trade
  | "structural" | "mechanical" | "electrical" | "plumbing" | "fire-protection"
  // Abbreviation
  | "abbreviation"
  // Notes
  | "general-note" | "typical-marker" | "coordination-note"
  // Rooms
  | "room-number" | "room-name" | "area-designation";

export interface TextAnnotation {
  type: TextAnnotationType;
  category: AnnotationCategory;
  text: string;
  bbox: [number, number, number, number]; // [left, top, width, height] normalized 0-1
  confidence: number;
  wordIndices: number[];
  group?: string;
  note?: string;
  meta?: Record<string, unknown>;
  csiTags?: CsiCode[];  // CSI codes that apply to this annotation (universal tagging)
}

export interface TextAnnotationGroup {
  prefix: string;
  count: number;
  items: TextAnnotation[];
  label: string;
}

export interface TextAnnotationResult {
  annotations: TextAnnotation[];
  groups: TextAnnotationGroup[];
  summary: Record<string, number>;
}

export const TEXT_ANNOTATION_COLORS: Record<AnnotationCategory, string> = {
  contact: "#ef4444",
  codes: "#ec4899",
  csi: "#c084fc",
  dimensions: "#3b82f6",
  equipment: "#eab308",
  references: "#a855f7",
  trade: "#f97316",
  abbreviation: "#f59e0b",
  notes: "#6366f1",
  rooms: "#14b8a6",
};

// ─── Page Intelligence types ────────────────────────────────

export interface PageClassification {
  discipline: string;       // "Architectural", "Electrical", etc.
  disciplinePrefix: string; // "A", "E", "M", etc.
  subType?: string;         // "Floor Plan", "Elevation", "Section", "Detail", "Schedule"
  series?: string;          // "100", "200", "300", etc.
  confidence: number;
}

export interface CrossRef {
  sourceText: string;       // "SEE DETAIL 4/A-501"
  targetDrawing: string;    // "A-501"
  refType: "sheet" | "detail" | "section" | "elevation" | "similar" | "typical" | "refer";
  detail?: string;          // "4" (specific detail number)
  bbox: BboxLTWH;
  confidence: number;
}

export interface NoteBlock {
  title: string;            // "GENERAL NOTES" or auto-detected
  notes: string[];          // ["1. All dimensions...", "2. Contractor shall..."]
  bbox: BboxLTWH;
  noteCount: number;
}

// ─── Text Region types (OCR-based classification) ──────────

export type TextRegionType = "table-like" | "notes-block" | "spec-text" | "key-value" | "paragraph";

export interface TextRegion {
  id: string;
  type: TextRegionType;
  bbox: BboxLTWH;
  confidence: number;
  csiTags?: CsiCode[];
  wordCount: number;
  columnCount?: number;
  rowCount?: number;
  hasNumberedItems?: boolean;
  headerText?: string;
  containedText?: string;
}

export interface HeuristicInference {
  ruleId: string;
  ruleName: string;
  label: string;
  confidence: number;
  evidence: string[];
  bbox?: BboxLTWH;
  csiTags?: CsiCode[];
}

export type ClassifiedTableCategory =
  | "keynote-table" | "material-schedule" | "symbol-legend"
  | "door-schedule" | "finish-schedule" | "general-notes"
  | "spec-text" | "unknown-table";

export interface ClassifiedTable extends TextRegion {
  category: ClassifiedTableCategory;
  evidence: string[];
  pageNumber: number;
  isPageSpecific: boolean;
}

export interface PageIntelligence {
  classification?: PageClassification;
  crossRefs?: CrossRef[];
  noteBlocks?: NoteBlock[];
  textRegions?: TextRegion[];
  heuristicInferences?: HeuristicInference[];
  classifiedTables?: ClassifiedTable[];
}

// ─── Project Intelligence types ─────────────────────────────

export interface DisciplineBreakdown {
  prefix: string;          // "A"
  discipline: string;      // "Architectural"
  count: number;           // 12
  range: string;           // "A-101 to A-501"
  series: Record<string, number>; // { "100": 5, "200": 3, "500": 4 }
}

export interface RefGraphEdge {
  fromPage: string;        // drawing number or page number
  toPage: string;
  refType: string;
  detail?: string;
}

export interface ProjectIntelligence {
  disciplines?: DisciplineBreakdown[];
  refGraph?: { edges: RefGraphEdge[]; hubs: string[]; leaves: string[] };
  csiGraph?: unknown; // CsiNetworkGraph — imported from csi-graph.ts at usage sites
  pageCount?: number;
}

// ─── Chat types ──────────────────────────────────────────────

export interface ChatMsg {
  id?: number;
  role: "user" | "assistant";
  content: string;
  model?: string;
}

export type LLMProvider = "groq" | "anthropic" | "openai" | "custom";

// ─── Shape types ─────────────────────────────────────────────

export const SHAPES = [
  "circle",
  "oval",
  "square",
  "diamond",
  "rectangle",
  "hexagon",
  "triangle",
  "pentagon",
  "pill",
  "half-circle",
] as const;

export type Shape = (typeof SHAPES)[number];

export const SHAPE_COLORS: Record<Shape, string> = {
  circle: "#e6194b",
  oval: "#3cb44b",
  square: "#ffe119",
  diamond: "#0082c8",
  rectangle: "#f58231",
  hexagon: "#911eb4",
  triangle: "#f032e6",
  pentagon: "#d2f53c",
  pill: "#fabebe",
  "half-circle": "#008080",
};

export const TWENTY_COLORS = [
  "#e6194b", "#3cb44b", "#ffe119", "#0082c8", "#f58231",
  "#911eb4", "#46f0f0", "#f032e6", "#d2f53c", "#fabebe",
  "#008080", "#e6beff", "#aa6e28", "#fffac8", "#800000",
  "#aaffc3", "#808000", "#ffd8b1", "#000080", "#808080",
];

// ─── YOLO types ──────────────────────────────────────────────

export interface YoloDetection {
  class_id: number;
  class_name: string;
  confidence: number;
  bbox: [number, number, number, number];
  bbox_normalized: [number, number, number, number];
}

// ─── Model class tagging (spatial intelligence) ─────────────

export type ModelClassType = "spatial" | "countable" | "both";

export interface ModelConfig {
  classes: string[];
  confidence: number;
  iou: number;
  imageSize: number;
  classTypes?: Record<string, ModelClassType>;
  classCsiCodes?: Record<string, string[]>;   // class name -> CSI codes
  classKeywords?: Record<string, string[]>;   // class name -> keywords
}

export interface SpatialRegion {
  className: string;
  displayName: string;
  bbox: [number, number, number, number]; // [minX, minY, maxX, maxY] normalized 0-1
  confidence: number;
  text: string;
}

export interface SpatialMappingResult {
  regions: SpatialRegion[];
  unmappedText: string;
}
