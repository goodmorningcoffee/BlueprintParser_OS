// @vitest-environment node
// [2026-10-21] startYoloJob launches on the root-chosen instance type and turns a SageMaker
// ResourceLimitExceeded into a 429 YoloStartRefusedError naming that type (confirmedAbsent only when a
// Describe says no such job exists); the run-path reader never throws.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  inputs: [] as Array<Record<string, unknown>>,
  send: vi.fn(),
  readYoloInstanceType: vi.fn(),
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
vi.mock("@/server/services/yolo-instance", () => ({ readYoloInstanceType: h.readYoloInstanceType }));

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
});

describe("startYoloJob instance type", () => {
  it("uses the instance type the setting reader returns", async () => {
    h.readYoloInstanceType.mockResolvedValue("ml.g5.2xlarge");
    const { startYoloJob } = await loadYolo();
    await startYoloJob("co/0123456789abcdefabcd", "models/doors", "doors", "bp-yolo-doors-x");
    expect(h.readYoloInstanceType).toHaveBeenCalledTimes(1);
    expect(clusterOf(h.inputs[0])).toEqual({ InstanceCount: 1, InstanceType: "ml.g5.2xlarge", VolumeSizeInGB: 30 });
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
    expect(refusal).toMatchObject({ code: "RATE_LIMITED", status: 429, confirmedAbsent: true });
    expect((refusal as Error).message).toMatch(/^No SageMaker quota for ml\.g6\.xlarge processing jobs/u);
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.send.mock.calls[1][0]).toMatchObject({ input: { ProcessingJobName: "j1" } }); // the Describe
  });

  it("a quota refusal whose Describe is inconclusive is NOT confirmed (the intent must stay a blocker)", async () => {
    const { startYoloJob } = await loadYolo();
    h.send
      .mockRejectedValueOnce(Object.assign(new Error("limit"), { name: "ResourceLimitExceeded" }))
      .mockRejectedValueOnce(Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" }));
    const refusal = await startYoloJob("co/0123456789abcdefabcd", "models/doors", "doors", "j3").catch((e: unknown) => e);
    expect(refusal).toMatchObject({ code: "RATE_LIMITED", confirmedAbsent: false });
  });

  it("a quota refusal on an SDK retry whose first attempt was accepted returns the job name (the job is real)", async () => {
    const { startYoloJob } = await loadYolo();
    h.send
      .mockRejectedValueOnce(Object.assign(new Error("limit"), { name: "ResourceLimitExceeded" }))
      .mockResolvedValueOnce({ ProcessingJobStatus: "InProgress" });
    await expect(startYoloJob("co/0123456789abcdefabcd", "models/doors", "doors", "j4")).resolves.toBe("j4");
  });

  it("other SDK errors pass through unchanged, with no Describe", async () => {
    const { startYoloJob } = await loadYolo();
    const boom = Object.assign(new Error("socket hang up"), { name: "TimeoutError" });
    h.send.mockRejectedValueOnce(boom);
    await expect(startYoloJob("co/0123456789abcdefabcd", "models/doors", "doors", "j2")).rejects.toBe(boom);
    expect(h.send).toHaveBeenCalledTimes(1);
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
    vi.doUnmock("@/lib/db");
  });
});
