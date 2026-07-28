/**
 * The raster-retry backstop, WIRED — the last line of "no sheet class keeps today's silent-commit
 * behaviour" (PLAN §5 phase 3).
 *
 * ── WHY THIS SUITE EXISTS SEPARATELY ────────────────────────────────────────────────────
 * `isRasterRetryPlausible` has unit tests, and the status model has unit tests, and both were
 * green while this path was **not connected to anything** — that is exactly the gap a unit test
 * cannot see. The claim under test here is end-to-end and behavioural:
 *
 *   the vector engine says this space LEAKS  →  the sheet is mixed, so raster gets a turn  →
 *   raster returns a third of the sheet      →  we REFUSE rather than hand over the number.
 *
 * Both phase-0 confidently-wrong-number cases live in that last step: `door-gap` (legacy returned
 * 963,687 pt² for a 142,100 pt² room, status `ok`) and `e-size-hairline` (legacy returned
 * 8,946,545 of 8,957,952 pt²). The vector engine had already refused both. Without this check the
 * retry hands back precisely the number the port exists to stop shipping.
 *
 * The vector side is driven through the REAL transport via `__setVectorWorkerFactory`, not a mocked
 * module, so the refusal travels the same coded path production uses.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/queries/queryKeys";
import type { PageGeometryEntry } from "@/queries/pageGeometryCache";
import { VECTOR_REFUSALS } from "@/lib/bucket-fill-vector-adapter";
import type { OneclickResponse } from "@/lib/oneclick-worker-core";

const PUBLIC_ID = "P";
const PAGE = 1;
const TRIANGLE = [
  { x: 0.1, y: 0.1 },
  { x: 0.4, y: 0.1 },
  { x: 0.1, y: 0.4 },
];

/** Raster worker stand-in — the same shape `bucket-fill-client.ts` constructs via `new Worker`. */
class FakeRasterWorker {
  static instances: FakeRasterWorker[] = [];
  readonly posted: { requestId: number }[] = [];
  private readonly listeners = new Set<(e: MessageEvent<unknown>) => void>();
  constructor() { FakeRasterWorker.instances.push(this); }
  addEventListener(t: string, l: (e: MessageEvent<unknown>) => void) {
    if (t === "message") this.listeners.add(l);
  }
  removeEventListener(t: string, l: (e: MessageEvent<unknown>) => void) {
    this.listeners.delete(l);
  }
  postMessage(message: unknown) { this.posted.push(message as { requestId: number }); }
  emit(data: unknown) {
    const event = new MessageEvent("message", { data });
    for (const l of [...this.listeners]) l(event);
  }
  static current() { return FakeRasterWorker.instances[FakeRasterWorker.instances.length - 1]; }
}

/** Vector worker stand-in: acknowledges the mask, then refuses the fill with a coded verdict. */
class LeakingVectorWorker {
  static instances: LeakingVectorWorker[] = [];
  private readonly listeners = new Set<(e: MessageEvent<OneclickResponse>) => void>();
  constructor() { LeakingVectorWorker.instances.push(this); }
  addEventListener(_t: "message", l: (e: MessageEvent<OneclickResponse>) => void) {
    this.listeners.add(l);
  }
  removeEventListener(_t: "message", l: (e: MessageEvent<OneclickResponse>) => void) {
    this.listeners.delete(l);
  }
  postMessage(message: { type: string; key?: string; requestId?: number }) {
    // Reply on a microtask so the client has registered its listener first.
    void Promise.resolve().then(() => {
      if (message.type === "mask") {
        this.emit({ type: "mask-ready", key: message.key!, maskBytes: 16 });
      } else if (message.type === "fill") {
        this.emit({
          type: "error",
          requestId: message.requestId!,
          error: VECTOR_REFUSALS.leak,
          code: "leak",
          method: "client-vector",
        });
      }
    });
  }
  emit(data: OneclickResponse) {
    for (const l of [...this.listeners]) l({ data } as MessageEvent<OneclickResponse>);
  }
}

/**
 * A MIXED sheet: substantial placed imagery, so a leak verdict earns raster a turn.
 * (A pure-vector sheet would refuse outright and never reach the backstop — covered below.)
 */
