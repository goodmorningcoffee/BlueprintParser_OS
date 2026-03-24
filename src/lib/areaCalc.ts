/**
 * Pure math utilities for QTO area calculation.
 * All vertex coordinates are normalized (0-1) relative to page dimensions.
 */

/** Shoelace formula — polygon area in normalized squared units. */
export function shoelaceArea(vertices: { x: number; y: number }[]): number {
  const n = vertices.length;
  if (n < 3) return 0;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += vertices[i].x * vertices[j].y;
    area -= vertices[j].x * vertices[i].y;
  }
  return Math.abs(area) / 2;
}

/** Compute pixels-per-unit from two calibration points + real distance. */
export function computePixelsPerUnit(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  pageWidth: number,
  pageHeight: number,
  realDistance: number
): number {
  const dxPx = (p2.x - p1.x) * pageWidth;
  const dyPx = (p2.y - p1.y) * pageHeight;
  const distPx = Math.sqrt(dxPx * dxPx + dyPx * dyPx);
  return distPx / realDistance;
}

/**
 * Convert polygon area from normalized coords to real-world squared units.
 * Accounts for aspect ratio since normalized X and Y have different physical lengths.
 */
export function computeRealArea(
  vertices: { x: number; y: number }[],
  pageWidth: number,
  pageHeight: number,
  calibration: { point1: { x: number; y: number }; point2: { x: number; y: number }; realDistance: number }
): number {
  const normArea = shoelaceArea(vertices);
  const ppu = computePixelsPerUnit(
    calibration.point1, calibration.point2,
    pageWidth, pageHeight,
    calibration.realDistance
  );
  // normArea * pageWidth * pageHeight = area in px², divide by ppu² for real units²
  return (normArea * pageWidth * pageHeight) / (ppu * ppu);
}

/** Centroid of polygon for label placement. */
export function polygonCentroid(vertices: { x: number; y: number }[]): { x: number; y: number } {
  const n = vertices.length;
  if (n === 0) return { x: 0, y: 0 };
  let cx = 0, cy = 0;
  for (const v of vertices) { cx += v.x; cy += v.y; }
  return { x: cx / n, y: cy / n };
}

/** Point-in-polygon test using ray casting. */
export function pointInPolygon(
  point: { x: number; y: number },
  vertices: { x: number; y: number }[]
): boolean {
  const n = vertices.length;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = vertices[i].x, yi = vertices[i].y;
    const xj = vertices[j].x, yj = vertices[j].y;
    if (
      ((yi > point.y) !== (yj > point.y)) &&
      (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi)
    ) {
      inside = !inside;
    }
  }
  return inside;
}
