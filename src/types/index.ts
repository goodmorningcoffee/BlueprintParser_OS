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
}

// ─── Chat types ──────────────────────────────────────────────

export interface ChatMsg {
  id?: number;
  role: "user" | "assistant";
  content: string;
  model?: string;
}

export type LLMProvider = "groq" | "anthropic" | "openai";

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

export type YoloModel = "medium" | "precise" | "primitive";
export const YOLO_MODELS: YoloModel[] = ["medium", "precise", "primitive"];

export interface YoloDetection {
  class_id: number;
  class_name: string;
  confidence: number;
  bbox: [number, number, number, number];
  bbox_normalized: [number, number, number, number];
}
