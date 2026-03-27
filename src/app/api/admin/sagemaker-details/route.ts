import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { SageMakerClient, DescribeProcessingJobCommand } from "@aws-sdk/client-sagemaker";

const sagemakerClient = new SageMakerClient({
  region: process.env.AWS_REGION || "us-east-1",
  ...(process.env.AWS_ACCESS_KEY_ID && {
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  }),
});

/**
 * GET /api/admin/sagemaker-details?jobName=xxx
 * Returns rich details about a SageMaker processing job.
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const url = new URL(req.url);
  const jobName = url.searchParams.get("jobName");
  if (!jobName) {
    return NextResponse.json({ error: "jobName required" }, { status: 400 });
  }

  try {
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

    return NextResponse.json({
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
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || "Failed to describe job" },
      { status: 500 }
    );
  }
}
