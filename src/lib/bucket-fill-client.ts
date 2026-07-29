/**
 * bucket-fill-client.ts — Manager for the bucket fill WebWorker.
 *
 * Provides `clientBucketFill()` that grabs the page canvas, sends it
 * to the worker via transferable ImageBitmap, and returns a Promise
 * with the polygon vertices.
 */

import type { BucketFillResult } from "@/workers/bucket-fill.worker";
import type { QueryClient } from "@tanstack/react-query";
import type { BucketFillMode } from "@/lib/bucket-fill-mode";
import { routeBucketFill } from "@/lib/bucket-fill-routing";
import { readGeometryEntry, isGeometryPending } from "@/queries/pageGeometryCache";
import { maskCacheKey } from "@/lib/oneclick-worker-core";
import {
  ensureVectorMask,
  vectorClientFill,
  isVectorRefusalError,
} from "@/lib/bucket-fill-vector-client";
import { MASK_DIM_DEFAULT } from "@/lib/bucket-fill-vector-limits";
import { reportBucketFill, setBucketFillPerfMode } from "@/lib/bucket-fill-perf";
import {
  decideBucketFillStatus,
  classifySheet,
  isRasterRetryPlausible,
  rasterRetryRejected,
  type StatusDecision,
  type VectorAttempt,
} from "@/lib/bucket-fill-status";

/**
 * The fill did not happen, and the user is being told why rather than handed another engine's
 * number.
 *
 * ⛔ **THE CALLER MUST NOT TREAT THIS AS A TRANSPORT FAILURE.** `tools/bucketFill.ts` catches a
 * rejected `clientBucketFill` and falls back to the SERVER raster path — which for a refusal would
 * fetch a number anyway and commit it, defeating the refusal completely while looking like it
 * worked. That is the exact silent-commit behaviour PLAN §5 phase 3 says no sheet class keeps.
 *
 * Brand-checked rather than `instanceof` for the same reason as `VectorRefusalError`: a duplicate
 * module copy must not silently downgrade a refusal into a fallback.
 */
export class BucketFillRefusedError extends Error {
  readonly isBucketFillRefusal = true as const;
  readonly decision: StatusDecision;

  constructor(decision: StatusDecision) {
    super(decision.message ?? "Bucket fill refused");
    this.name = "BucketFillRefusedError";
    this.decision = decision;
  }
}

export function isBucketFillRefusedError(e: unknown): e is BucketFillRefusedError {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { isBucketFillRefusal?: unknown }).isBucketFillRefusal === true
  );
}

let workerInstance: Worker | null = null;
let nextRequestId = 1;

function getWorker(): Worker {
  if (!workerInstance) {
    workerInstance = new Worker(
      new URL("../workers/bucket-fill.worker.ts", import.meta.url),
      { type: "module" }
    );
  }
  return workerInstance;
}

export interface ClientBucketFillOptions {
  tolerance: number;
  dilation: number;
  barriers: { x1: number; y1: number; x2: number; y2: number }[];
  polygonBarriers: { vertices: { x: number; y: number }[] }[];
  /** OCR text bounding boxes (normalized 0-1 [x, y, w, h]). Burned to passable
   *  before the flood so text inside rooms doesn't block the fill. */
  textBboxes?: { x: number; y: number; w: number; h: number }[];
  maxDimension?: number;
  /**
   * [bucketfill P2] Everything the vector path needs, passed down from the controller's press
   * scope. Optional so every existing caller and every test mock keeps working untouched.
   *
   * ⛔ DARK BY DEFAULT. `mode` comes from `resolveBucketFillMode()`, whose default is `raster`, so
   * `routeBucketFill` returns `raster` and this whole branch is unreachable until phase 3's env
   * flip. The wiring lands now so the flip is a one-line change rather than a feature.
   */
  vector?: {
    publicId: string;
    pageNumber: number;
    queryClient: QueryClient;
    mode: BucketFillMode;
    sensitivity: number;
  };
}

