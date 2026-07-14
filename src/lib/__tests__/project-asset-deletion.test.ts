// @vitest-environment node
import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  inject,
  it,
  vi,
} from "vitest";

const boundaries = vi.hoisted(() => {
  type PurgeResult = {
    deletedObjects: number;
    emptySweepObserved: boolean;
  };
  type InvalidationResult = { id: string | null; complete: boolean };

  const finalResults: Array<PurgeResult | Error> = [];
  const stagingResults: Array<PurgeResult | Error> = [];
  const invalidationResults: Array<InvalidationResult | Error> = [];
  const afterFinalEmptySweepHooks: Array<() => Promise<void>> = [];
  const afterFinalObjectsFoundErrors: Error[] = [];
  const events: string[] = [];

  function consume<T>(queue: Array<T | Error>, boundary: string): T {
    const result = queue.shift();
    if (result === undefined) {
      throw new Error(`Unplanned ${boundary} call`);
    }
    if (result instanceof Error) throw result;
    return result;
  }

  return {
    events,
    finalResults,
    stagingResults,
    invalidationResults,
    afterFinalEmptySweepHooks,
    afterFinalObjectsFoundErrors,
    deleteProjectFiles: vi.fn(
      async (
        storageRoot: string,
        options?: { onObjectsFound?: () => Promise<void> },
      ) => {
        events.push(`s3:final:${storageRoot}`);
        const result = consume<PurgeResult>(finalResults, "final-prefix purge");
        if (result.deletedObjects > 0) {
          await options?.onObjectsFound?.();
          const afterIntentError = afterFinalObjectsFoundErrors.shift();
          if (afterIntentError) throw afterIntentError;
          events.push(`s3:final-delete:${storageRoot}`);
        } else {
          await afterFinalEmptySweepHooks.shift()?.();
        }
        return result;
      },
    ),
    deleteProjectStagingFiles: vi.fn(async (storageRoot: string) => {
      events.push(`s3:staging:${storageRoot}`);
      return consume(stagingResults, "staging-prefix purge");
    }),
    ensureProjectCloudFrontInvalidation: vi.fn(
      async (
        storageRoot: string,
        callerReference: string,
        invalidationId?: string | null,
      ) => {
        events.push(
          `cloudfront:${storageRoot}:${callerReference}:${invalidationId ?? "new"}`,
        );
        return consume(invalidationResults, "CloudFront invalidation");
      },
    ),
  };
});

vi.mock("@/lib/s3", () => ({
  deleteProjectFiles: boundaries.deleteProjectFiles,
  deleteProjectStagingFiles: boundaries.deleteProjectStagingFiles,
}));

vi.mock("@/lib/cloudfront", () => ({
  ensureProjectCloudFrontInvalidation:
    boundaries.ensureProjectCloudFrontInvalidation,
}));

import {
  reconcileProjectAssetDeletion,
  type ProjectAssetDeletionResult,
} from "@/lib/project-asset-deletion";
import { db } from "@/lib/db";
import { projectAssetDeletions } from "@/lib/db/schema";

const dbUp = inject("dbUp") as boolean;
const emptyPurge = { deletedObjects: 0, emptySweepObserved: true };

interface SeedOverrides {
  status?: "pending" | "watching" | "completed";
  phase?: "purge" | "invalidate" | "verify" | "watch" | "complete";
  invalidationGeneration?: number;
  objectEventGeneration?: number;
  lastReconciledEventGeneration?: number;
  cloudfrontInvalidationId?: string | null;
  completedAt?: Date | null;
  createdAt?: Date;
}

const originalQueueUrl = process.env.PROJECT_ASSET_EVENT_QUEUE_URL;
const seededDeletionIds = new Set<string>();

function newStorageRoot(): string {
  return `asset-test-${randomUUID().slice(0, 8)}/${randomUUID()
    .replaceAll("-", "")
    .slice(0, 20)}`;
}

async function seedDeletion(overrides: SeedOverrides = {}) {
  const [row] = await db
    .insert(projectAssetDeletions)
    .values({
      projectPublicId: randomUUID(),
      companyId: 91_001,
      storageRoot: newStorageRoot(),
      lifecycleEpoch: 3,
      status: overrides.status ?? "pending",
      phase: overrides.phase ?? "purge",
      invalidationGeneration: overrides.invalidationGeneration ?? 0,
      objectEventGeneration: overrides.objectEventGeneration ?? 0,
      lastReconciledEventGeneration:
        overrides.lastReconciledEventGeneration ?? 0,
      cloudfrontInvalidationId: overrides.cloudfrontInvalidationId ?? null,
      completedAt: overrides.completedAt ?? null,
      createdAt: overrides.createdAt,
      nextAttemptAt: new Date(0),
    })
    .returning();
  seededDeletionIds.add(row.id);
  return row;
}

