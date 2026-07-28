/**
 * bucket-fill-status.ts — what the user is told after a vector attempt, and whether raster runs.
 *
 * PLAN §5 phase 3's centrepiece. Until now `bucket-fill-client.ts` swallowed every vector refusal
 * in a bare `catch {}` and quietly returned a raster number; its own comment said phase 3 owns the
 * decision. This module IS that decision, kept **pure and synchronous** so it can be exhaustively
 * tested without a worker, a canvas, a document or a store.
 *
 * ── ★ THE DISTINCTION THE WHOLE MODULE TURNS ON: A VERDICT IS NOT A FAILURE ──────────────
 * The vector engine can end a click in two completely different ways, and today's code cannot tell
 * them apart because both arrive as a rejected promise:
 *
 *   • **A VERDICT** — the engine ran, saw the linework, and concluded something true about this
 *     room: the fill escaped (`leak`), the seed sat in dense hatch (`tiny`), the seed sat on a wall
 *     (`boundary`). This is the thing the port was bought for. RC4 in the plan's ledger is exactly
 *     "leaked fill commits silently", and the measured contrast is stark: on our `door-gap` fixture
 *     the vector engine REFUSES while the legacy engine returns **963,687 pt² for a 142,100 pt²
 *     room — 578% over, status `ok`**. Throwing a verdict away to go get that number back is the
 *     single worst thing this code could do.
 *
 *   • **A FAILURE** — the worker wedged, the timeout fired, geometry was never extracted. The
 *     engine reached no conclusion. Nothing here is worth telling the user, because there is no
 *     action they could take. Fall back silently, exactly as today.
 *
 * ── ⚠ "NO SHEET CLASS KEEPS TODAY'S SILENT-COMMIT BEHAVIOUR" (PLAN §5 phase 3) ────────────
 * Every path below either refuses, or produces a number **with** a message. There is deliberately
 * no route from "vector said this room leaks" to "here is a raster area, no comment".
 */

import { LEAK_FRACTION } from "@/lib/oneclick/oneclick";
import { VECTOR_REFUSALS, type VectorRefusal } from "@/lib/bucket-fill-vector-adapter";
import { RASTER_IMAGE_FRACTION, rasterReasonMessage, type RasterReason } from "@/lib/bucket-fill-routing";
import type { CachedPageGeometry } from "@/queries/pageGeometryCache";

/**
 * Is there placed image content on this sheet that the vector engine is blind to?
 *
 * This is the ONLY question the sheet class answers, and it is what decides whether a raster retry
 * can add information or merely launder a refusal into a wrong number.
 */
export type SheetClass =
  /** Linework only. Raster sees a *rendering of the same linework* — it knows nothing new. */
  | "pure-vector"
  /** Substantial placed imagery. Raster may see real ink the vector path never received. */
  | "mixed";

/**
 * At or above this fraction of the sheet, placed images are treated as real drawing content.
 *
 * Deliberately the SAME number the router uses to spot a scan, imported rather than repeated: below
 * it, placed images are incidental (the VA sheet's title-block decoration measures 0.0144); at or
 * above it there is enough image area that raster may be reading ink vector never got.
 *
 * ⚠ **KNOWN IMPRECISION, STATED RATHER THAN HIDDEN.** `imageArea` is an area SUM, and the census
 * measured that the VA sheet alone carries **12,433 decorative 1-px gradient strips**. So a heavily
 * decorated pure-CAD sheet can in principle cross this line and be called `mixed`. The census's own
 * remedy is to read `imageOps` beside `imageArea` (few big ops = a scan underlay; many tiny ops =
 * artwork) — but `imageOps` is computed by the census script and is **not** on `VectorGeometry`,
 * so it is not available here without a fourth modification to the vendored engine.
 *
 * That refinement is deferred deliberately, because a misclassification is **backstopped rather
 * than fatal**: a sheet wrongly called `mixed` gets a raster retry whose result must still pass
 * {@link isRasterRetryPlausible}, and that check is what catches both measured
 * confidently-wrong-number cases. Recorded in STATE.md as the named follow-up.
 */
export const MIXED_SHEET_IMAGE_FRACTION = RASTER_IMAGE_FRACTION;

export function classifySheet(geometry: CachedPageGeometry): SheetClass {
  const sheetArea = geometry.viewportWidth * geometry.viewportHeight;
  if (!(sheetArea > 0)) return "pure-vector";
  return geometry.imageArea / sheetArea >= MIXED_SHEET_IMAGE_FRACTION ? "mixed" : "pure-vector";
}