export interface ClientBucketFillSuccess {
  vertices: { x: number; y: number }[];
  holes: { vertices: { x: number; y: number }[] }[];
  holeCount: number;
  areaFraction: number;
  method: string;
  /**
   * A caveat that must be shown WITH this number — never instead of it, and never dropped.
   *
   * This is how "no sheet class keeps today's silent-commit behaviour" is honoured on the paths
   * that still produce an area: the vector engine said something the user should know (it leaked,
   * or the sheet is still being read) and raster answered anyway. Absent on an ordinary fill.
   */
  notice?: string;
  /**
   * Phase-2 dev instrumentation (PLAN §9 U1) — the worker's own stage timings, in MILLISECONDS.
   *
   * ⚠ PRESENT ON EVERY VECTOR FILL, PRODUCTION INCLUDED. The worker measures unconditionally
   * because gating inside it would require it to know the mode, which would cost it the pure
   * function-over-explicit-state property its header depends on; the cost is ~6 clock reads and
   * ~24 bytes of structured-clone payload per fill. What is dev-gated is the PRINTING, in
   * `bucket-fill-perf.ts` — the only consumer.
   *
   * ⛔ Do NOT spread this shape into a persisted annotation body. These are diagnostics, not data:
   * `POST /api/annotations` is deep-equal-pinned by `BucketFillCommitParity.test.tsx`, and a
   * timing that varies run to run has no business in a takeoff record.
   */
  msFlood?: number;
  msTrace?: number;
}

/**
 * Run bucket fill client-side using the page canvas.
 * Returns polygon vertices in normalized 0-1 coords.
 */
