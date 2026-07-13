import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ClientBucketFill =
  typeof import("@/lib/bucket-fill-client").clientBucketFill;

type WorkerMessageListener = (event: MessageEvent<unknown>) => void;

interface PostedBucketRequest {
  requestId: number;
  seedX: number;
  seedY: number;
}

const TRIANGLE_A = [
  { x: 0.1, y: 0.1 },
  { x: 0.2, y: 0.1 },
  { x: 0.1, y: 0.2 },
];

const TRIANGLE_B = [
  { x: 0.6, y: 0.6 },
  { x: 0.8, y: 0.6 },
  { x: 0.6, y: 0.8 },
];

class FakeWorker {
  static instances: FakeWorker[] = [];
  static nextPostError: Error | null = null;

  readonly posted: Array<{
    message: PostedBucketRequest;
    transfer: unknown[] | undefined;
  }> = [];

  private readonly messageListeners = new Set<WorkerMessageListener>();

  constructor() {
    FakeWorker.instances.push(this);
  }

  addEventListener(type: string, listener: WorkerMessageListener): void {
    if (type === "message") this.messageListeners.add(listener);
  }

  removeEventListener(type: string, listener: WorkerMessageListener): void {
    if (type === "message") this.messageListeners.delete(listener);
  }

  postMessage(message: unknown, transfer?: unknown[]): void {
    const postError = FakeWorker.nextPostError;
    FakeWorker.nextPostError = null;
    if (postError) throw postError;

    this.posted.push({
      message: message as PostedBucketRequest,
      transfer,
    });
  }

  emit(data: unknown): void {
    const event = new MessageEvent("message", { data });
    for (const listener of [...this.messageListeners]) listener(event);
  }

  get listenerCount(): number {
    return this.messageListeners.size;
  }
}

function runFill(clientBucketFill: ClientBucketFill, seedX: number) {
  return clientBucketFill(
    document.createElement("canvas"),
    { x: seedX, y: 0.25 },
    {
      tolerance: 30,
      dilation: 3,
      barriers: [],
      polygonBarriers: [],
    }
  );
}

