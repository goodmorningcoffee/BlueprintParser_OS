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

export type TakeoffTab = "count" | "area" | "auto-qto";

export type AreaUnit = "ft" | "in" | "m" | "cm";

// ─── Auto-QTO Types ──────────────────────────────────────────

export type QtoWorkflowStep = "pick" | "select-schedule" | "confirm-tags" | "map-tags" | "review" | "done";

export interface QtoWorkflow {
  id: number;
  projectId: number;
  materialType: string;
  materialLabel: string | null;
  step: QtoWorkflowStep;
  schedulePageNumber: number | null;
  yoloModelFilter: string | null;
  yoloClassFilter: string | null;
  tagPattern: string | null;
  parsedSchedule: QtoParsedSchedule | null;
  lineItems: QtoLineItem[] | null;
  userEdits: QtoUserEdits | null;
  exportedAt: string | null;
}

export interface QtoParsedSchedule {
  headers: string[];
  rows: Record<string, string>[];
  tagColumn: string;
  tableName: string;
  scheduleCategory: string;
  sourcePageNumber: number;
}

export interface QtoLineItem {
  tag: string;
  specs: Record<string, string>;
  autoQuantity: number;
  manualQuantity?: number;
  instances: { pageNumber: number; bbox: [number, number, number, number]; confidence: number }[];
  pages: number[];
  csiCodes: string[];
  flags: QtoFlag[];
  notes: string;
}

export type QtoFlag = "not-found" | "extra" | "low-confidence" | "qty-mismatch" | "manual-override";

export interface QtoUserEdits {
  selectedPages?: number[];
  addedInstances: { tag: string; pageNumber: number; bbox: [number, number, number, number] }[];
  removedInstances: { tag: string; pageNumber: number; bbox: [number, number, number, number] }[];
  quantityOverrides: Record<string, number>;
  addedRows: Record<string, string>[];
  deletedTags: string[];
  cellEdits: Record<string, string>;
}
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

export interface TextractCell {
  row: number;          // 1-based row index
  col: number;          // 1-based column index
  rowSpan: number;
  colSpan: number;
  text: string;
  bbox: BboxLTWH;
  confidence: number;
}

export interface TextractTable {
  bbox: BboxLTWH;
  cells: TextractCell[];
  rowCount: number;
  colCount: number;
}

export interface TextractPageData {
  lines: TextractLine[];
  words: TextractWord[];
  tables?: TextractTable[];  // from Textract TABLES feature
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
  parsedRegions?: ParsedRegion[];
  csiSpatialMap?: { pageNumber: number; zones: Array<{ zone: string; divisions: Array<{ division: string; name: string; count: number; codes: string[] }>; totalInstances: number; dominantDivision?: string }>; summary: string } | null;
}

/** Typed data field for annotations (YOLO + user markups) */
export interface AnnotationData {
  modelId?: number;
  modelName?: string;
  classId?: number;
  confidence?: number;
  csiCodes?: string[];
  keywords?: string[];
  type?: "count-marker" | "area-polygon" | "takeoff-scale";
  shape?: TakeoffShape;
  color?: string;
  takeoffItemId?: number;
  vertices?: Array<{ x: number; y: number }>;
  areaSqUnits?: number;
  unit?: string;
  [key: string]: unknown;
}

// ─── Parsed Region types (System 4: structured data extraction) ──

export type ParsedRegionType = "schedule" | "keynote" | "legend" | "notes";

export interface ParsedRegion {
  id: string;
  type: ParsedRegionType;
  category: string;              // "door-schedule", "keynote-table", "symbol-legend", etc.
  bbox: BboxLTWH;               // region location on page
  confidence: number;
  csiTags?: CsiCode[];
  data: ScheduleData | KeynoteData | LegendData | NotesData;
}

export interface ScheduleData {
  headers: string[];
  rows: Record<string, string>[];  // { "TAG": "D-01", "TYPE": "Hollow Metal", "WIDTH": "3'-0\"" }
  tagColumn?: string;              // which column has the item tags
  rowCount: number;
  columnCount: number;
}

export interface KeynoteData {
  keynotes: { key: string; description: string; shapeClass?: string }[];
  isPageSpecific: boolean;
}

export interface LegendData {
  symbols: { yoloClass: string; description: string }[];
}

export interface NotesData {
  title: string;
  notes: string[];
  isBoilerplate?: boolean[];
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
  summaries?: ProjectSummaries;
}

// ─── Project Summaries (chunking support) ────────────────────
// Pre-computed indexes that power sidebar filters, panel lists, and
// annotation summaries without loading all page data into the browser.
// Computed at end of processing pipeline and after YOLO load.

