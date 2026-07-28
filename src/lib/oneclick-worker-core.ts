/**
 * oneclick-worker-core.ts — worker #2's protocol and state, with no `self` in sight.
 *
 * `src/workers/oneclick.worker.ts` is a ~20-line shell that wires this to `postMessage`. The split
 * is the same one that worked for the prefetcher: logic here is testable in a plain node
 * environment, and the shell contains nothing worth testing. (The legacy worker registers
 * `self.addEventListener` at module scope, so importing it outside a DOM-ish environment throws —
 * which is exactly the friction this avoids.)
 *
 * ── ★ WHY THERE IS A `mask` MESSAGE AT ALL — "TRANSFER ONCE" ────────────────────────────
 * The naive protocol sends geometry with every click. Geometry is ~2.4 MB/page even with `points`
 * dropped, and structured-clone of a 2.4 MB payload on every click would cost more than the flood
 * it enables (measured warm click: p50 4.3 ms). So the protocol is three messages:
 *
 *   `mask`  → send the geometry ONCE per page, build the MaskObj, keep it. The buffers are
 *             TRANSFERRED, not copied, so the main thread hands over ownership and pays nothing.
 *   `fill`  → a seed and a few numbers. This is the ~5 ms warm click, and it is tiny on the wire.
 *   `evict` → drop one page's MaskObj when the geometry cache evicts it, so the two caches cannot
 *             disagree about what is resident.
 *
 * ── ★★ THE THING "TRANSFER ONCE" HIDES: BARRIERS ARE PER-CLICK, THE MASK IS PER-PAGE ────
 * BP2's user-drawn barriers and polygon exclusions are burned into the mask as walls. If they were
 * burned into the CACHED mask, the second click on a page would still see the first click's
 * barriers — a wrong number, produced confidently, with no error anywhere. That is precisely the
 * failure class this whole rebuild exists to remove, so:
 *
 *   **the cached mask is never written to, and a fill that has barriers works on a COPY.**
 *
 * The copy is a flat `Uint8Array` memcpy (~9 MB at mask dim 3000, sub-millisecond) and it is
 * skipped entirely when there are no barriers, which is the common case. Correctness first, and
 * the cost lands only on the clicks that ask for it.
 */

import {
  buildMask,
  floodRegion,
  traceRegion,
  snapVertices,
  releaseFloodScratch,
  SENS_BALANCED,
  type MaskObj,
  type Point,
} from "@/lib/oneclick/oneclick";
import { burnLine, fillPolygonOnBinary, findHoleBorders } from "@/lib/bucket-fill-mask-ops";
import { clampMaskDim, MASK_DIM_DEFAULT } from "@/lib/bucket-fill-vector-limits";
import { NO_SNAP } from "@/lib/bucket-fill-snapgrid";
import { VECTOR_REFUSALS, type VectorRefusal } from "@/lib/bucket-fill-vector-adapter";

/** Bit 1 in the One-Click mask: a hard wall. Matches the adapter. */
const MASK_BIT_WALL = 1;
/** Barrier stroke width in mask px — the raster worker's own burn width. */
const BARRIER_THICKNESS = 3;
/** Upstream's call-site snap tolerance in image px (their function default is 6). */
const SNAP_TOL_PX = 7;
/** Minimum vertices for a usable polygon, matching the raster worker's floor. */
const MIN_VERTICES = 3;

/**
 * How long the CLIENT waits for a `fill` before giving up and routing to raster.
 *
 * 1.5 s is ~45x the measured p95 warm click (32 ms) and ~4x the worst grid-sweep sample (63 ms),
 * so it cannot fire on a slow-but-working click. It exists for the case where the worker is wedged
 * or was never reachable — where the right answer is a raster result the user can see, not a
 * spinner. Exported here rather than in the client so the number lives beside the work it bounds.
 */
export const VECTOR_FILL_TIMEOUT_MS = 1500;

/** What the mask was built from. Phase 5 adds `"raster"`; today only vector geometry exists. */
export type MaskSourceKind = "vector" | "raster";

/**
 * Cache identity for one MaskObj.
 *
 * Page and mask dimension are obvious. `sourceKind` is here because phase 5 converges the raster
 * path onto this same worker with a second mask builder — and a raster-built and a vector-built
 * mask for the same page at the same dimension are NOT interchangeable. Keying them apart now
 * costs one string and prevents a class of bug that would otherwise arrive with that phase.
 */
export function maskCacheKey(
  publicId: string,
  pageNumber: number,
  maskDim: number,
  sourceKind: MaskSourceKind,
): string {
  return `${encodeURIComponent(publicId)}::${pageNumber}::${maskDim}::${sourceKind}`;
}

