/**
 * bucket-fill-vector-adapter.ts — the boundary between BP2 and the vendored One-Click engine.
 *
 * BP2-side, outside `src/lib/oneclick/`. **All adaptation happens here**; nothing app-shaped is
 * merged into a vendored body. That is what keeps the drift check meaningful and the upstream
 * diff readable.
 *
 * It produces BP2's existing `BucketFillResult` shape so the vector path is drop-in against the
 * raster one — same vertices, same holes, same `areaFraction` semantics, differing only in
 * `method`. Everything downstream (the client, the commit path, the annotation pipeline) is
 * untouched by design.
 *
 * ── THE FOUR THINGS THAT ACTUALLY NEED ADAPTING ─────────────────────────────────────────
 * 1. **Coordinate spaces.** Three are in play and they are easy to confuse:
 *      normalised 0-1   what BP2 speaks (seed, barriers, returned vertices)
 *      image px         what the engine's flood seed and `traceRegion` output use
 *      mask px          what `floodRegion`'s region array and `findHoleBorders` use
 *    `traceRegion` already divides by `ws` for you; hole borders do NOT, so they are converted
 *    here. Getting this wrong produces a plausible-looking polygon at the wrong scale.
 *
 * 2. **Barriers.** Upstream has no barrier concept at all. BP2's user-drawn barriers and polygon
 *    exclusions are burned into their mask as bit-1 walls via the shared mask ops.
 *
 * 3. **Holes.** Their tracer is outer-contour-only; holes are manual option-click deducts. We keep
 *    BP2's automatic hole detection (12 behavioural tests defend it) and run it over their flood's
 *    region — same array layout, and the bbox needed to bound it is exactly what vendored
 *    MODIFICATION 1 lifted out of the flood pass.
 *
 * 4. **Statuses.** The engine has a real status model (`ok` / `leak` / `tiny` / `boundary`); BP2's
 *    protocol has an in-band `{type:"error"}` **returned at HTTP 200**, which callers parse in
 *    band. Each status maps to a message a user can act on, because "refuses clearly" beating
 *    "traces wrong" is the entire point of adopting this engine (RC4).
 */

import {
  buildMask,
  floodRegion,
  traceRegion,
  snapVertices,
  SENS_BALANCED,
  type VectorGeometry,
  type Point,
  type NearestFn,
} from "@/lib/oneclick/oneclick";
import { findHoleBorders } from "@/lib/bucket-fill-mask-ops";
import { burnLine, fillPolygonOnBinary } from "@/lib/bucket-fill-mask-ops";
import {
  clampMaskDim,
  MASK_DIM_DEFAULT,
  isHoleSignificant,
  polygonAreaAbs,
} from "@/lib/bucket-fill-vector-limits";
import { NO_SNAP } from "@/lib/bucket-fill-snapgrid";
import type { BucketFillResult } from "@/workers/bucket-fill.worker";

/** Bit 1 in the One-Click mask: a hard wall. */
const MASK_BIT_WALL = 1;

/** Minimum vertices for a usable polygon, matching the raster worker's own floor. */
const MIN_VERTICES = 3;

export interface VectorFillRequest {
  /** Extracted page geometry (cached per page; produced by `extractVectorGeometry`). */
  geo: VectorGeometry;
  /** Device px of the viewport the geometry was extracted at. */
  imgW: number;
  imgH: number;
  /** Seed, NORMALISED 0-1 — the same convention as `BucketFillRequest.seedX/seedY`. */
  seedX: number;
  seedY: number;
  /** User-drawn barriers, normalised 0-1. */
  barriers?: { x1: number; y1: number; x2: number; y2: number }[];
  /** Existing takeoff polygons that must not be re-filled, normalised 0-1. */
  polygonBarriers?: { vertices: { x: number; y: number }[] }[];
  /** Working mask dimension; clamped to the safe ceiling. */
  maskDimension?: number;
  /** 0..1 escalation sensitivity. Defaults to the engine's calibrated Balanced preset. */
  sensitivity?: number;
  /**
   * Vertex-snap lookup. Defaults to NO_SNAP — snapping ships disabled until phase 8 because
   * feeding it requires caching `points`, which takes geometry from 2.4 to 9.6 MB/page.
   */
  nearest?: NearestFn;
  /**
   * Closed-ring RDP tolerance in MASK px. Defaults to the engine's own value.
   *
   * Exposed because RC3 is literally "polygon simplification is 10x too loose AND HAS NO KNOB" —
   * BP2's raster worker hard-wires epsilon to 0.5% of the page (~±1.4 ft of vertex slop). Having
   * it as a parameter here is the seam that complaint asks for; the default keeps upstream's
   * calibrated behaviour until someone changes it deliberately.
   */
  epsMaskPx?: number;
}

/**
 * ★ `code` is what makes a refusal MACHINE-READABLE across the worker boundary.
 *
 * `error` is prose for a human; `code` is the verdict for the status model (PLAN §5 phase 3), which
 * must distinguish "the engine ran and concluded this room leaks" from "the engine never ran".
 * Without it the only way to recover the verdict on the far side of `postMessage` is to match on
 * the message text — and the whole reason {@link VECTOR_REFUSALS} is an exported table is so that
 * nothing has to do that. Copy is allowed to change; a verdict is not.
 *
 * Optional because it is additive: every existing consumer of `BucketFillResult` ignores it, and
 * the raster worker never sets it.
 */
export type VectorFillOutcome = Omit<BucketFillResult, "requestId"> & {
  code?: VectorRefusal;
};

/** Barrier thickness in mask px. 3 matches the raster worker's own burn width. */
const BARRIER_THICKNESS = 3;

