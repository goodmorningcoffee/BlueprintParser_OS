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
// Type-only import — ScoredMatch lives in tag-mapping but is a structural
// superset of YoloTagInstance, so we expose it on YoloTag.instances for
// tier badges + audit review. Type-only import avoids runtime cycles.
import type { ScoredMatch } from "@/lib/tag-mapping/types";

// ─── Multi-file upload ───────────────────────────────────────
// One staged upload per entry; persisted on projects.stagingManifest
// (JSONB) and consumed by processing.ts pre-stage concat.
export interface StagingFile {
  filename: string;
  stagingKey: string;
  size: number;
}

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

export type AnnotationData = Record<string, unknown> & {
  // YOLO fields
  modelId?: number;
  modelName?: string;
  classId?: number;
  confidence?: number;
  csiCodes?: string[];
  keywords?: string[];
  // Takeoff fields
  type?: string;
  takeoffItemId?: number;
  shape?: string;
  color?: string;
  size?: number;
  vertices?: { x: number; y: number }[];
  areaSqUnits?: number;
  unit?: string;
};

export interface ClientAnnotation {
  id: number;
  pageNumber: number;
  name: string;
  bbox: [number, number, number, number]; // [minX, minY, maxX, maxY] normalized 0-1
  note: string | null;
  source: "user" | "yolo" | "takeoff" | "takeoff-scale" | "shape-parse" | "symbol-search";
  data?: AnnotationData | null;
}

// TextractPageData is defined below (line ~215) with full TextractWord/TextractLine types

// ─── Takeoff types ──────────────────────────────────────────

export const TAKEOFF_SHAPES = ["circle", "square", "diamond", "triangle", "cross"] as const;
export type TakeoffShape = (typeof TAKEOFF_SHAPES)[number];
export type TakeoffItemShape = TakeoffShape | "polygon" | "linear";

export type TakeoffTab = "all" | "count" | "area" | "linear" | "auto-qto";

export type AreaUnit = "ft" | "in" | "m" | "cm";

export interface LinearPolylineData {
  type: "linear-polyline";
  takeoffItemId: number;
  color: string;
  vertices: { x: number; y: number }[];
  totalLength: number;
  unit: string;
  segmentLengths: number[];
}

// ─── Auto-QTO Types ──────────────────────────────────────────

export type QtoWorkflowStep = "pick" | "select-schedule" | "confirm-tags" | "map-tags" | "review" | "done";

/**
 * Discriminator for the 5 countable item types (SHIP 2). Determines which
 * engine dispatch path findItemOccurrences takes. See
 * memory/project_qto_taxonomy.md and src/lib/yolo-tag-engine.ts.
 */
export type QtoItemType =
  | "yolo-only"                    // Type 1 — count all shapes of a class, no text
  | "text-only"                    // Type 2 — pure free-floating text match
  | "yolo-with-inner-text"         // Type 3 — text inside a shape (+ Type 5 fallback)
  | "yolo-object-with-tag-shape"   // Type 4 — object tagged by a separate tag-shape
  | "yolo-object-with-nearby-text"; // Type 5 — object + nearby floating text (standalone)

export interface QtoWorkflow {
  id: number;
  projectId: number;
  materialType: string;
  materialLabel: string | null;
  step: QtoWorkflowStep;
  schedulePageNumber: number | null;
  yoloClassFilter: string | null;
  /** SHIP 2: which of the 5 item types this workflow is counting. Defaults
   *  to "yolo-with-inner-text" (backward compat — matches pre-SHIP-2 behavior). */
  itemType: QtoItemType;
  /** SHIP 2: for Type 4 (yolo-object-with-tag-shape), the class of the
   *  separate tag shape (e.g. "circle"). Null for other item types. */
  tagShapeClass: string | null;
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
  instances: {
    pageNumber: number;
    bbox: [number, number, number, number];
    confidence: number;
    /** Phase 2: optional tier + dropReason preserved for per-instance audit
     *  review in the ReviewStep expander. Absent on pre-Phase-2 data. */
    confidenceTier?: "high" | "medium" | "low";
    dropReason?: "outside_scope" | "pattern_mismatch" | "inside_title_block" | "inside_table" | "outside_drawings";
  }[];
  pages: number[];
  flags: QtoFlag[];
  notes: string;
}

