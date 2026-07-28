/**
 * bucket-fill-vector-limits.ts — hard safety limits for the vendored One-Click engine.
 *
 * BP2-side, deliberately OUTSIDE `src/lib/oneclick/`. That directory is Apache-2.0 third-party
 * code and its rule is that adaptation happens at the boundary, not inside vendored bodies —
 * so a guard we invented lives here, where it needs no MODIFICATIONS entry and cannot drift
 * against upstream.
 *
 * ── WHY A HARD CAP EXISTS ───────────────────────────────────────────────────────────────
 * `rastermask.ts` builds a summed-area table to compute its adaptive threshold:
 *
 *     // integral image, (mw+1)×(mh+1); max sum 3000·3000·255 ≈ 2.3e9 < 2^32
 *     const integral = new Uint32Array(iw * (mh + 1));
 *
 * That comment is upstream's own, and it is correct **at mask dim 3000**. But it is a comment,
 * not a check. The accumulator is `Uint32Array`, so the largest representable running sum is
 * 2³² − 1, and a grayscale cell contributes up to 255:
 *
 *     dim² · 255 < 2³²   ⇒   dim ≤ 4104
 *
 * VERIFIED, not assumed:
 *     4104² · 255 = 4,294,918,080  <  4,294,967,296 = 2³²   ✅ fits, by 49,216
 *     4105² · 255 = 4,297,011,375  >  4,294,967,296          ❌ overflows
 *
 * Past that the integral image wraps **silently**. Uint32Array does not throw; it truncates.
 * And the wrap is not self-cancelling: `adaptiveThreshold` reads window sums as
 *     integral[a] - integral[b] - integral[c] + integral[d]
 * in float64, not modular arithmetic — so once any of those four corners has wrapped past zero
 * the ordering breaks and the difference comes out wildly wrong (a small positive window sum
 * reads as a large negative one). Every window whose rectangle straddles the wrap is corrupt,
 * the Bradley–Roth comparison `g * area < sum * (1 - t)` misfires, and the flood then produces
 * a confidently wrong number — the exact failure class this rebuild exists to remove.
 *
 * `MASK_MAX_DIM_HARD` is therefore 4096, not 4104: a power of two, 8 px of headroom under the
 * true ceiling, and comfortably above the pinned working value of 3000.
 *
 * ── THIS IS A CEILING, NOT A TUNING KNOB ────────────────────────────────────────────────
 * The engine's 21 hatch constants are **mask-pixel literals** calibrated at dim 3000, and
 * measured hatch classification swings ~26% across dims 1000→4000. Raising mask dim is a
 * calibration decision requiring a recorded measurement, not a performance dial. This constant
 * only stops the silent-corruption cliff; it does not make 4096 a safe *choice*.
 */

/** Upstream's calibrated working value. Pinned; see the note above before changing it. */
export const MASK_DIM_DEFAULT = 3000;

/**
 * The largest mask dimension this code will pass to the engine.
 *
 * Chosen as 4096 = 2¹², eight pixels below the arithmetic ceiling of 4104 at which
 * `rastermask.ts`'s Uint32 integral image silently wraps.
 */
export const MASK_MAX_DIM_HARD = 4096;

/**
 * The true arithmetic ceiling, exported so the test can assert the relationship rather than
 * re-derive it, and so a future reader can see how much headroom 4096 actually buys.
 */
export const MASK_DIM_OVERFLOW_CEILING = 4104;

/** Does a square mask of this dimension keep the integral image inside Uint32? */
export function integralImageFits(dim: number): boolean {
  return dim * dim * 255 < 2 ** 32;
}

/**
 * Clamp a requested mask dimension into the safe range.
 *
 * Clamps rather than throws: a caller asking for too much should still get a usable result at
 * the largest safe size, and the alternative — an exception on the click path — trades a
 * numerical hazard for an availability one. Non-finite or non-positive input falls back to the
 * calibrated default rather than propagating NaN into an allocation.
 */
export function clampMaskDim(requested: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return MASK_DIM_DEFAULT;
  return Math.min(Math.floor(requested), MASK_MAX_DIM_HARD);
}

// ── [bucketfill P3] the minimum hole ────────────────────────────────────────────────────
//
// ★ WHY A FILTER EXISTS AT ALL, AND WHY IT LIVES IN THE CALLER.
//
// `findHoleBorders` reports every enclosed void in the flood region, and it is right to: it has no
// idea which of them a user meant. On the raster path that was harmless, because a 1000 px-capped
// downscale-then-threshold destroyed anything small before the detector ever saw it. The vector
// path has no such accidental filter — it traces linework at ~2.4 mask px per point — so specks,
// glyph counters, hatch intersections and dimension-line crossings all become "holes", each one
// silently SUBTRACTED from the room's area.
//
// The filter is applied by the CALLERS (the adapter and worker #2) rather than inside
// `findHoleBorders`, deliberately: that function is shared with the legacy raster worker and has
// twelve behavioural tests pinning it. Filtering there would change the raster path's numbers for
// every user while the vector path is still dark, and would make those twelve tests re-baseline
// for a reason that has nothing to do with what they test.
//
// ⚠ SCOPED TO THE VECTOR CALLERS ONLY, for the same reason the raster-retry plausibility check is:
// phase 3 shipping statuses must not quietly change what today's default engine returns.

/**
 * Absolute floor, in MASK px². Below this a "hole" cannot be a real feature at mask dim 3000 —
 * 30 px² is roughly a 5.5 x 5.5 px blob, about 2.2 pt square on a letter sheet.
 */
export const MIN_HOLE_MASK_PX = 30;

/**
 * Relative floor, as a fraction of the filled region.
 *
 * ⚠ THE TWO FLOORS ARE BOTH REQUIRED, AND THAT IS A REAL TRADE-OFF, NOT A BELT-AND-BRACES.
 * The absolute floor alone lets a large room accumulate dozens of legitimate-sized-but-spurious
 * voids; the relative floor alone would keep a 3 px speck inside a tiny closet. Requiring both
 * means a genuinely small feature in a very large room — a lone 8" pipe chase in a warehouse — is
 * dropped. That is the known cost, and it is the right side to err on: an over-reported area is a
 * visible, arguable number, while a phantom hole silently under-reports and looks like a
 * measurement.
 */
export const MIN_HOLE_REGION_FRACTION = 0.005;

/**
 * Absolute polygon area by the shoelace formula. Winding-agnostic.
 *
 * Units are whatever the vertices are in — callers pass MASK px, which is the only space where the
 * two thresholds above are meaningful.
 */
export function polygonAreaAbs(vertices: { x: number; y: number }[]): number {
  const n = vertices.length;
  if (n < 3) return 0;
  let twice = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    twice += vertices[j].x * vertices[i].y - vertices[i].x * vertices[j].y;
  }
  return Math.abs(twice) / 2;
}

/**
 * Is this hole big enough to be a feature the user meant, rather than tracer noise?
 *
 * @param holeAreaMaskPx  the hole's own area, MASK px²
 * @param regionAreaMaskPx the filled region's area, MASK px² (`flood.count`)
 */
export function isHoleSignificant(
  holeAreaMaskPx: number,
  regionAreaMaskPx: number,
): boolean {
  if (!(holeAreaMaskPx > 0)) return false;
  if (holeAreaMaskPx < MIN_HOLE_MASK_PX) return false;
  // A non-positive region cannot give a meaningful ratio; the absolute floor has already spoken.
  if (!(regionAreaMaskPx > 0)) return true;
  return holeAreaMaskPx >= regionAreaMaskPx * MIN_HOLE_REGION_FRACTION;
}
