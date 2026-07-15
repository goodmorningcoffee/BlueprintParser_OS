// @vitest-environment node
import { randomUUID } from "node:crypto";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  inject,
  it,
  vi,
} from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

const s3Mocks = vi.hoisted(() => ({
  getS3ObjectStream: vi.fn(),
}));
vi.mock("@/lib/s3", () => s3Mocks);

import { GET } from "@/app/api/project-assets/[id]/[...asset]/route";
import { db } from "@/lib/db";
import { companies, projectMutationLeases, projects } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { Pool, type PoolClient } from "pg";
import {
  asUser,
  createCompany,
  createUser,
  createWorld,
  makeReq,
  publishDemoFixture,
  readJson,
  signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

function bodyStream(bytes: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settleWithin<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 5_000,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(new Error(`${label} did not settle within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function waitForTransactionWaiter(
  client: PoolClient,
  blockingTransactionId: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await client.query(
      `SELECT 1
         FROM pg_locks
        WHERE locktype = 'transactionid'
          AND transactionid::text = $1
          AND granted = false
        LIMIT 1`,
      [blockingTransactionId],
    );
    if (result.rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the post-S3 asset fence to block");
}

function expectPrivateAssetPolicy(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("vary")).toBe(
    "Cookie, Authorization, Range, X-BlueprintParser-PDF-Range-Probe",
  );
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}

function getAsset(
  id: string,
  asset: string[],
  headers?: Record<string, string>,
  signal?: AbortSignal,
) {
  const path = `/api/project-assets/${id}/${asset.join("/")}`;
  return GET(
    signal
      ? new Request(`http://test.local${path}`, {
          method: "GET",
          headers,
          signal,
        })
      : makeReq(path, { method: "GET", headers }),
    { params: Promise.resolve({ id, asset }) } as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  s3Mocks.getS3ObjectStream.mockResolvedValue({
    body: bodyStream([0x89, 0x50, 0x4e, 0x47]),
    contentType: "image/png",
    contentLength: 4,
    eTag: '"etag"',
    lastModified: new Date("2026-07-14T00:00:00Z"),
  });
});

afterEach(() => signedOut());