/** How a vector attempt ended. */
export type VectorAttempt =
  /** The engine ran and reached a conclusion. */
  | { kind: "refused"; refusal: VectorRefusal }
  /** The engine never ran — the router said so before any work started. */
  | { kind: "not-run"; reason: RasterReason }
  /** The engine was asked and something broke: wedged worker, timeout, transport error. */
  | { kind: "error" };

export interface StatusInput {
  attempt: VectorAttempt;
  sheetClass: SheetClass;
  /**
   * Is this page's geometry being extracted *right now*?
   *
   * ★ ADDED BECAUSE OF THE CENSUS, not because the plan asked for it. PLAN assumed extraction cost
   * ~1.2 s; the 789-page census measured **p95 5.6 s and max 18.3 s**. That turns "not cached yet"
   * from an invisible startup blink into up to eighteen seconds during which a user gets raster
   * numbers with no hint that a better answer is seconds away. "Still preparing" and "cannot use
   * vector on this sheet" are different facts and must not share a message.
   */
  geometryPending: boolean;
}

export type StatusCode =
  /** Vector reached a verdict; we refuse and say why. No area is produced. */
  | "vector-refused"
  /** Vector leaked but raster may know something it does not; retry, and caveat the number. */
  | "vector-leak-raster-retry"
  /** Vector could not run for a reason worth explaining; raster ran. */
  | "raster-explained"
  /** Geometry is still being extracted; raster ran meanwhile. */
  | "raster-preparing"
  /** Ordinary raster operation, or a failure the user cannot act on. Say nothing. */
  | "raster-silent";

/**
 * `error` refuses and yields no number. `warning` accompanies a number the user should look at.
 * `null` shows nothing at all.
 */
export type StatusTone = "error" | "warning" | null;

export interface StatusDecision {
  code: StatusCode;
  /** Does the caller run the legacy raster path after this? */
  retryRaster: boolean;
  /** Copy to surface, or `null` for silence. */
  message: string | null;
  tone: StatusTone;
  /** Should the UI point the user at the barrier tool? Only ever true when a barrier would help. */
  offerBarrier: boolean;
}

/**
 * ⚠ Refusals that are verdicts about **the click**, not about the sheet.
 *
 * `tiny` ("that click landed inside dense linework") and `boundary` ("that click landed on a wall")
 * are statements about where the user pressed, and both remedies are user actions — click somewhere
 * else. A raster retry here answers a question the user did not mean to ask, and answers it with
 * the engine that has no verdict model at all. So these refuse on **every** sheet class, mixed
 * included; the sheet class only ever gets consulted for `leak`.
 *
 * Note the asymmetry is real, not tidiness: `boundary` in particular is *evidence of vector ink* at
 * the seed. The vector engine cannot see raster ink at all, so it could never report `boundary`
 * because of something only the scan layer contains.
 */
const CLICK_VERDICTS: ReadonlySet<VectorRefusal> = new Set<VectorRefusal>(["tiny", "boundary"]);

/**
 * Refusals that mean "vector cannot work here", not "this room is a problem".
 *
 * These are indistinguishable to the user from the page simply not being a vector page, so they
 * take the silent raster path. `untraceable` belongs here rather than with the verdicts: the flood
 * succeeded and only the *contour* came back degenerate, which says nothing actionable about the
 * room.
 */
const NON_VERDICT_REFUSALS: ReadonlySet<VectorRefusal> = new Set<VectorRefusal>([
  "no-geometry",
  "no-page",
  "untraceable",
]);

/** Silence, and a raster number. The shape today's code produces for everything. */
const SILENT_RASTER: StatusDecision = {
  code: "raster-silent",
  retryRaster: true,
  message: null,
  tone: null,
  offerBarrier: false,
};

/**
 * Decide what happens after a vector attempt.
 *
 * Pure: same input, same output, no clock, no store, no I/O.
 */
