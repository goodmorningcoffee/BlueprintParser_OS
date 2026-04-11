/**
 * polygon-split.ts — split a simple polygon by a line segment.
 *
 * Returns two sub-polygons if the line cleanly bisects the polygon (exactly
 * 2 intersection points with polygon edges). Returns null for degenerate
 * cases (0, 1, or >2 intersections, collinear-with-edge).
 */

export type Pt = { x: number; y: number };

const EPS_PARALLEL = 1e-9;
const EPS_VERTEX = 1e-6;

export function splitPolygonByLine(
  polygon: Pt[],
  lineA: Pt,
  lineB: Pt
): { left: Pt[]; right: Pt[] } | null {
  if (polygon.length < 3) return null;

  type Hit = { edgeIndex: number; point: Pt; t: number };
  const hits: Hit[] = [];

  const n = polygon.length;
  for (let i = 0; i < n; i++) {
    const v1 = polygon[i];
    const v2 = polygon[(i + 1) % n];
    const inter = intersectLineWithSegment(lineA, lineB, v1, v2);
    if (inter) {
      hits.push({ edgeIndex: i, point: inter.point, t: inter.t });
    }
  }

  if (hits.length === 0) return null;

  const deduped: Hit[] = [];
  for (const h of hits) {
    const same = deduped.find((d) => pointsEqual(d.point, h.point));
    if (!same) deduped.push(h);
  }

  if (deduped.length !== 2) return null;

  deduped.sort((a, b) => a.edgeIndex - b.edgeIndex);
  const [h1, h2] = deduped;

  const leftRaw: Pt[] = [h1.point];
  for (let k = h1.edgeIndex + 1; k <= h2.edgeIndex; k++) {
    leftRaw.push(polygon[k % n]);
  }
  leftRaw.push(h2.point);

  const rightRaw: Pt[] = [h2.point];
  for (let k = h2.edgeIndex + 1; k <= h1.edgeIndex + n; k++) {
    rightRaw.push(polygon[k % n]);
  }
  rightRaw.push(h1.point);

  const left = dedupeConsecutive(leftRaw);
  const right = dedupeConsecutive(rightRaw);

  if (left.length < 3 || right.length < 3) return null;

  return { left, right };
}

function dedupeConsecutive(points: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    if (out.length === 0 || !pointsEqual(out[out.length - 1], p)) {
      out.push(p);
    }
  }
  if (out.length > 2 && pointsEqual(out[0], out[out.length - 1])) {
    out.pop();
  }
  return out;
}

function intersectLineWithSegment(
  lineA: Pt,
  lineB: Pt,
  segA: Pt,
  segB: Pt
): { point: Pt; t: number } | null {
  const dx1 = lineB.x - lineA.x;
  const dy1 = lineB.y - lineA.y;
  const dx2 = segB.x - segA.x;
  const dy2 = segB.y - segA.y;

  const denom = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denom) < EPS_PARALLEL) return null;

  const dxAC = segA.x - lineA.x;
  const dyAC = segA.y - lineA.y;

  const u = (dxAC * dy2 - dyAC * dx2) / denom;
  const tSeg = (dxAC * dy1 - dyAC * dx1) / denom;

  if (tSeg < -EPS_VERTEX || tSeg > 1 + EPS_VERTEX) return null;

  const tClamped = Math.max(0, Math.min(1, tSeg));
  const point = {
    x: segA.x + tClamped * dx2,
    y: segA.y + tClamped * dy2,
  };
  return { point, t: tClamped };
}

function pointsEqual(a: Pt, b: Pt): boolean {
  return Math.abs(a.x - b.x) < EPS_VERTEX && Math.abs(a.y - b.y) < EPS_VERTEX;
}

export function polygonArea(polygon: Pt[]): number {
  let sum = 0;
  const n = polygon.length;
  for (let i = 0; i < n; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % n];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

export function pointInPolygon(pt: Pt, polygon: Pt[]): boolean {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const vi = polygon[i];
    const vj = polygon[j];
    const intersect =
      vi.y > pt.y !== vj.y > pt.y &&
      pt.x < ((vj.x - vi.x) * (pt.y - vi.y)) / (vj.y - vi.y) + vi.x;
    if (intersect) inside = !inside;
  }
  return inside;
}
