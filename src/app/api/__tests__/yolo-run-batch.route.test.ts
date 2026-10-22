// @vitest-environment node
// [2026-10-22] POST /api/yolo/run-batch — ONE SageMaker job for up to 9 projects, one processing_jobs row
// per project under the shared job name. Root only. Per-project guards (company scope, demo, page count,
// page images, the yolo-run lease, page-cap reservations) refuse a project without stopping the rest; the
// daily quota counts the batch as N runs. SageMaker/S3/toggles/quotas/compute-usage are mocked; the DB,
// the leases and the rows are real.
import { beforeEach, describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

const h = vi.hoisted(() => ({
  createYoloJobName: vi.fn(),
  startYoloBatchJob: vi.fn(),
  uploadToS3: vi.fn(),
  s3Send: vi.fn(),
  checkYoloQuota: vi.fn(),
  getToggles: vi.fn(),
  reserveSagemakerPages: vi.fn(),
  releaseReservation: vi.fn(),
  stampReservationJob: vi.fn(),
  recordComputeUsage: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/yolo", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/yolo")>();
  return {
    YoloStartRefusedError: real.YoloStartRefusedError,
    MAX_YOLO_BATCH_PROJECTS: real.MAX_YOLO_BATCH_PROJECTS,
    createYoloJobName: h.createYoloJobName,
    startYoloBatchJob: h.startYoloBatchJob,
  };
});
vi.mock("@/lib/s3", () => ({
  uploadToS3: h.uploadToS3,
  s3Client: { send: h.s3Send },
  S3_BUCKET: "test-bucket",
}));
vi.mock("@/lib/quotas", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/quotas")>()),
  checkYoloQuota: h.checkYoloQuota,
}));
vi.mock("@/lib/toggles", () => ({ getToggles: h.getToggles }));
vi.mock("@/lib/compute-usage", () => ({
  reserveSagemakerPages: h.reserveSagemakerPages,
  releaseReservation: h.releaseReservation,
  stampReservationJob: h.stampReservationJob,
  recordComputeUsage: h.recordComputeUsage,
}));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));

import { POST as batchPOST } from "@/app/api/yolo/run-batch/route";
import { YoloStartRefusedError } from "@/lib/yolo";
import { yoloRunBatch } from "@/server/services/yolo-batch-run";
import { db } from "@/lib/db";
import { models, processingJobs } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { asUser, createCompany, createProject, createUser, makeReq, readJson, signedOut } from "@/test/harness";
import { withProjectMutationLease, assertProjectWritable } from "@/server/api/project-write-capability";

const dbUp = inject("dbUp") as boolean;

async function createModel(companyId: number) {
  const name = `model-${Math.random().toString(36).slice(2, 8)}`;
  const [m] = await db
    .insert(models)
    .values({ name, type: "yolo", companyId, s3Path: `models/${name}`, config: { classes: ["door"] } } as never)
    .returning();
  return m;
}

async function world(projectCount = 3) {
  const company = await createCompany();
  const root = await createUser(company.id, { role: "admin", isRootAdmin: true, canRunModels: true });
  const admin = await createUser(company.id, { role: "admin", canRunModels: true });
  const projects = [];
  for (let i = 0; i < projectCount; i += 1) {
    projects.push(await createProject(company.id, root.id, { numPages: 10 + i, status: "completed" }));
  }
  const model = await createModel(company.id);
  return { company, root, admin, projects, model };
}

const post = (body: unknown) => batchPOST(makeReq("/api/yolo/run-batch", { method: "POST", body }));
const rowsFor = (jobName: string) => db.select().from(processingJobs).where(eq(processingJobs.executionId, jobName));

let JOB = "";
let JOB2 = "";
beforeEach(() => {
  vi.clearAllMocks();
  signedOut();
  const tag = Math.random().toString(36).slice(2, 10);
  JOB = `bp-yolo-batch-${tag}-1`;
  JOB2 = `bp-yolo-batch-${tag}-2`;
  h.createYoloJobName.mockReturnValue(JOB);
  h.startYoloBatchJob.mockImplementation(async (_urls: string[], _m: string, _n: string, name: string) => name);
  h.uploadToS3.mockResolvedValue(undefined);
  h.s3Send.mockResolvedValue({});
  h.checkYoloQuota.mockResolvedValue({ allowed: true });
  h.getToggles.mockResolvedValue({ sagemakerEnabled: true, quotaEnabled: true });
  h.reserveSagemakerPages.mockResolvedValue({ allowed: true, reservationId: 5 });
  h.recordComputeUsage.mockResolvedValue(undefined);
  h.stampReservationJob.mockResolvedValue(undefined);
  h.releaseReservation.mockResolvedValue(undefined);
});

