import {
  SageMakerClient,
  CreateProcessingJobCommand,
  DescribeProcessingJobCommand,
  StopProcessingJobCommand,
  type ProcessingInstanceType,
} from "@aws-sdk/client-sagemaker";
import { S3_BUCKET } from "@/lib/s3";
import { randomUUID } from "crypto";
import { readYoloInstanceType } from "@/server/services/yolo-instance";
import { readYoloMaxRuntimeSeconds } from "@/server/services/yolo-instance";
import { isSageMakerNotFoundError } from "@/lib/yolo-instances";
import { settleCreateFailure } from "@/lib/yolo-start-errors";

const sagemakerClient = new SageMakerClient({
  region: process.env.AWS_REGION || "us-east-1",
  ...(process.env.AWS_ACCESS_KEY_ID && {
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  }),
});

// The refusal class + AWS-name classification live in lib/yolo-start-errors (2026-10-22 incident).
export { YoloStartRefusedError } from "@/lib/yolo-start-errors";

const ECR_IMAGE = process.env.YOLO_ECR_IMAGE;
const SAGEMAKER_ROLE = process.env.SAGEMAKER_ROLE_ARN;

function assertYoloRuntimeAuthority(): void {
  const account = process.env.AWS_ACCOUNT;
  const region = process.env.AWS_REGION;
  if (!account || !/^[0-9]{12}$/.test(account)) {
    throw new Error("AWS_ACCOUNT is required for SageMaker jobs");
  }
  if (!region || !/^[a-z]{2}(?:-gov)?-[a-z]+-[0-9]$/.test(region)) {
    throw new Error("AWS_REGION is required for SageMaker jobs");
  }
  const expectedImage = new RegExp(
    `^${account}\\.dkr\\.ecr\\.${region}\\.amazonaws\\.com/beaver-yolo-pipeline@sha256:[0-9a-f]{64}$`,
  );
  if (!ECR_IMAGE || !expectedImage.test(ECR_IMAGE)) {
    throw new Error("YOLO_ECR_IMAGE must be the canonical digest-pinned repository image");
  }
  if (SAGEMAKER_ROLE !== `arn:aws:iam::${account}:role/beaver-sagemaker-role`) {
    throw new Error("SAGEMAKER_ROLE_ARN must be the canonical SageMaker execution role");
  }
  if (S3_BUCKET !== `beaver-data-${account}`) {
    throw new Error("S3_BUCKET must be the canonical account-owned data bucket");
  }
}

/** Allocate the provider identity before launch so an ambiguous SDK failure remains reconcilable. */
export function createYoloJobName(
  modelName: string,
  nonce = randomUUID(),
): string {
  const suffix =
    nonce.replace(/[^a-zA-Z0-9]/g, "").slice(0, 20) ||
    randomUUID().replace(/-/g, "").slice(0, 20);
  const prefix = "bp-yolo-";
  const safeModel = modelName.replace(/[^a-zA-Z0-9-]/g, "-");
  const modelBudget = 63 - prefix.length - suffix.length - 1;
  const truncatedModel = safeModel.slice(0, Math.max(0, modelBudget));
  return truncatedModel
    ? `${prefix}${truncatedModel}-${suffix}`
    : `${prefix}${suffix}`;
}

/**
 * Start a SageMaker processing job for YOLO inference.
 *
 * @param projectDataUrl - S3 prefix for the project (e.g., "companyKey/projectHash")
 * @param modelS3Path - S3 prefix for the model (e.g., "models/my-model")
 * @param modelName - Human-readable model name for the job
 * @returns Job name for status polling
 *
 * The instance type and the timeout (MaxRuntimeInSeconds) are root-chosen app_settings values; both
 * readers never throw and fall back to ml.g4dn.xlarge / 3600 s. Any create failure becomes a
 * YoloStartRefusedError classified by AWS error name (429 RETRYABLE / 400 / 500, lib/yolo-start-errors).
 * An SDK retry can follow an accepted first attempt, so AWS is asked about the job name first:
 * present → the job is real and its name is returned; absent (or a definitive 4xx) → confirmedAbsent.
 */
