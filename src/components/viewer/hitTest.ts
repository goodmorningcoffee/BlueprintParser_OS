// src/components/viewer/hitTest.ts — [refactor jul15 P3.1½] Pure geometry leaf for AnnotationOverlay.
// Dependency-free (SPEC §"Pure API": no React/DOM/canvas/store/query/tool/event imports). Byte-for-
// semantics with the pre-move live math; provenance ranges are HEAD 0fe4712.

export type HitPoint = Readonly<{ x: number; y: number }>;
export type HitBbox = readonly [number, number, number, number];

// [refactor jul15 P3.1½] Ray cast, verbatim from src/lib/areaCalc.ts:82-99 (readonly types only).
// Asymmetric square-edge rule preserved: left/top edges + top-left corner IN, right/bottom OUT;
// horizontal edges never toggle; 0/1/2-vertex polygons always return false. No epsilon/validation.
export function pointInPolygon(
  point: HitPoint,
  vertices: readonly HitPoint[],
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

// [refactor jul15 P3.1½] outer-hit AND no-hole-hit. Mirrors AnnotationOverlay.tsx:2005-2008
// (double-click) & 2228-2230 (single pointer). Short-circuits on outer miss, like live. Holes keep
// the live `{ vertices }[]` shape (DR010 bind (c)): call sites pass `data.holes` directly, adding
// zero allocation over the pre-move composition. No epsilon/validation.
export function pointInPolygonWithHoles(
  point: HitPoint,
  outer: readonly HitPoint[],
  holes?: readonly Readonly<{ vertices: readonly HitPoint[] }>[],
): boolean {
  if (!pointInPolygon(point, outer)) return false;
  return !(holes ?? []).some((h) => pointInPolygon(point, h.vertices));
}

// [refactor jul15 P3.1½] Point-near-polyline, verbatim from AnnotationOverlay.tsx:2242-2253
// (float-identical to the double-click block 2012-2019). In-loop anisotropic scaling, projection
// t clamped to [0,1], zero-length segment => t=0, Math.sqrt, strict `< thresholdPx`, first-hit stop.
export function pointNearPolyline(
  pointPx: HitPoint,
  normalizedVertices: readonly HitPoint[],
  pageWidth: number,
  pageHeight: number,
  thresholdPx = 8,
): boolean {
  for (let i = 0; i < normalizedVertices.length - 1; i++) {
    const ax = normalizedVertices[i].x * pageWidth;
    const ay = normalizedVertices[i].y * pageHeight;
    const bx = normalizedVertices[i + 1].x * pageWidth;
    const by = normalizedVertices[i + 1].y * pageHeight;
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((pointPx.x - ax) * dx + (pointPx.y - ay) * dy) / lenSq));
    const projX = ax + t * dx, projY = ay + t * dy;
    const dist = Math.sqrt((pointPx.x - projX) ** 2 + (pointPx.y - projY) ** 2);
    if (dist < thresholdPx) return true;
  }
  return false;
}

// [refactor jul15 P3.1½] Normalized MinMax bbox via live MIN-PLUS-EXTENT float form (ax +
// (max-min)*dim, NOT max*dim — the two forms differ at ULP level on non-round coordinates;
// both miss inverted boxes). ULP cases pinning this form live in HitTestPure.test.ts. Mirrors
// AnnotationOverlay.tsx:2022-2024 / 2263-2268 / 2362-2367. Inclusive edges; zero-size box hits its
// exact point; inverted axes (max<min) => empty range => miss.
export function pointInNormalizedBbox(
  pointPx: HitPoint,
  bbox: HitBbox,
  pageWidth: number,
  pageHeight: number,
): boolean {
  const [minX, minY, maxX, maxY] = bbox;
  const ax = minX * pageWidth;
  const ay = minY * pageHeight;
  return (
    pointPx.x >= ax &&
    pointPx.x <= ax + (maxX - minX) * pageWidth &&
    pointPx.y >= ay &&
    pointPx.y <= ay + (maxY - minY) * pageHeight
  );
}

// [refactor jul15 P3.1½] Open axis-aligned handle square: strict independent-axis compare, NOT
// Euclidean. Mirrors AnnotationOverlay.tsx:2155 / 2176 / 2341 (HANDLE=8, AO:1465). Diagonal
// (7.9,7.9) HITS (Euclidean ~11.17); exactly 8 on either axis MISSES. First-hit order is the caller's.
export function pointInHandle(
  pointPx: HitPoint,
  centerPx: HitPoint,
  halfExtentPx = 8,
): boolean {
  return (
    Math.abs(pointPx.x - centerPx.x) < halfExtentPx &&
    Math.abs(pointPx.y - centerPx.y) < halfExtentPx
  );
}
