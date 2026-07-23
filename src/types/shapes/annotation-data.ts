// [refactor jul23 P4.1 U0] annotations.data blob schemas + classifier.
//
// Eight blob shapes land in the `annotations.data` jsonb column. Every schema is
// `.loose()` (spec Verdict 1 / RD-A): the P3 sentinel freeze
// (annotationMarkupEditCacheFreeze.test.ts:29,63,123) pins that an unknown
// `sentinel` key round-trips unchanged through edit cycles — a `.strict()` here
// would strip/reject legacy keys, "the one unforgivable class" (data loss).
//
// U0 is schemas + classifier + types ONLY (RD-K): NO upgrade functions, NO
// wiring, NO source edits. `v` (spec canonical, RD-G) is an in-blob sibling
// version tag: absent ⇒ v0/legacy; new writes stamp v:1. Field optionality is
// decided from what the READ side must tolerate (legacy rows), NOT just writer
// behavior (RD-I) — annotated per field below where they differ.
import { z } from "zod";
import {
  zColor,
  zFiniteNonNegative,
  zNormalizedPoint,
  zPositiveSafeInteger,
  zTakeoffShape,
  zAreaUnit,
  zAreaUnitSq,
} from "./primitives";
import { zCsiCodeStringList } from "./csi";

/** Canonical in-blob version (spec canonical `v`, RD-G). Absent ⇒ v0/legacy. */
export const ANNOTATION_DATA_VERSION = 1 as const;

/** Sibling version tag mixed into every blob. absent = legacy; v:1 = new writes. */
const zVersionTag = {
  v: z.literal(ANNOTATION_DATA_VERSION).optional(),
};

/**
 * CSI auto-enrichment extension — mixed into ALL 8 blobs. mergeAutoCsi
 * (annotations.ts:79-97) can rewrite `data.csiCodes` on ANY create, and
 * reprocess-csi.ts does `data || {csiCodes,keywords}::jsonb` — so any blob may
 * grow these two keys. Typed OPTIONAL (read-side tolerance): even where a writer
 * always emits csiCodes/keywords (e.g. yolo), optional is a safe superset that
 * also tolerates rows written before enrichment (RD-I).
 */
const zCsiExtension = {
  csiCodes: zCsiCodeStringList.optional(),
  keywords: z.array(z.string()).optional(),
};

// ─── The 8 blob schemas ──────────────────────────────────────

/**
 * YOLO detection (server writer yolo.ts:583-590). All 6 fields ALWAYS present at
 * write (recon serverBlobs yolo). csiCodes/keywords typed via zCsiExtension
 * (optional superset) though yolo always writes them (RD-I read-tolerance).
 */
export const zYoloDetectionData = z
  .object({
    modelId: zPositiveSafeInteger,
    modelName: z.string(),
    classId: z.number().int().nonnegative(),
    confidence: z.number().min(0).max(1),
    ...zCsiExtension,
    ...zVersionTag,
  })
  .loose();
export type YoloDetectionData = z.infer<typeof zYoloDetectionData>;

/**
 * shape-parse (server processing.ts:504 / reprocess.ts:443,479; client
 * DetectionPanel.tsx:951,1060). Server always defaults `contour` to [] so it is
 * always present at SERVER write, but client writers omit it when the keynote
 * lacks it (JSON drops undefined) and KeynoteShapeData types it optional
 * (types/index.ts:327) — so `contour` is typed OPTIONAL here for read-tolerance
 * of client-written rows (RD-I).
 */
export const zShapeParseData = z
  .object({
    modelName: z.literal("shape-parse"),
    shapeType: z.string(),
    text: z.string(),
    contour: z.array(z.tuple([z.number(), z.number()])).optional(),
    confidence: z.number(),
    ...zCsiExtension,
    ...zVersionTag,
  })
  .loose();
export type ShapeParseData = z.infer<typeof zShapeParseData>;

/**
 * symbol-search (client SymbolSearchPanel.tsx:837-843). `templateSourcePage` is
 * optional-chained at the writer (symbolSearchResults?.sourcePageNumber → may be
 * undefined → JSON-dropped), so typed optional (RD-I).
 */
export const zSymbolSearchData = z
  .object({
    modelName: z.literal("symbol-search"),
    method: z.string(),
    confidence: z.number(),
    scale: z.number(),
    templateSourcePage: z.number().int().optional(),
    ...zCsiExtension,
    ...zVersionTag,
  })
  .loose();
