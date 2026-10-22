// @vitest-environment node
// [refactor jul6 S046] CHARACTERIZATION for the admin/running-jobs SOLO (GET running YOLO
// jobs + PUT update a job's terminal status), written as THE FREEZE before the fold onto
// services/running-jobs.ts. Solo. requireAdmin (admin OR root passes; member 403; signed-out
// 401). Frozen quirk inventory:
//   • GET: raw-SQL SELECT running processing_jobs JOIN projects WHERE p.company_id =
//     session.companyId AND pj.status='running' AND pj.model_config IS NOT NULL ORDER BY
//     started_at DESC → BARE ARRAY of {projectPublicId, executionId, modelId, modelName,
//     startedAt}. try/catch → catch returns [] (GRACEFUL fail — a SUCCESS fallback, NOT a
//     500; PRESERVE in-service). companyId-scoped.
//   • PUT: {executionId, status}; !executionId || !status → 400 "executionId and status
//     required"; dbStatus = Completed→"completed" / Failed|Stopped→"failed" / else null →
//     400 "Invalid terminal status". update processingJobs SET {status:dbStatus,
//     completedAt:now}. L5 requires resolving the job through its tenant-owned, non-demo project.
// GET body: none → GET has no E. PUT reads body → E applies at fold. No catch-500 literal → NO B.
// Assertions tagged [S046 fold: … applied] were flipped in the fold commit onto
// services/running-jobs.ts (sanctioned A/E only).
import { describe, expect, inject, it, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

const h = vi.hoisted(() => ({
  getYoloJobStatus: vi.fn(),
  describeYoloJobRun: vi.fn(),
  yoloLoad: vi.fn(),
}));
vi.mock("@/lib/yolo", () => ({
  getYoloJobStatus: h.getYoloJobStatus,
  describeYoloJobRun: h.describeYoloJobRun,
}));
// [2026-10-21] GET's server-side catch-up loads completed jobs through yoloLoad (S3 + DB); stubbed here.
vi.mock("@/server/services/yolo", () => ({ yoloLoad: h.yoloLoad }));

import { GET as rjGET, PUT as rjPUT } from "@/app/api/admin/running-jobs/route";
import { db } from "@/lib/db";
import { processingJobs } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  asUser,
  createCompany,
  createUser,
  createProject,
  makeReq,
  publishDemoFixture,
  readJson,
  signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

async function makeWorld() {
  const company = await createCompany();
  const admin = await createUser(company.id, { role: "admin" });
  const member = await createUser(company.id);
  const root = await createUser(company.id, { isRootAdmin: true });
  return { company, admin, member, root };
}

const getReq = () => makeReq("/api/admin/running-jobs", { method: "GET" });
const putReq = (body: unknown) =>
  makeReq("/api/admin/running-jobs", { method: "PUT", body });
const UNAUTH = { error: { code: "UNAUTHORIZED", message: "Unauthorized" } }; // [S046 fold: A applied]
const ADMIN_ONLY = { error: { code: "FORBIDDEN", message: "Admin only" } }; // [S046 fold: A applied]

const tag = () => Math.random().toString(36).slice(2, 8);
async function seedJob(
  projectId: number,
  over: Partial<typeof processingJobs.$inferInsert> = {},
) {
  const [j] = await db
    .insert(processingJobs)
    .values({
      projectId,
      executionId: `exec-${tag()}`,
      status: "running",
      modelConfig: { modelId: 7, modelName: "yolo-x" } as never,
      ...over,
    })
    .returning();
  return j;
}
async function jobByExec(executionId: string) {
  const [j] = await db
    .select()
    .from(processingJobs)
    .where(eq(processingJobs.executionId, executionId))
    .limit(1);
  return j;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getYoloJobStatus.mockResolvedValue({ status: "Completed" });
  h.describeYoloJobRun.mockResolvedValue(null);
  h.yoloLoad.mockResolvedValue({ success: true });
  signedOut();
});

