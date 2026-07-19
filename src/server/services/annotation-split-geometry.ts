import {
  SPLIT_ANNOTATION_BBOX_STORAGE_TOLERANCE,
  SPLIT_ANNOTATION_MEASUREMENT_RELATIVE_TOLERANCE,
  type NormalizedPoint,
  type SplitAnnotationBbox,
} from "@/lib/annotation-split-contract";
import { polygonArea, type Pt } from "@/lib/polygon-split";
import { hasSimplePolygonBoundary } from "@/server/services/annotation-split-boundary";

const SPLIT_GEOMETRY_RELATIVE_TOLERANCE = 1e-6;

export type SplitPolygonGeometry = Readonly<{
  bbox: SplitAnnotationBbox;
  area: number;
}>;

function bboxForPolygon(
  polygon: readonly NormalizedPoint[],
): SplitAnnotationBbox | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of polygon) {
    if (
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      point.x < 0 ||
      point.x > 1 ||
      point.y < 0 ||
      point.y > 1
    ) {
      return null;
    }
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  if (
    !(minX < maxX && minY < maxY) ||
    !(Math.fround(minX) < Math.fround(maxX)) ||
    !(Math.fround(minY) < Math.fround(maxY))
  ) {
    return null;
  }
  return [minX, minY, maxX, maxY];
}

export function inspectSimpleSplitPolygon(
  polygon: Pt[],
): SplitPolygonGeometry | null {
  const bbox = bboxForPolygon(polygon);
  const area = polygonArea(polygon);
  if (
    !bbox ||
    !hasSimplePolygonBoundary(polygon) ||
    !Number.isFinite(area) ||
    area <= 0
  ) {
    return null;
  }
  return { bbox, area };
}

export function storedSplitBboxMatches(
  stored: SplitAnnotationBbox,
  geometry: SplitAnnotationBbox,
): boolean {
  return stored.every(
    (coordinate, index) =>
      Math.abs(coordinate - geometry[index]) <=
      SPLIT_ANNOTATION_BBOX_STORAGE_TOLERANCE,
  );
}

export function splitAreasConserve(
  sourceArea: number,
  leftArea: number,
  rightArea: number,
): boolean {
  const outputArea = leftArea + rightArea;
  return (
    Math.abs(outputArea - sourceArea) <=
    SPLIT_GEOMETRY_RELATIVE_TOLERANCE * Math.max(sourceArea, outputArea)
  );
}

export function splitMeasurementsMatchGeometry(
  leftMeasurement: number,
  rightMeasurement: number,
  leftPolygonArea: number,
  rightPolygonArea: number,
): boolean {
  if (leftMeasurement === 0 && rightMeasurement === 0) return true;
  if (leftMeasurement <= 0 || rightMeasurement <= 0) return false;
  const leftScale = leftMeasurement / leftPolygonArea;
  const rightScale = rightMeasurement / rightPolygonArea;
  if (!Number.isFinite(leftScale) || !Number.isFinite(rightScale)) return false;
  const denominator = Math.max(Math.abs(leftScale), Math.abs(rightScale));
  return (
    denominator > 0 &&
    Math.abs(leftScale - rightScale) <=
      SPLIT_ANNOTATION_MEASUREMENT_RELATIVE_TOLERANCE * denominator
  );
}