export interface ProjectSummaries {
  // Catalog: schedule/table/keynote locations across all pages
  schedules: ScheduleSummaryEntry[];
  parsedTables: ParsedTableSummaryEntry[];
  keynoteTablePages: { pageNum: number; confidence: number }[];

  // Page indexes: which pages contain each filter value
  csiPageIndex: Record<string, number[]>;           // "08 11 16" -> [3, 7, 12]
  tradePageIndex: Record<string, number[]>;          // "Openings" -> [3, 7, 12]
  keynotePageIndex: Record<string, number[]>;        // "circle:T-01" -> [5, 8]
  textAnnotationPageIndex: Record<string, number[]>; // "phone:555-1234" -> [1, 3]
  pageClassifications: Record<number, { discipline: string; prefix: string }>;

  // Annotation summary: model names, category counts, per-page counts
  annotationSummary: AnnotationSummary;

  // Takeoff totals: aggregated counts/areas per takeoff item
  takeoffTotals: Record<number, TakeoffItemTotal>; // takeoffItemId -> totals

  // General
  allTrades: string[];
  allCsiCodes: { code: string; description: string }[];
}

export interface ScheduleSummaryEntry {
  pageNum: number;
  category: string;      // "door-schedule", "finish-schedule", etc.
  name: string;          // page name or classified table header
  confidence: number;
}

export interface ParsedTableSummaryEntry {
  pageNum: number;
  name: string;
  category: string;
  rowCount: number;
  colCount: number;
}

export interface AnnotationSummary {
  modelNames: string[];
  categoryCounts: Record<string, { count: number; pages: number[] }>;
  pageAnnotationCounts: Record<number, { yolo: number; user: number; takeoff: number }>;
}

export interface TakeoffItemTotal {
  count: number;
  totalArea: number;
  pages: number[];
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

// ─── YOLO Tag types ─────────────────────────────────────────

export interface YoloTag {
  id: string;
  name: string;                        // user-editable display name
  tagText: string;                     // the OCR text (e.g., "D-01")
  yoloClass: string;                   // YOLO class name, "" for free-floating
  yoloModel: string;                   // YOLO model name, "" for free-floating
  source: "keynote" | "schedule" | "manual";
  scope: "page" | "project";
  pageNumber?: number;                 // for page-scoped tags
  description?: string;                // from keynote/schedule parsing
  color?: string;                      // user-customizable
  csiCodes?: string[];                 // CSI codes inherited from parsed region (e.g., ["08 11 13"])
  instances: YoloTagInstance[];
}

export interface YoloTagInstance {
  pageNumber: number;
  annotationId: number;                // -1 for free-floating
  bbox: [number, number, number, number]; // [minX, minY, maxX, maxY]
  confidence: number;
}

// ─── Template Matching Engine types ─────────────────────────

export type TemplateMatchMode = "search" | "match_one" | "batch";
export type TemplateMatchMethod = "template" | "sift";

export interface TemplateMatchOptions {
  mode: TemplateMatchMode;
  templatePath: string;
  targetPaths: string[];
  confidenceThreshold?: number;     // default 0.75
  multiScale?: boolean;             // default true
  scales?: number[];                // default [0.9, 0.95, 1.0, 1.05, 1.1]
  useSiftFallback?: boolean;        // default true
  siftFallbackThreshold?: number;   // trigger SIFT if < N template hits, default 3
  nmsIouThreshold?: number;         // default 0.3
  maxMatchesPerPage?: number;       // default 100
}

export interface TemplateMatchHit {
  targetIndex: number;
  bbox: BboxLTWH;                   // normalized [x, y, w, h] 0-1
  confidence: number;
  method: TemplateMatchMethod;
  scale?: number;
}

export interface TemplateMatchProgress {
  type: "progress";
  targetIndex: number;
  targetPath: string;
  matches: number;
}

export interface TemplateMatchResult {
  totalMatches: number;
  results: TemplateMatchHit[];
}

// ─── Symbol Search types (UI layer on top of engine) ────────

export interface SymbolSearchMatch {
  id: string;
  pageNumber: number;
  bbox: BboxLTWH;                   // normalized [x, y, w, h] 0-1
  confidence: number;
  method: TemplateMatchMethod;
}

export interface SymbolSearchResult {
  templateBbox: BboxLTWH;
  sourcePageNumber: number;
  matches: SymbolSearchMatch[];
  totalMatches: number;
  pagesWithMatches: number[];
  searchedAt: string;               // ISO timestamp
}
