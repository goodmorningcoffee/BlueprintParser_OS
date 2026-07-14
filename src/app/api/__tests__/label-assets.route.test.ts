// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

const s3Mocks = vi.hoisted(() => ({
  getS3ObjectVersionStream: vi.fn(),
  headS3Object: vi.fn(),
}));
vi.mock("@/lib/s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/s3")>();
  return { ...actual, ...s3Mocks };
});

import { GET, HEAD, OPTIONS } from "@/app/api/label-assets/[id]/route";
import { db } from "@/lib/db";
import {
  labelingSessions,
  labelStudioAssetGrants,
  labelStudioProjectIntents,
  projectMutationLeases,
} from "@/lib/db/schema";
import {
  activateLabelStudioAssetGrants,
  createLabelStudioGrantSecret,
  hashLabelStudioAssetToken,
  labelStudioAssetUrl,
  revokeSessionLabelStudioAssetGrants,
} from "@/lib/label-studio-asset-grant";
import { assertProjectWritable } from "@/server/api/access";
import { withProjectWrite } from "@/server/api/project-write-capability";
import {
  createWorld,
  makeReq,
  params,
  readJson,
} from "@/test/harness";
import { and, eq, sql } from "drizzle-orm";

const dbUp = inject("dbUp") as boolean;

