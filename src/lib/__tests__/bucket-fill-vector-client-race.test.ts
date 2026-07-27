/**
 * bucket-fill-vector-client — request correlation and mask lifecycle.
 *
 * PLAN asks this to mirror the legacy transport tests' properties, so the five in
 * `bucket-fill-client-race.test.ts` are reproduced here against the vector client rather than
 * reinvented: correlate concurrent results · correlate errors and fail closed on a malformed
 * success · ignore wrong and missing ids · time out only the expired request · remove the exact
 * listener when `postMessage` throws synchronously.
 *
 * Two properties are NEW here because worker #2's protocol is two-phase, and both are hazards the
 * legacy single-message client cannot have:
 *   • **transferables detach** — the geometry cache owns `meta` and reads it on every click, so
 *     transferring it directly would leave the cache holding a zero-length array;
 *   • **concurrent first clicks must share one `mask`**, or the second rebuilds a ~9 MB mask and
 *     transfers a second set of buffers for geometry the worker already has.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureVectorMask,
  vectorClientFill,
  evictVectorMask,
  __setVectorWorkerFactory,
  type VectorWorkerLike,
} from "@/lib/bucket-fill-vector-client";
import type { OneclickRequest, OneclickResponse } from "@/lib/oneclick-worker-core";

const TRIANGLE = [
  { x: 0.1, y: 0.1 },
  { x: 0.2, y: 0.1 },
  { x: 0.1, y: 0.2 },
];

type Listener = (e: MessageEvent<OneclickResponse>) => void;

class FakeWorker implements VectorWorkerLike {
  static instances: FakeWorker[] = [];
  static nextPostError: Error | null = null;

  readonly posted: Array<{ message: OneclickRequest; transfer?: Transferable[] }> = [];
  private readonly listeners = new Set<Listener>();

  constructor() {
    FakeWorker.instances.push(this);
  }
  addEventListener(_t: "message", l: Listener) { this.listeners.add(l); }
  removeEventListener(_t: "message", l: Listener) { this.listeners.delete(l); }
  postMessage(message: OneclickRequest, transfer?: Transferable[]) {
    const err = FakeWorker.nextPostError;
    FakeWorker.nextPostError = null;
    if (err) throw err;
    // Emulate the real detach so a test can observe it — this is the whole point of `transfer`.
    for (const buf of transfer ?? []) {
      if (buf instanceof ArrayBuffer) {
        try { structuredClone(buf, { transfer: [buf] }); } catch { /* already detached */ }
      }
    }
    this.posted.push({ message, transfer });
  }
  emit(data: OneclickResponse) {
    const event = new MessageEvent("message", { data });
    for (const l of [...this.listeners]) l(event);
  }
  get listenerCount() { return this.listeners.size; }
}

const result = (requestId: number, vertices = TRIANGLE): OneclickResponse => ({
  type: "result",
  requestId,
  vertices,
  holes: [],
  holeCount: 0,
  areaFraction: 0.25,
  method: "client-vector",
});

let worker: FakeWorker;

const MASK_INPUT = () => ({
  segs: [0, 0, 10, 0, 10, 0, 10, 10],
  meta: new Uint8Array([16, 16]),
  imgW: 1000,
  imgH: 800,
});

beforeEach(() => {
  FakeWorker.instances = [];
  FakeWorker.nextPostError = null;
  __setVectorWorkerFactory(() => new FakeWorker());
  // Touch the worker so `worker` refers to the same instance the client uses.
  evictVectorMask();
  worker = FakeWorker.instances[0] ?? new FakeWorker();
});

afterEach(() => {
  __setVectorWorkerFactory(null);
  vi.useRealTimers();
});

function armWorker() {
  // ensureVectorMask lazily constructs the worker; grab whichever instance it made.
  const p = ensureVectorMask("K", MASK_INPUT());
  worker = FakeWorker.instances[FakeWorker.instances.length - 1];
  return p;
}

describe("mask lifecycle", () => {
  it("sends one mask and resolves on mask-ready", async () => {
    const p = armWorker();
    expect(worker.posted[0].message.type).toBe("mask");
    worker.emit({ type: "mask-ready", key: "K", maskBytes: 100 });
    await expect(p).resolves.toBeUndefined();
    expect(worker.listenerCount).toBe(0); // exact listener removed
  });

  it("★ concurrent first clicks SHARE one mask message", async () => {
    const a = armWorker();
    const b = ensureVectorMask("K", MASK_INPUT());
    expect(worker.posted.filter((p) => p.message.type === "mask")).toHaveLength(1);
    worker.emit({ type: "mask-ready", key: "K", maskBytes: 100 });
    await Promise.all([a, b]);
  });

  it("ignores a mask-ready for a different key", async () => {
    const p = armWorker();
    worker.emit({ type: "mask-ready", key: "OTHER", maskBytes: 1 });
    expect(worker.listenerCount).toBe(1); // still waiting
    worker.emit({ type: "mask-ready", key: "K", maskBytes: 1 });
    await expect(p).resolves.toBeUndefined();
  });

  it("rejects on mask-error and allows a later retry", async () => {
    const p = armWorker();
    worker.emit({ type: "mask-error", key: "K", error: "no vector linework" });
    await expect(p).rejects.toThrow(/no vector linework/);
    // The failed attempt must not be cached, or the page could never recover.
    const retry = ensureVectorMask("K", MASK_INPUT());
    expect(worker.posted.filter((m) => m.message.type === "mask")).toHaveLength(2);
    worker.emit({ type: "mask-ready", key: "K", maskBytes: 1 });
    await expect(retry).resolves.toBeUndefined();
  });

  it("★★ transfers FRESH buffers — the cache's own meta must not be detached", async () => {
    // The geometry cache reads `meta` on every click. Transferring it directly would leave the
    // cache holding a zero-length array, and the next click would build a mask from nothing and
    // refuse, with nothing naming the cause.
    const input = MASK_INPUT();
    const meta = input.meta;
    const p = ensureVectorMask("K", input);
    worker = FakeWorker.instances[FakeWorker.instances.length - 1];
    worker.emit({ type: "mask-ready", key: "K", maskBytes: 1 });
    await p;

    expect(meta.byteLength).toBe(2); // NOT detached
    expect(Array.from(meta)).toEqual([16, 16]);
    // ...and what was transferred was a different buffer.
    const sent = worker.posted[0];
    expect(sent.transfer).toHaveLength(2);
    expect(sent.transfer).not.toContain(meta.buffer);
  });
});

