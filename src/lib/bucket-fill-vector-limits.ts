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