export interface MaskMessage {
  type: "mask";
  key: string;
  /** Transferred, not copied — see the header. */
  segs: Float64Array;
  meta: Uint8Array;
  imgW: number;
  imgH: number;
  maskDimension?: number;
}

export interface FillMessage {
  type: "fill";
  key: string;
  requestId: number;
  /** Normalised 0-1, BP2's convention. */
  seedX: number;
  seedY: number;
  sensitivity?: number;
  barriers?: { x1: number; y1: number; x2: number; y2: number }[];
  polygonBarriers?: { vertices: { x: number; y: number }[] }[];
  epsMaskPx?: number;
}

export interface EvictMessage {
  type: "evict";
  /** Omit to drop everything — used on project teardown. */
  key?: string;
}

export type OneclickRequest = MaskMessage | FillMessage | EvictMessage;

export type OneclickResponse =
  | { type: "mask-ready"; key: string; maskBytes: number }
  | { type: "mask-error"; key: string; error: string; code?: VectorRefusal }
  | {
      type: "result";
      requestId: number;
      vertices: { x: number; y: number }[];
      holes: { vertices: { x: number; y: number }[] }[];
      holeCount: number;
      areaFraction: number;
      method: "client-vector";
    }
  /**
   * ★ `code` carries the VERDICT; `error` carries the prose.
   *
   * The status model on the far side must tell "the engine ran and concluded this room leaks" apart
   * from "the engine never ran" — and after `postMessage` the only other way to recover that is to
   * match on the message text, which is exactly what {@link VECTOR_REFUSALS} being an exported
   * table exists to prevent. Structured-clone carries a plain string fine.
   */
  | {
      type: "error";
      requestId: number;
      error: string;
      code?: VectorRefusal;
      method?: "client-vector";
    }
  | { type: "evicted"; keys: string[] };

interface CachedMask {
  maskObj: MaskObj;
  imgW: number;
  imgH: number;
}

/**
 * ⚠ THE INVARIANT THIS FILE KEEPS: `maskObj.mask` is NEVER written to after `buildMask`.
 *
 * An earlier version also held a second, pristine `clean` copy as belt-and-braces. Negative-testing
 * showed it was dead weight — aliasing it to the live mask changed no test, because the per-click
 * copy already guarantees the cached buffer is never touched. It cost ~9 MB per cached page (36 MB
 * across the 4-page cache) to defend an invariant the copy already defends. Removed; the single
 * defence is the one below, and it is the one under test.
 */

export interface OneclickWorkerState {
  masks: Map<string, CachedMask>;
}

export function createWorkerState(): OneclickWorkerState {
  return { masks: new Map() };
}

/**
 * A mask is retained per page, and pages are evicted by the caller (the geometry cache owns that
 * policy). This cap is a backstop against a caller that never evicts — it is not the policy.
 */
export const MAX_RETAINED_MASKS = 4;

function handleMask(state: OneclickWorkerState, msg: MaskMessage): OneclickResponse {
  if (!(msg.imgW > 0) || !(msg.imgH > 0)) {
    return { type: "mask-error", key: msg.key, error: VECTOR_REFUSALS["no-page"], code: "no-page" };
  }
  const segs = Array.from(msg.segs);
  if (segs.length === 0) {
    return { type: "mask-error", key: msg.key, error: VECTOR_REFUSALS["no-geometry"], code: "no-geometry" };
  }
  const maskDim = clampMaskDim(msg.maskDimension ?? MASK_DIM_DEFAULT);
  const maskObj = buildMask(segs, msg.imgW, msg.imgH, maskDim, msg.meta);

  state.masks.set(msg.key, { maskObj, imgW: msg.imgW, imgH: msg.imgH });

  // Backstop only; the caller's geometry cache is the real policy. Insertion order is Map order,
  // so the oldest key goes first.
  while (state.masks.size > MAX_RETAINED_MASKS) {
    const oldest = state.masks.keys().next().value;
    if (oldest === undefined) break;
    state.masks.delete(oldest);
  }

  return { type: "mask-ready", key: msg.key, maskBytes: maskObj.mask.byteLength };
}