export async function startYoloJob(
  projectDataUrl: string,
  modelS3Path: string,
  modelName: string,
  jobName = createYoloJobName(modelName),
): Promise<string> {
  assertYoloRuntimeAuthority();
  const instanceType = await readYoloInstanceType();
  const maxRuntimeSeconds = await readYoloMaxRuntimeSeconds();

  const command = new CreateProcessingJobCommand({
    ProcessingJobName: jobName,
    ProcessingResources: {
      ClusterConfig: {
        InstanceCount: 1,
        InstanceType: instanceType as ProcessingInstanceType,
        VolumeSizeInGB: 30,
      },
    },
    AppSpecification: {
      ImageUri: ECR_IMAGE,
    },
    RoleArn: SAGEMAKER_ROLE,
    NetworkConfig: {
      EnableNetworkIsolation: true,
    },
    ProcessingInputs: [
      {
        InputName: "images",
        S3Input: {
          S3Uri: `s3://${S3_BUCKET}/${projectDataUrl}/pages/`,
          LocalPath: "/opt/ml/processing/input/images",
          S3DataType: "S3Prefix",
          S3InputMode: "File",
        },
      },
      {
        InputName: "models",
        S3Input: {
          S3Uri: `s3://${S3_BUCKET}/${modelS3Path}/`,
          LocalPath: "/opt/ml/processing/input/models",
          S3DataType: "S3Prefix",
          S3InputMode: "File",
        },
      },
    ],
    ProcessingOutputConfig: {
      Outputs: [
        {
          OutputName: "results",
          S3Output: {
            S3Uri: `s3://${S3_BUCKET}/${projectDataUrl}/yolo-output/${modelName}/`,
            LocalPath: "/opt/ml/processing/output",
            S3UploadMode: "EndOfJob",
          },
        },
      ],
    },
    StoppingCondition: {
      MaxRuntimeInSeconds: maxRuntimeSeconds,
    },
  });

  try {
    await sagemakerClient.send(command);
  } catch (err) {
    return settleCreateFailure(err, jobName, instanceType, (name) => yoloJobPresence(name));
  }
  return jobName;
}

/** SageMaker allows 10 ProcessingInputs and 10 ProcessingOutputs: 9 projects + the model input. */
export const MAX_YOLO_BATCH_PROJECTS = 9;

/** Slot names of a batched job, in project order: p0, p1, … (scripts/yolo_inference.py BP_YOLO_SLOTS). */
export function yoloBatchSlots(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `p${i}`);
}

/**
 * [2026-10-22] ONE processing job for up to 9 projects (owner: "take full advantage of the larger GPU
 * and its larger quota"). Each project keeps its own S3 input ({dataUrl}/pages/) and output
 * ({dataUrl}/yolo-output/{modelName}/), mounted at /opt/ml/processing/input/projects/pK and
 * /opt/ml/processing/output/pK; BP_YOLO_SLOTS tells the script the layout. Same instance, timeout,
 * isolation and quota-refusal semantics as startYoloJob. Needs the YOLO image built from this
 * commit's scripts/yolo_inference.py — an older image finds no /input/images and fails the job.
 */
