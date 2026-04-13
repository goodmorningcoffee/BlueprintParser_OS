/**
 * bucket-fill-client.ts — Manager for the bucket fill WebWorker.
 *
 * Provides `clientBucketFill()` that grabs the page canvas, sends it
 * to the worker via transferable ImageBitmap, and returns a Promise
 * with the polygon vertices.
 */

import type { BucketFillResult } from "@/workers/bucket-fill.worker";

let workerInstance: Worker | null = null;

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
  /** Max accepted net-area fraction before a fill is a leak. 0.05–0.95, default 0.25. */
  leakThreshold?: number;
  barriers: { x1: number; y1: number; x2: number; y2: number }[];
  polygonBarriers: { vertices: { x: number; y: number }[] }[];
  maxDimension?: number;
}

export interface ClientBucketFillSuccess {
  vertices: { x: number; y: number }[];
  holes: { vertices: { x: number; y: number }[] }[];
  holeCount: number;
  areaFraction: number;
  method: string;
  retryHistory: BucketFillResult["retryHistory"];
  leakThreshold: number;
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
  if (!pageCanvas) {
    throw new Error("Page canvas not available");
  }

  // Create ImageBitmap from the canvas (fast, no pixel copy)
  const bitmap = await createImageBitmap(pageCanvas);

  const worker = getWorker();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Bucket fill timed out (10s)"));
    }, 10000);

    function handler(e: MessageEvent<BucketFillResult>) {
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
          retryHistory: data.retryHistory,
          leakThreshold: data.leakThreshold ?? 0.25,
        });
      } else {
        reject(new Error(data.error || "Bucket fill returned no result"));
      }
    }

    worker.addEventListener("message", handler);

    // Send via transferable (zero-copy)
    worker.postMessage(
      {
        imageBitmap: bitmap,
        seedX: seedPoint.x,
        seedY: seedPoint.y,
        tolerance: options.tolerance,
        dilation: options.dilation,
        leakThreshold: options.leakThreshold ?? 0.25,
        barriers: options.barriers,
        polygonBarriers: options.polygonBarriers,
        maxDimension: options.maxDimension ?? 1000,
      },
      [bitmap] // transfer ownership
    );
  });
}

/**
 * Find the page canvas in the DOM via data attribute set on PDFPage's canvas.
 * Returns null if not found.
 */
export function findPageCanvas(): HTMLCanvasElement | null {
  return document.querySelector<HTMLCanvasElement>("canvas[data-page-canvas]");
}