async function readDeletion(id: string) {
  const [row] = await db
    .select()
    .from(projectAssetDeletions)
    .where(eq(projectAssetDeletions.id, id));
  expect(row).toBeDefined();
  return row;
}

async function makeDue(id: string): Promise<void> {
  await db
    .update(projectAssetDeletions)
    .set({ nextAttemptAt: new Date(0) })
    .where(eq(projectAssetDeletions.id, id));
}

async function reconcile(id: string): Promise<ProjectAssetDeletionResult> {
  return reconcileProjectAssetDeletion(id);
}

beforeEach(() => {
  boundaries.events.length = 0;
  boundaries.finalResults.length = 0;
  boundaries.stagingResults.length = 0;
  boundaries.invalidationResults.length = 0;
  boundaries.afterFinalEmptySweepHooks.length = 0;
  boundaries.afterFinalObjectsFoundErrors.length = 0;
  delete process.env.PROJECT_ASSET_EVENT_QUEUE_URL;
  seededDeletionIds.clear();
  vi.clearAllMocks();
});

afterEach(async () => {
  if (originalQueueUrl === undefined) {
    delete process.env.PROJECT_ASSET_EVENT_QUEUE_URL;
  } else {
    process.env.PROJECT_ASSET_EVENT_QUEUE_URL = originalQueueUrl;
  }
  if (!dbUp) return;
  for (const id of seededDeletionIds) {
    await db
      .delete(projectAssetDeletions)
      .where(eq(projectAssetDeletions.id, id));
  }
});

