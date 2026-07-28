/**
 * bucket-fill-vector-client.ts — main-thread transport for worker #2.
 *
 * Mirrors `bucket-fill-client.ts`'s request-correlation discipline exactly, because that discipline
 * is load-bearing and already has a race suite pinning it: **one listener per request, removed on
 * every exit path** — settle, timeout, and synchronous `postMessage` failure. A listener that
 * outlives its request keeps a dead closure alive and can resolve a promise nobody is waiting on.
 *
 * ── ⚠⚠ TRANSFERABLES DETACH. NEVER TRANSFER THE CACHE'S OWN BUFFERS. ────────────────────
 * The whole point of the `mask` message is to hand the geometry over without a copy. But the
 * geometry lives in `pageGeometryCache` and is read again on **every** click. Transferring
 * `geo.meta` directly would detach it, and the cache would silently hold a zero-length array — the
 * next click on that page would build a mask from nothing and refuse, with no error naming the
 * cause.
 *
 * So this module builds **fresh** typed arrays from the cached geometry and transfers those.
 * `segs` is a plain `number[]` upstream, so converting it to `Float64Array` is a copy regardless;
 * `meta` is copied explicitly. That is **one copy per PAGE, not per click**, which is exactly the
 * trade `mask`/`fill` exists to make.
 *
 * ── WHY MASK READINESS IS A PROMISE MAP ─────────────────────────────────────────────────
 * Two clicks on a fresh page can race. Keyed on a `Promise`, the second click awaits the first
 * click's in-flight `mask` instead of sending a second one — which would rebuild a ~9 MB mask and,
 * worse, transfer a second set of buffers for geometry the worker already has.
 */

import type { ClientBucketFillSuccess } from "@/lib/bucket-fill-client";
import {
  VECTOR_FILL_TIMEOUT_MS,
  type OneclickRequest,
  type OneclickResponse,
} from "@/lib/oneclick-worker-core";
import type { VectorRefusal } from "@/lib/bucket-fill-vector-adapter";

/**
 * The engine ran and reached a conclusion — as distinct from the engine failing to run.
 *
 * ★ A SUBCLASS RATHER THAN A FIELD ON `Error`, so that `catch` sites which do not care keep working
 * unchanged (it *is* an Error, with the same human-readable `message`), while the one site that
 * does care can ask a single honest question. The status model's entire premise is that these two
 * outcomes deserve opposite treatment: a verdict may be worth refusing on, a failure never is.
 *
 * ⚠ `instanceof` is deliberately NOT the test — see {@link isVectorRefusalError}.
 */
export class VectorRefusalError extends Error {
  /** Structural brand: survives bundling, duplicate module instances and `instanceof` realms. */
  readonly isVectorRefusal = true as const;
  readonly code: VectorRefusal;

  constructor(code: VectorRefusal, message: string) {
    super(message);
    this.name = "VectorRefusalError";
    this.code = code;
  }
}

/**
 * Is this thrown value a vector VERDICT?
 *
 * ⚠ Brand check, not `instanceof`. `instanceof` fails across realms and across duplicate copies of
 * a module — and this class is thrown inside a worker-transport path and caught in an app module,
 * which is precisely where a bundler is most likely to produce two copies. A false negative here
 * would silently downgrade every refusal to "a failure", restoring exactly the silent-fallback
 * behaviour this work exists to remove — and nothing would break loudly enough to notice.
 */
export function isVectorRefusalError(e: unknown): e is VectorRefusalError {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { isVectorRefusal?: unknown }).isVectorRefusal === true &&
    typeof (e as { code?: unknown }).code === "string"
  );
}

/** Minimal structural type — lets tests inject a fake without a DOM Worker. */
export interface VectorWorkerLike {
  addEventListener(type: "message", listener: (e: MessageEvent<OneclickResponse>) => void): void;
  removeEventListener(type: "message", listener: (e: MessageEvent<OneclickResponse>) => void): void;
  postMessage(message: OneclickRequest, transfer?: Transferable[]): void;
  terminate?(): void;
}

let workerInstance: VectorWorkerLike | null = null;
let nextRequestId = 1;

/** Keyed by mask key. Resolves when the worker holds that mask; rejects if it could not build it. */
const maskReady = new Map<string, Promise<void>>();

function defaultWorker(): VectorWorkerLike {
  return new Worker(new URL("../workers/oneclick.worker.ts", import.meta.url), {
    type: "module",
  }) as unknown as VectorWorkerLike;
}

let workerFactory: () => VectorWorkerLike = defaultWorker;

function getWorker(): VectorWorkerLike {
  if (!workerInstance) workerInstance = workerFactory();
  return workerInstance;
}

/** Test seam. Never called by product code. */
export function __setVectorWorkerFactory(factory: (() => VectorWorkerLike) | null): void {
  workerFactory = factory ?? defaultWorker;
  workerInstance = null;
  maskReady.clear();
  nextRequestId = 1;
}

export interface VectorMaskInput {
  /** Plain `number[]`, as `VectorGeometry` carries it. Converted to Float64Array here. */
  segs: readonly number[];
  /** Owned by the geometry cache — COPIED before transfer, never transferred directly. */
  meta: Uint8Array;
  imgW: number;
  imgH: number;
  maskDimension?: number;
}

/**
 * Ensure the worker holds the mask for `key`. Idempotent, and safe to call concurrently.
 *
 * Rejects if the worker could not build one (no geometry, no page dimensions). A rejection is a
 * routing signal, not a crash: the caller falls back to raster.
 */
