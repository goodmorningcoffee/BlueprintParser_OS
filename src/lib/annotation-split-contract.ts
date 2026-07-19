import { z } from "zod";

import type { AreaUnitSq, ClientAnnotation } from "@/types";

export const SPLIT_ANNOTATION_MEASUREMENT_RELATIVE_TOLERANCE = 1e-6;
export const SPLIT_ANNOTATION_BBOX_STORAGE_TOLERANCE = 1e-6;
export const SPLIT_ANNOTATION_MAX_SOURCE_VERTICES = 10_000;
export const SPLIT_ANNOTATION_ERROR_DURATION_MS = 5_000;

export const SPLIT_HOLED_TARGET_MESSAGE =
  "Area polygons with holes cannot be split yet";
export const SPLIT_UNSUPPORTED_AREA_DATA_MESSAGE =
  "This area contains data that cannot be split safely.";
export const SPLIT_STALE_PREVIEW_MESSAGE =
  "This area changed after the split preview. Draw the split again.";
export const SPLIT_UNSAVED_SOURCE_MESSAGE =
  "This area is still saving. Try the split again in a moment.";
export const SPLIT_PERSISTED_NOT_ADOPTED_MESSAGE =
  "Split saved, but this view changed. Reopen the project to load it.";

export const SPLIT_ANNOTATION_AREA_UNITS = ["SF", "SI", "SM", "SC"] as const;
export const SPLIT_ANNOTATION_AREA_DATA_KEYS = [
  "type",
  "takeoffItemId",
  "color",
  "vertices",
  "holes",
  "areaSqUnits",
  "unit",
  "csiCodes",
  "keywords",
] as const;

export type NormalizedPoint = Readonly<{ x: number; y: number }>;
export type SplitAnnotationBbox = readonly [number, number, number, number];

export type SplitAnnotationRequest = Readonly<{
  sourceAnnotationId: number;
  expectedSource: Readonly<{
    pageNumber: number;
    bbox: SplitAnnotationBbox;
    data: Record<string, unknown>;
  }>;
  lineA: NormalizedPoint;
  lineB: NormalizedPoint;
  measurements: Readonly<{
    leftAreaSqUnits: number;
    rightAreaSqUnits: number;
    unit: AreaUnitSq;
  }>;
}>;

export type SplitAnnotationResponse = Readonly<{
  left: ClientAnnotation;
  right: ClientAnnotation;
}>;

export type SplittableAreaData = Readonly<{
  type: "area-polygon";
  takeoffItemId: number;
  color: string;
  vertices: readonly NormalizedPoint[];
  areaSqUnits: number;
  unit: AreaUnitSq;
  csiCodes?: readonly string[];
  keywords?: readonly string[];
}>;

export type SplittableAreaDataFailure =
  | "invalid-area"
  | "invalid-color"
  | "invalid-extensions"
  | "invalid-holes"
  | "invalid-item"
  | "invalid-shape"
  | "invalid-unit"
  | "invalid-vertices"
  | "nonempty-holes"
  | "unsupported-key";

export type SplittableAreaDataResult =
  | Readonly<{ ok: true; data: SplittableAreaData }>
  | Readonly<{ ok: false; reason: SplittableAreaDataFailure }>;