export type SymbolSearchData = z.infer<typeof zSymbolSearchData>;

/** count-marker (client takeoffCount.ts:87-92; typed `: CountMarkerData`). */
export const zCountMarkerData = z
  .object({
    type: z.literal("count-marker"),
    shape: zTakeoffShape,
    color: zColor,
    takeoffItemId: zPositiveSafeInteger,
    ...zCsiExtension,
    ...zVersionTag,
  })
  .loose();
export type CountMarkerData = z.infer<typeof zCountMarkerData>;

/**
 * area-polygon (client AO:649/:729, useAnnotations:557, splitAcceptance:223;
 * server split halves annotations.ts:485-502). `holes` is conditional (only
 * bucket-fill / assign-dialog paths emit it) → optional. csiCodes/keywords are
 * site-exclusive (only the split path copies them from the parent) → optional
 * via zCsiExtension. Documented SUPERSET of zSplitAnnotationResponseData: it adds
 * `holes` and drops the split's `vertices.max(N+2)` cap — keep the split schema
 * authoritative for the split RPC; this is the general read-side shape.
 */
export const zAreaPolygonData = z
  .object({
    type: z.literal("area-polygon"),
    takeoffItemId: zPositiveSafeInteger,
    color: zColor,
    vertices: z.array(zNormalizedPoint).min(3),
    holes: z
      .array(z.object({ vertices: z.array(zNormalizedPoint).min(3) }).loose())
      .optional(),
    areaSqUnits: zFiniteNonNegative,
    unit: zAreaUnitSq, // SF/SI/SM/SC — squared unit (contrast scale-calibration)
    ...zCsiExtension,
    ...zVersionTag,
  })
  .loose();
export type AreaPolygonData = z.infer<typeof zAreaPolygonData>;

/** linear-polyline (client AO:827-835; typed `: LinearPolylineData`). `unit` is
 *  plain string per the hand-written type (types/index.ts:133), NOT the squared
 *  enum. vertices min(2) (a line needs ≥2 points). */
export const zLinearPolylineData = z
  .object({
    type: z.literal("linear-polyline"),
    takeoffItemId: zPositiveSafeInteger,
    color: zColor,
    vertices: z.array(zNormalizedPoint).min(2),
    totalLength: zFiniteNonNegative,
    unit: z.string(),
    segmentLengths: z.array(zFiniteNonNegative),
    ...zCsiExtension,
    ...zVersionTag,
  })
  .loose();
export type LinearPolylineData = z.infer<typeof zLinearPolylineData>;

/**
 * scale-calibration (client CalibrationInput.tsx:65-71; the U1 target). `unit` is
 * zAreaUnit (ft/in/m/cm) — NOT the squared zAreaUnitSq that area/linear-area use.
 * NOTE: extract §1 table omitted zCsiExtension here, but the prose ("required on
 * ALL 8") and defensiveness win — it is harmless because optional, and calibration
 * never actually gets csiCodes (mergeAutoCsi no-ops on null note, recon HOP 5).
 */
export const zScaleCalibrationData = z
  .object({
    type: z.literal("scale-calibration"),
    point1: zNormalizedPoint,
    point2: zNormalizedPoint,
    realDistance: z.number().finite().positive(),
    unit: zAreaUnit,
    ...zCsiExtension,
    ...zVersionTag,
  })
  .loose();
export type ScaleCalibrationData = z.infer<typeof zScaleCalibrationData>;

/**
 * empty-markup — the literal `{}` LLM-created blob (llm/tools.ts:578). No owned
 * keys; only the optional csi-extension + version. Because it is all-optional and
 * `.loose()`, it matches ANY object — which is exactly why the registry must
 * ship a CLASSIFIER (RD-J), not rely on the bare union to attribute a shape.
 */
export const zEmptyMarkupData = z
  .object({
    ...zCsiExtension,
    ...zVersionTag,
  })
  .loose();
export type EmptyMarkupData = z.infer<typeof zEmptyMarkupData>;

// ─── Union + fallback ────────────────────────────────────────
// z.union (NOT discriminatedUnion): discrimination is two-keyed and irregular
// (`type` literal OR `modelName` literal OR modelId+classId) — no single shared
// discriminant key, so discriminatedUnion cannot apply (spec lines 18-20).