export function ensureVectorMask(key: string, input: VectorMaskInput): Promise<void> {
  const existing = maskReady.get(key);
  if (existing) return existing;

  const worker = getWorker();
  const pending = new Promise<void>((resolve, reject) => {
    function handler(e: MessageEvent<OneclickResponse>) {
      const data = e.data;
      if (data.type === "mask-ready") {
        if (data.key !== key) return;
        worker.removeEventListener("message", handler);
        resolve();
        return;
      }
      if (data.type === "mask-error") {
        if (data.key !== key) return;
        worker.removeEventListener("message", handler);
        // Carries a code for the same reason `fill` does. These two (`no-page`, `no-geometry`) are
        // non-verdict refusals that the status model routes to a silent fallback — but it should
        // reach that conclusion by reading the code, not by failing to find one.
        reject(
          data.code ? new VectorRefusalError(data.code, data.error) : new Error(data.error),
        );
      }
      // Anything else (a concurrent `result`) belongs to another listener. Ignore it.
    }
    worker.addEventListener("message", handler);

    try {
      // ⚠ Fresh buffers — see the header. Transferring the cache's own arrays would detach them.
      const segs = Float64Array.from(input.segs);
      const meta = input.meta.slice();
      worker.postMessage(
        {
          type: "mask",
          key,
          segs,
          meta,
          imgW: input.imgW,
          imgH: input.imgH,
          maskDimension: input.maskDimension,
        },
        [segs.buffer, meta.buffer],
      );
    } catch (error) {
      worker.removeEventListener("message", handler);
      reject(error);
    }
  });

  // Drop a failed attempt so a later click can retry; a page can fail to build a mask for a
  // transient reason (the geometry arrived empty because the cache was mid-eviction).
  const tracked = pending.catch((error) => {
    maskReady.delete(key);
    throw error;
  });
  maskReady.set(key, tracked);
  return tracked;
}

export interface VectorFillOptions {
  seedX: number;
  seedY: number;
  sensitivity?: number;
  barriers?: { x1: number; y1: number; x2: number; y2: number }[];
  polygonBarriers?: { vertices: { x: number; y: number }[] }[];
  epsMaskPx?: number;
  /** Overridable for tests; product code uses the constant beside the work it bounds. */
  timeoutMs?: number;
}

/**
 * One click. Assumes `ensureVectorMask` already resolved for this key.
 *
 * Correlation is by `requestId` and the listener is removed on **every** exit — settle, timeout,
 * and synchronous post failure. Those are the properties the legacy race suite pins, and they are
 * mirrored here rather than reinvented.
 */
export function vectorClientFill(
  key: string,
  options: VectorFillOptions,
): Promise<ClientBucketFillSuccess> {
  const worker = getWorker();
  const requestId = nextRequestId++;
  const timeoutMs = options.timeoutMs ?? VECTOR_FILL_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      worker.removeEventListener("message", handler);
      reject(new Error(`Vector bucket fill timed out (${timeoutMs}ms)`));
    }, timeoutMs);

    function handler(e: MessageEvent<OneclickResponse>) {
      const data = e.data;
      // Mask lifecycle messages carry no requestId and belong to another listener.
      if (data.type !== "result" && data.type !== "error") return;
      if (data.requestId !== requestId) return;

      clearTimeout(timeout);
      worker.removeEventListener("message", handler);

      // Fail closed on a malformed success: a `result` without a usable polygon is not a result.
      if (data.type === "result" && Array.isArray(data.vertices) && data.vertices.length >= 3) {
        resolve({
          vertices: data.vertices,
          holes: data.holes ?? [],
          holeCount: data.holeCount ?? 0,
          areaFraction: data.areaFraction ?? 0,
          method: data.method || "client-vector",
        });
        return;
      }
      // ★ A REFUSAL AND A FAILURE LEAVE BY THE SAME DOOR, SO THE VERDICT HAS TO RIDE ALONG.
      // Both reject; only one of them is the engine telling us something true about this room. The
      // status model cannot distinguish them from an `Error` alone, and recovering the verdict by
      // matching the message text is exactly what VECTOR_REFUSALS-as-a-table exists to prevent.
      if (data.type === "error" && data.code) {
        reject(new VectorRefusalError(data.code, data.error));
        return;
      }
      reject(
        new Error(
          data.type === "error" ? data.error : "Vector bucket fill returned no polygon",
        ),
      );
    }

    worker.addEventListener("message", handler);

    try {
      worker.postMessage({
        type: "fill",
        key,
        requestId,
        seedX: options.seedX,
        seedY: options.seedY,
        sensitivity: options.sensitivity,
        barriers: options.barriers,
        polygonBarriers: options.polygonBarriers,
        epsMaskPx: options.epsMaskPx,
      });
    } catch (error) {
      clearTimeout(timeout);
      worker.removeEventListener("message", handler);
      reject(error);
    }
  });
}

/**
 * Drop a mask the worker is holding — or all of them when `key` is omitted (project teardown).
 *
 * Fire-and-forget: there is nothing useful to await, and a teardown that can reject would have to
 * be handled at every call site for no benefit. Local readiness is cleared synchronously so a
 * subsequent click re-sends `mask` rather than filling against one the worker no longer has.
 */
export function evictVectorMask(key?: string): void {
  if (!workerInstance) {
    // Nothing was ever sent. Clearing local state is still correct and costs nothing.
    if (key === undefined) maskReady.clear();
    else maskReady.delete(key);
    return;
  }
  if (key === undefined) maskReady.clear();
  else maskReady.delete(key);
  try {
    workerInstance.postMessage(key === undefined ? { type: "evict" } : { type: "evict", key });
  } catch {
    // A dead worker cannot hold a stale mask, so a failed evict is not a problem worth surfacing.
  }
}