function bodyStream(bytes = [0x89, 0x50, 0x4e, 0x47]) {
  return new ReadableStream<Uint8Array>({
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

async function seedGrant(mode: "provisioning" | "active" = "active") {
  const world = await createWorld();
  const intentId = randomUUID();
  const requestLease = randomUUID();
  const providerInstanceId = `asset-grant-provider-${intentId}`;
  const grant = createLabelStudioGrantSecret();
  await db.insert(labelStudioProjectIntents).values({
    id: intentId,
    projectId: world.project.id,
    companyId: world.company.id,
    lifecycleEpoch: world.project.lifecycleEpoch,
    marker: `bp-labeling-intent:${intentId}`,
    providerProjectId: 7001,
    providerBaseUrl: "https://ls.test",
    providerInstanceId,
    state: "cleanup_pending",
    leaseToken: requestLease,
    leaseExpiresAt: new Date(Date.now() + 60_000),
  });
  await db.insert(projectMutationLeases).values({
    token: requestLease,
    projectId: world.project.id,
    lifecycleEpoch: world.project.lifecycleEpoch,
    kind: "labeling-session-create",
    idempotencyKey: `label-asset-test:${intentId}`,
    status: "active",
    expiresAt: new Date(Date.now() + 60_000),
  });
  await db.insert(labelStudioAssetGrants).values({
    id: grant.id,
    projectId: world.project.id,
    companyId: world.company.id,
    lifecycleEpoch: world.project.lifecycleEpoch,
    provisioningIntentId: intentId,
    tokenHash: grant.tokenHash,
    snapshotVersionId: "snapshot-version-1",
    state: "provisioning",
  });

  let sessionId: number | null = null;
  if (mode === "active") {
    const capability = assertProjectWritable(world.project);
    sessionId = await withProjectWrite(
      capability,
      world.project.id,
      async (tx) => {
        const [session] = await tx
          .insert(labelingSessions)
          .values({
            projectId: world.project.id,
            companyId: world.company.id,
            labelStudioProjectId: 7001,
            providerBaseUrl: "https://ls.test",
            providerInstanceId,
            labelStudioUrl: "https://ls.test/projects/7001",
            pageRange: "1",
            status: "active",
            provisioningIntentId: intentId,
          })
          .returning({ id: labelingSessions.id });
        await activateLabelStudioAssetGrants(tx, intentId, session.id, [
          grant.id,
        ]);
        await tx
          .delete(labelStudioProjectIntents)
          .where(eq(labelStudioProjectIntents.id, intentId));
        await tx
          .delete(projectMutationLeases)
          .where(eq(projectMutationLeases.token, requestLease));
        return session.id;
      },
    );
  }
  return { ...world, grant, intentId, sessionId };
}

function request(
  id: string,
  token: string,
  options: {
    method?: "GET" | "HEAD";
    origin?: string;
    signal?: AbortSignal;
  } = {},
) {
  const handler = options.method === "HEAD" ? HEAD : GET;
  const path = `/api/label-assets/${id}?token=${encodeURIComponent(token)}`;
  const req = options.signal
    ? new Request(`http://test.local${path}`, {
        method: options.method ?? "GET",
        headers: options.origin ? { origin: options.origin } : undefined,
        signal: options.signal,
      })
    : makeReq(path, {
        method: options.method ?? "GET",
        headers: options.origin ? { origin: options.origin } : undefined,
      });
  return handler(
    req,
    params({ id }),
  );
}

function expectPrivatePolicy(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("cross-origin-resource-policy")).toBe(
    "cross-origin",
  );
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("vary")).toBe("Origin");
}

beforeEach(() => {
  vi.stubEnv("LABEL_STUDIO_URL", "https://ls.test/");
  vi.stubEnv("NEXTAUTH_URL", "https://app.test/");
  s3Mocks.getS3ObjectVersionStream.mockResolvedValue({
    body: bodyStream(),
    contentLength: 4,
  });
  s3Mocks.headS3Object.mockResolvedValue({
    exists: true,
    size: 4,
    versionId: "snapshot-version-1",
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe.skipIf(!dbUp)("GET|HEAD /api/label-assets/[id]", () => {
  it("serves one active exact-version snapshot without storing or exposing the raw token", async () => {
    const { project, grant } = await seedGrant("active");
    const url = labelStudioAssetUrl(grant.id, grant.token);
    expect(url).toBe(
      `https://app.test/api/label-assets/${grant.id}?token=${grant.token}`,
    );
    expect(url).not.toContain(project.dataUrl);

    const response = await request(grant.id, grant.token, {
      origin: "https://ls.test",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://ls.test",
    );
    expectPrivatePolicy(response);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    expect(s3Mocks.getS3ObjectVersionStream).toHaveBeenCalledWith(
      `${project.dataUrl}/label-studio-assets/${grant.id}.png`,
      "snapshot-version-1",
      expect.any(AbortSignal),
    );

    const [stored] = await db
      .select({ tokenHash: labelStudioAssetGrants.tokenHash })
      .from(labelStudioAssetGrants)
      .where(eq(labelStudioAssetGrants.id, grant.id));
    expect(stored.tokenHash).toBe(hashLabelStudioAssetToken(grant.token));
    expect(JSON.stringify(stored)).not.toContain(grant.token);
  });

  it("serves a request-leased provisioning grant during provider import", async () => {
    const { project, grant, intentId } = await seedGrant("provisioning");
    const response = await request(grant.id, grant.token);
    expect(response.status).toBe(200);
    expect(s3Mocks.getS3ObjectVersionStream).toHaveBeenCalledWith(
      `${project.dataUrl}/label-studio-assets/${grant.id}.png`,
      "snapshot-version-1",
      expect.any(AbortSignal),
    );

    await db
      .update(labelStudioProjectIntents)
      .set({
        leaseExpiresAt: sql`CURRENT_TIMESTAMP - INTERVAL '1 second'`,
      })
      .where(eq(labelStudioProjectIntents.id, intentId));
    expect((await request(grant.id, grant.token)).status).toBe(404);
    expect(s3Mocks.getS3ObjectVersionStream).toHaveBeenCalledTimes(1);
  });

  it("fails a provisioning grant closed as soon as its outer mutation lease is released", async () => {
    const { grant, intentId } = await seedGrant("provisioning");
    expect((await request(grant.id, grant.token)).status).toBe(200);

    const [intent] = await db
      .select({ leaseToken: labelStudioProjectIntents.leaseToken })
      .from(labelStudioProjectIntents)
      .where(eq(labelStudioProjectIntents.id, intentId));
    expect(intent.leaseToken).not.toBeNull();
    await db
      .delete(projectMutationLeases)
      .where(eq(projectMutationLeases.token, intent.leaseToken!));

    expect((await request(grant.id, grant.token)).status).toBe(404);
    expect(s3Mocks.getS3ObjectVersionStream).toHaveBeenCalledTimes(1);
  });

  it("HEAD pins the same version without opening a response stream", async () => {
    const { project, grant } = await seedGrant("active");
    const response = await request(grant.id, grant.token, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(response.headers.get("content-length")).toBe("4");
    expect(s3Mocks.headS3Object).toHaveBeenCalledWith(
      `${project.dataUrl}/label-studio-assets/${grant.id}.png`,
      {
        signal: expect.any(AbortSignal),
        versionId: "snapshot-version-1",
      },
    );
    expect(s3Mocks.getS3ObjectVersionStream).not.toHaveBeenCalled();

    const missing = await request(randomUUID(), grant.token, { method: "HEAD" });
    expect(missing.status).toBe(404);
    expect(missing.body).toBeNull();
    expectPrivatePolicy(missing);
  });

  it("makes malformed, unknown, wrong-token, and revoked grants identical 404s", async () => {
    const active = await seedGrant("active");
    const malformed = await request("not-a-uuid", "x");
    expect(malformed.status).toBe(404);
    expectPrivatePolicy(malformed);

    expect((await request(randomUUID(), active.grant.token)).status).toBe(404);
    expect((await request(active.grant.id, "A".repeat(43))).status).toBe(404);

    const capability = assertProjectWritable(active.project);
    await withProjectWrite(capability, active.project.id, async (tx) => {
      await tx
        .update(labelingSessions)
        .set({ status: "retiring", updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(eq(labelingSessions.id, active.sessionId!));
      await revokeSessionLabelStudioAssetGrants(tx, active.sessionId!);
    });
    expect((await request(active.grant.id, active.grant.token)).status).toBe(
      404,
    );
    expect(s3Mocks.getS3ObjectVersionStream).not.toHaveBeenCalled();
  });

  it("emits CORS only for the exact configured Label Studio origin, including OPTIONS", async () => {
    const { grant } = await seedGrant("active");
    const foreign = await request(grant.id, grant.token, {
      origin: "https://evil.test",
    });
    expect(foreign.status).toBe(200);
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();

    const optionsReq = makeReq(
      `/api/label-assets/${grant.id}?token=${grant.token}`,
      { method: "GET", headers: { origin: "https://ls.test" } },
    );
    const preflight = await OPTIONS(optionsReq);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      "https://ls.test",
    );
    expect(preflight.headers.get("access-control-allow-methods")).toBe(
      "GET, HEAD, OPTIONS",
    );
    expectPrivatePolicy(preflight);
  });

  it("orders revocation after an already-admitted bounded S3 acquisition", async () => {
    const active = await seedGrant("active");
    const started = deferred<void>();
    const object = deferred<{
      body: ReadableStream<Uint8Array>;
      contentLength: number;
    }>();
    s3Mocks.getS3ObjectVersionStream.mockImplementationOnce(async () => {
      started.resolve(undefined);
      return object.promise;
    });

    const pendingRead = request(active.grant.id, active.grant.token);
    await started.promise;
    const capability = assertProjectWritable(active.project);
    let revokeFinished = false;
    const revocation = withProjectWrite(
      capability,
      active.project.id,
      async (tx) => {
        await tx
          .update(labelingSessions)
          .set({ status: "retiring", updatedAt: sql`CURRENT_TIMESTAMP` })
          .where(
            and(
              eq(labelingSessions.id, active.sessionId!),
              eq(labelingSessions.status, "active"),
            ),
          );
        await revokeSessionLabelStudioAssetGrants(tx, active.sessionId!);
      },
    ).then(() => {
      revokeFinished = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(revokeFinished).toBe(false);
    object.resolve({ body: bodyStream([1]), contentLength: 1 });
    const admitted = await pendingRead;
    expect(admitted.status).toBe(200);
    await revocation;
    expect(revokeFinished).toBe(true);
    expect((await request(active.grant.id, active.grant.token)).status).toBe(
      404,
    );
  });

  it("propagates client disconnects into S3 and releases the admission transaction", async () => {
    const active = await seedGrant("active");
    const started = deferred<AbortSignal>();
    s3Mocks.getS3ObjectVersionStream.mockImplementationOnce(
      async (_key: string, _versionId: string, signal: AbortSignal) => {
        started.resolve(signal);
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            { once: true },
          );
        });
      },
    );
    const controller = new AbortController();
    const pending = request(active.grant.id, active.grant.token, {
      signal: controller.signal,
    });
    const s3Signal = await started.promise;

    controller.abort(new Error("client disconnected"));
    expect((await pending).status).toBe(500);
    expect(s3Signal.aborted).toBe(true);

    const capability = assertProjectWritable(active.project);
    await withProjectWrite(capability, active.project.id, async () => undefined);
  });

  it("applies the private policy to unexpected S3 failures", async () => {
    const { grant } = await seedGrant("active");
    s3Mocks.getS3ObjectVersionStream.mockRejectedValueOnce(
      new Error("fixture failure"),
    );
    const response = await request(grant.id, grant.token);
    const parsed = await readJson(response);
    expect(parsed.status).toBe(500);
    expect(parsed.body.error).toEqual({
      code: "INTERNAL",
      message: "Internal server error",
    });
    expectPrivatePolicy(response);
  });
});
