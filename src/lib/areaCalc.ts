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

/**
 * Area centroid (centre of mass) of a polygon, for label placement.
 *
 * ── WHY THIS IS A SHOELACE CENTROID AND NOT A VERTEX MEAN ───────────────────────────────
 * This function used to average the vertices. A vertex mean is not a centroid: it weights by
 * *how many points describe an edge*, not by area, so two polygons covering the identical
 * region get different answers. MEASURED — subdividing ONE edge of a rectangle, which changes
 * no geometry whatsoever, walks the vertex mean from y=0.300 to y=0.112 (k=1 → 64 splits):
 * **148.9 pt of drift on a 1224 pt sheet**, dragging the label off the shape's own centre and
 * against the subdivided edge. The shoelace centroid over the same series drifts `0.0`, exactly.
 *
 * That is not a hypothetical. A traced outline collapses straight walls to two points and keeps
 * detail only where the boundary is complex, so its vertex density is deliberately uneven — and
 * any change to the tracer silently moves every label anchored here. Area centroids are immune
 * by construction, which is the whole reason to use one.
 *
 * ⚠ WHAT THIS DOES **NOT** PROMISE: that the label lands inside the room. A centroid is a
 * centre of mass, and for a sufficiently concave shape it is genuinely outside the polygon —
 * MEASURED on a thin L (arm width 60 of 490) and on a U, where *both* the old mean and the new
 * centroid fall outside. Fixing that requires a pole-of-inaccessibility placement, which is a
 * different function and a different decision. This change makes label placement *correct and
 * stable*, not *guaranteed interior*, and the distinction should survive into any future work.
 *
 * Coordinates are normalised 0-1 and the caller scales by page width/height. No aspect-ratio
 * correction is needed here (unlike `computeRealArea` directly above): a centroid is affine-
 * equivariant, so scaling x and y afterwards yields the true centroid in page space.
 *
 * Holes are not considered — `vertices` is the outer ring, and a polygon with a large hole
 * therefore reports the centroid of its outer boundary.
 */
export function polygonCentroid(vertices: { x: number; y: number }[]): { x: number; y: number } {
  const n = vertices.length;
  if (n === 0) return { x: 0, y: 0 };

  // `a2` is twice the signed shoelace area; the sign cancels in the division, so a ring wound
  // either way gives the same point.
  let a2 = 0, cx = 0, cy = 0;
  for (let i = 0; i < n; i++) {
    const p = vertices[i], q = vertices[(i + 1) % n];
    const cross = p.x * q.y - q.x * p.y;
    a2 += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }

  // Threshold, not zero: a near-degenerate ring loses `a2` to catastrophic cancellation, and
  // dividing by the noise that survives would fling the label off the page. In normalised
  // coordinates the float noise floor is ~1e-13 for a few thousand vertices, while the
  // smallest region worth labelling — 1 pt² on a 1224x792 sheet — has a2 ≈ 2e-6. 1e-12 sits
  // between them with six orders of margin on the side that matters.
  if (Math.abs(a2) > 1e-12) {
    return { x: cx / (3 * a2), y: cy / (3 * a2) };
  }

  // Degenerate (zero-area: collinear, or fewer than 3 points). The centroid is undefined, so
  // fall back to the bounding-box centre rather than the vertex mean — the same density bias
  // applies to a degenerate ring, and the bbox centre has none. For 1 and 2 vertices this is
  // identical to the old mean, so no non-degenerate behaviour changes.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const v of vertices) {
    if (v.x < minX) minX = v.x;
    if (v.x > maxX) maxX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

/**
 * Compute polyline length from normalized vertices + calibration.
 * Returns total length and per-segment lengths in real-world units.
 */
export function computePolylineLength(
  vertices: { x: number; y: number }[],
  pageWidth: number,
  pageHeight: number,
  pixelsPerUnit: number
): { total: number; segments: number[] } {
  const segments: number[] = [];
  for (let i = 0; i < vertices.length - 1; i++) {
    const dx = (vertices[i + 1].x - vertices[i].x) * pageWidth;
    const dy = (vertices[i + 1].y - vertices[i].y) * pageHeight;
    segments.push(Math.sqrt(dx * dx + dy * dy) / pixelsPerUnit);
  }
  return { total: segments.reduce((a, b) => a + b, 0), segments };
}
