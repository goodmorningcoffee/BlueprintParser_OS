// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  inputs: [] as Array<Record<string, unknown>>,
  send: vi.fn().mockResolvedValue({}),
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

const ACCOUNT = "123456789012";
const REGION = "us-east-1";
const DIGEST = `sha256:${"a".repeat(64)}`;
const IMAGE = `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/beaver-yolo-pipeline@${DIGEST}`;
const ROLE = `arn:aws:iam::${ACCOUNT}:role/beaver-sagemaker-role`;

async function loadYolo(overrides: Record<string, string> = {}) {
  process.env.AWS_ACCOUNT = ACCOUNT;
  process.env.AWS_REGION = REGION;
  process.env.S3_BUCKET = `beaver-data-${ACCOUNT}`;
  process.env.YOLO_ECR_IMAGE = IMAGE;
  process.env.SAGEMAKER_ROLE_ARN = ROLE;
  Object.assign(process.env, overrides);
  vi.resetModules();
  return import("@/lib/yolo");
}

beforeEach(() => {
  h.inputs.length = 0;
  h.send.mockClear();
  h.send.mockResolvedValue({});
});

describe("YOLO SageMaker execution boundary", () => {
  it("launches only the canonical digest/role/bucket with network isolation", async () => {
    const { startYoloJob } = await loadYolo();
    await expect(
      startYoloJob(
        "company-key/0123456789abcdefabcd",
        "models/doors",
        "doors",
        "bp-yolo-doors-fixed",
      ),
    ).resolves.toBe("bp-yolo-doors-fixed");

    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.inputs).toHaveLength(1);
    expect(h.inputs[0]).toMatchObject({
      AppSpecification: { ImageUri: IMAGE },
      RoleArn: ROLE,
      NetworkConfig: { EnableNetworkIsolation: true },
      ProcessingInputs: [
        {
          S3Input: {
            S3Uri: `s3://beaver-data-${ACCOUNT}/company-key/0123456789abcdefabcd/pages/`,
          },
        },
        {
          S3Input: {
            S3Uri: `s3://beaver-data-${ACCOUNT}/models/doors/`,
          },
        },
      ],
    });
  });

  it("rejects a mutable image tag before contacting SageMaker", async () => {
    const { startYoloJob } = await loadYolo({
      YOLO_ECR_IMAGE: `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/beaver-yolo-pipeline:latest`,
    });
    await expect(startYoloJob("a/b", "models/x", "x")).rejects.toThrow(
      /digest-pinned repository image/u,
    );
    expect(h.send).not.toHaveBeenCalled();
  });

  it("rejects a substituted execution role before contacting SageMaker", async () => {
    const { startYoloJob } = await loadYolo({
      SAGEMAKER_ROLE_ARN: `arn:aws:iam::${ACCOUNT}:role/attacker-role`,
    });
    await expect(startYoloJob("a/b", "models/x", "x")).rejects.toThrow(
      /canonical SageMaker execution role/u,
    );
    expect(h.send).not.toHaveBeenCalled();
  });

  it("rejects a substituted data bucket before contacting SageMaker", async () => {
    const { startYoloJob } = await loadYolo({ S3_BUCKET: "attacker-bucket" });
    await expect(startYoloJob("a/b", "models/x", "x")).rejects.toThrow(
      /canonical account-owned data bucket/u,
    );
    expect(h.send).not.toHaveBeenCalled();
  });
});
