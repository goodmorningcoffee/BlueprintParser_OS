// @vitest-environment node
// B2 security witness: publication quiescence must be based on provider-confirmed terminal state,
// never an administrator-supplied status string while an external job may still be running.
import { beforeEach, describe, expect, inject, it, vi } from "vitest";

const {
  mockCheckYoloQuota,
  mockGetToggles,
  mockGetYoloJobStatus,
  mockDeleteProjectFiles,
  mockReleaseReservation,
  mockReserveSagemakerPages,
  mockS3Send,
  mockStartYoloJob,
  mockUploadToS3,
} = vi.hoisted(() => ({
  mockCheckYoloQuota: vi.fn(),
  mockGetToggles: vi.fn(),
  mockGetYoloJobStatus: vi.fn(),
  mockDeleteProjectFiles: vi.fn(),
  mockReleaseReservation: vi.fn(),
  mockReserveSagemakerPages: vi.fn(),
  mockS3Send: vi.fn(),
  mockStartYoloJob: vi.fn(),
  mockUploadToS3: vi.fn(),
}));

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});
vi.mock("@/lib/yolo", () => ({
  createYoloJobName: (modelName: string) => `security-job-${modelName}`,
  getYoloJobStatus: mockGetYoloJobStatus,
  startYoloJob: mockStartYoloJob,
}));
vi.mock("@/lib/s3", () => ({
  S3_BUCKET: "security-witness-bucket",
  deleteProjectFiles: mockDeleteProjectFiles,
  s3Client: { send: mockS3Send },
  uploadToS3: mockUploadToS3,
}));
vi.mock("@/lib/quotas", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/quotas")>()),
  checkYoloQuota: mockCheckYoloQuota,
}));
vi.mock("@/lib/toggles", () => ({
  getToggles: mockGetToggles,
}));
vi.mock("@/lib/compute-usage", () => ({
  reserveSagemakerPages: mockReserveSagemakerPages,
  releaseReservation: mockReleaseReservation,
  stampReservationJob: vi.fn(),
  recordComputeUsage: vi.fn(),
  shouldSendCapAlert: vi.fn(() => false),
}));