/** Legacy / arbitrary passthrough — any object parses (reads never throw). */
export const zUnknownAnnotationData = z.record(z.string(), z.unknown());

/** The 8 recognized shapes. empty-markup ordered LAST (it matches any object). */
export const zRecognizedAnnotationData = z.union([
  zYoloDetectionData,
  zShapeParseData,
  zSymbolSearchData,
  zCountMarkerData,
  zAreaPolygonData,
  zLinearPolylineData,
  zScaleCalibrationData,
  zEmptyMarkupData, // LAST recognized member (all-optional; matches any object)
]);

/**
 * The full annotation-data union: recognized shapes first, then the unknown
 * fallback (RD-J: empty-markup LAST before the unknown fallback). Used for
 * "parses at all" checks; shape ATTRIBUTION uses classifyAnnotationData below.
 */
export const zAnnotationData = z.union([
  zRecognizedAnnotationData,
  zUnknownAnnotationData,
]);
export type AnnotationDataUnion = z.infer<typeof zAnnotationData>;

// ─── Classifier (RD-J) ───────────────────────────────────────

/** Classifier verdict — keys of SHAPE_SCHEMAS. */
export type AnnotationDataKind =
  | "yolo-detection"
  | "shape-parse"
  | "symbol-search"
  | "count-marker"
  | "area-polygon"
  | "linear-polyline"
  | "scale-calibration"
  | "empty-markup"
  | "unknown";

/** Per-shape schema map keyed by classifier verdict (RD-J). Log-mode sinks
 *  (U1+) classify FIRST, then validate against `SHAPE_SCHEMAS[kind]`. */
export const SHAPE_SCHEMAS = {
  "yolo-detection": zYoloDetectionData,
  "shape-parse": zShapeParseData,
  "symbol-search": zSymbolSearchData,
  "count-marker": zCountMarkerData,
  "area-polygon": zAreaPolygonData,
  "linear-polyline": zLinearPolylineData,
  "scale-calibration": zScaleCalibrationData,
  "empty-markup": zEmptyMarkupData,
  unknown: zUnknownAnnotationData,
} as const;

// Keys that an empty-markup blob is allowed to carry (besides being literally {}).
// A blob with ONLY these keys is empty-markup; ANY other unrecognized key ⇒
// unknown. This is what separates `{}` / `{csiCodes:[...]}` (empty-markup) from
// an arbitrary legacy blob like `{foo:"bar"}` (unknown).
const EMPTY_MARKUP_ALLOWED_KEYS = new Set(["csiCodes", "keywords", "v"]);

/**
 * Attribute a raw `annotations.data` value to exactly one shape (RD-J). Because
 * z.union is first-match and zEmptyMarkupData matches any object, the bare union
 * cannot attribute a shape — this classifier does, via the documented two-keyed
 * resolution order. It NEVER throws (returns "unknown" on any non-object input).
 *
 * Resolution order:
 *  1. `type` literal        → count-marker / area-polygon / linear-polyline / scale-calibration
 *  2. `modelName` literal   → shape-parse / symbol-search
 *  3. modelId + classId     → yolo-detection (yolo's modelName is arbitrary, so
 *                             step 2 does not catch it; it has no `type`)
 *  4. {} / only csi+version → empty-markup
 *  5. else                  → unknown
 */
export function classifyAnnotationData(data: unknown): AnnotationDataKind {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return "unknown";
  }
  const d = data as Record<string, unknown>;

  // (1) `type` literal → takeoff shapes
  if (d.type === "count-marker") return "count-marker";
  if (d.type === "area-polygon") return "area-polygon";
  if (d.type === "linear-polyline") return "linear-polyline";
  if (d.type === "scale-calibration") return "scale-calibration";

  // (2) `modelName` literal → parse shapes
  if (d.modelName === "shape-parse") return "shape-parse";
  if (d.modelName === "symbol-search") return "symbol-search";

  // (3) yolo detection — modelId + classId present, no recognized `type`
  if (d.modelId !== undefined && d.classId !== undefined) return "yolo-detection";

  // (4) empty-markup — {} or ONLY csi-extension/version keys
  if (Object.keys(d).every((k) => EMPTY_MARKUP_ALLOWED_KEYS.has(k))) {
    return "empty-markup";
  }

  // (5) everything else (unrecognized markers / arbitrary legacy blob)
  return "unknown";
}
