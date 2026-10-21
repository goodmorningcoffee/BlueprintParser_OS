// @vitest-environment node
// Admin data tools §1.2d/§1.2e — /api/admin/stuck-jobs (list, reconcile, stop, force-release) and
// the YOLO never-accepted close in PUT /api/admin/running-jobs. Providers mocked; fixtures synthetic.
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

const h = vi.hoisted(() => ({ send: vi.fn(), getYoloJobStatus: vi.fn() }));
vi.mock("@aws-sdk/client-sfn", () => ({
  SFNClient: class {
    send = h.send;
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
vi.mock("@/lib/yolo", () => ({ getYoloJobStatus: h.getYoloJobStatus }));

import { GET as listGET } from "@/app/api/admin/stuck-jobs/route";
import { POST as reconcilePOST } from "@/app/api/admin/stuck-jobs/reconcile/route";
import { POST as stopPOST } from "@/app/api/admin/stuck-jobs/stop/route";
import { POST as forcePOST } from "@/app/api/admin/stuck-jobs/force-release/route";
import { PUT as runningPUT } from "@/app/api/admin/running-jobs/route";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  auditLog,
  computeUsage,
  processingJobs,
  projectMutationLeases,
  projects,
} from "@/lib/db/schema";
import {
  acquireProjectMutationLease,
  assertProjectWritable,
} from "@/server/api/project-write-capability";
import { executionArnPrefix } from "@/server/services/ingest-reconcile";
import {
  asUser,
  createCompany,
  createProject,
  createUser,
  makeReq,
  publishDemoFixture,
  readJson,
  signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;
const MIN = 60_000;

async function world() {
  const company = await createCompany();
  const admin = await createUser(company.id, { role: "admin" });
  const member = await createUser(company.id);
  const root = await createUser(company.id, { isRootAdmin: true });
  const project = await createProject(company.id, member.id, { status: "processing" });
  return { company, admin, member, root, project };
}

async function seedIngestJob(project: typeof projects.$inferSelect, startedAgoMs = 60 * MIN) {
  const name = `proj-${project.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await db.update(projects).set({ jobId: name }).where(eq(projects.id, project.id));
  const [job] = await db
    .insert(processingJobs)
    .values({
      projectId: project.id,
      executionId: `${executionArnPrefix()}${name}`,
      status: "running",
      startedAt: new Date(Date.now() - startedAgoMs),
    })
    .returning();
  return job;
}

async function leaseOf(project: typeof projects.$inferSelect, kind: string, createdAgoMs: number) {
  const lease = await acquireProjectMutationLease(assertProjectWritable(project), {
    kind,
    idempotencyKey: `${kind}-${project.id}-${Math.random()}`,
  });
  await db
    .update(projectMutationLeases)
    // an orphan: its holder stopped heartbeating when it was created
    .set({
      createdAt: sql`CURRENT_TIMESTAMP - (${createdAgoMs} * INTERVAL '1 millisecond')`,
      heartbeatAt: sql`CURRENT_TIMESTAMP - (${createdAgoMs} * INTERVAL '1 millisecond')`,
    })
    .where(eq(projectMutationLeases.token, lease.token));
  return lease;
}

async function activeKinds(projectId: number) {
  const rows = await db
    .select({ kind: projectMutationLeases.kind })
    .from(projectMutationLeases)
    .where(eq(projectMutationLeases.projectId, projectId));
  return rows.map((row) => row.kind).sort();
}

async function waitForAudit(action: string, userId: number) {
  for (let i = 0; i < 40; i++) {
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, action), eq(auditLog.userId, userId)));
    if (rows.length > 0) return rows;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return [];
}

const list = (qs = "") => listGET(makeReq(`/api/admin/stuck-jobs${qs}`, { method: "GET" }));
const reconcile = (body: unknown) => reconcilePOST(makeReq("/api/admin/stuck-jobs/reconcile", { body }));
const stop = (body: unknown) => stopPOST(makeReq("/api/admin/stuck-jobs/stop", { body }));
const force = (body: unknown) => forcePOST(makeReq("/api/admin/stuck-jobs/force-release", { body }));

beforeEach(() => {
  h.send.mockReset();
  h.getYoloJobStatus.mockReset();
  signedOut();
});
afterEach(() => vi.restoreAllMocks());

describe.skipIf(!dbUp)("GET /api/admin/stuck-jobs", () => {
  it("auth: signed-out 401, member 403, company admin pinned to own company", async () => {
    const { admin, member } = await world();
    expect((await list()).status).toBe(401);
    asUser(member);
    expect((await list()).status).toBe(403);
    asUser(admin);
    expect((await list(`?companyId=${admin.companyId + 100000}`)).status).toBe(403);
    expect((await list(`?companyId=${admin.companyId}`)).status).toBe(200);
  });

  it("lists own running ingest/YOLO rows and leases with provider status; excludes demo and foreign rows", async () => {
    const { admin, project, member } = await world();
    const job = await seedIngestJob(project);
    await leaseOf(project, "project-processing", 30 * MIN);
    await db.insert(processingJobs).values({
      projectId: project.id,
      executionId: "yolo-synthetic-job",
      status: "running",
      modelConfig: { modelId: 1, modelName: "synthetic-model" },
    });
    const demoSource = await createProject(admin.companyId, member.id, { status: "processing" });
    await seedIngestJob(demoSource);
    await publishDemoFixture(demoSource.id);
    const other = await world();
    await seedIngestJob(other.project);

    h.send.mockResolvedValue({
      status: "FAILED",
      startDate: new Date(Date.now() - 50 * MIN),
      stopDate: new Date(Date.now() - 10 * MIN),
      error: "States.TaskFailed",
    });
    h.getYoloJobStatus.mockResolvedValue({ status: "Completed" });
    asUser(admin);
    const r = await readJson(await list());
    expect(r.status).toBe(200);
    expect(r.body.ingest.map((row: { jobId: number }) => row.jobId)).toEqual([job.id]);
    expect(r.body.ingest[0]).toMatchObject({ fixable: true, provider: { state: "terminal", status: "FAILED" } });
    expect(r.body.yolo).toHaveLength(1);
    expect(r.body.yolo[0]).toMatchObject({ providerStatus: "Completed", fixable: true });
    expect(r.body.leases).toEqual([
      expect.objectContaining({ kind: "project-processing", holder: "worker", projectPublicId: project.publicId }),
    ]);
    expect(r.body.unlinkedReservations).toBeNull(); // root view only
    expect(JSON.stringify(r.body)).not.toMatch(/"token"/);
  });

  it("root sees unlinked SageMaker reservations (listed only)", async () => {
    const { root, company, project } = await world();
    const [reservation] = await db
      .insert(computeUsage)
      .values({ companyId: company.id, projectId: project.id, resource: "sagemaker", pages: 7 })
      .returning();
    asUser(root);
    const r = await readJson(await list(`?companyId=${company.id}`));
    expect(r.status).toBe(200);
    expect(r.body.unlinkedReservations).toEqual([
      expect.objectContaining({ id: reservation.id, pages: 7, projectPublicId: project.publicId }),
    ]);
  });
});

describe.skipIf(!dbUp)("POST /api/admin/stuck-jobs/reconcile", () => {
  it("project mode closes an AWS-finished job and reclaims its worker lease; audit written", async () => {
    const { admin, project } = await world();
    const job = await seedIngestJob(project);
    await leaseOf(project, "project-processing", 30 * MIN);
    h.send.mockResolvedValue({
      status: "FAILED",
      startDate: new Date(Date.now() - 50 * MIN),
      stopDate: new Date(Date.now() - 10 * MIN),
    });
    asUser(admin);
    const r = await readJson(await reconcile({ projectPublicId: project.publicId }));
    expect(r.status).toBe(200);
    expect(r.body.outcomes).toEqual([
      expect.objectContaining({ jobId: job.id, changed: true, jobClosedAs: "failed", leasesReclaimed: 1 }),
    ]);
    expect(await activeKinds(project.id)).toEqual([]);
    expect(await waitForAudit("admin.stuck_jobs.reconcile", admin.id)).toHaveLength(1);
  });

  it("foreign project → 404; all mode touches only the caller's company", async () => {
    const { admin } = await world();
    const other = await world();
    const foreignJob = await seedIngestJob(other.project);
    asUser(admin);
    expect((await reconcile({ projectPublicId: other.project.publicId })).status).toBe(404);
    h.send.mockResolvedValue({
      status: "SUCCEEDED",
      startDate: new Date(Date.now() - 50 * MIN),
      stopDate: new Date(Date.now() - 10 * MIN),
    });
    const r = await readJson(await reconcile({ all: true }));
    expect(r.status).toBe(200);
    expect(r.body.outcomes.map((o: { jobId: number }) => o.jobId)).not.toContain(foreignJob.id);
    const [row] = await db.select().from(processingJobs).where(eq(processingJobs.id, foreignJob.id));
    expect(row.status).toBe("running");
  });

  it("RUNNING on AWS → unchanged", async () => {
    const { admin, project } = await world();
    const job = await seedIngestJob(project);
    h.send.mockResolvedValue({ status: "RUNNING", startDate: new Date(Date.now() - 5 * MIN) });
    asUser(admin);
    const r = await readJson(await reconcile({ projectPublicId: project.publicId }));
    expect(r.body.outcomes[0]).toMatchObject({ jobId: job.id, changed: false, action: "none" });
  });

  it("rejects a malformed body", async () => {
    const { admin } = await world();
    asUser(admin);
    expect((await reconcile({ all: false })).status).toBe(400);
    expect((await reconcile({ projectPublicId: "not-a-uuid" })).status).toBe(400);
  });
});

describe.skipIf(!dbUp)("POST /api/admin/stuck-jobs/stop", () => {
  it("root only; stops a RUNNING execution and writes no rows", async () => {
    const { admin, root, project } = await world();
    const job = await seedIngestJob(project);
    asUser(admin);
    expect((await stop({ projectPublicId: project.publicId })).status).toBe(403);
    h.send.mockImplementation(async (command: { kind: string }) =>
      command.kind === "describe" ? { status: "RUNNING", startDate: new Date(Date.now() - 5 * MIN) } : {},
    );
    asUser(root);
    const r = await readJson(await stop({ projectPublicId: project.publicId }));
    expect(r.status).toBe(200);
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ kind: "stop" }));
    const [row] = await db.select().from(processingJobs).where(eq(processingJobs.id, job.id));
    expect(row.status).toBe("running");
  });
});

describe.skipIf(!dbUp)("POST /api/admin/stuck-jobs/force-release", () => {
  const WEB_KINDS = ["processing-start", "admin-reprocess:full", "yolo-run", "yolo-load", "labeling-session-create"];

  it.each(WEB_KINDS)("releases a web-held %s lease older than this process", async (kind) => {
    const { root, project } = await world();
    await leaseOf(project, kind, 24 * 60 * MIN);
    vi.spyOn(process, "uptime").mockReturnValue(3600);
    asUser(root);
    const r = await readJson(await force({ projectPublicId: project.publicId, confirmProjectName: project.name }));
    expect(r.status).toBe(200);
    expect(r.body.released).toEqual([expect.objectContaining({ kind })]);
    expect(await activeKinds(project.id)).toEqual([]);
  });

  it("never releases the worker's project-processing lease, nor one taken after this process started", async () => {
    const { root, project } = await world();
    await leaseOf(project, "project-processing", 24 * 60 * MIN);
    await leaseOf(project, "yolo-run", 5 * MIN);
    vi.spyOn(process, "uptime").mockReturnValue(3600);
    asUser(root);
    const r = await readJson(await force({ projectPublicId: project.publicId, confirmProjectName: project.name }));
    expect(r.status).toBe(200);
    expect(r.body.released).toEqual([]);
    expect(r.body.refused.map((l: { reason: string }) => l.reason).sort()).toEqual([
      "not a web-held lease kind",
      "taken after this server started",
    ]);
    expect(await activeKinds(project.id)).toEqual(["project-processing", "yolo-run"]);
    const audits = await waitForAudit("admin.stuck_jobs.force_release", root.id);
    expect(audits).toHaveLength(1);
    expect(audits[0].details).toMatchObject({ projectPublicId: project.publicId, uptimeMinutes: 60 });
  });

  it("never releases a web-held lease from another lifecycle generation", async () => {
    const { root, project } = await world();
    const lease = await leaseOf(project, "yolo-run", 24 * 60 * MIN);
    // the projects epoch guard only moves on a demo flip, so stamp the lease row instead
    await db
      .update(projectMutationLeases)
      .set({ lifecycleEpoch: project.lifecycleEpoch + 1 })
      .where(eq(projectMutationLeases.token, lease.token));
    vi.spyOn(process, "uptime").mockReturnValue(3600);
    asUser(root);
    const r = await readJson(await force({ projectPublicId: project.publicId, confirmProjectName: project.name }));
    expect(r.status).toBe(200);
    expect(r.body.released).toEqual([]);
    expect(r.body.refused).toEqual([
      expect.objectContaining({ kind: "yolo-run", reason: "belongs to another lifecycle generation" }),
    ]);
    expect(await activeKinds(project.id)).toEqual(["yolo-run"]);
  });

  it("company admin → 403; missing or wrong confirmation → 400; young process → 409", async () => {
    const { admin, root, project } = await world();
    await leaseOf(project, "yolo-load", 24 * 60 * MIN);
    asUser(admin);
    expect((await force({ projectPublicId: project.publicId, confirmProjectName: project.name })).status).toBe(403);
    asUser(root);
    expect((await force({ projectPublicId: project.publicId })).status).toBe(400);
    vi.spyOn(process, "uptime").mockReturnValue(3600);
    expect((await force({ projectPublicId: project.publicId, confirmProjectName: "wrong" })).status).toBe(400);
    vi.spyOn(process, "uptime").mockReturnValue(60);
    expect((await force({ projectPublicId: project.publicId, confirmProjectName: project.name })).status).toBe(409);
    expect(await activeKinds(project.id)).toEqual(["yolo-load"]);
  });
});

describe.skipIf(!dbUp)("PUT /api/admin/running-jobs — SageMaker never accepted (case 9)", () => {
  function notFound() {
    const err = new Error("Could not find requested job with name synthetic");
    err.name = "ValidationException";
    return err;
  }

  it("old row → job failed; compute_usage untouched", async () => {
    const { admin, company, project } = await world();
    const [job] = await db
      .insert(processingJobs)
      .values({
        projectId: project.id,
        executionId: `yolo-never-${project.id}`,
        status: "running",
        modelConfig: { modelId: 1, modelName: "synthetic" },
        startedAt: new Date(Date.now() - 45 * MIN),
      })
      .returning();
    await db.insert(computeUsage).values({ companyId: company.id, projectId: project.id, resource: "sagemaker", pages: 3 });
    const before = await db.select().from(computeUsage).where(eq(computeUsage.companyId, company.id));
    h.getYoloJobStatus.mockRejectedValue(notFound());
    asUser(admin);
    const r = await readJson(
      await runningPUT(makeReq("/api/admin/running-jobs", { method: "PUT", body: { executionId: job.executionId, status: "Failed" } })),
    );
    expect(r.status).toBe(200);
    const [row] = await db.select().from(processingJobs).where(eq(processingJobs.id, job.id));
    expect(row).toMatchObject({ status: "failed", error: "SageMaker job never accepted" });
    expect(await db.select().from(computeUsage).where(eq(computeUsage.companyId, company.id))).toEqual(before);
  });

  it("young row → 409, still running", async () => {
    const { admin, project } = await world();
    const [job] = await db
      .insert(processingJobs)
      .values({
        projectId: project.id,
        executionId: `yolo-young-${project.id}`,
        status: "running",
        modelConfig: { modelId: 1, modelName: "synthetic" },
        startedAt: new Date(Date.now() - 5 * MIN),
      })
      .returning();
    h.getYoloJobStatus.mockRejectedValue(notFound());
    asUser(admin);
    const r = await readJson(
      await runningPUT(makeReq("/api/admin/running-jobs", { method: "PUT", body: { executionId: job.executionId, status: "Failed" } })),
    );
    expect(r.status).toBe(409);
    const [row] = await db.select().from(processingJobs).where(eq(processingJobs.id, job.id));
    expect(row.status).toBe("running");
  });
});
