// @vitest-environment node
// Admin data tools §1.2a/§1.2b — provider-aware ingest reconcile + delete-time reconcile.
// Step Functions is mocked; every fixture is synthetic.
import { beforeEach, describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

const sfnMocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/client-sfn", () => ({
  SFNClient: class {
    send = sfnMocks.send;
  },
  DescribeExecutionCommand: class {
    readonly kind = "describe";
    constructor(readonly input: { executionArn: string }) {}
  },
  StopExecutionCommand: class {
    readonly kind = "stop";
    constructor(readonly input: { executionArn: string }) {}
  },
}));

vi.mock("@/lib/cloudfront", () => ({
  ensureProjectCloudFrontInvalidation: vi.fn(async () => ({ id: "inv", complete: true })),
}));
vi.mock("@/lib/s3", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/s3")>();
  return {
    ...orig,
    headS3Object: vi.fn(async () => ({ exists: false })),
    deleteProjectFiles: vi.fn(async () => ({ deletedObjects: 0, emptySweepObserved: true })),
    deleteProjectStagingFiles: vi.fn(async () => ({ deletedObjects: 0, emptySweepObserved: true })),
  };
});

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { processingJobs, projectMutationLeases, projects } from "@/lib/db/schema";
import { deleteProjectFully } from "@/lib/project-delete";
import {
  acquireProjectMutationLease,
  assertProjectWritable,
} from "@/server/api/project-write-capability";
import { ApiError } from "@/server/api/envelope";
import {
  NEVER_STARTED_MIN_AGE_MS,
  TERMINAL_GRACE_MS,
  decideIngestAction,
  describeIngestExecution,
  executionArnPrefix,
  reconcileIngestJob,
  reconcileProjectIngestJobs,
  type ProviderView,
} from "@/server/services/ingest-reconcile";
import { ageProjectForPublication, createWorld } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;
const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);

function terminal(status: "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "ABORTED", stopAgoMs: number): ProviderView {
  return {
    state: "terminal",
    status,
    startDate: new Date(NOW - stopAgoMs - 30 * MIN),
    stopDate: new Date(NOW - stopAgoMs),
    error: status === "SUCCEEDED" ? null : "States.TaskFailed",
  };
}

function awsError(name: string): Error {
  const err = new Error(`${name}: synthetic`);
  err.name = name;
  return err;
}

beforeEach(() => {
  sfnMocks.send.mockReset();
});

describe("decideIngestAction (decision table)", () => {
  const job = { startedAt: new Date(NOW - 60 * MIN) };

  it.each(["FAILED", "TIMED_OUT", "ABORTED"] as const)("%s past the grace → close failed with the status", (status) => {
    const decision = decideIngestAction(job, terminal(status, 10 * MIN), NOW);
    expect(decision).toMatchObject({ action: "close", jobStatus: "failed" });
    expect(decision.action === "close" && decision.error).toContain(status);
  });

  it("SUCCEEDED past the grace → close completed, no error", () => {
    expect(decideIngestAction(job, terminal("SUCCEEDED", 10 * MIN), NOW)).toEqual({
      action: "close",
      jobStatus: "completed",
      error: null,
    });
  });

  it("grace boundary: 2:59 waits, 3:01 closes", () => {
    expect(decideIngestAction(job, terminal("FAILED", TERMINAL_GRACE_MS - 1000), NOW).action).toBe("wait");
    expect(decideIngestAction(job, terminal("FAILED", TERMINAL_GRACE_MS + 1000), NOW).action).toBe("close");
  });

  it("ExecutionDoesNotExist: young row waits, old row closes as never started", () => {
    const young = { startedAt: new Date(NOW - NEVER_STARTED_MIN_AGE_MS + MIN) };
    const old = { startedAt: new Date(NOW - NEVER_STARTED_MIN_AGE_MS - MIN) };
    expect(decideIngestAction(young, { state: "missing" }, NOW).action).toBe("wait");
    expect(decideIngestAction(old, { state: "missing" }, NOW).action).toBe("close-never-started");
  });

  it("RUNNING and provider failures (throttle, access denied) change nothing", () => {
    expect(
      decideIngestAction(job, { state: "running", status: "RUNNING", startDate: new Date(NOW - 5 * MIN) }, NOW),
    ).toMatchObject({ action: "none", reason: expect.stringContaining("still RUNNING on AWS since") });
    expect(decideIngestAction(job, { state: "unavailable", reason: "AWS lookup failed (ThrottlingException)" }, NOW)).toEqual({
      action: "none",
      reason: "AWS lookup failed (ThrottlingException)",
    });
  });
});