describe.skipIf(!dbUp)("GET /api/project-assets/[id]/[...asset]", () => {
  it("serves a private asset only to its tenant without exposing a storage URL", async () => {
    const { user, project } = await createWorld();
    asUser(user);

    const response = await getAsset(project.publicId, [
      "pages",
      "page_0002.png",
    ]);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expectPrivateAssetPolicy(response);
    expect(response.headers.get("content-length")).toBe("4");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    expect(s3Mocks.getS3ObjectStream).toHaveBeenCalledExactlyOnceWith(
      `${project.dataUrl}/pages/page_0002.png`,
      expect.objectContaining({
        range: undefined,
        signal: expect.any(AbortSignal),
      }),
    );

    signedOut();
    const signedOutResponse = await getAsset(project.publicId, [
      "original.pdf",
    ]);
    expect(signedOutResponse.status).toBe(401);
    expectPrivateAssetPolicy(signedOutResponse);

    const otherCompany = await createCompany();
    const outsider = await createUser(otherCompany.id);
    asUser(outsider);
    expect((await getAsset(project.publicId, ["original.pdf"])).status).toBe(
      404,
    );
  });

  it("allows a published demo signed-out, but returns no-store bytes", async () => {
    const { project } = await createWorld();
    await publishDemoFixture(project.id);
    signedOut();

    const response = await getAsset(project.publicId, ["thumbnail.png"]);
    expect(response.status).toBe(200);
    expectPrivateAssetPolicy(response);
    expect(s3Mocks.getS3ObjectStream).toHaveBeenCalledWith(
      `${project.dataUrl}/thumbnail.png`,
      expect.objectContaining({
        range: undefined,
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("forwards one validated PDF byte range and preserves the 206 contract", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    s3Mocks.getS3ObjectStream.mockResolvedValueOnce({
      body: bodyStream([1, 2, 3]),
      contentType: "application/pdf",
      contentLength: 3,
      contentRange: "bytes 10-12/100",
    });

    const response = await getAsset(project.publicId, ["original.pdf"], {
      range: "bytes=10-12",
    });
    expect(response.status).toBe(206);
    expectPrivateAssetPolicy(response);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-range")).toBe("bytes 10-12/100");
    expect(s3Mocks.getS3ObjectStream).toHaveBeenCalledWith(
      `${project.dataUrl}/original.pdf`,
      expect.objectContaining({
        range: "bytes=10-12",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("settles an exact-length upstream body without requiring an extra EOF pull", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const releaseClose = deferred<void>();
    const cancelStarted = deferred<void>();
    let cancelCalls = 0;
    let pullCount = 0;
    s3Mocks.getS3ObjectStream.mockResolvedValueOnce({
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          pullCount += 1;
          if (pullCount > 2) return;
          controller.enqueue(
            pullCount === 1 ? new Uint8Array([1]) : new Uint8Array([2, 3]),
          );
          // Deliberately do not close. Real HTTP consumers may stop pulling as
          // soon as Content-Length bytes arrive, so gateway teardown cannot
          // depend on one more reader.read() observing upstream EOF.
        },
        cancel() {
          cancelCalls += 1;
          cancelStarted.resolve(undefined);
        },
      }),
      contentType: "application/pdf",
      contentLength: 3,
      contentRange: "bytes 10-12/100",
      bodySettled: releaseClose.promise,
    });

    const response = await getAsset(project.publicId, ["original.pdf"], {
      range: "bytes=10-12",
    });
    const reader = response.body!.getReader();

    try {
      expect(await reader.read()).toEqual({
        done: false,
        value: new Uint8Array([1]),
      });

      let finalReadSettled = false;
      const finalRead = reader.read().then((result) => {
        finalReadSettled = true;
        return result;
      });
      await settleWithin(cancelStarted.promise, "exact-length body cancel");
      expect(finalReadSettled).toBe(false);
      expect(cancelCalls).toBe(1);

      releaseClose.resolve(undefined);
      await expect(finalRead).resolves.toEqual({
        done: false,
        value: new Uint8Array([2, 3]),
      });
      await expect(reader.read()).resolves.toEqual({
        done: true,
        value: undefined,
      });
      expect(cancelCalls).toBe(1);
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe("bytes 10-12/100");
      expectPrivateAssetPolicy(response);
    } finally {
      releaseClose.resolve(undefined);
    }
  });

  it("shares one pending teardown when downstream cancellation races exact completion", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const releaseClose = deferred<void>();
    const cancelStarted = deferred<void>();
    let cancelCalls = 0;
    let emitted = false;
    s3Mocks.getS3ObjectStream.mockResolvedValueOnce({
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (emitted) return;
          emitted = true;
          controller.enqueue(new Uint8Array([1, 2, 3]));
        },
        cancel() {
          cancelCalls += 1;
          cancelStarted.resolve(undefined);
        },
      }),
      contentType: "application/pdf",
      contentLength: 3,
      contentRange: "bytes 10-12/100",
      bodySettled: releaseClose.promise,
    });

    const response = await getAsset(project.publicId, ["original.pdf"], {
      range: "bytes=10-12",
    });
    const reader = response.body!.getReader();
    try {
      const pendingRead = reader.read();
      await settleWithin(
        cancelStarted.promise,
        "racing exact-length body cancel",
      );
      expect(cancelCalls).toBe(1);

      let downstreamCancelSettled = false;
      const downstreamCancel = reader
        .cancel("consumer stopped after Content-Length bytes")
        .then(() => {
          downstreamCancelSettled = true;
        });
      await Promise.resolve();
      expect(downstreamCancelSettled).toBe(false);
      expect(cancelCalls).toBe(1);

      releaseClose.resolve(undefined);
      await downstreamCancel;
      await expect(pendingRead).resolves.toEqual({
        done: true,
        value: undefined,
      });
      expect(downstreamCancelSettled).toBe(true);
      expect(cancelCalls).toBe(1);
      expectPrivateAssetPolicy(response);
    } finally {
      releaseClose.resolve(undefined);
    }
  });

  it("fails closed without emitting bytes beyond the declared upstream length", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    let cancelCalls = 0;
    let pullCount = 0;
    s3Mocks.getS3ObjectStream.mockResolvedValueOnce({
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          pullCount += 1;
          controller.enqueue(
            pullCount === 1 ? new Uint8Array([1, 2]) : new Uint8Array([3, 4]),
          );
        },
        cancel() {
          cancelCalls += 1;
        },
      }),
      contentType: "application/pdf",
      contentLength: 3,
      contentRange: "bytes 10-12/100",
    });

    const response = await getAsset(project.publicId, ["original.pdf"], {
      range: "bytes=10-12",
    });
    const reader = response.body!.getReader();

    expect(await reader.read()).toEqual({
      done: false,
      value: new Uint8Array([1, 2]),
    });
    await expect(reader.read()).rejects.toThrow(
      "S3 project asset body exceeded its 3-byte length",
    );
    expect(cancelCalls).toBe(1);
    expectPrivateAssetPolicy(response);
  });

  it("fails closed when upstream EOF arrives before the declared length", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    s3Mocks.getS3ObjectStream.mockResolvedValueOnce({
      body: bodyStream([1, 2]),
      contentType: "application/pdf",
      contentLength: 3,
      contentRange: "bytes 10-12/100",
    });

    const response = await getAsset(project.publicId, ["original.pdf"], {
      range: "bytes=10-12",
    });
    const reader = response.body!.getReader();

    expect(await reader.read()).toEqual({
      done: false,
      value: new Uint8Array([1, 2]),
    });
    await expect(reader.read()).rejects.toThrow(
      "S3 project asset body ended at 2 of 3 bytes",
    );
    expectPrivateAssetPolicy(response);
  });

  it("turns the marked pdf.js capability probe into a one-byte upstream range", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    s3Mocks.getS3ObjectStream.mockResolvedValueOnce({
      body: bodyStream([0x25]),
      contentType: "application/pdf",
      contentLength: 1,
      contentRange: "bytes 0-0/65682593",
    });

    const response = await getAsset(project.publicId, ["original.pdf"], {
      "x-blueprintparser-pdf-range-probe": "1",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("65682593");
    expect(response.headers.get("content-range")).toBeNull();
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      Buffer.from([0x25]),
    );
    expect(s3Mocks.getS3ObjectStream).toHaveBeenCalledExactlyOnceWith(
      `${project.dataUrl}/original.pdf`,
      expect.objectContaining({
        range: "bytes=0-0",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("fails closed and cancels a marked probe without an authoritative total", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    let canceled = false;
    s3Mocks.getS3ObjectStream.mockResolvedValueOnce({
      body: new ReadableStream<Uint8Array>({
        cancel() {
          canceled = true;
        },
      }),
      contentType: "application/pdf",
      contentLength: 1,
      contentRange: "bytes 0-0/*",
    });

    const response = await getAsset(project.publicId, ["original.pdf"], {
      "x-blueprintparser-pdf-range-probe": "1",
    });

    expect(response.status).toBe(500);
    expectPrivateAssetPolicy(response);
    expect(canceled).toBe(true);
  });

  it("propagates request cancellation into S3 acquisition and the admitted body", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        canceled = true;
      },
    });
    s3Mocks.getS3ObjectStream.mockResolvedValueOnce({
      body,
      contentType: "application/pdf",
    });
    const controller = new AbortController();

    const response = await getAsset(
      project.publicId,
      ["original.pdf"],
      undefined,
      controller.signal,
    );
    expect(response.status).toBe(200);
    expect(s3Mocks.getS3ObjectStream).toHaveBeenCalledExactlyOnceWith(
      `${project.dataUrl}/original.pdf`,
      expect.objectContaining({
        range: undefined,
        signal: expect.any(AbortSignal),
      }),
    );
    const forwardedSignal = s3Mocks.getS3ObjectStream.mock.calls[0]?.[1]
      ?.signal as AbortSignal;
    expect(forwardedSignal.aborted).toBe(false);

    controller.abort(new Error("browser navigated away"));
    await vi.waitFor(() => expect(canceled).toBe(true));
    expect(forwardedSignal.aborted).toBe(true);
  });

  it("absorbs an upstream body cancel rejection after the browser disconnects", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    let cancelAttempted = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelAttempted = true;
        return Promise.reject(new Error("upstream already failed"));
      },
    });
    s3Mocks.getS3ObjectStream.mockResolvedValueOnce({
      body,
      contentType: "application/pdf",
    });
    const controller = new AbortController();

    const response = await getAsset(
      project.publicId,
      ["original.pdf"],
      undefined,
      controller.signal,
    );
    expect(response.status).toBe(200);

    controller.abort(new Error("browser disconnected"));
    await vi.waitFor(() => expect(cancelAttempted).toBe(true));
    // Let the rejected underlying cancel settle. The request-bound wrapper must consume it rather
    // than leaking an unhandled rejection into the process.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("acknowledges an acquisition-time browser abort without an internal error", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    const started = deferred<void>();
    s3Mocks.getS3ObjectStream.mockImplementationOnce(
      async (_key, options: { signal?: AbortSignal }) => {
        const signal = options.signal!;
        started.resolve(undefined);
        return new Promise<never>((_, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(signal.reason ?? new Error("aborted")),
            { once: true },
          );
        });
      },
    );
    const controller = new AbortController();

    const pending = getAsset(
      project.publicId,
      ["original.pdf"],
      undefined,
      controller.signal,
    );
    await started.promise;
    controller.abort(new Error("browser range probe canceled"));

    const response = await pending;
    expect(response.status).toBe(499);
    expectPrivateAssetPolicy(response);
  });

  it.each([
    {
      label: "the request was already aborted when S3 resolved",
      timing: "before-body" as const,
    },
    {
      label: "the request aborted during the post-S3 fence",
      timing: "during-fence" as const,
    },
  ])(
    "cancels an acquired body while the post-S3 authority fence is blocked: $label",
    async ({ timing }) => {
      const { user, project } = await createWorld();
      asUser(user);
      const reachedS3 = deferred<void>();
      const object = deferred<{
        body: ReadableStream<Uint8Array>;
        contentType: string;
        contentLength: number;
      }>();
      const canceled = deferred<void>();
      let cancelCalls = 0;
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancelCalls += 1;
          canceled.resolve(undefined);
        },
      });
      s3Mocks.getS3ObjectStream.mockImplementationOnce(async () => {
        reachedS3.resolve(undefined);
        return object.promise;
      });
      const controller = new AbortController();
      const blockerPool = new Pool({
        connectionString: process.env.DATABASE_URL,
        max: 1,
      });
      let blocker: PoolClient | undefined;
      let pending: Promise<Response> | undefined;
      let released = false;

      try {
        blocker = await blockerPool.connect();
        pending = getAsset(
          project.publicId,
          ["original.pdf"],
          undefined,
          controller.signal,
        );
        void pending.catch(() => undefined);
        await settleWithin(reachedS3.promise, "project asset S3 acquisition");

        await blocker.query("BEGIN");
        const [{ xid }] = (
          await blocker.query<{ xid: string }>(
            "SELECT txid_current()::text AS xid",
          )
        ).rows;
        await blocker.query("SELECT 1 FROM projects WHERE id = $1 FOR UPDATE", [
          project.id,
        ]);
        if (timing === "before-body") {
          controller.abort(
            new Error("browser left before S3 body acquisition"),
          );
        }
        object.resolve({
          body,
          contentType: "application/pdf",
          contentLength: 3,
        });
        await waitForTransactionWaiter(blocker, xid);

        if (timing === "during-fence") {
          controller.abort(new Error("browser left during post-S3 fence"));
        }
        await Promise.resolve();
        expect(cancelCalls).toBe(1);
        await settleWithin(canceled.promise, "blocked-fence body cancellation");

        await blocker.query("COMMIT");
        released = true;
        const response = await settleWithin(
          pending,
          "post-fence project asset response",
        );
        expect(response.status).toBe(499);
        expect(await response.text()).toBe("");
        expect(cancelCalls).toBe(1);
        expectPrivateAssetPolicy(response);
      } finally {
        controller.abort(new Error("project asset lock-test cleanup"));
        object.resolve({
          body,
          contentType: "application/pdf",
          contentLength: 3,
        });
        if (blocker && !released) {
          await blocker.query("ROLLBACK").catch(() => undefined);
        }
        blocker?.release();
        await blockerPool.end();
        await settleWithin(
          Promise.allSettled(pending ? [pending] : []),
          "project asset lock-test request cleanup",
        );
      }
    },
    15_000,
  );

  it("fails closed for invalid ranges, paths, non-completed projects, and S3 misses", async () => {
    const { user, project } = await createWorld();
    asUser(user);

    const invalidRange = await getAsset(project.publicId, ["original.pdf"], {
      range: "bytes=1-2,4-5",
    });
    expect(invalidRange.status).toBe(416);
    expectPrivateAssetPolicy(invalidRange);
    expect(s3Mocks.getS3ObjectStream).not.toHaveBeenCalled();

    expect(
      (
        await readJson(
          await getAsset(project.publicId, ["..", "config", "toggles.json"]),
        )
      ).status,
    ).toBe(404);
    expect(
      (await getAsset(project.publicId, ["yolo-output", "detections.json"]))
        .status,
    ).toBe(404);

    const { user: pendingUser, project: pending } = await createWorld({
      status: "processing",
    });
    asUser(pendingUser);
    expect((await getAsset(pending.publicId, ["original.pdf"])).status).toBe(
      404,
    );

    asUser(user);
    s3Mocks.getS3ObjectStream.mockRejectedValueOnce({
      $metadata: { httpStatusCode: 404 },
    });
    const missingResponse = await getAsset(project.publicId, ["original.pdf"]);
    const missing = await readJson(missingResponse);
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({
      error: { code: "NOT_FOUND", message: "Asset not found" },
    });
    expectPrivateAssetPolicy(missingResponse);
  });

  it("forces MIME from the allowlisted path instead of trusting object metadata", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    s3Mocks.getS3ObjectStream.mockResolvedValueOnce({
      body: bodyStream([1]),
      contentType: "text/html",
      contentLength: 1,
    });

    const image = await getAsset(project.publicId, ["pages", "page_0001.png"]);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");

    s3Mocks.getS3ObjectStream.mockResolvedValueOnce({
      body: bodyStream([2]),
      contentType: "text/html",
      contentLength: 1,
    });
    const pdf = await getAsset(project.publicId, ["original.pdf"]);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
  });

  it("rejects a legacy project whose company namespace no longer proves its root", async () => {
    const { company, user, project } = await createWorld();
    await db
      .update(companies)
      .set({ dataKey: `rekeyed-${company.id}` })
      .where(eq(companies.id, company.id));
    asUser(user);

    const response = await getAsset(project.publicId, ["original.pdf"]);
    expect(response.status).toBe(404);
    expectPrivateAssetPolicy(response);
    expect(s3Mocks.getS3ObjectStream).not.toHaveBeenCalled();
  });

  it("revalidates demo authority after S3 acquisition and cancels stale bytes", async () => {
    const { project } = await createWorld();
    await publishDemoFixture(project.id);
    signedOut();

    const started = deferred<void>();
    const object = deferred<{
      body: ReadableStream<Uint8Array>;
      contentType: string;
    }>();
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        canceled = true;
      },
    });
    s3Mocks.getS3ObjectStream.mockImplementationOnce(async () => {
      started.resolve(undefined);
      return object.promise;
    });

    const pending = getAsset(project.publicId, ["thumbnail.png"]);
    await started.promise;
    await db
      .update(projects)
      .set({
        isDemo: false,
        lifecycleEpoch: sql`${projects.lifecycleEpoch} + 1`,
      })
      .where(eq(projects.id, project.id));
    object.resolve({ body, contentType: "image/png" });

    const response = await pending;
    expect(response.status).toBe(404);
    expect(canceled).toBe(true);
    expectPrivateAssetPolicy(response);
  });

  it("revalidates rebuild admission after S3 acquisition and cancels stale bytes", async () => {
    const { user, project } = await createWorld();
    asUser(user);

    const started = deferred<void>();
    const object = deferred<{
      body: ReadableStream<Uint8Array>;
      contentType: string;
    }>();
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        canceled = true;
      },
    });
    s3Mocks.getS3ObjectStream.mockImplementationOnce(async () => {
      started.resolve(undefined);
      return object.promise;
    });

    const pending = getAsset(project.publicId, ["pages", "page_0001.png"]);
    await started.promise;
    await db.insert(projectMutationLeases).values({
      token: randomUUID(),
      projectId: project.id,
      lifecycleEpoch: project.lifecycleEpoch,
      kind: "admin-reprocess:thumbnails",
      idempotencyKey: randomUUID(),
      status: "active",
      expiresAt: new Date(Date.now() + 60_000),
    });
    object.resolve({ body, contentType: "image/png" });

    const response = await pending;
    expect(response.status).toBe(404);
    expect(canceled).toBe(true);
    expectPrivateAssetPolicy(response);
  });

  it("applies the private policy to unexpected gateway failures", async () => {
    const { user, project } = await createWorld();
    asUser(user);
    s3Mocks.getS3ObjectStream.mockRejectedValueOnce(new Error("fixture boom"));

    const response = await getAsset(project.publicId, ["original.pdf"]);
    expect(response.status).toBe(500);
    expectPrivateAssetPolicy(response);
    expect((await response.json()).error).toEqual({
      code: "INTERNAL",
      message: "Internal server error",
    });
  });

  it("denies stable legacy reads while a thumbnail rebuild lease is active", async () => {
    const { user, project } = await createWorld();
    await db.insert(projectMutationLeases).values({
      token: randomUUID(),
      projectId: project.id,
      lifecycleEpoch: project.lifecycleEpoch,
      kind: "admin-reprocess:thumbnails",
      idempotencyKey: randomUUID(),
      status: "active",
      expiresAt: new Date(Date.now() + 60_000),
    });
    asUser(user);

    const response = await readJson(
      await getAsset(project.publicId, ["pages", "page_0001.png"]),
    );
    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: "NOT_FOUND", message: "Asset not found" },
    });
    expect(s3Mocks.getS3ObjectStream).not.toHaveBeenCalled();
  });
});
