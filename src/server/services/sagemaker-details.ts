// [refactor jul7 S052] admin/sagemaker-details SOLO — rich details of a SageMaker processing
// job, folded from the legacy route (git show 5dec5d5:src/app/api/admin/sagemaker-details/
// route.ts). Char: __tests__/admin-sagemaker-details.route.test.ts (SM-*). requireAdmin (the
// shell provides auth:"admin"). Sanctioned diffs:
//   • A — flat auth errors → envelope; "jobName required" (400) stays byte-verbatim as ApiError.
//   • B — ⚠️ the legacy catch LEAKED err.message at 500 ({error: err.message || "Failed to
//     describe job"}); RETIRED here — the service lets the SageMaker error propagate → the
//     shell renders a generic INTERNAL 500 (real cause logged server-side, no AWS-error leak).
//   • NO E — GET reads a query param, not a body.
// The SageMaker client + the full response shaping are ported verbatim.

import { SageMakerClient, DescribeProcessingJobCommand } from "@aws-sdk/client-sagemaker";
import { ApiError } from "@/server/api/envelope";

const sagemakerClient = new SageMakerClient({
  region: process.env.AWS_REGION || "us-east-1",
  ...(process.env.AWS_ACCESS_KEY_ID && {
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  }),
});

export async function getSagemakerDetails(req: Request): Promise<unknown> {
  const url = new URL(req.url);
  const jobName = url.searchParams.get("jobName");
  if (!jobName) {
    throw new ApiError("VALIDATION", "jobName required");
  }

  // [B] no try/catch — a SageMaker error propagates to the shell's generic INTERNAL 500
  // (legacy leaked err.message here; retired).
  const result = await sagemakerClient.send(
    new DescribeProcessingJobCommand({ ProcessingJobName: jobName })
  );

  const startTime = result.ProcessingStartTime || result.CreationTime;
  const endTime = result.ProcessingEndTime;
  const durationMs = startTime && endTime
    ? new Date(endTime).getTime() - new Date(startTime).getTime()
    : startTime
      ? Date.now() - new Date(startTime).getTime()
      : null;

  const inputs = (result.ProcessingInputs || []).map((i) => ({
    name: i.InputName,
    s3Uri: i.S3Input?.S3Uri,
  }));

  const outputs = (result.ProcessingOutputConfig?.Outputs || []).map((o) => ({
    name: o.OutputName,
    s3Uri: o.S3Output?.S3Uri,
  }));

  return {
    jobName: result.ProcessingJobName,
    status: result.ProcessingJobStatus,
    failureReason: result.FailureReason || null,
    exitMessage: result.ExitMessage || null,
    creationTime: result.CreationTime?.toISOString(),
    startTime: startTime?.toISOString() || null,
    endTime: endTime?.toISOString() || null,
    durationSeconds: durationMs ? Math.round(durationMs / 1000) : null,
    instanceType: result.ProcessingResources?.ClusterConfig?.InstanceType,
    instanceCount: result.ProcessingResources?.ClusterConfig?.InstanceCount,
    volumeSizeGB: result.ProcessingResources?.ClusterConfig?.VolumeSizeInGB,
    inputs,
    outputs,
    stoppingConditionSeconds: result.StoppingCondition?.MaxRuntimeInSeconds,
  };
}
