/**
 * bucket-fill-snapgrid.ts — nearest-endpoint lookup for vertex snapping.
 *
 * ── WHY THIS IS HAND-ROLLED RATHER THAN VENDORED ────────────────────────────────────────
 * This is the one piece of OpenTakeoff's functionality we deliberately did NOT take. Their
 * `geometry.js` **declares itself** byte-identical with a commercial product (Spline) in its own
 * header. We have no copy of that product and cannot check the claim either way — but the
 * entanglement the comment *describes* is reason enough to stay clear of it, and grid hashing is
 * about twenty lines. Taking it would have imported an unresolvable provenance question in
 * exchange for saving an afternoon.
 *
 * So this file is BP2's own work, lives OUTSIDE `src/lib/oneclick/`, and carries no Apache
 * header — there is nothing vendored in it.
 *
 * ── WHAT IT PLUGS INTO ──────────────────────────────────────────────────────────────────
 * The engine's `snapVertices(poly, nearest, tolPx, minGapPx)` takes an injected lookup:
 *
 *     type NearestFn = (x: number, y: number, maxDist: number) => Point | null | undefined
 *
 * `buildSnapGrid(points)` returns exactly that. Points are the true line endpoints
 * `extractVectorGeometry` collects, in image px — snapping a traced contour onto them pulls
 * polygon corners back onto real drawing geometry instead of mask-quantised staircases.
 *
 * ── ⛔ SHIPS DISABLED. DO NOT WIRE IT ON BEFORE PHASE 8. ─────────────────────────────────
 * Not because the code is unready — because of what it costs to keep the input alive. Measured:
 *
 *     geometry cached WITHOUT `points`   2.4 MB / page
 *     geometry cached WITH `points`      9.6 MB / page   ← 7.2 MB of it is points[]
 *
 * At 9.6 MB the 4-page / 24 MB cache holds **two** dense pages. Snapping is a polish feature;
 * paying 4× the cache budget for it before the vector path has even shipped is the wrong order.
 * Build it now (it is cheap and the seam should exist), enable it deliberately later.
 */

import type { Point, NearestFn } from "@/lib/oneclick/oneclick";

/** Grid cell size in image px. Chosen as the default snap tolerance so a lookup touches 3×3. */
const DEFAULT_CELL = 6;

export interface SnapGrid {
  /** The injectable lookup — pass straight to `snapVertices`. */
  nearest: NearestFn;
  /** Number of indexed endpoints, for diagnostics and cache accounting. */
  size: number;
}

/**
 * Build a spatial hash over `points` and return a nearest-within-maxDist lookup.
 *
 * A uniform grid rather than a k-d tree on purpose: endpoints on a drawing are roughly evenly
 * spread, queries are always short-range (tolerance is a handful of px), and the build must be
 * cheap because it happens per page. Bucketing is O(n) to build and O(1) per query in practice.
 *
 * The lookup scans the cells covering the query disc, so correctness does not depend on the cell
 * size matching the tolerance — a larger `maxDist` simply widens the scanned ring.
 */
export function buildSnapGrid(points: readonly Point[], cell: number = DEFAULT_CELL): SnapGrid {
  const size = Math.max(1, cell);
  const buckets = new Map<number, Point[]>();
  // Interleave the two coordinates into one integer key. Grid coords can be negative (a CropBox
  // offset can place geometry left of the origin), so bias before packing rather than assuming
  // non-negative — an unbiased key would collide across the axis.
  const key = (gx: number, gy: number) => (gx + 0x8000) * 0x10000 + (gy + 0x8000);

  for (const p of points) {
    const gx = Math.floor(p[0] / size);
    const gy = Math.floor(p[1] / size);
    const k = key(gx, gy);
    const b = buckets.get(k);
    if (b) b.push(p);
    else buckets.set(k, [p]);
  }

  const nearest: NearestFn = (x, y, maxDist) => {
    if (!(maxDist > 0) || buckets.size === 0) return null;
    const r = Math.ceil(maxDist / size);
    const gx = Math.floor(x / size);
    const gy = Math.floor(y / size);
    let best: Point | null = null;
    let bestD2 = maxDist * maxDist; // compare squared; never take a root in the scan
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const b = buckets.get(key(gx + dx, gy + dy));
        if (!b) continue;
        for (const p of b) {
          const ex = p[0] - x;
          const ey = p[1] - y;
          const d2 = ex * ex + ey * ey;
          if (d2 <= bestD2) {
            bestD2 = d2;
            best = p;
          }
        }
      }
    }
    return best;
  };

  return { nearest, size: points.length };
}

/** A lookup that never snaps — the shipping default while snapping stays disabled. */
export const NO_SNAP: NearestFn = () => null;