describe("describeIngestExecution", () => {
  const arn = () => `${executionArnPrefix()}proj-1-123`;

  it("never calls AWS for an execution outside this deployment's state machine", async () => {
    const view = await describeIngestExecution("arn:aws:states:us-east-1:111111111111:execution:other:proj-1-1");
    expect(view.state).toBe("unavailable");
    expect(await describeIngestExecution(null)).toMatchObject({ state: "unavailable" });
    expect(sfnMocks.send).not.toHaveBeenCalled();
  });

  it("maps terminal output and drops input/cause", async () => {
    sfnMocks.send.mockResolvedValueOnce({
      status: "FAILED",
      startDate: new Date(NOW - 20 * MIN),
      stopDate: new Date(NOW - 10 * MIN),
      error: "States.TaskFailed",
      cause: "synthetic-cause-with-overrides",
      input: '{"webhookSecret":"synthetic-secret"}',
    });
    const view = await describeIngestExecution(arn());
    expect(view).toMatchObject({ state: "terminal", status: "FAILED", error: "States.TaskFailed" });
    expect(JSON.stringify(view)).not.toContain("synthetic-secret");
    expect(JSON.stringify(view)).not.toContain("synthetic-cause");
  });

  it("ExecutionDoesNotExist → missing; throttle / access denied → unavailable", async () => {
    sfnMocks.send.mockRejectedValueOnce(awsError("ExecutionDoesNotExist"));
    expect(await describeIngestExecution(arn())).toEqual({ state: "missing" });
    sfnMocks.send.mockRejectedValueOnce(awsError("ThrottlingException"));
    expect(await describeIngestExecution(arn())).toEqual({
      state: "unavailable",
      reason: "AWS lookup failed (ThrottlingException)",
    });
    sfnMocks.send.mockRejectedValueOnce(awsError("AccessDeniedException"));
    expect(await describeIngestExecution(arn())).toMatchObject({
      state: "unavailable",
      reason: expect.stringContaining("states:DescribeExecution"),
    });
  });
});

async function seedIngest(opts: { jobName?: string; projectJobId?: string | null; startedAgoMs?: number } = {}) {
  const executionName = opts.jobName ?? `proj-x-${crypto.randomUUID()}`;
  const { company, user, project } = await createWorld({
    status: "processing",
    jobId: opts.projectJobId === undefined ? executionName : opts.projectJobId,
  });
  await ageProjectForPublication(project.id);
  const [job] = await db
    .insert(processingJobs)
    .values({
      projectId: project.id,
      executionId: `${executionArnPrefix()}${executionName}`,
      status: "running",
      startedAt: new Date(Date.now() - (opts.startedAgoMs ?? 60 * MIN)),
    })
    .returning();
  return { company, user, project, job, capability: assertProjectWritable(project) };
}

async function workerLease(
  project: { id: number },
  capability: ReturnType<typeof assertProjectWritable>,
  createdAgoMs: number,
  kind = "project-processing",
) {
  const lease = await acquireProjectMutationLease(capability, {
    kind,
    idempotencyKey: kind === "project-processing" ? String(project.id) : `${kind}-${project.id}`,
  });
  await db
    .update(projectMutationLeases)
    .set({ createdAt: sql`CURRENT_TIMESTAMP - (${createdAgoMs} * INTERVAL '1 millisecond')` })
    .where(eq(projectMutationLeases.token, lease.token));
  return lease;
}

function awsTerminal(status: string, startAgoMs: number, stopAgoMs: number) {
  sfnMocks.send.mockResolvedValue({
    status,
    startDate: new Date(Date.now() - startAgoMs),
    stopDate: new Date(Date.now() - stopAgoMs),
    error: status === "SUCCEEDED" ? undefined : "States.TaskFailed",
  });
}

async function leasesOf(projectId: number) {
  return db.select().from(projectMutationLeases).where(eq(projectMutationLeases.projectId, projectId));
}

async function expectConflict(op: Promise<unknown>, contains: string) {
  let error: unknown;
  try {
    await op;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).code).toBe("CONFLICT");
  expect((error as ApiError).message).toContain(contains);
}