/** Snap tolerance in image px. 7 is upstream's own call-site value, not the function default of 6. */
const SNAP_TOL_PX = 7;

/**
 * Every reason this adapter can refuse, keyed by a short code.
 *
 * Exported as a record rather than hidden in a switch so that anything needing to map a message
 * back to a reason — the accuracy harness classifies refusals per fixture cell — reads the SAME
 * table instead of pattern-matching on prose. String-sniffing the user-facing copy would make
 * these messages load-bearing for tooling, and the first person to improve the wording would
 * silently break the classifier.
 *
 * The engine knows *why* it refused; emitting a generic failure would give up the main thing this
 * port buys (RC4: "refuses clearly" beats "traces wrong").
 */
export const VECTOR_REFUSALS = {
  leak: "Fill escaped the room — the boundary has a gap. Draw a barrier across the opening and try again.",
  tiny: "That click landed inside dense linework rather than an open room. Try clicking nearer the middle of the space.",
  boundary: "That click landed on a wall or outside the drawing.",
  "no-geometry": "No vector linework on this page — use the raster path.",
  "no-page": "Page has no usable dimensions.",
  untraceable: "Traced region was too small to form a polygon.",
} as const;

export type VectorRefusal = keyof typeof VECTOR_REFUSALS;

/**
 * Run the vector engine and return BP2's result shape.
 *
 * Pure and synchronous: geometry acquisition (`getOperatorList` + `extractVectorGeometry`) is the
 * expensive, cacheable half and belongs to the caller. This function is the ~5 ms warm click.
 */
export function vectorBucketFill(req: VectorFillRequest): VectorFillOutcome {
  const { geo, imgW, imgH } = req;

  if (!(imgW > 0) || !(imgH > 0)) {
    return { type: "error", error: VECTOR_REFUSALS["no-page"], code: "no-page" };
  }
  // A page with no linework is a scan (or a blank sheet). Say so rather than flooding the whole
  // page: this is precisely the case the raster fallback exists for, and the caller routes on it.
  if (geo.segs.length === 0) {
    return { type: "error", error: VECTOR_REFUSALS["no-geometry"], code: "no-geometry", method: "client-vector" };
  }

  const maskDim = clampMaskDim(req.maskDimension ?? MASK_DIM_DEFAULT);
  const maskObj = buildMask(geo.segs, imgW, imgH, maskDim, geo.meta);
  const { mask, mw, mh, ws } = maskObj;

  // ── 2. barriers, burned as bit-1 walls, in MASK px ────────────────────────
  for (const b of req.barriers ?? []) {
    burnLine(
      mask, mw, mh,
      Math.round(b.x1 * mw), Math.round(b.y1 * mh),
      Math.round(b.x2 * mw), Math.round(b.y2 * mh),
      BARRIER_THICKNESS,
      MASK_BIT_WALL,
    );
  }
  for (const pe of req.polygonBarriers ?? []) {
    fillPolygonOnBinary(mask, mw, mh, pe.vertices, MASK_BIT_WALL);
  }

  // ── flood, from an IMAGE-px seed (the engine applies `ws` itself) ──────────
  const flood = floodRegion(
    maskObj,
    req.seedX * imgW,
    req.seedY * imgH,
    req.sensitivity ?? SENS_BALANCED,
  );
  if (flood.status !== "ok") {
    return { type: "error", error: VECTOR_REFUSALS[flood.status], code: flood.status, method: "client-vector" };
  }

  // ── 1. outer contour: already IMAGE px, thanks to traceRegion's /ws ────────
  // snapVertices is applied even with NO_SNAP because upstream's own call site does exactly
  // that: `snapVertices(traceRegion(f), (x,y,d) => grid ? nearestSnap(...) : null, 7)` — the
  // lookup returns null when no grid exists, so the minimum-gap dedup and closing-vertex trim
  // still run. Skipping it would produce a polygon upstream never emits.
  const ring = snapVertices(
    traceRegion(flood, req.epsMaskPx),
    req.nearest ?? NO_SNAP,
    SNAP_TOL_PX,
  );
  if (ring.length < MIN_VERTICES) {
    return { type: "error", error: VECTOR_REFUSALS.untraceable, code: "untraceable", method: "client-vector" };
  }

  // ── 3. holes: BP2's detector over their region, bounded by the lifted bbox ─
  //    findHoleBorders works in MASK px and returns MASK px, so convert on the way out.
  const holeBorders = findHoleBorders(flood.region, mw, mh, {
    minX: flood.minX, minY: flood.minY, maxX: flood.maxX, maxY: flood.maxY,
  });

  const norm = (p: Point) => ({ x: p[0] / imgW, y: p[1] / imgH });
  const holes: { vertices: { x: number; y: number }[] }[] = [];
  for (const hb of holeBorders) {
    if (hb.length < MIN_VERTICES) continue;
    // ★ Measured in MASK px, before the conversion below — the two thresholds are mask-px
    // literals and mean nothing in normalised space. See bucket-fill-vector-limits.ts.
    if (!isHoleSignificant(polygonAreaAbs(hb), flood.count)) continue;
    holes.push({
      vertices: hb.map((p) => ({ x: p.x / ws / imgW, y: p.y / ws / imgH })),
    });
  }

  return {
    type: "result",
    vertices: ring.map(norm),
    holes,
    holeCount: holes.length,
    // Net of holes by construction: `count` is what the flood actually marked, and holes were
    // never marked. Same semantics as the raster worker's `area / (w * h)`.
    areaFraction: flood.count / (mw * mh),
    method: "client-vector",
  };
}