describe.skipIf(!dbUp)("POST /api/yolo/run-batch", () => {
  it("is root only: signed-out 401, company admin 403", async () => {
    const w = await world(1);
    let r = await readJson(await post({ modelId: w.model.id, projectIds: [w.projects[0].publicId] }));
    expect(r.status).toBe(401);
    asUser(w.admin);
    r = await readJson(await post({ modelId: w.model.id, projectIds: [w.projects[0].publicId] }));
    expect(r.status).toBe(403);
    expect(h.startYoloBatchJob).not.toHaveBeenCalled();
  });

  it("rejects more than 9 projects and malformed bodies before any side effect", async () => {
    const w = await world(1);
    asUser(w.root);
    const ten = Array.from({ length: 10 }, () => w.projects[0].publicId);
    expect((await post({ modelId: w.model.id, projectIds: ten })).status).toBe(400);
    expect((await post({ modelId: w.model.id, projectIds: [] })).status).toBe(400);
    expect((await post({ modelId: w.model.id, projectIds: ["not-a-uuid"] })).status).toBe(400);
    expect(h.startYoloBatchJob).not.toHaveBeenCalled();
  });

  it("starts ONE job and writes one running row per project under the shared job name", async () => {
    const w = await world(3);
    asUser(w.root);
    const ids = w.projects.map((p) => p.publicId);
    const r = await readJson(await post({ modelId: w.model.id, projectIds: ids }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ jobName: JOB, status: "running" });
    expect((r.body as { projects: unknown[] }).projects).toEqual(ids.map((projectId) => ({ projectId, status: "running" })));
    expect(h.startYoloBatchJob).toHaveBeenCalledTimes(1);
    const [dataUrls, s3Path, modelName, jobName] = h.startYoloBatchJob.mock.calls[0];
    expect([...dataUrls].sort()).toEqual(w.projects.map((p) => p.dataUrl).sort());
    expect([s3Path, modelName, jobName]).toEqual([w.model.s3Path, w.model.name, JOB]);
    expect(h.uploadToS3).toHaveBeenCalledTimes(1); // config.yaml once per batch
    const rows = await rowsFor(JOB);
    expect(rows.map((x) => x.projectId).sort()).toEqual(w.projects.map((p) => p.id).sort());
    for (const row of rows) {
      expect(row.status).toBe("running");
      expect(row.modelConfig).toMatchObject({ modelId: w.model.id, modelName: w.model.name, batchPages: 10 + 11 + 12, batchProjects: 3 });
    }
    // root: no reservation, usage recorded per project after the start
    expect(h.reserveSagemakerPages).not.toHaveBeenCalled();
    expect(h.recordComputeUsage).toHaveBeenCalledTimes(3);
    expect(h.recordComputeUsage.mock.calls.map((c) => c[0].jobId)).toEqual([JOB, JOB, JOB]);
  });

  it("refuses a bad project alone (no pages / foreign / missing images) and runs the rest", async () => {
    const w = await world(2);
    const noPages = await createProject(w.company.id, w.root.id, { numPages: 0, status: "completed" });
    const other = await createCompany();
    const otherUser = await createUser(other.id);
    const foreign = await createProject(other.id, otherUser.id, { numPages: 5, status: "completed" });
    const noImages = await createProject(w.company.id, w.root.id, { numPages: 4, status: "completed" });
    h.s3Send.mockImplementation(async (cmd: { input: { Key: string } }) => {
      if (cmd.input.Key.startsWith(noImages.dataUrl)) throw new Error("NotFound");
      return {};
    });
    asUser(w.root);
    const ids = [w.projects[0].publicId, noPages.publicId, foreign.publicId, noImages.publicId, w.projects[1].publicId];
    const r = await readJson(await post({ modelId: w.model.id, projectIds: ids }));
    expect(r.status).toBe(200);
    const outcomes = (r.body as { projects: Array<{ projectId: string; status: string; httpStatus?: number }> }).projects;
    expect(outcomes.map((o) => [o.projectId, o.status, o.httpStatus])).toEqual([
      [w.projects[0].publicId, "running", undefined],
      [noPages.publicId, "refused", 400],
      [foreign.publicId, "refused", 404],
      [noImages.publicId, "refused", 400],
      [w.projects[1].publicId, "running", undefined],
    ]);
    expect(h.startYoloBatchJob.mock.calls[0][0]).toHaveLength(2);
    expect(await rowsFor(JOB)).toHaveLength(2);
  });

  it("a project whose yolo-run lease is held is refused (no double start); the others run", async () => {
    const w = await world(2);
    asUser(w.root);
    const busy = w.projects[0];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inLease = new Promise<void>((resolve) => (entered = resolve));
    const holder = withProjectMutationLease(
      assertProjectWritable(busy),
      { kind: "yolo-run", idempotencyKey: `${busy.id}:${w.model.id}` },
      async () => {
        entered();
        await held;
      },
    );
    await inLease;
    try {
      const r = await readJson(await post({ modelId: w.model.id, projectIds: w.projects.map((p) => p.publicId) }));
      expect(r.status).toBe(200);
      const outcomes = (r.body as { projects: Array<{ projectId: string; status: string; httpStatus?: number }> }).projects;
      expect(outcomes.find((o) => o.projectId === busy.publicId)).toMatchObject({ status: "refused", httpStatus: 409 });
      expect(outcomes.find((o) => o.projectId === w.projects[1].publicId)).toMatchObject({ status: "running" });
      expect(h.startYoloBatchJob.mock.calls[0][0]).toEqual([w.projects[1].dataUrl]);
    } finally {
      release();
      await holder;
    }
  });

  it("counts the batch as N runs against the daily quota (refused before any start)", async () => {
    const w = await world(3);
    asUser(w.root);
    h.checkYoloQuota.mockResolvedValue({ allowed: true, current: 8, limit: 10 });
    const r = await readJson(await post({ modelId: w.model.id, projectIds: w.projects.map((p) => p.publicId) }));
    expect(r.status).toBe(429);
    expect(JSON.stringify(r.body)).toMatch(/Daily YOLO job limit reached \(10\/day\): this batch needs 3, 2 left/u);
    expect(h.startYoloBatchJob).not.toHaveBeenCalled();
    expect(h.checkYoloQuota).toHaveBeenCalledWith(w.company.id, true, w.root.id);
  });

  it("non-root caller (service level): every project reserves its pages, a capped one is refused, reservations are stamped", async () => {
    const w = await world(2);
    h.reserveSagemakerPages
      .mockResolvedValueOnce({ allowed: true, reservationId: 11 })
      .mockResolvedValueOnce({ allowed: false, message: "SageMaker page cap reached", capHit: "company" });
    const session = { user: { companyId: w.company.id, dbId: w.admin.id, role: "admin", isRootAdmin: false, canRunModels: true } };
    const ordered = [...w.projects].sort((a, b) => a.id - b.id);
    const result = await yoloRunBatch({ modelId: w.model.id, projectIds: ordered.map((p) => p.publicId) }, session as never);
    expect(result.projects).toEqual([
      { projectId: ordered[0].publicId, status: "running" },
      { projectId: ordered[1].publicId, status: "refused", error: "SageMaker page cap reached", httpStatus: 429 },
    ]);
    expect(h.stampReservationJob).toHaveBeenCalledWith(11, JOB);
    expect(h.recordComputeUsage).not.toHaveBeenCalled();
  });

  it("a provider-confirmed refusal retires every row and reservation; an unknown outcome keeps them", async () => {
    const w = await world(2);
    asUser(w.root);
    h.startYoloBatchJob.mockRejectedValueOnce(new YoloStartRefusedError("No SageMaker quota for ml.g5.12xlarge", true));
    let r = await readJson(await post({ modelId: w.model.id, projectIds: w.projects.map((p) => p.publicId) }));
    expect(r.status).toBe(429);
    expect(await rowsFor(JOB)).toHaveLength(0);

    h.createYoloJobName.mockReturnValue(JOB2);
    h.startYoloBatchJob.mockRejectedValueOnce(new Error("socket hang up"));
    r = await readJson(await post({ modelId: w.model.id, projectIds: w.projects.map((p) => p.publicId) }));
    expect(r.status).toBe(500);
    const rows = await rowsFor(JOB2);
    expect(rows).toHaveLength(2);
    expect(rows.every((x) => x.status === "running" && x.error === "SageMaker start outcome unknown")).toBe(true);
  });

  it("rejects a non-canonical model path before writing config.yaml or starting", async () => {
    const w = await world(1);
    await db.update(models).set({ s3Path: "elsewhere/x" }).where(eq(models.id, w.model.id));
    asUser(w.root);
    const r = await readJson(await post({ modelId: w.model.id, projectIds: [w.projects[0].publicId] }));
    expect(r.status).toBe(409);
    expect(h.uploadToS3).not.toHaveBeenCalled();
    expect(h.startYoloBatchJob).not.toHaveBeenCalled();
  });
});