export type QtoFlag =
  | "not-found"
  | "extra"
  | "low-confidence"
  | "medium-confidence"
  | "qty-mismatch"
  | "manual-override";

/** SHIP 2: trimmed to only fields the UI actually populates. Previously had
 *  5 structured-but-unused fields (addedInstances, removedInstances, addedRows,
 *  deletedTags, cellEdits) — all removed. */
export interface QtoUserEdits {
  selectedPages?: number[];
  quantityOverrides: Record<string, number>;
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
  groupId?: number | null;
}

export type TakeoffGroupKind = "count" | "area" | "linear";

export interface TakeoffGroup {
  id: number;
  name: string;
  kind: TakeoffGroupKind;
  color: string | null;
  csiCode: string | null;
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
  /** Inner holes (e.g., courtyards inside a U-shaped hallway). Optional for
   *  back-compat with existing annotations created before hole support. When
   *  present, rendered via ctx.fill("evenodd") as cutouts and excluded from
   *  hit tests so clicks on the hole region don't select the polygon. */
  holes?: { vertices: { x: number; y: number }[] }[];
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

/** Detected keynote shapes on the canvas (circles, diamonds with text) */
export interface KeynoteShapeData {
  shape: string;
  text: string;
  bbox: [number, number, number, number]; // [left, top, right, bottom] normalized 0-1
  contour?: [number, number][];
}

/** A specific word/phrase on the page that caused a CSI code to be detected. */
export interface CsiCodeTrigger {
  text: string;        // matched word/phrase (lowercased, as it appeared)
  bbox: BboxLTWH;      // normalized 0-1 bbox on the full page
  tier: 1 | 2 | 3;     // 1=exact phrase, 2=bag-of-words, 3=anchor word
}

export interface CsiCode {
  code: string;
  description: string;
  trade: string;
  division: string;
  /** Words/phrases on the page that triggered this code's detection.
   *  Optional for backward compat with cached data from before triggers existed. */
  triggers?: CsiCodeTrigger[];
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

export type TextRegionType =
  | "notes-numbered"        // vertical list of N. or (N) keyed paragraphs
  | "notes-key-value"       // multi-column KEY → VALUE legends / abbreviations
  | "spec-dense-columns"    // narrow multi-column flowing spec text
  | "schedule-table"        // 3+ structured columns
  | "paragraph"             // free-form prose
  | "unknown";              // low-confidence fallback

/** Legacy type strings present on pages processed before 2026-04-24.
 *  Consumers that read `pageIntelligence.textRegions` from DB should route
 *  through `migrateTextRegion` from `text-region-migrate.ts` so legacy data
 *  transparently upgrades at read time. */
export type LegacyTextRegionType =
  | "table-like" | "notes-block" | "spec-text" | "key-value";

export interface TextRegion {
  id: string;
  type: TextRegionType;
  bbox: BboxLTWH;
  confidence: number;
  csiTags?: CsiCode[];
  wordCount: number;
  lineCount?: number;
  columnCount?: number;
  rowCount?: number;
  hasNumberedItems?: boolean;
  headerText?: string;
  /** Hierarchical tier matches from `note-keyword-tiers.ts`. Metadata only —
   *  does NOT override `type`. A `schedule-table` can have `tier1: "LEGEND"`. */
  classifiedLabels?: {
    tier1?: string;
    tier2?: string;
    trade?: string;
  };
  /** Optional structured extraction for K:V / numbered-list patterns. */
  grid?: {
    headers: string[];
    rows: Record<string, string>[];
    rowBoundaries?: number[];
    colBoundaries?: number[];
  };
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

// ─── Composite Region Classifier types (Layer 1 of QTO rebuild) ──
//
// Distinct from ClassifiedTable, which is OCR-keyword-based and produces
// semantic categories (door-schedule, finish-schedule, ...). ClassifiedRegion
// is YOLO + OCR signal fusion and produces three spatial kinds used for
// takeoff exclusion/inclusion zones:
//   - tables / title_blocks      → EXCLUSION zones (drop matches inside these)
//   - drawings                   → INCLUSION zone  (keep matches inside these)
//
// Produced by `classifyPageRegions` in `src/lib/composite-classifier.ts`,
// stored in `pageIntelligence.classifiedRegions`, consumed by
// `applyExclusionFilter` in `src/lib/yolo-tag-engine.ts`.

export type ClassifiedRegionKind = "table" | "title_block" | "drawings";

export type ClassifiedRegionSource =
  | "yolo:tables"          // yolo_medium tables class
  | "yolo:title_block"     // yolo_medium title_block class
  | "yolo:drawings"        // yolo_medium OR yolo_primitive drawings class
  | "yolo:grid"            // yolo_primitive grid — confirmation only
  | "yolo:vertical_area"   // yolo_primitive — confirmation only
  | "yolo:horizontal_area" // yolo_primitive — confirmation only
  | "ocr:header_keyword"   // SCHEDULE/LEGEND/NOTES header match
  | "pageIntel:classifiedTables" // legacy OCR-based classifier agreement
  | "parsedRegions";       // user-saved schedule region

export interface ClassifiedRegion {
  kind: ClassifiedRegionKind;
  bbox: BboxMinMax;           // normalized [0,1] page coords
  confidence: number;          // 0-1, max across merged sources
  sources: ClassifiedRegionSource[];
  headerText?: string;         // if sourced from OCR header keyword
  pageNumber: number;
}

export interface ClassifiedPageRegions {
  tables: ClassifiedRegion[];
  titleBlocks: ClassifiedRegion[];
  drawings: ClassifiedRegion[];
}

export interface PageIntelligence {
  classification?: PageClassification;
  crossRefs?: CrossRef[];
  noteBlocks?: NoteBlock[];
  textRegions?: TextRegion[];
  heuristicInferences?: HeuristicInference[];
  classifiedTables?: ClassifiedTable[];
  /** QTO Layer 1: YOLO+OCR region classifier output, populated by the
   *  post-YOLO reclassification hook in /api/yolo/load. Consumed by the
   *  exclusion filter in map-tags-batch. Absent on pages before YOLO runs. */
  classifiedRegions?: ClassifiedPageRegions;
  parsedRegions?: ParsedRegion[];
  csiSpatialMap?: { pageNumber: number; zones: Array<{ zone: string; divisions: Array<{ division: string; name: string; count: number; codes: string[] }>; totalInstances: number; dominantDivision?: string }>; summary: string } | null;
}

// AnnotationData is defined above (near ClientAnnotation)

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
  /** Normalized X coords of column edges — N+1 values for N columns */
  colBoundaries?: number[];
  /** Normalized Y coords of row edges — M+1 values for M visible rows (header + data) */
  rowBoundaries?: number[];
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
  yoloTags?: YoloTag[];
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

// ─── Annotation Groups ──────────────────────────────────────
// User-created groupings over annotations. M:N with annotations via
// annotation_group_members junction. See migration 0025 + the Group
// tool in ViewerToolbar. Groups are project-scoped and can span pages.

export interface AnnotationGroup {
  id: number;
  projectId: number;
  name: string;
  csiCode: string | null;
  notes: string | null;
  color: string | null;
  isActive: boolean;
  createdBy: number | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface AnnotationGroupMembership {
  annotationId: number;
  groupId: number;
}

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
  maxDetections?: number;
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
  /** Scored matches for this tag across the project. ScoredMatch is a
   *  structural superset of YoloTagInstance — pre-Phase-2 data (and
   *  legacy callers returning YoloTagInstance[] via shims) are still
   *  assignable. UI code can read optional confidenceTier / dropReason /
   *  signals / score fields for tier badges and audit review. */
  instances: ScoredMatch[];
  /** Optional scope + strictness snapshot from the Map Tags call that
   *  produced this tag. Captured so TagBrowseBar can explain why the
   *  browse surface is showing fewer instances than the raw page count
   *  would suggest — "strictness=strict dropped 12 low-tier matches",
   *  "scope: A-* only", etc. Absent on legacy / pre-2026-04-21 tags. */
  mapScope?: {
    drawingNumberPrefixes?: string[];
    strictness?: "strict" | "balanced" | "lenient";
  };
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
