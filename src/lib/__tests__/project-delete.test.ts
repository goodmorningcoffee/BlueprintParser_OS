// @vitest-environment node
// [refactor jun13 P0.5-G4] Freezes deleteProjectFully's NEW ordering contract:
// all DB rows go in one transaction FIRST, the S3 purge runs only after
// commit. Asset cleanup is a durable outbox: an S3/CDN failure never bubbles,
// but remains recorded for scheduled retry rather than becoming a forgotten orphan.
// [refactor jun16 P0-review G4] Added the annotation_groups cascade assertion.
// That child used to vanish only via a silent DB ON DELETE CASCADE and was
// untested ANYWHERE (the projects/[id] route test seeds a lone annotation, no
// groups). project-delete.ts now deletes it explicitly; this test pins it so a
// future schema/FK change that breaks the teardown fails loudly here.
import { describe, expect, inject, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

const s3CallLog: {
  projectRowsAtCallTime: number;
  tombstoneRowsAtCallTime: number;
  dataUrl: string;
}[] = [];
const stagingS3CallLog: { projectRowsAtCallTime: number; dataUrl: string }[] =
  [];
let s3ShouldThrow = false;

vi.mock("@/lib/cloudfront", () => ({
  ensureProjectCloudFrontInvalidation: vi.fn(async () => ({
    id: "test-invalidation",
    complete: true,
  })),
}));

vi.mock("@/lib/s3", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/s3")>();
  return {
    ...orig,
    headS3Object: vi.fn(async () => ({
      exists: true,
      size: 1024,
      versionId: "replayed-version",
    })),
    deleteProjectFiles: async (dataUrl: string) => {
      const { db } = await import("@/lib/db");
      const { projectAssetDeletions, projects } =
        await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      const [rows, tombstones] = await Promise.all([
        db
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.dataUrl, dataUrl)),
        db
          .select({ id: projectAssetDeletions.id })
          .from(projectAssetDeletions)
          .where(eq(projectAssetDeletions.storageRoot, dataUrl)),
      ]);
      s3CallLog.push({
        projectRowsAtCallTime: rows.length,
        tombstoneRowsAtCallTime: tombstones.length,
        dataUrl,
      });
      if (s3ShouldThrow) throw new Error("simulated S3 outage");
      return { deletedObjects: 0, emptySweepObserved: true };
    },
    deleteProjectStagingFiles: async (dataUrl: string) => {
      const { db } = await import("@/lib/db");
      const { projects } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      const rows = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.dataUrl, dataUrl));
      stagingS3CallLog.push({ projectRowsAtCallTime: rows.length, dataUrl });
      if (s3ShouldThrow) throw new Error("simulated staging S3 outage");
      return { deletedObjects: 0, emptySweepObserved: true };
    },
  };
});

import {
  deleteProjectFully,
  stageProjectDeletionsInTransaction,
} from "@/lib/project-delete";
import { createProject as createProjectFromManifest } from "@/server/services/projects";
import { db } from "@/lib/db";
import {
  annotations,
  annotationGroups,
  annotationGroupMembers,
  chatMessages,
  labelStudioProjectIntents,
  labelingSessions,
  pages,
  processingJobs,
  projectAssetDeletions,
  projectMutationLeases,
  projects,
  users,
} from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import {
  ageProjectForPublication,
  asUser,
  createLabelingSessionFixture,
  createPage,
  createProject,
  createUser,
  createWorld,
  sessionState,
} from "@/test/harness";
import { projectUploadStagingKey } from "@/lib/project-upload-authority";
import {
  PROJECT_STORAGE_ADVISORY_LOCK_SEED,
  acquireProjectMutationLease,
  assertProjectWritable,
  releaseProjectMutationLease,
} from "@/server/api/project-write-capability";
import { ApiError } from "@/server/api/envelope";

const dbUp = inject("dbUp") as boolean;

function s3CallsFor(dataUrl: string) {
  return s3CallLog.filter((call) => call.dataUrl === dataUrl);
}

function stagingS3CallsFor(dataUrl: string) {
  return stagingS3CallLog.filter((call) => call.dataUrl === dataUrl);
}

async function expectConflict(
  operation: Promise<unknown>,
  message: string,
): Promise<void> {
  let error: unknown;
  try {
    await operation;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ code: "CONFLICT", message });
}

