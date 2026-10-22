// @vitest-environment node
// [2026-10-21] YOLO inference-instance allowlist (owner: "change which instance is running for YOLO
// processing"). Every allowlisted type must be one SageMaker accepts for a PROCESSING job — measured
// against the installed SDK's ProcessingInstanceType enum, not asserted from prose.
import { describe, expect, it } from "vitest";
import { ProcessingInstanceType } from "@aws-sdk/client-sagemaker";
import {
  DEFAULT_YOLO_INSTANCE_TYPE,
  YOLO_INSTANCE_OPTIONS,
  YOLO_INSTANCE_TYPES,
  isSageMakerNotFoundError,
  isSageMakerQuotaError,
  isYoloInstanceType,
  resolveYoloInstanceSetting,
  yoloInstanceLabel,
  yoloQuotaMessage,
} from "@/lib/yolo-instances";

describe("YOLO instance allowlist", () => {
  it("is a duplicate-free subset of the SDK's processing instance types, containing the default", () => {
    const sdk = new Set<string>(Object.values(ProcessingInstanceType));
    expect(YOLO_INSTANCE_TYPES.filter((t) => !sdk.has(t))).toEqual([]);
    expect(new Set(YOLO_INSTANCE_TYPES).size).toBe(YOLO_INSTANCE_TYPES.length);
    expect(DEFAULT_YOLO_INSTANCE_TYPE).toBe("ml.g4dn.xlarge");
    expect(YOLO_INSTANCE_TYPES).toContain(DEFAULT_YOLO_INSTANCE_TYPE);
  });

  it("offers only CUDA GPU families or plain CPU types — never Inferentia, Trainium or AMD GPUs", () => {
    for (const o of YOLO_INSTANCE_OPTIONS) {
      expect(o.type).not.toMatch(/^ml\.(inf|trn|g4ad)/u);
      if (o.gpu) expect(o.type).toMatch(/^ml\.(g4dn|g5|g6|g6e|p3)\./u);
      else expect(o.type).toMatch(/^ml\.(m5|c5)\./u);
      expect(yoloInstanceLabel(o)).toContain(o.type);
    }
  });

  it("isYoloInstanceType accepts allowlisted strings only", () => {
    expect(isYoloInstanceType("ml.g5.xlarge")).toBe(true);
    expect(isYoloInstanceType("ml.inf2.xlarge")).toBe(false);
    expect(isYoloInstanceType("ml.g4dn.xlarge ")).toBe(false);
    expect(isYoloInstanceType(42)).toBe(false);
  });

  it("resolveYoloInstanceSetting: missing/unknown/malformed → default (valid:false); allowlisted → itself", () => {
    expect(resolveYoloInstanceSetting(undefined)).toEqual({ instanceType: DEFAULT_YOLO_INSTANCE_TYPE, valid: false, raw: undefined });
    expect(resolveYoloInstanceSetting({ instanceType: "ml.p5.48xlarge" })).toMatchObject({ instanceType: DEFAULT_YOLO_INSTANCE_TYPE, valid: false });
    expect(resolveYoloInstanceSetting("ml.g5.xlarge")).toMatchObject({ instanceType: DEFAULT_YOLO_INSTANCE_TYPE, valid: false });
    expect(resolveYoloInstanceSetting({ instanceType: ["ml.g5.xlarge"] })).toMatchObject({ valid: false });
    expect(resolveYoloInstanceSetting({ instanceType: "ml.g6.xlarge" })).toEqual({ instanceType: "ml.g6.xlarge", valid: true, raw: "ml.g6.xlarge" });
  });

  it("recognises SageMaker's ResourceLimitExceeded and names the type in the refusal", () => {
    expect(isSageMakerQuotaError({ name: "ResourceLimitExceeded", message: "limit" })).toBe(true);
    expect(isSageMakerQuotaError({ __type: "com.amazonaws.sagemaker#ResourceLimitExceeded" })).toBe(true);
    expect(isSageMakerQuotaError(new Error("ResourceLimitExceeded"))).toBe(false); // name is "Error"
    expect(isSageMakerQuotaError({ name: "ValidationException" })).toBe(false);
    expect(isSageMakerQuotaError(null)).toBe(false);
    expect(yoloQuotaMessage("ml.g5.xlarge")).toMatch(/^No SageMaker quota for ml\.g5\.xlarge processing jobs/u);
  });

  it("treats only a Describe 'no such job' answer as proof of absence", () => {
    expect(isSageMakerNotFoundError({ name: "ValidationException", message: "Could not find requested job with name x" })).toBe(true);
    expect(isSageMakerNotFoundError({ name: "ResourceNotFound", message: "" })).toBe(true);
    expect(isSageMakerNotFoundError({ name: "ValidationException", message: "1 validation error detected" })).toBe(false);
    expect(isSageMakerNotFoundError({ name: "ThrottlingException", message: "Rate exceeded; job not found" })).toBe(false);
    expect(isSageMakerNotFoundError(new Error("Could not find requested job"))).toBe(false); // name is "Error"
    expect(isSageMakerNotFoundError(undefined)).toBe(false);
  });
});