describe("fill request correlation", () => {
  beforeEach(async () => {
    const p = armWorker();
    worker.emit({ type: "mask-ready", key: "K", maskBytes: 1 });
    await p;
  });

  it("correlates concurrent results and leaves the other exact listener pending", async () => {
    const a = vectorClientFill("K", { seedX: 0.2, seedY: 0.2 });
    const b = vectorClientFill("K", { seedX: 0.7, seedY: 0.7 });
    expect(worker.listenerCount).toBe(2);

    const idB = (worker.posted[2].message as { requestId: number }).requestId;
    worker.emit(result(idB));
    await expect(b).resolves.toMatchObject({ method: "client-vector" });
    expect(worker.listenerCount).toBe(1); // a is still waiting

    const idA = (worker.posted[1].message as { requestId: number }).requestId;
    worker.emit(result(idA));
    await expect(a).resolves.toMatchObject({ areaFraction: 0.25 });
    expect(worker.listenerCount).toBe(0);
  });

  it("correlates error ids and fails closed on a malformed success", async () => {
    const p = vectorClientFill("K", { seedX: 0.2, seedY: 0.2 });
    const id = (worker.posted[1].message as { requestId: number }).requestId;
    // A `result` with too few vertices is not a result — reject rather than hand back a degenerate
    // polygon that downstream would happily commit.
    worker.emit(result(id, [{ x: 0.1, y: 0.1 }]));
    await expect(p).rejects.toThrow(/no polygon/);
    expect(worker.listenerCount).toBe(0);
  });

  it("surfaces the worker's own refusal text", async () => {
    const p = vectorClientFill("K", { seedX: 0.2, seedY: 0.2 });
    const id = (worker.posted[1].message as { requestId: number }).requestId;
    worker.emit({ type: "error", requestId: id, error: "Fill escaped the room", method: "client-vector" });
    await expect(p).rejects.toThrow(/escaped the room/);
  });

  it("ignores wrong and missing ids, and mask traffic, until the exact response arrives", async () => {
    const p = vectorClientFill("K", { seedX: 0.2, seedY: 0.2 });
    const id = (worker.posted[1].message as { requestId: number }).requestId;
    worker.emit(result(id + 99));
    worker.emit({ type: "mask-ready", key: "K", maskBytes: 1 });
    worker.emit({ type: "evicted", keys: ["K"] });
    expect(worker.listenerCount).toBe(1);
    worker.emit(result(id));
    await expect(p).resolves.toMatchObject({ holeCount: 0 });
  });

  it("times out only the expired request while a later one still accepts its result", async () => {
    vi.useFakeTimers();
    const stale = vectorClientFill("K", { seedX: 0.2, seedY: 0.2, timeoutMs: 100 });
    const staleAssertion = expect(stale).rejects.toThrow(/timed out/);
    const fresh = vectorClientFill("K", { seedX: 0.7, seedY: 0.7, timeoutMs: 10_000 });

    vi.advanceTimersByTime(150);
    await staleAssertion;
    expect(worker.listenerCount).toBe(1); // only the fresh listener survives

    const idFresh = (worker.posted[2].message as { requestId: number }).requestId;
    worker.emit(result(idFresh));
    await expect(fresh).resolves.toMatchObject({ areaFraction: 0.25 });
  });

  it("removes the exact listener when postMessage throws synchronously", async () => {
    const before = worker.listenerCount;
    FakeWorker.nextPostError = new Error("worker is gone");
    await expect(vectorClientFill("K", { seedX: 0.2, seedY: 0.2 })).rejects.toThrow(/worker is gone/);
    // A listener left behind would keep a dead closure alive and could settle a promise nobody
    // holds. This is the property the legacy suite pins, mirrored.
    expect(worker.listenerCount).toBe(before);
  });
});

describe("eviction", () => {
  it("clears local readiness so the next click re-sends mask", async () => {
    const p = armWorker();
    worker.emit({ type: "mask-ready", key: "K", maskBytes: 1 });
    await p;

    evictVectorMask("K");
    expect(worker.posted.at(-1)!.message).toEqual({ type: "evict", key: "K" });

    const again = ensureVectorMask("K", MASK_INPUT());
    expect(worker.posted.filter((m) => m.message.type === "mask")).toHaveLength(2);
    worker.emit({ type: "mask-ready", key: "K", maskBytes: 1 });
    await expect(again).resolves.toBeUndefined();
  });

  it("evicts everything when no key is given", async () => {
    const p = armWorker();
    worker.emit({ type: "mask-ready", key: "K", maskBytes: 1 });
    await p;
    evictVectorMask();
    expect(worker.posted.at(-1)!.message).toEqual({ type: "evict" });
  });

  it("does not throw when the worker is dead", () => {
    const p = armWorker();
    void p.catch(() => {});
    FakeWorker.nextPostError = new Error("gone");
    expect(() => evictVectorMask("K")).not.toThrow();
  });
});