function handleFill(state: OneclickWorkerState, msg: FillMessage): OneclickResponse {
  const cached = state.masks.get(msg.key);
  if (!cached) {
    // Not an error the user caused: the mask was evicted, or this page never sent one. The caller
    // re-sends `mask` and retries, or routes to raster.
    return { type: "error", requestId: msg.requestId, error: VECTOR_REFUSALS["no-geometry"], code: "no-geometry" };
  }

  const { maskObj, imgW, imgH } = cached;
  const { mw, mh, ws } = maskObj;

  const hasBarriers =
    (msg.barriers?.length ?? 0) > 0 || (msg.polygonBarriers?.length ?? 0) > 0;

  // ★★ THE PER-CLICK COPY — the single defence of the never-mutate invariant above.
  // Barriers are per-click, the mask is per-page. Burning into the cached buffer would leak one
  // click's barriers into the next: NEGATIVE-TESTED, and deleting this line makes the second
  // barrier-free click return 0.123 where it should return 0.249 — half the room, status `ok`,
  // no warning. Skipped entirely when there are no barriers, which is the common case.
  const workingMask = hasBarriers ? maskObj.mask.slice() : maskObj.mask;
  if (hasBarriers) {
    for (const b of msg.barriers ?? []) {
      burnLine(
        workingMask, mw, mh,
        Math.round(b.x1 * mw), Math.round(b.y1 * mh),
        Math.round(b.x2 * mw), Math.round(b.y2 * mh),
        BARRIER_THICKNESS,
        MASK_BIT_WALL,
      );
    }
    for (const pe of msg.polygonBarriers ?? []) {
      fillPolygonOnBinary(workingMask, mw, mh, pe.vertices, MASK_BIT_WALL);
    }
  }

  // `floodRegion` reads `.mask`, so hand it the working buffer without mutating the cache entry.
  const floodInput: MaskObj = hasBarriers ? { ...maskObj, mask: workingMask } : maskObj;

  const flood = floodRegion(
    floodInput,
    msg.seedX * imgW,
    msg.seedY * imgH,
    msg.sensitivity ?? SENS_BALANCED,
  );
  if (flood.status !== "ok") {
    return {
      type: "error",
      requestId: msg.requestId,
      error: VECTOR_REFUSALS[flood.status],
      code: flood.status,
      method: "client-vector",
    };
  }

  const ring = snapVertices(traceRegion(flood, msg.epsMaskPx), NO_SNAP, SNAP_TOL_PX);
  if (ring.length < MIN_VERTICES) {
    return {
      type: "error",
      requestId: msg.requestId,
      error: VECTOR_REFUSALS.untraceable,
      code: "untraceable",
      method: "client-vector",
    };
  }

  const holeBorders = findHoleBorders(flood.region, mw, mh, {
    minX: flood.minX, minY: flood.minY, maxX: flood.maxX, maxY: flood.maxY,
  });
  const holes: { vertices: { x: number; y: number }[] }[] = [];
  for (const hb of holeBorders) {
    if (hb.length < MIN_VERTICES) continue;
    holes.push({ vertices: hb.map((p) => ({ x: p.x / ws / imgW, y: p.y / ws / imgH })) });
  }

  const norm = (p: Point) => ({ x: p[0] / imgW, y: p[1] / imgH });
  return {
    type: "result",
    requestId: msg.requestId,
    vertices: ring.map(norm),
    holes,
    holeCount: holes.length,
    areaFraction: flood.count / (mw * mh),
    method: "client-vector",
  };
}

function handleEvict(state: OneclickWorkerState, msg: EvictMessage): OneclickResponse {
  if (msg.key === undefined) {
    const keys = [...state.masks.keys()];
    state.masks.clear();
    // The engine's two shared scratch buffers are ~11.6 MB. Teardown is the one moment worth
    // handing them back rather than keeping them warm for the next click.
    releaseFloodScratch();
    return { type: "evicted", keys };
  }
  const existed = state.masks.delete(msg.key);
  return { type: "evicted", keys: existed ? [msg.key] : [] };
}

/**
 * The whole protocol, as one pure function over explicit state.
 *
 * Never throws: a worker that throws takes down every subsequent click on that page with an
 * `onerror` the caller has no request id for. Every failure comes back as a typed message instead.
 */
export function handleOneclickMessage(
  state: OneclickWorkerState,
  msg: OneclickRequest,
): OneclickResponse {
  try {
    switch (msg.type) {
      case "mask":
        return handleMask(state, msg);
      case "fill":
        return handleFill(state, msg);
      case "evict":
        return handleEvict(state, msg);
      default: {
        const exhaustive: never = msg;
        return {
          type: "error",
          requestId: -1,
          error: `unknown message ${JSON.stringify(exhaustive)}`,
        };
      }
    }
  } catch (err) {
    const requestId = msg.type === "fill" ? msg.requestId : -1;
    return {
      type: "error",
      requestId,
      error: err instanceof Error ? err.message : "vector worker failed",
    };
  }
}