export async function clientBucketFill(
  pageCanvas: HTMLCanvasElement | null,
  seedPoint: { x: number; y: number },
  options: ClientBucketFillOptions
): Promise<ClientBucketFillSuccess> {
  // ── routing: vector first when this page qualifies, raster otherwise ──────
  //
  // ★ THE FALLBACK IS A `return` FROM A TRY, NOT A SEPARATE CODE PATH. Anything the vector attempt
  // cannot do — no cached geometry, a refusal, a wedged worker, a timeout — falls through to the
  // raster code below unchanged. That is what makes this safe to ship dark: the raster path is not
  // reached *through* the vector path, it simply still runs.
  let status: StatusDecision | null = null;

  if (options.vector) {
    const { publicId, pageNumber, queryClient, mode, sensitivity } = options.vector;
    // The perf table's second gate. The mode is resolved here, on the click path, so it is handed
    // over rather than re-read — a dev helper that reaches for `localStorage` itself is a dev
    // helper with real behaviour. See bucket-fill-perf.ts.
    setBucketFillPerfMode(mode);
    const entry = readGeometryEntry(queryClient, publicId, pageNumber);
    const decision = routeBucketFill({
      mode,
      entry,
      ocUnsafe: entry?.status === "ok" ? entry.geometry.ocUnsafe : false,
    });
    // A sheet we could not read is treated as pure-vector: that is the CONSERVATIVE side, because
    // `mixed` is the class that permits a raster retry after a leak verdict.
    const sheetClass =
      entry?.status === "ok" ? classifySheet(entry.geometry) : ("pure-vector" as const);
    const geometryPending = isGeometryPending(queryClient, publicId, pageNumber);

    if (decision.engine === "vector" && entry?.status === "ok") {
      const geo = entry.geometry;
      const key = maskCacheKey(publicId, pageNumber, MASK_DIM_DEFAULT, "vector");
      try {
        await ensureVectorMask(key, {
          segs: geo.segs,
          meta: geo.meta,
          imgW: geo.viewportWidth,
          imgH: geo.viewportHeight,
        });
        // The good path: a vector number, no caveat, nothing to say.
        const fill = await vectorClientFill(key, {
          seedX: seedPoint.x,
          seedY: seedPoint.y,
          sensitivity,
          barriers: options.barriers,
          polygonBarriers: options.polygonBarriers,
        });
        // Phase-2 dev instrumentation (PLAN §9 U1). This is the ONLY place that holds all four
        // stages at once — parse/walk were recorded per page by the geometry cache, the mask by the
        // transport client, and the flood/trace arrive on this very result. A no-op unless armed.
        //
        // ⛔ ITS OWN try/catch, AND THAT IS NOT DEFENSIVE PADDING. This call sits inside the try
        // whose catch classifies ANY throw as a vector-engine failure. A throw from a dev-only
        // console helper would therefore discard a SUCCESSFUL fill and route the user to a raster
        // retry or a refusal — instrumentation silently changing the product's answer, which is the
        // one thing it must never do.
        try {
          reportBucketFill({
            publicId,
            pageNumber,
            key,
            msFlood: fill.msFlood,
            msTrace: fill.msTrace,
            segCount: geo.segs.length / 4,
            status: "ok",
          });
        } catch {
          // A dev table that cannot print is not a reason to lose a measurement the user asked for.
        }
        return fill;
      } catch (e) {
        // ★ THE DISTINCTION THE WHOLE PHASE TURNS ON, and the only place it can be made: a coded
        // refusal is a VERDICT the engine reached; anything else is a failure it never got to.
        const attempt: VectorAttempt = isVectorRefusalError(e)
          ? { kind: "refused", refusal: e.code }
          : { kind: "error" };
        status = decideBucketFillStatus({ attempt, sheetClass, geometryPending });
        // A perf table that only shows successes hides the clicks worth looking at. A 1.5 s
        // timeout, a leak refusal on a huge sheet, a wedged worker — those ARE the slow ones, and
        // the mask may already have been paid before the failure. Own try/catch for the same
        // reason as the success path: this must not re-enter the classifier above.
        try {
          reportBucketFill({
            publicId,
            pageNumber,
            key,
            segCount: geo.segs.length / 4,
            status: isVectorRefusalError(e) ? `refused:${e.code}` : "error",
          });
        } catch {
          // ignored — see above
        }
      }
    } else if (decision.engine === "raster") {
      status = decideBucketFillStatus({
        attempt: { kind: "not-run", reason: decision.reason },
        sheetClass,
        geometryPending,
      });
    }

    // Refuse BEFORE the raster path runs. Doing it after would mean paying for a fill we have
    // already decided not to show — and, worse, having a number in hand at the moment of refusal.
    if (status && !status.retryRaster) throw new BucketFillRefusedError(status);
  }

  if (!pageCanvas) {
    throw new Error("Page canvas not available");
  }

  // Create ImageBitmap from the canvas (fast, no pixel copy)
  const bitmap = await createImageBitmap(pageCanvas);

  const worker = getWorker();
  const requestId = nextRequestId++;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      worker.removeEventListener("message", handler);
      reject(new Error("Bucket fill timed out (10s)"));
    }, 10000);

    function handler(e: MessageEvent<BucketFillResult>) {
      if (e.data.requestId !== requestId) return;
      clearTimeout(timeout);
      worker.removeEventListener("message", handler);
      const data = e.data;
      if (data.type === "result" && data.vertices && data.vertices.length >= 3) {
        const result: ClientBucketFillSuccess = {
          vertices: data.vertices,
          holes: data.holes ?? [],
          holeCount: data.holeCount ?? 0,
          areaFraction: data.areaFraction ?? 0,
          method: data.method || "client-raster",
        };

        // ★★ THE BACKSTOP, and it is scoped on purpose.
        //
        // It applies ONLY when the vector engine already said this space leaks and we retried
        // raster anyway. In that situation we have an independent verdict that the boundary is
        // open, so a raster fill covering a third of the sheet is not a room — it is the same
        // escape measured by an engine with no leak detection of its own. Both phase-0
        // confidently-wrong cases fail this decisively (`door-gap` and `e-size-hairline` each
        // return essentially the whole sheet).
        //
        // ⚠ Deliberately NOT applied to ordinary raster fills. Today's default engine is raster
        // for everyone, and adding a global plausibility gate here would change production
        // behaviour for every user while the vector path is still dark — a much larger change
        // than this phase is scoped to make, and one that belongs to phase 5's convergence.
        if (
          status?.code === "vector-leak-raster-retry" &&
          !isRasterRetryPlausible(result.areaFraction)
        ) {
          reject(new BucketFillRefusedError(rasterRetryRejected()));
          return;
        }

        resolve(status?.message ? { ...result, notice: status.message } : result);
      } else {
        reject(new Error(data.error || "Bucket fill returned no result"));
      }
    }

    worker.addEventListener("message", handler);

    // Send via transferable (zero-copy). A synchronous clone/worker failure must retire this
    // request's listener immediately; otherwise a later response could keep a dead closure alive.
    try {
      worker.postMessage(
        {
          requestId,
          imageBitmap: bitmap,
          seedX: seedPoint.x,
          seedY: seedPoint.y,
          tolerance: options.tolerance,
          dilation: options.dilation,
          barriers: options.barriers,
          polygonBarriers: options.polygonBarriers,
          textBboxes: options.textBboxes,
          maxDimension: options.maxDimension ?? 1000,
        },
        [bitmap] // transfer ownership
      );
    } catch (error) {
      clearTimeout(timeout);
      worker.removeEventListener("message", handler);
      reject(error);
    }
  });
}

/**
 * Find the page canvas in the DOM via data attribute set on PDFPage's canvas.
 * Returns null if not found.
 */
export function findPageCanvas(): HTMLCanvasElement | null {
  return document.querySelector<HTMLCanvasElement>("canvas[data-page-canvas]");
}