describe.skipIf(!dbUp)("project asset-deletion outbox state machine", () => {
  it("purges S3 before invalidating, persists an accepted ID, and polls it before verification", async () => {
    const deletion = await seedDeletion();
    boundaries.finalResults.push(emptyPurge, emptyPurge);
    boundaries.stagingResults.push(emptyPurge, emptyPurge);
    boundaries.invalidationResults.push(
      { id: "INV-accepted", complete: false },
      { id: "INV-accepted", complete: true },
    );

    await expect(reconcile(deletion.id)).resolves.toBe("pending");

    const waiting = await readDeletion(deletion.id);
    expect(waiting).toMatchObject({
      status: "pending",
      phase: "invalidate",
      cloudfrontInvalidationId: "INV-accepted",
      attemptCount: 1,
      consecutiveFailures: 0,
      completedAt: null,
      leaseToken: null,
      leaseExpiresAt: null,
    });
    expect(waiting.s3PurgedAt).toBeInstanceOf(Date);
    expect(boundaries.deleteProjectFiles).toHaveBeenCalledTimes(1);
    expect(boundaries.deleteProjectStagingFiles).toHaveBeenCalledTimes(1);
    expect(
      boundaries.ensureProjectCloudFrontInvalidation,
    ).toHaveBeenNthCalledWith(
      1,
      deletion.storageRoot,
      `bp-project-delete:${deletion.id}:0`,
      null,
    );
    const firstCloudFront = boundaries.events.findIndex((event) =>
      event.startsWith("cloudfront:"),
    );
    expect(firstCloudFront).toBeGreaterThan(
      boundaries.events.findIndex((event) => event.startsWith("s3:final:")),
    );
    expect(firstCloudFront).toBeGreaterThan(
      boundaries.events.findIndex((event) => event.startsWith("s3:staging:")),
    );

    const secondAttemptStartsAt = boundaries.events.length;
    await makeDue(deletion.id);
    await expect(reconcile(deletion.id)).resolves.toBe("reconciled");

    expect(
      boundaries.ensureProjectCloudFrontInvalidation,
    ).toHaveBeenNthCalledWith(
      2,
      deletion.storageRoot,
      `bp-project-delete:${deletion.id}:0`,
      "INV-accepted",
    );
    expect(boundaries.events[secondAttemptStartsAt]).toContain(":INV-accepted");
    expect(boundaries.deleteProjectFiles).toHaveBeenCalledTimes(2);
    expect(boundaries.deleteProjectStagingFiles).toHaveBeenCalledTimes(2);

    const completed = await readDeletion(deletion.id);
    expect(completed).toMatchObject({
      status: "watching",
      phase: "watch",
      cloudfrontInvalidationId: "INV-accepted",
      attemptCount: 2,
      consecutiveFailures: 0,
      leaseToken: null,
      leaseExpiresAt: null,
    });
    expect(completed.completedAt).toBeInstanceOf(Date);
    expect(completed.lastVerifiedAt).toBeInstanceOf(Date);
  });

  it("does not complete after CloudFront completion until verification succeeds, and persists retry state", async () => {
    const deletion = await seedDeletion({
      phase: "invalidate",
      cloudfrontInvalidationId: "INV-completed",
    });
    boundaries.invalidationResults.push({
      id: "INV-completed",
      complete: true,
    });
    boundaries.finalResults.push(
      new Error("simulated final-prefix verification outage"),
    );
    boundaries.stagingResults.push(emptyPurge);

    await expect(reconcile(deletion.id)).rejects.toThrow(
      "Project asset purge failed",
    );

    const failed = await readDeletion(deletion.id);
    expect(failed).toMatchObject({
      status: "pending",
      phase: "verify",
      cloudfrontInvalidationId: "INV-completed",
      consecutiveFailures: 1,
      completedAt: null,
      leaseToken: null,
      leaseExpiresAt: null,
    });
    expect(failed.lastError).toContain("Project asset purge failed");

    boundaries.finalResults.push(emptyPurge);
    boundaries.stagingResults.push(emptyPurge);
    await makeDue(deletion.id);
    await expect(reconcile(deletion.id)).resolves.toBe("reconciled");

    expect(
      boundaries.ensureProjectCloudFrontInvalidation,
    ).toHaveBeenCalledTimes(1);
    const recovered = await readDeletion(deletion.id);
    expect(recovered).toMatchObject({
      status: "watching",
      phase: "watch",
      consecutiveFailures: 0,
      lastError: null,
    });
    expect(recovered.completedAt).toBeInstanceOf(Date);
  });

  it("detects a late final object, advances the generation, and starts a new deterministic invalidation", async () => {
    const originalCompletion = new Date("2026-07-14T00:00:00.000Z");
    const deletion = await seedDeletion({
      status: "watching",
      phase: "watch",
      invalidationGeneration: 4,
      cloudfrontInvalidationId: "INV-generation-4",
      completedAt: originalCompletion,
    });
    boundaries.finalResults.push({
      deletedObjects: 1,
      emptySweepObserved: true,
    });
    boundaries.stagingResults.push(emptyPurge);
    boundaries.invalidationResults.push({
      id: "INV-generation-5",
      complete: false,
    });

    await expect(reconcile(deletion.id)).resolves.toBe("pending");

    expect(boundaries.ensureProjectCloudFrontInvalidation).toHaveBeenCalledWith(
      deletion.storageRoot,
      `bp-project-delete:${deletion.id}:5`,
      null,
    );
    const watched = await readDeletion(deletion.id);
    expect(watched).toMatchObject({
      status: "pending",
      phase: "invalidate",
      invalidationGeneration: 5,
      cloudfrontInvalidationId: "INV-generation-5",
      completedAt: originalCompletion,
    });
    const cloudFrontIndex = boundaries.events.findIndex((event) =>
      event.startsWith("cloudfront:"),
    );
    expect(cloudFrontIndex).toBeGreaterThan(
      boundaries.events.findIndex((event) => event.startsWith("s3:final:")),
    );
    expect(cloudFrontIndex).toBeGreaterThan(
      boundaries.events.findIndex((event) => event.startsWith("s3:staging:")),
    );
  });

  it("does not invalidate for a staging-only late object", async () => {
    const originalCompletion = new Date("2026-07-14T00:00:00.000Z");
    const deletion = await seedDeletion({
      status: "watching",
      phase: "watch",
      invalidationGeneration: 2,
      cloudfrontInvalidationId: "INV-generation-2",
      completedAt: originalCompletion,
    });
    boundaries.finalResults.push(emptyPurge);
    boundaries.stagingResults.push({
      deletedObjects: 1,
      emptySweepObserved: true,
    });

    await expect(reconcile(deletion.id)).resolves.toBe("reconciled");

    expect(
      boundaries.ensureProjectCloudFrontInvalidation,
    ).not.toHaveBeenCalled();
    const watched = await readDeletion(deletion.id);
    expect(watched).toMatchObject({
      status: "watching",
      phase: "watch",
      invalidationGeneration: 2,
      cloudfrontInvalidationId: "INV-generation-2",
      completedAt: originalCompletion,
      consecutiveFailures: 0,
    });
    expect(watched.lastVerifiedAt).toBeInstanceOf(Date);
  });

  it("retains a cold watch instead of terminalizing when the durable event queue is disabled", async () => {
    const originalCompletion = new Date("2026-06-01T00:00:00.000Z");
    const deletion = await seedDeletion({
      status: "watching",
      phase: "watch",
      completedAt: originalCompletion,
      createdAt: originalCompletion,
      objectEventGeneration: 6,
      lastReconciledEventGeneration: 6,
    });
    boundaries.finalResults.push(emptyPurge);
    boundaries.stagingResults.push(emptyPurge);

    await expect(reconcile(deletion.id)).resolves.toBe("reconciled");

    const watched = await readDeletion(deletion.id);
    expect(watched).toMatchObject({
      status: "watching",
      phase: "watch",
      completedAt: originalCompletion,
      objectEventGeneration: 6,
      lastReconciledEventGeneration: 6,
      leaseToken: null,
      leaseExpiresAt: null,
    });
    expect(watched.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("terminalizes an old empty watcher only when the durable event queue is enabled", async () => {
    process.env.PROJECT_ASSET_EVENT_QUEUE_URL =
      "https://sqs.us-east-1.amazonaws.com/000000000000/assets";
    const originalCompletion = new Date("2026-06-01T00:00:00.000Z");
    const deletion = await seedDeletion({
      status: "watching",
      phase: "watch",
      completedAt: originalCompletion,
      createdAt: originalCompletion,
      objectEventGeneration: 7,
      lastReconciledEventGeneration: 6,
    });
    boundaries.finalResults.push(emptyPurge);
    boundaries.stagingResults.push(emptyPurge);

    await expect(reconcile(deletion.id)).resolves.toBe("reconciled");

    expect(await readDeletion(deletion.id)).toMatchObject({
      status: "completed",
      phase: "complete",
      completedAt: originalCompletion,
      objectEventGeneration: 7,
      lastReconciledEventGeneration: 7,
      leaseToken: null,
      leaseExpiresAt: null,
    });
  });

  it("fails the completion CAS and requeues purge when an event lands after an empty sweep", async () => {
    process.env.PROJECT_ASSET_EVENT_QUEUE_URL =
      "https://sqs.us-east-1.amazonaws.com/000000000000/assets";
    const originalCompletion = new Date("2026-06-01T00:00:00.000Z");
    const deletion = await seedDeletion({
      status: "watching",
      phase: "watch",
      completedAt: originalCompletion,
      createdAt: originalCompletion,
      objectEventGeneration: 12,
      lastReconciledEventGeneration: 12,
    });
    boundaries.finalResults.push(emptyPurge);
    boundaries.stagingResults.push(emptyPurge);
    boundaries.afterFinalEmptySweepHooks.push(async () => {
      await db
        .update(projectAssetDeletions)
        .set({
          objectEventGeneration: sql`${projectAssetDeletions.objectEventGeneration} + 1`,
        })
        .where(eq(projectAssetDeletions.id, deletion.id));
    });

    await expect(reconcile(deletion.id)).rejects.toThrow(
      "Project asset deletion lease was lost",
    );

    const requeued = await readDeletion(deletion.id);
    expect(requeued).toMatchObject({
      status: "pending",
      phase: "purge",
      completedAt: originalCompletion,
      objectEventGeneration: 13,
      lastReconciledEventGeneration: 12,
      consecutiveFailures: 1,
      leaseToken: null,
      leaseExpiresAt: null,
    });
    expect(requeued.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(requeued.lastError).toContain(
      "Project asset deletion lease was lost",
    );
  });

  it("retains the bumped invalidation generation when purge fails after persisting late-final evidence", async () => {
    const originalCompletion = new Date("2026-07-01T00:00:00.000Z");
    const deletion = await seedDeletion({
      status: "watching",
      phase: "watch",
      completedAt: originalCompletion,
      invalidationGeneration: 21,
      cloudfrontInvalidationId: "INV-generation-21",
    });
    boundaries.finalResults.push({
      deletedObjects: 1,
      emptySweepObserved: false,
    });
    boundaries.stagingResults.push(emptyPurge);
    boundaries.afterFinalObjectsFoundErrors.push(
      new Error("simulated failure after durable late-final intent"),
    );

    await expect(reconcile(deletion.id)).rejects.toThrow(
      "Project asset purge failed",
    );

    expect(
      boundaries.ensureProjectCloudFrontInvalidation,
    ).not.toHaveBeenCalled();
    expect(boundaries.deleteProjectFiles).toHaveBeenCalledTimes(1);
    const retry = await readDeletion(deletion.id);
    expect(retry).toMatchObject({
      status: "pending",
      phase: "purge",
      invalidationGeneration: 22,
      cloudfrontInvalidationId: null,
      completedAt: originalCompletion,
      consecutiveFailures: 1,
      leaseToken: null,
      leaseExpiresAt: null,
    });
    expect(retry.lastError).toContain("Project asset purge failed");
    expect(retry.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });
});
