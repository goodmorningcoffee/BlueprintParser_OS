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
import { clampMaskDim, MASK_DIM_DEFAULT } from "@/lib/bucket-fill-vector-limits";
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
}

export type VectorFillOutcome = Omit<BucketFillResult, "requestId">;

/** Barrier thickness in mask px. 3 matches the raster worker's own burn width. */
const BARRIER_THICKNESS = 3;

/**
 * Status → user-facing message. The engine knows *why* it refused; throwing that away and
 * emitting a generic failure would give up the main thing this port buys.
 */
function refusalMessage(status: "leak" | "tiny" | "boundary"): string {
  switch (status) {
    case "leak":
      return "Fill escaped the room — the boundary has a gap. Draw a barrier across the opening and try again.";
    case "tiny":
      return "That click landed inside dense linework rather than an open room. Try clicking nearer the middle of the space.";
    case "boundary":
      return "That click landed on a wall or outside the drawing.";
  }
}

/**
 * Run the vector engine and return BP2's result shape.
 *
 * Pure and synchronous: geometry acquisition (`getOperatorList` + `extractVectorGeometry`) is the
 * expensive, cacheable half and belongs to the caller. This function is the ~5 ms warm click.
 */
export function vectorBucketFill(req: VectorFillRequest): VectorFillOutcome {
  const { geo, imgW, imgH } = req;

  if (!(imgW > 0) || !(imgH > 0)) {
    return { type: "error", error: "Page has no usable dimensions." };
  }
  // A page with no linework is a scan (or a blank sheet). Say so rather than flooding the whole
  // page: this is precisely the case the raster fallback exists for, and the caller routes on it.
  if (geo.segs.length === 0) {
    return { type: "error", error: "No vector linework on this page — use the raster path." };
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
    return { type: "error", error: refusalMessage(flood.status), method: "client-vector" };
  }

  // ── 1. outer contour: already IMAGE px, thanks to traceRegion's /ws ────────
  const ring = snapVertices(traceRegion(flood), req.nearest ?? NO_SNAP);
  if (ring.length < MIN_VERTICES) {
    return { type: "error", error: "Traced region was too small to form a polygon.", method: "client-vector" };
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