export function decideBucketFillStatus(input: StatusInput): StatusDecision {
  const { attempt, sheetClass, geometryPending } = input;

  // A failure is not a verdict — nothing to say, fall back exactly as today.
  if (attempt.kind === "error") return SILENT_RASTER;

  if (attempt.kind === "not-run") {
    // "Still working on it" outranks every other explanation: it is temporary, it is the only one
    // that will resolve on its own, and telling a user their sheet "has no vector data" while it is
    // actively being read would be simply false.
    if (geometryPending) {
      return {
        code: "raster-preparing",
        retryRaster: true,
        message:
          "Still reading this sheet's linework — this area was measured from the image. Try again in a moment for a more precise result.",
        tone: "warning",
        offerBarrier: false,
      };
    }
    const message = rasterReasonMessage(attempt.reason);
    if (!message) return SILENT_RASTER;
    return {
      code: "raster-explained",
      retryRaster: true,
      message,
      tone: "warning",
      offerBarrier: false,
    };
  }

  const { refusal } = attempt;

  if (NON_VERDICT_REFUSALS.has(refusal)) return SILENT_RASTER;

  if (CLICK_VERDICTS.has(refusal)) {
    return {
      code: "vector-refused",
      retryRaster: false,
      message: VECTOR_REFUSALS[refusal],
      tone: "error",
      offerBarrier: false,
    };
  }

  // ── `leak` — the case the sheet class exists for ────────────────────────────
  //
  // On a PURE-VECTOR sheet the vector engine has seen everything there is to see, so its verdict is
  // the best information available and raster cannot improve on it. Retrying would render the same
  // linework to a 1000 px bitmap and flood *that* — the measured result of which is `door-gap`
  // (+578%, status `ok`) and `e-size-hairline` (the entire 8.96M pt² sheet). Refuse, and offer the
  // one remedy that actually closes a gap.
  if (sheetClass === "pure-vector") {
    return {
      code: "vector-refused",
      retryRaster: false,
      message: VECTOR_REFUSALS.leak,
      tone: "error",
      offerBarrier: true,
    };
  }

  // On a MIXED sheet the leak may be a blind spot rather than a real gap: the boundary the user can
  // see might live entirely in the scan layer, which the vector engine never received. Raster
  // deserves its shot — but the number arrives CAVEATED and naming the vector verdict, and it still
  // has to survive isRasterRetryPlausible() before anyone commits it.
  return {
    code: "vector-leak-raster-retry",
    retryRaster: true,
    message:
      "The linework on this sheet doesn't fully enclose that space, so it was measured from the image instead — check the area before you add it. Drawing a barrier across the opening will give a precise result.",
    tone: "warning",
    offerBarrier: true,
  };
}

/**
 * Is a raster retry's area believable, given that the vector engine just said the space leaks?
 *
 * ★ THE CRITERION IS THE ENGINE'S OWN, IMPORTED RATHER THAN COPIED. `LEAK_FRACTION` is the constant
 * `floodRegion` uses to decide a fill escaped ("fill > 30% of the sheet ⇒ not an enclosed space").
 * Applying that same number to the raster result is what makes this a *check* rather than a second
 * opinion pulled out of the air — and exporting it (vendored MODIFICATION 3) is what stops the two
 * from drifting apart silently.
 *
 * ⚠ **This is the backstop for everything above it.** Both confidently-wrong-number cases measured
 * in phase 0 fail it decisively: `door-gap` returns essentially the whole sheet, and
 * `e-size-hairline` returns 8,946,545 of 8,957,952 pt² (99.87%). A sheet misclassified as `mixed`
 * therefore cannot turn a clean vector refusal into a committed wrong number — it can only cost the
 * user one extra raster attempt.
 *
 * @param areaFraction fraction of the sheet the raster fill marked — the same quantity on both
 *        engines (`flood.count / (mw * mh)` on vector, `area / (w * h)` on the raster worker).
 */
export function isRasterRetryPlausible(areaFraction: number): boolean {
  // ⚠ THE LOWER BOUND IS NOT DEFENSIVE PADDING — it is the half a mutation test proved was doing
  // the work. `NaN <= x` and `Infinity <= x` are ALREADY false, so an upper-bound-only check needs
  // no finiteness guard and adding one tests nothing (measured: deleting `Number.isFinite` left all
  // 25 tests green). What `<=` alone genuinely admits is a NEGATIVE or zero fraction, which is not
  // a small room — it is an engine that marked nothing, or a corrupt count.
  return areaFraction > 0 && areaFraction <= LEAK_FRACTION;
}

/**
 * What to show when the raster retry ALSO produced something implausible.
 *
 * Both engines have now failed on the same space, one of them explicitly. There is no number worth
 * offering, and the barrier tool is the genuine remedy.
 */
export function rasterRetryRejected(): StatusDecision {
  return {
    code: "vector-refused",
    retryRaster: false,
    message:
      "Neither engine could enclose that space — the fill escaped across the sheet. Draw a barrier across the opening and try again.",
    tone: "error",
    offerBarrier: true,
  };
}