async function waitForTransactionWaiter(
  client: PoolClient,
  blockingTransactionId: string,
): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await client.query<{ pid: number }>(
      `SELECT pid
         FROM pg_locks
        WHERE locktype = 'transactionid'
          AND transactionid::text = $1
          AND granted = false
        LIMIT 1`,
      [blockingTransactionId],
    );
    if (result.rows[0]) return result.rows[0].pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    "Timed out waiting for project deletion to block on its page row",
  );
}

async function waitForAdvisoryWaiter(
  client: PoolClient,
  advisoryHolderPid: number,
): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await client.query<{ pid: number }>(
      `SELECT waiter.pid
         FROM pg_locks holder
         JOIN pg_locks waiter
           ON waiter.locktype = holder.locktype
          AND waiter.database IS NOT DISTINCT FROM holder.database
          AND waiter.classid IS NOT DISTINCT FROM holder.classid
          AND waiter.objid IS NOT DISTINCT FROM holder.objid
          AND waiter.objsubid IS NOT DISTINCT FROM holder.objsubid
        WHERE holder.pid = $1
          AND holder.locktype = 'advisory'
          AND holder.granted = true
          AND waiter.granted = false
          AND waiter.pid <> holder.pid
        LIMIT 1`,
      [advisoryHolderPid],
    );
    if (result.rows[0]) return result.rows[0].pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    "Timed out waiting for project creation on the storage-root advisory lock",
  );
}

