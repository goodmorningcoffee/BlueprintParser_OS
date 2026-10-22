// @vitest-environment node
// [2026-10-22] startYoloBatchJob: ONE processing job for up to 9 projects — each project's own canonical
// input/output prefix at its own slot path, the model input, BP_YOLO_SLOTS for the script, and the same
// authority / instance / timeout / isolation as the single job.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  inputs: [] as Array<Record<string, any>>,
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
const BUCKET = `beaver-data-${ACCOUNT}`;

async function loadYolo(image = `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/beaver-yolo-pipeline@sha256:${"a".repeat(64)}`) {
  process.env.AWS_ACCOUNT = ACCOUNT;
  process.env.AWS_REGION = REGION;
  process.env.S3_BUCKET = BUCKET;
  process.env.YOLO_ECR_IMAGE = image;
  process.env.SAGEMAKER_ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/beaver-sagemaker-role`;
  vi.resetModules();
  return import("@/lib/yolo");
}

beforeEach(() => {
  h.inputs.length = 0;
  h.send.mockReset().mockResolvedValue({});
  h.readYoloInstanceType.mockReset().mockResolvedValue("ml.g5.12xlarge");
  h.readYoloMaxRuntimeSeconds.mockReset().mockResolvedValue(5400);
});

describe("startYoloBatchJob", () => {
  it("mounts each project at its own slot with its canonical S3 input and output", async () => {
    const { startYoloBatchJob } = await loadYolo();
    await expect(startYoloBatchJob(["co/aaa", "co/bbb", "co/ccc"], "models/doors", "doors", "bp-yolo-doors-b1")).resolves.toBe("bp-yolo-doors-b1");
    const input = h.inputs[0];
    expect(input.Environment).toEqual({ BP_YOLO_SLOTS: "p0,p1,p2" });
    expect(input.ProcessingInputs).toEqual([
      { InputName: "images-p0", S3Input: { S3Uri: `s3://${BUCKET}/co/aaa/pages/`, LocalPath: "/opt/ml/processing/input/projects/p0", S3DataType: "S3Prefix", S3InputMode: "File" } },
      { InputName: "images-p1", S3Input: { S3Uri: `s3://${BUCKET}/co/bbb/pages/`, LocalPath: "/opt/ml/processing/input/projects/p1", S3DataType: "S3Prefix", S3InputMode: "File" } },
      { InputName: "images-p2", S3Input: { S3Uri: `s3://${BUCKET}/co/ccc/pages/`, LocalPath: "/opt/ml/processing/input/projects/p2", S3DataType: "S3Prefix", S3InputMode: "File" } },
      { InputName: "models", S3Input: { S3Uri: `s3://${BUCKET}/models/doors/`, LocalPath: "/opt/ml/processing/input/models", S3DataType: "S3Prefix", S3InputMode: "File" } },
    ]);
    expect(input.ProcessingOutputConfig.Outputs.map((o: any) => [o.OutputName, o.S3Output.S3Uri, o.S3Output.LocalPath])).toEqual([
      ["results-p0", `s3://${BUCKET}/co/aaa/yolo-output/doors/`, "/opt/ml/processing/output/p0"],
      ["results-p1", `s3://${BUCKET}/co/bbb/yolo-output/doors/`, "/opt/ml/processing/output/p1"],
      ["results-p2", `s3://${BUCKET}/co/ccc/yolo-output/doors/`, "/opt/ml/processing/output/p2"],
    ]);
    expect(input.ProcessingResources.ClusterConfig).toEqual({ InstanceCount: 1, InstanceType: "ml.g5.12xlarge", VolumeSizeInGB: 30 });
    expect(input.StoppingCondition).toEqual({ MaxRuntimeInSeconds: 5400 });
    expect(input.NetworkConfig).toEqual({ EnableNetworkIsolation: true });
  });

  it("allows 9 projects (9 + model = 10 inputs, 9 outputs) and refuses 0 or 10 before contacting SageMaker", async () => {
    const { startYoloBatchJob, MAX_YOLO_BATCH_PROJECTS } = await loadYolo();
    expect(MAX_YOLO_BATCH_PROJECTS).toBe(9);
    const nine = Array.from({ length: 9 }, (_, i) => `co/p${i}`);
    await startYoloBatchJob(nine, "models/doors", "doors", "j9");
    expect(h.inputs[0].ProcessingInputs).toHaveLength(10);
    expect(h.inputs[0].ProcessingOutputConfig.Outputs).toHaveLength(9);
    await expect(startYoloBatchJob([...nine, "co/p9"], "models/doors", "doors", "j10")).rejects.toThrow(/1–9 projects/u);
    await expect(startYoloBatchJob([], "models/doors", "doors", "j0")).rejects.toThrow(/1–9 projects/u);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("keeps the runtime authority: a mutable image tag is refused before any send", async () => {
    const { startYoloBatchJob } = await loadYolo(`${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/beaver-yolo-pipeline:latest`);
    await expect(startYoloBatchJob(["co/a"], "models/doors", "doors", "j")).rejects.toThrow(/YOLO_ECR_IMAGE/u);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("a quota refusal is a YoloStartRefusedError (confirmedAbsent when AWS has no such job)", async () => {
    const { startYoloBatchJob, YoloStartRefusedError } = await loadYolo();
    h.send
      .mockRejectedValueOnce(Object.assign(new Error("limit"), { name: "ResourceLimitExceeded" }))
      .mockRejectedValueOnce(Object.assign(new Error("Could not find requested job"), { name: "ValidationException" }));
    const err = await startYoloBatchJob(["co/a"], "models/doors", "doors", "j").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(YoloStartRefusedError);
    expect((err as InstanceType<typeof YoloStartRefusedError>).confirmedAbsent).toBe(true);
  });
});