import { db } from "@/lib/db";
import {
  labelingSessions,
  models,
  processingJobs,
  projectMutationLeases,
  projects,
} from "@/lib/db/schema";
import { deleteProjectFully } from "@/lib/project-delete";
import { PROJECT_UPLOAD_PUBLICATION_FENCE_SECONDS } from "@/lib/project-upload-authority";
import { eq, sql } from "drizzle-orm";
import { manageDemo } from "@/server/services/demo";
import { processingWebhook } from "@/server/services/processing-routes";
import { updateRunningJob } from "@/server/services/running-jobs";
import { yoloRun } from "@/server/services/yolo";
import {
  acquireProjectMutationLease,
  assertProjectWritable,
  releaseProjectMutationLease,
} from "@/server/api/project-write-capability";
import {
  asUser,
  createCompany,
  createLabelingSessionFixture,
  createProject,
  createUser,
  createWorld,
  sessionState,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

async function ageProjectPastUploadPublicationFence(
  projectId: number,
): Promise<void> {
  await db
    .update(projects)
    .set({
      createdAt: sql`CURRENT_TIMESTAMP - (${PROJECT_UPLOAD_PUBLICATION_FENCE_SECONDS + 1} * INTERVAL '1 second')`,
    })
    .where(eq(projects.id, projectId));
}

beforeEach(() => {
  mockDeleteProjectFiles.mockReset();
  mockDeleteProjectFiles.mockResolvedValue(undefined);
  mockGetYoloJobStatus.mockReset();
  mockGetYoloJobStatus.mockResolvedValue({ status: "InProgress" });
  mockStartYoloJob.mockReset();
  mockUploadToS3.mockReset();
  mockUploadToS3.mockResolvedValue(undefined);
  mockS3Send.mockReset();
  mockS3Send.mockResolvedValue({});
  mockCheckYoloQuota.mockReset();
  mockCheckYoloQuota.mockResolvedValue({ allowed: true });
  mockGetToggles.mockReset();
  mockGetToggles.mockResolvedValue({
    sagemakerEnabled: true,
    quotaEnabled: true,
  });
  mockReserveSagemakerPages.mockReset();
  mockReserveSagemakerPages.mockResolvedValue({
    allowed: true,
    reservationId: 1,
  });
  mockReleaseReservation.mockReset();
  mockReleaseReservation.mockResolvedValue(undefined);
});

describe.skipIf(!dbUp)("project publication quiescence", () => {
  it("rejects a stale or aliased delete root before any DB or S3 deletion", async () => {
    const { project } = await createWorld();
    await ageProjectPastUploadPublicationFence(project.id);

    await expect(
      deleteProjectFully(
        {
          id: project.id,
          dataUrl: `${project.dataUrl}/pages`,
          jobId: project.jobId,
          name: project.name,
        },
        assertProjectWritable(project),
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Project storage root requires reconciliation",
    });

    expect(
      await db.select({ id: projects.id }).from(projects).where(eq(projects.id, project.id)),
    ).toHaveLength(1);
    expect(mockDeleteProjectFiles).not.toHaveBeenCalled();
  });

  it("the database makes a project's final storage root immutable", async () => {
    const { company, project } = await createWorld();
    const replacement = `${company.dataKey}/${"f".repeat(20)}`;

    await expect(
      db.update(projects).set({ dataUrl: replacement }).where(eq(projects.id, project.id)),
    ).rejects.toBeDefined();

    const [retained] = await db
      .select({ dataUrl: projects.dataUrl })
      .from(projects)
      .where(eq(projects.id, project.id));
    expect(retained?.dataUrl).toBe(project.dataUrl);
  });

  it("does not let a caller-declared terminal status retire a still-external running-job blocker", async () => {
    const { company, project } = await createWorld();
    await ageProjectPastUploadPublicationFence(project.id);
    const admin = await createUser(company.id, { role: "admin" });
    asUser(admin);
    const adminSession = sessionState.current!;

    const executionId = `provider-job-still-running-${project.id}`;
    await db.insert(processingJobs).values({
      projectId: project.id,
      executionId,
      status: "running",
      modelConfig: { modelId: 1, modelName: "security-witness" },
    });

    // This request contains no provider attestation. Treat the external job as still running.
    // The database transition may reject or no-op; either is safe. It must consult the provider,
    // whose authoritative state is still nonterminal, and leave publication blocked.
    await updateRunningJob(
      { executionId, status: "Completed" },
      adminSession,
    ).catch(() => undefined);
    expect.soft(mockGetYoloJobStatus).toHaveBeenCalledWith(executionId);

    await expect(
      manageDemo({ projectId: project.publicId, isDemo: true }, adminSession),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Project has an active processing job",
    });

    const [after] = await db
      .select({ isDemo: projects.isDemo })
      .from(projects)
      .where(eq(projects.id, project.id));
    expect(after.isDemo).toBe(false);
  });

  it("does not let an ingestion webhook retire an unrelated running YOLO job", async () => {
    const { company, project } = await createWorld();
    await ageProjectPastUploadPublicationFence(project.id);
    const admin = await createUser(company.id, { role: "admin" });
    asUser(admin);
    const adminSession = sessionState.current!;

    await db.insert(processingJobs).values([
      {
        projectId: project.id,
        executionId: `ingestion-${project.id}`,
        status: "running",
        modelConfig: null,
      },
      {
        projectId: project.id,
        executionId: `yolo-still-running-${project.id}`,
        status: "running",
        modelConfig: { modelId: 1, modelName: "security-witness" },
      },
    ]);

    await processingWebhook({
      projectId: project.id,
      pages: [],
      status: "completed",
    });

    await expect(
      manageDemo({ projectId: project.publicId, isDemo: true }, adminSession),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Project has an active processing job",
    });

    const [after] = await db
      .select({ isDemo: projects.isDemo })
      .from(projects)
      .where(eq(projects.id, project.id));
    expect(after.isDemo).toBe(false);
  });

  it("keeps a named running intent after an ambiguous YOLO start failure", async () => {
    const company = await createCompany();
    const runner = await createUser(company.id, { canRunModels: true });
    const project = await createProject(company.id, runner.id, { numPages: 5 });
    await ageProjectPastUploadPublicationFence(project.id);
    const admin = await createUser(company.id, { role: "admin" });
    const modelName = `security-witness-${project.id}`;
    const [model] = await db
      .insert(models)
      .values({
        companyId: company.id,
        name: modelName,
        type: "yolo",
        s3Path: `models/${modelName}`,
        config: {
          classes: ["door"],
          confidence: 0.1,
          iou: 0.6,
          imageSize: 1280,
        },
      })
      .returning();
    asUser(runner);
    mockStartYoloJob.mockRejectedValue(
      new Error("ambiguous transport timeout"),
    );

    await yoloRun(
      { projectId: project.publicId, modelId: model.id },
      new Request("http://test.local/api/yolo/run", { method: "POST" }),
    ).catch(() => undefined);

    const jobs = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.projectId, project.id));
    expect.soft(jobs).toHaveLength(1);
    expect.soft(jobs[0]).toMatchObject({ status: "running" });
    expect.soft(jobs[0]?.executionId).toEqual(expect.any(String));
    expect.soft(jobs[0]?.executionId).not.toBe("");

    asUser(admin);
    await expect(
      manageDemo(
        { projectId: project.publicId, isDemo: true },
        sessionState.current!,
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Project has an active processing job",
    });
  });

  it("uses the database clock so publisher clock skew cannot expire a live mutation lease", async () => {
    const { company, project } = await createWorld();
    await ageProjectPastUploadPublicationFence(project.id);
    const admin = await createUser(company.id, { role: "admin" });
    const capability = assertProjectWritable(project);
    const lease = await acquireProjectMutationLease(capability, {
      kind: "clock-skew-security-witness",
      idempotencyKey: `clock-skew-security-witness-${project.id}`,
    });
    asUser(admin);

    // Model a publisher instance whose application clock is years ahead of the instance that
    // acquired the lease. Lease liveness is a distributed database fact; local Date skew must not
    // let the publisher delete the row and expose externally mutating work as quiescent.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2040-01-01T00:00:00.000Z"));
    try {
      await expect(
        manageDemo(
          { projectId: project.publicId, isDemo: true },
          sessionState.current!,
        ),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        message: "Project has an active mutation lease",
      });
    } finally {
      vi.useRealTimers();
      await releaseProjectMutationLease(capability, lease).catch(
        () => undefined,
      );
    }

    const [after] = await db
      .select({ isDemo: projects.isDemo })
      .from(projects)
      .where(eq(projects.id, project.id));
    expect(after.isDemo).toBe(false);
  });

  it("fails closed when an active mutation lease has missed its heartbeat deadline", async () => {
    const { company, project } = await createWorld();
    await ageProjectPastUploadPublicationFence(project.id);
    const admin = await createUser(company.id, { role: "admin" });
    const capability = assertProjectWritable(project);
    const idempotencyKey = `missed-heartbeat-security-witness-${project.id}`;
    const lease = await acquireProjectMutationLease(capability, {
      kind: "missed-heartbeat-security-witness",
      idempotencyKey,
    });

    // A stale heartbeat is not proof that external mutation stopped: the worker may be alive while
    // its DB connection or event loop is impaired. Only explicit retirement may establish quiescence.
    await db
      .update(projectMutationLeases)
      .set({ expiresAt: sql`CURRENT_TIMESTAMP - INTERVAL '1 second'` })
      .where(eq(projectMutationLeases.token, lease.token));
    asUser(admin);

    try {
      await expect(
        acquireProjectMutationLease(capability, {
          kind: "missed-heartbeat-security-witness",
          idempotencyKey,
        }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        message: "Project mutation already in progress",
      });
      await expect(
        manageDemo(
          { projectId: project.publicId, isDemo: true },
          sessionState.current!,
        ),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        message: "Project has an active mutation lease",
      });
    } finally {
      await releaseProjectMutationLease(capability, lease).catch(
        () => undefined,
      );
    }

    const [after] = await db
      .select({ isDemo: projects.isDemo })
      .from(projects)
      .where(eq(projects.id, project.id));
    expect(after.isDemo).toBe(false);

    const reacquired = await acquireProjectMutationLease(capability, {
      kind: "missed-heartbeat-security-witness",
      idempotencyKey,
    });
    await releaseProjectMutationLease(capability, reacquired);
  });

  it("waits out all project upload authority before allowing publication", async () => {
    const { company, project } = await createWorld();
    const admin = await createUser(company.id, { role: "admin" });
    asUser(admin);
    const adminSession = sessionState.current!;

    // S3 POST policies are reusable until their 900-second expiry and SigV4 permits clock skew.
    // Every project path originates as an upload target before its DB row exists, so a newly
    // completed project must conservatively retain that outstanding-authority publication fence.
    await expect(
      manageDemo({ projectId: project.publicId, isDemo: true }, adminSession),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await db
      .update(projects)
      .set({
        createdAt: sql`CURRENT_TIMESTAMP - (${PROJECT_UPLOAD_PUBLICATION_FENCE_SECONDS + 1} * INTERVAL '1 second')`,
      })
      .where(eq(projects.id, project.id));

    await manageDemo(
      { projectId: project.publicId, isDemo: true },
      adminSession,
    );
    const [after] = await db
      .select({ isDemo: projects.isDemo })
      .from(projects)
      .where(eq(projects.id, project.id));
    expect(after.isDemo).toBe(true);
  });

  it("requires linked Label Studio state to be retired before publication or deletion", async () => {
    const { company, project } = await createWorld();
    await ageProjectPastUploadPublicationFence(project.id);
    const admin = await createUser(company.id, { role: "admin" });
    const capability = assertProjectWritable(project);
    const labelingSession = await createLabelingSessionFixture(project, {
      labelStudioProjectId: 880_000 + project.id,
      labelStudioUrl: `https://labels.test/projects/${880_000 + project.id}`,
      taskType: "generic",
      pageRange: "1-3",
      status: "active",
    });
    asUser(admin);

    await expect(
      manageDemo(
        { projectId: project.publicId, isDemo: true },
        sessionState.current!,
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Project has linked labeling sessions",
    });

    await expect(
      deleteProjectFully(
        {
          id: project.id,
          dataUrl: project.dataUrl,
          jobId: project.jobId,
          name: project.name,
        },
        capability,
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Project has linked labeling sessions",
    });

    const [retainedProject] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, project.id));
    const [retainedSession] = await db
      .select({ id: labelingSessions.id })
      .from(labelingSessions)
      .where(eq(labelingSessions.id, labelingSession.id));
    expect.soft(retainedProject).toBeDefined();
    expect.soft(retainedSession).toBeDefined();
  });
});