describe.skipIf(!dbUp)("deleteProjectFully — G4 ordering contract", () => {
  it("commits the DB transaction BEFORE the S3 purge runs", async () => {
    const { project } = await createWorld();
    await ageProjectForPublication(project.id);
    await db
      .insert(pages)
      .values({ projectId: project.id, pageNumber: 1, name: "P1" });
    await db
      .insert(chatMessages)
      .values({ projectId: project.id, role: "user", content: "hi" });

    await deleteProjectFully(
      { id: project.id, dataUrl: project.dataUrl, jobId: null },
      assertProjectWritable(project),
    );

    const call = s3CallLog.find((c) => c.dataUrl === project.dataUrl);
    expect(call).toBeTruthy();
    // The transaction is indivisible from every observer: when external cleanup starts, the
    // project is gone and its permanent tombstone is already committed.
    expect(call!.projectRowsAtCallTime).toBe(0);
    expect(call!.tombstoneRowsAtCallTime).toBe(1);
    expect(stagingS3CallsFor(project.dataUrl)).toEqual([
      expect.objectContaining({ projectRowsAtCallTime: 0 }),
      expect.objectContaining({ projectRowsAtCallTime: 0 }),
    ]);
    const [tombstone] = await db
      .select()
      .from(projectAssetDeletions)
      .where(eq(projectAssetDeletions.storageRoot, project.dataUrl));
    expect(tombstone).toMatchObject({
      projectPublicId: project.publicId,
      status: "watching",
      phase: "watch",
    });
    expect(tombstone.completedAt).toBeInstanceOf(Date);
    expect(
      await db.select().from(pages).where(eq(pages.projectId, project.id)),
    ).toHaveLength(0);
  });

  it("S3 failure does not bubble and the DB delete still stands", async () => {
    const { project } = await createWorld();
    await ageProjectForPublication(project.id);
    s3ShouldThrow = true;
    try {
      await expect(
        deleteProjectFully(
          { id: project.id, dataUrl: project.dataUrl, jobId: null },
          assertProjectWritable(project),
        ),
      ).resolves.toBeUndefined();
    } finally {
      s3ShouldThrow = false;
    }
    expect(
      await db.select().from(projects).where(eq(projects.id, project.id)),
    ).toHaveLength(0);
    const [tombstone] = await db
      .select()
      .from(projectAssetDeletions)
      .where(eq(projectAssetDeletions.storageRoot, project.dataUrl));
    expect(tombstone).toMatchObject({ status: "pending", phase: "purge" });
    expect(tombstone.lastError).toContain("Project asset purge failed");
  });

  it("rolls back every staged deletion, outbox, user mutation, and attribution when the transaction tail fails", async () => {
    const { company, user: victim, project: first } = await createWorld();
    const second = await createProject(company.id, victim.id);
    const otherOwner = await createUser(company.id);
    const referenced = await createProject(company.id, otherOwner.id);
    await Promise.all([
      ageProjectForPublication(first.id),
      ageProjectForPublication(second.id),
    ]);
    const [attribution] = await db
      .insert(annotations)
      .values({
        projectId: referenced.id,
        creatorId: victim.id,
        name: "tail-rollback-attribution",
        minX: 0,
        minY: 0,
        maxX: 1,
        maxY: 1,
        pageNumber: 1,
      })
      .returning({ id: annotations.id });

    await expect(
      db.transaction((tx) =>
        stageProjectDeletionsInTransaction(
          tx,
          [first, second].map((project) => ({
            project,
            writeCapability: assertProjectWritable(project),
          })),
          [assertProjectWritable(referenced)],
          async (lockedTx) => {
            await lockedTx
              .update(annotations)
              .set({ creatorId: null })
              .where(eq(annotations.id, attribution.id));
            await lockedTx.delete(users).where(eq(users.id, victim.id));
            throw new Error("simulated atomic tail failure");
          },
        ),
      ),
    ).rejects.toThrow("simulated atomic tail failure");

    expect(
      await db
        .select({ id: projects.id })
        .from(projects)
        .where(sql`${projects.id} IN (${first.id}, ${second.id})`),
    ).toHaveLength(2);
    expect(
      await db
        .select({ id: projectAssetDeletions.id })
        .from(projectAssetDeletions)
        .where(
          sql`${projectAssetDeletions.storageRoot} IN (${first.dataUrl}, ${second.dataUrl})`,
        ),
    ).toHaveLength(0);
    expect(
      await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, victim.id)),
    ).toHaveLength(1);
    expect(
      await db
        .select({ creatorId: annotations.creatorId })
        .from(annotations)
        .where(eq(annotations.id, attribution.id)),
    ).toEqual([{ creatorId: victim.id }]);
    expect(s3CallsFor(first.dataUrl)).toHaveLength(0);
    expect(s3CallsFor(second.dataUrl)).toHaveLength(0);
  });

  it("locks reversed bulk storage roots lexicographically before touching the later root", async () => {
    const { company, user, project: first } = await createWorld();
    const second = await createProject(company.id, user.id);
    await Promise.all([
      ageProjectForPublication(first.id),
      ageProjectForPublication(second.id),
    ]);
    const ordered = [first, second].sort((left, right) =>
      left.dataUrl < right.dataUrl ? -1 : left.dataUrl > right.dataUrl ? 1 : 0,
    );
    const blockerPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 2,
    });
    const blocker = await blockerPool.connect();
    const probe = await blockerPool.connect();
    let staged: Promise<unknown> | undefined;
    let released = false;
    try {
      await blocker.query("BEGIN");
      const [{ pid }] = (
        await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows;
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, $2))",
        [ordered[0].dataUrl, PROJECT_STORAGE_ADVISORY_LOCK_SEED],
      );

      staged = db.transaction((tx) =>
        stageProjectDeletionsInTransaction(
          tx,
          [ordered[1], ordered[0]].map((project) => ({
            project,
            writeCapability: assertProjectWritable(project),
          })),
          [],
          async () => undefined,
        ),
      );
      await waitForAdvisoryWaiter(blocker, pid);

      const [{ acquired }] = (
        await probe.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_lock(hashtextextended($1, $2)) AS acquired",
          [ordered[1].dataUrl, PROJECT_STORAGE_ADVISORY_LOCK_SEED],
        )
      ).rows;
      expect(acquired).toBe(true);
      if (acquired) {
        await probe.query(
          "SELECT pg_advisory_unlock(hashtextextended($1, $2))",
          [ordered[1].dataUrl, PROJECT_STORAGE_ADVISORY_LOCK_SEED],
        );
      }
      await blocker.query("COMMIT");
      released = true;
      await expect(staged).resolves.toMatchObject({ deletions: { length: 2 } });
    } finally {
      if (!released) await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      probe.release();
      await blockerPool.end();
      await Promise.allSettled(staged ? [staged] : []);
    }
  }, 15_000);

  it("locks reversed bulk project parents by ascending id", async () => {
    const { company, user, project: first } = await createWorld();
    const second = await createProject(company.id, user.id);
    await Promise.all([
      ageProjectForPublication(first.id),
      ageProjectForPublication(second.id),
    ]);
    const ordered = [first, second].sort((left, right) => left.id - right.id);
    const blockerPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 2,
    });
    const blocker = await blockerPool.connect();
    const probe = await blockerPool.connect();
    let staged: Promise<unknown> | undefined;
    let released = false;
    try {
      await blocker.query("BEGIN");
      const [{ xid }] = (
        await blocker.query<{ xid: string }>(
          "SELECT txid_current()::text AS xid",
        )
      ).rows;
      await blocker.query("SELECT 1 FROM projects WHERE id = $1 FOR UPDATE", [
        ordered[0].id,
      ]);

      staged = db.transaction((tx) =>
        stageProjectDeletionsInTransaction(
          tx,
          [ordered[1], ordered[0]].map((project) => ({
            project,
            writeCapability: assertProjectWritable(project),
          })),
          [],
          async () => undefined,
        ),
      );
      await waitForTransactionWaiter(blocker, xid);

      await probe.query("BEGIN");
      await expect(
        probe.query("SELECT 1 FROM projects WHERE id = $1 FOR UPDATE NOWAIT", [
          ordered[1].id,
        ]),
      ).resolves.toBeDefined();
      await probe.query("ROLLBACK");
      await blocker.query("COMMIT");
      released = true;
      await expect(staged).resolves.toMatchObject({ deletions: { length: 2 } });
    } finally {
      await probe.query("ROLLBACK").catch(() => undefined);
      if (!released) await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      probe.release();
      await blockerPool.end();
      await Promise.allSettled(staged ? [staged] : []);
    }
  }, 15_000);

  it("removes annotation_groups + their member links (the previously cascade-only path)", async () => {
    const { user, project } = await createWorld();
    await ageProjectForPublication(project.id);
    // an annotation + a group + the M:N link between them
    const [anno] = await db
      .insert(annotations)
      .values({
        projectId: project.id,
        name: "A1",
        minX: 0,
        maxX: 1,
        minY: 0,
        maxY: 1,
        pageNumber: 1,
        creatorId: user.id,
      })
      .returning();
    const [group] = await db
      .insert(annotationGroups)
      .values({ projectId: project.id, name: "Doors" })
      .returning();
    await db
      .insert(annotationGroupMembers)
      .values({ annotationId: anno.id, groupId: group.id });

    await deleteProjectFully(
      { id: project.id, dataUrl: project.dataUrl, jobId: null },
      assertProjectWritable(project),
    );

    // annotation_groups: the one child that used to rely on a silent DB cascade
    // — now deleted explicitly, asserted gone here.
    expect(
      await db
        .select()
        .from(annotationGroups)
        .where(eq(annotationGroups.projectId, project.id)),
    ).toHaveLength(0);
    // the junction has no direct project FK; it clears via its parents' cascade
    expect(
      await db
        .select()
        .from(annotationGroupMembers)
        .where(eq(annotationGroupMembers.groupId, group.id)),
    ).toHaveLength(0);
  });

  it.each([
    { kind: "ingestion", modelConfig: null },
    {
      kind: "YOLO",
      modelConfig: { modelId: 41, modelName: "delete-quiescence-witness" },
    },
  ])(
    "rejects a running $kind job without touching DB rows or S3",
    async ({ kind, modelConfig }) => {
      const executionId = `delete-${kind.toLowerCase()}-${crypto.randomUUID()}`;
      const { project } = await createWorld(
        kind === "ingestion" ? { jobId: executionId } : {},
      );
      await ageProjectForPublication(project.id);
      await db
        .insert(pages)
        .values({ projectId: project.id, pageNumber: 1, name: "Must survive" });
      const [job] = await db
        .insert(processingJobs)
        .values({
          projectId: project.id,
          executionId,
          status: "running",
          modelConfig,
        })
        .returning();

      await expectConflict(
        deleteProjectFully(
          { id: project.id, dataUrl: project.dataUrl, jobId: project.jobId },
          assertProjectWritable(project),
        ),
        "Project has an active processing job",
      );

      expect(
        await db.select().from(projects).where(eq(projects.id, project.id)),
      ).toHaveLength(1);
      expect(
        await db.select().from(pages).where(eq(pages.projectId, project.id)),
      ).toHaveLength(1);
      expect(
        await db
          .select()
          .from(processingJobs)
          .where(eq(processingJobs.id, job.id)),
      ).toHaveLength(1);
      // deleteProjectFully inserted the tombstone before finding this blocker. The rejected
      // transaction must roll that insert back together with every attempted child deletion.
      expect(
        await db
          .select()
          .from(projectAssetDeletions)
          .where(eq(projectAssetDeletions.storageRoot, project.dataUrl)),
      ).toHaveLength(0);
      expect(s3CallsFor(project.dataUrl)).toHaveLength(0);
    },
  );

  it("DB trigger permanently rejects a raw project INSERT on a retired storage root", async () => {
    const { company, user, project } = await createWorld();
    await ageProjectForPublication(project.id);
    await deleteProjectFully(
      { id: project.id, dataUrl: project.dataUrl, jobId: null },
      assertProjectWritable(project),
    );

    let error: unknown;
    try {
      await db.insert(projects).values({
        name: "raw retired-root reuse",
        dataUrl: project.dataUrl,
        authorId: user.id,
        companyId: company.id,
      });
    } catch (caught) {
      error = caught;
    }

    const pgError =
      (error as { cause?: { code?: string; message?: string } } | undefined)
        ?.cause ?? (error as { code?: string; message?: string } | undefined);
    expect(pgError?.code).toBe("23514");
    expect(pgError?.message).toContain("project storage root has been retired");
    expect(
      await db
        .select()
        .from(projects)
        .where(eq(projects.dataUrl, project.dataUrl)),
    ).toHaveLength(0);
  });

  it("serializes concurrent create behind delete and rejects the ABA root reuse", async () => {
    const { user, project } = await createWorld();
    await ageProjectForPublication(project.id);
    const page = await createPage(project.id, 1);
    asUser(user);
    const session = sessionState.current!;
    const capability = assertProjectWritable(project);
    const blockerPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
    });
    const blocker = await blockerPool.connect();
    let deletion: Promise<void> | undefined;
    let creation: Promise<unknown> | undefined;
    let operationError: unknown;

    try {
      await blocker.query("BEGIN");
      const xid = await blocker.query<{ xid: string }>(
        "SELECT txid_current()::text AS xid",
      );
      await blocker.query("SELECT 1 FROM pages WHERE id = $1 FOR UPDATE", [
        page.id,
      ]);

      deletion = deleteProjectFully(
        { id: project.id, dataUrl: project.dataUrl, jobId: null },
        capability,
      );
      const deletingPid = await waitForTransactionWaiter(
        blocker,
        xid.rows[0].xid,
      );

      creation = createProjectFromManifest(
        {
          name: "replayed retired root",
          dataUrl: project.dataUrl,
          stagingFiles: [
            {
              filename: "plan.pdf",
              stagingKey: projectUploadStagingKey(
                project.dataUrl,
                "plan.pdf",
                0,
              ),
            },
          ],
        },
        session,
      );
      // The expected rejection happens as soon as deletion releases the advisory lock. Attach a
      // handler now so the runner never observes a transient unhandled rejection before the final
      // assertion consumes the original promise.
      void creation.catch(() => undefined);

      // This observes the exact lock edge, rather than relying on promise timing: creation is
      // queued on the advisory lock held by the deleting transaction while its tombstone is still
      // uncommitted and therefore invisible to other snapshots.
      await waitForAdvisoryWaiter(blocker, deletingPid);
    } catch (error) {
      operationError = error;
    } finally {
      await blocker.query("COMMIT").catch(async () => {
        await blocker.query("ROLLBACK").catch(() => undefined);
      });
      blocker.release();
      await blockerPool.end();
    }

    if (operationError) {
      await Promise.allSettled(
        [deletion, creation].filter(Boolean) as Promise<unknown>[],
      );
      throw operationError;
    }
    await expect(deletion).resolves.toBeUndefined();
    await expectConflict(creation!, "Project storage root has been retired");
    expect(
      await db
        .select()
        .from(projects)
        .where(eq(projects.dataUrl, project.dataUrl)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(projectAssetDeletions)
        .where(eq(projectAssetDeletions.storageRoot, project.dataUrl)),
    ).toHaveLength(1);
  }, 15_000);

  it("rejects active and missed-heartbeat leases until explicit release", async () => {
    const { project } = await createWorld();
    await ageProjectForPublication(project.id);
    const capability = assertProjectWritable(project);
    const lease = await acquireProjectMutationLease(capability, {
      kind: "delete-quiescence-witness",
      idempotencyKey: `delete-quiescence-witness-${project.id}`,
    });
    const deletion = () =>
      deleteProjectFully(
        { id: project.id, dataUrl: project.dataUrl, jobId: null },
        capability,
      );

    await expectConflict(deletion(), "Project has an active mutation lease");
    expect(s3CallsFor(project.dataUrl)).toHaveLength(0);

    // Expiry is diagnostic only: a missed heartbeat cannot prove that external work stopped.
    await db
      .update(projectMutationLeases)
      .set({ expiresAt: sql`CURRENT_TIMESTAMP - INTERVAL '1 second'` })
      .where(eq(projectMutationLeases.token, lease.token));
    await expectConflict(deletion(), "Project has an active mutation lease");
    expect(
      await db.select().from(projects).where(eq(projects.id, project.id)),
    ).toHaveLength(1);
    expect(s3CallsFor(project.dataUrl)).toHaveLength(0);

    await releaseProjectMutationLease(capability, lease);
    await expect(deletion()).resolves.toBeUndefined();
    expect(
      await db.select().from(projects).where(eq(projects.id, project.id)),
    ).toHaveLength(0);
    expect(s3CallsFor(project.dataUrl)).toHaveLength(2);
  });

  it("rejects a young project while its upload authority may still be active", async () => {
    const { project } = await createWorld();

    await expectConflict(
      deleteProjectFully(
        { id: project.id, dataUrl: project.dataUrl, jobId: null },
        assertProjectWritable(project),
      ),
      "Project upload credentials are still active",
    );

    expect(
      await db.select().from(projects).where(eq(projects.id, project.id)),
    ).toHaveLength(1);
    expect(s3CallsFor(project.dataUrl)).toHaveLength(0);
  });

  it("rejects a linked Label Studio session without deleting DB rows or S3 objects", async () => {
    const { company, project } = await createWorld();
    await ageProjectForPublication(project.id);
    const labelingSession = await createLabelingSessionFixture(project, {
      labelStudioProjectId: 93000 + project.id,
      labelStudioUrl: `http://ls.test/projects/${93000 + project.id}`,
      taskType: "generic",
      status: "active",
    });

    await expectConflict(
      deleteProjectFully(
        { id: project.id, dataUrl: project.dataUrl, jobId: null },
        assertProjectWritable(project),
      ),
      "Project has linked labeling sessions",
    );

    expect(
      await db.select().from(projects).where(eq(projects.id, project.id)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(labelingSessions)
        .where(eq(labelingSessions.id, labelingSession.id)),
    ).toHaveLength(1);
    expect(s3CallsFor(project.dataUrl)).toHaveLength(0);
  });

  it("rejects a pending Label Studio provider intent without committing its asset tombstone", async () => {
    const { company, project } = await createWorld();
    await ageProjectForPublication(project.id);
    const intentId = randomUUID();
    await db.insert(labelStudioProjectIntents).values({
      id: intentId,
      projectId: project.id,
      companyId: company.id,
      lifecycleEpoch: project.lifecycleEpoch,
      marker: `bp-labeling-intent:${intentId}`,
      providerBaseUrl: "https://labels.test",
      providerInstanceId: `project-delete-provider-${intentId}`,
      state: "create_uncertain",
    });

    await expectConflict(
      deleteProjectFully(
        { id: project.id, dataUrl: project.dataUrl, jobId: null },
        assertProjectWritable(project),
      ),
      "Project has pending Label Studio provisioning",
    );

    expect(
      await db.select().from(projects).where(eq(projects.id, project.id)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(labelStudioProjectIntents)
        .where(eq(labelStudioProjectIntents.id, intentId)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(projectAssetDeletions)
        .where(eq(projectAssetDeletions.storageRoot, project.dataUrl)),
    ).toHaveLength(0);
    expect(s3CallsFor(project.dataUrl)).toHaveLength(0);
  });
});