describe.skipIf(!dbUp)("admin/running-jobs (RJ)", () => {
  it("RJ-1 GET auth: signed-out→401, member→403, admin+root→200", async () => {
    const { admin, member, root } = await makeWorld();
    let r = await readJson(await rjGET(getReq()));
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S046 fold: A applied]
    asUser(member);
    r = await readJson(await rjGET(getReq()));
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ADMIN_ONLY); // [S046 fold: A applied]
    asUser(admin);
    expect((await readJson(await rjGET(getReq()))).status).toBe(200);
    asUser(root);
    expect((await readJson(await rjGET(getReq()))).status).toBe(200);
  });

  it("RJ-2 GET: BARE ARRAY of own-company running jobs (companyId-scoped), shaped from model_config", async () => {
    h.getYoloJobStatus.mockResolvedValue({ status: "InProgress" }); // still running at the provider
    const { company, admin } = await makeWorld();
    const author = await createUser(company.id);
    const proj = await createProject(company.id, author.id);
    const job = await seedJob(proj.id);
    // a completed job (excluded), and another company's running job (excluded)
    await seedJob(proj.id, {
      status: "completed",
      executionId: `done-${tag()}`,
    });
    const otherCo = await createCompany();
    const otherProj = await createProject(
      otherCo.id,
      (await createUser(otherCo.id)).id,
    );
    await seedJob(otherProj.id);
    asUser(admin);
    const r = await readJson(await rjGET(getReq()));
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true); // BARE array, not enveloped
    const mine = r.body.filter(
      (j: { executionId: string }) => j.executionId === job.executionId,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      projectPublicId: proj.publicId,
      executionId: job.executionId,
      modelId: 7,
      modelName: "yolo-x",
    });
    // the other company's running job is NOT visible
    expect(
      r.body.every(
        (j: { projectPublicId: string }) =>
          j.projectPublicId !== otherProj.publicId,
      ),
    ).toBe(true);
  });

  it("RJ-3 GET GRACEFUL catch: a raw-SQL error → 200 bare [] (fail quietly, NOT a 500)", async () => {
    const { admin } = await makeWorld();
    asUser(admin);
    const spy = vi
      .spyOn(db, "execute")
      .mockRejectedValueOnce(new Error("db down"));
    const r = await readJson(await rjGET(getReq()));
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]); // graceful empty array
    spy.mockRestore();
  });

  it("RJ-4 PUT auth: signed-out→401, member→403", async () => {
    const { member } = await makeWorld();
    let r = await readJson(
      await rjPUT(putReq({ executionId: "x", status: "Completed" })),
    );
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S046 fold: A applied]
    asUser(member);
    r = await readJson(
      await rjPUT(putReq({ executionId: "x", status: "Completed" })),
    );
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ADMIN_ONLY); // [S046 fold: A applied]
  });

  it("RJ-5 PUT validation: missing fields → 'executionId and status required'; bad status → 'Invalid terminal status'", async () => {
    const { admin } = await makeWorld();
    asUser(admin);
    for (const body of [{}, { executionId: "x" }, { status: "Completed" }]) {
      const r = await readJson(await rjPUT(putReq(body)));
      expect(r.status).toBe(400);
      expect(r.body).toEqual({
        error: {
          code: "VALIDATION",
          message: "executionId and status required",
        },
      }); // [S046 fold: A applied]
    }
    const r = await readJson(
      await rjPUT(putReq({ executionId: "x", status: "Bogus" })),
    );
    expect(r.status).toBe(400);
    expect(r.body).toEqual({
      error: { code: "VALIDATION", message: "Invalid terminal status" },
    }); // [S046 fold: A applied]
  });

  it("RJ-6 PUT write: maps provider-confirmed terminal status and sets completedAt", async () => {
    const { company, admin } = await makeWorld();
    const author = await createUser(company.id);
    const proj = await createProject(company.id, author.id);
    asUser(admin);
    for (const [status, dbStatus] of [
      ["Completed", "completed"],
      ["Failed", "failed"],
      ["Stopped", "failed"],
    ] as const) {
      const job = await seedJob(proj.id);
      h.getYoloJobStatus.mockResolvedValueOnce({ status });
      const r = await readJson(
        await rjPUT(putReq({ executionId: job.executionId, status })),
      );
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ success: true });
      const updated = await jobByExec(job.executionId!);
      expect(updated.status).toBe(dbStatus);
      expect(updated.completedAt).toBeTruthy();
    }
  });

  it("security: PUT keeps the blocker running for every nonterminal/unknown SageMaker state", async () => {
    const { company, admin } = await makeWorld();
    const project = await createProject(
      company.id,
      (await createUser(company.id)).id,
    );
    asUser(admin);

    for (const providerStatus of ["InProgress", "Stopping", "Unknown"]) {
      const job = await seedJob(project.id);
      h.getYoloJobStatus.mockResolvedValueOnce({ status: providerStatus });

      const r = await readJson(
        await rjPUT(
          putReq({ executionId: job.executionId, status: "Completed" }),
        ),
      );

      expect.soft(r.status).toBe(409);
      expect.soft(r.body).toEqual({
        error: {
          code: "CONFLICT",
          message: "Job has not reached a terminal provider status",
        },
      });
      expect.soft(await jobByExec(job.executionId!)).toMatchObject({
        status: "running",
        completedAt: null,
      });
    }
  });

  it("security: a provider error is a generic 500 and leaves the blocker running", async () => {
    const { company, admin } = await makeWorld();
    const project = await createProject(
      company.id,
      (await createUser(company.id)).id,
    );
    const job = await seedJob(project.id);
    h.getYoloJobStatus.mockRejectedValueOnce(new Error("AWS secret detail"));
    asUser(admin);

    const r = await readJson(
      await rjPUT(
        putReq({ executionId: job.executionId, status: "Completed" }),
      ),
    );

    expect(r.status).toBe(500);
    expect(r.body).toEqual({
      error: { code: "INTERNAL", message: "Internal server error" },
    });
    expect(await jobByExec(job.executionId!)).toMatchObject({
      status: "running",
      completedAt: null,
    });
  });

  it("security: the provider status, not the caller claim, selects the terminal DB status", async () => {
    const { company, admin } = await makeWorld();
    const project = await createProject(
      company.id,
      (await createUser(company.id)).id,
    );
    const job = await seedJob(project.id);
    h.getYoloJobStatus.mockResolvedValueOnce({ status: "Failed" });
    asUser(admin);

    const r = await readJson(
      await rjPUT(
        putReq({ executionId: job.executionId, status: "Completed" }),
      ),
    );

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true });
    expect(await jobByExec(job.executionId!)).toMatchObject({
      status: "failed",
    });
  });

  it("L5 freeze: PUT cannot update a foreign-tenant or demo project's running job", async () => {
    const { company, admin } = await makeWorld();
    const ownAuthor = await createUser(company.id);
    const ownProject = await createProject(company.id, ownAuthor.id);
    const ownJob = await seedJob(ownProject.id);

    const foreignCompany = await createCompany();
    const foreignProject = await createProject(
      foreignCompany.id,
      (await createUser(foreignCompany.id)).id,
    );
    const foreignJob = await seedJob(foreignProject.id);

    const demoProject = await createProject(company.id, ownAuthor.id);
    const demoJob = await seedJob(demoProject.id);
    await publishDemoFixture(demoProject.id);
    asUser(admin);

    const ownResponse = await readJson(
      await rjPUT(
        putReq({ executionId: ownJob.executionId, status: "Completed" }),
      ),
    );
    expect.soft(h.getYoloJobStatus).toHaveBeenCalledTimes(1);
    expect.soft(h.getYoloJobStatus).toHaveBeenCalledWith(ownJob.executionId);
    h.getYoloJobStatus.mockClear();

    const foreignResponse = await readJson(
      await rjPUT(
        putReq({ executionId: foreignJob.executionId, status: "Completed" }),
      ),
    );
    const demoResponse = await readJson(
      await rjPUT(
        putReq({ executionId: demoJob.executionId, status: "Completed" }),
      ),
    );
    const missingResponse = await readJson(
      await rjPUT(
        putReq({ executionId: `missing-${tag()}`, status: "Completed" }),
      ),
    );

    expect.soft(ownResponse.status).toBe(200);
    expect.soft(foreignResponse.status).toBe(404);
    expect.soft(demoResponse.status).toBe(403);
    expect.soft(missingResponse.status).toBe(404);
    expect.soft(h.getYoloJobStatus).not.toHaveBeenCalled();
    expect
      .soft((await jobByExec(ownJob.executionId!)).status)
      .toBe("completed");
    expect
      .soft((await jobByExec(foreignJob.executionId!)).status)
      .toBe("running");
    expect.soft((await jobByExec(demoJob.executionId!)).status).toBe("running");
  });

  it("[2026-10-21 catch-up] GET: a provider-Completed job nobody polled is marked completed, loaded once, and dropped from the list", async () => {
    const { company, admin } = await makeWorld();
    const proj = await createProject(company.id, (await createUser(company.id)).id);
    const job = await seedJob(proj.id);
    h.describeYoloJobRun.mockResolvedValue({ instanceType: "ml.g5.xlarge", runSeconds: 321 });
    asUser(admin);
    const r = await readJson(await rjGET(getReq()));
    expect(r.status).toBe(200);
    expect(r.body.some((j: { executionId: string }) => j.executionId === job.executionId)).toBe(false);
    const row = await jobByExec(job.executionId!);
    expect(row?.status).toBe("completed");
    // the run's instance + provider seconds are kept for the cost estimate (services/yolo-run-stats)
    expect(row?.modelConfig).toMatchObject({ modelId: 7, modelName: "yolo-x", instanceType: "ml.g5.xlarge", runSeconds: 321 });
    expect(h.yoloLoad).toHaveBeenCalledTimes(1);
    expect(h.yoloLoad.mock.calls[0][0]).toEqual({ projectId: proj.publicId, modelId: 7, modelName: "yolo-x" });
    expect(h.yoloLoad.mock.calls[0][1]).toMatchObject({ user: { dbId: admin.id } });
  });

  it("[2026-10-21 catch-up] GET: an in-progress job is left running and is not loaded", async () => {
    h.getYoloJobStatus.mockResolvedValue({ status: "InProgress" });
    const { company, admin } = await makeWorld();
    const proj = await createProject(company.id, (await createUser(company.id)).id);
    const job = await seedJob(proj.id);
    asUser(admin);
    const r = await readJson(await rjGET(getReq()));
    expect(r.body.some((j: { executionId: string }) => j.executionId === job.executionId)).toBe(true);
    expect((await jobByExec(job.executionId!))?.status).toBe("running");
    expect(h.yoloLoad).not.toHaveBeenCalled();
  });
});