const AREA_DATA_KEY_SET = new Set<string>(SPLIT_ANNOTATION_AREA_DATA_KEYS);
const AREA_UNIT_SET = new Set<string>(SPLIT_ANNOTATION_AREA_UNITS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNormalizedPoint(value: unknown): value is NormalizedPoint {
  if (!isRecord(value)) return false;
  if (Object.keys(value).some((key) => key !== "x" && key !== "y"))
    return false;
  return (
    typeof value.x === "number" &&
    Number.isFinite(value.x) &&
    value.x >= 0 &&
    value.x <= 1 &&
    typeof value.y === "number" &&
    Number.isFinite(value.y) &&
    value.y >= 0 &&
    value.y <= 1
  );
}

/**
 * Validate the bounded area-data shape shared by persistent and local Split acceptance.
 * `undefined` optional extension/holes values are treated as absent for live in-memory rows;
 * JSONB rows never contain them.
 */
export function parseSplittableAreaData(
  value: unknown,
  maxVertices = SPLIT_ANNOTATION_MAX_SOURCE_VERTICES,
): SplittableAreaDataResult {
  if (!isRecord(value)) return { ok: false, reason: "invalid-shape" };
  if (Object.keys(value).some((key) => !AREA_DATA_KEY_SET.has(key))) {
    return { ok: false, reason: "unsupported-key" };
  }
  if (value.type !== "area-polygon")
    return { ok: false, reason: "invalid-shape" };
  if (
    typeof value.takeoffItemId !== "number" ||
    !Number.isSafeInteger(value.takeoffItemId) ||
    value.takeoffItemId <= 0
  ) {
    return { ok: false, reason: "invalid-item" };
  }
  if (typeof value.color !== "string")
    return { ok: false, reason: "invalid-color" };
  if (
    !Array.isArray(value.vertices) ||
    value.vertices.length < 3 ||
    value.vertices.length > maxVertices ||
    !value.vertices.every(isNormalizedPoint)
  ) {
    return { ok: false, reason: "invalid-vertices" };
  }
  if (value.holes !== undefined) {
    if (!Array.isArray(value.holes))
      return { ok: false, reason: "invalid-holes" };
    if (value.holes.length > 0) return { ok: false, reason: "nonempty-holes" };
  }
  if (
    typeof value.areaSqUnits !== "number" ||
    !Number.isFinite(value.areaSqUnits) ||
    value.areaSqUnits < 0
  ) {
    return { ok: false, reason: "invalid-area" };
  }
  if (typeof value.unit !== "string" || !AREA_UNIT_SET.has(value.unit)) {
    return { ok: false, reason: "invalid-unit" };
  }
  for (const extension of [value.csiCodes, value.keywords]) {
    if (
      extension !== undefined &&
      (!Array.isArray(extension) ||
        !extension.every((entry) => typeof entry === "string"))
    ) {
      return { ok: false, reason: "invalid-extensions" };
    }
  }

  return {
    ok: true,
    data: {
      type: "area-polygon",
      takeoffItemId: value.takeoffItemId,
      color: value.color,
      vertices: value.vertices,
      areaSqUnits: value.areaSqUnits,
      unit: value.unit as AreaUnitSq,
      ...(value.csiCodes === undefined
        ? {}
        : { csiCodes: value.csiCodes as string[] }),
      ...(value.keywords === undefined
        ? {}
        : { keywords: value.keywords as string[] }),
    },
  };
}

const zPositiveSafeInteger = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const zNormalizedCoordinate = z.number().finite().min(0).max(1);
export const zSplitAnnotationPoint = z
  .object({ x: zNormalizedCoordinate, y: zNormalizedCoordinate })
  .strict();
export const zSplitAnnotationBbox = z
  .tuple([
    zNormalizedCoordinate,
    zNormalizedCoordinate,
    zNormalizedCoordinate,
    zNormalizedCoordinate,
  ])
  .refine(([minX, minY, maxX, maxY]) => minX < maxX && minY < maxY, {
    message: "bbox: minX must be < maxX and minY must be < maxY",
  });
export const zSplitAnnotationAreaUnit = z.enum(SPLIT_ANNOTATION_AREA_UNITS);

export const zSplitAnnotationRequest = z
  .object({
    sourceAnnotationId: zPositiveSafeInteger,
    expectedSource: z
      .object({
        pageNumber: zPositiveSafeInteger,
        bbox: zSplitAnnotationBbox,
        data: z.record(z.string(), z.unknown()),
      })
      .strict(),
    lineA: zSplitAnnotationPoint,
    lineB: zSplitAnnotationPoint,
    measurements: z
      .object({
        leftAreaSqUnits: z.number().finite().nonnegative(),
        rightAreaSqUnits: z.number().finite().nonnegative(),
        unit: zSplitAnnotationAreaUnit,
      })
      .strict(),
  })
  .strict()
  .refine(({ lineA, lineB }) => lineA.x !== lineB.x || lineA.y !== lineB.y, {
    message: "lineA and lineB must be distinct",
    path: ["lineB"],
  });

const zSplitAnnotationResponseData = z
  .object({
    type: z.literal("area-polygon"),
    takeoffItemId: zPositiveSafeInteger,
    color: z.string().max(20),
    vertices: z
      .array(zSplitAnnotationPoint)
      .min(3)
      .max(SPLIT_ANNOTATION_MAX_SOURCE_VERTICES + 2),
    areaSqUnits: z.number().finite().nonnegative(),
    unit: zSplitAnnotationAreaUnit,
    csiCodes: z.array(z.string()).optional(),
    keywords: z.array(z.string()).optional(),
  })
  .strict();

export const zSplitAnnotationClientAnnotation = z
  .object({
    id: zPositiveSafeInteger,
    pageNumber: zPositiveSafeInteger,
    name: z.string().max(255),
    bbox: zSplitAnnotationBbox,
    note: z.string().nullable(),
    source: z.literal("takeoff"),
    data: zSplitAnnotationResponseData,
  })
  .strict();

export const zSplitAnnotationResponse = z
  .object({
    left: zSplitAnnotationClientAnnotation,
    right: zSplitAnnotationClientAnnotation,
  })
  .strict();
