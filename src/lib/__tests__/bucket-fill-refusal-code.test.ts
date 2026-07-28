// @vitest-environment node
/**
 * The refusal CODE across the worker boundary — the precondition the status model needs.
 *
 * ── WHY THIS SUITE EXISTS ───────────────────────────────────────────────────────────────
 * `bucket-fill-status.ts` decides whether a vector refusal should be shown, and its whole premise
 * is that **a verdict is not a failure**: `leak`/`tiny`/`boundary` mean the engine ran and
 * concluded something true about this room, while a wedged worker or an evicted mask means it
 * concluded nothing. Those deserve opposite treatment — one may refuse and offer the barrier tool,
 * the other must fall back silently.
 *
 * But both leave the worker as `{type:"error"}` and arrive on the main thread as a rejected
 * promise. Before this change the ONLY surviving difference was the human-readable message, and
 * recovering a verdict by matching prose is exactly what `VECTOR_REFUSALS` being an exported table
 * exists to prevent — the first person to improve the wording would silently turn every refusal
 * into a fallback, and no test would fail.
 *
 * So: the code travels, and this suite is what stops it being dropped again.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  handleOneclickMessage,
  createWorkerState,
  maskCacheKey,
  type OneclickWorkerState,
  type OneclickResponse,
  type OneclickRequest,
} from "@/lib/oneclick-worker-core";
import {
  vectorBucketFill,
  VECTOR_REFUSALS,
  type VectorRefusal,
} from "@/lib/bucket-fill-vector-adapter";
import {
  vectorClientFill,
  ensureVectorMask,
  evictVectorMask,
  VectorRefusalError,
  isVectorRefusalError,
  __setVectorWorkerFactory,
  type VectorWorkerLike,
} from "@/lib/bucket-fill-vector-client";

const IMG_W = 1000;
const IMG_H = 800;
const ROOM = { x0: 200, y0: 150, x1: 700, y1: 600 };
const KEY = maskCacheKey("proj", 1, 3000, "vector");

function roomGeometry() {
  const { x0, y0, x1, y1 } = ROOM;
  const segs = Float64Array.from([
    x0, y0, x1, y0,
    x1, y0, x1, y1,
    x1, y1, x0, y1,
    x0, y1, x0, y0,
  ]);
  const meta = new Uint8Array([1 << 4, 1 << 4, 1 << 4, 1 << 4]);
  return { segs, meta };
}

let state: OneclickWorkerState;
beforeEach(() => {
  state = createWorkerState();
});

const codeOf = (r: OneclickResponse): VectorRefusal | undefined =>
  r.type === "error" || r.type === "mask-error" ? r.code : undefined;

describe("the worker emits a CODE beside the prose", () => {
  it("mask: no segments ⇒ no-geometry, no page size ⇒ no-page", () => {
    const noSegs = handleOneclickMessage(state, {
      type: "mask", key: KEY, segs: new Float64Array(0), meta: new Uint8Array(0),
      imgW: IMG_W, imgH: IMG_H,
    });
    expect(noSegs.type).toBe("mask-error");
    expect(codeOf(noSegs)).toBe("no-geometry");

    const { segs, meta } = roomGeometry();
    const noPage = handleOneclickMessage(state, {
      type: "mask", key: KEY, segs, meta, imgW: 0, imgH: IMG_H,
    });
    expect(codeOf(noPage)).toBe("no-page");
  });

  it("fill against a key the worker never received ⇒ no-geometry", () => {
    const res = handleOneclickMessage(state, {
      type: "fill", key: KEY, requestId: 1, seedX: 0.5, seedY: 0.5,
    });
    expect(codeOf(res)).toBe("no-geometry");
  });

  it("★ a real FLOOD verdict travels, and a good click carries no code at all", () => {
    const { segs, meta } = roomGeometry();
    const seedAt = (x: number, y: number) => {
      const s = createWorkerState();
      handleOneclickMessage(s, {
        type: "mask", key: KEY, segs: segs.slice(), meta: meta.slice(), imgW: IMG_W, imgH: IMG_H,
      });
      return handleOneclickMessage(s, {
        type: "fill", key: KEY, requestId: 7, seedX: x / IMG_W, seedY: y / IMG_H,
      });
    };

    // Inside the room: a real polygon, and NO code — the code is not stamped unconditionally.
    const inside = seedAt((ROOM.x0 + ROOM.x1) / 2, (ROOM.y0 + ROOM.y1) / 2);
    expect(inside.type).toBe("result");
    expect(codeOf(inside)).toBeUndefined();

    // Outside it: the flood escapes across the sheet and the ENGINE says so. This code comes from
    // `flood.status`, not from a handler branch — which is what makes it a verdict.
    const outside = seedAt(50, 50);
    expect(outside.type).toBe("error");
    expect(codeOf(outside)).toBe("leak");
    expect(outside.type === "error" && outside.error).toBe(VECTOR_REFUSALS.leak);
  });

  it("⚠ a seed exactly ON the wall leaks here — measured, and NOT the `boundary` case", () => {
    // Recorded because the obvious guess is wrong and cost a test rewrite: seeding on the wall of a
    // LONE rectangle lands in the unbounded exterior, which is a leak, not a boundary hit.
    // `boundary` needs the seed to land on a mask pixel that is actually marked as wall — this
    // fixture's 1 px stroke at canonical scale does not reliably cover the seed. A fixture that
    // wants `boundary` must be built for it rather than assumed into existence.
    const { segs, meta } = roomGeometry();
    handleOneclickMessage(state, {
      type: "mask", key: KEY, segs, meta, imgW: IMG_W, imgH: IMG_H,
    });
    const onWall = handleOneclickMessage(state, {
      type: "fill", key: KEY, requestId: 8,
      seedX: ROOM.x0 / IMG_W, seedY: ((ROOM.y0 + ROOM.y1) / 2) / IMG_H,
    });
    expect(codeOf(onWall)).toBe("leak");
  });

  it("every code the worker emits is a real VECTOR_REFUSALS key", () => {
    const responses: OneclickResponse[] = [
      handleOneclickMessage(state, {
        type: "mask", key: KEY, segs: new Float64Array(0), meta: new Uint8Array(0),
        imgW: IMG_W, imgH: IMG_H,
      }),
      handleOneclickMessage(state, {
        type: "fill", key: KEY, requestId: 2, seedX: 0.5, seedY: 0.5,
      }),
    ];
    for (const r of responses) {
      const code = codeOf(r);
      expect(code).toBeDefined();
      expect(Object.keys(VECTOR_REFUSALS)).toContain(code);
      // The prose and the code must describe the SAME refusal — a mismatched pair would show the
      // user one thing and route on another.
      if (r.type === "error" || r.type === "mask-error") {
        expect(r.error).toBe(VECTOR_REFUSALS[code as VectorRefusal]);
      }
    }
  });
});

describe("the adapter emits a CODE beside the prose", () => {
  const geo = { segs: [] as number[], meta: new Uint8Array(0), points: [], imageArea: 0 };

  it("no page dimensions ⇒ no-page", () => {
    const out = vectorBucketFill({ geo, imgW: 0, imgH: 0, seedX: 0.5, seedY: 0.5 });
    expect(out.type).toBe("error");
    expect(out.code).toBe("no-page");
    expect(out.error).toBe(VECTOR_REFUSALS["no-page"]);
  });

  it("no linework ⇒ no-geometry", () => {
    const out = vectorBucketFill({ geo, imgW: IMG_W, imgH: IMG_H, seedX: 0.5, seedY: 0.5 });
    expect(out.code).toBe("no-geometry");
    expect(out.error).toBe(VECTOR_REFUSALS["no-geometry"]);
  });
});

// ── transport ───────────────────────────────────────────────────────────────
type Listener = (e: MessageEvent<OneclickResponse>) => void;

class FakeWorker implements VectorWorkerLike {
  static instances: FakeWorker[] = [];
  readonly posted: OneclickRequest[] = [];
  private readonly listeners = new Set<Listener>();
  constructor() { FakeWorker.instances.push(this); }
  addEventListener(_t: "message", l: Listener) { this.listeners.add(l); }
  removeEventListener(_t: "message", l: Listener) { this.listeners.delete(l); }
  postMessage(message: OneclickRequest) { this.posted.push(message); }
  emit(data: OneclickResponse) {
    for (const l of [...this.listeners]) l({ data } as MessageEvent<OneclickResponse>);
  }
  static current() { return FakeWorker.instances[FakeWorker.instances.length - 1]; }
}

describe("the transport turns a coded error into a typed refusal", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    __setVectorWorkerFactory(() => new FakeWorker());
  });
  afterEach(() => {
    evictVectorMask();
    __setVectorWorkerFactory(null);
  });

  async function readyMask() {
    const p = ensureVectorMask(KEY, {
      segs: [0, 0, 1, 1], meta: new Uint8Array([1 << 4]), imgW: IMG_W, imgH: IMG_H,
    });
    FakeWorker.current().emit({ type: "mask-ready", key: KEY, maskBytes: 1 });
    await p;
  }

  it("★ a coded fill error rejects with VectorRefusalError carrying the code", async () => {
    await readyMask();
    const p = vectorClientFill(KEY, { seedX: 0.5, seedY: 0.5 });
    FakeWorker.current().emit({
      type: "error", requestId: 1, error: VECTOR_REFUSALS.leak, code: "leak",
      method: "client-vector",
    });
    await expect(p).rejects.toThrow(VECTOR_REFUSALS.leak);
    await p.catch((e: unknown) => {
      expect(isVectorRefusalError(e)).toBe(true);
      expect((e as VectorRefusalError).code).toBe("leak");
    });
  });

  it("an UNCODED error stays an ordinary Error — a failure, not a verdict", async () => {
    await readyMask();
    const p = vectorClientFill(KEY, { seedX: 0.5, seedY: 0.5 });
    FakeWorker.current().emit({
      type: "error", requestId: 1, error: "worker exploded",
    });
    await p.catch((e: unknown) => {
      expect(e).toBeInstanceOf(Error);
      expect(isVectorRefusalError(e)).toBe(false);
    });
  });

  it("a malformed success is still a failure, not a verdict", async () => {
    await readyMask();
    const p = vectorClientFill(KEY, { seedX: 0.5, seedY: 0.5 });
    FakeWorker.current().emit({
      type: "result", requestId: 1, vertices: [{ x: 0, y: 0 }], holes: [], holeCount: 0,
      areaFraction: 0.1, method: "client-vector",
    });
    await p.catch((e: unknown) => expect(isVectorRefusalError(e)).toBe(false));
  });

  it("a coded mask error also rejects as a typed refusal", async () => {
    const p = ensureVectorMask(KEY, {
      segs: [], meta: new Uint8Array(0), imgW: IMG_W, imgH: IMG_H,
    });
    FakeWorker.current().emit({
      type: "mask-error", key: KEY, error: VECTOR_REFUSALS["no-geometry"], code: "no-geometry",
    });
    await p.catch((e: unknown) => {
      expect(isVectorRefusalError(e)).toBe(true);
      expect((e as VectorRefusalError).code).toBe("no-geometry");
    });
  });
});

describe("★ isVectorRefusalError is a BRAND check, not instanceof", () => {
  it("accepts a structurally-identical object from a duplicate module copy", () => {
    // What a second bundled copy of this module produces: same shape, different class identity.
    const fromAnotherCopy = Object.assign(new Error(VECTOR_REFUSALS.leak), {
      isVectorRefusal: true as const,
      code: "leak",
    });
    expect(fromAnotherCopy instanceof VectorRefusalError).toBe(false);
    // ★ The whole point: instanceof says no, the brand says yes. A false negative here would
    // silently downgrade every refusal to "a failure" and restore the silent fallback.
    expect(isVectorRefusalError(fromAnotherCopy)).toBe(true);
  });

  it("rejects things that merely look error-ish", () => {
    expect(isVectorRefusalError(new Error("nope"))).toBe(false);
    expect(isVectorRefusalError(null)).toBe(false);
    expect(isVectorRefusalError(undefined)).toBe(false);
    expect(isVectorRefusalError("leak")).toBe(false);
    expect(isVectorRefusalError({ isVectorRefusal: true })).toBe(false); // no code
    expect(isVectorRefusalError({ code: "leak" })).toBe(false); // no brand
  });

  it("a real VectorRefusalError satisfies both tests and keeps its message", () => {
    const e = new VectorRefusalError("tiny", VECTOR_REFUSALS.tiny);
    expect(e instanceof Error).toBe(true);
    expect(isVectorRefusalError(e)).toBe(true);
    expect(e.message).toBe(VECTOR_REFUSALS.tiny);
    expect(e.code).toBe("tiny");
  });
});