function mixedSheetEntry(imageFraction: number): PageGeometryEntry {
  const w = 1000;
  const h = 1000;
  return {
    status: "ok",
    geometry: {
      segs: Array.from({ length: 4000 }, (_, i) => i % 997),
      meta: new Uint8Array(1000),
      points: [],
      pointsDropped: true,
      imageArea: imageFraction * w * h,
      viewportWidth: w,
      viewportHeight: h,
      scale: 1,
      pageWidthPt: w,
      pageHeightPt: h,
      ocUnsafe: false,
    },
  } as PageGeometryEntry;
}

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("★ the raster retry is judged, not trusted", () => {
  beforeEach(() => {
    vi.resetModules();
    FakeRasterWorker.instances = [];
    LeakingVectorWorker.instances = [];
    vi.stubGlobal("Worker", FakeRasterWorker);
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 100, height: 100 }) as ImageBitmap),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function runLeakThenRaster(opts: {
    imageFraction: number;
    rasterAreaFraction: number;
  }) {
    const client = await import("@/lib/bucket-fill-client");
    const vectorClient = await import("@/lib/bucket-fill-vector-client");
    vectorClient.__setVectorWorkerFactory(() => new LeakingVectorWorker());

    const qc = new QueryClient();
    qc.setQueryData(
      queryKeys.pageGeometry.page(PUBLIC_ID, PAGE),
      mixedSheetEntry(opts.imageFraction),
    );

    const promise = client.clientBucketFill(
      document.createElement("canvas"),
      { x: 0.25, y: 0.25 },
      {
        tolerance: 30,
        dilation: 3,
        barriers: [],
        polygonBarriers: [],
        vector: {
          publicId: PUBLIC_ID,
          pageNumber: PAGE,
          queryClient: qc,
          mode: "vector",
          sensitivity: 0.5,
        },
      },
    );

    // Let the vector attempt run and refuse, then the raster path spin up.
    await flush();
    const worker = FakeRasterWorker.current();
    if (worker && worker.posted.length > 0) {
      worker.emit({
        requestId: worker.posted[0].requestId,
        type: "result",
        vertices: TRIANGLE,
        holes: [],
        holeCount: 0,
        areaFraction: opts.rasterAreaFraction,
        method: "client-raster",
      });
    }
    return { promise, rasterRan: Boolean(worker && worker.posted.length > 0), client };
  }

  it("REFUSES when the retry floods a third of the sheet — the door-gap shape", async () => {
    const { promise, rasterRan, client } = await runLeakThenRaster({
      imageFraction: 0.5,
      rasterAreaFraction: 0.99, // essentially the whole sheet, exactly what legacy returned
    });
    expect(rasterRan).toBe(true);

    await expect(promise).rejects.toSatisfy((e: unknown) =>
      client.isBucketFillRefusedError(e),
    );
    await promise.catch((e: unknown) => {
      const decision = (e as InstanceType<typeof client.BucketFillRefusedError>).decision;
      expect(decision.retryRaster).toBe(false);
      expect(decision.tone).toBe("error");
      // The barrier is the genuine remedy when both engines lose the fill.
      expect(decision.offerBarrier).toBe(true);
      // ★ WHICH refusal fired matters, and asserting only tone/offerBarrier cannot tell: the
      // pure-vector leak refusal has the same pair. This message is emitted ONLY by
      // `rasterRetryRejected()`, so it proves the retry ran and was then judged — rather than the
      // request having been refused before raster was ever asked.
      expect(decision.message).toMatch(/Neither engine/);
      expect(decision.message).not.toBe(VECTOR_REFUSALS.leak);
    });
  });

  it("ACCEPTS a plausible retry — but the caveat rides with it", async () => {
    const { promise, rasterRan } = await runLeakThenRaster({
      imageFraction: 0.5,
      rasterAreaFraction: 0.12, // an ordinary room
    });
    expect(rasterRan).toBe(true);

    const result = await promise;
    expect(result.areaFraction).toBe(0.12);
    expect(result.method).toBe("client-raster");
    // ★ The number arrives WITH its caveat. A bare result here would be the silent commit.
    expect(result.notice).toBeTruthy();
  });

  it("exactly at the threshold is still acceptable — the boundary is inclusive", async () => {
    const { promise } = await runLeakThenRaster({
      imageFraction: 0.5,
      rasterAreaFraction: 0.3,
    });
    const result = await promise;
    expect(result.areaFraction).toBe(0.3);
    expect(result.notice).toBeTruthy();
  });

  it("★ a PURE-VECTOR sheet never reaches the retry at all", async () => {
    const { promise, rasterRan, client } = await runLeakThenRaster({
      imageFraction: 0.0144, // the VA sheet's measured title-block decoration
      rasterAreaFraction: 0.12,
    });
    // Raster is not asked. On a pure-vector sheet the engine has seen everything there is to see,
    // so a retry would only re-render the same linework and flood that.
    expect(rasterRan).toBe(false);
    await expect(promise).rejects.toSatisfy((e: unknown) =>
      client.isBucketFillRefusedError(e),
    );
    await promise.catch((e: unknown) => {
      const decision = (e as InstanceType<typeof client.BucketFillRefusedError>).decision;
      expect(decision.message).toBe(VECTOR_REFUSALS.leak);
      expect(decision.offerBarrier).toBe(true);
    });
  });
});