async function flushBitmapContinuations(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function success(requestId: number, vertices = TRIANGLE_A) {
  return {
    requestId,
    type: "result" as const,
    vertices,
    holes: [],
    holeCount: 0,
    areaFraction: 0.25,
    method: "client-raster",
  };
}

describe("bucket-fill-client request correlation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    FakeWorker.instances = [];
    FakeWorker.nextPostError = null;

    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 100, height: 100 }) as ImageBitmap)
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("correlates concurrent results and leaves the other exact listener pending", async () => {
    const { clientBucketFill } = await import("@/lib/bucket-fill-client");
    const fillA = runFill(clientBucketFill, 0.1);
    const fillB = runFill(clientBucketFill, 0.9);
    let fillBSettled = false;
    void fillB.then(
      () => { fillBSettled = true; },
      () => { fillBSettled = true; }
    );

    await flushBitmapContinuations();

    const worker = FakeWorker.instances[0];
    expect(FakeWorker.instances).toHaveLength(1);
    expect(worker.posted).toHaveLength(2);
    expect(worker.listenerCount).toBe(2);
    const requestA = worker.posted[0].message;
    const requestB = worker.posted[1].message;
    expect(requestA.requestId).not.toBe(requestB.requestId);
    expect([requestA.seedX, requestB.seedX]).toEqual([0.1, 0.9]);

    worker.emit(success(requestA.requestId, TRIANGLE_A));

    await expect(fillA).resolves.toMatchObject({ vertices: TRIANGLE_A });
    await Promise.resolve();
    expect(fillBSettled).toBe(false);
    expect(worker.listenerCount).toBe(1);

    worker.emit(success(requestB.requestId, TRIANGLE_B));

    await expect(fillB).resolves.toMatchObject({ vertices: TRIANGLE_B });
    expect(worker.listenerCount).toBe(0);
  });

  it("correlates error IDs and fails closed for an exact malformed result", async () => {
    const { clientBucketFill } = await import("@/lib/bucket-fill-client");
    const fillA = runFill(clientBucketFill, 0.1);
    const fillB = runFill(clientBucketFill, 0.9);
    const errorA = fillA.catch((error: unknown) => error);
    const errorB = fillB.catch((error: unknown) => error);

    await flushBitmapContinuations();

    const worker = FakeWorker.instances[0];
    const requestA = worker.posted[0].message;
    const requestB = worker.posted[1].message;

    worker.emit({
      requestId: requestA.requestId,
      type: "error",
      error: "A failed",
    });

    await expect(errorA).resolves.toMatchObject({ message: "A failed" });
    expect(worker.listenerCount).toBe(1);

    worker.emit({
      requestId: requestB.requestId,
      type: "result",
      vertices: TRIANGLE_B.slice(0, 2),
    });

    await expect(errorB).resolves.toMatchObject({
      message: "Bucket fill returned no result",
    });
    expect(worker.listenerCount).toBe(0);
  });

  it("ignores wrong and missing IDs until the exact response arrives", async () => {
    const { clientBucketFill } = await import("@/lib/bucket-fill-client");
    const fill = runFill(clientBucketFill, 0.4);
    let settled = false;
    void fill.then(
      () => { settled = true; },
      () => { settled = true; }
    );

    await flushBitmapContinuations();

    const worker = FakeWorker.instances[0];
    const request = worker.posted[0].message;
    worker.emit(success(request.requestId + 100, TRIANGLE_B));
    worker.emit({ type: "error", error: "missing request ID" });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(worker.listenerCount).toBe(1);

    worker.emit(success(request.requestId, TRIANGLE_A));

    await expect(fill).resolves.toMatchObject({ vertices: TRIANGLE_A });
    expect(worker.listenerCount).toBe(0);
  });

  it("times out only the expired request while a later request still accepts its result", async () => {
    const { clientBucketFill } = await import("@/lib/bucket-fill-client");
    const fillA = runFill(clientBucketFill, 0.1);
    const errorA = fillA.catch((error: unknown) => error);
    await flushBitmapContinuations();

    await vi.advanceTimersByTimeAsync(4_000);

    const fillB = runFill(clientBucketFill, 0.9);
    await flushBitmapContinuations();
    const worker = FakeWorker.instances[0];
    const requestA = worker.posted[0].message;
    const requestB = worker.posted[1].message;
    expect(worker.listenerCount).toBe(2);

    await vi.advanceTimersByTimeAsync(6_000);

    await expect(errorA).resolves.toMatchObject({
      message: "Bucket fill timed out (10s)",
    });
    expect(worker.listenerCount).toBe(1);

    worker.emit(success(requestA.requestId, TRIANGLE_A));
    expect(worker.listenerCount).toBe(1);
    worker.emit(success(requestB.requestId, TRIANGLE_B));

    await expect(fillB).resolves.toMatchObject({ vertices: TRIANGLE_B });
    expect(worker.listenerCount).toBe(0);
  });

  it("removes the exact listener when postMessage throws synchronously", async () => {
    const { clientBucketFill } = await import("@/lib/bucket-fill-client");
    const postError = new Error("structured clone failed");
    FakeWorker.nextPostError = postError;
    const failedFill = runFill(clientBucketFill, 0.1);
    const caughtError = failedFill.catch((error: unknown) => error);

    await flushBitmapContinuations();

    const worker = FakeWorker.instances[0];
    await expect(caughtError).resolves.toBe(postError);
    expect(worker.listenerCount).toBe(0);
    expect(worker.posted).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);

    const nextFill = runFill(clientBucketFill, 0.9);
    await flushBitmapContinuations();
    const nextRequest = worker.posted[0].message;
    worker.emit(success(nextRequest.requestId, TRIANGLE_B));

    await expect(nextFill).resolves.toMatchObject({ vertices: TRIANGLE_B });
    expect(worker.listenerCount).toBe(0);
  });
});

describe("bucket-fill worker request-ID protocol source oracle", () => {
  it("carries requestId through the client and both worker response paths", () => {
    const clientSource = readFileSync(
      join(process.cwd(), "src/lib/bucket-fill-client.ts"),
      "utf8"
    );
    const workerSource = readFileSync(
      join(process.cwd(), "src/workers/bucket-fill.worker.ts"),
      "utf8"
    );

    expect(clientSource).toContain("if (e.data.requestId !== requestId) return;");
    expect(clientSource).toMatch(/worker\.postMessage\(\s*\{\s*requestId,/);
    expect(workerSource).toContain("requestId: number;");
    expect(workerSource).toContain("const requestId = e.data.requestId;");
    expect(workerSource).toMatch(/postMessage\(\{ requestId, \.\.\.result \}/);
    expect(workerSource).toMatch(
      /catch \(err\)[\s\S]*?postMessage\(\{\s*requestId,\s*type: "error"/
    );
  });
});
