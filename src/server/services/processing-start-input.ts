// [2026-10-23] The Step Functions StartExecution input for an uploaded project (createProject in
// services/projects.ts). Moved out of projects.ts, which sits at its MAX_LINES ceiling, when the root
// admin's upload compute preset (services/upload-compute.ts) joined it: `cpu`/`memory` become the
// CPUProcessing task's Cpu/Memory overrides and `pageConcurrency` its PAGE_CONCURRENCY env
// (infrastructure/terraform/stepfunctions.tf). The state machine defaults all three when absent, so
// an execution started by an older app image still runs at the task definition's 8 vCPU · 16 GB.

import { uploadComputeExecutionFields, type UploadComputePreset } from "@/lib/upload-compute";
import { readUploadComputePreset } from "@/server/services/upload-compute";

export interface ProcessingStartProject {
  id: number;
  dataUrl: string;
}

/** Pure: the input object for one project and preset. */
export function buildProcessingStartInput(
  project: ProcessingStartProject,
  preset: UploadComputePreset,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  return {
    projectId: project.id,
    dataUrl: project.dataUrl,
    s3Bucket: env.S3_BUCKET,
    webhookUrl: `${env.NEXTAUTH_URL}/api/processing/webhook`,
    webhookSecret: env.PROCESSING_WEBHOOK_SECRET,
    ...uploadComputeExecutionFields(preset),
  };
}

/** The serialized StartExecution input, with the saved preset (never throws on a settings read). */
export async function processingStartInput(project: ProcessingStartProject): Promise<string> {
  return JSON.stringify(buildProcessingStartInput(project, await readUploadComputePreset()));
}
