import {
  SageMakerClient,
  CreateProcessingJobCommand,
  DescribeProcessingJobCommand,
} from "@aws-sdk/client-sagemaker";
import { S3_BUCKET } from "@/lib/s3";

const sagemakerClient = new SageMakerClient({
  region: process.env.AWS_REGION || "us-east-1",
  ...(process.env.AWS_ACCESS_KEY_ID && {
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  }),
});

const ECR_IMAGE =
  process.env.YOLO_ECR_IMAGE ||
  `${process.env.AWS_ACCOUNT || "100328509916"}.dkr.ecr.${process.env.AWS_REGION || "us-east-1"}.amazonaws.com/beaver-yolo-pipeline:latest`;

const SAGEMAKER_ROLE =
  process.env.SAGEMAKER_ROLE_ARN ||
  `arn:aws:iam::${process.env.AWS_ACCOUNT || "100328509916"}:role/beaver-sagemaker-role`;

/**
 * Start a SageMaker processing job for YOLO inference.
 *
 * @param projectDataUrl - S3 prefix for the project (e.g., "companyKey/projectHash")
 * @param modelS3Path - S3 prefix for the model (e.g., "models/my-model")
 * @param modelName - Human-readable model name for the job
 * @returns Job name for status polling
 */
export async function startYoloJob(
  projectDataUrl: string,
  modelS3Path: string,
  modelName: string
): Promise<string> {
  const jobName = `beaver-yolo-${modelName}-${Date.now()}`.replace(
    /[^a-zA-Z0-9-]/g,
    "-"
  ).slice(0, 63);

  const command = new CreateProcessingJobCommand({
    ProcessingJobName: jobName,
    ProcessingResources: {
      ClusterConfig: {
        InstanceCount: 1,
        InstanceType: "ml.g4dn.xlarge",
        VolumeSizeInGB: 30,
      },
    },
    AppSpecification: {
      ImageUri: ECR_IMAGE,
    },
    RoleArn: SAGEMAKER_ROLE,
    ProcessingInputs: [
      {
        InputName: "images",
        S3Input: {
          S3Uri: `s3://${S3_BUCKET}/${projectDataUrl}/images/`,
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

  await sagemakerClient.send(command);
  return jobName;
}

/**
 * Check the status of a SageMaker processing job.
 */
export async function getYoloJobStatus(
  jobName: string
): Promise<{
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
