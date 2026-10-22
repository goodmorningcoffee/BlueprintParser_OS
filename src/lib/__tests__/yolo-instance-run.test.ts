// @vitest-environment node
// [2026-10-21] startYoloJob launches on the root-chosen instance type and turns a SageMaker
// ResourceLimitExceeded into a 429 YoloStartRefusedError naming that type (confirmedAbsent only when a
// Describe says no such job exists); the run-path reader never throws. [2026-10-22] Every create failure
// is classified by AWS name (lib/yolo-start-errors): 429 RETRYABLE / 400 VALIDATION / 500 naming it.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  inputs: [] as Array<Record<string, unknown>>,
  send: vi.fn(),
  readYoloInstanceType: vi.fn(),
  readYoloMaxRuntimeSeconds: vi.fn(),
}));

vi.mock("@aws-sdk/client-sagemaker", () => ({
  SageMakerClient: class {
    send = h.send;
  },
  CreateProcessingJobCommand: class {
    constructor(public input: Record<string, unknown>) {
      h.inputs.push(input);
    }
  },
  DescribeProcessingJobCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));
vi.mock("@/server/services/yolo-instance", () => ({
  readYoloInstanceType: h.readYoloInstanceType,
  readYoloMaxRuntimeSeconds: h.readYoloMaxRuntimeSeconds,
}));

const ACCOUNT = "123456789012";
const REGION = "us-east-1";

async function loadYolo() {
  process.env.AWS_ACCOUNT = ACCOUNT;
  process.env.AWS_REGION = REGION;
  process.env.S3_BUCKET = `beaver-data-${ACCOUNT}`;
  process.env.YOLO_ECR_IMAGE = `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/beaver-yolo-pipeline@sha256:${"a".repeat(64)}`;
  process.env.SAGEMAKER_ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/beaver-sagemaker-role`;
  vi.resetModules();
  return import("@/lib/yolo");
}

const clusterOf = (input: Record<string, unknown>) =>
  (input.ProcessingResources as { ClusterConfig: Record<string, unknown> }).ClusterConfig;

beforeEach(() => {
  h.inputs.length = 0;
  h.send.mockReset().mockResolvedValue({});
  h.readYoloInstanceType.mockReset().mockResolvedValue("ml.g4dn.xlarge");
  h.readYoloMaxRuntimeSeconds.mockReset().mockResolvedValue(3600);
});

describe("startYoloJob instance type", () => {
  it("uses the instance type the setting reader returns", async () => {
    h.readYoloInstanceType.mockResolvedValue("ml.g5.2xlarge");
    const { startYoloJob } = await loadYolo();
    await startYoloJob("co/0123456789abcdefabcd", "models/doors", "doors", "bp-yolo-doors-x");
    expect(h.readYoloInstanceType).toHaveBeenCalledTimes(1);
    expect(clusterOf(h.inputs[0])).toEqual({ InstanceCount: 1, InstanceType: "ml.g5.2xlarge", VolumeSizeInGB: 30 });
    expect(h.inputs[0].StoppingCondition).toEqual({ MaxRuntimeInSeconds: 3600 });
  });

  it("uses the root-set timeout as MaxRuntimeInSeconds", async () => {
    h.readYoloMaxRuntimeSeconds.mockResolvedValue(7200);
    const { startYoloJob } = await loadYolo();
    await startYoloJob("co/0123456789abcdefabcd", "models/doors", "doors", "bp-yolo-doors-t");
    expect(h.readYoloMaxRuntimeSeconds).toHaveBeenCalledTimes(1);
    expect(h.inputs[0].StoppingCondition).toEqual({ MaxRuntimeInSeconds: 7200 });
  });

  it("maps ResourceLimitExceeded to a 429 YoloStartRefusedError naming the type; AWS-confirmed absent → confirmedAbsent", async () => {
    h.readYoloInstanceType.mockResolvedValue("ml.g6.xlarge");
    const { startYoloJob, YoloStartRefusedError } = await loadYolo();
    const { ApiError } = await import("@/server/api/envelope");
    h.send
      .mockRejectedValueOnce(Object.assign(new Error("account-level service limit"), { name: "ResourceLimitExceeded" }))
      .mockRejectedValueOnce(Object.assign(new Error("Could not find requested job with name j1"), { name: "ValidationException" }));
    const refusal = await startYoloJob("co/0123456789abcdefabcd", "models/doors", "doors", "j1").catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(YoloStartRefusedError);
    expect(refusal).toBeInstanceOf(ApiError);
    expect(refusal).toMatchObject({ code: "RETRYABLE", status: 429, confirmedAbsent: true });
    expect((refusal as Error).message).toMatch(/^No SageMaker quota for ml\.g6\.xlarge processing jobs/u);
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.send.mock.calls[1][0]).toMatchObject({ input: { ProcessingJobName: "j1" } }); // the Describe
  });

  it("a refusal with no AWS status whose Describe stays inconclusive (3 tries) is NOT confirmed: 500, never retryable", async () => {
    const { startYoloJob } = await loadYolo();
    const throttle = () => Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" });
    h.send
      .mockRejectedValueOnce(Object.assign(new Error("limit"), { name: "ResourceLimitExceeded" }))
      .mockRejectedValueOnce(throttle())
      .mockRejectedValueOnce(throttle())
      .mockRejectedValueOnce(throttle());
    const refusal = await startYoloJob("co/0123456789abcdefabcd", "models/doors", "doors", "j3").catch((e: unknown) => e);
    expect(refusal).toMatchObject({ code: "INTERNAL", status: 500, confirmedAbsent: false, awsName: "ResourceLimitExceeded" });
    expect((refusal as Error).message).toBe("SageMaker start outcome unknown (ResourceLimitExceeded) — check Stuck jobs before retrying");
    expect(h.send).toHaveBeenCalledTimes(4);
  });

  it("[DOUBLE_BACK quota burn] a throttled first Describe is retried, so a real absence is still confirmed", async () => {
    const { startYoloJob } = await loadYolo();
    h.send
      .mockRejectedValueOnce(Object.assign(new Error("limit"), { name: "ResourceLimitExceeded" }))
      .mockRejectedValueOnce(Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" }))
      .mockRejectedValueOnce(Object.assign(new Error("Could not find requested job with name j5"), { name: "ValidationException" }));
    const refusal = await startYoloJob("co/0123456789abcdefabcd", "models/doors", "doors", "j5").catch((e: unknown) => e);
    expect(refusal).toMatchObject({ code: "RETRYABLE", confirmedAbsent: true });
  });

  it("a quota refusal on an SDK retry whose first attempt was accepted returns the job name (the job is real)", async () => {
    const { startYoloJob } = await loadYolo();
    h.send
      .mockRejectedValueOnce(Object.assign(new Error("limit"), { name: "ResourceLimitExceeded" }))
      .mockResolvedValueOnce({ ProcessingJobStatus: "InProgress" });
    await expect(startYoloJob("co/0123456789abcdefabcd", "models/doors", "doors", "j4")).resolves.toBe("j4");
  });

  it("[2026-10-22 incident] a throttled create (AWS 400) whose Describe is also throttled is still a confirmed 429 RETRYABLE", async () => {
    const { startYoloJob } = await loadYolo();
    const throttle = () =>
      Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException", $metadata: { httpStatusCode: 400 } });
    h.send.mockRejectedValueOnce(throttle()).mockRejectedValueOnce(throttle()).mockRejectedValueOnce(throttle()).mockRejectedValueOnce(throttle());
    const refusal = await startYoloJob("co/0123456789abcdefabcd", "models/doors", "doors", "j6").catch((e: unknown) => e);
    expect(refusal).toMatchObject({ code: "RETRYABLE", status: 429, confirmedAbsent: true, awsName: "ThrottlingException" });
    expect((refusal as Error).message).toBe("SageMaker is busy (ThrottlingException): Rate exceeded — retry shortly");
  });

  it("a network error with no AWS answer is settled by Describe: absent → confirmed 500 naming it; present → the job runs", async () => {
    const { startYoloJob } = await loadYolo();
    const boom = () => Object.assign(new Error("socket hang up"), { name: "TimeoutError" });
    h.send
      .mockRejectedValueOnce(boom())
      .mockRejectedValueOnce(Object.assign(new Error("Could not find requested job with name j2"), { name: "ValidationException" }));
    const refusal = await startYoloJob("co/0123456789abcdefabcd", "models/doors", "doors", "j2").catch((e: unknown) => e);
    expect(refusal).toMatchObject({ code: "INTERNAL", status: 500, confirmedAbsent: true, message: "Failed to start SageMaker job (TimeoutError)" });
    expect(h.send).toHaveBeenCalledTimes(2);

    h.send.mockRejectedValueOnce(boom()).mockResolvedValueOnce({ ProcessingJobStatus: "InProgress" });
    await expect(startYoloJob("co/0123456789abcdefabcd", "models/doors", "doors", "j7")).resolves.toBe("j7");
  });
});

describe("readYoloInstanceType (run path)", () => {
  it("never throws: a failed settings read falls back to ml.g4dn.xlarge", async () => {
    vi.doUnmock("@/server/services/yolo-instance");
    vi.doMock("@/lib/db", () => ({
      db: {
        select: () => {
          throw new Error("db down");
        },
      },
    }));
    vi.resetModules();
    const { readYoloInstanceType } = await import("@/server/services/yolo-instance");
    await expect(readYoloInstanceType()).resolves.toBe("ml.g4dn.xlarge");
    const { readYoloMaxRuntimeSeconds } = await import("@/server/services/yolo-instance");
    await expect(readYoloMaxRuntimeSeconds()).resolves.toBe(3600);
    vi.doUnmock("@/lib/db");
  });
});
