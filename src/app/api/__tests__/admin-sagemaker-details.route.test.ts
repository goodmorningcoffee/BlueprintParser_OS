// @vitest-environment node
// [refactor jul7 S052] CHARACTERIZATION for admin/sagemaker-details SOLO (GET — rich details
// of a SageMaker processing job), written as THE FREEZE before the fold onto
// services/sagemaker-details.ts. Solo. requireAdmin. Frozen quirk inventory:
//   • jobName query param; !jobName → 400 "jobName required".
//   • sagemakerClient.send(DescribeProcessingJobCommand) → shaped response (jobName, status,
//     failureReason||null, exitMessage||null, times ISO, durationSeconds = round((end-start)/
//     1000) [or Date.now()-start for in-progress, else null], instanceType/Count/VolumeGB,
//     inputs[]{name,s3Uri}, outputs[]{name,s3Uri}, stoppingConditionSeconds).
//   • ⚠️ catch: {error: err.message || "Failed to describe job"} @500 — an ERR.MESSAGE LEAK
//     (DR002 :70 sanctioned B) → flips to generic INTERNAL 500 at fold.
// GET no body (query param) → ZERO E. Sanctioned diffs A (jobName-required) + B (leak catch).
// @aws-sdk/client-sagemaker mocked. Assertions tagged [S052 fold: … applied] were flipped
// in the fold commit onto services/sagemaker-details.ts.
import { describe, expect, inject, it, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

const h = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/client-sagemaker", () => ({
  SageMakerClient: class { send = h.send; },
  DescribeProcessingJobCommand: class { constructor(public input: unknown) {} },
}));

import { GET as smGET } from "@/app/api/admin/sagemaker-details/route";
import { asUser, createCompany, createUser, makeReq, readJson, signedOut } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

async function makeAdmin() {
  const company = await createCompany();
  const admin = await createUser(company.id, { role: "admin" });
  const member = await createUser(company.id);
  const root = await createUser(company.id, { isRootAdmin: true });
  return { admin, member, root };
}

const req = (qs = "") => makeReq(`/api/admin/sagemaker-details${qs}`, { method: "GET" });
const UNAUTH = { error: { code: "UNAUTHORIZED", message: "Unauthorized" } }; // [S052 fold: A applied]
const ADMIN_ONLY = { error: { code: "FORBIDDEN", message: "Admin only" } }; // [S052 fold: A applied]

const COMPLETED_JOB = {
  ProcessingJobName: "job-1",
  ProcessingJobStatus: "Completed",
  FailureReason: undefined,
  ExitMessage: undefined,
  CreationTime: new Date("2026-07-01T00:00:00.000Z"),
  ProcessingStartTime: new Date("2026-07-01T00:00:00.000Z"),
  ProcessingEndTime: new Date("2026-07-01T00:01:40.000Z"), // +100s
  ProcessingInputs: [{ InputName: "in1", S3Input: { S3Uri: "s3://b/in" } }],
  ProcessingOutputConfig: { Outputs: [{ OutputName: "out1", S3Output: { S3Uri: "s3://b/out" } }] },
  ProcessingResources: { ClusterConfig: { InstanceType: "ml.g4dn.xlarge", InstanceCount: 1, VolumeSizeInGB: 30 } },
  StoppingCondition: { MaxRuntimeInSeconds: 3600 },
};

beforeEach(() => { vi.clearAllMocks(); signedOut(); h.send.mockResolvedValue(COMPLETED_JOB); });

describe.skipIf(!dbUp)("admin/sagemaker-details (SM)", () => {
  it("SM-1 auth: signed-out→401, member→403, admin→200", async () => {
    const { admin, member } = await makeAdmin();
    let r = await readJson(await smGET(req("?jobName=job-1")));
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S052 fold: A applied]
    asUser(member);
    r = await readJson(await smGET(req("?jobName=job-1")));
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ADMIN_ONLY); // [S052 fold: A applied]
    asUser(admin);
    expect((await readJson(await smGET(req("?jobName=job-1")))).status).toBe(200);
  });

  it("SM-2 no jobName → 400 'jobName required'", async () => {
    const { admin } = await makeAdmin();
    asUser(admin);
    const r = await readJson(await smGET(req()));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: { code: "VALIDATION", message: "jobName required" } }); // [S052 fold: A applied]
    expect(h.send).not.toHaveBeenCalled();
  });

  it("SM-3 shapes the DescribeProcessingJob result (durationSeconds, inputs/outputs, nulls)", async () => {
    const { admin } = await makeAdmin();
    asUser(admin);
    const r = await readJson(await smGET(req("?jobName=job-1")));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      jobName: "job-1",
      status: "Completed",
      failureReason: null, // undefined → null
      exitMessage: null,
      durationSeconds: 100, // (end-start)/1000
      instanceType: "ml.g4dn.xlarge",
      instanceCount: 1,
      volumeSizeGB: 30,
      inputs: [{ name: "in1", s3Uri: "s3://b/in" }],
      outputs: [{ name: "out1", s3Uri: "s3://b/out" }],
      stoppingConditionSeconds: 3600,
    });
    expect(r.body.startTime).toBe("2026-07-01T00:00:00.000Z");
    expect(r.body.endTime).toBe("2026-07-01T00:01:40.000Z");
  });

  it("SM-4 ⚠️ catch LEAKS err.message @500 (DR002 sanctioned B)", async () => {
    // [S052 fold: B — err.message leak retired → generic INTERNAL 500 "Internal server error"]
    const { admin } = await makeAdmin();
    asUser(admin);
    h.send.mockRejectedValue(new Error("AccessDenied: not authorized to sagemaker:DescribeProcessingJob"));
    const r = await readJson(await smGET(req("?jobName=job-1")));
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: { code: "INTERNAL", message: "Internal server error" } }); // [S052 fold: B applied — AWS-error leak dropped]
  });
});
