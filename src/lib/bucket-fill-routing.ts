/**
 * bucket-fill-routing.ts — which engine handles this click, and why.
 *
 * PLAN §4.3's auto-fallback. A **pure, synchronous decision** over facts already gathered, because
 * it sits on the click path: every input is either a cached value or a store read, and nothing here
 * awaits, allocates, or touches pdf.js.
 *
 * ── ★ THE MISS IS THE MECHANISM, NOT A SPECIAL CASE ─────────────────────────────────────
 * PLAN: *"the mechanism you asked for falls out of the cache design rather than being invented."*
 * A page with no cached geometry routes to raster for the same reason a scanned page does — there
 * is nothing for the vector engine to read. Startup, eviction, a corrupt op list and a photograph
 * of a drawing all arrive here as the same absence, and all get the same answer.
 *
 * ── EVERY REFUSAL CARRIES A REASON ──────────────────────────────────────────────────────
 * Not for logging. Phase 3 shows the user a different message depending on whether vector *could
 * not run* (route to raster silently) or *ran and refused* (offer the barrier tool), and phase 4's
 * toggle needs to explain why a page it promised would be vector was not. A boolean would force
 * both to be re-derived from scratch, and the routing code is the only place that knows.
 */

import type { PageGeometryEntry } from "@/queries/pageGeometryCache";
import { vectorMayRun, type BucketFillMode } from "@/lib/bucket-fill-mode";

/**
 * Placed-image coverage at or above this fraction of the sheet ⇒ raster.
 *
 * ⚠ MEASURED CAVEAT, and it decides how this signal must be read: `imageArea` is an area SUM, and
 * the VA sheet alone carries **12,433 decorative 1-px gradient strips** in its title block. High
 * coverage from many tiny ops is artwork; high coverage from few large ops is a scan underlay.
 * This threshold is therefore a *scan detector only in combination* — see `segCount` below, which
 * is what actually separates the two cases: a scan has almost no vector segments, decorated CAD has
 * thousands.
 */
export const RASTER_IMAGE_FRACTION = 0.10;

/**
 * Below this many vector segments a page is not a drawing we can flood.
 *
 * A genuine scan extracts ~0 segments (measured: our `scan-150dpi` fixture yields 0 and the vector
 * engine correctly refuses). 500 leaves generous room for a sparse detail sheet while still
 * catching a scan wrapped in a thin vector border.
 */
export const MIN_VECTOR_SEGMENTS = 500;

export type BucketFillEngine = "vector" | "raster";

export type RasterReason =
  /** The session is pinned to raster (dev override, or the phase-2/3 default). */
  | "mode-raster"
  /** Nothing cached for this page — startup, eviction, or never armed. THE fallback trigger. */
  | "no-geometry"
  /** Extraction was tried and cannot work here (the cached sentinel). */
  | "geometry-unavailable"
  /** Placed images dominate the sheet AND there is almost no linework: a scan. */
  | "scanned-page"
  /** Too little vector linework to flood. */
  | "sparse-geometry"
  /** ★ The page paints linework from a switched-off CAD layer. See pdf-optional-content.ts. */
  | "hidden-layers";

export type RoutingDecision =
  | { engine: "vector" }
  | { engine: "raster"; reason: RasterReason };

export interface RoutingInput {
  mode: BucketFillMode;
  /** Whatever the geometry cache holds for this page — `undefined` is a miss, and that is fine. */
  entry: PageGeometryEntry | undefined;
  /** Does this page reference a non-visible optional-content group? */
  ocUnsafe: boolean;
}

/**
 * Decide the engine for one click.
 *
 * Order matters and is not arbitrary: cheapest and most decisive first, so a raster-pinned session
 * never inspects geometry it will not use, and a page with no geometry is never asked about signals
 * that only exist inside geometry.
 */
export function routeBucketFill(input: RoutingInput): RoutingDecision {
  const { mode, entry, ocUnsafe } = input;

  if (!vectorMayRun(mode)) return { engine: "raster", reason: "mode-raster" };
  if (!entry) return { engine: "raster", reason: "no-geometry" };
  if (entry.status !== "ok") return { engine: "raster", reason: "geometry-unavailable" };

  // ★ MANDATORY, NOT OPTIONAL — this is the port's single regression risk. Checked BEFORE the
  // corpus signals, because a page with beautiful vector linework and a hidden demolition layer
  // looks perfect to every other signal here and returns exactly half a room with status `ok`.
  if (ocUnsafe) return { engine: "raster", reason: "hidden-layers" };

  const { geometry } = entry;
  const segCount = geometry.segs.length / 4; // segs is flat [x1,y1,x2,y2] per segment
  const sheetArea = geometry.viewportWidth * geometry.viewportHeight;
  const imageFraction = sheetArea > 0 ? geometry.imageArea / sheetArea : 0;

  // The two-signal policy. Neither alone is sufficient and PLAN says so: image coverage on its own
  // misreads a decorated title block as a scan, and a low segment count on its own would demote a
  // genuinely sparse detail sheet that the vector path handles fine.
  if (imageFraction >= RASTER_IMAGE_FRACTION && segCount < MIN_VECTOR_SEGMENTS) {
    return { engine: "raster", reason: "scanned-page" };
  }
  if (segCount < MIN_VECTOR_SEGMENTS) {
    return { engine: "raster", reason: "sparse-geometry" };
  }

  return { engine: "vector" };
}

/**
 * User-facing explanation for a raster route, or `null` when the reason is not worth surfacing.
 *
 * ⚠ `null` for `mode-raster` and `no-geometry` is deliberate. Those are the ordinary states — the
 * default engine, and a page whose geometry has not been extracted yet — and announcing them would
 * train users to ignore the messages that DO matter. Only the three that say something true about
 * *this drawing* get copy.
 */
export function rasterReasonMessage(reason: RasterReason): string | null {
  switch (reason) {
    case "hidden-layers":
      return "This sheet has hidden CAD layers, so it was measured from the image to avoid tracing linework you cannot see.";
    case "scanned-page":
      return "This sheet looks like a scan, so it was measured from the image.";
    case "sparse-geometry":
      return "This sheet has very little vector linework, so it was measured from the image.";
    case "geometry-unavailable":
      return "This sheet's vector data could not be read, so it was measured from the image.";
    case "mode-raster":
    case "no-geometry":
      return null;
  }
}