export async function startYoloBatchJob(
  projectDataUrls: readonly string[],
  modelS3Path: string,
  modelName: string,
  jobName: string,
): Promise<string> {
  assertYoloRuntimeAuthority();
  const instanceType = await readYoloInstanceType();
  const maxRuntimeSeconds = await readYoloMaxRuntimeSeconds();
  if (projectDataUrls.length < 1 || projectDataUrls.length > MAX_YOLO_BATCH_PROJECTS) {
    throw new Error(`A batched YOLO job serves 1–${MAX_YOLO_BATCH_PROJECTS} projects`);
  }
  const slots = yoloBatchSlots(projectDataUrls.length);

  const command = new CreateProcessingJobCommand({
    ProcessingJobName: jobName,
    ProcessingResources: {
      ClusterConfig: {
        InstanceCount: 1,
        InstanceType: instanceType as ProcessingInstanceType,
        VolumeSizeInGB: 30,
      },
    },
    AppSpecification: { ImageUri: ECR_IMAGE },
    RoleArn: SAGEMAKER_ROLE,
    NetworkConfig: { EnableNetworkIsolation: true },
    Environment: { BP_YOLO_SLOTS: slots.join(",") },
    ProcessingInputs: [
      ...projectDataUrls.map((dataUrl, i) => ({
        InputName: `images-${slots[i]}`,
        S3Input: {
          S3Uri: `s3://${S3_BUCKET}/${dataUrl}/pages/`,
          LocalPath: `/opt/ml/processing/input/projects/${slots[i]}`,
          S3DataType: "S3Prefix" as const,
          S3InputMode: "File" as const,
        },
      })),
      {
        InputName: "models",
        S3Input: {
          S3Uri: `s3://${S3_BUCKET}/${modelS3Path}/`,
          LocalPath: "/opt/ml/processing/input/models",
          S3DataType: "S3Prefix",
          S3InputMode: "File",
        },
      },
    ],
    ProcessingOutputConfig: {
      Outputs: projectDataUrls.map((dataUrl, i) => ({
        OutputName: `results-${slots[i]}`,
        S3Output: {
          S3Uri: `s3://${S3_BUCKET}/${dataUrl}/yolo-output/${modelName}/`,
          LocalPath: `/opt/ml/processing/output/${slots[i]}`,
          S3UploadMode: "EndOfJob" as const,
        },
      })),
    },
    StoppingCondition: { MaxRuntimeInSeconds: maxRuntimeSeconds },
  });

  try {
    await sagemakerClient.send(command);
  } catch (err) {
    return settleCreateFailure(err, jobName, instanceType, (name) => yoloJobPresence(name));
  }
  return jobName;
}

/** Waits between Describe attempts when the answer is inconclusive (throttling, network). */
export const YOLO_PRESENCE_RETRY_MS: readonly number[] = [500, 1500];

/**
 * Does SageMaker hold a processing job under this name? Never throws; "unknown" only when every
 * attempt was inconclusive. [2026-10-22 DOUBLE_BACK] One throttled Describe used to leave a refused
 * start's row + reservation live (quota burn); the retries make a confirmed answer the normal case.
 */
export async function yoloJobPresence(
  jobName: string,
  retryMs: readonly number[] = YOLO_PRESENCE_RETRY_MS,
): Promise<"present" | "absent" | "unknown"> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await getYoloJobStatus(jobName);
      return "present";
    } catch (err) {
      if (isSageMakerNotFoundError(err)) return "absent";
      if (attempt >= retryMs.length) return "unknown";
      await new Promise((resolve) => setTimeout(resolve, retryMs[attempt]));
    }
  }
}

/**
 * The provider's record of a finished job, for the cost estimate's history (instance type and wall
 * seconds from creation to end, i.e. including instance start-up). Never throws; null on any doubt.
 */
export async function describeYoloJobRun(
  jobName: string,
): Promise<{ instanceType: string; runSeconds: number } | null> {
  try {
    const r = await sagemakerClient.send(new DescribeProcessingJobCommand({ ProcessingJobName: jobName }));
    const instanceType = r.ProcessingResources?.ClusterConfig?.InstanceType;
    const start = r.CreationTime?.getTime();
    const end = r.ProcessingEndTime?.getTime();
    if (!instanceType || start === undefined || end === undefined || end <= start) return null;
    return { instanceType, runSeconds: Math.round((end - start) / 1000) };
  } catch {
    return null;
  }
}

/**
 * Check the status of a SageMaker processing job.
 */
export async function getYoloJobStatus(jobName: string): Promise<{
  status: string;
  failureReason?: string;
}> {
  const command = new DescribeProcessingJobCommand({
    ProcessingJobName: jobName,
  });

  const response = await sagemakerClient.send(command);

  return {
    status: response.ProcessingJobStatus || "Unknown",
    failureReason: response.FailureReason,
  };
}

/** [2026-10-22] Root's Stuck jobs › Stop: ask SageMaker to stop a processing job (it goes Stopping → Stopped). */
export async function stopYoloJob(jobName: string): Promise<void> {
  await sagemakerClient.send(new StopProcessingJobCommand({ ProcessingJobName: jobName }));
}
