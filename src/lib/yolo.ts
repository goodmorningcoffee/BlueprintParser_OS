import {
  SageMakerClient,
  CreateProcessingJobCommand,
  DescribeProcessingJobCommand,
  type ProcessingInstanceType,
} from "@aws-sdk/client-sagemaker";
import { S3_BUCKET } from "@/lib/s3";
import { randomUUID } from "crypto";
import { ApiError } from "@/server/api/envelope";
import { readYoloInstanceType } from "@/server/services/yolo-instance";
import { isSageMakerNotFoundError, isSageMakerQuotaError, yoloQuotaMessage } from "@/lib/yolo-instances";

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
 * SageMaker refused CreateProcessingJob for lack of instance quota (HTTP 429 to the admin).
 * `confirmedAbsent`: a follow-up Describe reported no job under this name, so the refusal is
 * provider-confirmed and the caller may retire its job intent and page reservation.
 */
export class YoloStartRefusedError extends ApiError {
  readonly confirmedAbsent: boolean;
  constructor(message: string, confirmedAbsent: boolean) {
    super("RATE_LIMITED", message);
    this.confirmedAbsent = confirmedAbsent;
  }
}

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
 * The instance type is the root-chosen app_settings value (readYoloInstanceType never throws; it
 * falls back to ml.g4dn.xlarge). A ResourceLimitExceeded refusal becomes a YoloStartRefusedError
 * (429) naming that type, which yoloRun passes through so the admin sees "No SageMaker quota for
 * <type>". An SDK retry can follow an accepted first attempt, so AWS is asked about the job name
 * first: present → the job is real and its name is returned; absent → confirmedAbsent; else not.
 */
export async function startYoloJob(
  projectDataUrl: string,
  modelS3Path: string,
  modelName: string,
  jobName = createYoloJobName(modelName),
): Promise<string> {
  assertYoloRuntimeAuthority();
  const instanceType = await readYoloInstanceType();

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
      MaxRuntimeInSeconds: 3600,
    },
  });

  try {
    await sagemakerClient.send(command);
  } catch (err) {
    if (!isSageMakerQuotaError(err)) throw err;
    const presence = await yoloJobPresence(jobName);
    if (presence === "present") return jobName;
    throw new YoloStartRefusedError(yoloQuotaMessage(instanceType), presence === "absent");
  }
  return jobName;
}

/** Does SageMaker hold a processing job under this name? Never throws; "unknown" on any doubt. */
export async function yoloJobPresence(jobName: string): Promise<"present" | "absent" | "unknown"> {
  try {
    await getYoloJobStatus(jobName);
    return "present";
  } catch (err) {
    return isSageMakerNotFoundError(err) ? "absent" : "unknown";
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
