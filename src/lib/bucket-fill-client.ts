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
import { readGeometryEntry } from "@/queries/pageGeometryCache";
import { maskCacheKey } from "@/lib/oneclick-worker-core";
import { ensureVectorMask, vectorClientFill } from "@/lib/bucket-fill-vector-client";
import { MASK_DIM_DEFAULT } from "@/lib/bucket-fill-vector-limits";

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
  if (options.vector) {
    const { publicId, pageNumber, queryClient, mode, sensitivity } = options.vector;
    const entry = readGeometryEntry(queryClient, publicId, pageNumber);
    const decision = routeBucketFill({
      mode,
      entry,
      ocUnsafe: entry?.status === "ok" ? entry.geometry.ocUnsafe : false,
    });
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
        return await vectorClientFill(key, {
          seedX: seedPoint.x,
          seedY: seedPoint.y,
          sensitivity,
          barriers: options.barriers,
          polygonBarriers: options.polygonBarriers,
        });
      } catch {
        // Deliberately silent. Phase 3 owns the status model that decides when a vector refusal
        // should be SHOWN (a `leak` on a pure-vector sheet must offer the barrier tool rather than
        // quietly returning a raster number). Until then, falling back is the whole behaviour, and
        // announcing it would be announcing something the user cannot act on.
      }
    }
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
        resolve({
          vertices: data.vertices,
          holes: data.holes ?? [],
          holeCount: data.holeCount ?? 0,
          areaFraction: data.areaFraction ?? 0,
          method: data.method || "client-raster",
        });
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
