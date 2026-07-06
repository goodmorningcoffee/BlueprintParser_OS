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
//     completedAt:now} WHERE executionId=executionId (⚠️ NOT company-scoped — legacy behavior,
//     preserve byte-exact) → {success:true}.
// GET body: none → GET has no E. PUT reads body → E applies at fold. No catch-500 literal → NO B.
// Assertions tagged [S046 fold] flip in the fold commit (sanctioned A/E only).
import { describe, expect, inject, it, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { GET as rjGET, PUT as rjPUT } from "@/app/api/admin/running-jobs/route";
import { db } from "@/lib/db";
import { processingJobs } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { asUser, createCompany, createUser, createProject, makeReq, readJson, signedOut } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

async function makeWorld() {
  const company = await createCompany();
  const admin = await createUser(company.id, { role: "admin" });
  const member = await createUser(company.id);
  const root = await createUser(company.id, { isRootAdmin: true });
  return { company, admin, member, root };
}

const getReq = () => makeReq("/api/admin/running-jobs", { method: "GET" });
const putReq = (body: unknown) => makeReq("/api/admin/running-jobs", { method: "PUT", body });
const UNAUTH = { error: "Unauthorized" }; // [S046 fold: A → {error:{code:"UNAUTHORIZED",message:"Unauthorized"}}]
const ADMIN_ONLY = { error: "Admin only" }; // [S046 fold: A → {error:{code:"FORBIDDEN",message:"Admin only"}}]

const tag = () => Math.random().toString(36).slice(2, 8);
async function seedJob(projectId: number, over: Partial<typeof processingJobs.$inferInsert> = {}) {
  const [j] = await db.insert(processingJobs).values({
    projectId, executionId: `exec-${tag()}`, status: "running",
    modelConfig: { modelId: 7, modelName: "yolo-x" } as never, ...over,
  }).returning();
  return j;
}
async function jobByExec(executionId: string) {
  const [j] = await db.select().from(processingJobs).where(eq(processingJobs.executionId, executionId)).limit(1);
  return j;
}

beforeEach(() => { vi.clearAllMocks(); signedOut(); });

describe.skipIf(!dbUp)("admin/running-jobs (RJ)", () => {
  it("RJ-1 GET auth: signed-out→401, member→403, admin+root→200", async () => {
    const { admin, member, root } = await makeWorld();
    let r = await readJson(await rjGET());
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S046 fold: A]
    asUser(member);
    r = await readJson(await rjGET());
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ADMIN_ONLY); // [S046 fold: A]
    asUser(admin);
    expect((await readJson(await rjGET())).status).toBe(200);
    asUser(root);
    expect((await readJson(await rjGET())).status).toBe(200);
  });

  it("RJ-2 GET: BARE ARRAY of own-company running jobs (companyId-scoped), shaped from model_config", async () => {
    const { company, admin } = await makeWorld();
    const author = await createUser(company.id);
    const proj = await createProject(company.id, author.id);
    const job = await seedJob(proj.id);
    // a completed job (excluded), and another company's running job (excluded)
    await seedJob(proj.id, { status: "completed", executionId: `done-${tag()}` });
    const otherCo = await createCompany();
    const otherProj = await createProject(otherCo.id, (await createUser(otherCo.id)).id);
    await seedJob(otherProj.id);
    asUser(admin);
    const r = await readJson(await rjGET());
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true); // BARE array, not enveloped
    const mine = r.body.filter((j: { executionId: string }) => j.executionId === job.executionId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ projectPublicId: proj.publicId, executionId: job.executionId, modelId: 7, modelName: "yolo-x" });
    // the other company's running job is NOT visible
    expect(r.body.every((j: { projectPublicId: string }) => j.projectPublicId !== otherProj.publicId)).toBe(true);
  });

  it("RJ-3 GET GRACEFUL catch: a raw-SQL error → 200 bare [] (fail quietly, NOT a 500)", async () => {
    const { admin } = await makeWorld();
    asUser(admin);
    const spy = vi.spyOn(db, "execute").mockRejectedValueOnce(new Error("db down"));
    const r = await readJson(await rjGET());
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]); // graceful empty array
    spy.mockRestore();
  });

  it("RJ-4 PUT auth: signed-out→401, member→403", async () => {
    const { member } = await makeWorld();
    let r = await readJson(await rjPUT(putReq({ executionId: "x", status: "Completed" })));
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S046 fold: A]
    asUser(member);
    r = await readJson(await rjPUT(putReq({ executionId: "x", status: "Completed" })));
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ADMIN_ONLY); // [S046 fold: A]
  });

  it("RJ-5 PUT validation: missing fields → 'executionId and status required'; bad status → 'Invalid terminal status'", async () => {
    const { admin } = await makeWorld();
    asUser(admin);
    for (const body of [{}, { executionId: "x" }, { status: "Completed" }]) {
      const r = await readJson(await rjPUT(putReq(body)));
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: "executionId and status required" }); // [S046 fold: A]
    }
    const r = await readJson(await rjPUT(putReq({ executionId: "x", status: "Bogus" })));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "Invalid terminal status" }); // [S046 fold: A]
  });

  it("RJ-6 PUT write: maps Completed→completed / Failed|Stopped→failed, sets completedAt (by executionId, NOT company-scoped)", async () => {
    const { company, admin } = await makeWorld();
    const author = await createUser(company.id);
    const proj = await createProject(company.id, author.id);
    asUser(admin);
    for (const [status, dbStatus] of [["Completed", "completed"], ["Failed", "failed"], ["Stopped", "failed"]] as const) {
      const job = await seedJob(proj.id);
      const r = await readJson(await rjPUT(putReq({ executionId: job.executionId, status })));
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ success: true });
      const updated = await jobByExec(job.executionId!);
      expect(updated.status).toBe(dbStatus);
      expect(updated.completedAt).toBeTruthy();
    }
  });
});
