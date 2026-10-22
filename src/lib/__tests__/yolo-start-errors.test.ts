// @vitest-environment node
// [2026-10-22 bulk YOLO incident] CreateProcessingJob refusals are classified by AWS error name:
// retryable → 429 RETRYABLE, validation → 400 with the AWS message, else 500 naming the error.
// A 4xx answer to the create is a definitive refusal unless the job name collided (SDK retry of an
// accepted create); an unconfirmed outcome is never retryable. Messages are scrubbed of ARNs/accounts.
import { describe, expect, it } from "vitest";
import {
  awsErrorFacts,
  isDefinitiveRejection,
  refusedStartError,
  scrubAwsMessage,
  settleCreateFailure,
} from "@/lib/yolo-start-errors";

const awsErr = (name: string, message: string, httpStatusCode?: number) =>
  Object.assign(new Error(message), { name, ...(httpStatusCode ? { $metadata: { httpStatusCode } } : {}) });

describe("refusedStartError", () => {
  it.each([
    ["ThrottlingException", "Rate exceeded", 400],
    ["Throttling", "Rate exceeded", 400],
    ["ServiceUnavailable", "Service unavailable", 503],
    ["InsufficientCapacityError", "no capacity", 400],
    ["SomethingNew", "slow down", 429],
  ])("%s → 429 RETRYABLE with the AWS name + message", (name, message, status) => {
    const e = refusedStartError(awsErr(name, message, status), "ml.g5.12xlarge", true);
    expect(e).toMatchObject({ code: "RETRYABLE", status: 429, awsName: name, confirmedAbsent: true });
    expect(e.message).toBe(`SageMaker is busy (${name}): ${message} — retry shortly`);
  });

  it("ResourceLimitExceeded keeps the instance-quota wording (the queue waits for its own jobs)", () => {
    const e = refusedStartError(awsErr("ResourceLimitExceeded", "limit", 400), "ml.g5.12xlarge", true);
    expect(e).toMatchObject({ code: "RETRYABLE", status: 429 });
    expect(e.message).toMatch(/^No SageMaker quota for ml\.g5\.12xlarge processing jobs \(ResourceLimitExceeded\)/u);
  });

  it("validation → 400 with the scrubbed AWS message", () => {
    const e = refusedStartError(
      awsErr("ValidationException", "Role arn:aws:iam::123456789012:role/x is invalid for account 123456789012", 400),
      "ml.g4dn.xlarge",
      true,
    );
    expect(e).toMatchObject({ code: "VALIDATION", status: 400 });
    expect(e.message).toBe("SageMaker rejected the job (ValidationException): Role <arn> is invalid for account <account>");
  });

  it("anything else → 500 naming the error (no message: it may carry internals)", () => {
    const e = refusedStartError(awsErr("AccessDeniedException", "User arn:aws:sts::1:assumed is not authorized", 400), "x", true);
    expect(e).toMatchObject({ code: "INTERNAL", status: 500 });
    expect(e.message).toBe("Failed to start SageMaker job (AccessDeniedException)");
  });

  it("unconfirmed → 500 'outcome unknown', never retryable, whatever the name", () => {
    const e = refusedStartError(awsErr("ThrottlingException", "Rate exceeded"), "x", false);
    expect(e).toMatchObject({ code: "INTERNAL", status: 500, confirmedAbsent: false });
  });
});

describe("definitive rejection + settle", () => {
  it("a 4xx is definitive; a name collision, a 5xx or no AWS answer is not", () => {
    expect(isDefinitiveRejection(awsErrorFacts(awsErr("ThrottlingException", "Rate exceeded", 400)))).toBe(true);
    expect(isDefinitiveRejection(awsErrorFacts(awsErr("ResourceInUse", "Job name must be unique", 400)))).toBe(false);
    expect(isDefinitiveRejection(awsErrorFacts(awsErr("InternalFailure", "oops", 500)))).toBe(false);
    expect(isDefinitiveRejection(awsErrorFacts(awsErr("TimeoutError", "socket hang up")))).toBe(false);
  });

  it("present → the job name; absent → confirmed; unknown + 4xx → confirmed; unknown + no answer → unconfirmed", async () => {
    await expect(settleCreateFailure(awsErr("TimeoutError", "x"), "j", "t", async () => "present")).resolves.toBe("j");
    await expect(settleCreateFailure(awsErr("TimeoutError", "x"), "j", "t", async () => "absent")).rejects.toMatchObject({
      confirmedAbsent: true,
    });
    await expect(
      settleCreateFailure(awsErr("ThrottlingException", "Rate exceeded", 400), "j", "t", async () => "unknown"),
    ).rejects.toMatchObject({ confirmedAbsent: true, code: "RETRYABLE" });
    await expect(settleCreateFailure(awsErr("TimeoutError", "x"), "j", "t", async () => "unknown")).rejects.toMatchObject({
      confirmedAbsent: false,
      code: "INTERNAL",
    });
  });

  it("scrubAwsMessage bounds and flattens", () => {
    expect(scrubAwsMessage(`a\n b ${"x".repeat(400)}`)).toHaveLength(300);
    expect(awsErrorFacts({ __type: "com.amazonaws.sagemaker#ThrottlingException", message: "m" }).name).toBe("ThrottlingException");
  });
});