describe.skipIf(!dbUp)("reconcileIngestJob + delete (DB)", () => {
  it("terminal FAILED + orphan worker lease in the run window → job failed, project error, lease reclaimed, delete succeeds", async () => {
    const { project, job, capability } = await seedIngest();
    await workerLease(project, capability, 40 * MIN);
    awsTerminal("FAILED", 50 * MIN, 10 * MIN);

    await expect(
      deleteProjectFully({ id: project.id, dataUrl: project.dataUrl, jobId: project.jobId }, capability),
    ).resolves.toBeUndefined();
    expect(await db.select().from(projects).where(eq(projects.id, project.id))).toHaveLength(0);
    expect(sfnMocks.send).toHaveBeenCalledTimes(1);
    void job;
  }, 20_000);

  it("closes the job and reclaims the lease without deleting (direct reconcile)", async () => {
    const { project, job, capability } = await seedIngest();
    await workerLease(project, capability, 40 * MIN);
    awsTerminal("FAILED", 50 * MIN, 10 * MIN);

    const outcome = await reconcileIngestJob(job, project.publicId, capability);
    expect(outcome).toMatchObject({ changed: true, jobClosedAs: "failed", projectStatusSet: "error", leasesReclaimed: 1 });
    expect(outcome.leaseRefusal).toBeUndefined();
    const [row] = await db.select().from(processingJobs).where(eq(processingJobs.id, job.id));
    expect(row.status).toBe("failed");
    expect(row.error).toContain("FAILED");
    const [proj] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(proj.status).toBe("error");
    expect(await leasesOf(project.id)).toHaveLength(0);

    // idempotent: a second run changes nothing
    const again = await reconcileIngestJob(job, project.publicId, capability);
    expect(again.changed).toBe(false);
  });

  it("SUCCEEDED → job completed; a project the worker already completed keeps its status", async () => {
    const { project, job, capability } = await seedIngest();
    await db.update(projects).set({ status: "completed" }).where(eq(projects.id, project.id));
    awsTerminal("SUCCEEDED", 50 * MIN, 10 * MIN);
    const outcome = await reconcileIngestJob(job, project.publicId, capability);
    expect(outcome).toMatchObject({ changed: true, jobClosedAs: "completed" });
    expect(outcome.projectStatusSet).toBeUndefined();
    const [proj] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(proj.status).toBe("completed");
  });

  it("RUNNING → nothing changes and delete still refuses, naming AWS", async () => {
    const { project, job, capability } = await seedIngest();
    sfnMocks.send.mockResolvedValue({ status: "RUNNING", startDate: new Date(Date.now() - 5 * MIN) });
    await expectConflict(
      deleteProjectFully({ id: project.id, dataUrl: project.dataUrl, jobId: project.jobId }, capability),
      "Project has an active processing job (still RUNNING on AWS since",
    );
    const [row] = await db.select().from(processingJobs).where(eq(processingJobs.id, job.id));
    expect(row.status).toBe("running");
  });

  it("AWS failure → delete keeps today's exact refusal", async () => {
    const { project, capability } = await seedIngest();
    sfnMocks.send.mockRejectedValue(awsError("ThrottlingException"));
    let message = "";
    try {
      await deleteProjectFully({ id: project.id, dataUrl: project.dataUrl, jobId: project.jobId }, capability);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("Project has an active processing job");
  });

  it("terminal but inside the grace → refusal explains the wait and points at Stuck jobs", async () => {
    const { project, capability } = await seedIngest();
    awsTerminal("FAILED", 20 * MIN, MIN);
    await expectConflict(
      deleteProjectFully({ id: project.id, dataUrl: project.dataUrl, jobId: project.jobId }, capability),
      "closing after a 3-minute grace; see Admin > Data tools > Stuck jobs",
    );
  });

  it("lease created outside [startDate, stopDate] survives, refusal reported", async () => {
    const { project, job, capability } = await seedIngest();
    await workerLease(project, capability, 5 * MIN); // after the stop
    awsTerminal("FAILED", 50 * MIN, 10 * MIN);
    const outcome = await reconcileIngestJob(job, project.publicId, capability);
    expect(outcome.changed).toBe(true);
    expect(outcome.leasesReclaimed).toBe(0);
    expect(outcome.leaseRefusal).toContain("outside this execution's run window");
    expect(await leasesOf(project.id)).toHaveLength(1);
    // the job is already closed now, so a delete sees only the lease (no new provider info)
    await expectConflict(
      deleteProjectFully({ id: project.id, dataUrl: project.dataUrl, jobId: project.jobId }, capability),
      "Project has an active mutation lease",
    );
  });

  it("lease created BEFORE the execution's startDate survives (window lower bound)", async () => {
    const { project, job, capability } = await seedIngest();
    await workerLease(project, capability, 55 * MIN); // start is 50 min ago
    awsTerminal("FAILED", 50 * MIN, 10 * MIN);
    const outcome = await reconcileIngestJob(job, project.publicId, capability);
    expect(outcome).toMatchObject({ changed: true, jobClosedAs: "failed", leasesReclaimed: 0 });
    expect(outcome.leaseRefusal).toContain("outside this execution's run window");
    expect(await leasesOf(project.id)).toHaveLength(1);
  });

  it("lease from another lifecycle generation survives even inside the run window", async () => {
    const { project, job, capability } = await seedIngest();
    const lease = await workerLease(project, capability, 40 * MIN);
    // the projects epoch guard only moves on a demo flip, so stamp the lease row instead
    await db
      .update(projectMutationLeases)
      .set({ lifecycleEpoch: capability.lifecycleEpoch + 1 })
      .where(eq(projectMutationLeases.token, lease.token));
    awsTerminal("FAILED", 50 * MIN, 10 * MIN);
    const outcome = await reconcileIngestJob(job, project.publicId, capability);
    expect(outcome).toMatchObject({ changed: true, jobClosedAs: "failed", leasesReclaimed: 0 });
    expect(outcome.leaseRefusal).toContain("lifecycle generation");
    const leases = await leasesOf(project.id);
    expect(leases).toHaveLength(1);
    expect(leases[0].lifecycleEpoch).toBe(capability.lifecycleEpoch + 1);
  });

  it("a web-held lease taken inside the run window is never reclaimed; delete refuses", async () => {
    const { project, job, capability } = await seedIngest();
    await workerLease(project, capability, 40 * MIN);
    await workerLease(project, capability, 30 * MIN, "admin-reprocess:full"); // live web operation
    awsTerminal("FAILED", 50 * MIN, 10 * MIN);
    await expectConflict(
      deleteProjectFully({ id: project.id, dataUrl: project.dataUrl, jobId: project.jobId }, capability),
      "Project has an active mutation lease",
    );
    expect(await db.select().from(projects).where(eq(projects.id, project.id))).toHaveLength(1);
    const [row] = await db.select().from(processingJobs).where(eq(processingJobs.id, job.id));
    expect(row.status).toBe("failed");
    const leases = await leasesOf(project.id);
    expect(leases.map((lease) => lease.kind)).toEqual(["admin-reprocess:full"]);
  }, 20_000);

  it("projects.jobId mismatch → lease kept", async () => {
    const { project, job, capability } = await seedIngest({ projectJobId: "proj-x-some-later-run" });
    await workerLease(project, capability, 40 * MIN);
    awsTerminal("FAILED", 50 * MIN, 10 * MIN);
    const outcome = await reconcileIngestJob(job, project.publicId, capability);
    expect(outcome.leaseRefusal).toContain("current job id is not this execution");
    expect(await leasesOf(project.id)).toHaveLength(1);
  });

  it("two ingest rows (one terminal on AWS, one live) → the live lease survives, refusal reported", async () => {
    const { project, job, capability } = await seedIngest();
    const liveName = `proj-x-live-${crypto.randomUUID()}`;
    await db.insert(processingJobs).values({
      projectId: project.id,
      executionId: `${executionArnPrefix()}${liveName}`,
      status: "running",
    });
    await workerLease(project, capability, 40 * MIN);
    awsTerminal("FAILED", 50 * MIN, 10 * MIN);
    const outcome = await reconcileIngestJob(job, project.publicId, capability);
    expect(outcome.changed).toBe(true);
    expect(outcome.leaseRefusal).toContain("2 ingest jobs");
    expect(await leasesOf(project.id)).toHaveLength(1);
  });

  it("ExecutionDoesNotExist on an old row → closed as never started, no lease action", async () => {
    const { project, job, capability } = await seedIngest({ startedAgoMs: 20 * MIN });
    await workerLease(project, capability, 10 * MIN);
    sfnMocks.send.mockRejectedValue(awsError("ExecutionDoesNotExist"));
    const outcome = await reconcileIngestJob(job, project.publicId, capability);
    expect(outcome).toMatchObject({ changed: true, jobClosedAs: "failed", leasesReclaimed: 0 });
    const [row] = await db.select().from(processingJobs).where(eq(processingJobs.id, job.id));
    expect(row.error).toBe("Step Functions execution never started");
    expect(await leasesOf(project.id)).toHaveLength(1);
  });

  it("processingDev-shaped lease (no ingest row) → nothing reconciled, delete refuses unchanged", async () => {
    const { project } = await createWorld();
    await ageProjectForPublication(project.id);
    const capability = assertProjectWritable(project);
    await workerLease(project, capability, 60 * MIN);
    expect(await reconcileProjectIngestJobs(project.id, capability)).toEqual([]);
    expect(sfnMocks.send).not.toHaveBeenCalled();
    let message = "";
    try {
      await deleteProjectFully({ id: project.id, dataUrl: project.dataUrl, jobId: null }, capability);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("Project has an active mutation lease");
  });

  it("closed rows are never reopened or relabelled", async () => {
    const { project, job, capability } = await seedIngest();
    await db
      .update(processingJobs)
      .set({ status: "completed", error: null })
      .where(and(eq(processingJobs.id, job.id)));
    awsTerminal("FAILED", 50 * MIN, 10 * MIN);
    expect(await reconcileProjectIngestJobs(project.id, capability)).toEqual([]);
    const [row] = await db.select().from(processingJobs).where(eq(processingJobs.id, job.id));
    expect(row).toMatchObject({ status: "completed", error: null });
  });
});
